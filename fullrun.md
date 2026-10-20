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

Then reload the local site. To publish to fantezianaliz.com as well:

```powershell
python src/web/build_static.py --season 2026/2027
npx wrangler pages deploy data/temp/site --project-name fantezianaliz --branch main
```

Or let the scheduled update below do all of it, except the TFF export.

## Publishing code changes

The public site's code comes from GitHub, not from this folder: the build takes
the website files from `main` as last pushed. Saved, committed-but-unpushed and
half-finished edits never go live, even when a scheduled data update runs.

1. Commit and push the change.
2. Either wait for the next scheduled update, or publish it now with the two
   commands above (they reuse the data you already have).

The build prints which commit it published, and every page of the live site
names it in an `X-Site-Code` header. Push page changes together with any
pipeline change they depend on: the pipeline runs from this folder, the pages
from GitHub.

To preview unpushed code first, build from this folder and open it locally:

```powershell
python src/web/build_static.py --season 2026/2027 --local-code
npx wrangler pages dev data/temp/site
```

Don't upload a `--local-code` build; push instead.

## Automatic updates

`src/update_site.py` runs download, odds (when needed), pipeline, build and
upload in that order, and stops at the first failure, so a broken run never
reaches the public site. Windows Task Scheduler starts it every 30 minutes;
most starts find nothing to do and exit without contacting anyone. It does the
work:

- 2.5 hours after each kickoff (the result) and 6 hours after (Sportmonks'
  statistics corrections, late kickoffs);
- once a day otherwise, for injuries, squads and kickoff times;
- after a failure, no sooner than 2 hours later.

The odds forecast runs only when the next matchweek has not started and has no
forecast yet - normally once, the first run after a matchweek ends. The TFF
export still needs you: run it weekly as above, and the next update publishes it.

Set it up once, in PowerShell:

```powershell
$action = New-ScheduledTaskAction -Execute "C:\Users\ygtcs\AppData\Local\Programs\Python\Python314\pythonw.exe" -Argument "src\update_site.py" -WorkingDirectory "C:\Users\ygtcs\Desktop\superlig\analysis"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 30)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 4)
Register-ScheduledTask -TaskName "Fantezi Analiz update" -Action $action -Trigger $trigger -Settings $settings -Description "Updates fantezianaliz.com. See fullrun.md."
```

`pythonw.exe` runs without a window. If you move to a newer Python, point the
task at its `pythonw.exe`. The computer has to be on; a start missed while it
was off or asleep runs as soon as it is back.

| To | Run |
|---|---|
| See whether an update is due, without running one | `python src/update_site.py --check` |
| Update now, by hand, with progress | `python src/update_site.py --now` |
| Make the task run now | `Start-ScheduledTask -TaskName "Fantezi Analiz update"` |
| Pause / resume it (for example in summer) | `Disable-ScheduledTask` / `Enable-ScheduledTask -TaskName "Fantezi Analiz update"` |
| Remove it | `Unregister-ScheduledTask -TaskName "Fantezi Analiz update" -Confirm:$false` |

Every run that did work adds a row to `data/temp/site_update/update_runs.csv`
(status, reason, which steps ran, where it stopped) and writes the full output
to `data/temp/site_update/logs/`. The site's own "Fantezi analizi güncellendi"
date shows the last successful update.

The upload reuses the Cloudflare login wrangler saved when you first deployed
by hand. If it ever fails with a login error, either run the manual deploy once
to log in again, or add `CLOUDFLARE_API_TOKEN` (a token with Cloudflare Pages
edit access) and `CLOUDFLARE_ACCOUNT_ID` to `.env`; the update then uses those.

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
