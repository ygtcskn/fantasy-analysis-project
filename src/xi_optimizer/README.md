# XI optimizer

Chooses the eleven players that maximize projected points under the squad rules.
The website drives it through the read-only `xi_recommendations.py` in this folder
adapter; the command line below is for working on it directly. Generated CSVs go
to `data/temp/xi_optimizer/<timestamp>_<id>/`. Nothing is downloaded and nothing
in `data/final` is modified. Run commands from the analysis project root.

## Objective and rules

Maximize the sum of next-match expected points over binary player variables:

- Exactly 11 starters, one goalkeeper, no bench or captain multiplier.
- At most ₺100M by default, and at most three players from each club.
- Positions and prices checked against the matched TFF Fantasy CSV using
  Sportmonks IDs. No name matching or position inference.
- Auto formation compares 4-4-2, 4-3-3, 4-2-3-1, 3-4-3, 3-5-2, 5-3-2 and 5-4-1.
  The 4-2-3-1 formation uses five OS players; it does not infer midfield subroles.
- Locked IDs must remain selected; excluded IDs must not be selected.
- `--risk` optionally charges expected points per same-club defensive pair.
- Use injury-adjusted `expected_points`, not baseline points. Out, doubtful,
  unknown-availability, and otherwise ineligible players are excluded.

This is a mixed-integer program rather than a greedy pick because the
constraints interact. The best player per million is often unaffordable once the
budget has to cover ten more places, and the three-per-club cap can make the
highest-scoring pair of teammates worse than a cheaper split. Greedy selection
gets both wrong.

SciPy's mixed-integer solver solves each allowed formation with a zero relative
gap. A timeout or unproven optimum is an error, not a successful recommendation,
and every returned XI is re-checked against budget, positions, club limit and
locked/excluded selections independently of the solver. Equivalent optimal teams
may differ between solver versions; no artificial score bonus breaks player ties.

The constraint matrix does not depend on the formation - only the four position
row bounds do - so it is built once per player pool and reused across formations
and, in `recommend`, across candidates. On the current 334-player pool that is
about 9 ms for one formation, 51 ms for all seven, and 0.8 s to rank every
defender by completed XI.

## Run

Install dependencies in your existing virtual environment if needed:

```powershell
python -m pip install -r src/xi_optimizer/requirements.txt
python src/xi_optimizer/run.py --season 2026/2027
python src/xi_optimizer/run.py --season 2026/2027 --formation 4-3-3
```

Keep players already chosen by supplying their Sportmonks IDs:

```powershell
python src/xi_optimizer/run.py --lock 5640825 8417851 --recommend --position DEF
```

IDs above are examples and must still be eligible in the current export. An
unavailable locked player produces an explicit error rather than silently being
removed. `--exclude ID ID` excludes eligible candidates. `--budget 100` sets the
budget in millions of TL. `--time-limit 30` limits each formation solve, not the
whole run.

Recommendations force each candidate into the team and re-optimize the remaining
places. They rank by completed-XI points, not the candidate's individual score,
because a high-scoring player who forces ten cheap teammates can be worth less
than a slightly weaker one who leaves the budget intact.
`points_below_optimal_xi` quantifies that opportunity cost. Candidates already in
the unconstrained optimum are scored without a solve: locking a player who is
already selected cannot change the optimum, so the answer is the baseline by
construction. Multiple recommendations can tie because they belong to the same
optimal XI. `--recommend` evaluates all eligible candidates (or the requested
position) and takes substantially longer than a single XI solve.

## Risk

Expected value is linear, so how correlated the chosen players are cannot change
the expected total - only the spread around it. Measured on the points ledger
over 35,849 appearances of 60+ minutes, two players from the same club in the
same match have a points covariance of 7.49 when both are a goalkeeper or
defender, against 0.80 when both play further forward. A clean sheet is one
team-level event paid to the whole defensive block at once. Three defenders from
one club score the same 10.23 points on average as three from different clubs,
with a standard deviation of 8.92 against 5.83.

So stacking attackers is close to free, and stacking defenders is where a squad
quietly concentrates its risk. `--risk` prices exactly that, in expected points
per same-club defensive pair:

| Setting | Weight | Effect |
| --- | --- | --- |
| `low` | +0.75 | Spreads the defence across clubs |
| `balanced` (default) | 0 | Pure expected points, as before |
| `high` | -0.75 | Deliberately stacks one or two defences |

Any number works too, and negative rewards stacking. On the current pool the
three settings give 50.21 points with no same-club pairs (standard deviation
11.39), the same team again, and 47.69 points with six pairs (standard deviation
14.59) - about two and a half expected points traded for roughly a quarter more
spread. Low risk is sometimes free, as it is there: if the points optimum
already spreads the defence, charging for pairs changes nothing.

Neither direction is more correct. Spreading protects a weekly score; stacking
buys the variance needed to catch someone in a league table. `summary.csv`
records the setting, the resulting pair count and the standard deviation, and
`expected_points` is always the true total - the risk charge steers the choice
and never enters the reported points.

The solver keeps this linear by adding two indicator variables per club, "at
least two" and "all three" of that club's defenders. Weighted 1 and 2 their sum
is exactly the pair count, because the club cap is three. Standard deviation is
computed afterwards from the chosen XI using all three measured covariances, so
it is exact rather than the approximation the objective uses.

## Rating

Every candidate carries the provider's decayed match rating, and it is shown
next to the projection. It orders candidates; it never enters the objective.

That split is deliberate. Measured over 21,766 appearances of 60+ minutes, a
player's prior average rating predicts his next fantasy points at r=+0.109,
against +0.134 for his prior average points, and the two are 60% redundant
(r=+0.602). Worse, the incremental value has the wrong sign at the bottom of the
table: holding prior points fixed, the best-rated third of mid-to-high scorers
beat the worst-rated third by +0.31 to +0.66 points, but among low scorers they
*trailed* by 0.13 to 0.20. Letting a weaker, partly redundant and inconsistent
signal outrank the projection would trade accuracy for the appearance of extra
information.

So at the default weight of zero, rating separates only candidates that are
otherwise exactly equal - which is strictly better than the arbitrary
tie-break by player ID it replaced. `recommend(..., rating_weight=w)` lets it
carry real weight in the ordering for callers who want that; the XI each
candidate completes is still solved from expected points alone, so every
reported figure is unchanged and only the running order moves.

The honest place for rating to earn a role in selection is inside the
projections, where `backtest.py` could measure whether it improves them. Until
that measurement exists it stays a displayed signal, not a driver.

## Full sweep (precomputed)

The builder can only rank a shortlist while you wait. `sweep.py` answers the
same question for every eligible player and saves it, so each one carries a real
"what would building around this player cost" number rather than only a
projection.

```powershell
python src/xi_optimizer/sweep.py --season 2026/2027
python src/xi_optimizer/sweep.py --season 2026/2027 --formation 4-3-3
python src/xi_optimizer/sweep.py --season 2026/2027 --risk high --no-publish
```

About 2.5 seconds for one formation and 18 across all seven, at roughly 7
milliseconds per solve on a 334-player pool. Too slow to run while somebody
waits, irrelevant once a week, which is why it is a separate command. It runs
sequentially on purpose: the solves are independent and would parallelise, but
process plumbing is not worth adding to a job that runs once per matchweek.

Rerun it after the fantasy pipeline, since it reads the published projections
and refuses a mismatched generation. `--no-publish` writes only the run record.

Published to `data/final/xi_optimizer/<season>/player_opportunity_cost.csv`,
with a copy and `run_status.csv` under `data/temp/xi_optimizer/sweeps/`. One row
per player: `expected_points` is their own projection,
`completed_xi_expected_points` is the best legal XI containing them, and
`points_below_optimal_xi` is the difference - the price of insisting on that
player. `in_optimal_xi` marks the eleven that cost nothing.

The two rankings genuinely differ. On the current pool a cheap goalkeeper can
climb eighty places against his own projection, because he completes a stronger
eleven than a costlier one does, while a mid-priced midfielder falls just as far.
Eleven players cost nothing, thirty cost under a point, and 136 cost more than
three - that long tail is correct, not a defect.

Two caveats. The sweep locks nothing, so it answers "if I built the optimal team
around this player", not "given the ten I have already picked". Those currently
agree almost exactly - locking three players left the top fifteen defenders in
identical order - but only because the budget is not binding at ₺72.5M of ₺100M,
and that will change if prices tighten. And it inherits the projections it
reads: it measures the model's opinion, not what will happen.

## Inputs and outputs

Reads the current published player projections, pipeline completion marker,
Sportmonks fixtures/download status and matched TFF player CSV. Requires one
projected round, consistent generation IDs, unchanged TFF positions/prices,
upcoming matching fixtures and a deadline one hour before the round's first match.
It rejects double-gameweek/multiple-row player projections instead of choosing one
silently. Rebuild the fantasy pipeline yourself if inputs are stale.

Read `run_status.csv` first. Only `complete` means all requested work succeeded.
An infeasible team has status `infeasible`; solver/read errors have status `failed`.
An interrupted run may have no status file and must not be treated as complete.

- `selected_xi.csv`: selected IDs, clubs, TFF positions, prices, points and locks.
- `summary.csv`: matchweek, source generation, formation, cost and expected total.
- `excluded_players.csv`: unavailable/invalid source players and reasons.
- `recommendations.csv`: optional ranked candidate-completion results.

This maximizes the supplied model's expectation, not guaranteed real points. It
inherits that model's uncertainty and does not yet adjust replacement minutes
when a teammate is injured. `src/player_projections/backtest.py` measures how
well the supplied projections actually select teams; read it before trusting an
XI. No extra TFF rules beyond the stated budget, club cap and formation
constraints are claimed here — in particular, if the game has a captain
multiplier or a bench, neither is modelled.

## Tests (user-run)

```powershell
python -m unittest discover -s tests -p "test_xi_optimizer.py"
```

Tests cover budget/formation/club limits, an expensive greedy trap, locks,
infeasibility, duplicate IDs, full-XI recommendation scoring, and the risk
dial: preset resolution, that low spreads and high stacks, that the pair count
matches the linearisation, and that the risk charge never leaks into the
reported points.
