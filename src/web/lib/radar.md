# Radar plots (`lib/radar.js`)

The **İstatistikler** page (`index.html?view=statistics`) draws two
spider plots for the player selected in its list: **Genel Nitelikler**, general
attributes computed with principal components, and **Ayrıntılı Ölçütler**, one
fixed wheel of individual statistics. **Takım İstatistikleri**
(`index.html?view=team-statistics`) draws the same two plots for a team; see
[Team plots](#team-plots). Everything that builds them lives here.

Both pages first read `data/final/spider/<season>/spider_stats.csv`, prepared
from the saved player and team match exports by
`python -m src.spider.build_spider_stats --all-seasons`. Each row is one player
or team in one fixture. `p_` and `t_` columns keep the two provider feeds
separate; the browser removes the prefix before calculating rates, reference
percentiles and principal components. The normal `src/run_pipeline.py` run
rebuilds and publishes the current and saved earlier seasons after the website tables.
Earlier-season files widen the reference group but do not change the plotted
season's own match data. Missing statistics remain blank rather than zero.

When a team match lacks `KEY_PASSES`, the preparer can use the sum of recorded
player key passes if at least eleven played players have other match statistics
and at least one has a positive key-pass record. The `t_key_passes_source`
column distinguishes `team_provider`, `player_sum` and `missing`. Published
team values take precedence; the two feeds sometimes differ, so a supplemental
player total is never presented as a provider team value.

| File | Role |
| --- | --- |
| `radar.js` | Pure modules: `RadarScoring` (season totals, per-90 rates, peer populations, percentiles), `RadarAttributes` (principal-component attributes), `RadarTeams` (the team catalogue and team-match rows) and `RadarChart` (the SVG). No DOM and no requests, so Node can test them directly. |
| `radar-page.js` | Page wiring for players: the earlier-season loader, the shared reference, tooltips, detail tables and the render. |
| `team-radar-page.js` | Page wiring for teams, reusing the tooltips, detail tables and feed-availability rule from `radar-page.js`. |
| `radar.css` | Layout and styling of the two plots, on the site's theme variables so they follow light and dark mode. |
| `build_reference.py` | Legacy pooled-percentile exporter, kept for existing local workflows. Not an input to the plots. |

`src/web/index.html` loads them as `../spider/...`: `src/web/serve.py` serves
`/spider/...` from this folder, and a page opened straight from disk resolves
the same path to it. Leader cards, lists, season totals, timelines and rating
bars stay with their pages: `src/web/statistics.js` for players and
`src/web/team-statistics.js` for teams.

## One option

The plots have no settings. Every render uses the same definition:

- the selected player's own season and competition;
- his position group;
- a minute bar that follows the season - half the minutes the most-used player
  has managed, rounded to a third of a match and capped at 900 - because ten
  full matches is unreachable in September and an unreachable bar leaves the
  plots with no peers at all (after four rounds of 2026/2027 it is 180);
- this season's peers plus every earlier Süper Lig season, each cut to the
  rounds this season has reached;
- small samples pulled toward their group (empirical Bayes), below;
- the mid-rank percentile, with the zero-heavy rule below where no adjustment
  applies.

There is no comparison overlay. Search, club and list sorting filters never
change the reference.

## Who a player is compared with

- **This season:** players of the same season, competition and position group
  who reach the minute bar.
- **Earlier seasons:** every earlier Süper Lig season in
  `data/final/sportmonks`, one entry per player-season, under the same role and
  bar. **Only the scale widens: every plotted value is the player's
  current-season figure.** Seasons after the served one are never used, and
  another competition never is. The browser reads the earlier seasons in the
  background (a few seconds) through the read-only `/local-data/history/` route
  in `serve.py`, reduces each player-season to its totals and releases the raw
  rows. Until they arrive, or if the route is unavailable, the distribution
  panel's note says the comparison is current-season only.
- **Same point of the season:** while the served season is under way, every
  earlier season is cut to the rounds it has reached - the highest round with a
  finished fixture, read from `round.name`. Seven rounds in, a current per-90
  rests on 330-630 minutes and a full earlier season on 2,000+, so the noisier
  current rates crowded both ends of the pooled scale; cut, seven rounds are
  compared with seven rounds. The cut applies to the tallies only - feed
  availability is still judged on the whole earlier season - and the history
  reloads when a refresh brings a new round. A complete served season, one
  with no finished fixture, or unnumbered rounds are not cut. The distribution
  panel's note says `ilk N hafta`. After seven rounds of 2026/2027 a forward is
  ranked among 18 current and 98 earlier forwards (317 without the cut).
- **Position:** the supplied match position with the most recorded minutes in
  the season and competition. An exact tie is unresolved. If match roles are
  absent, a single unambiguous supplied squad role can be used. Fantasy
  classifications do not change radar peers. The exports provide broad role
  names, so Defender and Midfielder remain DEF and MID; the code does not guess
  CB/FB/DM/CM from numeric detailed-position IDs. `positionGroups` supports
  supplied GK/CB/FB/DM/CM/AM/W/FW names and custom alias groups; a new custom
  group falls back to the outfield wheel and attribute groups unless it gets its
  own entry in `RadarScoring.profiles` and `RadarAttributes.groups`.
- **Scope first:** appearances are joined to fixtures before summing minutes or
  metrics. Unknown fixture identities or missing season/league identities do not
  enter a reference group. Transfers within the same competition remain one
  Sportmonks player ID.

## Reading the statistics

- **Rates:** counting statistics are totals / minutes × 90. xG prefers the
  dedicated feed on each match and falls back to `expected_goals` only when the
  dedicated value is blank; the feeds are never added together, and a second
  feed outranks the omitted-zero reading below. A combined axis such as goal
  contribution sums its columns per match and needs every part of that match to
  be known. Minutes and provider ratings remain season facts, not radar axes.
- **Missingness:** the provider encodes a zero counting statistic by omitting
  it. Not one row of the 2025/2026 export writes a literal `0` in `goals`,
  `shots_total`, `tackles`, `aerials` or `redcards`, and 92% of played rows
  leave `goals` blank. A blank counting column is therefore read as none of
  that event - but only on a match the statistics feed covered, judged by
  whether any of touches, passes, duels, shots, fouls or possession lost is
  present. 53 of 9,438 played rows in 2025/2026 carry no statistics at all;
  those stay unknown, because reading them as ninety minutes of nothing would
  understate every rate the player has. A column absent from the export, or a
  nonfinite or negative count, remains unavailable. An incomplete season metric
  keeps its observed subtotal and match coverage in the tooltip, but gets no
  rate or score.
- **Bench rows:** rows explicitly showing zero minutes are excluded, and so are
  blank-minute rows that record nothing else: of 19,270 blank-minute rows across
  2021-2027, all but 36 are unused substitutes - not started, no statistic, no
  rating. Left in, one benched match made a whole season's minutes unknown and
  removed the player from every reference; in 2026/2027 that had excluded 120
  players. A blank-minute row that does record play still makes the season's
  minutes uncertain and excludes the player.
- **Feed availability:** providers added columns over time. For example,
  touches, possession lost, ball recoveries, final-third passes, errors leading
  to a shot, high claims and punches are blank on every row before 2024/2025;
  xG fills 13.5% of rows in 2023/2024 against about 46% later; long balls and
  blocked shots are partial before 2023/2024. In an earlier season a column
  counts as supplied only when its fill rate on covered rows is at least 80% of
  the served season's or within sampling noise of it (z ≥ -4). Otherwise it is
  removed from that season's rows, so every axis built on it is unknown there -
  those player-seasons simply do not enter that axis - rather than read as zero.
- **Percentages:** ratios are formed from matching season numerator and attempt
  totals, never averaged from match percentages. Complete coverage is required
  for both components; success counts exceeding attempts are rejected per match.
  A below-threshold or zero-attempt ratio is unavailable, not zero. An omitted
  denominator counts as zero attempts only when the numerator is also omitted:
  Sportmonks blanks `aerials` on 1,828 covered rows that do record aerials won,
  and reading those as no attempts would credit duels the player never
  contested. That same gap is why aerial win rate is not an axis; aerial duels
  appear as won-per-90 instead.

  Each requirement below states a ten-match sample. It is scaled down with the
  minute bar and never falls below twenty attempts. **It applies only where the
  small-sample adjustment cannot run** (fewer than ten valid peers, or the
  adjustment switched off). Where it runs, one attempt is enough: the prior is
  fitted on peers that meet the full requirement and then pulls every
  percentage toward the group mean by its attempts, so a one-of-one ratio lands
  almost exactly on the mean instead of at 100%, and a low-volume passer is
  ranked rather than blanked - Victor Osimhen's 29 of 33 passes after seven
  rounds of 2026/2027 is ranked as 78% instead of being left empty under a
  37-attempt minimum. Zero attempts stays unavailable (`no_attempts`).

| Percentage metric | Minimum attempts (ten matches) |
| --- | ---: |
| Pass completion | 100 |
| All duels, long-pass completion | 30 |

## Small-sample adjustment

Before ranking, each per-90 and percentage is pulled toward its peer group in
proportion to how little evidence it rests on (empirical Bayes):

```
adjusted = (events + mean × weight) / (minutes + weight) × 90
```

with attempts in place of minutes for a percentage. `mean` is the pooled group
rate. `weight` is how many minutes (or attempts) of evidence that mean is worth:
the noise of one minute divided by the true spread between players.

- **True spread** is the spread of the peers' observed rates minus their
  sampling noise.
- **Noise is measured, not assumed.** Each season tally keeps match-level sums,
  so a player's own match-to-match variation around his season rate gives his
  sampling variance (a ratio estimator, `n / (n - 1)` corrected). Earlier
  seasons keep these sums in their stored tallies. A peer with fewer than two
  matches falls back to the counting model: Poisson for a per-90, binomial for
  a percentage. This matters: xG is not a count and is far steadier than a
  Poisson count of the same mean, and pass volume swings with team context.
- A metric whose spread is all noise gets the cap: 2,700 minutes (thirty full
  matches), or ten times the ten-match attempt requirement. Fewer than ten
  valid peers, or a group mean of zero, leaves the observed value unchanged.
- The prior is fitted on the same reference the wheel ranks against, so every
  peer and the selected player are adjusted the same way. The principal
  components and the distribution panel use the adjusted values too.

After seven rounds of 2026/2027 among forwards: passes carry about 100 minutes
of weight (the player's own share 84% at 560 minutes), shots about 730, xG about
620, shots on target and goal contributions about 1,300, and big chances
created the cap, meaning those differences are still mostly luck.

The tooltips show the observed value, the adjusted value that
is ranked, the group mean, the weight and the player's own share,
`minutes / (minutes + weight)`. Because adjusted values are rarely exactly zero,
the zero-heavy rule below now matters mainly where no adjustment applies.

## Scores

**Mid-rank percentiles:** (peers below + half of those tied) / N × 100. Ties
share a score; `[1, 1, 2, 4]` scores `[25, 25, 62.5, 87.5]`. The unique leader
of 20 scores 97.5 and the last 2.5, because being best of a finite group is
evidence of being very good, not of being unbeatable; a larger group earns a
score closer to the edge (99.9 among 400). A target outside the reference
population, such as a short sample, is placed where it would fall as one more
observation, (below + 0.5) / (N + 1), and is never inserted into the reference
to score it; the two forms interleave monotonically. At least two eligible
nonmissing observations are required for each metric. Full precision is kept
for plotting. Displayed scores show 0 or 100 only where a rule puts them there
(an observed zero on a zero-heavy axis); a rank inside a group reads 1-99, so
99.8 among 383 does not round to 100.

**Zero-heavy metrics:** where at least 70% of the eligible peers recorded none
of an event (metric metadata can force this on or off), an observed zero scores
0 and positive values are ranked among the positive peers only. Negative events
are reversed after this, so zero errors score 100. All-zero valid populations
remain 0 for positive metrics and 100 for negative ones. A positive target with
no positive peers is unavailable; a single positive contributor sits in the
middle of the positive group, at 50. These scores are labelled in the tooltip
because they are not literal percentiles of all peers.

**Direction and context:** negative events such as possession losses, fouls,
cards and errors use `100 - score`, with positive display labels and the
original event label in the tooltip. Context axes, such as touches, passes and
defensive action volumes, indicate greater activity rather than better quality;
they are set in italics on the chart and labelled in words in the tooltip and
details. No overall rating or average polygon score is calculated.

Configuration lives in `RadarScoring.defaults` (minute bar, minimum peers,
zero-share threshold) and `RadarScoring.metrics` (source and fallback columns,
transforms, direction, zero policy, attempt thresholds, category, display
labels and position relevance).

## Genel Nitelikler

The left plot answers "what is this player good at" one quality at a time
rather than one column at a time. Each axis is the first principal component of
a group of related per-90 rates, so measures that repeat each other count once:
shots, shots on target and xG say much the same thing about a striker, and
averaging their percentiles would treat one piece of evidence as three. The
groups are Hücum, Üretim, Top kullanımı, Savunma, Hava ve mücadele and Disiplin
for outfielders, and Kurtarış, Ceza sahası, Az gol yeme, Ayakla oyun and
Disiplin for goalkeepers. "Tactic" and "positioning" have no Sportmonks column
and are not invented.

- The component is fitted on the same peer population the right-hand wheel
  ranks against, so both plots share a season, competition, role and minute bar.
- Only peers with every member present enter the fit: a principal component
  cannot be taken over ragged rows without inventing the missing values. When a
  member is missing from earlier seasons, it stays unless requiring it would cut
  the fittable peers to under a third of what the other members allow; then the
  member leaves the axis instead. Chances created is the usual case: keeping it
  would fit Üretim on this season's 22 forwards, dropping it fits it on 259.
- Members are direction-adjusted first, so fewer fouls is more discipline, and
  each is standardised against the peer group. Power iteration on the resulting
  correlation matrix gives PC1; a member the whole group scores identically is
  dropped rather than dividing by zero.
- **Agreement:** PC1 only reads as "more of this quality" when its members
  agree. Where one moves against the rest - dribbling against shot volume, or
  possession lost against touches - it is measuring something else, and an axis
  labelled Hücum that fell when a player dribbled more would mislead. Members
  that load negatively leave the axis, most negative first, and the component
  is refitted until the survivors agree. Every member that left - for missing
  coverage, for being constant, or for moving against the axis - is named with
  its reason in the tooltip.
- The component is oriented so higher is always better, then the player's
  projection is ranked against the peers' projections with the same mid-rank
  percentile. The share of the surviving members' variance it explains is
  reported beside the plot.

A one-member group, such as a keeper's goals conceded, is that member's
standardised value and explains all of its own variance by construction.

## Ayrıntılı Ölçütler

The right-hand plot draws one fixed set of variables per role - sixteen for
outfielders, ten for goalkeepers - in the order they sit on the circle:
finishing, then creation and passing, then defending and duels, the way
published player pizza charts present it. Three variables from those charts
have no Sportmonks equivalent and are not substituted silently: opposition
penalty-area touches, passes received and any positioning composite. A player
below the minute bar is still drawn, with an explicit small-sample note, but
does not enter the reference.

## Team plots

The team plots run the same code: `RadarScoring` for totals, rates, the
reference and mid-rank percentiles, `RadarAttributes` for the principal
components, `RadarChart` for the wheel. A team-season is treated like a
player-season whose every match lasts 90 minutes, so a per-90 rate is a
per-match rate (shown as `/maç`), and every team is one group, `TEAM`.

- **Data:** the team rows of prepared `spider_stats.csv`, one row per
  team-match with Sportmonks names lower-cased (`SHOTS_TOTAL` becomes
  `shots_total`), so the coverage and
  omitted-zero rules read it exactly as they read player rows. What a team
  conceded - goals, shots, shots on target - comes from the opponent's row in
  the same fixture; with only one side saved it stays unknown. xG conceded is the
  provider's own figure, or the opponent's xG when that is blank.
- **Omitted records:** in the provider's long format an omitted statistic has no
  record at all, so preparation first gives each team row every statistic its
  season supplies anywhere,
  left blank. Without that, a match with no goal recorded had no goals column,
  the shared rules read it as unknown rather than none, and one goalless match
  removed a whole team-season from every attack axis (Hücum fitted on 19 teams
  instead of 55).
- **Blank as zero, per statistic:** event counts where zero is ordinary - goals,
  goals conceded, shots on target, big chances, accurate crosses, corners and
  cards - read a blank on a covered match as none; from 2024-25 Sportmonks
  stops writing zero goals and red cards at all. Volume statistics a team never
  records as zero - passes, possession, shots, tackles - and xG keep a blank
  unknown. So do key passes and duels won, which have genuine gaps. The
  preparer checks the player-match feed for a supported key-pass total where
  the team feed omitted one; any remaining gap stays unknown.
- **Reference:** the served season's teams that have played at least half as
  many matches as the busiest (after four rounds, two), plus every earlier
  season's team-seasons of the same competition - 18 current and 96 earlier
  team-seasons in 2026-27. The feed-availability rule is the players' rule: xG,
  xG conceded and big chances are unknown before 2024-25, key passes before
  2023-24, and duels won in 2025-26, where they fill 79% of matches.
- **Wheel:** sixteen axes - goals, xG, shots, shots on target, big chances,
  dangerous attacks, possession (a per-match average, never summed), passes,
  pass completion, key passes, accurate crosses, fewer goals conceded, less xG
  conceded, fewer shots conceded, tackles and interceptions.
- **Attributes:** Hücum, Üretim, Top hakimiyeti, Savunma, Mücadele and Disiplin,
  with the same coverage, constant-member and agreement rules as the player
  attributes. Duels won currently leaves Mücadele for coverage.

## Drawing

Both plots have fixed rings at 0, 20, 40, 60, 80 and 100. Missing scores have no
point, and the axis says why in a few muted italic words under its dash - veri
yok, eksik maç verisi, deneme yok, az emsal and so on - so a blank axis needs no
hover; neighbouring segments are not connected across missing axes, and an
incomplete polygon is not filled. An observed zero is plotted at the actual
centre. Keyboard-focusable tooltips show the observed
total, rate or percentage, score rule, reference definition, metric-specific N,
positive-only N when applicable, attempts, minutes, coverage and any
unavailable reason. When no metric can be scored, the plot says whether the
minute bar leaves too few peers or the observations are unavailable.

The plots sit side by side whenever the profile panel is at least 740px wide -
from a 1366px window up - and stack below that, where each would drop under
~330px. The chart is proportioned for that half-width: labels render at 9-11px,
blocks that would collide just off the vertical axis are pushed outward, and the
viewBox is cropped to what was drawn. The two plots of a page then share one
frame - the union of both viewBoxes (`statisticsAlignRadars` in
`radar-page.js`) - so the attribute wheel and the metric wheel always have
the same radius, centre line and height side by side.

## Limitations

Early in a season, small current samples used to put current players at both
ends of the pooled scale - 14 of the top 37 defender shot rates, against their
8% share of the population. The same-point cut and the small-sample adjustment
above address this; `src/spider/radar_reliability.py` measures how well it
works (see [Reliability report](#reliability-report)). What remains:

- Positions are the provider's broad roles, so wingers share a group with
  strikers, holding midfielders with attacking ones, and centre-backs with
  full-backs.
- Team style is not adjusted for: touches, passes and defensive volumes follow
  possession. Those axes are marked as context, but they still feed attributes.
- Five seasons are pooled; feed availability is handled, but a provider change
  of definition (for example a new xG model) is not.
- The cut reduces the earlier peers to those who had reached the minute bar by
  the same round, so early in a season the reference is smaller.

The legacy `player_reference/reference_*.csv` exports from `build_reference.py`
are not read; earlier seasons are aggregated in the browser from the saved match
rows with exactly the same scoping, missingness and position rules as the
current season, so no reference build or new downloader is required.

## Reliability report

`python -m src.spider.radar_reliability` writes
`data/temp/radar_reliability.csv`. For every completed saved season it compares
each player's figure over the first N rounds (default 4, 7, 10 and 15) with the
same figure over the rest of that season, which never overlaps the early window,
so the test is out of sample. The rules mirror the browser: finished fixtures,
unused-substitute rows dropped, the omitted-zero and feed-availability rules,
broad position by most minutes, the seeded minute bar, scaled attempt
requirements and the same prior. The rest of the season needs at least 900
minutes and a full attempt requirement to be an answer key.

One row per window, position and metric:

| Column | Meaning |
| --- | --- |
| `players`, `seasons` | Player-seasons scored and the seasons they came from |
| `early_minutes_median` | Median minutes in the early window |
| `prior_mean`, `prior_weight`, `prior_unit` | The fitted prior, per 90 or per cent |
| `own_share_median` | Median share of the adjusted value that is the player's own |
| `spearman_observed`, `spearman_adjusted` | Rank correlation of the early figure with the rest of the season |
| `percentile_error_observed`, `percentile_error_adjusted` | Mean gap, in percentile points, between early and later standing |
| `reading` | From `spearman_adjusted`: strong (0.7+), moderate (0.5+), weak (0.3+), noise |

An axis reading noise at the current round is one to ignore for now. If
`spearman_adjusted` is not above `spearman_observed`, the adjustment is not
helping that axis.

## Running

Restart `src/web/serve.py` after installing this layout, so it serves
`/spider/...` and `/local-data/history/`, then reload the page. Automated checks
are in `tests/test_radar.cjs`; they use only synthetic observations and Node's
built-in test runner. Run them yourself when desired:

```powershell
node --test tests/test_radar.cjs
python -m unittest tests.test_radar_reliability
python -m src.spider.radar_reliability
```

These checks were written but not run, following `AGENTS.md`.
