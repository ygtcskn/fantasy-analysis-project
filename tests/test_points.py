"""Regression cases for ledger filtering and on-pitch scoring."""
import tempfile
import unittest
from pathlib import Path

from src.points.run import (ROOT, build_season, published_generation, tff_positions,
                           unfinished_clubs, warn_if_unpublishing, write_csv)
from src.points.rules import ScoringRules


class PointsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.season = self.root / "2026-2027"
        self.rules = ScoringRules.load(ROOT / "config/tff_scoring_rules.csv")
        write_csv(self.season / "teams.csv", [{"id": "34", "name": "Home"}, {"id": "88", "name": "Away"}])

    def fixtures(self, state="FT"):
        write_csv(self.season / "fixtures.csv", [dict(fixture_id="1", home_team_id="34",
                  away_team_id="88", league_id="600", state=state, kickoff="2026-09-04 17:00:00")])
        write_csv(self.season / "fixture_scores.csv", [
            {"fixture_id": "1", "participant_id": "34", "description": "CURRENT", "score.goals": "0"},
            {"fixture_id": "1", "participant_id": "88", "description": "CURRENT", "score.goals": "1"}])

    def player(self, player_id="10", minutes="65"):
        return dict(fixture_id="1", player_id=player_id, team_id="34", name="Defender",
                    position="Defender", minutes_played=minutes, started="1", goals_conceded="")

    def test_unfinished_match_is_not_scored(self):
        self.fixtures("INPLAY")
        write_csv(self.season / "player_match_stats.csv", [self.player()])
        rows, _ = build_season("2026-2027", self.rules, {}, self.root)
        self.assertEqual(rows, [])

    def test_substitute_does_not_inherit_full_match_concession(self):
        self.fixtures()
        write_csv(self.season / "player_match_stats.csv", [self.player(), self.player("11", "90")])
        rows, _ = build_season("2026-2027", self.rules, {}, self.root)
        by_id = {row["player_id"]: row for row in rows}
        self.assertEqual(by_id["10"]["points_clean_sheet"], self.rules.clean_sheet["DEF"])
        self.assertEqual(by_id["11"]["points_clean_sheet"], 0)

    def test_duplicate_player_match_is_rejected(self):
        self.fixtures()
        write_csv(self.season / "player_match_stats.csv", [self.player(), self.player()])
        with self.assertRaisesRegex(ValueError, "duplicate"):
            build_season("2026-2027", self.rules, {}, self.root)

    def test_anonymous_rows_are_reported_without_blocking_valid_players(self):
        self.fixtures()
        write_csv(self.season / "player_match_stats.csv", [self.player(""), self.player(""), self.player()])
        rows, issues = build_season("2026-2027", self.rules, {}, self.root)
        self.assertEqual([row["player_id"] for row in rows], ["10"])
        omitted = [issue for issue in issues if "missing or invalid player_id" in issue["issue"]]
        self.assertEqual(len(omitted), 1)
        self.assertEqual(omitted[0]["count"], 2)
        self.assertIn("fixture 1", omitted[0]["issue"])

    def test_missing_fixture_id_is_reported(self):
        self.fixtures()
        invalid = dict(self.player(), fixture_id="")
        write_csv(self.season / "player_match_stats.csv", [invalid, self.player()])
        rows, issues = build_season("2026-2027", self.rules, {}, self.root)
        self.assertEqual(len(rows), 1)
        self.assertTrue(any("missing or invalid fixture_id" in issue["issue"] for issue in issues))

    def test_duplicate_matched_fantasy_identity_is_rejected(self):
        path = self.root / "tff.csv"
        row = dict(sportmonks_player_id="10", match_status="matched", position="DEF")
        write_csv(path, [row, row])
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            tff_positions(path)


if __name__ == "__main__":
    unittest.main()


class UnfinishedFixtureTests(unittest.TestCase):
    """A stale download must not be reported as a scoring error."""

    def season(self, folder, states):
        (folder / "2026-2027").mkdir(parents=True, exist_ok=True)
        header = "fixture_id,league_id,round.name,state,home_team_id,away_team_id\n"
        body = "".join(f"{i},600,1,{s},{10 + i},{20 + i}\n" for i, s in enumerate(states, 1))
        (folder / "2026-2027" / "fixtures.csv").write_text(header + body, encoding="utf-8")

    def test_in_progress_fixture_marks_both_clubs(self):
        with tempfile.TemporaryDirectory() as name:
            folder = Path(name)
            self.season(folder, ["FT", "INPLAY_2ND_HALF", "NS"])
            clubs = unfinished_clubs("2026-2027", folder)
        self.assertEqual(clubs, {"12", "22"})

    def test_finished_scheduled_and_called_off_fixtures_are_not_stale(self):
        with tempfile.TemporaryDirectory() as name:
            folder = Path(name)
            self.season(folder, ["FT", "NS", "TBA", "POSTPONED", "CANCELLED"])
            self.assertEqual(unfinished_clubs("2026-2027", folder), set())

    def test_a_missing_fixtures_file_reports_nothing_rather_than_failing(self):
        with tempfile.TemporaryDirectory() as name:
            self.assertEqual(unfinished_clubs("2026-2027", Path(name)), set())


class PublishedGenerationTests(unittest.TestCase):
    """A standalone rebuild must announce that it broke the published set."""

    def write(self, path, header, row):
        path.write_text(f"{header}\n{row}\n", encoding="utf-8")

    def test_a_stamped_file_reports_its_generation(self):
        with tempfile.TemporaryDirectory() as name:
            path = Path(name) / "ledger.csv"
            self.write(path, "player_id,points_total,pipeline_run_id", "1,5,20260908T200724Z_abc")
            self.assertEqual(published_generation(path), "20260908T200724Z_abc")

    def test_an_untagged_file_reports_nothing(self):
        with tempfile.TemporaryDirectory() as name:
            path = Path(name) / "ledger.csv"
            self.write(path, "player_id,points_total", "1,5")
            self.assertEqual(published_generation(path), "")

    def test_a_missing_or_empty_file_reports_nothing(self):
        with tempfile.TemporaryDirectory() as name:
            missing = Path(name) / "absent.csv"
            self.assertEqual(published_generation(missing), "")
            empty = Path(name) / "empty.csv"
            empty.write_text("player_id,pipeline_run_id\n", encoding="utf-8")
            self.assertEqual(published_generation(empty), "")

    def test_the_warning_fires_only_when_a_generation_was_replaced(self):
        import contextlib
        import io as stream_io
        for generations, expected in (([""], False), (["", ""], False),
                                      (["20260908T200724Z_abc", ""], True)):
            captured = stream_io.StringIO()
            with contextlib.redirect_stdout(captured):
                warn_if_unpublishing(generations, "2026-2027")
            printed = captured.getvalue()
            self.assertEqual(bool(printed.strip()), expected)
            if expected:
                self.assertIn("20260908T200724Z_abc", printed)
                self.assertIn("run_pipeline.py --season 2026-2027", printed)
