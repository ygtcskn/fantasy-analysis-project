"""Copy the chatbot database to Cloudflare D1, where the online chat (functions/api/chat.js) reads it.

    python src/chat/sync_chat_d1.py              # send what changed
    python src/chat/sync_chat_d1.py --dry-run    # only say what would be sent

Reads data/temp/chat/chat.sqlite (python src/chat/build_chat_db.py makes it)
and changes the D1 database CHAT_D1_DATABASE_ID through Cloudflare's API, with
CLOUDFLARE_API_TOKEN (it needs D1 Edit) and CLOUDFLARE_ACCOUNT_ID from the
environment or .env. src/update_site.py runs it after each site update.

D1 on Cloudflare's free plan allows about 100,000 written rows a day, and a
row written into a table with indexes counts once more per index. So only
what changed is sent: each match (its row, events and the players who
played) carries a fingerprint, and a match is sent again only when its
fingerprint differs from the one D1 holds. The small tables (seasons, clubs,
players, league tables) are compared row by row. Newest matches go first,
and a run stops at the day's budget (CHAT_D1_DAILY_WRITES, default 80,000),
so filling an empty database takes a few days, the current season first.
Nothing here deletes anything outside the chat's own tables.
"""
from __future__ import annotations

import argparse
import hashlib
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import sqlite3
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.chat.build_chat_db import OUTPUT as DATABASE  # noqa: E402
from src.fetch.sportmonks import local_setting  # noqa: E402

API = "https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{database}/query"
DAILY_WRITES = 80_000
MAX_STATEMENT_BYTES = 90_000   # D1 refuses a statement over 100 KB
FIXTURES_PER_BATCH = 20

# The same tables as chat.sqlite (src/chat/build_chat_db.py), shaped for D1's
# billing: WITHOUT ROWID where the key is not one integer, so the key is not a
# second index to write, and only the indexes the chat's queries need. The
# bench (players who did not play) is left out: every tool counts minutes > 0.
D1_SCHEMA = """
CREATE TABLE IF NOT EXISTS seasons (season TEXT PRIMARY KEY, season_id INTEGER) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS teams (team_id INTEGER PRIMARY KEY, name TEXT NOT NULL, short_code TEXT, search_name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS players (player_id INTEGER PRIMARY KEY, name TEXT NOT NULL, short_name TEXT, search_name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS matches (fixture_id INTEGER PRIMARY KEY, season TEXT NOT NULL, round TEXT, kickoff_utc TEXT,
  state TEXT, finished INTEGER NOT NULL, home_team_id INTEGER NOT NULL, away_team_id INTEGER NOT NULL,
  home_goals INTEGER, away_goals INTEGER);
CREATE INDEX IF NOT EXISTS idx_matches_season ON matches (season);
CREATE TABLE IF NOT EXISTS events (fixture_id INTEGER NOT NULL, event_id INTEGER NOT NULL, season TEXT NOT NULL, type TEXT NOT NULL,
  minute INTEGER, extra_minute INTEGER, team_id INTEGER, player_id INTEGER, related_player_id INTEGER,
  PRIMARY KEY (fixture_id, event_id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS player_matches (fixture_id INTEGER NOT NULL, player_id INTEGER NOT NULL, season TEXT NOT NULL,
  team_id INTEGER, position TEXT, started INTEGER, minutes REAL, rating REAL, expected_goals REAL,
  goals REAL, assists REAL, shots_total REAL, shots_on_target REAL, key_passes REAL, big_chances_created REAL,
  passes REAL, accurate_passes REAL, tackles REAL, interceptions REAL, clearances REAL, saves REAL,
  goals_conceded REAL, yellowcards REAL, redcards REAL, yellowred_cards REAL, own_goals REAL,
  penalties_scored REAL, penalties_misses REAL, fouls REAL, fouls_drawn REAL, touches REAL,
  PRIMARY KEY (fixture_id, player_id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_player_matches_player ON player_matches (player_id);
CREATE INDEX IF NOT EXISTS idx_player_matches_season ON player_matches (season);
CREATE TABLE IF NOT EXISTS standings (season TEXT NOT NULL, stage_id INTEGER NOT NULL, group_id TEXT NOT NULL, team_id INTEGER NOT NULL,
  position INTEGER, points INTEGER, played INTEGER, won INTEGER, drawn INTEGER, lost INTEGER,
  goals_for INTEGER, goals_against INTEGER, PRIMARY KEY (season, stage_id, group_id, team_id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS chat_sync (unit TEXT PRIMARY KEY, fingerprint TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS chat_sync_usage (day TEXT PRIMARY KEY, rows_written INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS chat_limits (key TEXT PRIMARY KEY, day TEXT NOT NULL, used INTEGER NOT NULL) WITHOUT ROWID
"""
# Written rows per row, counting each index (estimates; D1 reports the real number).
ROW_COST = {"seasons": 1, "teams": 1, "players": 1, "standings": 1, "matches": 2, "events": 1, "player_matches": 3}
# The small tables and their keys: compared row by row.
SMALL_TABLES = {"seasons": ("season",), "teams": ("team_id",), "players": ("player_id",),
                "standings": ("season", "stage_id", "group_id", "team_id")}


class SyncError(RuntimeError):
    pass


class D1:
    """Cloudflare's D1 query API: one SQL statement per call."""

    def __init__(self, account: str, database: str, token: str, dry_run: bool = False):
        self.url = API.format(account=account, database=database)
        self.token = token
        self.dry_run = dry_run
        self.written = 0

    def query(self, sql: str, params=(), write: bool = False) -> list[dict]:
        if write and self.dry_run:
            return []
        body = json.dumps({"sql": sql, "params": list(params)}).encode("utf-8")
        for attempt in range(4):
            request = Request(self.url, data=body, method="POST",
                              headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"})
            try:
                with urlopen(request, timeout=60) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                break
            except HTTPError as error:
                if error.code in (429, 500, 502, 503, 504) and attempt < 3:
                    time.sleep(2 ** attempt)
                    continue
                detail = error.read(2000).decode("utf-8", "replace")
                raise SyncError(f"D1 refused the request (HTTP {error.code}): {detail}") from None
            except (URLError, TimeoutError, OSError) as error:
                if attempt < 3:
                    time.sleep(2 ** attempt)
                    continue
                raise SyncError(f"Cannot reach Cloudflare: {error}") from None
        if not payload.get("success"):
            raise SyncError(f"D1 reported an error: {payload.get('errors')}")
        result = (payload.get("result") or [{}])[0]
        self.written += int((result.get("meta") or {}).get("rows_written") or 0)
        return result.get("results") or []


def literal(value) -> str:
    """A value written into SQL text. Only this file's own data goes through here."""
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return str(int(value))
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value) if math.isfinite(value) else "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def inserts(table: str, columns: list[str], rows: list[tuple], verb: str = "INSERT") -> list[str]:
    """Multi-row INSERT statements, each under D1's size limit."""
    head = f"{verb} INTO {table} ({', '.join(columns)}) VALUES "
    statements, values, size = [], [], len(head)
    for row in rows:
        text = "(" + ", ".join(literal(value) for value in row) + ")"
        if values and size + len(text) + 2 > MAX_STATEMENT_BYTES:
            statements.append(head + ", ".join(values))
            values, size = [], len(head)
        values.append(text)
        size += len(text) + 2
    if values:
        statements.append(head + ", ".join(values))
    return statements


def columns_of(db: sqlite3.Connection, table: str) -> list[str]:
    return [row[1] for row in db.execute(f"PRAGMA table_info({table})")]


def local_rows(db: sqlite3.Connection, table: str, where: str = "", params=()) -> tuple[list[str], list[tuple]]:
    columns = columns_of(db, table)
    return columns, [tuple(row) for row in db.execute(f"SELECT {', '.join(columns)} FROM {table} {where}", params)]


def fingerprint(*parts) -> str:
    return hashlib.sha256(repr(parts).encode("utf-8")).hexdigest()


def fixture_units(db: sqlite3.Connection) -> tuple[list[dict], dict[str, list[str]]]:
    """Every match with its events and the players who played, newest first, each with a fingerprint."""
    match_columns, matches = local_rows(db, "matches", "ORDER BY season DESC, kickoff_utc DESC, fixture_id DESC")
    event_columns, events = local_rows(db, "events", "ORDER BY fixture_id, event_id")
    player_columns, players = local_rows(db, "player_matches", "WHERE minutes > 0 ORDER BY fixture_id, player_id")
    by_fixture = {}
    for row in events:
        by_fixture.setdefault(row[0], ([], []))[0].append(row)
    for row in players:
        by_fixture.setdefault(row[0], ([], []))[1].append(row)
    units = []
    for match in matches:
        fixture_events, fixture_players = by_fixture.get(match[0], ([], []))
        units.append({"unit": f"fixture:{match[0]}", "fixture_id": match[0], "match": match,
                      "events": fixture_events, "players": fixture_players,
                      "fingerprint": fingerprint(match, fixture_events, fixture_players)})
    return units, {"matches": match_columns, "events": event_columns, "player_matches": player_columns}


def today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


class Budget:
    """Rows D1 may still write today, shared by every run of the day."""

    def __init__(self, d1: D1, daily: int):
        self.d1, self.daily, self.day = d1, daily, today()
        found = d1.query("SELECT rows_written FROM chat_sync_usage WHERE day = ?", [self.day])
        self.used = int(found[0]["rows_written"]) if found else 0

    def left(self) -> int:
        return self.daily - self.used

    def record(self, rows: int) -> None:
        if rows <= 0 or self.d1.dry_run:
            return
        self.used += rows
        self.d1.query("INSERT INTO chat_sync_usage (day, rows_written) VALUES (?, ?) ON CONFLICT(day) DO UPDATE "
                      "SET rows_written = rows_written + excluded.rows_written", [self.day, rows], write=True)


def sync_small_table(d1: D1, db: sqlite3.Connection, table: str, budget: Budget, report: list[str]) -> bool:
    """Make one small table equal to the local one, row by row. False when today's budget is too small."""
    keys = SMALL_TABLES[table]
    columns, rows = local_rows(db, table)
    wanted = {tuple(row[columns.index(key)] for key in keys): row for row in rows}
    remote = {tuple(row[key] for key in keys): tuple(row[column] for column in columns)
              for row in d1.query(f"SELECT {', '.join(columns)} FROM {table}")}
    changed = [row for key, row in wanted.items() if remote.get(key) != row]
    gone = [key for key in remote if key not in wanted]
    if not changed and not gone:
        return True
    cost = (len(changed) + len(gone)) * ROW_COST[table]
    if cost > budget.left():
        report.append(f"{table}: {len(changed)} changed rows wait for tomorrow's budget")
        return False
    before = d1.written
    for statement in inserts(table, columns, changed, "INSERT OR REPLACE"):
        d1.query(statement, write=True)
    for start in range(0, len(gone), 200):
        chunk = gone[start:start + 200]
        condition = " OR ".join("(" + " AND ".join(f"{key} = {literal(value)}" for key, value in zip(keys, key_values)) + ")"
                                for key_values in chunk)
        d1.query(f"DELETE FROM {table} WHERE {condition}", write=True)
    budget.record(d1.written - before or cost)
    report.append(f"{table}: {len(changed)} rows sent, {len(gone)} removed")
    return True


def sync_fixtures(d1: D1, units: list[dict], columns: dict, budget: Budget, report: list[str]) -> int:
    """Send the matches whose fingerprint D1 does not have yet, newest first, until the budget runs out."""
    remote = {row["unit"]: row["fingerprint"] for row in d1.query("SELECT unit, fingerprint FROM chat_sync WHERE unit LIKE 'fixture:%'")}
    local = {unit["unit"] for unit in units}
    stale = [unit for unit in units if remote.get(unit["unit"]) != unit["fingerprint"]]
    gone = [int(name.split(":", 1)[1]) for name in remote if name not in local]
    sent = 0
    for start in range(0, len(stale), FIXTURES_PER_BATCH):
        batch = stale[start:start + FIXTURES_PER_BATCH]
        cost = sum(ROW_COST["matches"] + ROW_COST["events"] * len(unit["events"])
                   + ROW_COST["player_matches"] * len(unit["players"]) for unit in batch) * 2 + len(batch)
        if cost > budget.left():
            report.append(f"{len(stale) - sent} matches wait for tomorrow's budget")
            break
        before = d1.written
        ids = ", ".join(str(unit["fixture_id"]) for unit in batch)
        d1.query(f"DELETE FROM events WHERE fixture_id IN ({ids})", write=True)
        d1.query(f"DELETE FROM player_matches WHERE fixture_id IN ({ids})", write=True)
        statements = inserts("matches", columns["matches"], [unit["match"] for unit in batch], "INSERT OR REPLACE")
        statements += inserts("events", columns["events"], [row for unit in batch for row in unit["events"]])
        statements += inserts("player_matches", columns["player_matches"], [row for unit in batch for row in unit["players"]])
        statements += inserts("chat_sync", ["unit", "fingerprint"], [(unit["unit"], unit["fingerprint"]) for unit in batch],
                              "INSERT OR REPLACE")
        for statement in statements:
            d1.query(statement, write=True)
        budget.record(d1.written - before or cost)
        sent += len(batch)
    if gone and budget.left() > len(gone) * 50:
        before = d1.written
        for start in range(0, len(gone), 200):
            ids = ", ".join(str(fixture_id) for fixture_id in gone[start:start + 200])
            for table in ("events", "player_matches", "matches"):
                d1.query(f"DELETE FROM {table} WHERE fixture_id IN ({ids})", write=True)
            names = ", ".join(literal(f"fixture:{fixture_id}") for fixture_id in gone[start:start + 200])
            d1.query(f"DELETE FROM chat_sync WHERE unit IN ({names})", write=True)
        budget.record(d1.written - before)
        report.append(f"{len(gone)} matches no longer in the data removed")
    report.append(f"matches: {sent} sent, {len(stale) - sent} waiting, {len(units) - len(stale)} already up to date")
    return sent


def sync(d1: D1, db: sqlite3.Connection, daily: int = DAILY_WRITES) -> list[str]:
    # The tables are made even on a dry run (CREATE ... IF NOT EXISTS writes no rows),
    # so a dry run against a new database can still read and report.
    for statement in (part.strip() for part in D1_SCHEMA.split(";")):
        if statement:
            d1.query(statement)
    budget = Budget(d1, daily)
    report = [f"budget: {budget.used} of {daily} rows already written today"]
    for table in SMALL_TABLES:
        sync_small_table(d1, db, table, budget, report)
    units, columns = fixture_units(db)
    sync_fixtures(d1, units, columns, budget, report)
    report.append(f"rows written by this run: {d1.written}")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--database", type=Path, default=DATABASE, help="The local chat database.")
    parser.add_argument("--daily-writes", type=int, default=None,
                        help=f"Rows D1 may write per day (default CHAT_D1_DAILY_WRITES or {DAILY_WRITES}).")
    parser.add_argument("--dry-run", action="store_true",
                        help="Read D1 and report, changing no rows (the empty tables are still created).")
    args = parser.parse_args()
    settings = {name: local_setting(name) for name in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CHAT_D1_DATABASE_ID")}
    missing = [name for name, value in settings.items() if not value]
    if missing:
        raise SystemExit(f"Add {', '.join(missing)} to the environment or .env.")
    if not args.database.is_file():
        raise SystemExit(f"{args.database} is missing. Build it first: python src/chat/build_chat_db.py")
    daily = args.daily_writes or int(local_setting("CHAT_D1_DAILY_WRITES") or DAILY_WRITES)
    d1 = D1(settings["CLOUDFLARE_ACCOUNT_ID"], settings["CHAT_D1_DATABASE_ID"], settings["CLOUDFLARE_API_TOKEN"], args.dry_run)
    db = sqlite3.connect(f"{args.database.resolve().as_uri()}?mode=ro", uri=True)
    try:
        for line in sync(d1, db, daily):
            print(line)
    except SyncError as error:
        raise SystemExit(str(error)) from None
    finally:
        db.close()


if __name__ == "__main__":
    main()
