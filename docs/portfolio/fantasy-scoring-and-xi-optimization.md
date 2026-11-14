# Fantasy scoring and XI optimization

TFF Fantasy provides season totals. I reconstructed a player-match scoring ledger so I could see how points accumulated and use past scores in player analysis. I also built an optimizer to work out which eleven players to select once their projected points and prices were available.

**Skills demonstrated** · Rule-based scoring · Data reconciliation · Mixed-integer optimization · Risk trade-offs

## My approach

- **Scoring.** I put position-specific rules in a CSV and recorded a breakdown of points for each appearance. The ledger uses conceded goals while the player was on the pitch. For a full-match starter with a blank concession count, it can use the final score to fill the gap. I reconcile reconstructed totals against the TFF snapshot and flag clubs with unfinished fixtures. The bonus allocation is approximate.
- **Selection.** I used SciPy’s mixed-integer solver with one binary variable per player. The model enforces eleven players, the formation, the budget, a three-per-club limit, and any players the user locks or excludes. For recommendations, I rank each candidate by the best full XI the candidate can complete.
- **Defensive risk.** A clean sheet can benefit several teammates at once. I gave users a setting that rewards or penalizes pairs of defensive players from the same club while reporting the lineup’s expected points separately.

## How I checked it

Scoring tests cover unfinished fixtures, duplicate player-match rows, and whether a player who leaves the pitch inherits a later concession. Optimizer tests check budget and formation constraints, infeasible selections, and how changing the risk setting affects defensive concentration. [Scoring tests](../../tests/test_points.py) · [Optimizer tests](../../tests/test_xi_optimizer.py)

## Read the code

- `build_season()` reconstructs points by player and fixture, including the breakdown by scoring rule. [Ledger builder](../../src/points/run.py#L113)
- `_Problem` builds the solver’s constraint matrix once per player pool. `recommend()` reuses it to evaluate possible next picks. [Constraint matrix](../../src/xi_optimizer/optimizer.py#L128) · [Recommendations](../../src/xi_optimizer/optimizer.py#L299)
