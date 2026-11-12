"use strict";

const standingsMetrics = [
  ["overall_matches", "played"], ["overall_wins", "wins"],
  ["overall_draws", "draws"], ["overall_lost", "losses"],
  ["overall_scored", "scored"], ["overall_conceded", "conceded"],
  ["overall_goal_difference", "difference"],
];

const europeanPlaces = new Map([
  [1, { competition: "ucl", label: t("UEFA Şampiyonlar Ligi") }],
  [2, { competition: "ucl", label: t("UEFA Şampiyonlar Ligi") }],
  [3, { competition: "uel", label: t("UEFA Avrupa Ligi") }],
  [4, { competition: "uecl", label: t("UEFA Konferans Ligi") }],
]);
// A result is kept as G, B or M (galibiyet, beraberlik, mağlubiyet) and shown
// as the page's language writes it: W, D, L in English.
const RESULT_LETTERS = { G: t("G"), B: t("B"), M: t("M") };

// The position cell carries the European-place marker on its left edge, so the
// table needs no separate marker column (which read as an empty gap).
function qualificationCell(position) {
  const place = europeanPlaces.get(number(position));
  const cell = element("td", `standing-position qualification-spot${place ? ` qualification-${place.competition}` : ""}`, displayNumber(position));
  if (place) {
    cell.title = place.label;
    cell.setAttribute("aria-label", place.label);
    cell.append(element("span", "qualification-marker"));
  }
  return cell;
}

function standingResults(standing, scores) {
  const fixtures = (state.tables["fixtures.csv"] || []).filter((fixture) =>
    [fixture.home_team_id, fixture.away_team_id].includes(standing.participant_id)
    && (!standing.season_id || fixture.season_id === standing.season_id)
    && (!standing.league_id || fixture.league_id === standing.league_id)
    && (!standing.stage_id || fixture.stage_id === standing.stage_id)
    && (!standing.group_id || fixture.group_id === standing.group_id));
  const finished = fixtures.filter(fixtureFinished)
    .sort((a, b) => String(a.kickoff || "").localeCompare(String(b.kickoff || "")) || a.fixture_id.localeCompare(b.fixture_id));
  const games = finished.map((fixture) => {
    const home = scores.get(`${fixture.fixture_id}:${fixture.home_team_id}`);
    const away = scores.get(`${fixture.fixture_id}:${fixture.away_team_id}`);
    const valid = [home, away].every((value) => Number.isInteger(value) && value >= 0);
    const isHome = fixture.home_team_id === standing.participant_id;
    const own = isHome ? home : away, other = isHome ? away : home;
    return { fixture, opponent: isHome ? fixture.away_team_id : fixture.home_team_id, isHome, valid, own, other, result: !valid ? "—" : own > other ? "G" : own < other ? "M" : "B" };
  });
  const officialPlayed = number(standing["details.overall_matches"]);
  const complete = fixtures.length > 0 && games.every((game) => game.valid) && (officialPlayed === null || officialPlayed === games.length);
  const sum = (fn) => complete ? games.reduce((total, game) => total + fn(game), 0) : null;
  const values = {
    played: fixtures.length ? games.length : null,
    wins: sum((game) => game.result === "G" ? 1 : 0),
    draws: sum((game) => game.result === "B" ? 1 : 0),
    losses: sum((game) => game.result === "M" ? 1 : 0),
    scored: sum((game) => game.own), conceded: sum((game) => game.other),
    difference: sum((game) => game.own - game.other),
  };
  return { games, values };
}

// One figure of a club's record as a table cell: Sportmonks' own, or when it
// gives none, the count from the saved results if they are complete, marked
// with an asterisk. `results` is a function, so the results are only worked
// out when they are needed. Puan Durumu and Ana Sayfa's table both use it.
function standingFigureCell(row, metric, derivedKey, results, increment = 0) {
  let official = number(row[`details.${metric}`]);
  // Goal difference can also be obtained from the provider's two goal totals.
  if (metric === "overall_goal_difference" && official === null) {
    const scored = number(row["details.overall_scored"]), conceded = number(row["details.overall_conceded"]);
    if (scored !== null && conceded !== null) official = scored - conceded;
  }
  const value = official ?? results().values[derivedKey] ?? null;
  const fromResults = official === null && value !== null;
  const cell = element("td", "numeric", displayNumber(value === null ? null : value + increment) + (fromResults ? "*" : ""));
  cell.title = value === null ? t("Veri eksik veya sonuçlar tamamlanmamış.") : fromResults ? t("Kaydedilmiş tamamlanan maçlardan hesaplandı.") : t("Sportmonks puan tablosu verisi.");
  if (value !== null && increment) cell.title += ` · ${t("Geçici puan durumu")}`;
  return cell;
}

function detailedStandingsFeed() {
  const rows = liveCentre.rows.filter((row) => row.record_type === "fixture");
  if (matchweekResults.season === state.seasonSlug) {
    for (const confirmed of matchweekResults.completed.values()) {
      const fixture = confirmed.find((row) => row.record_type === "fixture");
      if (fixture) rows.push(fixture);
    }
  }
  return rows;
}

function addStandingMatch(identity, name, entry, teams, id, showMinute = true) {
  const score = `${displayNumber(entry.own)}–${displayNumber(entry.other)}`;
  const opponent = homeShortName(entry.opponentId, teams);
  const minute = showMinute && entry.live ? liveMinute(entry.game) : "";
  const match = element("small", "standing-match", [score, opponent, minute].filter(Boolean).join(" · "));
  match.id = id;
  match.title = `${score} · ${entry.opponent}`;
  identity.setAttribute("aria-describedby", id);
  const label = element("span", "standing-team-label");
  name.replaceWith(label);
  label.append(name, match);
}

function renderDetailedStandings() {
  const teams = homeTeams();
  const source = state.tables["standings.csv"] || [];
  const groups = [...new Set(source.map(standingGroupKey))];
  if (!groups.includes(state.standingsGroup)) state.standingsGroup = groups[0] ?? null;
  const groupRows = source.filter((row) => standingGroupKey(row) === state.standingsGroup);
  const rows = groupRows.sort((a, b) => (number(a.position) ?? Infinity) - (number(b.position) ?? Infinity) || teamName(a.participant_id, teams).localeCompare(teamName(b.participant_id, teams), LOCALE));
  const local = siteMode === "local" && Boolean(state.seasonSlug);
  const simulated = local && homeSimulationActive() && homeSimulation.session.fixtures === state.tables["fixtures.csv"];
  const live = simulated ? homeSimulationStandings(rows) : local ? matchweekLiveStandings(rows, detailedStandingsFeed()) : null;
  const status = $("detailed-standings-live");
  const inPlay = live && [...live.teams.values()].some((entry) => entry.live);
  const message = simulated ? (inPlay ? t("Simülasyon · Canlı") : t("Simülasyon · Geçici puan durumu"))
    : live ? (inPlay ? t("Canlı puan durumu") : t("Geçici puan durumu"))
    : local && liveCentre.meta?.status === "unavailable" ? t("Canlı veriler şu anda alınamıyor.") : "";
  if (status.textContent !== message) status.textContent = message;
  status.hidden = !message;
  const standingsBody = $("detailed-standings-body"), active = document.activeElement;
  const focusedLink = standingsBody.contains(active) ? active.getAttribute("href") : null;
  const body = document.createDocumentFragment();
  const scores = currentFixtureScores();
  for (const [index, row] of (live?.order || rows).entries()) {
    const tr = element("tr");
    const clubCell = element("td");
    const identity = createTeamLink(row.participant_id, teamName(row.participant_id, teams), "standing-club");
    const name = element("span", "", teamName(row.participant_id, teams));
    identity.replaceChildren(createTeamLogo(row.participant_id, teams, false), name);
    clubCell.append(identity);
    const entry = live?.teams.get(String(row.participant_id));
    if (entry) addStandingMatch(identity, name, entry, teams, `detailed-standing-match-${row.participant_id}`);
    tr.append(qualificationCell(live ? index + 1 : row.position), clubCell);
    const results = standingResults(row, scores);
    const increments = { played: entry?.played, wins: entry?.won, draws: entry?.draws, losses: entry?.losses,
      scored: entry?.goalsFor, conceded: entry?.goalsAgainst, difference: entry?.goalDifference };
    for (const [metric, derivedKey] of standingsMetrics) tr.append(standingFigureCell(row, metric, derivedKey, () => results, increments[derivedKey]));
    const points = element("td", `numeric detailed-points${entry ? ` standing-live standing-live-${entry.status}` : ""}`,
      displayNumber(entry ? entry.points : row.points));
    points.title = entry ? `${displayNumber(entry.base)} + ${displayNumber(entry.gained)} · ${displayNumber(entry.own)}–${displayNumber(entry.other)} ${entry.opponent} (${entry.live ? t("sürüyor") : t("bitti, kayda girmedi")})`
      : simulated && live ? t("Simülasyon · Geçici puan durumu") : t("Sportmonks tarafından verilen puan; yeniden hesaplanmaz.");
    tr.append(points);
    const formCell = element("td"), form = element("div", "standings-form");
    for (const game of results.games.slice(-5)) {
      const link = element("a", `form-result form-${game.result === "G" ? "win" : game.result === "M" ? "loss" : game.result === "B" ? "draw" : "unknown"}`, RESULT_LETTERS[game.result] || game.result);
      link.href = `team.html?${new URLSearchParams({ id: row.participant_id, name: teamName(row.participant_id, teams), match: game.fixture.fixture_id })}`;
      const label = `${kickoffText(game.fixture)} · ${teamName(game.opponent, teams)} · ${game.isHome ? t("İç saha") : t("Deplasman")} · ${game.valid ? `${game.own}–${game.other}` : t("Skor yok")}`;
      link.title = label;
      link.setAttribute("aria-label", `${label} · ${t("Maç detaylarını aç")}`);
      form.append(link);
    }
    if (!results.games.length) form.append(element("span", "", "—"));
    formCell.append(form); tr.append(formCell); body.append(tr);
  }
  if (!rows.length) {
    const tr = element("tr"), cell = element("td", "no-results", t("Puan tablosu için standings.csv dosyasını yükleyin."));
    cell.colSpan = 11; tr.append(cell); body.append(tr);
  }
  standingsBody.replaceChildren(body);
  if (focusedLink) [...standingsBody.querySelectorAll("a[href]")].find((link) => link.getAttribute("href") === focusedLink)?.focus({ preventScroll: true });
}

function setupDetailedStandings() {}
