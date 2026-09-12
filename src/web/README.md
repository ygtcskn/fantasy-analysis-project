# Süper Lig Lab — local data explorer

For automatic data loading, run this from the project root (Python 3.10 or newer; no extra packages):

```powershell
python src/web/serve.py --season 2026/2027
```

Open **http://127.0.0.1:8000** in your browser and keep the terminal open. The website automatically reads all seven CSVs from `data/final/sportmonks/2026-2027` on each page load. After your next download finishes, reload the page or click **Refresh saved data**. You do not need to select files or edit website code. The server reads the saved files on each request, so it does not need restarting after a download. To change seasons, stop it with Ctrl+C and restart with a different `--season`. If port 8000 is busy, add `--port 8001` and open the printed URL.

This only updates the website from your saved CSVs. It does not download new Sportmonks data or run your Python analysis. Finish downloading/exporting before refreshing; files are validated together before replacing the displayed dataset. Missing files or validation errors keep the previous loaded data. All seven supported CSVs must exist for automatic loading.

The server binds only to this computer and serves an explicit list of website assets, seven core CSVs, optional `fixture_formations.csv` for team pages, and the tables `src/tables` publishes under `data/final/tables/<season>/` (as `/local-data/tables/<name>.csv`). Those tables hold the season totals, league table, leader cards, ratings and tiers; the pages are being switched over to read them instead of computing their own, one page at a time. Run `python src/run_pipeline.py --season 2026/2027` to build them - see [src/tables/README.md](../tables/README.md). It does not expose `.env`, source Python files, databases, raw exports, or directory listings. It creates no files and makes no provider calls. Stop it with Ctrl+C when finished.

You can still double-click `index.html` for manual file selection instead of starting the server. Browsers cannot automatically read arbitrary local folders from a directly opened HTML file:

1. Click **Open season CSVs**.
2. Navigate to `data/final/sportmonks/2026-2027` in this project.
3. For **Home**, select `standings.csv`, `fixtures.csv`, `teams.csv`, and `fixture_scores.csv` together (hold Ctrl while selecting). Add `player_match_stats.csv`, `players.csv`, and `squads.csv` for the player pages. All seven files can be selected together.
4. **Home** is the opening page: a wide season overview above a league points table on the left and fixtures on the right, matching the supplied layout. The panels stack on mobile. The points table uses the provider's position and points without recalculating them. If multiple competition groups exist, use the group selector. Fixtures can be browsed by matchweek, with club logos, kickoff, status, and saved scores. Only `CURRENT` score records are used; half-time and period scores are never added together. Missing scores stay blank (a dash). The page is a saved snapshot, not a live feed; times are displayed as exported.
5. Open **Player Tier List** from the sidebar. The centered table begins with **Rank, Logo, Role, Player, Tier, AVG Rating**, followed by rated matches, match records, minutes, goals, assists, xG, shots, key passes, and saves. Team names remain searchable even though clubs are represented by logos: typing `Galatasaray` shows players associated with that club in the loaded season. You can also filter by team or position. Click a player's name to open their full match history; select **Show every exported field** for all statistics from every supplied match record, including missing fields and the original provider ratings.
6. **Fikstür**, directly below **Puan Durumu** in the shared sidebar, displays the complete season without filters, matchweek selection, pagination, or a column-heading row. Each Turkish section row uses `Maç Haftası N - DD/MM`, based on that matchweek's earliest kickoff date, followed by Saat, Ev Sahibi, Skor, and Deplasman values. Home and away club names and logos link to their team pages. Missing scores stay as dashes. Fixture and standings rows alternate between purple and light purple in both site themes. Direct URL: `http://127.0.0.1:8000/index.html?view=fixtures`.
7. **Player appearances** continues to provide searchable, sortable records with its existing 40-row pages and Sportmonks ratings.

The main workspace is centered with empty side margins. Move the mouse to the left edge for a temporary navigation preview; moving away closes it. Click the menu button to lock the sidebar open, then click the same button again to close it. A sidebar locked open stays visible when the pointer moves away or the page is clicked. Escape and selecting a destination close it. The slide animation remains active, except when reduced motion is enabled in the operating system. The sidebar overlays the page and does not change its horizontal position.

The same sidebar is available on team pages. `sidebar.js` owns the shared menu and its toggle behavior. Its links return from a team page to the selected main-page view. The menu button remains visible when the sidebar is closed. Main-page view links support direct URLs, reload, and browser Back/Forward without discarding the currently loaded data during in-page navigation.

## Puan Durumu

**Puan Durumu** appears directly below **Home** in the sidebar, with a direct address of `http://127.0.0.1:8000/index.html?view=standings`. The Turkish table includes Sıra, Takım, O, G, B, M, A, Y, AV, Puan, and Son 5 maç. A narrow marker beside Sıra shows the base UEFA places: green for Champions League, blue for Europa League, and purple for Conference League. The Türkiye Kupası winner can shift the Europa and Conference places down one league position. Team names and logos link to team pages. Form badges run from oldest to newest and open the corresponding match on the team's page. The table scrolls horizontally on smaller screens.

Positions and points always use the supplied standings; the page does not recalculate the league order or infer tiebreak rules. Detailed columns prefer the provider's `details.overall_*` columns in `standings.csv`. The exporter now preserves these scalar details, including home/away details for later use. To add them to existing exports, use the documented `--rebuild-csv` command yourself; no API calls are needed.

The page also works with older exports: detailed totals fall back to completed fixtures and saved CURRENT scores for the matching season, league, stage, and group. These values have an asterisk. If results are missing, dependent totals remain unavailable rather than silently using zero; if the provider supplies a played-match count, the results must cover that count. Form always uses saved completed fixtures. Provider standings and saved fixtures may have different update times, which the page states explicitly. No datasets or analyses have been run by the assistant.

The page keeps loaded files in browser memory. It does not upload files, call Sportmonks, save JSON, or modify CSVs. With the local server, reloading automatically reads the saved CSVs again. With a directly opened HTML file, reloading clears the data and you must select files again. Selecting a new fixtures file manually starts a new dataset; select all files for the new season together when switching seasons. **Clear loaded files** only clears browser memory, never your disk; a page reload or **Refresh saved data** loads the server's files again.

The tier list has one entry per player ID, combining match records and loaded player/squad rosters. This includes roster players with no appearances; with only match CSVs, only players in those records can be listed. Club filters match any recorded membership and do not remove that player's matches at other clubs. Match records can include unused substitutes. Unrecorded games are not invented.

## Team logos

Team names and logos in the points table, fixtures, player tables, and player details link to an individual team page. Each team has a separate URL such as `team.html?id=34&name=Galatasaray`, using one shared page template. Team pages automatically load their saved CSVs through the local server. Directly opened HTML pages offer manual file selection instead. Restart an already-running server after code updates that add new assets or CSV routes.

## Team dashboard

The team page follows the supplied sketch: the starting eleven occupies the large left panel, with matchday selection above the pitch. The right column contains already played games, the next five scheduled games, and selected-match details (score above the game's best players). A full-width season leaders panel sits beneath both columns. Color accents follow the sketch; narrow screens stack the panels.

Use the matchday dropdown, previous/next buttons, or a match in either fixture list to update the lineup, score, and match leaders together. Selection defaults to the latest completed game, otherwise the earliest fixture. Each fixture has its own option, including multiple fixtures in a matchweek. The selected fixture is preserved in the URL on the local server. The played list includes all completed games, newest first, in a scrollable panel. Upcoming games are the next five from the current date in the saved schedule, excluding cancelled, postponed, and abandoned matches. Undated NS/TBA fixtures are placed last. Fewer than five games are shown if fewer are available. Times remain as exported; results show home score first, with H/A and W/D/L relative to this club.

Team pages read `fixtures.csv`, `teams.csv`, `player_match_stats.csv`, and `fixture_scores.csv`, plus optional `fixture_formations.csv`. For manual imports, select the files together. Missing scores, lineups, formations, or ratings remain visibly unavailable. Scores use only CURRENT records. Conflicting scores are not guessed. Team names and logos in the score panel link to their team pages.

The starting eleven uses only records marked as starters. The formation label comes from `fixture_formations.csv`. Exact pitch placement requires eleven unique starter slots in `formation_field` that agree with the supplied formation. If slots are missing or inconsistent, players are grouped by recorded role with a visible explanation; tactical positions are not invented. Future matches show an unavailable lineup until starter records exist.

The exporter now preserves `formation_field` and `formation_position` in `player_match_stats.csv`. To add these columns to existing exports, run this yourself from the project root:

```powershell
python src/fetch/download_season.py --season 2026/2027 --rebuild-csv
```

This rewrites the flat CSV tables from your saved raw CSVs, without Sportmonks API calls. The assistant has not run it or modified existing datasets. Once it finishes, refresh saved data. Older CSVs still work with role grouping.

The game's best players are the top three eligible Sportmonks ratings across both teams in that fixture. Season leaders are the top five mean ratings from completed matches for this club only. The minimum is three rated matches by default and is adjustable. Ratings must be 1–10; explicit zero-minute records and missing ratings are excluded. Match means are not weighted by minutes. Equal season averages are ordered by rated-match count and then name; match-rating ties are ordered by name. These are descriptive ratings, not fantasy-point predictions. The season panel does not change when selecting a different matchweek.

## Fantasy XI Builder

Player details now use the permanent fantasy pipeline. After downloading and
updating the TFF snapshot, run `python src/run_pipeline.py --season 2026/2027`,
restart the local server to load its new routes, then refresh the browser.
The panel reads `data/final/points/player_season_summary.csv`,
`data/final/points/player_match_points.csv`, and
`data/final/player_projections/<season>/player_projections.csv`.
The completion marker at `data/final/fantasy_pipeline/<season>/pipeline_status.csv`
and matching generation IDs prevent mixed builds. Missing analysis does not
prevent the core player pool from loading. Manual provider CSV imports do not
infer a fantasy season; use the local server for fantasy outputs.

Expanded rows show expected points, starting/scoring
probabilities, price, opponent, expected minutes and injury availability.
The points per match column comes from the current season's reconstructed points summary
and remains visible when a next-match projection is unavailable. Uncertain availability has blank
forecast numbers; fixture-confirmed absences show zero. The panel suppresses
projections after the round deadline or when fixture details no longer match.
The original rating column remains a descriptive Sportmonks rating.

**Fantasy XI Builder** appears in the shared sidebar. Direct URL: `http://127.0.0.1:8000/index.html?view=builder`. The editable pitch sits beside the player pool. Clicking a name expands fantasy statistics beneath that row; Match history opens the existing provider-statistics dialog. Players join by Sportmonks ID, never name. Search matches player and club names and the club selector filters the pool.

The player pool includes points per match beside Rating. Sort by either metric, always descending with missing values last. Opponents appear as club logos with a home/away marker; healthy-status and kickoff notes are hidden.

**Maç Haftası** appears under Fantezi, above Fantasy XI Builder, at `index.html?view=matchweek`. It shows saved fixtures in the current Tuesday–Monday calendar window, using Europe/Istanbul dates and kickoff times. The window updates while the page is open and when the tab becomes visible again. Empty weeks remain empty rather than jumping to a future round.

Fixtures appear on the left as Gün, Saat, Ev, Odds, Deplasman. The central odds cell contains labelled 1/X/2 probabilities: green for home win, yellow for draw, red for away win; unavailable values stay neutral. The full provider standings appear on the right without an internal scrolling area. On narrower screens, standings move below the fixtures.

Click a fixture row or activate its odds button with the keyboard to select it. The Maç Analizi panel beneath the fixtures shows the selected teams, kickoff, saved score when available, model probabilities and expected goals. Changing the model updates the selected analysis. Selection clears when the fixture leaves the displayed week; missing predictions have an explicit empty state.

The analysis shows each team's last starting XI on two mini pitches, then a team comparison. Last XI uses the latest FT fixture before the selected kickoff and the current time, conservatively allowing three hours for completion. It uses saved starter flags and formation coordinates, falling back to labelled role groups when coordinates are incomplete. It never substitutes a predicted XI or fills missing starters. The comparison includes model win/draw probabilities and expected goals, plus form, goals scored/conceded per match and clean sheets from up to five preceding completed fixtures in the loaded season. Missing scores remain unavailable; history is shown even without a forecast.

The fantasy comparison sums baseline_expected_points for the selected fixture by team and fantasy position (KL, DEF, OS, FOR), before injury and other availability adjustments. The table labels this assumption. These are totals across exported players, not the historical last XI or a claim of complete squad coverage. Each value shows available/exported player counts; partial totals are labelled and missing baselines are never zero-filled. The XI Builder's season, fixture and deadline checks still apply; individual player forecasts retain their availability adjustments. Player-point totals are independent of the match-odds model selector.

Selected-match analysis also compares the teams' current-season league ranks for goals scored, goals conceded, clean sheets, recorded yellow cards and recorded dismissals. Rankings use descending totals with shared ranks for ties, and show totals and per-match averages. This is current saved season context, not a historical pre-match snapshot. Goal rankings require complete scores for each included club. Card rankings cover observed player records only, show match coverage and the number of ranked teams, and divide by matches with card data. Missing card fields are not assumed to be zero; direct red and second-yellow dismissal count at most once per player and fixture.

The fantasy team's headline value uses at most three players with the highest positive baseline expected points for that single fixture, respecting the three-per-club cap. It lists their names and contributions. This is a club comparison without budget or formation optimization; injuries remain ignored. Position rows still show all exported players in each group, not the selected trio's breakdown. Missing forecasts leave an explicitly partial candidate pool.

The page reads `data/final/odds/predictions.csv` through the local server, separately from player projections. Choose a model to view its home-win, draw and away-win probabilities as percentages. Predictions must match the saved season, fixture ID, team orientation and kickoff, have been generated before kickoff, and contain valid probabilities summing to one. Missing or ambiguous predictions display —. Completed matches can retain their saved pre-match forecast. Weekly rollover does not run models or download data; rerun the odds analysis yourself and click Refresh saved data to load fresh outputs. Restart the local server after installing these route changes.

Dragging a player from the pool or between pitch positions shows only their club shirt with its jersey number (when available), on a transparent background with no name beneath it.

Click an empty pitch position and the recommendation table ranks every candidate for it, not just the members of one optimal XI. Each candidate is forced into the team in turn and the remaining places re-optimized, so the order is by the strength of the completed XI and "Costs N vs best XI" is the real price of preferring that player. Without a position selected the table falls back to listing the optimal remaining XI, which is useful once but does not change as you fill it: adding a player already in that XI cannot change the XI, so the list only shrinks. The 40 strongest candidates per position are evaluated; a player projected near zero cannot complete a competitive team.

After the first XI selection, the player list shrinks and a recommendation table appears beneath it. The local server lazily loads `src/xi_optimizer` and solves the remaining XI with selected players locked, the current formation, ₺100M budget, and maximum three players per club. Suggestions are members of one optimal completed XI, ordered by their individual expected points; they are not exhaustive forced-candidate alternative rankings. Empty-slot selection filters visible suggestions by position. Add buttons fill compatible empty slots without replacing locked players. Placement uses TFF fantasy roles when available.

## Themes

`styles.css` defines the light palette on bare `:root` and overrides it under
`:root[data-theme="dark"]`. Older rules write a literal `white` and pair it with
a `:root[data-theme="dark"] .thing { background: var(--surface); }` override
further down; newer ones use `var(--surface)` directly, which carries both
themes in a single declaration and cannot drift apart.

Prefer the variables — `--surface`, `--surface-raised`, `--surface-soft`,
`--field`, `--ink`, `--muted`, `--line`. Only accent colours need an explicit
dark variant, because a deep colour vanishes against a dark panel. Check any
change in both themes: a hardcoded white panel keeps light-theme text colour
rules working while the dark theme paints near-white text onto it.

## İstatistikler

`index.html?view=statistics`, below Fantasy XI Builder in the sidebar. Three
season leader cards across the top - most goals, most assists, and most fantasy
points - then a searchable player list beside the player profile.

Fantasy points earn the third card because they are the currency this project is
built around and appear nowhere else on the site; a third attacking metric would
mostly repeat the first two. That card reads the published points ledger, so it
asks you to refresh the fantasy analysis when it has not been built, while the
other two work from `player_match_stats.csv` alone.

Every figure comes from the same aggregation the tier list uses, so a player's
totals cannot disagree between the two pages. Equal values share a rank. The
list shows at most 200 rows and says so; narrow the search or the club filter to
see past that.

### Oyuncu Profili

Clicking a name in the list fills the right-hand panel with three views of that
player. A name in a leader card still opens the per-match dialog, which is what
a leaderboard click should do; the list drives the profile.

### Spider plots

The two plots at the top of the profile - **Genel Nitelikler** and **Ayrıntılı
Ölçütler** - are built in `lib/radar.js`, which holds their code, styles and
methodology: see [lib/radar.md](lib/radar.md). They have no
settings; every render uses one definition of the reference, the minute bar and
the score.

**Season totals,** full width between the radars and the timeline. Appearances,
minutes, goals, assists, shots, key passes, match rating, and the fantasy
figures where the analysis is loaded.

**Fantasy points over time.** One point per match in kickoff order, with a zero
line drawn when a player has been sent off or scored an own goal into a negative
week. Dates thin out to about eight labels so they never collide over a season.

**Sportmonks rating per match,** under the timeline. One vertical bar per
rated match, in kickoff order from left to right like the timeline, labelled
with the matchweek and the opponent with (İ)/(D) for home or away; labels thin
to about twelve and bar values hide once bars get narrow, both staying in each
bar's tooltip. Bars start at zero on the provider's 0-10 scale, so their heights
compare honestly. The
dashed line is the player's own average - the same unweighted mean of valid
ratings (1-10, not a zero-minute record) as "Maç puanı" in the season totals
and the tier list - and matches below it are drawn paler. The note gives the
highest and lowest rating and counts records without a valid rating.

**Dağılım · Emsallere Göre,** at the bottom of the profile. For each metric of
the Ayrıntılı Ölçütler wheel, the spread of the comparison players as a smooth
curve, the player's value marked on it, the peers he outperforms coloured by
percentile, and his percentile on the right - the same peers and the same
numbers as the wheel. It lives in `features/statistics/distribution.js`; see
[features/statistics/distribution.md](features/statistics/distribution.md).

All of these charts are inline SVG with no charting library, and their colours
are CSS variables so they follow the theme like everything else.

Each recommendation shows the player's decayed match rating beside its fixture difficulty and opportunity cost. Rating orders candidates that are otherwise equal but never overrides the projection, because it predicts next-match points less well than prior points do and is largely redundant with them.

A **Risk** selector sits beside the refresh button. Balanced is the pure expected-points optimum; low spreads the defence across clubs; high deliberately stacks it. Correlation cannot change a team's expected total, only the spread around it, so both figures are shown: the note reports expected points, the spread, and how many same-club goalkeeper/defender pairs produced it. Only the three named settings are accepted from the browser.

Restart `src/web/serve.py` after this update. Its Python environment needs `src/xi_optimizer/requirements.txt`. The same-origin `/local-recommendations.csv` endpoint performs on-demand, read-only optimization and returns CSV; it does not write reports or call providers. Solves are serialized with a five-second solver limit. Stale browser responses are discarded. Missing dependencies, ineligible locks, expired forecasts and infeasible teams show a status message, with a retry button. Recommendations use injury-adjusted projections even though the team comparison ignores injuries. Clearing the XI restores the full player list.

Choose among 4-4-2, 4-3-3, 4-2-3-1, 3-4-3, 3-5-2, and 5-3-2. Use **+** beside a player to place them in the first compatible empty position. To choose an exact position, click that pitch position first and then add a player. You can drag a player from the list to a position, or drag a selected player between positions to move or swap. Selecting a filled position allows replacement; its × button removes the player. **Clear team** restores an empty 4-3-3 and closes expanded player statistics.

The builder uses the broad playing positions supplied in the loaded CSVs: goalkeeper, defender, midfielder, and forward/attacker. Multi-position players can use any matching slot. Players without a supplied position can use any slot, because the site has no evidence for a stricter rule. A formation change retains compatible selections deterministically and returns selections that no longer fit to the pool. Player IDs remain unique, so the same player cannot occupy two positions.

Ratings use the same calculation as the tier list: the unweighted arithmetic mean of eligible Sportmonks match ratings, excluding ratings outside 1–10 and records explicitly showing zero minutes. Missing ratings display as a dash and do not prevent selection. The crafted XI remains only in browser memory and resets on page reload, clearing loaded data, or loading a different season. It does not modify CSVs, run analysis, calculate fantasy points, or make provider calls.

Put logos in `assets/team-logos/`, using the Sportmonks team ID as the filename: for example `2811.svg` or `2811.png` for Samsunspor. Find IDs in `teams.csv`. SVG is tried first, then PNG. Missing logos show club abbreviations. For players associated with multiple clubs, each recorded club is shown. Logos are local website assets and do not require provider API calls.

## Takım İstatistikleri

`index.html?view=team-statistics`, directly below İstatistikler in the sidebar.
The team counterpart of the player page, laid out the same way: three leader
cards, a searchable team list, and a profile of the team clicked in the list or
a card (the league leader until then).

- **Leader cards:** most goals scored, fewest conceded, and most clean sheets.
  Clean sheets carry fantasy points for goalkeepers and defenders, which is why
  they earn the third card. Goals come from the provider's standings totals,
  falling back to saved results the way Puan Durumu does; clean sheets come only
  from saved CURRENT scores, and a match whose score is missing is not counted.
- **Team list:** played, goals for and against, and points, sortable by points,
  goals scored, goals conceded (fewest first), goal difference or clean sheets.
- **Spider plots:** Genel Nitelikler and Ayrıntılı Ölçütler for teams, built in
  `lib/radar.js` with the same scoring and reference rules as the player plots,
  per match instead of per 90 - see [lib/radar.md](lib/radar.md).
- **Season totals:** position, points, played, W-D-L, goal difference, goals for
  and against, clean sheets, xG, xG conceded, average possession and shots. The
  match-statistic totals are shown only when every match supplies them.
- **Match by match, for the open team:** xG against xGA, xG form, goal minutes
  and pressure balance, each drawn for that team alone but on the league's
  scale, so the panel reads as it would beside every other team's. They come
  from `lib/team-analysis.js`; see
  [lib/team-analysis.md](lib/team-analysis.md).

- **Takım Analizi:** below the profile, charts comparing every team this season:
  fantasy points by position, luck, and ten one-point-per-team comparisons
  (attack against defence, points against expected points, goals against xG and
  more). They live in `lib/team-analysis.js` and redraw on every data refresh.

Match statistics come from `team_metrics.csv`, which the page reads on demand
through `serve.py` because older exports do not include it; without it the
cards, list and totals from standings still work, and the spider plots and the
match-by-match charts say what is missing. **Refresh saved data** re-reads it. Restart
`serve.py` once after installing this page so it serves the new files.

## Tier rules

The tier list uses the arithmetic mean of available Sportmonks match ratings, not a custom performance model. Ratings are equally weighted, not weighted by minutes. Only numeric ratings between 1 and 10 count, and records explicitly showing zero minutes are excluded from the average. Original values remain visible in full match history, including values excluded from the average. Duplicate player-match and fixture IDs are rejected on import to prevent double counting.

| Tier | Unrounded average |
| --- | --- |
| S | 8.00 or above |
| A | 7.50 to below 8.00 |
| B | 7.00 to below 7.50 |
| C | 6.50 to below 7.00 |
| D | Below 6.50 |
| Provisional | Has ratings, but fewer than the minimum rated matches |
| Unrated | No eligible rating |

The default minimum is 3 rated matches and can be changed on the page. This changes tier eligibility, not the underlying average. Players remain visible in Provisional or Unrated. These bands are site-defined display rules, not official Sportmonks tiers or fantasy predictions. They do not adjust for position, opponent, or sample uncertainty beyond the minimum-match rule. Ratings display two decimals, but boundaries use the unrounded mean.

Rank compares eligible players across the entire loaded season, ordered by unrounded average rating. Equal averages share competition ranks (1, 2, 2, 4). Filters retain those ranks. Provisional and unrated players remain at the bottom without a rank. Role is the playing position supplied in the CSVs; no tactical role is inferred.

Season summaries sum supplied count metrics only. Missing numeric values remain missing: an entirely unavailable metric displays a dash, and partial coverage displays an asterisk with a coverage tooltip. Percentages and provider ratings are not summed. xG totals prefer `xg_expected_goals` per match when present, otherwise `expected_goals`; they never sum the two feeds. Match history preserves the original fields and separate feed columns. Kickoff text retains the export's timezone convention.

## How the folder is laid out

The website is organised by feature rather than by file type, so everything one
page needs sits together and a page can be read, changed or removed without
hunting through a flat folder.

```text
src/web/
  index.html                  Main page; team.html is the club dashboard
  serve.py                    Read-only local server
  core/                       The shell every page shares
    app.js                      Loading, navigation, shared helpers
    sidebar.js                  Sidebar and theme
    kits.js                     Club colours and crests
  data/                       Everything that reads a file
    csv.js                      CSV parsing
    fantasy.js                  Published points, projections and pipeline status
  lib/                        Drawing libraries shared by more than one feature
    radar.js / radar.css        The two spider plots, players and teams
    team-analysis.js / .css     The match-by-match team charts
  features/                   One folder per page or panel
    home/  standings/  matchweek/  tier-list/  builder/
    statistics/                 Player page: list, profile, radar page, distribution
    team-statistics/            Team page: list, profile, radar page, charts page
    team-page/                  team.html
  styles/
    styles.css                  Global appearance and theme variables
    panels.css                  Shared panel, table and profile styles
  assets/                     Club logos, role icons, player portraits
```

The server serves this whole folder by file suffix - `.html`, `.js`, `.css`,
`.svg`, `.png` - so a page that gains a script needs no new route, and anything
without one of those suffixes (`serve.py`, these notes) stays unreachable.

Two rules keep it that way. A feature never reaches into another feature: what
two of them share moves to `core/`, `lib/` or `data/`. And nothing outside
`data/` fetches a file, so there is one place to look when a page shows the
wrong season.

## Domain later

`yigitcoskun.com` currently has Cloudflare nameservers. This indicates where DNS is managed, not who owns the domain or whether it has active hosting. Confirm access to the domain's account before connecting it.

This folder can later be deployed as a static website. Deploy only these website files, never the project root, `.env`, or the football dataset. The initial hosted version can retain the local file picker so each visitor's CSV files stay in their browser. No domain or hosting configuration has been changed.
