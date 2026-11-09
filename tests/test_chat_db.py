"""The chatbot's database builder (src/chat/build_chat_db.py), on a tiny made-up season."""
from pathlib import Path
import sqlite3
import tempfile
import unittest

from src.chat import build_chat_db
from src.shared import write_csv


def make_season(root: Path, folder="2023-2024"):
    """One finished match (Beşiktaş 2-1 Fenerbahçe) and one not yet played."""
    season = root / folder
    write_csv(season / "fixtures.csv", [
        {"fixture_id": "1", "season_id": "22057", "kickoff": "2023-08-14 18:00:00", "state.developer_name": "FT",
         "home_team_id": "10", "away_team_id": "20", "round.name": "1"},
        {"fixture_id": "2", "season_id": "22057", "kickoff": "2023-08-21 18:00:00", "state.developer_name": "NS",
         "home_team_id": "20", "away_team_id": "10", "round.name": "2"},
    ])
    write_csv(season / "fixture_scores.csv", [
        {"fixture_id": "1", "participant_id": "10", "description": "CURRENT", "score.goals": "2"},
        {"fixture_id": "1", "participant_id": "20", "description": "CURRENT", "score.goals": "1"},
        {"fixture_id": "1", "participant_id": "10", "description": "1ST_HALF", "score.goals": "1"},
        {"fixture_id": "2", "participant_id": "10", "description": "CURRENT", "score.goals": "0"},
    ])
    write_csv(season / "teams.csv", [
        {"id": "10", "name": "Beşiktaş", "short_code": "BJK"},
        {"id": "20", "name": "Fenerbahçe", "short_code": "FB"},
    ])
    write_csv(season / "players.csv", [
        {"id": "100", "display_name": "Ciro Immobile", "common_name": "C. Immobile"},
        {"id": "200", "display_name": "Edin Džeko", "common_name": "E. Džeko"},
    ])
    write_csv(season / "events.csv", [
        {"fixture_id": "1", "event_id": "1", "type.developer_name": "GOAL", "minute": "12", "extra_minute": "",
         "team_id": "10", "player_id": "100", "related_player_id": "", "rescinded": ""},
        {"fixture_id": "1", "event_id": "2", "type.developer_name": "PENALTY", "minute": "90", "extra_minute": "3",
         "team_id": "10", "player_id": "100", "related_player_id": "", "rescinded": "False"},
        {"fixture_id": "1", "event_id": "3", "type.developer_name": "GOAL", "minute": "40", "extra_minute": "",
         "team_id": "20", "player_id": "200", "related_player_id": "", "rescinded": "True"},
        {"fixture_id": "1", "event_id": "4", "type.developer_name": "VAR", "minute": "41", "extra_minute": "",
         "team_id": "20", "player_id": "", "related_player_id": "", "rescinded": ""},
    ])
    write_csv(season / "player_match_stats.csv", [
        # Covered by the feed: blank assists mean none.
        {"fixture_id": "1", "player_id": "100", "team_id": "10", "name": "Ciro Immobile", "started": "1",
         "position": "Attacker", "minutes_played": "90", "rating": "8.1", "goals": "2", "assists": "",
         "shots_total": "4", "passes": "20", "expected_goals": ""},
        # Not covered (no coverage columns): blanks stay unknown.
        {"fixture_id": "1", "player_id": "300", "team_id": "20", "name": "Unknown Bench", "started": "0",
         "position": "Defender", "minutes_played": "", "rating": "", "goals": "", "assists": ""},
    ])
    write_csv(season / "standings.csv", [
        {"participant_id": "10", "stage_id": "5", "group_id": "", "position": "1", "points": "3",
         "details.overall_matches": "1", "details.overall_wins": "1", "details.overall_draws": "0",
         "details.overall_lost": "0", "details.overall_scored": "2", "details.overall_conceded": "1"},
    ])


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        make_season(self.root / "sportmonks")
        self.output = self.root / "chat.sqlite"
        self.report = build_chat_db.build(self.root / "sportmonks", self.output)
        self.db = sqlite3.connect(self.output)

    def tearDown(self):
        self.db.close()
        self.folder.cleanup()

    def one(self, sql, *args):
        return self.db.execute(sql, args).fetchone()

    def test_report_counts_each_table(self):
        self.assertEqual(self.report, {"2023/2024": {"matches": 2, "events": 2, "player_matches": 2, "standings": 1}})

    def test_finished_match_has_its_current_score(self):
        self.assertEqual(self.one("SELECT season, kickoff_utc, finished, home_goals, away_goals FROM matches "
                                  "WHERE fixture_id = 1"), ("2023/2024", "2023-08-14T18:00:00Z", 1, 2, 1))

    def test_unplayed_match_has_no_score(self):
        self.assertEqual(self.one("SELECT finished, home_goals, away_goals FROM matches WHERE fixture_id = 2"),
                         (0, None, None))

    def test_conflicting_scores_are_unknown(self):
        scores = build_chat_db.final_scores(
            [{"fixture_id": "1", "participant_id": "10", "description": "CURRENT", "score.goals": "2"},
             {"fixture_id": "1", "participant_id": "10", "description": "CURRENT", "score.goals": "3"},
             {"fixture_id": "1", "participant_id": "20", "description": "CURRENT", "score.goals": "0"}],
            [{"fixture_id": "1", "state": "FT", "home_team_id": "10", "away_team_id": "20"}])
        self.assertEqual(scores, {"1": (None, 0)})

    def test_rescinded_and_unlisted_events_are_left_out(self):
        rows = self.db.execute("SELECT event_id, type, minute, extra_minute FROM events ORDER BY event_id").fetchall()
        self.assertEqual(rows, [(1, "GOAL", 12, None), (2, "PENALTY", 90, 3)])

    def test_a_blank_is_zero_only_on_a_covered_match(self):
        self.assertEqual(self.one("SELECT minutes, goals, assists, expected_goals FROM player_matches "
                                  "WHERE player_id = 100"), (90.0, 2.0, 0.0, None))
        self.assertEqual(self.one("SELECT minutes, goals, assists FROM player_matches WHERE player_id = 300"),
                         (None, None, None))

    def test_names_can_be_searched_without_turkish_letters(self):
        self.assertEqual(self.one("SELECT name FROM teams WHERE search_name = 'besiktas'"), ("Beşiktaş",))
        self.assertEqual(self.one("SELECT name FROM players WHERE search_name = 'edin dzeko'"), ("Edin Džeko",))
        # A player missing from players.csv still gets the name from the stats file.
        self.assertEqual(self.one("SELECT name FROM players WHERE player_id = 300"), ("Unknown Bench",))

    def test_standings_use_the_overall_totals(self):
        self.assertEqual(self.one("SELECT position, points, played, won, goals_for, goals_against FROM standings"),
                         (1, 3, 1, 1, 2, 1))

    def test_names_take_the_latest_season(self):
        # A later season with no matches yet, where the club has a new name.
        later = self.root / "sportmonks" / "2024-2025"
        write_csv(later / "fixtures.csv", [], columns=["fixture_id"])
        write_csv(later / "teams.csv", [{"id": "10", "name": "Beşiktaş JK", "short_code": "BJK"}])
        self.db.close()
        build_chat_db.build(self.root / "sportmonks", self.output)
        self.db = sqlite3.connect(self.output)
        self.assertEqual(self.one("SELECT name FROM teams WHERE team_id = 10"), ("Beşiktaş JK",))

    def test_a_failed_build_keeps_the_previous_file(self):
        before = self.output.read_bytes()
        self.db.close()
        # The same fixture in two seasons breaks the build.
        make_season(self.root / "sportmonks", "2024-2025")
        with self.assertRaises(SystemExit):
            build_chat_db.build(self.root / "sportmonks", self.output)
        self.assertEqual(self.output.read_bytes(), before)
        self.assertEqual([path.name for path in self.root.iterdir() if path.name.endswith(".tmp")], [])
        self.db = sqlite3.connect(self.output)


class SearchNameTests(unittest.TestCase):
    def test_folds_turkish_letters_case_and_spaces(self):
        self.assertEqual(build_chat_db.search_name("  İrfan Can  KAHVECİ "), "irfan can kahveci")
        self.assertEqual(build_chat_db.search_name("Göztepe Şükrü Çağlar"), "goztepe sukru caglar")


if __name__ == "__main__":
    unittest.main()
