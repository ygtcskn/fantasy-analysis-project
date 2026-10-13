"""Adapter regression tests; no actual solver or input-data reads."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("xi_adapter_test", Path(__file__).resolve().parents[1] / "src/xi_optimizer/xi_recommendations.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class RecommendationAdapterTests(unittest.TestCase):
    def setUp(self):
        self.player = SimpleNamespace(id="1", name="One", team="10", team_name="Club",
                                      position="DEF", price=5_000_000, points=4, rating=7.0)
        self.next_player = SimpleNamespace(id="2", name="Two", team="20", team_name="Club 2",
                                           position="FOR", price=7_000_000, points=6, rating=7.4)
        solution = SimpleNamespace(players=[self.player, self.next_player], points=50,
                                   defensive_pairs=0, standard_deviation=11.4)
        self.model = SimpleNamespace(FORMATIONS={"4-3-3": None},
                                     RISK_PRESETS={"balanced": 0.0, "low": 0.75, "high": -0.75},
                                     optimize=Mock(return_value=solution))
        self.source = SimpleNamespace(load_pool=Mock(return_value=([self.player, self.next_player], [], "generation", "5")),
                                      FINAL=Path("unused"), read=Mock(return_value=[
                                          {"sportmonks_player_id": "2", "match_status": "matched", "so_percent": "43.6"},
                                          {"sportmonks_player_id": "1", "match_status": "unmatched", "so_percent": "12.0"},
                                      ]))
        self.query = {"locked": ["1"], "formation": ["4-3-3"], "generation": ["generation"],
                      "risk": ["balanced"]}

    def test_locks_and_budget_passed_and_locked_players_omitted(self):
        with patch.object(adapter, "modules", return_value=(self.model, self.source)):
            rows = adapter.recommendations("2026-2027", self.query)
        self.assertEqual([r["player_id"] for r in rows], ["2"])
        self.assertEqual(rows[0]["remaining_budget"], 95)
        self.assertEqual(self.model.optimize.call_args.kwargs["locked"], ["1"])
        self.assertEqual(self.model.optimize.call_args.kwargs["budget"], 100_000_000)

    def test_changed_generation_does_not_solve(self):
        self.query["generation"] = ["old"]
        with patch.object(adapter, "modules", return_value=(self.model, self.source)):
            rows = adapter.recommendations("2026-2027", self.query)
        self.assertEqual(rows[0]["status"], "unavailable")
        self.model.optimize.assert_not_called()

    def test_ineligible_locked_player_does_not_solve(self):
        self.query["locked"] = ["999"]
        with patch.object(adapter, "modules", return_value=(self.model, self.source)):
            rows = adapter.recommendations("2026-2027", self.query)
        self.assertEqual(rows[0]["status"], "unavailable")
        self.model.optimize.assert_not_called()

    def test_infeasible_and_missing_dependencies_are_explicit(self):
        self.model.optimize.return_value = None
        with patch.object(adapter, "modules", return_value=(self.model, self.source)):
            self.assertEqual(adapter.recommendations("2026-2027", self.query)[0]["status"], "unavailable")
        with patch.object(adapter, "modules", side_effect=ImportError):
            self.assertIn("dependencies", adapter.recommendations("2026-2027", self.query)[0]["message"])


if __name__ == "__main__":
    unittest.main()


class SubstituteTests(RecommendationAdapterTests):
    def setUp(self):
        super().setUp()
        self.source.FINAL = Path("unused")
        self.source.read = Mock(return_value=[{
            "sportmonks_player_id": "3", "sportmonks_team_id": "10",
            "match_status": "matched", "price_million_try": "6",
        }])
        self.source.money = lambda value: int(value) * 1_000_000

    def test_substitute_cost_and_club_reduce_starting_xi_capacity(self):
        # No eligible projection is needed for a manually selected substitute.
        with patch.object(adapter, "modules", return_value=(self.model, self.source)):
            rows = adapter.recommendations("2026-2027", dict(self.query, bench=["3"]))
        self.assertEqual(rows[0]["status"], "complete")
        self.assertEqual(rows[0]["remaining_budget"], 89)
        self.assertEqual(self.model.optimize.call_args.kwargs["budget"], 94_000_000)
        self.assertEqual(self.model.optimize.call_args.kwargs["reserved_clubs"], {"10": 1})
        self.assertEqual(self.model.optimize.call_args.kwargs["locked"], ["1"])

    def test_substitute_is_removed_from_starter_candidates(self):
        self.source.load_pool.return_value[0].append(SimpleNamespace(id="3"))
        with patch.object(adapter, "modules", return_value=(self.model, self.source)):
            adapter.recommendations("2026-2027", dict(self.query, bench=["3"]))
        self.assertNotIn("3", [p.id for p in self.model.optimize.call_args.args[0]])

    def test_invalid_bench_cannot_reach_solver(self):
        for bench in ("1", "3,3", "3,4,5,6,7", "unknown", "999"):
            with self.subTest(bench=bench), patch.object(adapter, "modules", return_value=(self.model, self.source)):
                rows = adapter.recommendations("2026-2027", dict(self.query, bench=[bench]))
                self.assertEqual(rows[0]["status"], "unavailable")
                self.model.optimize.assert_not_called()


class RiskSettingTests(RecommendationAdapterTests):
    def test_named_presets_reach_the_solver(self):
        for risk in ("balanced", "low", "high"):
            with patch.object(adapter, "modules", return_value=(self.model, self.source)):
                rows = adapter.recommendations("2026-2027", dict(self.query, risk=[risk]))
            self.assertEqual(rows[0]["status"], "complete")
            self.assertEqual(rows[0]["risk"], risk)
            self.assertEqual(self.model.optimize.call_args.kwargs["risk"], risk)

    def test_an_arbitrary_weight_from_the_browser_is_refused(self):
        # A query string must not be able to set a numeric risk weight.
        for risk in ("-99", "medium", "0.5"):
            with patch.object(adapter, "modules", return_value=(self.model, self.source)):
                rows = adapter.recommendations("2026-2027", dict(self.query, risk=[risk]))
            self.assertEqual(rows[0]["status"], "unavailable")
            self.assertIn("risk", rows[0]["message"].lower())

    def test_missing_risk_defaults_to_balanced(self):
        query = {key: value for key, value in self.query.items() if key != "risk"}
        with patch.object(adapter, "modules", return_value=(self.model, self.source)):
            rows = adapter.recommendations("2026-2027", query)
        self.assertEqual(rows[0]["risk"], "balanced")

    def test_spread_is_reported_alongside_expected_points(self):
        with patch.object(adapter, "modules", return_value=(self.model, self.source)):
            rows = adapter.recommendations("2026-2027", self.query)
        self.assertEqual(rows[0]["xi_expected_points"], 50)
        self.assertEqual(rows[0]["xi_standard_deviation"], 11.4)
        self.assertEqual(rows[0]["same_club_defensive_pairs"], 0)


class PositionRankingTests(RecommendationAdapterTests):
    def test_a_position_switches_to_ranked_candidates(self):
        ranked = [{"player_id": "2", "player_name": "Two", "team_name": "Club 2",
                   "position": "FOR", "expected_points": 6, "price_million_try": 7.0,
                   "rating": 7.4, "completed_xi_expected_points": 50,
                   "points_below_optimal_xi": 0.0}]
        self.model.recommend = Mock(return_value=ranked)
        self.model.POSITIONS = ("KL", "DEF", "OS", "FOR")
        with patch.object(adapter, "modules", return_value=(self.model, self.source)):
            rows = adapter.recommendations("2026-2027", dict(self.query, position=["FOR"]))
        self.assertEqual(rows[0]["player_id"], "2")
        self.assertEqual(rows[0]["points_below_optimal_xi"], 0.0)
        self.assertIn("FOR", rows[0]["message"])
        # The whole pool must reach the solver; only the shortlist is narrowed.
        call = self.model.recommend.call_args
        self.assertEqual(call.args[0], [self.player, self.next_player])
        self.assertEqual(call.kwargs["position"], "FOR")
        self.assertIn("candidates", call.kwargs)

    def test_an_unsupported_position_is_refused(self):
        self.model.POSITIONS = ("KL", "DEF", "OS", "FOR")
        with patch.object(adapter, "modules", return_value=(self.model, self.source)):
            rows = adapter.recommendations("2026-2027", dict(self.query, position=["GK"]))
        self.assertEqual(rows[0]["status"], "unavailable")
        self.assertIn("position", rows[0]["message"].lower())

    def test_no_position_keeps_the_optimal_xi_view(self):
        self.model.recommend = Mock()
        with patch.object(adapter, "modules", return_value=(self.model, self.source)):
            rows = adapter.recommendations("2026-2027", self.query)
        self.model.recommend.assert_not_called()
        self.assertEqual([r["player_id"] for r in rows], ["2"])


class RatingPassthroughTests(RecommendationAdapterTests):
    def test_rating_reaches_the_reader_in_the_optimal_xi_view(self):
        with patch.object(adapter, "modules", return_value=(self.model, self.source)):
            rows = adapter.recommendations("2026-2027", self.query)
        self.assertEqual(rows[0]["rating"], 7.4)

    def test_rating_reaches_the_reader_in_the_ranked_view(self):
        ranked = [{"player_id": "2", "player_name": "Two", "team_name": "Club 2",
                   "position": "FOR", "expected_points": 6, "price_million_try": 7.0,
                   "rating": 7.4, "completed_xi_expected_points": 50,
                   "points_below_optimal_xi": 0.0}]
        self.model.recommend = Mock(return_value=ranked)
        self.model.POSITIONS = ("KL", "DEF", "OS", "FOR")
        with patch.object(adapter, "modules", return_value=(self.model, self.source)):
            rows = adapter.recommendations("2026-2027", dict(self.query, position=["FOR"]))
        self.assertEqual(rows[0]["rating"], 7.4)


class OwnershipPassthroughTests(RecommendationAdapterTests):
    def test_so_percent_reaches_the_reader_in_both_views(self):
        with patch.object(adapter, "modules", return_value=(self.model, self.source)):
            rows = adapter.recommendations("2026-2027", self.query)
        self.assertEqual(rows[0]["so_percent"], "43.6")
        self.model.recommend = Mock(return_value=[{
            "player_id": "2", "player_name": "Two", "position": "FOR", "expected_points": 6,
            "price_million_try": 7.0, "rating": 7.4, "completed_xi_expected_points": 50,
            "points_below_optimal_xi": 0.0}])
        self.model.POSITIONS = ("KL", "DEF", "OS", "FOR")
        with patch.object(adapter, "modules", return_value=(self.model, self.source)):
            rows = adapter.recommendations("2026-2027", dict(self.query, position=["FOR"]))
        self.assertEqual(rows[0]["so_percent"], "43.6")

    def test_unmatched_tff_rows_never_supply_so_percent(self):
        self.player.id, self.next_player.id = "2", "1"
        self.query["locked"] = ["2"]
        with patch.object(adapter, "modules", return_value=(self.model, self.source)):
            rows = adapter.recommendations("2026-2027", self.query)
        self.assertEqual(rows[0]["player_id"], "1")
        self.assertEqual(rows[0]["so_percent"], "")
