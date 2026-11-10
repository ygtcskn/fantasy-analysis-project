"""The online chat: src/chat/sync_chat_d1.py against a fake D1 (real SQLite), and the JavaScript copy
in src/chat/cloud/ and functions/api/chat.js kept in step with the Python chat."""
import ast
from pathlib import Path
import re
import sqlite3
import unittest
from unittest import mock

from src.chat import assistant, build_chat_db, sync_chat_d1, tools
from src.chat.sync_chat_d1 import D1, D1_SCHEMA, sync
from src.web import serve
from tests.test_chat_tools import sample_database

ROOT = Path(__file__).resolve().parents[1]
CLOUD = ROOT / "src" / "chat" / "cloud"


class FakeD1(D1):
    """D1's query API answered by an in-memory SQLite database; rows_written counted as D1 reports it."""

    def __init__(self, dry_run=False):
        super().__init__("account", "database", "token", dry_run)
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.statements = []

    def query(self, sql, params=(), write=False):
        if write and self.dry_run:
            return []
        self.statements.append(sql)
        before = self.db.total_changes
        rows = [dict(row) for row in self.db.execute(sql, list(params))]
        self.db.commit()
        self.written += self.db.total_changes - before
        return rows

    def count(self, table, where=""):
        return self.db.execute(f"SELECT COUNT(*) FROM {table} {where}").fetchone()[0]


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.local = sample_database()
        self.local.commit()
        self.d1 = FakeD1()

    def tearDown(self):
        self.local.close()

    def test_the_d1_tables_have_the_local_columns(self):
        local = sqlite3.connect(":memory:")
        local.executescript(build_chat_db.SCHEMA)
        remote = sqlite3.connect(":memory:")
        remote.executescript(D1_SCHEMA)
        for table in ("seasons", "teams", "players", "matches", "events", "player_matches", "standings"):
            with self.subTest(table=table):
                names = lambda db: [row[1] for row in db.execute(f"PRAGMA table_info({table})")]  # noqa: E731
                self.assertEqual(names(remote), names(local))

    def test_a_first_sync_sends_everything_but_the_bench(self):
        sync(self.d1, self.local)
        self.assertEqual(self.d1.count("matches"), 4)
        self.assertEqual(self.d1.count("events"), 5)
        self.assertEqual(self.d1.count("teams"), 2)
        self.assertEqual(self.d1.count("players"), 4)
        self.assertEqual(self.d1.count("standings"), 2)
        # The bench row (no minutes) stays behind; every tool counts minutes > 0.
        self.assertEqual(self.d1.count("player_matches"), 6)
        self.assertEqual(self.d1.count("chat_sync"), 4)

    def test_the_tools_answer_the_same_from_d1(self):
        sync(self.d1, self.local)
        for name, arguments in (("leaderboard", {"stat": "goals", "season": "2023/2024"}),
                                ("match_details", {"fixture_id": 1}), ("standings", {}),
                                ("find_player", {"name": "mert"}), ("team_season_stats", {"team_id": 10})):
            with self.subTest(tool=name):
                self.assertEqual(tools.run_tool(self.d1.db, name, arguments), tools.run_tool(self.local, name, arguments))

    def test_nothing_is_sent_twice(self):
        sync(self.d1, self.local)
        self.d1.statements.clear()
        before = self.d1.written
        report = sync(self.d1, self.local)
        self.assertFalse([sql for sql in self.d1.statements if sql.startswith(("INSERT INTO", "DELETE"))])
        self.assertEqual(self.d1.written - before, 0)
        self.assertIn("matches: 0 sent, 0 waiting, 4 already up to date", report)

    def test_only_a_changed_match_is_sent_again(self):
        sync(self.d1, self.local)
        self.local.execute("UPDATE matches SET state = 'FT', finished = 1, home_goals = 1, away_goals = 0 WHERE fixture_id = 3")
        self.local.execute("UPDATE players SET name = 'Ciro Immobile Jr' WHERE player_id = 100")
        self.d1.statements.clear()
        report = sync(self.d1, self.local)
        self.assertIn("matches: 1 sent, 0 waiting, 3 already up to date", report)
        self.assertIn("players: 1 rows sent, 0 removed", report)
        self.assertEqual(self.d1.db.execute("SELECT home_goals FROM matches WHERE fixture_id = 3").fetchone()[0], 1)
        self.assertEqual(self.d1.db.execute("SELECT name FROM players WHERE player_id = 100").fetchone()[0], "Ciro Immobile Jr")
        deletes = [sql for sql in self.d1.statements if sql.startswith("DELETE")]
        self.assertTrue(all("(3)" in sql for sql in deletes), deletes)

    def test_a_removed_match_is_removed(self):
        sync(self.d1, self.local)
        for table in ("events", "player_matches", "matches"):
            self.local.execute(f"DELETE FROM {table} WHERE fixture_id = 1")
        sync(self.d1, self.local)
        self.assertEqual(self.d1.count("matches", "WHERE fixture_id = 1"), 0)
        self.assertEqual(self.d1.count("events", "WHERE fixture_id = 1"), 0)
        self.assertEqual(self.d1.count("chat_sync", "WHERE unit = 'fixture:1'"), 0)

    def test_the_daily_budget_stops_a_run_and_the_next_day_goes_on(self):
        with mock.patch.object(sync_chat_d1, "FIXTURES_PER_BATCH", 1):
            report = sync(self.d1, self.local, daily=40)
            self.assertTrue(any("wait for tomorrow" in line for line in report), report)
            self.assertLess(self.d1.count("matches"), 4)
            self.assertLessEqual(self.d1.db.execute("SELECT rows_written FROM chat_sync_usage").fetchone()[0], 40)
            # Newest first: the latest match went up before the older ones.
            self.assertEqual(self.d1.count("matches", "WHERE fixture_id = 3"), 1)
            with mock.patch.object(sync_chat_d1, "today", return_value="2999-01-01"):
                sync(self.d1, self.local, daily=10_000)
        self.assertEqual(self.d1.count("matches"), 4)

    def test_a_dry_run_changes_no_rows(self):
        d1 = FakeD1(dry_run=True)
        report = sync(d1, self.local)
        self.assertEqual(d1.count("matches"), 0)
        self.assertEqual(d1.count("chat_sync_usage"), 0)
        self.assertEqual(report[-2], "matches: 4 sent, 0 waiting, 0 already up to date")
        self.assertEqual(report[-1], "rows written by this run: 0")

    def test_values_are_written_safely(self):
        self.assertEqual(sync_chat_d1.literal("O'Neil"), "'O''Neil'")
        self.assertEqual(sync_chat_d1.literal(None), "NULL")
        self.assertEqual(sync_chat_d1.literal(float("nan")), "NULL")
        self.assertEqual(sync_chat_d1.literal(7.5), "7.5")
        self.assertEqual(sync_chat_d1.literal(True), "1")

    def test_long_inserts_are_split_under_the_size_limit(self):
        rows = [(number, "x" * 500) for number in range(1000)]
        statements = sync_chat_d1.inserts("t", ["a", "b"], rows)
        self.assertGreater(len(statements), 1)
        self.assertTrue(all(len(statement) <= sync_chat_d1.MAX_STATEMENT_BYTES for statement in statements))
        self.assertEqual(sum(statement.count("'xxx") for statement in statements), 1000)


def js_strings(source: str, name: str) -> list[str]:
    """The double-quoted strings in a JavaScript array named name."""
    block = re.search(rf"\b{name}\s*=\s*\[(.*?)\];", source, re.S)
    if block is None:
        raise AssertionError(f"{name} not found")
    return [ast.literal_eval(text) for text in re.findall(r'"(?:[^"\\]|\\.)*"', block[1])]


class JavaScriptCopyTests(unittest.TestCase):
    """The online chat is JavaScript; these keep it saying what the Python chat says."""

    assistant_js = (CLOUD / "assistant.js").read_text(encoding="utf-8")
    tools_js = (CLOUD / "tools.js").read_text(encoding="utf-8")
    agents_js = (CLOUD / "agents.js").read_text(encoding="utf-8")
    function_js = (ROOT / "functions" / "api" / "chat.js").read_text(encoding="utf-8")

    def test_the_prompt_is_the_same(self):
        self.assertEqual("\n".join(js_strings(self.assistant_js, "SYSTEM_PROMPT_LINES")), assistant.SYSTEM_PROMPT)

    def test_the_limits_and_messages_are_the_same(self):
        for name in ("TOO_MANY_STEPS", "CANNOT_ANSWER", "NO_ANSWER", "EFFORT"):
            with self.subTest(name=name):
                found = re.search(rf'export const {name} = ("(?:[^"\\]|\\.)*");', self.assistant_js)
                self.assertEqual(ast.literal_eval(found[1]), getattr(assistant, name))
        for name in ("MAX_TOKENS", "MAX_ROUNDS"):
            with self.subTest(name=name):
                self.assertIn(f"export const {name} = {getattr(assistant, name)};", self.assistant_js)

    def test_the_tools_and_stats_are_the_same(self):
        self.assertEqual(re.findall(r'^  \["([a-z_]+)",$', self.tools_js, re.M), list(tools.TOOLS_BY_NAME))
        self.assertEqual(re.findall(r"^  ([a-z_]+): \[", self.tools_js, re.M), list(tools.STATS))
        for stat, (expression, column) in tools.STATS.items():
            with self.subTest(stat=stat):
                self.assertIn(f'{stat}: ["{expression}", {"null" if column is None else chr(34) + column + chr(34)}]', self.tools_js)
        self.assertEqual(js_strings(self.tools_js, "POSITIONS"), tools.POSITIONS)

    def test_the_models_are_the_same(self):
        from src.chat import claude_agent, openai_agent
        self.assertIn(f'model: "{claude_agent.MODEL}"', self.agents_js)
        self.assertIn(f'model: "{openai_agent.MODEL}"', self.agents_js)

    def test_the_answer_has_the_local_columns(self):
        self.assertEqual(js_strings(self.function_js, "FIELDS"), list(serve.CHAT_FIELDS))


if __name__ == "__main__":
    unittest.main()
