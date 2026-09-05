# Super Lig data — Sportmonks with TFF Fantasy snapshots

Sportmonks is the primary football-data provider. TFF Fantasy table snapshots
are kept separately as a supplemental source and matched to Sportmonks player
IDs. Use **CSV for Python analysis and data exchange**, and **SQLite for the final dataset and SQL queries**. CSV fits these rectangular tables; JSON is more useful for nested API responses, which this project already preserves in typed raw CSV files.

You run downloads, database builds, tests, and analysis. The assistant edits code and performs explicitly requested cleanup. These preferences are saved in `AGENTS.md`.

## Local website

Run the local website from the project root:

```powershell
python src/web/serve.py --season 2026/2027
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000) and leave the terminal running. The page automatically loads the saved season CSVs from `data/final/sportmonks/2026-2027`. After your next download finishes, reload the page or click **Refresh saved data**; no file selection or code changes are needed. This reads local files only and makes no Sportmonks calls. Stop the server with Ctrl+C.

**Home** shows the league points table on the left and fixtures on the right. **Player Tier List** groups players by average Sportmonks match rating, shows season totals, and opens full match statistics, including roster players with no appearances. You can still open `src/web/index.html` directly and select CSVs manually. See `src/web/README.md` for details. No domain has been connected or website published.

## Python setup

Python 3.10+ is sufficient for the core scripts; they have no third-party package requirements. The optional browser exporter below requires Playwright. Keep your token in `.env`:

```dotenv
SPORTMONKS_API_TOKEN=your_token
```

If your normal Python command is unavailable, replace `python` in the commands below with this workstation's bundled executable:

```powershell
& 'C:\Users\ygtcs\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' src/fetch/download_season.py --season 2026/2027
```

## Workflow

Run from the project directory:

```powershell
# Refresh Sportmonks and rebuild the clean season CSVs
python src/fetch/download_season.py --season 2026/2027 --refresh

# Capture the current TFF table and update final/tff_fantasy/tff_players.csv
python src/fetch/export_tff_browser.py --season 2026/2027

# Run this last to atomically rebuild the combined database
python src/fetch/build_database.py --season 2026/2027
```

Files:

```text
data/
  raw/                        # Lossless provider captures; never edited manually
    sportmonks/2026-2027/
      raw_fixtures/
      raw_resources/
    tff_fantasy/
      players_<timestamp>.csv
  temp/                       # Rebuildable working files
    cache_csv/
    tff_fantasy/
      tff_player_match_report.csv
      tff_player_match_candidates.csv
  final/                      # Clean tables consumed by the website and database
    sportmonks/2026-2027/
      fixtures.csv
      player_match_stats.csv
      teams.csv
      players.csv
      squads.csv
      standings.csv
      fixture_scores.csv
      ...
    tff_fantasy/
      tff_players.csv
  superlig.sqlite             # Unified Sportmonks + TFF Fantasy database
config/
  tff_player_overrides.csv    # Permanent, manually reviewed identity decisions
```

Source code lives in `src/fetch/`. The scripts find `.env` and create `data/` at the project root regardless of the working directory. They also support module invocation from the project root, for example `python -m src.fetch.download_season --season 2026/2027`.

## CSV conventions

`player_match_stats.csv` has one row per player per match and separate columns for available statistics. Standard metrics use lowercase names such as `minutes_played`, `shots_total`, and `goals`. The dedicated xG feed uses an `xg_` prefix such as `xg_expected_goals`. The two feeds can contain the same concept: do not add them together.

Long-format metric tables retain provider type IDs, metric names, sources, and values. Complex season totals become scalar columns such as `value.total` and `value.home`. Blank metric cells remain missing; numeric zero remains zero. Metric columns depend on what the provider returned. UTF-8 with a BOM preserves Turkish characters in common spreadsheet applications.

Raw CSV files preserve nested source records as typed scalar rows: `node_id,parent_id,key,kind,value`. Use the root-level tables for ordinary analysis; the raw files support complete source retention and rebuilding.

## SQLite build

`build_database.py` imports the clean Sportmonks CSVs with a `sportmonks_` table prefix and imports `data/final/tff_fantasy/tff_players.csv` as `tff_players`. It excludes status and validation reports. It infers INTEGER, REAL, and TEXT columns, preserves codes with leading zeroes as text, maps blank cells to SQL NULL, and adds primary keys and indexes to the main tables. Column names containing dots are retained and can be referenced with double quotes in SQL.

The build requires a completed Sportmonks download and the final TFF player table. It checks row counts and duplicate assigned player IDs, then writes a temporary database before atomically replacing `data/superlig.sqlite`. Unresolved TFF rows remain in `tff_players` with a blank/SQL NULL Sportmonks ID and their review status. If the build fails, the previous database remains. On Windows, disconnect the `superlig` data source in the database viewer before rebuilding; closing only its SQL editor tab may leave the SQLite file locked. Reconnect and synchronize it after the build. `import_log` records imported filenames, row counts, and timestamps.

To keep the existing database and write a separate one:

```powershell
python src/fetch/build_database.py --season 2026/2027 --output data/superlig-new.sqlite
```

## Optional commands you can run

### Learning HTML extraction from a saved TFF table

`src/fetch/parse_tff_table.py` reads a statistics table you manually copied into
an HTML or text file. It uses only the Python standard library and makes no
network requests. This standalone local exercise does not feed the Sportmonks
pipeline or the website.

```powershell
python src/fetch/parse_tff_table.py "C:\path\to\table.html"
```

The output is `data/raw/tff_fantasy/players.csv`. Use `--output PATH.csv` for another
destination, or `--overwrite` to explicitly replace an existing output.
The source file is preserved. The script separates the first cell into
`player_name`, `team_name`, and `position`, then pairs the remaining cells with
their headers. It validates column counts before writing UTF-8 BOM CSV.

`price_million_try` stores the displayed price in millions (12.0 for ₺12.0m);
`so_percent` stores percentage points (84.7 for 84.7%). Dashes become blank
cells and zero stays zero. Other headers retain their source abbreviations in
lowercase because the copied HTML does not include tooltip definitions.
Only copied rows and visible columns are available, so one table export must
not be assumed to contain the full catalogue. Player IDs are not inferred from
names or kit/logo filenames. The assistant has not run this parser.

For paginated tables, select all desired columns using **Kolonlar**, clear
filters for a full catalogue, and keep the same columns, filters and sort order
while copying every page. Save each table's outerHTML into a separate UTF-8
file: `data/temp/tff_tables/page-01.html`, `page-02.html`, and so on. Keep only
the pages from one capture in that folder. Then run:

```powershell
python src/fetch/parse_tff_table.py data/temp/tff_tables --expected-rows 509
```

At 100 rows per page, a total of 509 means five pages of 100 plus a final page
of nine. Use the current displayed total for `--expected-rows`. The script
accepts multiple file paths as well as a folder, checks that each page has the
same columns, rejects identical repeated pages, and requires the expected total
before writing. It does not silently remove individual rows: display names are
not reliable unique IDs. A matching count cannot prove that no players were
skipped or repeated if the live ranking changed during copying.

Newly selected headers become lowercase CSV names with underscores. Their
values retain displayed units; the existing price and SO% conversions still
apply. Missing selected columns cannot be recovered from older saved HTML.
Choose a new `--output` or add `--overwrite` if `players.csv` already exists.

### Optional browser export

`src/fetch/export_tff_browser.py` opens Chromium, logs in when configured, selects
the six extra statistics columns, reads the rendered table, and clicks
**Sonraki** until it reaches the displayed player total. It uses the same CSV
parser as the local HTML exercise. Install its optional dependency once:

```powershell
python -m pip install playwright
python -m playwright install chromium
```

Then run:

```powershell
python src/fetch/export_tff_browser.py --expected-rows 509
```

For automatic login, add these two settings to the project `.env` alongside
your existing Sportmonks token. Use the email address registered with TFF,
not the display name:

```dotenv
TFF_FANTASY_EMAIL=your_account_email
TFF_FANTASY_PASSWORD='your_account_password'
```

The script reads this local file only when login is needed, fills the normal
email/password form and submits it once. Keep credentials out of Python source
and chat; `.env` is already ignored by Git. Environment variables with these
names override `.env`. Quotes enclosing an entire value are removed; `#`, `=`,
backslashes and dollar signs are literal, and inline comments are not supported.
Choose quotes that are not the first and last characters of the actual password.
Leave both settings empty or absent to sign in manually. Social sign-in accounts
without a TFF password should use that manual option.

Use the Turkish interface. The script waits up to five minutes after submitting
login and continues automatically when signed-in navigation appears. Complete
any verification or cookie overlays in the browser. Rejected credentials are not
automatically retried: correct them in the browser, or update `.env` and rerun.
It uses a fresh browser session each run and does not export passwords, login
state, traces or HTML files. Keep the browser untouched during table export.

Each complete table export creates a new
`data/raw/tff_fantasy/players_<UTC timestamp>.csv`, then rebuilds
`data/final/tff_fantasy/tff_players.csv` from that snapshot. The canonical table has
one row per current TFF player and starts with `sportmonks_player_id`, the key
to use when joining it to Sportmonks CSV tables such as `players.csv`,
`squads.csv`, and `player_match_stats.csv`. It mirrors the newest snapshot;
older timestamped files remain available as historical snapshots.

Player matching compares the normalized complete TFF label and its final word
with both Sportmonks `firstname` and `lastname` forms. This is necessary because
TFF sometimes displays a first name: its two `Yunus` rows resolve separately to
Yunus Akgün at Galatasaray and Yunus Emre Çift at Samsunspor. Every automatic
match must also belong to the TFF club after the club name is resolved through
Sportmonks `teams.csv` and `squads.csv`. Exact team names, documented sponsor
aliases, and unique team suffixes are recorded separately in `team_match_method`.
Position is retained for auditing but is not a hard filter because the sources
can classify the same player differently.

Accents are ignored (`e` and `é` are equivalent), unique name prefixes are
accepted (`Shomu` matches `Shomurodov`), and a unique one-character spelling
difference is accepted (`Jacobs` matches `Jakobs`). Each word in a compound
name is eligible, so `Salah` matches `Salah Ghaly`. Exact full/component matches
outrank prefix and one-character matches if two TFF rows would otherwise claim
the same ID. Equal-confidence duplicates remain blocked. A player ID is never
chosen by an unrestricted fuzzy-score cutoff.
If a player is missing, ambiguous, or would duplicate another ID, its
Sportmonks ID stays blank and the run writes these review files:

```text
data/temp/tff_fantasy/tff_player_match_report.csv
data/temp/tff_fantasy/tff_player_match_candidates.csv
config/tff_player_overrides.csv
```

Open the candidate report, copy the correct ID into the matching row of
`tff_player_overrides.csv`, leave unresolved IDs blank, and rerun the canonical
update without opening the browser:

```powershell
python src/fetch/update_tff_players.py --season 2026/2027
```

That command uses the newest raw `players_<timestamp>.csv`. Pass
`--snapshot PATH.csv` to select a specific capture. If a recent transfer has no
Sportmonks squad candidate, refresh the Sportmonks season CSVs first and then
rerun the updater. The canonical file is replaced atomically and exposes
`match_status`, so website/database joins can require `match_status = matched`.

The number 509 comes from the supplied screenshot; update `--expected-rows` when
the catalogue changes, or omit it to use the site's displayed total. All rows
in the current filters are exported; a fresh browser has no local saved filter
preferences. The expected count helps catch an accidentally filtered table.
The script uses the site's current page size, so it also works when that is
smaller than 100. It waits between pages, checks contiguous ranges, rejects
repeated pages, and saves only after completion. `--max-pages` defaults to 100.
Use `--output PATH.csv` to choose the destination and `--overwrite` to replace
an existing file explicitly.

This is a sequential snapshot, not an atomic snapshot of live rankings. Player
IDs are absent from the supplied markup, so a stable count does not guarantee
that live sorting did not move a player between pages. Menu and pagination
locators are based on the supplied screenshots and table HTML and have not yet
been verified against a logged-in browser. If the site changes labels or markup,
the exporter stops with an error rather than claiming an incomplete CSV is done.
The assistant has not run the exporter or installed its dependencies.

See [Playwright's Python library setup](https://playwright.dev/python/docs/library)
for browser installation details. Sportmonks remains the main data pipeline;
these optional TFF exports are separate from its CSVs and database build.

### Sportmonks utilities

```powershell
python src/fetch/sportmonks.py discover
python src/fetch/download_season.py --season 2026/2027 --refresh
python src/fetch/download_season.py --season 2026/2027 --rebuild-csv
python src/fetch/audit_season.py
python -m unittest discover -s tests -v
```

`--rebuild-csv` rebuilds flat tables from saved raw CSVs without network calls. `audit_season.py` only checks structural consistency. No automatic download, database rebuild, or analysis is scheduled. The assistant has not executed this revision or its tests.
