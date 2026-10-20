"use strict";

const matchweekResults = { season: "", completed: new Map(), metrics: [], metricsStatus: "idle", request: 0 };
// The live feed can send a final state as its Sportmonks id rather than its name.
const matchweekFinalStateIds = new Map([["5", "FT"], ["7", "AET"], ["8", "FT_PEN"]]);

function matchweekFinalState(fixture) {
  const code = String(fixture.state).toUpperCase();
  return matchweekFinalStateIds.get(code) || code;
}

// The site's one definition of a finished match (core/match-rules.js).
function matchweekFinished(fixture) {
  return FINISHED_STATES.has(matchweekFinalState(fixture));
}

function resetMatchweekResults() {
  if (matchweekResults.season !== state.seasonSlug || !state.seasonSlug) matchweekResults.completed.clear();
  Object.assign(matchweekResults, { season: state.seasonSlug, metrics: [], metricsStatus: "idle", request: matchweekResults.request + 1 });
}

function matchweekCompletedSnapshot(fixture) {
  if (!state.seasonSlug || matchweekResults.season !== state.seasonSlug) return null;
  const rows = matchweekResults.completed.get(fixture.fixture_id);
  const game = rows?.find((row) => row.record_type === "fixture");
  return game && game.league_id === fixture.league_id && game.season_id === fixture.season_id && game.home_team_id === fixture.home_team_id
    && game.away_team_id === fixture.away_team_id ? rows : null;
}

function matchweekEffectiveFixture(fixture) {
  const game = matchweekCompletedSnapshot(fixture)?.find((row) => row.record_type === "fixture");
  return game ? { ...fixture, state: game.state } : fixture;
}

function ingestMatchweekResults(rows) {
  if (matchweekResults.season !== state.seasonSlug) resetMatchweekResults();
  let changed = false;
  for (const fixture of rows.filter((row) => row.record_type === "fixture" && matchweekFinished(row))) {
    const saved = (state.tables["fixtures.csv"] || []).find((row) => row.fixture_id === fixture.fixture_id);
    if (!saved || saved.league_id !== fixture.league_id || saved.season_id !== fixture.season_id || saved.home_team_id !== fixture.home_team_id || saved.away_team_id !== fixture.away_team_id) continue;
    const next = rows.filter((row) => row.fixture_id === fixture.fixture_id);
    const previous = matchweekResults.completed.get(fixture.fixture_id);
    if (!previous || next.length !== previous.length || next.some((row, index) =>
      Object.keys(row).some((key) => row[key] !== previous[index]?.[key]))) {
      matchweekResults.completed.set(fixture.fixture_id, next);
      changed = true;
    }
  }
  if (changed && state.view === "matchweek") renderMatchweek();
}

function matchweekFinalScore(fixture) {
  const snapshot = matchweekCompletedSnapshot(fixture)?.find((row) => row.record_type === "fixture");
  const saved = snapshot ? null : currentFixtureScores();
  const values = snapshot ? [snapshot.home_score, snapshot.away_score]
    : [saved.get(`${fixture.fixture_id}:${fixture.home_team_id}`), saved.get(`${fixture.fixture_id}:${fixture.away_team_id}`)];
  return values.map((value) => {
    const score = number(value);
    return score !== null && Number.isInteger(score) && score >= 0 ? String(score) : "—";
  }).join(" – ");
}

function matchweekResultBadge(fixture) {
  const badge = element("span", "matchweek-result");
  badge.append(element("strong", "", matchweekFinalScore(fixture)),
    element("small", "", fixtureStateLabel({ state: matchweekFinalState(fixture) })));
  return badge;
}

async function loadMatchweekResultMetrics() {
  if (!state.seasonSlug || matchweekResults.metricsStatus !== "idle") return;
  const season = state.seasonSlug, request = ++matchweekResults.request;
  matchweekResults.metricsStatus = "loading";
  try {
    const rows = await readFantasyCSV("team_metrics.csv", ["fixture_id", "team_id", "type_id", "value"], season, true);
    if (request !== matchweekResults.request || season !== state.seasonSlug) return;
    matchweekResults.metrics = rows || [];
    matchweekResults.metricsStatus = rows ? "ready" : "unavailable";
  } catch {
    if (request !== matchweekResults.request || season !== state.seasonSlug) return;
    matchweekResults.metricsStatus = "unavailable";
  }
  if (state.view === "matchweek") renderMatchweek();
}

function matchweekResultPlayers(fixture) {
  const snapshot = matchweekCompletedSnapshot(fixture);
  if (snapshot?.some((row) => row.record_type === "lineup")) {
    return snapshot.filter((row) => row.record_type === "lineup").map((row) => ({ ...row, name: row.player_name }));
  }
  return (state.tables["player_match_stats.csv"] || []).filter((row) => row.fixture_id === fixture.fixture_id);
}

function matchweekResultStatistics(fixture, teams) {
  const snapshot = matchweekCompletedSnapshot(fixture);
  const confirmed = snapshot?.filter((row) => row.record_type === "statistic") || [];
  if (!confirmed.length) loadMatchweekResultMetrics();
  const rows = confirmed.length ? confirmed : matchweekResults.metrics
    .filter((row) => row.fixture_id === fixture.fixture_id && (!row.source || row.source === "statistics"));
  const section = element("section"), table = element("table", "matchweek-comparison");
  table.append(element("caption", "", "Bu maçın istatistikleri"));
  const head = element("thead"), titles = element("tr"), body = element("tbody");
  [teamName(fixture.home_team_id, teams), "İstatistik", teamName(fixture.away_team_id, teams)].forEach((label) => {
    const cell = element("th", "", label); cell.scope = "col"; titles.append(cell);
  });
  head.append(titles);
  for (const [type, label, percent] of liveStatistics) {
    const row = element("tr"), title = element("th", "", label); title.scope = "row";
    const values = [fixture.home_team_id, fixture.away_team_id].map((team) => {
      const matching = rows.filter((metric) => metric.team_id === team && metric.type_id === String(type));
      const value = matching.length === 1 ? number(matching[0].value) : null;
      return value === null || value < 0 || (percent && value > 100) ? "—" : percent ? percentText(value) : displayNumber(value);
    });
    row.append(element("td", "", values[0]), title, element("td", "", values[1])); body.append(row);
  }
  table.append(head, body); section.append(table);
  section.append(element("p", "message", !confirmed.length && matchweekResults.metricsStatus === "loading"
    ? "Maç istatistikleri yükleniyor…" : "Seçilen maçın Sportmonks istatistikleri. — henüz sağlanmayan veya doğrulanamayan değer."));
  return section;
}

function matchweekFantasyPlayers(fixture, team, players) {
  const available = state.seasonSlug && fantasyState.season === state.seasonSlug;
  const ledger = available ? [...fantasyState.matches.values()].flat()
    .filter((row) => row.fixture_id === fixture.fixture_id && row.season === state.seasonSlug) : [];
  const candidates = new Map();
  for (const player of players) {
    if (player.fixture_id === fixture.fixture_id && player.team_id === team && player.player_id && (["1", "true"].includes(String(player.started).toLowerCase()) || number(player.minutes_played) > 0)) {
      candidates.set(player.player_id, playerName(player.player_id, player.name));
    }
  }
  for (const row of ledger) {
    if (row.team_id === team && row.player_id && !candidates.has(row.player_id)) candidates.set(row.player_id, playerName(row.player_id, row.player_name));
  }
  const opponent = fixture.home_team_id === team ? fixture.away_team_id : fixture.home_team_id;
  return [...candidates].map(([id, name]) => {
    const matching = ledger.filter((row) => row.player_id === id);
    const entry = matching.length === 1 && matching[0].team_id === team && matching[0].opponent_id === opponent ? matching[0] : null;
    return { id, name, points: number(entry?.points_total) };
  }).sort((a, b) => (b.points ?? -Infinity) - (a.points ?? -Infinity) || a.name.localeCompare(b.name, "tr"));
}

function matchweekResultFantasyPoints(fixture, teams, players) {
  const section = element("section", "matchweek-result-players");
  section.append(element("h3", "", "Fantezi Lig · Oyuncu Puanları"));
  for (const team of [fixture.home_team_id, fixture.away_team_id]) {
    const table = element("table", "matchweek-comparison");
    table.append(element("caption", "", teamName(team, teams)));
    const head = element("thead"), titles = element("tr"), body = element("tbody");
    for (const label of ["Oyuncu", "Fantezi puanı"]) {
      const cell = element("th", "", label); cell.scope = "col"; titles.append(cell);
    }
    head.append(titles);
    const eligible = matchweekFantasyPlayers(fixture, team, players);
    for (const player of eligible) {
      const row = element("tr");
      row.append(element("td", "", player.name), element("td", "", player.points === null ? "—" : displayNumber(player.points)));
      body.append(row);
    }
    if (!eligible.length) { const cell = element("td", "message", "Bu maçın fantezi oyuncu puanları henüz yayımlanmadı."); cell.colSpan = 2; const row = element("tr"); row.append(cell); body.append(row); }
    table.append(head, body); section.append(table);
  }
  section.append(element("p", "message", "Seçilen maçın kaydedilmiş fantezi puanları · Bonus dahil. — henüz yayımlanmayan veya doğrulanamayan puan."));
  return section;
}

function renderMatchweekResult(fixture, teams, content) {
  // Laid out like an upcoming match's analysis: no repeated scoreline (the row
  // above shows it), statistics beside this match's elevens, the extra tables
  // side by side, and the explanation folded away.
  const players = matchweekResultPlayers(fixture), lineups = element("div", "matchweek-lineups");
  [fixture.home_team_id, fixture.away_team_id].forEach((id, index) => {
    if (index) lineups.append(element("span", "matchweek-versus", "VS"));
    lineups.append(matchweekLastXI(id, fixture, teams, { players, title: "İlk 11 · Bu maç" }));
  });
  const overview = element("div", "matchweek-analysis-grid");
  overview.append(matchweekResultStatistics(fixture, teams), lineups);
  const extra = element("div", "matchweek-analysis-extra");
  extra.append(matchweekResultFantasyPoints(fixture, teams, players), matchweekLeagueComparison(fixture, teams));
  content.append(overview, extra);
  const snapshot = matchweekCompletedSnapshot(fixture);
  if (snapshot) {
    const events = element("section", "live-events matchweek-result-events"), list = element("ol");
    list.tabIndex = 0;
    list.setAttribute("aria-label", "Bu maçın olayları, en yeni önce");
    renderLiveEvents(snapshot.find((row) => row.record_type === "fixture"), teams, snapshot, list);
    events.append(element("h3", "", "Maç olayları"), list); content.append(events);
  }
  const notes = element("details", "matchweek-notes");
  notes.append(element("summary", "", "Açıklamalar"), element("p", "", "İlk 11 bu maçın kayıtlarına aittir."));
  content.append(notes);
}
