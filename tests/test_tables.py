"""Synthetic cases for the published tables.

The rules worth pinning are the ones a browser used to apply and a reader
cannot see in the output: which matches count, when a provider total is
preferred over a counted one, and when a missing value must stay missing
instead of becoming a zero.
"""
import tempfile
import unittest
from pathlib import Path

from src.tables import (common, player_leaders, player_season, standings,
                        team_leaders, team_results, team_season)
from src.tables.common import write_csv


class TablesTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source = self.root / "sportmonks"
        self.season_dir = self.source / "2026-2027"
        self.published = self.root / "final"
        write_csv(self.season_dir / "teams.csv", [
            {"id": "34", "name": "Alfa", "short_code": "ALF"},
            {"id": "88", "name": "Çamlı", "short_code": "CAM"}])

    def fixtures(self, second_state="FT"):
        write_csv(self.season_dir / "fixtures.csv", [
            {"fixture_id": "1", "home_team_id": "34", "away_team_id": "88", "league_id": "600",
             "season_id": "9", "stage_id": "7", "state": "FT", "kickoff": "2026-09-04 17:00:00",
             "round.name": "1"},
            {"fixture_id": "2", "home_team_id": "88", "away_team_id": "34", "league_id": "600",
             "season_id": "9", "stage_id": "7", "state": second_state, "kickoff": "2026-09-11 17:00:00",
             "round.name": "2"}])

    def scores(self, rows=None):
        write_csv(self.season_dir / "fixture_scores.csv", rows if rows is not None else [
            {"fixture_id": "1", "participant_id": "34", "description": "CURRENT", "score.goals": "2"},
            {"fixture_id": "1", "participant_id": "88", "description": "CURRENT", "score.goals": "0"},
            {"fixture_id": "2", "participant_id": "88", "description": "CURRENT", "score.goals": "1"},
            {"fixture_id": "2", "participant_id": "34", "description": "CURRENT", "score.goals": "1"}])

    def standing(self, **overrides):
        row = {"participant_id": "34", "position": "1", "points": "4", "league_id": "600",
               "stage_id": "7", "group_id": "", "participant.name": "Alfa"}
        row.update(overrides)
        write_csv(self.season_dir / "standings.csv", [row])

    def season(self):
        return common.Season("2026-2027", self.source, self.root / "tables", self.published)

    # ------------------------------------------------------------------ matches

    def test_only_finished_fixtures_with_both_scores_count_from_both_sides(self):
        self.fixtures(second_state="INPLAY_2ND_HALF")
        self.scores()
        played = self.season().played
        self.assertEqual({row["fixture_id"] for row in played}, {"1"},
                         "a fixture caught in play waits for the next download")
        self.assertEqual(sorted(row["result"] for row in played), ["L", "W"])
        self.assertEqual(len(team_results.build(self.season())[0].rows), 2)

    def test_a_conflicting_duplicate_score_is_unknown_rather_than_guessed(self):
        self.fixtures()
        self.scores([
            {"fixture_id": "1", "participant_id": "34", "description": "CURRENT", "score.goals": "2"},
            {"fixture_id": "1", "participant_id": "34", "description": "CURRENT", "score.goals": "3"},
            {"fixture_id": "1", "participant_id": "88", "description": "CURRENT", "score.goals": "0"}])
        self.assertEqual(self.season().played, [])

    # ---------------------------------------------------------------- standings

    def test_the_league_table_prefers_the_providers_totals_and_marks_counted_ones(self):
        self.fixtures()
        self.scores()
        self.standing(**{"details.overall_matches": "2", "details.overall_scored": "3"})
        row = standings.build(self.season())[0].rows[0]
        self.assertEqual(row["scored"], "3", "the provider's own total is never recalculated")
        self.assertEqual(row["wins"], "1")
        self.assertIn("wins", row["derived"].split(), "a counted cell is reported for its asterisk")
        self.assertNotIn("scored", row["derived"].split())
        self.assertEqual(row["qualification"], "ucl")

    def test_incomplete_results_leave_counted_totals_missing_rather_than_partial(self):
        self.fixtures()
        # The second fixture is finished but has no saved score for either side.
        self.scores([
            {"fixture_id": "1", "participant_id": "34", "description": "CURRENT", "score.goals": "2"},
            {"fixture_id": "1", "participant_id": "88", "description": "CURRENT", "score.goals": "0"}])
        self.standing()
        row = standings.build(self.season())[0].rows[0]
        self.assertEqual(row["played"], "1")
        self.assertEqual(row["wins"], "", "one unscored match must not become a one-win season")
        self.assertEqual(row["scored"], "")

    # --------------------------------------------------------------- team table

    def test_team_statistics_need_every_counted_match_to_supply_them(self):
        self.fixtures()
        self.scores()
        self.standing()
        write_csv(self.season_dir / "team_metrics.csv", [
            {"fixture_id": "1", "team_id": "34", "name": "EXPECTED_GOALS", "value": "1.5"},
            {"fixture_id": "1", "team_id": "88", "name": "EXPECTED_GOALS", "value": "0.4"},
            {"fixture_id": "1", "team_id": "34", "name": "SHOTS_TOTAL", "value": "12"},
            {"fixture_id": "2", "team_id": "34", "name": "EXPECTED_GOALS", "value": "0.9"},
            {"fixture_id": "2", "team_id": "88", "name": "EXPECTED_GOALS", "value": "1.1"}])
        row = team_season.build(self.season())[0].rows[0]
        self.assertEqual(row["xg"], "2.4", "both counted matches supplied xG")
        self.assertEqual(row["shots"], "", "a total over some of the matches is not a season total")
        self.assertEqual(row["xg_against"], "1.5", "the opponent's row says what was conceded")
        self.assertEqual(row["clean_sheets"], "1")
        self.assertEqual(row["unknown_results"], "0")

    def test_a_match_without_a_saved_score_is_not_a_clean_sheet(self):
        self.fixtures()
        self.scores([
            {"fixture_id": "1", "participant_id": "34", "description": "CURRENT", "score.goals": "2"},
            {"fixture_id": "1", "participant_id": "88", "description": "CURRENT", "score.goals": "0"}])
        self.standing()
        row = team_season.build(self.season())[0].rows[0]
        self.assertEqual(row["clean_sheets"], "1")
        self.assertEqual(row["unknown_results"], "1")

    # ------------------------------------------------------------- player table

    def test_player_totals_report_their_coverage_and_never_read_a_blank_as_zero(self):
        self.fixtures()
        self.scores()
        self.standing()
        write_csv(self.season_dir / "player_match_stats.csv", [
            {"fixture_id": "1", "player_id": "10", "team_id": "34", "name": "Ali",
             "position": "Attacker", "minutes_played": "90", "goals": "2", "rating": "8.4"},
            {"fixture_id": "2", "player_id": "10", "team_id": "34", "name": "Ali",
             "position": "Attacker", "minutes_played": "80", "goals": "", "rating": "7.6"}])
        row = player_season.build(self.season())[0].rows[0]
        self.assertEqual(row["goals"], "2")
        self.assertEqual(row["goals_supplied"], "1", "one of two records supplied goals")
        self.assertEqual(row["minutes_played"], "170")
        self.assertEqual(row["rated_matches"], "2")
        self.assertEqual(row["tier"], "P", "two rated matches is still provisional")
        self.assertEqual(row["role"], "attacker")

    def test_a_zero_minute_record_and_an_out_of_range_rating_are_not_averaged(self):
        self.fixtures()
        self.scores()
        self.standing()
        write_csv(self.season_dir / "player_match_stats.csv", [
            {"fixture_id": "1", "player_id": "10", "team_id": "34", "name": "Ali",
             "position": "Goalkeeper", "minutes_played": "0", "rating": "6.0"},
            {"fixture_id": "2", "player_id": "10", "team_id": "34", "name": "Ali",
             "position": "Goalkeeper", "minutes_played": "90", "rating": "12"}])
        row = player_season.build(self.season())[0].rows[0]
        self.assertEqual(row["rated_matches"], "0")
        self.assertEqual(row["rating_average"], "")
        self.assertEqual(row["tier"], "U")
        self.assertEqual(row["role"], "goalkeeper")

    # -------------------------------------------------------------- leader cards

    def test_equal_values_share_a_rank_and_nobody_leads_a_card_on_nothing(self):
        rows = [{"player_name": "Bora", "goals": "3", "minutes_played": "200"},
                {"player_name": "Ali", "goals": "3", "minutes_played": "300"},
                {"player_name": "Can", "goals": "1", "minutes_played": "90"},
                {"player_name": "Dora", "goals": "0", "minutes_played": "90"}]
        leaders = player_leaders.rank_rows(rows, "goals")
        self.assertEqual([entry["rank"] for entry in leaders], [1, 1, 3])  # rank_rows is pre-format
        self.assertEqual([entry["row"]["player_name"] for entry in leaders], ["Ali", "Bora", "Can"],
                         "more minutes breaks a tie before the name does")
        self.assertTrue(all(entry["row"]["player_name"] != "Dora" for entry in leaders))

    def test_fewest_conceded_is_ranked_upward_and_zero_still_leads(self):
        rows = [{"team_name": "Alfa", "conceded": "4"}, {"team_name": "Çamlı", "conceded": "0"},
                {"team_name": "Bora", "conceded": ""}]
        leaders = team_leaders.rank_rows(rows, "conceded", ascending=True)
        self.assertEqual([entry["row"]["team_name"] for entry in leaders], ["Çamlı", "Alfa"])
        self.assertEqual(leaders[0]["value"], 0.0)

    def test_names_that_tie_are_ordered_the_way_a_turkish_reader_expects(self):
        names = ["Zeki", "Çetin", "Ali", "Irmak", "İsmail", "Sema", "Şule", "Ufuk", "Ülkü"]
        self.assertEqual(sorted(names, key=common.turkish_key),
                         ["Ali", "Çetin", "Irmak", "İsmail", "Sema", "Şule", "Ufuk", "Ülkü", "Zeki"])


if __name__ == "__main__":
    unittest.main()
