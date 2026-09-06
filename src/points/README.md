# Fantasy points ledger

One row per player per match: what they did, and what it scored under
`config/tff_scoring_rules.csv`.

Everything downstream — expected minutes, projections, the optimiser — predicts
fantasy points, and none of it can be fitted or checked without a record of what
those points actually were. The TFF export gives one season-to-date total per
player. This gives 53,891 player-matches across six seasons, broken into
components.

## Run

```powershell
.venv\Scripts\python.exe src/points/run.py --reconcile-before 2026-09-05
```

`--seasons` defaults to every downloaded season. `--reconcile-before` excludes
fixtures that kicked off on or after that date from the accuracy check: the
fantasy export is a snapshot, so a matchweek played after it was taken sits in
the ledger but not in `tp`, and without the cut those players read as scoring
errors rather than as timing.

## Output

```text
data/final/points/
  player_match_points.csv     the ledger, one row per player per match
  player_season_summary.csv   per player per season, with consistency measures

temp/points/runs/<timestamp>_ledger_<id>/
  the same two files, plus:
  component_summary.csv       where points come from, overall and by position
  reconciliation.csv          computed season totals against the game's own tp
  unmatched_players.csv       fantasy players with no usable Sportmonks id
  data_issues.csv             provider gaps encountered while building
  run_settings.csv
```

## Is it right?

Reconstructed 2026/27 totals against the game's own `tp`, for the 395 players
matched to a Sportmonks id, excluding fixtures after the snapshot:

**317 of 395 exact, 384 within 2 points, mean absolute error 0.38, bias −0.10.**

That check is the reason the module exists in this shape. A rule read wrongly
shows up here as disagreement, rather than as a quietly wrong projection six
steps later.

It also resolved a rule the source graphic states ambiguously. "60 dakikadan
fazla" reads as *more than* 60 minutes, but scoring at that threshold produces
165 exact matches against 271 for a 60-inclusive threshold with any appearance
scoring 1. The rules file now records the resolved version and the evidence.

## Known residual

53 players disagree by a point or more while their minutes agree, and the
residual is concentrated in the bonus. Players my scorer awards bonus to run
+0.38 against the official total; players it awards none to run −0.40. The
magnitude is right and the recipients are not, which suggests the game ranks its
3/2/1 bonus on something other than the points computed here — a rating or an
index of its own. Everything except `bonus` and `points_total` is unaffected.

Separately, players conceding heavily run −1.33, so the goals-conceded penalty
may be capped or counted differently than one point per two goals.

## Data conventions, verified rather than assumed

`goals_conceded` is per player, not per team: it counts goals conceded while
that player was on the pitch. All 605 full-match goalkeepers in 2025/26 matched
the scoreline exactly. Blank means none conceded, so it is cross-checked against
the scoreline only to catch the few provider gaps where a player finished a
match his team lost goals in — 1,959 such corrections across six seasons, nearly
all in 2024/25.

A second yellow is recorded in `yellowred_cards`, not `redcards`. A player is
dismissed at most once, so the two are combined rather than added.

Fantasy position comes from the game's own classification where the player is
matched, and from the Sportmonks per-match position otherwise. `position_source`
records which was used, since scoring depends on it and the fallback is the only
option for seasons before the current pool was scraped.
