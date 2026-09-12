# Published tables

Every season total, ranking and percentile the website shows, computed here in
Python and published as CSV under `data/final/tables/<season>/`, so that the
site renders figures rather than working them out in the browser.

The pages are being switched over one at a time. A page that has been switched
reads its table from here; one that has not still computes its own figures in
JavaScript. Both produce the same numbers - the rules below are the browser's
rules, moved across unchanged - so a half-migrated site does not contradict
itself.

One module per table, so a table is one file you can read end to end:

| Module | Publishes | What it is |
| --- | --- | --- |
| `team_results.py` | `team_results.csv` | One row per team and finished match: opponent, venue, score, result. The unit the other team tables are built from, and what the form guide and the team page read. |
| `standings.py` | `standings.csv` | The league table. Points and position are the provider's; the rest prefer the provider's total and fall back to counting results. |
| `team_season.py` | `team_season.csv` | Per team: standings totals, clean sheets, and the match statistics (xG, xGA, possession, shots, corners, tackles). |
| `player_season.py` | `player_season.csv` | Per player: identity, club, role, season totals with their coverage, mean Sportmonks rating, tier, and fantasy points joined from the published ledger. |
| `player_leaders.py` | `player_leaders.csv` | The İstatistikler leader cards, ranked: goals, assists, fantasy points. |
| `team_leaders.py` | `team_leaders.csv` | The Takım İstatistikleri leader cards: goals scored, fewest conceded, clean sheets. |

`run.py` builds them all and writes `tables_status.csv` beside them, saying how
many rows each table has and which module failed, if any. A module that cannot
build - because the export lacks a file it needs - does not stop the others.

## Running it

Normally you do not: `src/run_pipeline.py` runs this as its third stage, after
the fantasy points and projections it joins.

On its own, to rebuild the tables without touching points, projections or
SQLite:

```powershell
python -m src.tables.run --season 2026/2027
```

Useful flags: `--only player_season player_leaders` to rebuild part of it, and
`--output-root` to write a copy somewhere else and compare before publishing.

## The rules these tables keep

These are the rules the pages used to apply in the browser, moved here
unchanged, so a published table says exactly what the site said before.

**Which matches count.** Only fixtures the provider marks finished (FT, AET,
FT_PEN, AWARDED, WO) with a saved CURRENT score for both sides. A fixture the
last download caught in play is left out, with its half-match statistics, until
it is downloaded again.

**A conflicting duplicate score is unknown.** Not the first one seen, and not an
average.

**A blank is not a zero.** A missing counting column is "none" only on a match
whose statistics the feed actually covered; on a match it never described, the
value stays unknown. Every player total therefore carries a `*_supplied` count -
how many of that player's match records supplied it - which is what the site
marks with an asterisk.

**A partial total is not a season total.** Team match statistics are published
only when every counted match supplies them, and a counted standings total is
published only when every finished fixture has a score and the count agrees with
the provider's matches played. Otherwise the cell is empty.

**The provider's own totals win.** Points, position, goals for and against are
taken from the standings when they are there. `derived` lists the metrics that
had to be counted instead, so the site can still mark them.

**Language belongs to the page.** Results are stored as W, D and L, roles as
`goalkeeper`/`defender`/`midfielder`/`attacker`, European places as `ucl`,
`uel`, `uecl`. The Turkish labels are the website's business.

## Ties

Where a ranking has to break a tie it does so the way the page did: equal values
share a rank, players are then ordered by minutes played, and names fall back to
Turkish alphabetical order (`common.turkish_key`), which is not what Python's
default sort gives - it would put I before ı and ignore ç, ğ, ö, ş and ü.

## Tests

`tests/test_tables.py`, synthetic data only:

```powershell
python -m unittest tests.test_tables
```
