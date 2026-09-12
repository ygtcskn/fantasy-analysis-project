"""Backtest scoring regression tests; no solver, no saved-data reads."""
import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
_spec = importlib.util.spec_from_file_location(
    "projection_backtest", ROOT / "src/player_projections/backtest.py")
backtest = importlib.util.module_from_spec(_spec)
sys.modules["projection_backtest"] = backtest
_spec.loader.exec_module(backtest)

UTC = timezone.utc


class SpearmanTests(unittest.TestCase):
    def test_perfect_and_reversed_agreement(self):
        rising = [(1, 10), (2, 20), (3, 30), (4, 40)]
        self.assertAlmostEqual(backtest.spearman(rising), 1.0)
        self.assertAlmostEqual(backtest.spearman([(a, -b) for a, b in rising]), -1.0)

    def test_tied_forecasts_share_a_rank(self):
        self.assertAlmostEqual(backtest.spearman([(1, 5), (1, 7), (2, 9), (2, 11)]), 0.8944, places=3)

    def test_a_constant_forecast_has_no_defined_correlation(self):
        # Zero spread would divide by zero. The score must be NaN rather than
        # 0.0, so a method predicting one number for everyone cannot read as
        # merely neutral when it is uninformative.
        value = backtest.spearman([(3, 1), (3, 2), (3, 4)])
        self.assertNotEqual(value, value)

    def test_too_few_points_is_not_a_number(self):
        value = backtest.spearman([(1, 2), (2, 3)])
        self.assertNotEqual(value, value)


class BaselineTests(unittest.TestCase):
    def setUp(self):
        self.as_of = datetime(2026, 9, 1, tzinfo=UTC)
        day = timedelta(days=7)
        self.history = {
            "1": [(self.as_of - 4 * day, 2.0), (self.as_of - 3 * day, 4.0),
                  (self.as_of - 2 * day, 6.0), (self.as_of - day, 8.0),
                  # Must be ignored: it had not happened at the cutoff.
                  (self.as_of + day, 100.0)],
            "2": [],
        }
        self.projected = [
            {"player_id": "1", "position": "OS", "price_million_try": "7.5"},
            {"player_id": "2", "position": "OS", "price_million_try": "4.0"},
        ]

    def test_future_matches_never_enter_a_baseline(self):
        values = backtest.baselines(self.projected, self.history, self.as_of)
        self.assertAlmostEqual(values["1"]["season_points_per_match"], 5.0)
        self.assertAlmostEqual(values["1"]["last_three_matches"], 6.0)

    def test_player_without_history_scores_zero_not_an_error(self):
        values = backtest.baselines(self.projected, self.history, self.as_of)
        self.assertEqual(values["2"]["season_points_per_match"], 0.0)
        self.assertEqual(values["2"]["last_three_matches"], 0.0)

    def test_position_average_pools_the_position_and_price_passes_through(self):
        values = backtest.baselines(self.projected, self.history, self.as_of)
        self.assertAlmostEqual(values["1"]["position_average"], 5.0)
        self.assertAlmostEqual(values["2"]["position_average"], 5.0)
        self.assertAlmostEqual(values["1"]["price"], 7.5)


class CompletedRoundTests(unittest.TestCase):
    def write(self, folder, rows):
        header = "fixture_id,league_id,round.name,state,kickoff\n"
        body = "".join(f"{r[0]},600,{r[1]},{r[2]},{r[3]}\n" for r in rows)
        (folder / "2026-2027").mkdir(parents=True, exist_ok=True)
        (folder / "2026-2027" / "fixtures.csv").write_text(header + body, encoding="utf-8")

    def test_only_fully_finished_rounds_are_scored(self):
        with tempfile.TemporaryDirectory() as name:
            folder = Path(name)
            self.write(folder, [
                ("1", "1", "FT", "2026-08-14 18:30:00"), ("2", "1", "FT", "2026-08-15 15:00:00"),
                ("3", "2", "FT", "2026-08-21 18:30:00"), ("4", "2", "NS", "2026-08-22 15:00:00"),
            ])
            rounds = backtest.completed_rounds("2026-2027", folder)
        self.assertEqual([item["matchweek"] for item in rounds], [1])

    def test_cutoff_sits_just_inside_the_deadline(self):
        with tempfile.TemporaryDirectory() as name:
            folder = Path(name)
            self.write(folder, [("1", "1", "FT", "2026-08-14 18:30:00"),
                                ("2", "1", "FT", "2026-08-15 15:00:00")])
            rounds = backtest.completed_rounds("2026-2027", folder)
        first = datetime(2026, 8, 14, 18, 30, tzinfo=UTC)
        # One second inside the hour, so the round's own first fixture still
        # counts as unstarted when the replay selects the round.
        self.assertEqual(rounds[0]["as_of"], first - timedelta(hours=1, seconds=1))
        self.assertLess(rounds[0]["as_of"], first - timedelta(hours=1))
        self.assertEqual(rounds[0]["fixture_ids"], {"1", "2"})


if __name__ == "__main__":
    unittest.main()
