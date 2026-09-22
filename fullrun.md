# Full run

Run from the project folder, in this order.

## After a single match (mid-week)

```powershell
python src/fetch/download_season.py --season 2026/2027 --refresh
python src/run_pipeline.py --season 2026/2027
```

## After the last match of the matchweek

```powershell
python src/fetch/download_season.py --season 2026/2027 --refresh
python src/fetch/export_tff_browser.py --season 2026/2027
.venv/Scripts/python.exe src/odds/run.py predict
python src/run_pipeline.py --season 2026/2027
```

Then reload the site.

## What each command does

**`download_season.py --refresh`**
Downloads the season from Sportmonks and rebuilds the CSVs in
`data/final/sportmonks/`. `--refresh` skips the cache, so you get the new match.

**`export_tff_browser.py`**
Opens a browser, you log in to TFF, and it saves prices, positions and TFF's own
points. Weekly only: TFF updates per matchweek, not per match.

**`odds/run.py predict`** (uses `.venv`, which has XGBoost and Optuna)
Tunes XGBoost with Optuna, fits Poisson and XGBoost, and forecasts the next
matchweek into `data/final/odds/predictions.csv`. Takes about a minute;
`--no-tune` skips tuning. Only useful after the matchweek ends - mid-week it
forecasts the round still being played, which projections ignore.

**`run_pipeline.py`**
Rebuilds everything the site reads, and publishes nothing unless all of it
succeeds:
1. fantasy points per player-match
2. next matchweek projections (uses the odds forecast if it covers that round)
3. website tables
4. SQLite database (`--skip-database` to leave it out)

## Check it worked

Open the newest folder in `data/temp/player_projections/runs/` and read
`run_settings.csv`. `team_goals_source` should say `odds_model` after a full run; if it
says `internal_history`, `team_goals_note` says why.
