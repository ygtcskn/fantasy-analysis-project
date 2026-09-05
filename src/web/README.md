# Süper Lig Lab — local data explorer

For automatic data loading, run this from the project root (Python 3.10 or newer; no extra packages):

```powershell
python src/web/serve.py --season 2026/2027
```

Open **http://127.0.0.1:8000** in your browser and keep the terminal open. The website automatically reads all seven CSVs from `data/final/sportmonks/2026-2027` on each page load. After your next download finishes, reload the page or click **Refresh saved data**. You do not need to select files or edit website code. The server reads the saved files on each request, so it does not need restarting after a download. To change seasons, stop it with Ctrl+C and restart with a different `--season`. If port 8000 is busy, add `--port 8001` and open the printed URL.

This only updates the website from your saved CSVs. It does not download new Sportmonks data or run your Python analysis. Finish downloading/exporting before refreshing; files are validated together before replacing the displayed dataset. Missing files or validation errors keep the previous loaded data. All seven supported CSVs must exist for automatic loading.

The server binds only to this computer and serves an explicit list of website assets, seven core CSVs, and optional `fixture_formations.csv` for team pages. It does not expose `.env`, source Python files, databases, raw exports, or directory listings. It creates no files and makes no provider calls. Stop it with Ctrl+C when finished.

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

**Fantasy XI Builder** appears in the shared sidebar after **Fixture Page**. Direct URL: `http://127.0.0.1:8000/index.html?view=builder`. It uses a two-column layout: an editable pitch on the left and the full player pool on the right. The player list has exactly the requested data columns: local club logo, player name, and average rating. One row represents one player ID; a player associated with multiple clubs displays every recorded club logo. Search matches player and club names, and the club selector filters the pool.

Choose among 4-4-2, 4-3-3, 4-2-3-1, 3-4-3, 3-5-2, and 5-3-2. Click a player to place them in the first compatible empty position. To choose an exact position, click that pitch position first and then click a player. You can drag a player from the list to a position, or drag a selected player between positions to move or swap. Selecting a filled position allows replacement; its × button removes the player. **Clear team** restores an empty 4-3-3.

The builder uses the broad playing positions supplied in the loaded CSVs: goalkeeper, defender, midfielder, and forward/attacker. Multi-position players can use any matching slot. Players without a supplied position can use any slot, because the site has no evidence for a stricter rule. A formation change retains compatible selections deterministically and returns selections that no longer fit to the pool. Player IDs remain unique, so the same player cannot occupy two positions.

Ratings use the same calculation as the tier list: the unweighted arithmetic mean of eligible Sportmonks match ratings, excluding ratings outside 1–10 and records explicitly showing zero minutes. Missing ratings display as a dash and do not prevent selection. The crafted XI remains only in browser memory and resets on page reload, clearing loaded data, or loading a different season. It does not modify CSVs, run analysis, calculate fantasy points, or make provider calls.

Put logos in `assets/team-logos/`, using the Sportmonks team ID as the filename: for example `2811.svg` or `2811.png` for Samsunspor. Find IDs in `teams.csv`. SVG is tried first, then PNG. Missing logos show club abbreviations. For players associated with multiple clubs, each recorded club is shown. Logos are local website assets and do not require provider API calls.

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

Source files: `index.html` (main page), `styles.css` (shared appearance), `app.js` (main-page loading and navigation), `sidebar.js` (shared sidebar), `csv.js` (shared CSV parser), `home.js` (home standings and fixtures), `standings.js` (detailed Puan Durumu), `builder.js` and `builder.css` (Fantasy XI Builder), `tier-list.js` (tiers and match history), `team.html`, `team-page.js`, and `team-page.css` (team dashboard), and `serve.py` (local website and CSV server). The assistant prepared the code but did not execute the server, page, or tests, following the project's code-only preference.

## Domain later

`yigitcoskun.com` currently has Cloudflare nameservers. This indicates where DNS is managed, not who owns the domain or whether it has active hosting. Confirm access to the domain's account before connecting it.

This folder can later be deployed as a static website. Deploy only these website files, never the project root, `.env`, or the football dataset. The initial hosted version can retain the local file picker so each visitor's CSV files stay in their browser. No domain or hosting configuration has been changed.
