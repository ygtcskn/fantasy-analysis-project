"""Synthetic opponent/venue checks; no provider data or pipeline execution."""
import unittest
from src.player_projections.fixture_context import fixture_context, difficulty


class FixtureContextTests(unittest.TestCase):
    def context(self, venue="H", opponent_attack=1, opponent_conceded=1, team_attack=1):
        return fixture_context("1", "2", venue, 1.5, 1.0,
                               {"1": team_attack, "2": opponent_attack},
                               {"1": 1, "2": opponent_conceded})

    def test_weak_defense_is_better_for_attackers(self):
        easy = self.context(opponent_conceded=1.5)
        hard = self.context(opponent_conceded=.5)
        self.assertLess(easy["attacking_fixture_difficulty"], hard["attacking_fixture_difficulty"])
        self.assertLess(easy["opponent_defense_strength"], hard["opponent_defense_strength"])

    def test_strong_attack_is_harder_for_defenders(self):
        self.assertGreater(self.context(opponent_attack=2)["defensive_fixture_difficulty"],
                           self.context(opponent_attack=.5)["defensive_fixture_difficulty"])

    def test_venue_and_own_strength_are_distinct(self):
        self.assertGreater(self.context()["attacking_fixture_factor"], self.context("A")["attacking_fixture_factor"])
        self.assertLess(self.context()["defensive_fixture_factor"], self.context("A")["defensive_fixture_factor"])
        self.assertEqual(self.context(team_attack=2)["attacking_fixture_difficulty"], self.context()["attacking_fixture_difficulty"])

    def test_neutral_average_and_missing_history(self):
        result = fixture_context("1", "2", "H", 1.2, 1.2, {}, {})
        self.assertEqual(result["attacking_fixture_difficulty"], 3)
        self.assertEqual(result["defensive_fixture_difficulty"], 3)
        self.assertEqual(result["strength_context_status"], "league_average_fallback")
        self.assertEqual([difficulty(x) for x in [.5, .75, 1, 1.3, 1.6]], [1, 2, 3, 4, 5])


if __name__ == "__main__":
    unittest.main()
