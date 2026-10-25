"""Synthetic cases for the early-season radar reliability report.

The report decides which radar axes are worth reading after a handful of
rounds, so the rules worth pinning are the out-of-sample split, the measured
noise behind the small-sample prior, and the rank statistics it is scored by.
"""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from src.spider import radar_reliability as reliability
from src.shared import write_csv


def row(minutes, **values):
    return {"minutes_played": str(minutes), "touches": "40", **{key: str(value) for key, value in values.items()}}


class HelperTests(unittest.TestCase):
    def test_rank_statistics(self):
        self.assertEqual(reliability.ranks([2, 1, 2]), [2.5, 1.0, 2.5])
        self.assertAlmostEqual(reliability.spearman([1, 2, 3, 4], [1, 3, 2, 4]), 0.8)
        self.assertAlmostEqual(reliability.spearman([1, 2, 3], [1, 2, 3]), 1.0)
        self.assertIsNone(reliability.spearman([1, 2], [2, 1]))
        self.assertAlmostEqual(reliability.percentile_error([1, 2, 3], [1, 2, 3]), 0.0)
        self.assertEqual(reliability.reading(0.75), "strong")
        self.assertEqual(reliability.reading(0.1), "noise")
        self.assertEqual(reliability.reading(None), "unknown")

    def test_tally_reads_omitted_zeros_and_measures_match_noise(self):
        item = reliability.tally([row(90, goals=2), row(45, goals="")], "goals")
        self.assertEqual((item["events"], item["exposure"]), (2.0, 135.0))
        rate = 2 / 135
        expected = ((2 - 90 * rate) ** 2 + (45 * rate) ** 2) / 135 ** 2 * 2
        self.assertAlmostEqual(item["variance"], expected)
        # An uncovered match is unknown, not a zero, so the season is incomplete.
        self.assertIsNone(reliability.tally([row(90, goals=1), {"minutes_played": "90", "goals": ""}], "goals"))

    def test_ratio_needs_matching_attempts(self):
        made = reliability.tally([row(90, accurate_passes=30, passes=40)], "pass_accuracy")
        self.assertEqual((made["events"], made["exposure"]), (30.0, 40.0))
        self.assertIsNone(reliability.tally([row(90, accurate_passes=50, passes=40)], "pass_accuracy"))
        self.assertEqual(reliability.required_attempts("pass_accuracy", 330), 37)
        self.assertEqual(reliability.required_attempts("duel_pct", 90), 20)

    def test_prior_follows_measured_noise(self):
        # Steady players who really differ: no match noise, no adjustment.
        steady = [{"events": 10 * (0.1 + index * 0.01), "exposure": 900.0, "variance": 0.0} for index in range(20)]
        fitted = reliability.prior("goals", steady)
        self.assertAlmostEqual(fitted["mean"] * 90, 0.195)
        self.assertAlmostEqual(fitted["weight"], 0.0)
        # The same spread from one lucky match each is noise: the weight hits the cap.
        lucky = [reliability.tally([row(90, goals=1 + index % 3)] + [row(90, goals="")] * 9, "goals")
                 for index in range(20)]
        self.assertEqual(reliability.prior("goals", lucky)["weight"], reliability.PRIOR_MAX_MINUTES)
        self.assertIsNone(reliability.prior("goals", lucky[:9]))


class ReportTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        self.spider, self.source = root / "spider", root / "sportmonks"
        for name, value in (("SPIDER_ROOT", self.spider), ("SOURCE_ROOT", self.source), ("TARGET_MINUTES", 90)):
            patcher = mock.patch.object(reliability, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def season(self, name, state="FT"):
        write_csv(self.source / name / "fixtures.csv", [
            {"fixture_id": str(round_), "season_id": "1", "league_id": "600", "state": state, "round.name": str(round_)}
            for round_ in range(1, 5)])
        records = []
        for index in range(5):
            for round_ in range(1, 5):
                # Scoring two goals more each round in the second half: the
                # early order still predicts the later one exactly.
                goals = index + (2 if round_ > 2 else 0)
                records.append({"entity_type": "player", "fixture_id": str(round_), "player_id": f"p{index}",
                                "team_id": "1", "name": f"P{index}", "position": "Attacker", "started": "1",
                                "minutes_played": "90", "rating": "7", "p_touches": "40", "p_goals": str(goals or "")})
        write_csv(self.spider / name / "spider_stats.csv", records)

    def test_early_window_predicts_rest_of_season(self):
        self.season("2024-2025")
        report = reliability.build((2,))
        goals = next(item for item in report if item["position"] == "FW" and item["metric"] == "goals")
        self.assertEqual(goals["players"], 5)
        self.assertEqual(goals["seasons"], "2024-2025")
        self.assertEqual(goals["spearman_observed"], "1")
        self.assertEqual(goals["reading"], "strong")
        # A column the season never wrote has no players rather than zeros.
        shots = next(item for item in report if item["position"] == "FW" and item["metric"] == "shots")
        self.assertEqual(shots["players"], 0)

    def test_incomplete_seasons_are_not_used(self):
        self.season("2024-2025")
        self.season("2026-2027", state="NS")
        self.assertEqual(reliability.completed_seasons(), ["2024-2025"])


if __name__ == "__main__":
    unittest.main()
