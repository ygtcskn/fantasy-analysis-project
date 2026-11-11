"use strict";

// Takım İstatistikleri: a tabbed team analysis, a searchable team list, the
// selected team's players (team-players.js), and a
// profile of the selected team - two spider plots
// (src/web/features/team-statistics/team-radar-page.js), season totals, and the four match-by-match
// charts drawn for that team by src/web/features/team-statistics/team-charts-page.js.
//
// Results and goals come from the saved standings and CURRENT scores, the same
// way Puan Durumu reads them. Match statistics (xG, possession, shots) come
// from team_metrics.csv, read on demand because older exports lack it; the page
// works without it and says what is missing.

const teamStatisticsState = { selected: null };
const teamMetricsState = { key: null, state: "idle", rows: [], message: "" };

const teamStatisticsSigned = (value) => (value === null ? "—" : `${value > 0 ? "+" : ""}${displayNumber(value)}`);

// A sort on a figure the list does not show brings it in as a last column:
// its heading, the heading's full name, and the cell.
const TEAM_STATISTICS_SORTS = [
  ["points", "Puan ↓", (team) => team.points],
  ["scored", "Atılan gol ↓", (team) => team.scored],
  ["conceded", "Yenilen gol ↑", (team) => (team.conceded === null ? null : -team.conceded)],
  ["difference", "Averaj ↓", (team) => team.difference, [t("AV"), t("Averaj"), (team) => teamStatisticsSigned(team.difference)]],
  ["cleanSheets", "Gol yemeden ↓", (team) => team.cleanSheets, [t("GY"), t("Gol yemeden"), (team) => displayNumber(team.cleanSheets)]],
];

async function loadTeamMetrics() {
  const key = state.seasonSlug;
  if (!key || teamMetricsState.key === key) return;
  Object.assign(teamMetricsState, { key, state: "loading", rows: [], message: "" });
  try {
    if (typeof RadarTeams === "undefined") throw new Error("spider");
    const records = await readFantasyCSV("team_metrics.csv", ["fixture_id", "team_id", "name", "value"], key);
    if (teamMetricsState.key !== key) return;
    Object.assign(teamMetricsState, { state: "ready", rows: RadarTeams.rows(records) });
  } catch (error) {
    if (teamMetricsState.key !== key) return;
    Object.assign(teamMetricsState, { state: "unavailable", rows: [],
      message: error.message === "spider" ? t("Radar dosyaları yüklenemedi; src/web/serve.py'yi yeniden başlatıp sayfayı yenileyin.")
        : error.message === "missing" ? t("team_metrics.csv sunulmuyor; src/web/serve.py'yi yeniden başlatın veya sezonu yeniden indirin.")
          : t("Takım maç istatistikleri okunamadı.") });
  }
  // Maç Haftası reads the same rows for its card rankings.
  if (state.seasonSlug !== key) return;
  if (state.view === "team-statistics") renderTeamStatistics();
  else if (state.view === "matchweek") renderMatchweek();
}

// One entry per team in the standings group Puan Durumu has selected - the
// first, the regular season, unless another was chosen there - with the
// provider's totals where it supplies them and saved results otherwise.
function teamStatisticsTeams() {
  const names = homeTeams(), source = state.tables["standings.csv"] || [];
  const groups = [...new Set(source.map(standingGroupKey))];
  const group = groups.includes(state.standingsGroup) ? state.standingsGroup : groups[0];
  const scores = currentFixtureScores();
  return { names, list: source.filter((row) => standingGroupKey(row) === group).map((row) => {
    const { games, values } = standingResults(row, scores);
    const valid = games.filter((game) => game.valid);
    const provided = (key, fallback) => number(row[`details.${key}`]) ?? fallback ?? null;
    return { id: row.participant_id, name: teamName(row.participant_id, names), position: number(row.position),
      points: number(row.points), played: provided("overall_matches", values.played),
      wins: provided("overall_wins", values.wins), draws: provided("overall_draws", values.draws),
      losses: provided("overall_lost", values.losses), scored: provided("overall_scored", values.scored),
      conceded: provided("overall_conceded", values.conceded),
      difference: provided("overall_goal_difference", values.difference),
      // Only from saved scores: a match whose score is missing is not a clean sheet.
      cleanSheets: games.length ? valid.filter((game) => game.other === 0).length : null,
      unknownGames: games.length - valid.length, games };
  }) };
}

function teamStatisticsIdentity(team, names, label) {
  const club = element("div", "statistics-club");
  club.append(createTeamLogo(team.id, names, false));
  const open = element("button", "statistics-player-button", team.name);
  open.type = "button";
  open.title = team.name;
  open.setAttribute("aria-label", label);
  open.addEventListener("click", () => {
    teamStatisticsState.selected = team.id;
    renderTeamStatistics();
    $("team-statistics-profile").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  club.append(open);
  return club;
}

function teamStatisticsFitNames() {
  for (const button of document.querySelectorAll("#team-statistics-list-body .statistics-player-button, #team-statistics-players-body .statistics-player-button")) {
    button.style.fontSize = "";
    for (let size = 12; size >= 8 && button.scrollWidth > button.clientWidth; size--) {
      button.style.fontSize = `${size}px`;
    }
  }
}

function renderTeamStatisticsList(teams, names) {
  const query = $("team-statistics-search").value.trim().toLocaleLowerCase(LOCALE);
  const [, , accessor, extra] = TEAM_STATISTICS_SORTS.find(([key]) => key === $("team-statistics-sort").value)
    || TEAM_STATISTICS_SORTS[0];
  const heading = $("team-statistics-sort-column");
  heading.hidden = !extra;
  heading.textContent = extra?.[0] || "";
  heading.title = extra?.[1] || "";
  heading.closest("table").classList.toggle("has-sort-column", Boolean(extra));
  const visible = teams.filter((team) => !query || team.name.toLocaleLowerCase(LOCALE).includes(query))
    .sort((a, b) => (accessor(b) ?? -Infinity) - (accessor(a) ?? -Infinity) || (a.position ?? 99) - (b.position ?? 99));
  const body = document.createDocumentFragment();
  for (const team of visible) {
    const row = element("tr"), identity = element("td");
    identity.append(teamStatisticsIdentity(team, names, t("{name} profilini göster", { name: team.name })));
    if (team.id === teamStatisticsState.selected) row.classList.add("statistics-row-selected");
    row.append(identity, element("td", "numeric", displayNumber(team.played)),
      element("td", "numeric", displayNumber(team.scored)), element("td", "numeric", displayNumber(team.conceded)),
      element("td", "numeric", displayNumber(team.points)));
    if (extra) row.append(element("td", "numeric", extra[2](team)));
    body.append(row);
  }
  if (!visible.length) {
    const row = element("tr"), cell = element("td", "no-results", t("Bu aramayla takım bulunamadı."));
    cell.colSpan = extra ? 6 : 5;
    row.append(cell);
    body.append(row);
  }
  $("team-statistics-list-body").replaceChildren(body);
}

// Season sums of a team's match statistics; null when any match lacks it, so
// a partial total is never shown as the season's.
function teamStatisticsSum(rows, column, mean = false) {
  const values = rows.map((row) => number(row[column]));
  if (!values.length || values.some((value) => value === null)) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return mean ? total / values.length : total;
}

function renderTeamStatisticsFacts(team, rows) {
  const own = rows.filter((row) => row.team_id === team.id);
  // Whole per cent, as the possession charts show it.
  const possession = own.length ? teamStatisticsSum(own, "ball_possession", true) : null;
  const entries = [
    [t("Sıra"), displayNumber(team.position)],
    [t("Puan"), displayNumber(team.points)],
    [t({ tr: "Maç", en: "Matches" }), displayNumber(team.played)],
    [t("G-B-M"), [team.wins, team.draws, team.losses].every((value) => value !== null)
      ? `${team.wins}-${team.draws}-${team.losses}` : "—"],
    [t("Averaj"), teamStatisticsSigned(team.difference)],
    [t("Atılan gol"), displayNumber(team.scored)],
    [t("Yenilen gol"), displayNumber(team.conceded)],
    [t("Gol yemeden"), displayNumber(team.cleanSheets)],
    ["xG", own.length ? displayNumber(teamStatisticsSum(own, "expected_goals")) : "—"],
    [t("Rakibe verilen xG"), own.length ? displayNumber(teamStatisticsSum(own, "expected_goals_against")) : "—"],
    [t("Topla oynama"), possession === null ? "—" : percentText(Math.round(possession))],
    [t("Şut"), own.length ? displayNumber(teamStatisticsSum(own, "shots_total")) : "—"],
  ];
  const list = document.createDocumentFragment();
  for (const [label, value] of entries) {
    const item = element("div");
    item.append(element("dt", "", label), element("dd", "", value));
    list.append(item);
  }
  $("team-statistics-facts-list").replaceChildren(list);
  $("team-statistics-facts-note").textContent = (team.unknownGames ? `${t("{count} maçın skoru kayıtlı değil; gol yemeden sayılmadı.", { count: team.unknownGames }, team.unknownGames)} ` : "")
    + (teamMetricsState.state === "unavailable" ? teamMetricsState.message
      : own.length ? t("xG, topla oynama ve şut {count} maçın istatistiğinden.", { count: own.length }) : "");
}

function renderTeamStatisticsProfile(teams, names) {
  const selected = teams.find((team) => team.id === teamStatisticsState.selected)
    || [...teams].sort((a, b) => (a.position ?? 99) - (b.position ?? 99))[0];
  const panels = ["team-statistics-radar-chart", "team-statistics-detailed-chart", "team-statistics-radar-details",
    "team-statistics-detailed-details", "team-statistics-facts-list"];
  const notes = ["team-statistics-radar-note", "team-statistics-detailed-note", "team-statistics-facts-note"];
  if (!selected) {
    $("team-statistics-profile-name").textContent = "—";
    $("team-statistics-profile-note").textContent = t("Puan durumunda takım bulunamadı.");
    for (const id of panels) $(id).replaceChildren();
    for (const id of notes) {
      $(id).textContent = "";
      if (id !== "team-statistics-facts-note") $(id).hidden = true;
    }
    return;
  }
  teamStatisticsState.selected = selected.id;
  $("team-statistics-profile-name").textContent = selected.name;
  $("team-statistics-profile-note").textContent = t("Listeden bir takıma tıklayarak profili değiştirin.");
  $("team-statistics-open-team").onclick = () => {
    location.href = `team.html?${new URLSearchParams({ id: selected.id, name: selected.name })}`;
  };
  // Season totals from finished fixtures only: a match the last download caught
  // in play would otherwise count with half its statistics. The radars apply
  // the same rule to their own rows.
  const finished = new Set((state.tables["fixtures.csv"] || []).filter(fixtureFinished)
    .map((fixture) => String(fixture.fixture_id)));
  const rows = teamMetricsState.rows.filter((row) => finished.has(row.fixture_id));
  if (typeof renderTeamRadars === "function") {
    renderTeamRadars(selected.id, (id) => teamName(id, names));
  } else {
    for (const id of panels.slice(0, 4)) $(id).replaceChildren();
    const note = t("Radar dosyaları yüklenemedi; src/web/serve.py'yi yeniden başlatıp sayfayı yenileyin.");
    for (const id of ["team-statistics-radar-note", "team-statistics-detailed-note"]) {
      $(id).textContent = note;
      $(id).hidden = !note;
    }
  }
  renderTeamStatisticsFacts(selected, rows);
}

function renderTeamStatistics() {
  if (teamMetricsState.key !== state.seasonSlug) loadTeamMetrics();
  const { names, list } = teamStatisticsTeams();
  renderTeamStatisticsList(list, names);
  renderTeamStatisticsProfile(list, names);
  // After the profile, which settles the open team (the leader until a click).
  if (typeof renderTeamPlayers === "function") renderTeamPlayers(teamStatisticsState.selected);
  if (typeof renderTeamAnalysis === "function") renderTeamAnalysis(list, names);
  requestAnimationFrame(teamStatisticsFitNames);
}

function setupTeamStatistics() {
  $("team-statistics-search").addEventListener("input", renderTeamStatistics);
  $("team-statistics-sort").addEventListener("change", renderTeamStatistics);
  window.addEventListener("resize", () => requestAnimationFrame(teamStatisticsFitNames));
  if (typeof setupTeamAnalysis === "function") setupTeamAnalysis();
  if (typeof setupTeamPlayers === "function") setupTeamPlayers();
}
