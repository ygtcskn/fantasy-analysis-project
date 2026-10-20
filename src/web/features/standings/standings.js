"use strict";

const standingsMetrics = [
  ["overall_matches", "played"], ["overall_wins", "wins"],
  ["overall_draws", "draws"], ["overall_lost", "losses"],
  ["overall_scored", "scored"], ["overall_conceded", "conceded"],
  ["overall_goal_difference", "difference"],
];

const europeanPlaces = new Map([
  [1, { competition: "ucl", label: "UEFA Şampiyonlar Ligi" }],
  [2, { competition: "ucl", label: "UEFA Şampiyonlar Ligi" }],
  [3, { competition: "uel", label: "UEFA Avrupa Ligi" }],
  [4, { competition: "uecl", label: "UEFA Konferans Ligi" }],
]);

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

function renderDetailedStandings() {
  const teams = homeTeams();
  const source = state.tables["standings.csv"] || [];
  const groups = [...new Set(source.map(standingGroupKey))];
  if (!groups.includes(state.standingsGroup)) state.standingsGroup = groups[0] ?? null;
  const groupRows = source.filter((row) => standingGroupKey(row) === state.standingsGroup);
  const rows = groupRows.sort((a, b) => (number(a.position) ?? Infinity) - (number(b.position) ?? Infinity) || teamName(a.participant_id, teams).localeCompare(teamName(b.participant_id, teams), "tr"));
  const body = document.createDocumentFragment();
  const scores = currentFixtureScores();
  for (const row of rows) {
    const tr = element("tr");
    const clubCell = element("td");
    const identity = createTeamLink(row.participant_id, teamName(row.participant_id, teams), "standing-club");
    identity.replaceChildren(createTeamLogo(row.participant_id, teams, false), element("span", "", teamName(row.participant_id, teams)));
    clubCell.append(identity);
    tr.append(qualificationCell(row.position), clubCell);
    const results = standingResults(row, scores);
    for (const [metric, derivedKey] of standingsMetrics) {
      let official = number(row[`details.${metric}`]);
      // Goal difference can also be obtained from the provider's two goal totals.
      if (metric === "overall_goal_difference" && official === null) {
        const scored = number(row["details.overall_scored"]), conceded = number(row["details.overall_conceded"]);
        if (scored !== null && conceded !== null) official = scored - conceded;
      }
      const value = official ?? results.values[derivedKey];
      const fromResults = official === null && value !== null;
      const cell = element("td", "numeric", displayNumber(value) + (fromResults ? "*" : ""));
      cell.title = value === null ? "Veri eksik veya sonuçlar tamamlanmamış." : fromResults ? "Kaydedilmiş tamamlanan maçlardan hesaplandı." : "Sportmonks puan tablosu verisi.";
      tr.append(cell);
    }
    const points = element("td", "numeric detailed-points", displayNumber(row.points));
    points.title = "Sportmonks tarafından verilen puan; yeniden hesaplanmaz.";
    tr.append(points);
    const formCell = element("td"), form = element("div", "standings-form");
    for (const game of results.games.slice(-5)) {
      const link = element("a", `form-result form-${game.result === "G" ? "win" : game.result === "M" ? "loss" : game.result === "B" ? "draw" : "unknown"}`, game.result);
      link.href = `team.html?${new URLSearchParams({ id: row.participant_id, name: teamName(row.participant_id, teams), match: game.fixture.fixture_id })}`;
      const label = `${kickoffText(game.fixture)} · ${teamName(game.opponent, teams)} · ${game.isHome ? "İç saha" : "Deplasman"} · ${game.valid ? `${game.own}–${game.other}` : "Skor yok"}`;
      link.title = label;
      link.setAttribute("aria-label", `${label} · Maç detaylarını aç`);
      form.append(link);
    }
    if (!results.games.length) form.append(element("span", "", "—"));
    formCell.append(form); tr.append(formCell); body.append(tr);
  }
  if (!rows.length) {
    const tr = element("tr"), cell = element("td", "no-results", "Puan tablosu için standings.csv dosyasını yükleyin.");
    cell.colSpan = 11; tr.append(cell); body.append(tr);
  }
  $("detailed-standings-body").replaceChildren(body);
}

function setupDetailedStandings() {}
