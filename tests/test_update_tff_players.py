"""TFF-to-Sportmonks matcher rules; in-memory rows only, no data files."""
import tempfile
from pathlib import Path
import unittest
from src.fetch import update_tff_players as matcher

PLAYERS = {
    "1": {"display_name": "Talisca", "firstname": "Anderson", "lastname": "Souza Conceição"},
    "2": {"display_name": "Mert Müldür", "firstname": "Mert", "lastname": "Müldür"},
    "3": {"display_name": "Levent Mercan", "firstname": "Münir", "lastname": "Mercan"},
    "4": {"display_name": "Edin Dzeko", "firstname": "Edin", "lastname": "Dzeko"},
}
TEAM_IDS = {matcher.normalized("Fenerbahçe"): "88"}
TEAM_NAMES = {"88": "Fenerbahçe"}
SEASON_SQUAD = {"88": {"1", "2", "3", "4"}}


def tff(name, position="OS"):
    return {"player_name": name, "team_name": "Fenerbahçe", "position": position}


def match(rows, current=None, overrides=None):
    _, reports, _ = matcher.match_snapshot(rows, PLAYERS, TEAM_IDS, TEAM_NAMES, SEASON_SQUAD,
                                           overrides or {}, current)
    return [(r["match_status"], r["match_method"], r["sportmonks_player_id"]) for r in reports]


class DisplayNameTests(unittest.TestCase):
    def test_known_as_name_matches_when_legal_names_do_not(self):
        self.assertEqual(match([tff("Talisca", "FOR")]), [("matched", "exact_display_name", "1")])

    def test_display_name_component_matches(self):
        self.assertEqual(match([tff("Levent", "DEF")]),
                         [("matched", "exact_display_name_component", "3")])

    def test_legal_name_match_is_never_overridden_by_display_name(self):
        self.assertEqual(match([tff("Mert", "DEF")]), [("matched", "exact_firstname", "2")])


class CurrentSquadTests(unittest.TestCase):
    current = {"88": {"2", "3"}}

    def test_departed_player_is_left_league_not_matched_or_awaiting_review(self):
        self.assertEqual(match([tff("Talisca", "FOR")], self.current),
                         [("left_league", "exact_display_name", "")])

    def test_current_player_still_matches(self):
        self.assertEqual(match([tff("Mert", "DEF")], self.current),
                         [("matched", "exact_firstname", "2")])

    def test_override_to_departed_player_is_refused(self):
        key = matcher.override_key("Dzeko", "Fenerbahçe", "FOR")
        self.assertEqual(match([tff("Dzeko", "FOR")], self.current, {key: "4"}),
                         [("left_league", "manual_override", "")])

    def test_unknown_name_stays_unmatched_for_review(self):
        self.assertEqual(match([tff("Jelert", "DEF")], self.current), [("unmatched", "", "")])

    def test_without_current_squads_the_season_squad_is_used(self):
        self.assertEqual(match([tff("Talisca", "FOR")]), [("matched", "exact_display_name", "1")])

    def test_left_league_rows_are_not_added_to_the_review_template(self):
        reports = [{"tff_player_name": "Talisca", "tff_team_name": "Fenerbahçe",
                    "tff_position": "FOR", "match_status": "left_league"}]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "overrides.csv"
            matcher.write_override_template(path, reports)
            self.assertFalse(path.exists())


class CurrentSquadFileTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.folder = Path(self.directory.name)

    def tearDown(self):
        self.directory.cleanup()

    def test_missing_file_means_no_filter(self):
        self.assertIsNone(matcher.current_squads(self.folder, TEAM_NAMES, PLAYERS))

    def test_a_league_team_without_rows_means_no_filter(self):
        matcher.write_table(self.folder / "current_squads.csv",
                            [{"team_id": "99", "player_id": "2"}], ["team_id", "player_id"])
        self.assertIsNone(matcher.current_squads(self.folder, TEAM_NAMES, PLAYERS))

    def test_complete_file_lists_current_players(self):
        matcher.write_table(self.folder / "current_squads.csv",
                            [{"team_id": "88", "player_id": "2"}], ["team_id", "player_id"])
        self.assertEqual(matcher.current_squads(self.folder, TEAM_NAMES, PLAYERS), {"88": {"2"}})


if __name__ == "__main__":
    unittest.main()
