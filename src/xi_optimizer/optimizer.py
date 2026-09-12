"""Binary optimization of an eleven-player fantasy team.

Choose players to maximize the sum of projected points subject to the squad
rules. This is a mixed-integer program rather than a greedy pick because the
constraints interact: the best player per million is often unaffordable once the
budget has to cover ten more places, and the three-per-club cap can make the
highest-scoring pair of teammates worse than a cheaper split. Greedy selection
gets both wrong; a solver does not.

Only a proven optimum is returned. A solve that hits its time limit raises
rather than publishing a possibly-suboptimal team as the recommendation, and
every solution is re-checked against the constraints independently of the
solver before it is accepted.

The constraint matrix does not depend on the formation - only the position row
bounds do - so it is built once per player pool and reused across every
formation and, in ``recommend``, across every candidate. That matters because a
full recommendation solves one program per eligible player per formation.

Risk is a separate dial from points. Expected value is linear, so how correlated
the chosen players are cannot change the expected total at all - it changes the
spread around it. Measured over 35,849 player-matches of 60+ minutes, two
players from the same club in the same match have a points covariance of 7.49
when both are a goalkeeper or defender, against 0.80 when both play further
forward. A clean sheet is one team-level event paid to the whole defensive block
at once, and that is where a squad quietly concentrates its risk: three
defenders from one club score the same 10.23 points on average as three from
different clubs, with a standard deviation of 8.92 instead of 5.83.

``risk_weight`` prices that. It is charged per same-club defensive pair, in
expected points, so a positive weight spreads the defence and a negative one
deliberately stacks it. Neither is more correct: spreading protects a weekly
score, stacking buys the variance needed to catch someone in a league. Zero
reproduces the pure expected-points optimum.
"""
from collections import Counter
from dataclasses import dataclass
import math

import numpy as np
from scipy.optimize import Bounds, LinearConstraint, milp

FORMATIONS = {
    "4-4-2": (1, 4, 4, 2), "4-3-3": (1, 4, 3, 3),
    "4-2-3-1": (1, 4, 5, 1), "3-4-3": (1, 3, 4, 3),
    "3-5-2": (1, 3, 5, 2), "5-3-2": (1, 5, 3, 2),
    "5-4-1": (1, 5, 4, 1),
}
POSITIONS = ("KL", "DEF", "OS", "FOR")
DEFENSIVE = ("KL", "DEF")
SQUAD_SIZE = 11
CLUB_LIMIT = 3
# Measured on the points ledger, 60+ minute appearances. Used to report a
# squad's spread; they are historical dispersion, not forecast uncertainty.
POSITION_VARIANCE = {"KL": 10.77, "DEF": 11.39, "OS": 9.33, "FOR": 12.79}
DEFENSIVE_PAIR_COVARIANCE = 7.49
ATTACKING_PAIR_COVARIANCE = 0.80
MIXED_PAIR_COVARIANCE = 1.16
# Expected points charged per same-club defensive pair. The presets are round
# numbers, not calibrated optima: 0.75 is roughly a twentieth of the variance a
# pair adds, enough to break a tie without overruling a real points advantage.
RISK_PRESETS = {"low": 0.75, "balanced": 0.0, "high": -0.75}
# scipy.optimize.milp status codes.
OPTIMAL, LIMIT_REACHED, INFEASIBLE = 0, 1, 2


@dataclass(frozen=True)
class Player:
    id: str
    name: str
    team: str
    team_name: str
    position: str
    price: int  # Whole Turkish lira, avoiding rounded million-TL budget checks.
    points: float
    # Decayed Sportmonks match rating. It orders candidates and is shown to the
    # reader; it never enters the objective. Measured over 21,766 appearances it
    # predicts next-match points at r=+0.109 against +0.134 for prior points,
    # and is 60% redundant with them, so letting it outrank the projection would
    # trade a better signal for a worse one.
    rating: float = 0.0


@dataclass
class Solution:
    formation: str
    players: list[Player]

    @property
    def points(self):
        return sum(player.points for player in self.players)

    @property
    def cost(self):
        return sum(player.price for player in self.players)

    @property
    def defensive_pairs(self):
        """Same-club goalkeeper/defender pairs: the squad's shared-event risk."""
        blocks = Counter(p.team for p in self.players if p.position in DEFENSIVE)
        return sum(count * (count - 1) // 2 for count in blocks.values())

    @property
    def variance(self):
        """Spread of the squad's score, from measured per-position dispersion.

        Exact for this XI rather than the linear approximation the solver
        optimizes: every same-club pair is counted at its own covariance.
        """
        total = sum(POSITION_VARIANCE.get(p.position, 0.0) for p in self.players)
        for left in range(len(self.players)):
            for right in range(left + 1, len(self.players)):
                one, two = self.players[left], self.players[right]
                if one.team != two.team:
                    continue
                back = (one.position in DEFENSIVE, two.position in DEFENSIVE)
                covariance = (DEFENSIVE_PAIR_COVARIANCE if all(back)
                              else ATTACKING_PAIR_COVARIANCE if not any(back)
                              else MIXED_PAIR_COVARIANCE)
                total += 2 * covariance
        return total

    @property
    def standard_deviation(self):
        return math.sqrt(max(0.0, self.variance))


class _Problem:
    """The parts of the program that every solve for one pool shares.

    Rows are squad size, cost, one per position, then one per club. Only the
    four position rows change between formations, and they change bounds, not
    coefficients, so the matrix itself is built exactly once.

    A non-zero ``risk_weight`` appends two indicator variables per club, "at
    least two" and "all three" of that club's defenders selected. Their sum
    weighted 1 and 2 is exactly the number of same-club defensive pairs, because
    the club cap is three: two selected is one pair, three is three pairs. That
    keeps a quadratic risk term inside a linear program, and the indicators are
    bounded from both sides so the count is right whether the weight rewards
    stacking or punishes it.
    """

    __slots__ = ("players", "matrix", "lower", "upper", "objective", "budget",
                 "first_position", "width")

    def __init__(self, players, budget, risk_weight=0.0):
        count = len(players)
        clubs = sorted({player.team for player in players})
        self.players = players
        self.budget = budget
        self.first_position = 2
        extra = 2 * len(clubs) if risk_weight else 0
        self.width = count + extra

        def row(values):
            padded = np.zeros(self.width)
            padded[:count] = values
            return padded

        rows = [row(np.ones(count)),
                row([player.price / 1_000_000 for player in players])]
        lower = [float(SQUAD_SIZE), -np.inf]
        upper = [float(SQUAD_SIZE), budget / 1_000_000]
        for position in POSITIONS:
            rows.append(row([player.position == position for player in players]))
            lower.append(0.0)   # Replaced per formation.
            upper.append(0.0)
        for club in clubs:
            rows.append(row([player.team == club for player in players]))
            lower.append(0.0)
            upper.append(float(CLUB_LIMIT))
        objective = np.zeros(self.width)
        objective[:count] = [-player.points for player in players]
        for index, club in enumerate(clubs):
            if not risk_weight:
                break
            pair, triple = count + 2 * index, count + 2 * index + 1
            block = [player.team == club and player.position in DEFENSIVE for player in players]
            for indicator, threshold, scale in ((pair, 1, 2.0), (triple, 2, 3.0)):
                # indicator <= block / scale, so it cannot switch on too early.
                ceiling = row([-value for value in block])
                ceiling[indicator] = scale
                rows.append(ceiling)
                lower.append(-np.inf)
                upper.append(0.0)
                # indicator >= (block - threshold) / 3, so it cannot stay off.
                floor = row([-value for value in block])
                floor[indicator] = 3.0
                rows.append(floor)
                lower.append(float(-threshold))
                upper.append(np.inf)
            objective[pair] = risk_weight
            objective[triple] = 2 * risk_weight
        self.matrix = np.vstack(rows)
        self.lower = np.array(lower)
        self.upper = np.array(upper)
        self.objective = objective

    def solve(self, formation, counts, locked, excluded, time_limit):
        lower, upper = self.lower.copy(), self.upper.copy()
        for offset, count in enumerate(counts):
            lower[self.first_position + offset] = float(count)
            upper[self.first_position + offset] = float(count)
        players = len(self.players)
        floor = [1.0 if player.id in locked else 0.0 for player in self.players]
        ceiling = [0.0 if player.id in excluded else 1.0 for player in self.players]
        pad = self.width - players
        bounds = Bounds(floor + [0.0] * pad, ceiling + [1.0] * pad)
        result = milp(c=self.objective, integrality=np.ones(self.width), bounds=bounds,
                      constraints=LinearConstraint(self.matrix, lower, upper),
                      options={"time_limit": time_limit, "mip_rel_gap": 0.0})
        if result.status == INFEASIBLE:
            return None
        if result.status != OPTIMAL or result.x is None:
            raise RuntimeError(f"{formation}: optimality not proven: {result.message}")
        selected = [player for player, value in zip(self.players, result.x) if value > .5]
        solution = Solution(formation, selected)
        if (len(selected) != SQUAD_SIZE or solution.cost > self.budget
                or Counter(p.position for p in selected) != Counter(dict(zip(POSITIONS, counts)))
                or max(Counter(p.team for p in selected).values()) > CLUB_LIMIT
                or not set(locked) <= {p.id for p in selected}
                or set(excluded) & {p.id for p in selected}):
            raise RuntimeError("Solver result failed independent constraint validation.")
        return solution


def resolve_risk(risk):
    """A named preset or an explicit expected-points charge per defensive pair."""
    if risk is None or risk == "":
        return 0.0
    if isinstance(risk, str):
        if risk not in RISK_PRESETS:
            raise ValueError(f"Unknown risk setting: {risk}. Use {', '.join(RISK_PRESETS)}.")
        return RISK_PRESETS[risk]
    weight = float(risk)
    if not math.isfinite(weight):
        raise ValueError("Risk weight must be finite.")
    return weight


def _validate(players, budget, locked, excluded, formation, time_limit):
    ids = [player.id for player in players]
    if len(ids) != len(set(ids)):
        raise ValueError("Duplicate Sportmonks player ID.")
    if locked & excluded:
        raise ValueError("A player cannot be both locked and excluded.")
    if (locked | excluded) - set(ids):
        raise ValueError("Locked/excluded IDs must belong to the eligible player pool.")
    if budget <= 0 or time_limit <= 0:
        raise ValueError("Budget and solver time limit must be positive.")
    if any(not p.id.isdigit() or not p.team.isdigit() or p.position not in POSITIONS
           or p.price <= 0 or not math.isfinite(p.points) for p in players):
        raise ValueError("Invalid player identity, position, price or projection.")
    if formation != "auto" and formation not in FORMATIONS:
        raise ValueError("Unsupported formation.")


def _score(solution, risk_weight):
    """What the solver actually maximizes: points less the risk charge."""
    return solution.points - risk_weight * solution.defensive_pairs


def _best(problem, choices, locked, excluded, time_limit, risk_weight=0.0):
    best = None
    for name, counts in choices.items():
        solution = problem.solve(name, counts, locked, excluded, time_limit)
        if solution is None:
            continue
        if best is None or _score(solution, risk_weight) > _score(best, risk_weight) + 1e-8:
            best = solution
    return best


def optimize(players, budget=100_000_000, locked=(), excluded=(), formation="auto",
             time_limit=30, risk="balanced"):
    """Return a proven optimum or None for infeasibility; never publish a timeout as optimal.

    ``risk`` is a preset name or an explicit charge per same-club defensive
    pair. It changes which optimum is chosen, never the reported points: a
    returned solution's ``points`` is always its true expected total.
    """
    players = list(players)
    locked, excluded = set(locked), set(excluded)
    risk_weight = resolve_risk(risk)
    _validate(players, budget, locked, excluded, formation, time_limit)
    if len(players) < SQUAD_SIZE:
        return None
    choices = FORMATIONS if formation == "auto" else {formation: FORMATIONS[formation]}
    problem = _Problem(players, budget, risk_weight)
    return _best(problem, choices, locked, excluded, time_limit, risk_weight)


def recommend(players, *, locked=(), excluded=(), position=None, candidates=None,
              budget=100_000_000, formation="auto", time_limit=30, risk="balanced",
              rating_weight=0.0):
    """Rank next picks by the optimal completed XI when each candidate is locked.

    Ranking on the completed XI rather than the candidate's own projection is
    the point: a high-scoring player who forces eleven cheap teammates can be
    worth less than a slightly weaker one who leaves the budget intact.

    Players already in the unconstrained optimum are scored without a solve.
    Locking a player who is already selected cannot change the optimum - that
    same team stays feasible and no better team exists - so the answer is the
    baseline by construction.

    ``candidates`` limits which players are evaluated without shrinking the pool
    the completions are built from. Every solve still chooses freely from the
    whole squad; only the list of players offered a turn is narrowed. Passing a
    reduced pool instead would be wrong, because a team cannot be completed from
    one position.

    ``rating_weight`` lets the provider's match rating influence the order
    candidates are presented in. It changes no team: the XI each candidate
    completes is solved from expected points alone, and the reported figures are
    unaffected. At zero, rating only separates candidates that are otherwise
    exactly equal, which is strictly better than the arbitrary tie-break by ID
    it replaces.
    """
    players = list(players)
    locked, excluded = set(locked), set(excluded)
    risk_weight = resolve_risk(risk)
    _validate(players, budget, locked, excluded, formation, time_limit)
    if len(players) < SQUAD_SIZE:
        return []
    choices = FORMATIONS if formation == "auto" else {formation: FORMATIONS[formation]}
    problem = _Problem(players, budget, risk_weight)
    baseline = _best(problem, choices, locked, excluded, time_limit, risk_weight)
    if baseline is None:
        return []
    already = {player.id for player in baseline.players}
    considered = None if candidates is None else set(candidates)
    rows = []
    for player in players:
        if player.id in locked | excluded or (position and player.position != position):
            continue
        if considered is not None and player.id not in considered:
            continue
        if player.id in already:
            completion = baseline
        else:
            completion = _best(problem, choices, locked | {player.id}, excluded,
                               time_limit, risk_weight)
            if completion is None:
                continue
        rows.append({"player_id": player.id, "player_name": player.name,
                     "team_name": player.team_name, "position": player.position,
                     "expected_points": player.points, "rating": player.rating,
                     "price_million_try": player.price / 1_000_000,
                     "completed_xi_expected_points": completion.points,
                     "points_below_optimal_xi": max(0, baseline.points - completion.points),
                     "completed_xi_cost_million_try": completion.cost / 1_000_000,
                     "formation": completion.formation})
    return sorted(rows, key=lambda r: (
        -(r["completed_xi_expected_points"] + rating_weight * r["rating"]),
        -r["expected_points"], -r["rating"], r["player_id"]))
