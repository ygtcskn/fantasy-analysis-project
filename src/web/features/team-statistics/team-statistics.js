"use strict";

// Takım İstatistikleri: the team counterpart of İstatistikler. Leader cards, a
// searchable team list, and a profile of the selected team - two spider plots
// (src/web/features/team-statistics/team-radar-page.js), season totals, and the four match-by-match
// charts drawn for that team by src/web/features/team-statistics/team-charts-page.js.
//
// Results and goals come from the saved standings and CURRENT scores, the same
// way Puan Durumu reads them. Match statistics (xG, possession, shots) come
// from team_metrics.csv, read on demand because older exports lack it; the page
// works without it and says what is missing.

const teamStatisticsState = { selected: null };
const teamMetricsState = { key: null, state: "idle", rows: [], message: "" };

const TEAM_STATISTICS_SORTS = [
  ["points", "Puan ↓", (team) => team.points],
  ["scored", "Atılan gol ↓", (team) => team.scored],
  ["conceded", "Yenilen gol ↑", (team) => (team.conceded === null ? null : -team.conceded)],
  ["difference", "Averaj ↓", (team) => team.difference],
  ["cleanSheets", "Gol yemeden ↓", (team) => team.cleanSheets],
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
      message: error.message === "spider" ? "Radar dosyaları yüklenemedi; src/web/serve.py'yi yeniden başlatıp sayfayı yenileyin."
        : error.message === "missing" ? "team_metrics.csv sunulmuyor; src/web/serve.py'yi yeniden başlatın veya sezonu yeniden indirin."
          : "Takım maç istatistikleri okunamadı." });
  }
  if (state.view === "team-statistics" && state.seasonSlug === key) renderTeamStatistics();
}

// One entry per team in the first standings group (the regular season), with
// the provider's totals where it supplies them and saved results otherwise.
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
  open.setAttribute("aria-label", `${team.name} ${label}`);
  open.addEventListener("click", () => {
    teamStatisticsState.selected = team.id;
    renderTeamStatistics();
    $("team-statistics-profile").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  club.append(open);
  return club;
}

function renderTeamStatisticsCard(bodyId, noteId, teams, names, accessor, format, ascending = false) {
  const leaders = teams.filter((team) => accessor(team) !== null)
    .sort((a, b) => (ascending ? accessor(a) - accessor(b) : accessor(b) - accessor(a)) || a.name.localeCompare(b.name, "tr"))
    .slice(0, 10);
  const body = document.createDocumentFragment();
  // Equal values share a rank.
  let rank = 0;
  leaders.forEach((team, index) => {
    if (index === 0 || accessor(team) !== accessor(leaders[index - 1])) rank = index + 1;
    const row = element("tr"), identity = element("td");
    identity.append(teamStatisticsIdentity(team, names, "profilini göster"));
    row.append(element("td", "numeric statistics-rank", String(rank)), identity,
      element("td", "numeric statistics-value", format(accessor(team))));
    body.append(row);
  });
  if (!leaders.length) {
    const row = element("tr"), cell = element("td", "no-results", "Kayıtlı sonuç bulunamadı.");
    cell.colSpan = 3;
    row.append(cell);
    body.append(row);
  }
  $(bodyId).replaceChildren(body);
  $(noteId).textContent = leaders.length ? `İlk ${leaders.length} takım gösteriliyor.` : "";
}

function renderTeamStatisticsList(teams, names) {
  const query = $("team-statistics-search").value.trim().toLocaleLowerCase("tr");
  const [, , accessor] = TEAM_STATISTICS_SORTS.find(([key]) => key === $("team-statistics-sort").value)
    || TEAM_STATISTICS_SORTS[0];
  const visible = teams.filter((team) => !query || team.name.toLocaleLowerCase("tr").includes(query))
    .sort((a, b) => (accessor(b) ?? -Infinity) - (accessor(a) ?? -Infinity) || (a.position ?? 99) - (b.position ?? 99));
  $("team-statistics-list-count").textContent = `${visible.length} takım`;
  const body = document.createDocumentFragment();
  for (const team of visible) {
    const row = element("tr"), identity = element("td");
    identity.append(teamStatisticsIdentity(team, names, "profilini göster"));
    if (team.id === teamStatisticsState.selected) row.classList.add("statistics-row-selected");
    row.append(identity, element("td", "numeric", displayNumber(team.played)),
      element("td", "numeric", displayNumber(team.scored)), element("td", "numeric", displayNumber(team.conceded)),
      element("td", "numeric", displayNumber(team.points)));
    body.append(row);
  }
  if (!visible.length) {
    const row = element("tr"), cell = element("td", "no-results", "Bu aramayla takım bulunamadı.");
    cell.colSpan = 5;
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
  const entries = [
    ["Sıra", displayNumber(team.position)],
    ["Puan", displayNumber(team.points)],
    ["Maç", displayNumber(team.played)],
    ["G-B-M", [team.wins, team.draws, team.losses].every((value) => value !== null)
      ? `${team.wins}-${team.draws}-${team.losses}` : "—"],
    ["Averaj", team.difference === null ? "—" : `${team.difference > 0 ? "+" : ""}${displayNumber(team.difference)}`],
    ["Atılan gol", displayNumber(team.scored)],
    ["Yenilen gol", displayNumber(team.conceded)],
    ["Gol yemeden", displayNumber(team.cleanSheets)],
    ["xG", own.length ? displayNumber(teamStatisticsSum(own, "expected_goals")) : "—"],
    ["Rakibe verilen xG", own.length ? displayNumber(teamStatisticsSum(own, "expected_goals_against")) : "—"],
    ["Topla oynama", own.length && teamStatisticsSum(own, "ball_possession", true) !== null
      ? `%${displayNumber(teamStatisticsSum(own, "ball_possession", true))}` : "—"],
    ["Şut", own.length ? displayNumber(teamStatisticsSum(own, "shots_total")) : "—"],
  ];
  const list = document.createDocumentFragment();
  for (const [label, value] of entries) {
    const item = element("div");
    item.append(element("dt", "", label), element("dd", "", value));
    list.append(item);
  }
  $("team-statistics-facts-list").replaceChildren(list);
  $("team-statistics-facts-note").textContent = (team.unknownGames ? `${team.unknownGames} maçın skoru kayıtlı değil; gol yemeden sayılmadı. ` : "")
    + (teamMetricsState.state === "unavailable" ? teamMetricsState.message
      : own.length ? `xG, topla oynama ve şut ${own.length} maçın istatistiğinden.` : "");
}

function renderTeamStatisticsProfile(teams, names) {
  const selected = teams.find((team) => team.id === teamStatisticsState.selected)
    || [...teams].sort((a, b) => (a.position ?? 99) - (b.position ?? 99))[0];
  const panels = ["team-statistics-radar-chart", "team-statistics-detailed-chart", "team-statistics-radar-details",
    "team-statistics-detailed-details", "team-statistics-facts-list"];
  const notes = ["team-statistics-radar-note", "team-statistics-detailed-note", "team-statistics-facts-note"];
  if (!selected) {
    $("team-statistics-profile-name").textContent = "—";
    $("team-statistics-profile-note").textContent = "Puan durumunda takım bulunamadı.";
    for (const id of panels) $(id).replaceChildren();
    for (const id of notes) $(id).textContent = "";
    return;
  }
  teamStatisticsState.selected = selected.id;
  $("team-statistics-profile-name").textContent = selected.name;
  $("team-statistics-profile-note").textContent = "Listeden bir takıma tıklayarak profili değiştirin.";
  $("team-statistics-open-team").onclick = () => {
    location.href = `team.html?${new URLSearchParams({ id: selected.id, name: selected.name })}`;
  };
  // Only finished fixtures: a match the last download caught in play would
  // otherwise count with half its statistics.
  const finished = new Set((state.tables["fixtures.csv"] || []).filter((fixture) =>
    ["FT", "AET", "FT_PEN", "AWARDED", "WO"].includes(String(fixture["state.developer_name"] || fixture.state).toUpperCase()))
    .map((fixture) => String(fixture.fixture_id)));
  const rows = teamMetricsState.rows.filter((row) => finished.has(row.fixture_id));
  if (teamMetricsState.state === "ready" && typeof renderTeamRadars === "function") {
    renderTeamRadars(selected.id, rows, (id) => teamName(id, names));
  } else {
    for (const id of panels.slice(0, 4)) $(id).replaceChildren();
    const note = teamMetricsState.state === "unavailable" ? teamMetricsState.message
      : typeof renderTeamRadars !== "function" ? "Radar dosyaları yüklenemedi; src/web/serve.py'yi yeniden başlatıp sayfayı yenileyin."
        : "Takım maç istatistikleri yükleniyor…";
    for (const id of ["team-statistics-radar-note", "team-statistics-detailed-note"]) $(id).textContent = note;
  }
  renderTeamStatisticsFacts(selected, rows);
}

function renderTeamStatistics() {
  if (teamMetricsState.key !== state.seasonSlug) loadTeamMetrics();
  const { names, list } = teamStatisticsTeams();
  renderTeamStatisticsCard("team-statistics-scored-body", "team-statistics-scored-note", list, names,
    (team) => team.scored, (value) => displayNumber(value));
  renderTeamStatisticsCard("team-statistics-conceded-body", "team-statistics-conceded-note", list, names,
    (team) => team.conceded, (value) => displayNumber(value), true);
  renderTeamStatisticsCard("team-statistics-clean-body", "team-statistics-clean-note", list, names,
    (team) => team.cleanSheets, (value) => displayNumber(value));
  renderTeamStatisticsList(list, names);
  renderTeamStatisticsProfile(list, names);
  if (typeof renderTeamAnalysis === "function") renderTeamAnalysis(list, names);
}

function setupTeamStatistics() {
  $("team-statistics-search").addEventListener("input", renderTeamStatistics);
  $("team-statistics-sort").addEventListener("change", renderTeamStatistics);
  if (typeof setupTeamAnalysis === "function") setupTeamAnalysis();
}
