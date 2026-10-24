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

GitHub updates the site on its own servers; this computer can be off.
`.github/workflows/update-site.yml` runs every hour from 13:00 to 02:00 Turkish
time. Each run first asks `src/update_site.py --check` whether there is anything
to do - under a minute, and most hours the answer is no. When there is, it runs
`update_site.py`: download, odds (when needed), pipeline (without SQLite, which
the site never reads), build and upload, stopping at the first failure so a
broken run never reaches the public site. It does the work:

- 2.5 hours after each kickoff (the result) and 6 hours after (Sportmonks'
  statistics corrections, late kickoffs);
- once a day otherwise, for injuries, squads and kickoff times;
- after a failure, no sooner than 2 hours later.

GitHub may start a scheduled run some minutes late. The odds forecast runs only
when the next matchweek has not started and has no forecast yet - normally once,
the first run after a matchweek ends.

### Where the data lives

Cloudflare R2 (bucket `fantezianaliz-data`) holds `data/final`, the current
season's raw Sportmonks captures and the run history between runs. R2 is the
main copy; this computer keeps a copy. `src/sync_data.py` moves files both
ways, never deletes anything, and refuses to let an older local file overwrite
a newer one in R2.

| To | Run on this computer |
|---|---|
| Bring this computer up to date (before working with the data here) | `python src/sync_data.py pull` |
| Publish a weekly TFF export (after `export_tff_browser.py`) | `python src/sync_data.py push --path data/final/tff_fantasy` |
| See what a pull or push would change | add `--dry-run` |
| Also fetch the raw captures | `python src/sync_data.py pull --path data/raw/sportmonks/2026-2027` |

The next GitHub run picks up a pushed TFF export by itself. Downloads and the
pipeline should now run in GitHub only; if you run them here, pull first and
push afterwards, or the next cloud run will not see your results.

### Watching it

On GitHub: the repository's **Actions** tab, **Update fantezianaliz.com**. Each
run shows its steps; a failed update keeps its full log as **update-log** for 14
days. **Run workflow** starts one by hand, with **Update now** to skip the
schedule. The run history is also in R2 as
`data/temp/site_update/update_runs.csv` (pull it to read it here). The site's
own "Fantezi analizi güncellendi" date shows the last successful update.

### Setting it up (once)

1. **R2 bucket.** Cloudflare dashboard -> **R2 Object Storage**. The first time,
   Cloudflare asks you to purchase R2: the free tier still needs a payment
   method, and stays free up to 10 GB (the data is about 0.3 GB). Then **Create
   bucket**, named exactly `fantezianaliz-data`, location **Automatic**, no
   jurisdiction (a jurisdiction bucket has another address `sync_data.py` does
   not use). Leave it private: never turn on public access.
2. **R2 key.** R2 -> **Manage API tokens** -> **Create API token**: permission
   **Object Read & Write**, limited to the `fantezianaliz-data` bucket. Keep the
   **Access Key ID** and **Secret Access Key** it shows once.
3. **Pages token.** **My Profile** -> **API Tokens** -> **Create Token** ->
   **Custom token**: permission **Account -> Cloudflare Pages -> Edit**. Keep the
   token. Your **Account ID** is on the right of the Workers & Pages overview.
4. **This computer's `.env`** gets the R2 values (names in `.env.example`):
   `R2_ACCOUNT_ID` (the Account ID), `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
   `R2_BUCKET=fantezianaliz-data`. Then `pip install boto3`.
5. **First upload.** `python src/sync_data.py push`, then
   `python src/sync_data.py push --path data/raw/sportmonks/2026-2027`.
6. **GitHub secrets.** Repository -> **Settings** -> **Secrets and variables** ->
   **Actions** -> **New repository secret**, one each:
   `SPORTMONKS_API_TOKEN`, `CLOUDFLARE_API_TOKEN` (step 3),
   `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
7. **Push** the workflow, then **Actions** -> **Update fantezianaliz.com** ->
   **Run workflow** with **Update now** ticked, and watch the first run.

GitHub gives a private repository 2,000 free minutes a month; this schedule uses
roughly 1,200-1,500, most of them on the real updates. The season is set at the
top of the workflow (`SEASON`, `SEASON_FOLDER`); change both when a new one starts.

### Alternative: on this computer

`update_site.py` can also run from Windows Task Scheduler every 30 minutes, with
the data in this folder. Use one or the other, never both: two schedules would
download twice and overwrite each other's results. The same rules decide when
it works. Set it up in PowerShell:

```powershell
$action = New-ScheduledTaskAction -Execute "C:\Users\ygtcs\AppData\Local\Programs\Python\Python314\pythonw.exe" -Argument "src\update_site.py" -WorkingDirectory "C:\Users\ygtcs\Desktop\superlig\analysis"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 30)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 4)
Register-ScheduledTask -TaskName "Fantezi Analiz update" -Action $action -Trigger $trigger -Settings $settings -Description "Updates fantezianaliz.com. See fullrun.md."
```

`pythonw.exe` runs without a window. The computer has to be on; a start missed
while it was off or asleep runs as soon as it is back.

| To | Run |
|---|---|
| See whether an update is due, without running one | `python src/update_site.py --check` |
| Update now, by hand, with progress | `python src/update_site.py --now` |
| Make the task run now | `Start-ScheduledTask -TaskName "Fantezi Analiz update"` |
| Pause / resume it (for example in summer) | `Disable-ScheduledTask` / `Enable-ScheduledTask -TaskName "Fantezi Analiz update"` |
| Remove it | `Unregister-ScheduledTask -TaskName "Fantezi Analiz update" -Confirm:$false` |

Every run that did work adds a row to `data/temp/site_update/update_runs.csv`
(status, reason, which steps ran, where it stopped) and writes the full output
to `data/temp/site_update/logs/`. Here the upload reuses the Cloudflare login
wrangler saved when you first deployed by hand, or `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` from `.env` when they are set.

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
