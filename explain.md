# What the Python does, what the JavaScript does

A map of the project for when you come back to it. Written 2026-09-12; the last
section says how to tell whether it has gone stale.

## The one-line split

**Python answers questions about football. JavaScript puts answers on screen.**

Anything that adds up, averages, ranks, forecasts or decides is Python. Anything
that draws, filters, sorts or responds to a click is JavaScript.

The reason for the split is not tidiness. A calculation in Python runs once,
after a match, on your machine, where it can be tested, versioned and checked
against last week's answer. The same calculation in a browser runs again on
every page load, cannot be tested without a browser, and quietly disagrees with
itself the moment two pages implement it slightly differently.

## The chain, end to end

```
Sportmonks API
      │  src/fetch/download_season.py
      ▼
data/raw/                                  lossless capture, never edited
      │  src/fetch/export_csv.py
      ▼
data/final/sportmonks/2026-2027/*.csv      clean season files
      │
      │  src/run_pipeline.py
      │    1. src/points                   fantasy points per player-match
      │    2. src/player_projections       next matchweek forecasts
      │    3. src/tables                   season totals, league table, rankings
      │    4. src/fetch/build_database.py  SQLite
      ▼
data/final/                                the published answers
      │  src/web/serve.py                  reads files and sends them; computes nothing
      ▼
browser: src/web/**.js                     fetch → filter → draw
```

Everything above `serve.py` runs **once, when you run the pipeline after a
match**. Everything below it runs **every time a page is opened**.

## Python

| Folder | Its job |
| --- | --- |
| `src/fetch/` | Talks to Sportmonks. The only code that makes network calls. Also builds the SQLite database. |
| `src/points/` | Reconstructs TFF fantasy points for every player-match, from the rules in `config/tff_scoring_rules.csv`. |
| `src/player_projections/` | Forecasts next matchweek's points, injury-aware. `backtest.py` scores those forecasts against what actually happened. |
| `src/odds/` | Match-result probabilities. Research, not part of the per-match pipeline. |
| `src/xi_optimizer/` | Picks the best XI under the fantasy rules. Also answers the website live through `/local-recommendations.csv`. |
| `src/tables/` | Every season total, league table, leader card, rating and tier the site shows. One module per table. |
| `src/run_pipeline.py` | Runs the four stages in order and publishes nothing unless all of them succeed. |

Python also owns every judgement about missing data, and those judgements are
the reason the numbers can be trusted:

* A blank counting column is a zero only on a match whose statistics the feed
  actually covered. On a match it never described, the value stays unknown.
* A partial total is not a season total. If one counted match is missing xG,
  the season xG is empty rather than the sum of the rest.
* A conflicting duplicate score is unknown - not the first one seen, not an
  average.
* Only fixtures the provider marks finished, with a saved CURRENT score for
  both sides, count at all.

If you are ever tempted to "fill in" a missing value to make a chart look
complete, that is the rule you would be breaking.

## JavaScript

| Folder | Its job |
| --- | --- |
| `src/web/core/` | Boots the page: navigation, sidebar, theme, club colours. |
| `src/web/data/` | Fetches files and parses CSV. Nothing else is allowed to fetch. |
| `src/web/lib/` | Drawing libraries shared by more than one feature: the radar SVG, the team chart SVGs. |
| `src/web/features/` | One folder per page: build the DOM, handle clicks, search, sort, paginate, select, tooltip. |
| `src/web/styles/` | Appearance, light and dark. |

Two rules keep that structure honest:

1. A feature never reaches into another feature. What two of them share moves
   to `core/`, `lib/` or `data/`.
2. Nothing outside `data/` fetches a file, so there is one place to look when a
   page shows the wrong season.

The browser also owns state that only makes sense in a browser - what you
clicked, what is in the search box, which team is open, which page you are on.
That never needs to leave the browser and should not be written anywhere.

## The part that already works this way

The fantasy points on the site are the finished pattern. `src/points` computes
them into `data/final/points/player_match_points.csv`; `src/web/data/fantasy.js`
fetches that file; `features/statistics/statistics.js` sorts and draws it. The
browser never adds up a single point.

Everything else is being moved to look like that.

## Where it does not hold yet

`src/tables/` publishes six tables, and as of this writing **no page reads them
yet**. Until each page is switched over, these files still compute in the
browser what Python now also computes:

| Still computing in the browser | What it works out |
| --- | --- |
| `lib/radar.js` | Per-90 rates, peer percentiles, the PCA attributes |
| `lib/team-analysis.js` | xG grids, luck, goal minutes, pressure balance, comparisons |
| `features/tier-list/tier-list.js` | Every player's match rows, rating means, tiers |
| `features/statistics/statistics.js` | Leader cards, profile facts |
| `features/team-statistics/team-statistics.js` | Team season totals, clean sheets |
| `features/standings/standings.js`, `features/home/home.js` | The league table from saved scores |
| `features/matchweek/matchweek.js` | Matchweek comparisons |

Both paths give the same numbers today - the Python rules were ported from the
browser unchanged, and the leader cards, tiers and team totals were compared
against the live site and matched exactly. That agreement is a snapshot, not a
guarantee: the longer two copies of one calculation live side by side, the more
likely they are to drift.

The migration order is: switch the page to read its table, then delete the
JavaScript that used to compute it. Not one without the other.

## Deciding where new code goes

Ask what the answer depends on.

* If it depends only on saved data, it is Python. It belongs in `src/tables/`
  (or `src/points`, `src/player_projections`) and it publishes a CSV.
* If it depends on what the reader just did - a click, a search, a sort, which
  team is selected - it is JavaScript.
* If it depends on both, split it: Python publishes every value the reader
  might ask for, JavaScript picks the one to show.

Sorting a table by a different column is JavaScript. Working out what goes in
the column is Python.

## Running it

After every match:

```powershell
python src/run_pipeline.py --season 2026/2027
```

Then reload the site, or click **Refresh saved data**.

Serving the site:

```powershell
python src/web/serve.py --season 2026/2027
```

Tables on their own, without touching points, projections or SQLite:

```powershell
python -m src.tables.run --season 2026/2027
```

Tests:

```powershell
python -m unittest discover -s tests
node --test tests/test_radar.cjs tests/test_team_analysis.cjs tests/test_distribution.cjs
```

## Is this document still true?

Three checks, cheapest first.

**Has the migration moved on?** If a page has been switched, its feature reads
its table directly. Search for it:

```powershell
Select-String -Path src/web -Pattern "local-data/tables" -Recurse
```

Every hit is a page that is no longer computing its own figures, and its row in
"Where it does not hold yet" above is out of date.

**Are there new tables?** `src/tables/run.py` lists every module it builds, and
`data/final/tables/<season>/tables_status.csv` records what the last run wrote.
Either is more current than this file.

**Has the folder structure changed?** `src/web/README.md` holds the layout of
the website and `src/tables/README.md` holds the table-by-table list. If they
disagree with this file, they are the ones kept next to the code, so trust them.
