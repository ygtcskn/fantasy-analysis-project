"""Sweep regression tests on a synthetic pool; reads no saved data."""
import csv
import importlib.util
import io
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src" / "xi_optimizer"))
_spec = importlib.util.spec_from_file_location(
    "xi_optimizer_sweep", ROOT / "src/xi_optimizer/sweep.py")
sweep_module = importlib.util.module_from_spec(_spec)
sys.modules["xi_optimizer_sweep"] = sweep_module
_spec.loader.exec_module(sweep_module)
Player = sweep_module.optimize.__globals__["Player"]


def pool(cheap_bench=True):
    """One clearly best XI, plus alternatives of descending quality."""
    players = []
    price = 5_000_000
    for index in range(4):
        players.append(Player(f"1{index}", f"Keeper {index}", str(index % 6 + 1),
                              f"Club {index % 6 + 1}", "KL", price, 4.5 - index * 0.3))
    for index in range(10):
        players.append(Player(f"2{index}", f"Back {index}", str(index % 6 + 1),
                              f"Club {index % 6 + 1}", "DEF", price, 4.4 - index * 0.2))
    for index in range(10):
        players.append(Player(f"3{index}", f"Mid {index}", str(index % 6 + 1),
                              f"Club {index % 6 + 1}", "OS", price, 4.3 - index * 0.2))
    for index in range(8):
        players.append(Player(f"4{index}", f"Fwd {index}", str(index % 6 + 1),
                              f"Club {index % 6 + 1}", "FOR", price, 4.6 - index * 0.25))
    return players


class SweepTests(unittest.TestCase):
    def test_every_player_is_scored_exactly_once(self):
        players = pool()
        baseline, rows = sweep_module.sweep(
            players, formation="4-3-3", risk="balanced",
            budget=100_000_000, time_limit=30, progress=lambda message: None)
        self.assertEqual(len(rows), len(players))
        self.assertEqual(len({row["player_id"] for row in rows}), len(players))

    def test_splitting_by_position_matches_one_call_over_the_pool(self):
        # The sweep runs four position calls for progress reporting; that must
        # not change any number compared with a single sweep of the pool.
        players = pool()
        _, rows = sweep_module.sweep(
            players, formation="4-3-3", risk="balanced",
            budget=100_000_000, time_limit=30, progress=lambda message: None)
        whole = sweep_module.recommend(players, formation="4-3-3", budget=100_000_000,
                                       time_limit=30, risk="balanced")
        mine = {row["player_id"]: row["completed_xi_expected_points"] for row in rows}
        theirs = {row["player_id"]: row["completed_xi_expected_points"] for row in whole}
        self.assertEqual(mine.keys(), theirs.keys())
        for player_id, value in theirs.items():
            self.assertAlmostEqual(mine[player_id], value, places=9)

    def test_optimal_xi_members_cost_nothing_and_are_flagged(self):
        players = pool()
        baseline, rows = sweep_module.sweep(
            players, formation="4-3-3", risk="balanced",
            budget=100_000_000, time_limit=30, progress=lambda message: None)
        chosen = {player.id for player in baseline.players}
        for row in rows:
            self.assertEqual(row["in_optimal_xi"], row["player_id"] in chosen)
            if row["in_optimal_xi"]:
                self.assertAlmostEqual(row["points_below_optimal_xi"], 0.0, places=9)

    def test_rows_are_ordered_by_the_team_each_player_completes(self):
        _, rows = sweep_module.sweep(
            pool(), formation="4-3-3", risk="balanced",
            budget=100_000_000, time_limit=30, progress=lambda message: None)
        values = [row["completed_xi_expected_points"] for row in rows]
        self.assertEqual(values, sorted(values, reverse=True))

    def test_opportunity_cost_is_never_negative(self):
        # No forced completion can beat the unconstrained optimum.
        baseline, rows = sweep_module.sweep(
            pool(), formation="4-3-3", risk="balanced",
            budget=100_000_000, time_limit=30, progress=lambda message: None)
        for row in rows:
            self.assertGreaterEqual(row["points_below_optimal_xi"], 0.0)
            self.assertLessEqual(row["completed_xi_expected_points"], baseline.points + 1e-9)

    def test_an_impossible_pool_is_an_error_not_an_empty_sweep(self):
        keepers_only = [p for p in pool() if p.position == "KL"]
        with self.assertRaises(ValueError):
            sweep_module.sweep(keepers_only, formation="4-3-3", risk="balanced",
                               budget=100_000_000, time_limit=30,
                               progress=lambda message: None)


class WriteTests(unittest.TestCase):
    def test_output_is_replaced_atomically_and_leaves_no_temporary(self):
        with tempfile.TemporaryDirectory() as name:
            target = Path(name) / "nested" / "sweep.csv"
            sweep_module.write_csv(target, [{"a": 1, "b": 2}], ["a", "b"])
            sweep_module.write_csv(target, [{"a": 3, "b": 4}], ["a", "b"])
            rows = list(csv.DictReader(io.StringIO(target.read_text(encoding="utf-8-sig"))))
            # The rewrite replaced the file and left no partial temporary behind.
            self.assertEqual(rows, [{"a": "3", "b": "4"}])
            self.assertEqual([p.name for p in target.parent.iterdir()], ["sweep.csv"])

    def test_columns_cover_every_field_the_sweep_produces(self):
        _, rows = sweep_module.sweep(
            pool(), formation="4-3-3", risk="balanced",
            budget=100_000_000, time_limit=30, progress=lambda message: None)
        produced = set(rows[0]) | {"season", "matchweek", "pipeline_run_id", "rank",
                                   "team_id", "optimal_xi_expected_points", "risk",
                                   "formation_setting", "generated_at_utc"}
        # Everything the CSV promises must be something the sweep can supply.
        missing = set(sweep_module.COLUMNS) - produced - {"completed_xi_formation"}
        self.assertEqual(missing, set())


if __name__ == "__main__":
    unittest.main()
