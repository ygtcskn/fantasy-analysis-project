"""Regression tests for squad constraints, recommendations, and risk."""
from collections import Counter
from dataclasses import replace
import unittest

from src.xi_optimizer import optimizer as _model
from src.xi_optimizer.optimizer import Player, optimize, recommend


def pool():
    positions = ["KL"] * 2 + ["DEF"] * 8 + ["OS"] * 8 + ["FOR"] * 4
    return [Player(str(i + 1), f"Player {i + 1}", str(i % 6 + 1), f"Club {i % 6 + 1}",
                   position, 8_000_000, 3 + i / 10) for i, position in enumerate(positions)]


class OptimizerTests(unittest.TestCase):
    def test_budget_club_limit_formation_and_locks(self):
        players = pool()
        players[2] = replace(players[2], price=60_000_000, points=100)
        result = optimize(players, formation="4-3-3", locked={"1"}, excluded={"22"})
        self.assertIsNotNone(result)
        self.assertEqual(len(result.players), 11)
        self.assertLessEqual(result.cost, 100_000_000)
        self.assertEqual(Counter(p.position for p in result.players), {"KL": 1, "DEF": 4, "OS": 3, "FOR": 3})
        self.assertLessEqual(max(Counter(p.team for p in result.players).values()), 3)
        self.assertIn("1", {p.id for p in result.players})
        self.assertNotIn("22", {p.id for p in result.players})
        self.assertNotIn("3", {p.id for p in result.players})  # Greedy highest points cannot fit the budget.

    def test_infeasible_locked_players(self):
        self.assertIsNone(optimize(pool(), locked={"1", "2"}))  # Two goalkeepers cannot start.
        self.assertIsNone(optimize(pool(), budget=80_000_000))
        self.assertIsNone(optimize(pool(), locked={"1", "7", "13", "19"}))  # Four from club 1.

    def test_duplicate_and_unavailable_identity_rejected(self):
        with self.assertRaises(ValueError):
            optimize(pool() + [pool()[0]])
        with self.assertRaises(ValueError):
            optimize(pool(), locked={"999"})

    def test_substitute_club_reservations_apply_to_solutions_and_recommendations(self):
        players = pool()
        reserved = {"1": 2}
        result = optimize(players, formation="4-3-3", reserved_clubs=reserved)
        self.assertIsNotNone(result)
        self.assertLessEqual(sum(p.team == "1" for p in result.players), 1)
        self.assertIsNone(optimize(players, formation="4-3-3", locked={"1", "7"}, reserved_clubs=reserved))
        rows = recommend(players, formation="4-3-3", locked={"1"}, reserved_clubs=reserved)
        self.assertTrue(rows)
        by_id = {p.id: p for p in players}
        self.assertTrue(all(by_id[row["player_id"]].team != "1" for row in rows))

    def test_recommendations_use_completed_xi(self):
        players = pool()
        best = optimize(players, formation="4-3-3", locked={"1"})
        rows = recommend(players, formation="4-3-3", locked={"1"}, position="FOR")
        self.assertTrue(rows)
        self.assertAlmostEqual(rows[0]["completed_xi_expected_points"], best.points)
        for row in rows:
            forced = optimize(players, formation="4-3-3", locked={"1", row["player_id"]})
            self.assertAlmostEqual(row["completed_xi_expected_points"], forced.points)


if __name__ == "__main__":
    unittest.main()


def risk_pool():
    """Two clubs field strong defenders; spreading costs a little in points."""
    players = []
    # Club 1 and club 2 each have three good, cheap defenders.
    for club in ("1", "2"):
        for index in range(3):
            players.append(Player(f"{club}0{index}", f"Back {club}{index}", club, f"Club {club}",
                                  "DEF", 5_000_000, 5.0))
    # Other clubs' defenders are marginally worse, so stacking is the points optimum.
    for index, club in enumerate(("3", "4", "5", "6"), start=1):
        players.append(Player(f"9{index}", f"Spare {index}", club, f"Club {club}",
                              "DEF", 5_000_000, 4.6))
    for index in range(2):
        players.append(Player(f"7{index}", f"Keeper {index}", str(index + 3), f"Club {index + 3}",
                              "KL", 4_000_000, 4.0))
    for index in range(6):
        players.append(Player(f"8{index}", f"Mid {index}", str(index % 4 + 3), f"Club {index % 4 + 3}",
                              "OS", 5_000_000, 4.0))
    for index in range(4):
        players.append(Player(f"6{index}", f"Fwd {index}", str(index % 4 + 3), f"Club {index % 4 + 3}",
                              "FOR", 5_000_000, 4.0))
    return players


class RiskTests(unittest.TestCase):
    def test_presets_resolve_and_reject_unknown_names(self):
        self.assertEqual(_model.resolve_risk("balanced"), 0.0)
        self.assertGreater(_model.resolve_risk("low"), 0)
        self.assertLess(_model.resolve_risk("high"), 0)
        self.assertEqual(_model.resolve_risk(1.25), 1.25)
        self.assertEqual(_model.resolve_risk(None), 0.0)
        with self.assertRaises(ValueError):
            _model.resolve_risk("medium")

    def test_low_risk_spreads_the_defence_and_high_risk_stacks_it(self):
        pool = risk_pool()
        low = optimize(pool, formation="5-3-2", risk=6.0)
        high = optimize(pool, formation="5-3-2", risk=-6.0)
        self.assertIsNotNone(low)
        self.assertIsNotNone(high)
        self.assertLess(low.defensive_pairs, high.defensive_pairs)
        # Spreading costs points; that is the trade being made, not a bug.
        self.assertLessEqual(low.points, high.points + 1e-9)
        self.assertLess(low.standard_deviation, high.standard_deviation)

    def test_reported_points_are_always_the_true_total(self):
        # The risk charge steers the choice; it must never enter the total.
        pool = risk_pool()
        chosen = optimize(pool, formation="5-3-2", risk=-6.0)
        self.assertAlmostEqual(chosen.points, sum(p.points for p in chosen.players))

    def test_pair_count_matches_the_linearisation(self):
        # Club cap 3: two selected is one pair, three is three pairs.
        pool = risk_pool()
        for weight in (6.0, 0.0, -6.0):
            chosen = optimize(pool, formation="5-3-2", risk=weight)
            blocks = Counter(p.team for p in chosen.players if p.position in _model.DEFENSIVE)
            expected = sum(n * (n - 1) // 2 for n in blocks.values())
            self.assertEqual(chosen.defensive_pairs, expected)
            self.assertLessEqual(max(blocks.values()), 3)

    def test_risk_setting_never_breaks_the_squad_rules(self):
        pool = risk_pool()
        chosen = optimize(pool, formation="5-3-2", risk=-6.0)
        self.assertEqual(len(chosen.players), 11)
        self.assertLessEqual(chosen.cost, 100_000_000)
        self.assertLessEqual(max(Counter(p.team for p in chosen.players).values()), 3)


class CandidateShortlistTests(unittest.TestCase):
    def test_candidates_limit_who_is_evaluated_not_who_can_be_selected(self):
        players = pool()
        forwards = [p.id for p in players if p.position == "FOR"]
        rows = recommend(players, position="FOR", formation="4-3-3",
                         candidates=forwards[:2])
        self.assertEqual({row["player_id"] for row in rows}, set(forwards[:2]))
        # Completions still draw on the whole squad, so each one is a legal XI.
        for row in rows:
            self.assertGreater(row["completed_xi_expected_points"], 0)

    def test_no_shortlist_still_evaluates_every_candidate(self):
        players = pool()
        forwards = {p.id for p in players if p.position == "FOR"}
        rows = recommend(players, position="FOR", formation="4-3-3")
        self.assertEqual({row["player_id"] for row in rows}, forwards)

    def test_an_empty_shortlist_returns_nothing_rather_than_everything(self):
        rows = recommend(pool(), position="FOR", formation="4-3-3", candidates=[])
        self.assertEqual(rows, [])


class RatingTests(unittest.TestCase):
    def rated_pool(self, ratings):
        """Two forwards identical in every way the objective can see."""
        players = [Player("70", "Keeper", "1", "Club 1", "KL", 5_000_000, 4.0)]
        for index in range(4):
            players.append(Player(f"2{index}", f"Back {index}", str(index + 2),
                                  f"Club {index + 2}", "DEF", 5_000_000, 4.0))
        for index in range(3):
            players.append(Player(f"3{index}", f"Mid {index}", str(index + 2),
                                  f"Club {index + 2}", "OS", 5_000_000, 4.0))
        for index, rating in enumerate(ratings):
            players.append(Player(f"4{index}", f"Fwd {index}", str(index % 4 + 2),
                                  f"Club {index % 4 + 2}", "FOR", 5_000_000, 4.0, rating))
        return players

    def test_rating_separates_otherwise_identical_candidates(self):
        # Same points, same price, same completed XI: rating decides the order
        # instead of the arbitrary player ID that decided it before.
        rows = recommend(self.rated_pool([6.0, 8.0, 7.0, 5.0]),
                         position="FOR", formation="4-3-3")
        best = [row["player_id"] for row in rows]
        self.assertEqual(best[0], "41")   # rating 8.0
        self.assertEqual(best[-1], "43")  # rating 5.0

    def test_rating_never_outranks_expected_points_by_default(self):
        players = self.rated_pool([5.0, 5.0, 5.0, 5.0])
        # Give one forward a worse rating but a better projection.
        players = [p if p.id != "40" else replace(p, points=6.0, rating=1.0) for p in players]
        rows = recommend(players, position="FOR", formation="4-3-3")
        self.assertEqual(rows[0]["player_id"], "40")

    def test_rating_weight_reorders_without_changing_any_team(self):
        players = self.rated_pool([5.0, 5.0, 5.0, 5.0])
        players = [p if p.id != "40" else replace(p, points=4.2, rating=1.0) for p in players]
        players = [p if p.id != "41" else replace(p, rating=9.0) for p in players]
        plain = recommend(players, position="FOR", formation="4-3-3")
        weighted = recommend(players, position="FOR", formation="4-3-3", rating_weight=0.5)
        self.assertEqual(plain[0]["player_id"], "40")
        self.assertEqual(weighted[0]["player_id"], "41")
        # The completed XI values are solved from points alone, so they are the
        # same numbers in both orderings.
        self.assertEqual({r["player_id"]: round(r["completed_xi_expected_points"], 9) for r in plain},
                         {r["player_id"]: round(r["completed_xi_expected_points"], 9) for r in weighted})

    def test_rating_defaults_to_zero_and_changes_nothing(self):
        unrated = [replace(p, rating=0.0) for p in self.rated_pool([0, 0, 0, 0])]
        chosen = optimize(unrated, formation="4-3-3")
        self.assertIsNotNone(chosen)
        self.assertEqual(len(chosen.players), 11)
