# Player projections

Experimental component forecast for the next matchweek. It reads saved CSVs
only and makes no provider calls. Rebuildable working output goes under
`data/temp/player_projections`, alongside every other module's.

## Run

After refreshing Sportmonks and the reviewed TFF player table:

```powershell
python src/run_pipeline.py --season 2026/2027
```

The pipeline builds points, projections and SQLite, then publishes a matching
website generation. Add `--matchweek 5` for a specific round or `--skip-database`
for CSVs only. No analysis or tests were executed by the assistant.

For standalone development: `python src/player_projections/run.py --season
2026/2027`. This writes the published paths without the `pipeline_run_id` stamp,
so the website rejects the whole fantasy dataset until the pipeline is rerun.
The run warns when it has done that and prints the command to repair it.
Options include `--input-root`, `--tff-players`, `--points-path`, `--rules`,
`--output-root` and `--runs-root`. Output-root is the parent of season folders.

The default target is the earliest complete unstarted round before its global
one-hour-before-first-kickoff deadline. No such round produces header-only CSVs.

## Outputs

`data/final/player_projections/<season>/player_projections.csv` contains one row
per matched player with a target fixture. `team_fixture_projections.csv` contains
the team goal estimates. Reports, excluded identities and input fingerprints
live under `data/temp/player_projections/runs`. Original experiments were moved
there intact and are not promoted as current forecasts.

## Calculation

Sportmonks player IDs join the reviewed TFF price, team and position to the
historical ledger. Unresolved identities stay in the exclusion report. Starting,
appearance and 60-minute chances blend current-season history with a 1.5-match
position prior. Event rates use two years, a 240-day half-life and a 720-minute
position prior.

Team expected goals come from the odds model's Poisson fit, read from
`data/final/odds/predictions.csv`, whenever it covers the whole round and was
fitted only on results older than this projection's cutoff. That check uses
`training_latest_available_at_utc`, the newest result the fit consumed, not the
odds file's nominal cutoff, which is normally still in the future when the
forecast is made. `team_goals_source` records which estimate was used and
`--no-odds` forces the fallback.

The fallback is the module's own estimate: three years of actual goals, a
365-day half-life and an eight-match league prior. Both are model estimates, not
the provider shot-xG feed. They currently agree to 0.052 goals per team on
average, worth 0.027 expected points per player, so preferring the odds model is
about using the one that has been backtested rather than keeping two unmeasured
estimates of the same quantity.

All scoring constants come from the reviewed
`config/tff_scoring_rules.csv`; the rules and their confirmation flags are unchanged.

`expected_yellow_cards` and `expected_red_cards` are the expected card counts
behind `points_cards`: the player's decayed per-90 rates times expected minutes,
without fixture scaling. Red cards are dismissals, so a second yellow counts.

Expected points sum appearances, goals, assists, clean sheets, saves, penalties,
conceded penalties, cards, own goals and historical bonus expectations. Poisson
scoring probability is conditional on appearing and cannot exceed playing chance.
The model is experimental, without predictive backtesting. Confidence labels
measure historical sample coverage, not forecast accuracy. The inherited bonus
reconstruction is approximate. Injury effects on teammates/team strength, transfer
opportunity windows and expected lineups are not yet modeled.

## Backtest

`backtest.py` replays every completed matchweek at its own deadline, projects
each player from data available only before it, and compares the forecast with
the points they went on to score. Without it the model was unmeasured.

```powershell
python src/player_projections/backtest.py --season 2026/2027
```

Two questions, which are not the same. Accuracy is mean absolute error and rank
correlation against actual points; a model can win there by predicting the
average for everybody. Selection feeds each method's numbers to the same
optimizer, takes the eleven it picks and adds up what those eleven really
scored. That is the question the project exists to answer.

Both are measured against baselines needing no model: season points per match so
far, the last three matches, the position average, and the price the game
charges. A hindsight XI chosen with the results already known gives the ceiling.

Reports land in `data/temp/player_projections/backtests/<timestamp>_backtest_<id>/`
as `player_rounds.csv`, `round_scores.csv`, `method_summary.csv` and
`selected_teams.csv`.

Three limitations, none fixable inside the backtest. Availability is a snapshot
of today's injuries, so the replay scores the pre-availability `baseline_*`
forecast rather than retroactively ruling out players for injuries they had not
yet suffered. The player pool, prices and positions come from the current
fantasy export, so replaying an earlier season would assign transferred players
to the wrong club, which is why the default is the current season only. And the
sample is however many rounds have been played.

## Rating

`recent_rating` is the player's decayed average Sportmonks match rating, shrunk
toward the position mean by four appearances and built in the same leak-free
replay as everything else. `rating_appearances` says how many rated matches it
rests on. It is carried for display and for ordering candidates downstream, and
is deliberately absent from expected points, which are built from the scoring
rules alone. Rating scores no fantasy points; treating it as though it did would
be inventing a rule the game does not have.

## Availability

Target-season `team_sidelined.csv` and `fixture_sidelined.csv` supply availability.

- Target-fixture absence: `out`, zero forecast points and player probabilities.
- Active injury with estimated return on/after kickoff: `expected_out`.
- Active injury without a date, or a passed unconfirmed date: `doubtful`.
- Unscoped suspensions or missing feeds: `unknown`.
- No active records in present feeds: `no_reported_absence`, not medical clearance.

Uncertain statuses have blank forecasts and are excluded from automatic selection.
Duplicate injuries preserve the latest nonblank estimate. Internal `baseline_*`
fields retain the pre-availability forecast for audit, never normal display.
Missing price blocks budget eligibility. Rebuild after refreshing availability.
The website rejects mixed generations, wrong seasons, outdated fixture projections
and a Sportmonks download newer than the published fantasy generation.
# Team strengths and fixture difficulty

Player projections export team/opponent attack and defence strength, two fixture
factors, two 1–5 difficulty bands, and a history/fallback marker. These explain
the opponent adjustment already present in expected points; they do not multiply
the final points again.

The current goals-based strengths use at most 1,095 days of completed results,
a 365-day half-life and an eight-match prior toward average strength. Attack is
goals scored relative to the home/away league baseline. Exported defence strength
is the reciprocal of the internal goals-conceded factor, so both strength indices
have 1 as average and higher as stronger. They are descriptive estimates, not
opponent-adjusted fitted ratings or provider xG statistics.

Attacking fixture factor = opponent conceded factor × scoring venue baseline /
average team goals. Defensive fixture factor = opponent attack × opposition venue
baseline / average team goals. Attack difficulty uses the reciprocal of the
attacking factor; defence difficulty uses the defensive factor directly. Risk
bands are below 0.65, below 0.85, through 1.15, through 1.45, and above 1.45,
corresponding to 1 (easy) through 5 (hard). These thresholds are experimental,
not calibrated win probabilities. Opponent strength and venue define difficulty;
the team's own strength remains a separate input to the goal/clean-sheet model.

Goals and assists already scale with the predicted scoring environment. Clean
sheet points already use exp(-opponent expected goals) and the chance of 60+
minutes. Goalkeeper save and goals-conceded components already reflect opponent
scoring pressure. Thus harder fixtures need not reduce every goalkeeper component.
The optimizer consumes these adjusted expected points without another difficulty
bonus or penalty. New fields appear after the user reruns the fantasy pipeline;
older exports display unavailable context. Backtesting the indices and thresholds
is still required before claiming better predictive accuracy.
