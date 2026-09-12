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
python src/run_pipeline.py --season 2026/2027
```

This builds points, projections and SQLite, then publishes a matching generation
for the website. Points reads the reviewed TFF CSV directly; no prior database
build is needed.

A standalone `python src/points/run.py` writes the same published paths without
the `pipeline_run_id` stamp, which makes the website reject the entire fantasy
dataset until the pipeline is rerun - recommendations go empty and the only
clue is "Fantasy analysis is being updated". The run now detects that it
overwrote a stamped file and prints the command to repair it. Use standalone
runs for development, then rerun the pipeline before opening the site.

`--seasons` on the standalone command defaults to every downloaded season. `--reconcile-before` excludes
fixtures that kicked off on or after that date from the accuracy check: the
fantasy export is a snapshot, so a matchweek played after it was taken sits in
the ledger but not in `tp`, and without the cut those players read as scoring
errors rather than as timing.

## Output

```text
data/final/points/
  player_match_points.csv     the ledger, one row per player per match
                              (carries the provider `rating` for context;
                               it scores nothing and enters no total)
  player_season_summary.csv   per player per season, with consistency measures

data/temp/points/runs/<timestamp>_ledger_<id>/
  the same two files, plus:
  component_summary.csv       where points come from, overall and by position
  reconciliation.csv          computed season totals against the game's own tp
  unmatched_players.csv       fantasy players with no usable Sportmonks id
  data_issues.csv             provider gaps encountered while building
  run_settings.csv
```

## Is it right?

The original experiment reconstructed 2026/27 totals against the game's own `tp`, for the 395 players
matched to a Sportmonks id, excluding fixtures after the snapshot:

**317 of 395 exact, 384 within 2 points, mean absolute error 0.38, bias −0.10.**

These are archived results, not validation of the integrated pipeline. The new
ledger excludes unfinished/non-league matches, rejects duplicate IDs and applies
TFF positions only to the specified TFF season. Final-score conceded corrections
are limited to full-match starters. Rerun reconciliation to measure these fixes;
without an explicit cutoff the comparison is provisional. Rules are unchanged.

Historical records without usable player or fixture IDs are skipped and counted
in the run's `data_issues.csv`, including the fixture reference where supplied.
Identities are never inferred from names. Duplicate valid fixture/player pairs
still stop the build to prevent double counting. Skipped participants also mean
the reconstructed bonus ranking for that fixture may have incomplete coverage.

That check is the reason the module exists in this shape. A rule read wrongly
shows up here as disagreement, rather than as a quietly wrong projection six
steps later.

It also resolved a rule the source graphic states ambiguously. "60 dakikadan
fazla" reads as *more than* 60 minutes, but scoring at that threshold produces
165 exact matches against 271 for a 60-inclusive threshold with any appearance
scoring 1. The rules file now records the resolved version and the evidence.

## When the download is behind the fantasy export

A fixture still being played when the provider data was captured leaves its
players short a match in the ledger while the fantasy export already counts it.
That shows up as a large negative difference and looks exactly like a scoring
error. The reconciliation marks those players `club_fixture_unfinished` and
reports the two groups separately, because the fix is completely different:
re-download the season, rather than question the rules.

On the current data two round-4 fixtures were still in progress, affecting four
clubs. Split out, the comparison reads:

```text
comparable players    : 278/308 exact (90%), mean absolute error 0.12
stale-fixture players :  39/88  exact (44%), mean absolute error 1.72
```

The scoring is accurate to 0.12 points on every player whose matches are
actually complete. Re-download and rebuild to clear the rest.

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
the scoreline exactly. The inherited blank-as-zero convention remains, but
final-score correction now applies only to starters with at least 90 minutes.
A substituted player's conceded count cannot be inferred from the final score.

A second yellow is recorded in `yellowred_cards`, not `redcards`. A player is
dismissed at most once, so the two are combined rather than added.

For the current TFF season, fantasy position comes from the game's own classification where the player is
matched, and from the Sportmonks per-match position otherwise. `position_source`
records which was used, since scoring depends on it and the fallback is the only
option for seasons before the current pool was scraped.
