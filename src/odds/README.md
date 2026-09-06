# Match probability research

Working area requested for research before website integration. This directory
holds analysis source code and notes. Raw provider captures remain under
`data/raw/sportmonks`; generated research CSVs and reports belong under
`data/src/odds`. Nothing is published to `data/final` by this research stage.

The research pipeline is implemented. It reads existing Sportmonks season CSVs;
it does not download data or update the website. The current user instruction
authorizes analysis of the available downloads. Tests remain user-run.

## Run from the project root

Coverage auditing and descriptive summaries require only Python 3.10+:

```powershell
python src/odds/run.py coverage --seasons 2021/2022 2022/2023 2023/2024 2024/2025 2025/2026 2026/2027
```

Missing, unfinished, or changing downloads are reported and skipped. Omit
`--seasons` to inspect all available season folders. Each invocation creates a
new directory under `data/src/odds` with a UTC timestamp and unique suffix.
Previous reports are preserved. Read `run_status.csv` before using any outputs;
an interrupted or blocked run is not a completed backtest.

For modelling, install the research dependencies into the Python environment
you intend to use, then run the historical comparison:

```powershell
python -m pip install -r src/odds/requirements.txt
python src/odds/run.py backtest --seasons 2021/2022 2022/2023 2023/2024 2024/2025 2025/2026
```

To include the boosted candidates:

```powershell
python src/odds/run.py backtest --seasons 2021/2022 2022/2023 2023/2024 2024/2025 2025/2026 --gbdt hist_gbdt
```

The default compares smoothed outcome frequencies, Poisson, and Dixon-Coles,
each with a 365-day half-life and a 1,095-day training window. To compare decay
settings on validation data, add `--decay-candidates 180 365 730`. Other explicit
settings are `--window-days`, `--ridge` (default 5), `--cutoff-hours` (default 24),
and `--min-train-matches` (default 200). Their values are saved for every run.
These defaults are starting choices, not empirically established best settings.

The backtest requires at least five consecutive, fully exported, finished seasons
with complete fixture schedules and no unresolved structural data errors. It
stops if those requirements fail, leaving coverage reports to explain why.
With five seasons, the split is 2021/22-2023/24 initial training, 2024/25 rolling
validation, and 2025/26 held-out rolling evaluation. With more seasons, the final
two retain the validation/test roles. Only the validation-selected candidate and
the frequency baseline are evaluated on the test season. Selection is saved
before test predictions are calculated. Do not tune against that test result;
subsequent changes need another untouched period for an independent evaluation.

If the normal Python command is unavailable, the bundled executable used on this
workstation for coverage is:

```powershell
& 'C:\Users\ygtcs\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' src/odds/run.py coverage
```

The bundled environment was inspected and has NumPy but no SciPy. Coverage works
without them; fitting requires both. The existing `.venv` executable could not
start its referenced Python installation in this session. No environment repairs
are made here.

## Initial prediction target

Predict regulation-time home win, draw, and away win for Super Lig fixtures.
Include stoppage time. Use a consistent prediction cutoff of 24 hours before
kickoff for the first experiment. Use only results completed before that cutoff.
Because publication times are not archived, result availability is conservatively
approximated as kickoff plus three hours, extended to the second-half period end
where a later valid timestamp is present. This is an assumption, not a guarantee
about historical provider publication times.
Keep prediction timestamps and model versions in all prediction exports.

## Historical data recommendation

Start with five completed seasons (2021/22 through 2025/26), plus completed
2026/27 matches for subsequent current-season predictions. Verify actual
subscription access and season coverage first. If basic results for ten seasons
are readily available, retain them for later comparisons; do not assume that
training equally on ten years improves current predictions.

Required fields: Sportmonks fixture, league, season, home-team and away-team IDs;
actual kickoff timestamp; match status; regulation-time home and away goals.
Keep names as labels, not identity keys. Retain venue/neutral-site information
where available. Provider capture timestamps must remain available for auditing.

Before modelling, produce a season coverage report checking duplicate fixture
IDs, missing scores, participant orientation, timestamp completeness, and season
fixture counts against that season's competition structure. Report postponed,
abandoned, awarded and cancelled fixtures separately. Train on normally completed
matches with valid regulation-time scores; do not treat awarded scores as played
results. Missing values are not zeroes.

Historical results can support a reconstructed backtest, but a download today
does not prove what the provider showed at a past prediction cutoff. Document
that limitation, especially rescheduled kickoff times and corrected results.

## Models and evaluation

Two candidates are kept, plus a baseline that exists only for comparison.

1. Historical league home/draw/away frequency, estimated on training data only.
   Not a deployable model: it is the reference the paired bootstrap measures
   against, and removing it would leave the comparison with no baseline.
2. Independent Poisson attack/defence with home advantage and shrinkage toward
   league averages, including an explicit prior for promoted teams.
3. XGBoost on the pre-match features in `features.py`, with settings tuned by
   `tune.py` and stored in `xgboost_params.json`.

Dixon-Coles, LightGBM and scikit-learn's HistGradientBoosting were compared and
dropped. All three finished within 0.006 log loss of the two kept models on a
340-match validation season, while the paired bootstrap puts the resolution of
that sample at roughly +/-0.045. Their ordering was not distinguishable from
noise, so carrying them added run time and no information. The Dixon-Coles rho
machinery stays in `models.py` because the Poisson path shares it with rho fixed
at zero; only the candidate was removed.

Tuning matters more than the choice between the two. Untuned, XGBoost scored
1.006 on validation; tuned it scored 0.965. The gain came from calibration
rather than accuracy: the away-side bias fell from about -3.8pp to -1.0pp and
the share of predictions above 0.70 fell from 28% to 13%.

Neither model is clearly better. XGBoost won validation by 0.005 and lost the
held-out season by 0.009. Treat them as two readings of the same evidence, which
is why `predict` runs both by default.

Goal models jointly fit a standard log-linear attack/defence model, centering
team effects and penalizing their squared magnitude. Unseen teams receive zero
effects (the league-average prior). Time weights are exponential in kickoff age;
`effective_matches` is their sum, not a formal effective sample size. Optimizer
failures abort evaluation; broad numerical parameter bounds are disclosed in the
prediction rows. Frequency predictions use one pseudo-count per outcome and
equalize home/away probabilities for explicitly neutral venues.

Use rolling chronological evaluation. With five completed seasons, use the first
three for initial fitting, the fourth for rolling validation and parameter
selection, and the fifth for a held-out rolling test. During the test, refitting
may incorporate earlier completed test matches, but modelling choices and tuning
must stay fixed. Never use random train/test splits or final-season standings as
historical pre-match features.

Report multiclass log loss, multiclass Brier score, calibration tables with sample
counts, and per-season results. Keep all models on the same evaluated fixtures.
Treat small score differences with caution; inspect paired uncertainty. Accuracy
is secondary, and the boosted candidates demonstrate why: untuned XGBoost beat
Poisson on accuracy while losing on log loss, because sharper predictions win
more calls and cost more when wrong.

Calibration was tested and rejected. A per-class correction fitted on the
validation season and applied to the held-out season improved log loss by 0.0002
and made Brier worse. Of the three classes only the away bias replicated across
seasons; the draw gap appeared in both Poisson and XGBoost on the same season
and reflects that season's draw rate (29.1% against 23.5%), not a model defect.

## Weekly forecast

Two commands, in this order. The download matters: without it the model has no
idea last weekend happened.

```powershell
.venv\Scripts\python.exe src/fetch/download_season.py --season 2026/2027
.venv\Scripts\python.exe src/odds/run.py predict
```

`--seasons` defaults to every downloaded season, `--round` defaults to `next`
(the matchweek holding the earliest unplayed fixture), and `--model` defaults to
Poisson and XGBoost so the two can be read side by side.

XGBoost is re-tuned before every forecast. The search runs on chronological
folds over results already available at the first prediction cutoff, so it can
see nothing the forecast itself could not. One hundred trials take about a
minute; `--trials` changes that and `--no-tune` skips the search and falls back
to the stored `xgboost_params.json`.

Re-tuning each week is a deliberate choice, not a free one. Hyperparameters
describe how much model complexity the sample supports, and that barely moves
when nine matches are added, so expect the settings to wander slightly between
runs without the forecasts changing much. `tuned_params.csv` in each run records
exactly what was used.

## Output

```text
data/final/odds/
  predictions.csv                  latest forecast, overwritten every run
  runs/<timestamp>_predict_<id>/   full record of one run, never overwritten
    predictions.csv
    tuned_params.csv, tuning_trials.csv
    candidates.csv, run_status.csv
    coverage_report.csv, excluded_fixtures.csv
    input_manifest.csv, code_manifest.csv, run_settings.csv
```

`predictions.csv` holds one row per fixture per model: three probabilities that
sum to one, and fair odds as `1/probability` with no margin applied. These are
not prices; no market comparison is made anywhere in this pipeline.

`actual_outcome`, `home_goals`, `log_loss`, `brier_score` and `correct` are
always empty in a forecast because the match has not been played. They exist
because the backtest fills the same columns.

Two fields worth watching. `cutoff_in_future` is `True` when the 24-hour cutoff
has not yet passed, meaning the fit currently uses every completed result and
will change if re-run closer to kickoff. `effective_matches` is the training set
weighted by time decay; a sharp fall in it means something is wrong upstream.

