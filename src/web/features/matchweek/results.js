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
  // Ana Sayfa's match statistics read the same rows.
  if (state.view === "matchweek") renderMatchweek();
  if (state.view === "home") renderHome();
}

function matchweekResultPlayers(fixture) {
  const snapshot = matchweekCompletedSnapshot(fixture);
  if (snapshot?.some((row) => row.record_type === "lineup")) {
    return snapshot.filter((row) => row.record_type === "lineup").map((row) => ({ ...row, name: row.player_name }));
  }
  return (state.tables["player_match_stats.csv"] || []).filter((row) => row.fixture_id === fixture.fixture_id);
}

// One statistic of one match for both sides, from one feed's rows (team_id,
// type_id, value). Sportmonks leaves a card count out when it is zero: for a
// side with this match's statistics recorded, a missing card count is 0.
// Anything else missing, duplicated or out of range is unknown (null).
function matchweekStatisticValues(rows, sides, type, percent = false) {
  const cardTypes = new Set(["84", "83", "85"]);
  return sides.map((team) => {
    const matching = rows.filter((metric) => metric.team_id === team && metric.type_id === String(type));
    if (!matching.length && cardTypes.has(String(type)) && rows.some((metric) => metric.team_id === team)) return 0;
    const value = matching.length === 1 ? number(matching[0].value) : null;
    return value === null || value < 0 || (percent && value > 100) ? null : value;
  });
}

// This match's Sportmonks statistics, home against away, each with a bar.
function matchweekResultStatisticsCard(fixture, sides, teams) {
  const snapshot = matchweekCompletedSnapshot(fixture);
  const confirmed = snapshot?.filter((row) => row.record_type === "statistic") || [];
  if (!confirmed.length) loadMatchweekResultMetrics();
  const rows = confirmed.length ? confirmed : matchweekResults.metrics
    .filter((row) => row.fixture_id === fixture.fixture_id && (!row.source || row.source === "statistics"));
  const section = matchweekCard("matchweek-preview-wide", t("Maç istatistikleri"));
  section.append(matchweekVersusHeader(sides, teams));
  for (const [type, label, percent] of liveStatistics) {
    const values = matchweekStatisticValues(rows, sides, type, percent);
    section.append(matchweekVersusRow(label, values.map((value) => ({
      value: value === null ? "—" : percent ? percentText(value) : displayNumber(value), note: "" })), values));
  }
  if (!confirmed.length && matchweekResults.metricsStatus === "loading") section.append(element("p", "message", t("Maç istatistikleri yükleniyor…")));
  return section;
}

// Each side's players in this match from the fantasy ledger, best first:
// fantasy points (bonus included), position and Sportmonks match rating.
function matchweekMatchFantasy(fixture) {
  const sides = [fixture.home_team_id, fixture.away_team_id];
  return sides.map((team, index) => {
    if (!state.seasonSlug || fantasyState.season !== state.seasonSlug) return [];
    const players = [];
    for (const [id, rows] of fantasyState.matches) {
      const row = rows.find((item) => item.fixture_id === fixture.fixture_id && item.team_id === team && item.opponent_id === sides[1 - index]);
      const points = number(row?.points_total);
      if (points === null) continue;
      players.push({ id, name: playerName(id, row.player_name), position: row.fantasy_position, points,
        rating: validMatchRating(row), minutes: number(row.minutes_played) });
    }
    return players.sort((a, b) => b.points - a.points || (b.rating ?? 0) - (a.rating ?? 0) || a.name.localeCompare(b.name, LOCALE));
  });
}

function renderMatchweekResult(fixture, teams, content) {
  // The same cards as an upcoming match's analysis, told from the result:
  // this match's elevens and statistics, the season around it, then the
  // fantasy points the match itself produced. The row above shows the score.
  const sides = [fixture.home_team_id, fixture.away_team_id];
  const players = matchweekResultPlayers(fixture), scores = currentFixtureScores();
  const histories = sides.map((id) => matchweekTeamHistory(id, fixture));
  const xi = matchweekElevensCard(sides, t("Bu maçın ilk 11'leri"), (id) => matchweekLastXI(id, fixture, teams, { players, title: t("İlk 11 · Bu maç") }));

  const fantasy = matchweekMatchFantasy(fixture);
  const fantasyCard = matchweekCard("matchweek-preview-fantasy", t("Fantezi puanları · Bu maç"));
  fantasyCard.append(matchweekVersusHeader(sides, teams));
  for (const [key, label] of [["ALL", t("Takım toplamı")], ["KL", t("Kaleci")], ["DEF", t("Defans")], ["OS", t("Orta saha")], ["FOR", t("Forvet")]]) {
    const values = fantasy.map((team) => team.length
      ? team.filter((player) => key === "ALL" || player.position === key).reduce((sum, player) => sum + player.points, 0) : null);
    fantasyCard.append(matchweekVersusRow(label, values.map((value) => ({ value: value === null ? "—" : displayNumber(value), note: "" })),
      values.every((value) => value !== null && value >= 0) ? values : null));
  }
  const best = sides.map((id, index) => matchweekPlayersCard(id, index, teams, t("Maçın en iyileri"), fantasy[index].slice(0, 5),
    t("Bu maçın fantezi puanları henüz yayımlanmadı."),
    (player) => `${player.name} · ${player.position ? fantasyPositionCode(player.position) : t("Mevki yok")}${player.minutes === null ? "" : ` · ${t("{minutes} dk", { minutes: displayNumber(player.minutes) })}`}`));

  const cards = [xi, matchweekResultStatisticsCard(fixture, sides, teams), matchweekSeasonStatsCard(fixture, sides, teams),
    matchweekFormCard(sides, histories, teams, scores), matchweekTrendCard(fixture, sides, teams), fantasyCard, ...best];
  const snapshot = matchweekCompletedSnapshot(fixture);
  if (snapshot) {
    const events = matchweekCard("matchweek-preview-wide live-events", t("Maç olayları")), list = element("ol");
    list.tabIndex = 0;
    list.setAttribute("aria-label", t("Bu maçın olayları, en yeni önce"));
    renderLiveEvents(snapshot.find((row) => row.record_type === "fixture"), teams, snapshot, list);
    events.append(list); cards.push(events);
  }
  const notes = element("details", "matchweek-notes");
  notes.append(element("summary", "", t("Açıklamalar")),
    element("p", "", t("İlk 11 ve maç istatistikleri bu maçın Sportmonks kayıtlarıdır. — henüz sağlanmayan veya doğrulanamayan değer.")),
    element("p", "", matchweekSeasonStatsNote),
    element("p", "", matchweekFormNote),
    element("p", "", t("Fantezi puanları bu maçın kaydedilmiş oyuncu puanlarıdır (bonus dahil); mevki satırları o mevkideki oyuncuların toplamıdır. Maçın en iyileri bu maçta en çok fantezi puanı (FP) alan oyunculardır; reyting, oyuncunun bu maçtaki Sportmonks reytingidir.")),
    element("p", "", matchweekTrendNote));
  content.append(matchweekCardGrid(sides, cards), notes);
}
