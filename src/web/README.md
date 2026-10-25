# Fantezi Analiz — local data explorer

## Maç Tribünü

The sidebar's **Sosyal → Maç Tribünü** page (`index.html?view=social`) groups
saved fixtures by matchweek. Blue match headers contain a **Konu aç** control;
rose topic rows expand to show the discussion and a reply form. The page supports
dark mode and narrow screens. It uses the existing loaded fixtures and teams.

Topics and replies live in Supabase, in `match_topics` and `match_replies`
(`supabase/match_discussions.sql`, run after `profiles.sql`), keyed by
Sportmonks fixture ID and season. Anyone can read them. Posting needs a
signed-in visitor with a nickname: "+ Konu aç" or "Yanıt yaz" opens the
sign-in dialog, then the profile, whichever is missing. The database fills in
the author from the session and the profile, so a post cannot be signed as
someone else; a later nickname or club change shows on earlier posts too.
Authors can delete their own posts ("Sil"; a topic takes its replies with it),
nobody can edit, and the database allows five posts a minute per person.
Moderation is deleting rows in Supabase → Table Editor. New posts by others
appear on refresh (↻) or when the week changes; unsent drafts survive redraws
on the open page only. The implementation lives in `features/social/`.

## Kadrolar

The sidebar's **Sosyal → Kadrolar** page (`index.html?view=squads`), below
Maç Tribünü, lists the fantasy squads visitors have shared. Each matchweek is a
purple bar, newest first: the current week always (the same week Ana Sayfa and
Maç Tribünü open on, `currentRoundIndex` in `core/match-rules.js`), then every
earlier or later week someone shared a squad for. Under each bar, three cards
to a row (two, then one, on narrower screens) show the sharer's profile photo
(or the nickname's first letter, as everywhere a person appears), nickname, share
date in Turkish time and the eleven's expected fantasy points, highest first.
A total that left out an eleven without a current projection carries a `*`, as
on Kadro Kur.

Beside it, **Gerçekleşen FP** is what the eleven actually scored that week:
each starter's points (`points_total` in `points/player_match_points.csv`) in
the week's finished matches, with "4 / 9 maç" for how much of the week that
covers. It grows as each match ends and the site's data is refreshed by the
download and pipeline run. Only the eleven score, with no captain and no bench
substitutions, the same reading as Kadro Kur's summary; a starter whose club
has played without him scores 0. The squad's page shows the same total and each
starter's points under his rating. The author's own squads carry **Sil**, on
the card and on the squad's page; the database lets nobody else delete them.

Each card opens that squad's own page, `index.html?view=squads&squad=<id>`
(`features/squads/squad-detail.js`), which the browser's back button and a
shared link both reach. It shows the sharer, the week and the save time, then
the eleven in its formation and the bench on the site's one pitch (shirt, name,
season rating, as on Kadro Kur), with the budget, and beside it Kadro Kur's
**Kadro beklentisi** and **Takımlara göre**. The expectation is the one saved
with the squad, because the projections behind it are replaced after the week's
deadline; players are looked up by Sportmonks ID in the season files, so one who
has since left the league still shows. "← Tüm kadrolar" and the sidebar return
to the week list.

Squads are saved with **Kadroyu kaydet** under Kadro Kur's bench
(`features/builder/save.js`), for the first matchweek whose fantasy deadline
(one hour before its first kickoff, `fantasyDeadline` in `data/fantasy.js`) is
still ahead; the line under the button names that week and its deadline. Saving
needs a full eleven, a signed-in visitor and a nickname: a visitor who is not
signed in gets the sign-in dialog, and the squad on the pitch is kept for that
tab (`sessionStorage`), so a Google sign-in, which leaves the page, comes back to
it. Saving again for the same week replaces that week's squad.

Squads live in Supabase, in `shared_squads` (`supabase/shared_squads.sql`, run
after `profiles.sql`), one per visitor per week, keyed by season and Sportmonks
round ID; each holds the formation, the eleven (goalkeeper first) and bench as
Sportmonks player IDs, and, as they stood when saved, the eleven's expected
points, goals, assists, cards and minutes, the bench's expected points, how many
of the eleven had a projection and the fifteen's price. Columns added since the
table was first made are added by running the file again; a squad saved before
then shows "—" for them until it is saved again. Anyone can read them. The database fills in the author from
the session and the profile, as for Maç Tribünü, and keeps a squad in its week.
It knows no kickoffs, so the deadline is the page's rule only. The page lives in
`features/squads/`.

Every view, including individual team pages, uses the shared light-purple banner in
`styles/page-header.css`. It contains the page title, season/context and description,
and stays light purple in dark mode. Load this stylesheet after `theme-dark.css`.

For automatic data loading, run this from the project root (Python 3.10 or newer; no extra packages):

```powershell
python src/web/serve.py --season 2026/2027
```

Open **http://127.0.0.1:8000** in your browser and keep the terminal open. The website automatically reads all seven CSVs from `data/final/sportmonks/2026-2027` on each page load. After your next download finishes, reload the page or click **Refresh saved data**. You do not need to select files or edit website code. The server reads the saved files on each request, so it does not need restarting after a download. To change seasons, stop it with Ctrl+C and restart with a different `--season`. If port 8000 is busy, add `--port 8001` and open the printed URL.

The main dataset loads from your saved CSVs and does not run your Python analysis. Maç Haftası additionally requests live Sportmonks data while visible, as described below. Finish downloading/exporting before refreshing; files are validated together before replacing the displayed dataset. Missing files or validation errors keep the previous loaded data. All seven supported CSVs must exist for automatic loading.

The server binds only to this computer and serves allowed website assets, seven core CSVs, and optional `fixture_formations.csv` for team pages. It does not expose `.env`, source Python files, databases, raw exports, or directory listings. It creates no files. Only `/local-live.csv` requests provider data. Stop it with Ctrl+C when finished.

## Live match centre

On **Maç Haftası**, **Canlı Maç Merkezi** sits below the purple header and above
the prediction/standings layout. It appears for in-progress matches in the served
season and disappears after a successful update reports none. A visible header
dropdown lists the live games with team names and scores, alongside the match
count. It stays visible with one game and preserves the selected match during
updates, switching to an available game if that match ends.
The scoreboard shows CURRENT scores and provider minutes;
statistics compare possession, shots, corners, dangerous attacks, fouls and cards.
Events show goals, substitutions, cards and VAR information, newest first. Missing
statistics stay as dashes; a connection failure hides the old scores and statistics
and displays an unavailable notice. Confirmed results update the Matchweek display
in memory; saved predictions and CSV files are never overwritten.

Restart the local server after installing this change, then refresh the browser.
The server uses the existing local `SPORTMONKS_API_TOKEN` from the environment or
project `.env`; the token needs access to the league's live data. It never goes to
the browser or logs. No widget subscription or embed snippet is used: this is a
native panel powered by the [Sportmonks in-play endpoint](https://docs.sportmonks.com/v3/endpoints-and-entities/endpoints/livescores/get-inplay-livescores).
Available statistics/events depend on Sportmonks coverage and subscription access.

The visible page polls every 30 seconds during games and every 60 seconds when
none are live. It pauses when hidden or when another view is selected. The server
shares a locked CSV snapshot across tabs, backs off for at least 120 seconds after
errors, and honors longer `Retry-After` delays. A HEAD request makes no API call.
The league/season pair must be unambiguous in `fixtures.csv`; returned fixtures are
checked against both IDs. Scheduled/finished games are excluded from the live panel.
When a previously observed live fixture disappears, the server uses one bounded
[fixture-by-IDs request](https://docs.sportmonks.com/v3/endpoints-and-entities/endpoints/fixtures/get-fixtures-by-multiple-ids)
to confirm its state and retrieve final statistics and lineups. Absence from the
live feed alone never implies full time. Confirmed FT/AET/FT_PEN snapshots remain
available in a CSV memory cache for seven days; interrupted or cancelled games do
not become results. Provider JSON is decoded only in memory, converted to flat CSV
for the browser, and discarded. Nothing is saved to disk.

To keep the server entirely offline, add `--no-live` to the startup command.
Direct file opening and manually loaded datasets do not activate the live feed.
Offline regression cases are in `tests/test_live.py`; run them yourself with
`python -m unittest discover -s tests -p test_live.py`. They mock all provider calls.
Finished-result display and identity regressions can be run separately with
`node --test tests/test_matchweek_results.js`; they use only Node's built-in modules.

You can still double-click `index.html` for manual file selection instead of starting the server. Browsers cannot automatically read arbitrary local folders from a directly opened HTML file:

1. Click **Open season CSVs**.
2. Navigate to `data/final/sportmonks/2026-2027` in this project.
3. For **Home**, select `standings.csv`, `fixtures.csv`, `teams.csv`, and `fixture_scores.csv` together (hold Ctrl while selecting). Add `player_match_stats.csv`, `players.csv`, and `squads.csv` for the player pages. All seven files can be selected together.
4. **Home** is the opening page: a wide season overview above a league points table on the left and fixtures on the right, matching the supplied layout. The panels stack on mobile. The points table uses the provider's position and points without recalculating them. If multiple competition groups exist, use the group selector. Fixtures can be browsed by matchweek, with club logos, kickoff, status, and saved scores. Only `CURRENT` score records are used; half-time and period scores are never added together. Missing scores stay blank (a dash). The page is a saved snapshot, not a live feed; times are shown in Turkish time.
5. Open **Player Tier List** from the sidebar. The centered table begins with **Sıra, Logo, Mevki, Oyuncu, Kademe, Ort. Reyting**, followed by rated matches, matches played, minutes, goals, assists, xG, shots, key passes, and saves. Team names remain searchable even though clubs are represented by logos: typing `Galatasaray` shows players associated with that club in the loaded season. You can also filter by team or position. Click a player's name to open their full match history; select **Show every exported field** for all statistics from every supplied match record, including missing fields and the original provider ratings.
6. **Fikstür**, directly below **Puan Durumu** in the shared sidebar, displays the complete season without filters, matchweek selection, pagination, or a column-heading row. Each Turkish section row uses `Maç Haftası N - DD/MM`, based on that matchweek's earliest kickoff date, followed by Saat, Ev Sahibi, Skor, and Deplasman values. Home and away club names and logos link to their team pages. Missing scores stay as dashes. Fixture and standings rows alternate between purple and light purple in dark mode. Direct URL: `http://127.0.0.1:8000/index.html?view=fixtures`.
7. **Player appearances** continues to provide searchable, sortable records with its existing 40-row pages and Sportmonks ratings.

The main workspace is centered with empty side margins. Move the mouse to the left edge for a temporary navigation preview; moving away closes it. Click the menu button to lock the sidebar open, then click the same button again to close it. A sidebar locked open stays visible when the pointer moves away or the page is clicked. Escape and selecting a destination close it. The slide animation remains active, except when reduced motion is enabled in the operating system. The sidebar overlays the page and does not change its horizontal position.

The same sidebar is available on team pages. `sidebar.js` owns the shared menu and its toggle behavior. Its links return from a team page to the selected main-page view. The menu button remains visible when the sidebar is closed. Main-page view links support direct URLs, reload, and browser Back/Forward without discarding the currently loaded data during in-page navigation.

## Puan Durumu

**Puan Durumu** appears directly below **Home** in the sidebar, with a direct address of `http://127.0.0.1:8000/index.html?view=standings`. The Turkish table includes Sıra, Takım, O, G, B, M, A, Y, AV, Puan, and Son 5 maç. A narrow marker beside Sıra shows the base UEFA places: green for Champions League, blue for Europa League, and purple for Conference League. The Türkiye Kupası winner can shift the Europa and Conference places down one league position. Team names and logos link to team pages. Form badges run from oldest to newest and open the corresponding match on the team's page. The table scrolls horizontally on smaller screens.

Positions and points always use the supplied standings; the page does not recalculate the league order or infer tiebreak rules. Detailed columns prefer the provider's `details.overall_*` columns in `standings.csv`. The exporter now preserves these scalar details, including home/away details for later use. To add them to existing exports, use the documented `--rebuild-csv` command yourself; no API calls are needed.

The page also works with older exports: detailed totals fall back to completed fixtures and saved CURRENT scores for the matching season, league, stage, and group. These values have an asterisk. If results are missing, dependent totals remain unavailable rather than silently using zero; if the provider supplies a played-match count, the results must cover that count. Form always uses saved completed fixtures. Provider standings and saved fixtures may have different update times, which the page states explicitly. No datasets or analyses have been run by the assistant.

The page keeps loaded files in browser memory. It does not upload files, call Sportmonks, save JSON, or modify CSVs. With the local server, reloading automatically reads the saved CSVs again. With a directly opened HTML file, reloading clears the data and you must select files again. Selecting a new fixtures file manually starts a new dataset; select all files for the new season together when switching seasons. **Clear loaded files** only clears browser memory, never your disk; a page reload or **Refresh saved data** loads the server's files again.

The tier list has one entry per player ID, combining match records and loaded player/squad rosters. This includes roster players with no appearances; with only match CSVs, only players in those records can be listed. Club filters match any recorded membership and do not remove that player's matches at other clubs. A match counts only if the fixture finished and the player was on the pitch; unused substitutes are squad records, not matches (see [Site-wide rules](#site-wide-rules)). Unrecorded games are not invented.

## Team logos

Team names and logos in the points table, fixtures, player tables, and player details link to an individual team page. Each team has a separate URL such as `team.html?id=34&name=Galatasaray`, using one shared page template. Team pages automatically load their saved CSVs through the local server. Directly opened HTML pages offer manual file selection instead. Restart an already-running server after code updates that add new assets or CSV routes.

## Team dashboard

The team page follows the supplied sketch: the starting eleven occupies the large left panel, with matchday selection above the pitch. The right column contains already played games, the next five scheduled games, and selected-match details (score above the game's best players). A full-width season leaders panel sits beneath both columns. Color accents follow the sketch; narrow screens stack the panels.

Use the matchday dropdown, previous/next buttons, or a match in either fixture list to update the lineup, score, and match leaders together. Selection defaults to the latest completed game, otherwise the earliest fixture. Each fixture has its own option, including multiple fixtures in a matchweek. The selected fixture is preserved in the URL on the local server. The played list includes all completed games, newest first, in a scrollable panel. Upcoming games are the next five from the current date in the saved schedule, excluding cancelled, postponed, and abandoned matches. Undated NS/TBA fixtures are placed last. Fewer than five games are shown if fewer are available. Times are in Turkish time; results show home score first, with İ/D and G/B/M relative to this club.

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
Uncertain availability has blank
forecast numbers; fixture-confirmed absences show zero. The panel suppresses
projections after the round deadline or when fixture details no longer match.
The original rating column remains a descriptive Sportmonks rating.

**Fantasy XI Builder** appears in the shared sidebar. Direct URL: `http://127.0.0.1:8000/index.html?view=builder`. The editable pitch sits beside the player pool. Clicking a name expands fantasy statistics beneath that row; Match history opens the existing provider-statistics dialog. Players join by Sportmonks ID, never name. Search matches player and club names and the club selector filters the pool.

The player pool lists only players in a club's current Sportmonks squad (`current_squads.csv`), so players who left after appearing this season cannot be selected. The same rule drops them from Oyuncu Listesi and Oyuncu İstatistikleri (leader cards, player list, profile and the current-season radar peers); their rows stay only in past match records, lineups and the match-history dialog. An export without that file, or missing a club, shows the whole season squad. The pool shows Rating (the player's Sportmonks match-rating average) and Beklenen FP (next-match expected fantasy points from the published projection, under the same deadline and availability checks as the player's details). Sort by either, always descending with missing values last. The recommendation table shows Fiyat, SO% (TFF's selection rate, joined by reviewed Sportmonks ID; the server must be restarted after updating) and Beklenen FP. A successful load or solve shows no note; only problems are explained. Opponents appear as club logos with a home/away marker; healthy-status and kickoff notes are hidden.

**Maç Haftası** appears under Fantezi, above Fantasy XI Builder, at `index.html?view=matchweek`. It shows saved fixtures in the current Tuesday–Monday calendar window, using Europe/Istanbul dates and kickoff times. The window updates while the page is open and when the tab becomes visible again. Empty weeks remain empty rather than jumping to a future round.

Fixtures appear on the left as Gün, Saat, Ev, Tahmin / Sonuç, Deplasman. The central cell shows final CURRENT scores for finished matches (FT/AET/FT_PEN, including numeric states 5/7/8); other games show labelled 1/X/2 probabilities. Missing scores stay as dashes. Finished games do not trigger missing-prediction warnings. The full provider standings appear on the right without an internal scrolling area. On narrower screens, standings move below the fixtures.

Click a fixture row or activate its score/odds button with the keyboard to select it. For finished games, the panel is titled **Maç Sonucu ve İstatistikleri** and shows that game's final score, team match statistics, actual starting XI, fantasy player points and saved league context. Previously saved results use `team_metrics.csv` and `player_match_stats.csv`; live-to-finished transitions use the confirmed provider snapshot. Missing player or team data remains unavailable, with no substitute lineup from another match. Pre-match probabilities and future player projections are not presented as post-match statistics. Other games retain the existing Maç Analizi preview. Selection stays on the same fixture when it finishes and clears when it leaves the displayed week.

**Fantezi Lig · Oyuncu Puanları** lists each team's players by descending match-specific `points_total` from the validated `points/player_match_points.csv` snapshot. These totals already include bonuses. Matching requires the season, fixture, Sportmonks player ID, team and opponent; ambiguous or unavailable totals remain dashes. Zero and negative points are preserved. Sportmonks ratings are not used as fantasy points. A newly finished game's fantasy totals appear after the user publishes fresh scoring outputs and refreshes the page; the website does not run scoring itself.

The pre-match analysis shows each team's last starting XI on two mini pitches, then a team comparison. Last XI uses the latest finished fixture before the selected kickoff and the current time, conservatively allowing three hours for completion. It uses saved starter flags and formation coordinates, falling back to labelled role groups when coordinates are incomplete. It never substitutes a predicted XI or fills missing starters. The comparison includes model win/draw probabilities and expected goals, plus form, goals scored/conceded per match and clean sheets from up to five preceding completed fixtures in the loaded season. Missing scores remain unavailable; history is shown even without a forecast.

The fantasy comparison sums the same `expected_points` Kadro Kur shows for the selected fixture, by team and fantasy position (KL, DEF, OS, FOR): availability applies, a confirmed absence counts zero and an uncertain one shows no forecast. The notes say so. These are totals across exported players, not the historical last XI or a claim of complete squad coverage. Each value shows available/exported player counts; partial totals are labelled and missing baselines are never zero-filled. The XI Builder's season, fixture and deadline checks still apply; individual player forecasts retain their availability adjustments. Player-point totals are independent of the match-odds model selector.

Selected-match analysis also compares the teams' current-season league ranks for goals scored, goals conceded, clean sheets, recorded yellow cards and recorded dismissals. Rankings use descending totals with shared ranks for ties, and show totals and per-match averages. This is current saved season context, not a historical pre-match snapshot. Goal rankings require complete scores for each included club. Card rankings cover observed player records only, show match coverage and the number of ranked teams, and divide by matches with card data. A blank card field is zero on a match the statistics feed covered and unknown elsewhere, the site-wide rule; direct red and second-yellow dismissal count at most once per player and fixture.

The fantasy team's headline value uses at most three players with the highest positive expected points for that single fixture, respecting the three-per-club cap. It lists their names and contributions. This is a club comparison without budget or formation optimization. Position rows still show all exported players in each group, not the selected trio's breakdown. Missing forecasts leave an explicitly partial candidate pool.

The page reads `data/final/odds/predictions.csv` through the local server, separately from player projections. Choose a model to view its home-win, draw and away-win probabilities as percentages. Predictions must match the saved season, fixture ID, team orientation and kickoff, have been generated before kickoff, and contain valid probabilities summing to one. Missing or ambiguous predictions display —. Completed matches show their result; any saved pre-match forecasts remain unchanged on disk. Weekly rollover does not run models or download data; rerun the odds analysis yourself and click Refresh saved data to load fresh outputs. Restart the local server after installing these route changes.

Dragging a player from the pool or between pitch positions shows only their club shirt with its jersey number (when available), on a transparent background with no name beneath it.

Click an empty pitch position and the recommendation table ranks every candidate for it, not just the members of one optimal XI. Each candidate is forced into the team in turn and the remaining places re-optimized, so the order is by the strength of the completed XI and "Costs N vs best XI" is the real price of preferring that player. Without a position selected the table falls back to listing the optimal remaining XI, which is useful once but does not change as you fill it: adding a player already in that XI cannot change the XI, so the list only shrinks. The 40 strongest candidates per position are evaluated; a player projected near zero cannot complete a competitive team.

After the first XI selection, the player list shrinks and a recommendation table appears beneath it. The local server lazily loads `src/xi_optimizer` and solves the remaining XI with selected players locked, the current formation, ₺100M budget, and maximum three players per club. Suggestions are members of one optimal completed XI, ordered by their individual expected points; they are not exhaustive forced-candidate alternative rankings. Empty-slot selection filters visible suggestions by position. Add buttons fill compatible empty slots without replacing locked players. Placement uses TFF fantasy roles when available.

## Squad substitutes

Kadro Kur includes four unrestricted substitute slots beneath the pitch. They
support selection, removal and drag/swap with compatible starting positions, and
stay on the bench when the formation changes. All selected players share the
₺100M budget and three-per-club cap; unknown prices prevent a new selection.
The displayed spend uses the published projection prices, including sidelined
players. A substitute can be unavailable without blocking starting-XI suggestions.

## Squad expectation

A full-width **Kadro beklentisi** panel beneath the pitch and player pool sums
the starting XI's next-match projections: expected points, goals, assists,
yellow cards, red cards (a second yellow counts as a dismissal) and minutes.
Substitutes do not score, so their expected points are shown separately. Totals
use the same current-projection and deadline checks as a player's details: a
player without a current forecast, or whose forecast is suppressed for an
uncertain absence, is left out and the total is starred as partial. Confirmed
absences count as zero. Card totals need `expected_yellow_cards` and
`expected_red_cards`, which older projection files lack; they show a dash until
the projections are rebuilt. Below the totals, **Takımlara göre** lists each
club in the 15-player squad with its logo and player count, using the same club
the three-per-club rule counts.

Recommendations optimize only the starting XI. Selected bench players are removed
from its candidate pool; their reviewed TFF prices and club counts reduce the
available budget and club capacity on the server. Empty bench places reserve no
money, and bench players contribute no points to the starting-XI estimate. Select
bench players from the player list. Restart the local server after this update.

Regression checks (user-run): `node --test tests/test_builder_bench.cjs`, plus
`tests/test_xi_recommendations.py` and `tests/test_xi_optimizer.py` with unittest.

## Appearance

The website uses dark mode only. Both HTML entry points set data-theme to dark
before rendering, independently of old saved preferences. The sidebar has no
theme selector or personal-explorer note. The shared page banner stays light purple.

Use the existing CSS variables for surfaces, fields, text and borders. Dark styling
lives in styles/theme-dark.css, loaded before the shared page-header stylesheet.

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

Clicking a name in the list fills the right-hand panel with that player - the
primary. Clicking a second name compares the two: the secondary is drawn in a
sky blue beside the primary's colour on both radars, the season totals, the
fantasy timeline, the rating bars (side by side in each round) and the
distribution (a second marker on the primary's curves). The header shows one
name chip per player, each starting with his colour, and every chart title
carries the same swatches as a legend. A third pick replaces the secondary;
clicking the secondary again, or its ×, removes him; clicking the primary
hands the primary role to the secondary. Compared, the match charts' columns
are rounds, with each player's opponent under the column in his colour. A name
in a leader card still opens the per-match dialog, which is what a leaderboard
click should do; the list drives the profile.

### Spider plots

The two plots at the top of the profile - **Genel Nitelikler** and **Ayrıntılı
Ölçütler** - are built in `lib/radar.js`, which holds their code, styles and
methodology: see [lib/radar.md](lib/radar.md). They have no
settings; every render uses one definition of the reference, the minute bar and
the score.

**Season totals,** full width between the radars and the timeline. Appearances,
minutes, goals, assists, shots, key passes, match rating, and the fantasy
figures where the analysis is loaded.

**Fantasy points over time.** One point per match, in the same columns and on
the same frame as the rating bars below (matchweek and opponent labels), with a
zero line drawn when a player has been sent off or scored an own goal into a
negative week, and the player's average as a dashed line.

**Sportmonks rating per match,** under the timeline. One vertical bar per
rated match, in kickoff order from left to right like the timeline, labelled
with the matchweek and the opponent with (İ)/(D) for home or away; labels thin
to about twelve and bar values hide once bars get narrow, both staying in each
bar's tooltip. Bars start at zero on the provider's 0-10 scale, so their heights
compare honestly. The
dashed line is the player's own average - the same unweighted mean of valid
ratings (1-10, not a zero-minute record) as "Reyting" in the season totals
and the tier list - and matches below it are drawn paler. The note gives the
highest and lowest rating and counts records without a valid rating.

**Dağılım · Emsallere Göre,** under the profile, full width. For each metric of
the Ayrıntılı Ölçütler wheel, the spread of the comparison players as a smooth
curve, the player's value marked on it, the peers he outperforms coloured by
percentile, and his percentile on the right - the same peers and the same
numbers as the wheel. It lives in `features/statistics/distribution.js`; see
[features/statistics/distribution.md](features/statistics/distribution.md).
It shares the full-width **Dağılım ve Sıralama** section with a ranking table:
clicking a metric's name ranks this season's players best to worst on it, by
the chart's own value and percentile, and the role buttons in the section's
header choose the comparison group for both (the primary's own by default).

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

`index.html?view=team-statistics`, directly below Oyuncu İstatistikleri in the
sidebar. The page starts with Takım Analizi, followed by a searchable team list
and a profile of the team clicked in the list or a chart (the league leader
until then).

- **Team list:** played, goals for and against, and points, sortable by points,
  goals scored, goals conceded (fewest first), goal difference or clean sheets.
  Sorting by goal difference (AV) or clean sheets (GY) adds that figure as a
  last column, so the order can be read.
- **Oyuncu Listesi:** below the team list, the Oyuncu İstatistikleri player
  list - same rows, search, role buttons, sorting and styles - for the open team
  only, with figures from that team's matches: rating (the tier list's average),
  fantasy points per match from the published ledger, goals and assists. A
  blank goal or assist on a match with statistics counts as none, as on the
  spider plots; a total with an uncovered match carries an asterisk. A name
  opens that player's matches. Players who have left the league's squads are
  left out, as on every player list, and the note says how many. The code is in
  `features/team-statistics/team-players.js`.
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

- **Takım Analizi:** at the top, with a left tab for each chart comparing every
  team this season: fantasy points by position, luck, and ten one-point-per-team
  comparisons (attack against defence, points against expected points, goals
  against xG and more). One chart is shown at a time. They live in
  `lib/team-analysis.js` and redraw on every data refresh.

Team facts and match-by-match charts read `team_metrics.csv`. Both team and
player spider plots read prepared `data/final/spider/<season>/spider_stats.csv`
files; build them from saved player and team statistics with
`python -m src.spider.build_spider_stats --all-seasons`, or let the next
`src/run_pipeline.py` run refresh all saved seasons. See
[lib/radar.md](lib/radar.md) for the source and missing-value rules. **Refresh
saved data** re-reads the published CSVs. Restart `serve.py` once after
installing the new route.

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

Rank compares eligible players across the entire loaded season, ordered by unrounded average rating. Equal averages share competition ranks (1, 2, 2, 4). Filters retain those ranks. Provisional and unrated players remain at the bottom without a rank. Mevki is the player's one role, the same on every page: the position he has played the most minutes in this season, else his squad position. Only Kadro Kur uses the TFF game's own position.

Season summaries sum count metrics over the player's appearances. Sportmonks writes no zeros, so a blank count on a match the statistics feed covered is none; on an uncovered match it is unknown, and a total resting on one shows an asterisk with a coverage tooltip. An entirely unavailable metric displays a dash. Percentages and provider ratings are not summed. xG totals prefer `xg_expected_goals` per match when present, otherwise `expected_goals`; they never sum the two feeds. Match history shows the same counts the totals add up and keeps the separate feed columns. Times are shown in Turkish time.

## Site-wide rules

Every page follows one set of rules, so a number reads the same wherever it appears:

- **Finished match** - `FT`, `AET`, `FT_PEN`, `AWARDED` or `WO` (`core/match-rules.js`; the pipeline's copy is `FINISHED_STATES` in `src/shared.py`). Fantasy points and the models use the narrower played list, `FT`, `AET` or `FT_PEN`: an awarded result has a score but no match behind it.
- **Appearance ("Maç")** - a finished match the player was on the pitch for (`minutes_played` > 0), the fantasy ledger's rule. Unused substitutes do not count.
- **Blanks** - Sportmonks leaves zeros blank. A blank count on a covered match (any of touches, passes, total duels, shots, fouls, possession lost recorded) is zero; elsewhere it is unknown and totals show an asterisk.
- **Names** - one name per player ID on every page, from his Sportmonks profile (`profileName` in `core/match-rules.js`): match rows, the ledger, projections, the optimizer and the live feed are looked up by ID rather than shown as sent, because each keeps the spelling of the day it was captured. A multi-word `display_name` sharing no word with the player's own names is a provider error (Stefan Savić's profile reads "André Hainault") and is replaced by his registered name.
- **Players who left the league** - anyone missing from `current_squads.csv` is left out of every player list, leader card, best-player list and the team page's season leaders, which say how many were left out.
- **Cards** - team card totals come from the team statistics (`team_metrics.csv`) everywhere: the match result table, the live centre and Maç Haftası's season ranks. Sportmonks counts a second yellow as a yellow card there, and any dismissal as a red card. Fantasy points still score each player's own card columns.
- **Times** - kickoffs and dates are shown in Turkish time (`Europe/Istanbul`), from `starting_at_timestamp` or the UTC kickoff (`core/locale.js`). Every time the pipeline saves is UTC, written as `2026-10-25T18:30:00Z` (`utc_stamp` in `src/shared.py`).
- **Words** - *Reyting* is Sportmonks' match rating, *Puan* is league points, *Fantezi puanı (FP)* is TFF fantasy points; *İ/D* is home/away; positions are always Turkish (Kaleci, Defans, Orta saha, Forvet); shares are written %55.
- **Pitch** - Kadro Kur, Maç Haftası's elevens and the team page draw one pitch (`styles/pitch.css`): Kadro Kur's grass and lines, club shirts from `core/kits.js` and the same rating badge.
- **Colours** - win, draw and loss use one palette (`--result-win/draw/loss`) for chips, charts and the live table; anything that compares clubs uses each club's colour from `core/team-colors.js`.

## How the folder is laid out

The website is organised by feature rather than by file type, so everything one
page needs sits together and a page can be read, changed or removed without
hunting through a flat folder.

```text
src/web/
  index.html                  Main page; team.html is the club dashboard
  404.html                    The public site's missing-page answer
  serve.py                    Read-only local server
  build_static.py             Writes the public site to data/temp/site
  core/                       The shell every page shares
    site.js                     siteMode: local server, public site or opened from disk
    auth.js / auth-config.js    Optional visitor sign-in (Supabase) and its project settings
    app.js                      Loading, navigation, shared helpers
    locale.js                   Turkish words, Turkish-time dates, positions, percentages
    match-rules.js              Finished match, appearance, blank and rating rules
    sidebar.js                  Sidebar navigation
    kits.js                     Club shirts
    team-colors.js              Each club's own colour for charts and comparisons
  data/                       Everything that reads a file
    csv.js                      CSV parsing
    fantasy.js                  Published points, projections and pipeline status
  lib/                        Drawing libraries shared by more than one feature
    radar.js / radar.css        The two spider plots, players and teams
    team-analysis.js / .css     The match-by-match team charts
  features/                   One folder per page or panel
    home/  standings/  matchweek/  tier-list/  builder/  social/  squads/
    statistics/                 Player page: list, profile, radar page, distribution
    team-statistics/            Team page: list, players, profile, radar page, charts page
    team-page/                  team.html
  styles/
    styles.css                  Global appearance and theme variables
    panels.css                  Shared panel, table and profile styles
    pitch.css                   The one pitch: grass, lines, shirts, rating badge
    theme-dark.css              Every dark rule: tokens, then shared panels, headings and zebra tables
  assets/                     Club logos, role icons, player portraits
```

The server serves this whole folder by file suffix - `.html`, `.js`, `.css`,
`.svg`, `.png` - so a page that gains a script needs no new route, and anything
without one of those suffixes (`serve.py`, these notes) stays unreachable.

Two rules keep it that way. A feature never reaches into another feature: what
two of them share moves to `core/`, `lib/` or `data/`. And nothing outside
`data/` fetches a file, so there is one place to look when a page shows the
wrong season.

## Sign-in

Every page is open to everyone; signing in only gives a visitor an account
that later features can build on. `core/auth.js` uses Supabase Auth with no
passwords: "Google ile devam et", or a one-time link sent by email. The first
sign-in creates the account. The account area sits at the foot of the
sidebar: "Giriş yap" when signed out, the email and "Çıkış yap" when signed in.

- **Settings** - `core/auth-config.js` holds the Supabase project URL, its
  publishable (anon) key and which sign-in ways to offer. Both values are public
  by design and ship to every browser; the secret `service_role` key must never
  appear in `src/web`. With the URL empty, sign-in is off and the account area
  stays hidden.
- **Cost to visitors** - the Supabase library (pinned, integrity-checked, from
  jsDelivr) loads only when someone opens the dialog, already has a session or
  comes back from a sign-in. Visitors who never sign in download none of it.
- **Session** - kept in the browser under `fantezi-analiz-auth`. Email links use
  PKCE, so a link must be opened in the browser that asked for it; the dialog
  says so when it is not. "Çıkış yap" signs out this browser only.
- **Profile** - `core/profile.js` keeps a nickname (3–24 characters: letters,
  digits, `_ . -`; unique whatever the case) and a favourite club (its
  Sportmonks team ID) in the Supabase `profiles` table, created by
  `supabase/profiles.sql`. Each visitor can read and change only their own row;
  the database enforces that and the nickname rules, and the page repeats them
  only to explain mistakes. Signed in, the sidebar shows the nickname (else the
  email) with their profile photo, then "Profil" and "Çıkış yap". Until a
  nickname is saved, the profile opens first as "Hoş geldin": right after
  signing in (in the tab the email link opened and in the tab that asked for
  it), and otherwise once per browser session. A new field means a column and its
  check in `profiles.sql` (run again in the SQL Editor) and an input in
  `profile.js`.
- **Profile photo** - "Fotoğraf yükle" in the profile crops the chosen picture
  to a centred square and shrinks it to 256 pixels in the browser (WebP, else
  JPEG; a few KB), which also drops anything the camera stored, such as the
  place it was taken. It goes to `<user id>/<new name>` in the public `avatars`
  Storage bucket (`supabase/avatars.sql`), and `profiles.avatar_path` points
  to it. Only the owner can upload to or delete from their folder, at most
  three files at a time; the bucket takes only images up to 512 KB. Each upload
  gets a new name, so browsers can keep a photo for good. "Kaldır" removes it.
  `profileAvatar()` draws a person everywhere one appears - the sidebar, the
  profile, Maç Tribünü posts, topic lines and forms, shared squads and their
  pages: the photo in a circle, else the nickname's first letter in the same
  circle. Never a club's crest, which stands for a club; a photo that no
  longer loads leaves the letter. Maç Tribünü posts and shared squads copy the
  photo like the nickname (`author_avatar_path`, filled in by the database),
  and a change follows onto earlier ones. A new place that shows a person uses
  `profileAvatar()` and, if it stores the author, copies `author_avatar_path`.
  Moderation: delete the file in Supabase → Storage → avatars.
- **For features** - `siteAuth.user` is the signed-in user or `null`, and
  `document` receives a `site-auth-change` event whenever it changes. Anything
  members-only must also be enforced by Supabase (row-level security), never
  only by hiding it in the page: everything under `/local-data/` is public.

Supabase setup, once: create a project; under Authentication → URL
Configuration set the Site URL to `https://fantezianaliz.com` and allow
`https://fantezianaliz.com/**`, `https://www.fantezianaliz.com/**`,
`https://fantezianaliz.pages.dev/**` and, for the local site,
`http://127.0.0.1:8000/**` and `http://localhost:8000/**`. Google needs an
OAuth client from Google Cloud, entered under Authentication → Sign In /
Providers → Google. Email links need custom SMTP (for example Resend): the
built-in sender only reaches the project's own team, two emails an hour. Leave
out of `providers` any way that is not set up.

## Publishing the site

The public site, **fantezianaliz.com**, is a files-only copy of this folder on
Cloudflare Pages. Build it after each download and pipeline run, then upload it:

```powershell
python src/web/build_static.py --season 2026/2027
npx wrangler pages deploy data/temp/site --project-name fantezianaliz --branch main
```

The first upload needs Node.js and opens a browser to sign in to Cloudflare.
Before it, create the project once with
`npx wrangler pages project create fantezianaliz --production-branch main`.
Then, in the Cloudflare dashboard, open **Workers & Pages → fantezianaliz →
Custom domains** and add `fantezianaliz.com` and `www.fantezianaliz.com`.

`build_static.py` writes `data/temp/site/` from scratch each run:

- **Code source** - the website files come from GitHub's `main` as last pushed
  (`git fetch`, then `git archive`), never from this folder, so unpushed or
  half-finished edits cannot go live with a data update. `--local-code` builds
  from this folder instead, for previewing with `npx wrangler pages dev`.
- **Pages** - every file `serve.py` would serve, except `assets/face-portraits/`
  (unused, and third-party artwork). Its copy of `core/site.js` says
  `SITE_PUBLISHED = true`.
- **Data** - the same files `serve.py` answers under `/local-data/`, at the same
  paths, so the pages read both sites the same way. Radar history includes only
  seasons before the published one, because the radar reads no others. The
  analysis files with a `season` column (points, odds) keep only the published
  season's rows: the points file holds every season since 2021, and the pages
  discard the rest, so publishing it whole cost every visitor about 11 MB.
- **`_headers`** - sends the `X-Superlig-Local` and `X-Superlig-Season` headers
  the pages check before trusting a data file, and labels the data
  `text/plain`: Cloudflare compresses that type but not `text/csv`.
- **`404.html`** - without it Pages answers a missing CSV with `index.html`, and
  optional files such as `download_status.csv` would look present but broken.

The build never reads `.env`, `data/raw` or `data/temp`, and never contacts
Sportmonks. It stops if a file exceeds Pages' 25 MiB limit, and lists optional
files that do not exist yet.

`siteMode` in `core/site.js` is `"local"` under `serve.py`, `"published"` on
the public site and `"none"` when a page is opened from disk. Live scores and
Kadro Kur recommendations need `serve.py`, so they appear only in `"local"`
mode. On the public site the serve.py setup instructions on the empty page
and the team page's "open CSV files" and "refresh saved data" buttons are
hidden. Maç Tribünü, Kadrolar and sign-in work the same on both, through Supabase.

The pages fetch data with `cache: "no-cache"`: the browser asks every time,
but a file that has not changed since the last visit comes back as a short
304 instead of the whole CSV. `serve.py` forbids storing its responses, so
locally every load still reads the files fresh.
