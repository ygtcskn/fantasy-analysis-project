"""The chatbot's tools (src/chat/tools.py), on a tiny made-up database."""
import sqlite3
import unittest

from src.chat import build_chat_db, tools
from src.chat.build_chat_db import search_name


def insert(db, table, **values):
    columns = list(values)
    db.execute(f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
               list(values.values()))


def sample_database():
    """2023/24: Beşiktaş 2-1 Fenerbahçe, Fenerbahçe 3-0 Beşiktaş, one unplayed. 2022/23: 1-1."""
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript(build_chat_db.SCHEMA)
    for season in ("2022/2023", "2023/2024"):
        insert(db, "seasons", season=season)
    for team_id, name, code in ((10, "Beşiktaş", "BJK"), (20, "Fenerbahçe", "FB")):
        insert(db, "teams", team_id=team_id, name=name, short_code=code, search_name=search_name(name))
    for player_id, name in ((100, "Ciro Immobile"), (200, "Edin Džeko"),
                            (201, "Mert Hakan Yandaş"), (202, "Mert Müldür")):
        insert(db, "players", player_id=player_id, name=name, search_name=search_name(name))
    for fixture_id, season, kickoff, state, finished, home, away, home_goals, away_goals in (
            (1, "2023/2024", "2023-09-01T17:00:00Z", "FT", 1, 10, 20, 2, 1),
            (2, "2023/2024", "2024-02-01T17:00:00Z", "FT", 1, 20, 10, 3, 0),
            (3, "2023/2024", "2024-05-01T17:00:00Z", "NS", 0, 10, 20, None, None),
            (4, "2022/2023", "2022-10-01T17:00:00Z", "FT", 1, 10, 20, 1, 1)):
        insert(db, "matches", fixture_id=fixture_id, season=season, round="1", kickoff_utc=kickoff, state=state,
               finished=finished, home_team_id=home, away_team_id=away, home_goals=home_goals, away_goals=away_goals)
    seasons = {1: "2023/2024", 2: "2023/2024", 4: "2022/2023"}
    for fixture_id, player_id, team_id, position, started, minutes, rating, xg, goals, assists in (
            (1, 100, 10, "Attacker", 1, 90, 8.1, 1.5, 2, 0),
            (1, 200, 20, "Attacker", 1, 90, 7.0, None, 1, 0),
            (2, 200, 20, "Attacker", 1, 90, 8.5, 0.9, 2, 1),
            (2, 100, 10, "Attacker", 1, 60, 6.2, 0.2, 0, 0),
            (2, 201, 20, "Midfielder", 0, 30, 7.1, None, 1, 0),
            (2, 202, 20, "Defender", 0, None, None, None, None, None),   # on the bench, did not play
            (4, 202, 20, "Defender", 1, 90, 7.4, None, 1, 0)):
        insert(db, "player_matches", fixture_id=fixture_id, player_id=player_id, season=seasons[fixture_id],
               team_id=team_id, position=position, started=started, minutes=minutes, rating=rating,
               expected_goals=xg, goals=goals, assists=assists, yellowcards=0, redcards=0, yellowred_cards=0)
    for event_id, kind, minute, extra, team_id, player_id, related in (
            (1, "GOAL", 12, None, 10, 100, None),
            (2, "GOAL", 40, None, 20, 200, 201),
            (3, "YELLOWCARD", 55, None, 20, 200, None),
            (4, "SUBSTITUTION", 70, None, 20, 201, 200),
            (5, "PENALTY", 90, 3, 10, 100, None)):
        insert(db, "events", fixture_id=1, event_id=event_id, season="2023/2024", type=kind, minute=minute,
               extra_minute=extra, team_id=team_id, player_id=player_id, related_player_id=related)
    for team_id, position, won, lost, scored, conceded in ((20, 1, 1, 1, 4, 2), (10, 2, 1, 1, 2, 4)):
        insert(db, "standings", season="2023/2024", stage_id=5, group_id="", team_id=team_id, position=position,
               points=3, played=2, won=won, drawn=0, lost=lost, goals_for=scored, goals_against=conceded)
    return db


def names(answer, table=0, column="name"):
    return [row[column] for row in answer.tables[table].rows]


class ToolTests(unittest.TestCase):
    def setUp(self):
        self.db = sample_database()

    def tearDown(self):
        self.db.close()

    def test_list_seasons(self):
        rows = tools.list_seasons(self.db).tables[0].rows
        self.assertEqual([(r["season"], r["matches"], r["finished"]) for r in rows],
                         [("2022/2023", 1, 1), ("2023/2024", 3, 2)])
        self.assertEqual(rows[1]["expected_goals_recorded_percent"], 60)

    def test_team_rankings_use_team_match_values_and_flag_missing_sides(self):
        self.db.execute("UPDATE matches SET round = '2' WHERE fixture_id = 3")
        for fixture, team, shots, xg in ((1, 10, 9, 1.2), (1, 20, 8, None), (2, 10, 10, 0), (2, 20, 17, 2.1)):
            insert(self.db, "dashboard_team_stats", fixture_id=fixture, team_id=team, shots_total=shots, xg=xg)
        shots = tools.team_leaderboard(self.db, "shots_total", week="1", limit=1)
        self.assertEqual([(r["team"], r["value"]) for r in shots.tables[0].rows], [("Fenerbahçe", 25)])
        self.assertFalse(any("cannot be confirmed" in note for note in shots.notes))
        xg = tools.team_leaderboard(self.db, "xg", week="1")
        self.assertEqual(xg.tables[0].rows[0]["matches_recorded"], 1)
        self.assertTrue(any("3 of 4 team-match" in note and "cannot be confirmed" in note for note in xg.notes))
        future = tools.team_leaderboard(self.db, "shots_total", week="2")
        self.assertEqual(future.tables[0].rows, [])
        self.assertIn("0 of 1 scheduled matches are finished.", future.notes)
        fixtures = tools.matchweek_fixtures(self.db, week="2")
        self.assertEqual(names(fixtures, column="fixture_id"), [3])

    def test_dashboard_returns_pressure_phases_and_saved_minutes(self):
        insert(self.db, "dashboard_pressure", fixture_id=1, elapsed_minute=47, clock="45+2", phase=2,
               home_pressure=60, away_pressure=40)
        pressure = tools.match_dashboard(self.db, 1, section="pressure")
        self.assertEqual(pressure.tables[0].rows, [{"phase": "31–45+", "recorded_minutes": 1,
                                                   "home_share": 60, "away_share": 40}])
        point = tools.match_dashboard(self.db, 1, section="pressure", minute="45+2'")
        self.assertEqual(point.tables[0].rows[0]["home_pressure"], 60)

    def test_find_team_by_name_or_short_code(self):
        self.assertEqual(names(tools.find_team(self.db, "fener")), ["Fenerbahçe"])
        self.assertEqual(names(tools.find_team(self.db, "BJK")), ["Beşiktaş"])
        missing = tools.find_team(self.db, "galatasaray")
        self.assertEqual(names(missing), [])
        self.assertIn("No team matches", missing.notes[0])

    def test_find_player_flags_several_matches(self):
        answer = tools.find_player(self.db, "mert")
        self.assertEqual(names(answer), ["Mert Hakan Yandaş", "Mert Müldür"])
        self.assertIn("ask them", answer.notes[0])
        self.assertEqual(names(tools.find_player(self.db, "mert", season="2022/2023")), ["Mert Müldür"])
        exact = tools.find_player(self.db, "Edin Dzeko")
        self.assertEqual((names(exact), exact.notes), (["Edin Džeko"], []))
        self.assertEqual(exact.tables[0].rows[0]["latest_team"], "Fenerbahçe")

    def test_find_matches_head_to_head(self):
        answer = tools.find_matches(self.db, 10, opponent_id=20)
        summary = answer.tables[0].rows[0]
        self.assertEqual((summary["played"], summary["won"], summary["drawn"], summary["lost"],
                          summary["goals_for"], summary["goals_against"]), (3, 1, 1, 1, 3, 5))
        self.assertEqual(names(answer, 1, "fixture_id"), [2, 1, 4])   # newest first, unplayed left out
        self.assertEqual(names(answer, 1, "result_for_team"), ["loss", "win", "draw"])

    def test_find_matches_filters_and_limit(self):
        self.assertEqual(names(tools.find_matches(self.db, 10, season="2023-24"), 1, "fixture_id"), [2, 1])
        self.assertEqual(names(tools.find_matches(self.db, 10, venue="home"), 1, "fixture_id"), [1, 4])
        short = tools.find_matches(self.db, 10, limit=2)
        self.assertEqual(len(short.tables[1].rows), 2)
        self.assertIn("2 most recent of 3", short.notes[-1])

    def test_match_details(self):
        answer = tools.match_details(self.db, 1)
        goals = answer.tables[1].rows
        self.assertEqual([(g["minute"], g["kind"], g["player"]) for g in goals],
                         [("12", "goal", "Ciro Immobile"), ("40", "goal", "Edin Džeko"),
                          ("90+3", "penalty goal", "Ciro Immobile")])
        self.assertEqual(goals[1]["assist"], "Mert Hakan Yandaş")
        self.assertEqual([(c["minute"], c["kind"]) for c in answer.tables[2].rows], [("55", "yellow card")])
        self.assertEqual(names(answer, 3, "player"), ["Ciro Immobile", "Edin Džeko"])   # home team first

    def test_leaderboard_goals(self):
        answer = tools.leaderboard(self.db, "goals", season="2023/2024")
        self.assertEqual([(r["player"], r["goals"]) for r in answer.tables[0].rows],
                         [("Edin Džeko", 3), ("Ciro Immobile", 2), ("Mert Hakan Yandaş", 1)])
        self.assertTrue(any("still being played" in note for note in answer.notes))

    def test_leaderboard_warns_about_missing_data(self):
        answer = tools.leaderboard(self.db, "expected_goals")   # no season: the latest one
        self.assertEqual([(r["player"], r["expected_goals"]) for r in answer.tables[0].rows],
                         [("Ciro Immobile", 1.7), ("Edin Džeko", 0.9)])
        self.assertTrue(any("only 60%" in note for note in answer.notes))

    def test_player_leaderboard_uses_the_marked_matchweek(self):
        self.db.execute("UPDATE matches SET round = '2' WHERE fixture_id = 2")
        self.db.execute("UPDATE matches SET round = '3' WHERE fixture_id = 3")
        self.db.execute("INSERT INTO current_rounds VALUES ('2023/2024', '2')")
        self.db.execute("UPDATE player_matches SET fouls = 3 WHERE fixture_id = 2 AND player_id = 200")
        self.db.execute("UPDATE player_matches SET fouls = 0 WHERE fixture_id = 2 AND player_id = 100")

        current = tools.leaderboard(self.db, "goals", week="current")
        self.assertEqual(current.tables[0].title, "2023/2024 matchweek 2 by goals")
        self.assertEqual(names(current, column="player"), ["Edin Džeko", "Mert Hakan Yandaş"])
        previous = tools.leaderboard(self.db, "goals", week="previous")
        self.assertEqual(names(previous, column="player"), ["Ciro Immobile", "Edin Džeko"])
        self.assertEqual(tools.leaderboard(self.db, "goals").tables[0].rows[0]["goals"], 3)

        fouls = tools.leaderboard(self.db, "fouls", week="current")
        self.assertEqual(names(fouls, column="player"), ["Edin Džeko"])
        self.assertTrue(any("coverage is incomplete" in note for note in fouls.notes))
        player = tools.leaderboard(self.db, "fouls", week="current", player_id=100)
        self.assertEqual(player.tables[0].rows[0]["fouls"], 0)

    def test_week_queries_work_before_the_cache_has_a_current_round_table(self):
        self.db.execute("UPDATE matches SET round = '2' WHERE fixture_id = 3")
        self.db.execute("UPDATE matches SET kickoff_utc = '2999-05-01T17:00:00Z' WHERE fixture_id = 3")
        self.db.execute("DROP TABLE current_rounds")

        upcoming = tools.leaderboard(self.db, "goals", week="current")
        self.assertEqual(upcoming.tables[0].title, "2023/2024 matchweek 2 by goals")
        self.assertEqual(upcoming.tables[0].rows, [])
        self.assertIn("0 of 1 scheduled matches", upcoming.notes[0])
        played = tools.leaderboard(self.db, "goals", week="1")
        self.assertEqual(played.tables[0].rows[0]["goals"], 3)

    def test_leaderboard_position_and_minimum_minutes(self):
        answer = tools.leaderboard(self.db, "goals", season="2022/2023", position="Defender")
        self.assertEqual(names(answer, column="player"), ["Mert Müldür"])
        rating = tools.leaderboard(self.db, "average_rating")
        self.assertEqual(rating.tables[0].rows, [])
        self.assertIn("at least 900 minutes", rating.notes[0])

    def test_player_season_stats(self):
        answer = tools.player_season_stats(self.db, 200, last_matches=1)
        totals = answer.tables[0].rows[0]
        self.assertEqual((totals["season"], totals["appearances"], totals["goals"], totals["assists"],
                          totals["expected_goals"]), ("2023/2024", 2, 3, 1, 0.9))
        self.assertIn("recorded in only 1 of 2", answer.notes[0])
        recent = answer.tables[1].rows[0]
        self.assertEqual((recent["venue"], recent["opponent"], recent["fixture_id"]), ("home", "Beşiktaş", 2))

    def test_standings_and_team_season(self):
        self.assertEqual(names(tools.standings(self.db), column="team"), ["Fenerbahçe", "Beşiktaş"])
        answer = tools.team_season_stats(self.db, 10, "2023/2024")
        overall, home, away = answer.tables[0].rows
        self.assertEqual((overall["played"], overall["won"], overall["lost"], overall["points"]), (2, 1, 1, 3))
        self.assertEqual((home["won"], away["lost"]), (1, 1))
        self.assertEqual(names(answer, 1, "player"), ["Ciro Immobile"])
        self.assertIn("League position in the saved table: 2", answer.notes[0])


class RunToolTests(unittest.TestCase):
    def setUp(self):
        self.db = sample_database()

    def tearDown(self):
        self.db.close()

    def test_answers_are_text_tables(self):
        text = tools.run_tool(self.db, "leaderboard", {"stat": "goals", "season": "2023/2024"})
        self.assertIn("## 2023/2024 by goals", text)
        self.assertIn("Edin Džeko,Fenerbahçe,3,2,180", text)   # 180.0 minutes is written as 180

    def test_numbers_typed_as_text_are_accepted(self):
        self.assertIn("## Matches", tools.run_tool(self.db, "find_matches", {"team_id": "10", "limit": "2"}))

    def test_mistakes_come_back_as_errors(self):
        cases = {
            ("nope", ()): "there is no tool called nope",
            ("find_matches", ()): "find_matches needs team_id",
            ("find_matches", (("team", "x"),)): "has no input called team",
            ("find_matches", (("team_id", "ten"),)): "team_id must be a whole number",
            ("find_matches", (("team_id", 10), ("limit", 99))): "limit must be between 1 and 50",
            ("find_matches", (("team_id", 99),)): "No team has team_id 99",
            ("leaderboard", (("stat", "height"),)): "stat must be one of",
            ("standings", (("season", "2019/2020"),)): "Seasons available: 2022/2023, 2023/2024",
            ("standings", (("season", "last year"),)): "is not a season",
        }
        for (name, arguments), expected in cases.items():
            with self.subTest(name=name, arguments=arguments):
                text = tools.run_tool(self.db, name, dict(arguments))
                self.assertTrue(text.startswith("Error:"), text)
                self.assertIn(expected, text)

    def test_text_in_a_name_cannot_change_the_query(self):
        text = tools.run_tool(self.db, "find_team", {"name": "x'; DROP TABLE teams; --"})
        self.assertIn("No team matches", text)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM teams").fetchone()[0], 2)

    def test_every_tool_has_a_definition(self):
        definitions = tools.definitions()
        self.assertEqual([d["name"] for d in definitions], list(tools.TOOLS_BY_NAME))
        for definition in definitions:
            self.assertTrue(definition["description"])
            self.assertEqual(definition["input_schema"]["type"], "object")


if __name__ == "__main__":
    unittest.main()
