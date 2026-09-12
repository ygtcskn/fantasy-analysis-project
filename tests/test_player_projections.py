"""Availability regression cases; synthetic records, no network or real data writes."""
import unittest
from datetime import datetime, timezone

from src.player_projections.availability import apply_availability, resolve_availability


class AvailabilityTests(unittest.TestCase):
    def resolve(self, team_rows, fixture_rows=()):
        return resolve_availability(
            player_id="455805", team_id="34", fixture_id="19746612",
            kickoff=datetime(2026, 9, 13, tzinfo=timezone.utc),
            cutoff=datetime(2026, 9, 7, tzinfo=timezone.utc),
            team_rows=team_rows, fixture_rows=list(fixture_rows))

    def injury(self, end_date="2026-09-30"):
        return dict(player_id="455805", team_id="34", category="injury",
                    start_date="2026-09-04", end_date=end_date, completed="False")

    def test_estimate_suppresses_forecast_but_preserves_baseline(self):
        status = self.resolve([self.injury()])
        self.assertEqual(status["availability_status"], "expected_out")
        result = apply_availability({"expected_points": 6.7}, status, ["expected_points"])
        self.assertEqual(result["expected_points"], "")
        self.assertEqual(result["baseline_expected_points"], 6.7)
        self.assertFalse(result["eligible_for_selection"])

    def test_fixture_absence_zeroes_forecast_and_keeps_date(self):
        status = self.resolve([self.injury(), self.injury("")], [
            dict(player_id="455805", participant_id="34", fixture_id="19746612")])
        result = apply_availability({"chance_playing": .9}, status, ["chance_playing"])
        self.assertEqual(result["chance_playing"], 0)
        self.assertEqual(result["estimated_return_date"], "2026-09-30")

    def test_past_estimate_does_not_clear_unfinished_injury(self):
        self.assertEqual(self.resolve([self.injury("2026-09-06")])["availability_status"], "doubtful")

    def test_other_fixture_does_not_confirm_target_absence(self):
        result = self.resolve([], [dict(player_id="455805", participant_id="34", fixture_id="999")])
        self.assertEqual(result["availability_status"], "no_reported_absence")

    def test_unscoped_suspension_does_not_produce_zero(self):
        row = dict(self.injury(), category="suspended")
        self.assertEqual(self.resolve([row])["availability_status"], "unknown")


if __name__ == "__main__":
    unittest.main()
