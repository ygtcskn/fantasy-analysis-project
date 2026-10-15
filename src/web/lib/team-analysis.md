# Team charts (`lib/team-analysis.js`)

The charts of Takım İstatistikleri (`index.html?view=team-statistics`), current
season only. Four of them are match by match and belong to **Takım Profili**,
where they are drawn for the open team alone: xG against xGA, xG form, goal
minutes and pressure balance. The **Takım Analizi** section at the top of the page
compares every team: fantasy points by position, the luck indicator and ten
one-point-per-team comparisons, each selected from a tab on the left. They are
drawn in the browser from the saved season CSVs, so there is nothing to build
or export: each weekly download
followed by **Refresh saved data** redraws all of them. A badge states the
latest round included, and the section note says when the last download caught
fixtures still in play.

| File | Role |
| --- | --- |
| `team-analysis.js` | `TeamAnalysis`: every computation and every chart, as pure functions returning SVG markup. No DOM and no requests, so Node can test them. |
| `team-charts-page.js` | Page wiring: reads the minute-level files on demand, draws the profile's four charts for the open team and the section's charts for every team, each with its note, and opens a team's profile when a panel or team name is clicked. |
| `team-analysis.css` | Layout and colours. Result, position and luck colours are theme variables with light and dark values. |

`src/web/index.html` loads them as `lib/...` and `features/team-statistics/...`;
`src/web/serve.py` serves the whole website folder by file suffix.

## Weekly update

1. Download the round: `python -m src.fetch.download_season --season 2026/2027 --refresh`.
2. Rebuild the fantasy ledger if you want the fantasy chart current:
   `python src/run_pipeline.py` (every other chart reads the season CSVs
   directly).
3. Click **Refresh saved data** on the site, or reload the page.

No restart is needed after the first one that installs these routes.

## Which matches count

Only finished fixtures (FT, AET, FT_PEN, AWARDED, WO) with a saved CURRENT score
for both sides, from both teams' point of view. A fixture the last download
caught in play (for example `INPLAY_2ND_HALF`) is left out, with its half-match
statistics, until it is downloaded again. Every chart in the section orders
teams by the standings unless it says otherwise, and clicking a panel or a team
name opens that team's profile above. The profile's four charts draw the open
team only, but their scales are still the league's, so the panel reads exactly
as it would beside every other team's.

## The charts

Charts 1-4 are on the profile, drawn for the open team; 5-7 are in the Takım
Analizi section above it, drawn for every team.

1. **xG ve xGA · maç maç.** One panel, one point per match: xG
   conceded across, xG created up, both on one scale from 0 to at least 3,
   widened to the league's largest single-match value (0-5 in 2026/27). Above the dashed diagonal the team out-created its
   opponent; the shaded half is where it did not. Grey points are every
   team-match of the season, colour is the result, and the cross is the team's
   own average - with few matches, the most readable summary.
2. **xG formu · maç maç.** Per match, xG above the line and xG conceded below,
   oldest first, with the result letter.
3. **Gol dakikaları.** Goals scored and conceded by fifteen-minute block, from
   `events.csv`. Goals, penalties and own goals count, disallowed ones do not;
   an own goal belongs to the side that benefits, as Sportmonks records it, and
   so counted the events reconcile with every saved 2026/27 score. Stoppage time
   joins the half's last block.
4. **Baskı dengesi.** Sportmonks' pressure index from `fixture_pressure.csv`:
   the team's pressure minus its opponent's, averaged per block over its matches.
   The feed numbers minutes continuously through stoppage time (a 45+7 first half
   runs to minute 52), so each minute is first put back on the match clock using
   the first half's length from `fixture_periods.csv`. A match whose feed lacks
   either side's pressure is left out of the average, and the note says how
   many were (Beşiktaş-Erzurumspor in round 5 of 2026/27 has none).
5. **Fantezi puanı · mevkiye göre.** The published points ledger summed per team
   by the game's positions (KL, DEF, OS, FOR), sorted by total. Shows directly
   whose defence or attack is paying out. Negative position totals are drawn
   left of zero. Until the ledger is ready, this chart and the fantasy
   comparison show the loader's own note: still reading, older than the match
   data (run the pipeline), or missing.
6. **Şans göstergesi.** Goals minus xG, and xG conceded minus goals conceded,
   over the season. Both columns point the same way: right means results were
   better than the chances, which tends not to last; teams on the left are
   candidates to improve.
7. **Karşılaştırma grafikleri.** Ten scatters, two per row, one point per team,
   each with captions saying what its corners mean:

   | Chart | Across | Up | Reference |
   | --- | --- | --- | --- |
   | Hücum ve savunma gücü | xG conceded per match | xG per match | league means |
   | Puan ve beklenen puan | expected points (xPts) | points | diagonal |
   | Gol ve xG | xG | goals | diagonal |
   | Yenilen gol ve xGA | xG conceded | goals conceded | diagonal |
   | Şut hacmi ve kalitesi | shots per match | xG per shot | league means |
   | Verilen şut ve kalitesi | opponent shots per match | xG conceded per opponent shot | league means |
   | Büyük fırsatlar | big chances conceded per match | big chances created per match | league means |
   | Topa sahip olma ve tehlike | average possession | dangerous attacks per match | league means |
   | Pres ve topa sahip olma | average possession | opponent passes per tackle, interception and foul (axis reversed: up is more pressing) | league means |
   | Fantezi puanı ve xG | xG per match | team fantasy points per match | league means |

   Like-for-like pairs share one scale, floored at zero, with a diagonal where
   the two figures are equal; the others get dashed lines at the league means.
   Gridlines fall on round values (1, 2, 2.5 or 5 times a power of ten) labelled
   to the step's precision, so a line marked 1 is at 1. Team codes move around
   their point - three distances in eight directions, inside the plot, clear of
   the points, the corner captions and each other - and take the least crowded
   spot when a cluster leaves nothing free. Every figure is taken over the matches
   that record what it needs, and each card says how many teams and matches it
   rests on. Expected points are Sportmonks' per-match values (they sum to about
   2.6-2.9 per fixture). The pressing figure is PPDA-like but covers the whole
   pitch, because the data has no pitch zones. Big chances are an event count, so
   a blank on a match whose statistics were recorded counts as none.

## Data

| Chart | Source |
| --- | --- |
| 1, 2, 6, 7 | `fixtures.csv`, `fixture_scores.csv` (CURRENT) and `team_metrics.csv` (xG, xG conceded, expected points, shots, possession, dangerous attacks, passes, tackles, interceptions, fouls, big chances) |
| 3 | `events.csv` |
| 4 | `fixture_pressure.csv`, `fixture_periods.csv` |
| 5 and the fantasy comparison | `data/final/points/player_match_points.csv`, the published ledger |

`team_metrics.csv`, `events.csv`, `fixture_pressure.csv` and
`fixture_periods.csv` are optional to the server: an export without one of them
still shows every chart that does not need it, and the missing chart says which
file it lacks.

## Narrow screens

The Takım Analizi section is its own CSS size container, because from 761px to
1100px the sidebar keeps 256px of the window. Below 800px of section width the
tabs move from the left of the chart to above it, wrapping into rows so every
tab stays visible. Below 600px the 640-unit bar charts and scatters
keep a 540px minimum width and scroll sideways, so their labels stay legible
on a phone.

## Tabs

The tabs are Chrome's tabs stood on end, in one colour: the panel purple
(`--ta-tab`, which is `--panel-rule` in dark). The chart fills its cell like a
browser page, with a purple left edge. The open tab is solid purple with white
text, joins that edge and curves into it through two concave corners, as
Chrome's open tab flares into the toolbar. The other tabs are faded purple
pills set back from the edge, a little stronger on hover. The tabs stretch to
the chart's height, so no empty strip is left below them. Below 800px the
tabs wrap into rows above the chart, and the open one is a solid purple pill.

Changing tabs never moves the page. Every chart is drawn into the same grid
cell, and only the open one is visible (`.ta-open`); the others keep their
space but are not seen, read out or focusable. So the section is always as
tall as its tallest chart at the current width - the luck chart, in practice.
Every tab uses the same font weight, because a bolder open tab could wrap its
label onto another line and change the height after all.

## Limitations

Early in a season every chart rests on a handful of matches; the luck figures
and the per-team averages move a lot until around the eighth to tenth round. xG
includes penalties throughout.

## Tests

`tests/test_team_analysis.cjs` uses only synthetic data and Node's built-in test
runner. Run it yourself when desired:

```powershell
node --test tests/test_team_analysis.cjs
```

These checks were written but not run, following `AGENTS.md`.
