"use strict";

// Page wiring for the two team spider plots on Takım İstatistikleri. The same
// scoring, reference, principal components, chart and tooltips
// as the player plots, over RadarTeams. Depends on radar.js, on the shared
// helpers in radar-page.js and on the page helpers ($, element, displayNumber,
// state).

// Earlier seasons widen the population a team is ranked against; the plotted
// team is always measured on the served season alone. Each earlier season is
// read once, in the background, reduced to per-team tallies and released. The
// feed-availability rule is the player plots' rule: a column an earlier season
// clearly did not supply - xG before 2024-25, for one - is unknown there, not
// zero.
// Like the player history, earlier seasons are cut to the rounds the served
// season has reached, so seven matches are compared with seven matches.
const teamHistory = { key: null, rounds: null, state: "idle", teams: [], seasons: [], unsupplied: {}, message: "" };

async function loadTeamHistory(currentRows) {
  const served = state.seasonSlug, key = statisticsHistoryKey(), rounds = statisticsHistoryRounds();
  if (!key || teamHistory.key === key) return;
  Object.assign(teamHistory, { key, rounds, state: "loading", teams: [], seasons: [], unsupplied: {}, message: "" });
  try {
    const seasons = (await statisticsHistoryCSV("seasons.csv")).map((row) => row.season)
      .filter((season) => /^\d{4}-\d{4}$/.test(season) && season < served);
    const reference = statisticsFillRates(currentRows, RadarTeams.columns());
    const metrics = Object.values(RadarTeams.metrics), teams = [], used = [], unsupplied = {};
    for (const season of seasons) {
      // A season downloaded before team statistics were captured is skipped,
      // not treated as a failure of the whole history.
      const [fixtures, records] = await Promise.all([statisticsHistoryCSV(`${season}/fixtures.csv`),
        statisticsHistoryCSV(`${season}/spider_stats.csv`).catch(() => null)]);
      if (teamHistory.key !== key) return;
      if (!records) continue;
      const rows = spiderRows(records, "team");
      const missing = statisticsUnsupplied(statisticsFillRates(rows, [...reference.rates.keys()]), reference);
      for (const row of rows) for (const column of missing) delete row[column];
      if (missing.length) unsupplied[season] = missing;
      const windowed = RadarScoring.throughRound(fixtures, rounds);
      for (const scope of RadarScoring.scopes(windowed)) {
        for (const team of RadarTeams.entities(rows, windowed, scope)) {
          teams.push({ ...team, id: `${season}:${team.id}`, teamId: team.id, season, rows: [],
            tallies: new Map(metrics.map((metric) => [metric.id, RadarScoring.tally(team, metric)])) });
        }
      }
      used.push(season);
    }
    Object.assign(teamHistory, { state: "ready", teams, seasons: used, unsupplied });
  } catch (error) {
    if (teamHistory.key !== key) return;
    Object.assign(teamHistory, { state: "unavailable", teams: [], seasons: [],
      message: error.message === "missing"
        ? "Sunucu önceki sezonları henüz sunmuyor; src/web/serve.py'yi yeniden başlatın."
        : "Önceki sezonlar okunamadı." });
  }
  if (state.view === "team-statistics" && statisticsHistoryKey() === key) renderTeamStatistics();
}

// Both wheels share one reference per render, with no settings: the served
// season and competition, every team that has played at least half as many
// matches as the busiest, and - once loaded - every earlier season. They read
// the prepared spider rows; RadarTeams.entities keeps finished fixtures only.
function renderTeamRadars(teamId, names) {
  const charts = ["team-statistics-radar-chart", "team-statistics-detailed-chart",
    "team-statistics-radar-details", "team-statistics-detailed-details"];
  const clear = (note) => {
    for (const id of charts) $(id).replaceChildren();
    for (const id of ["team-statistics-radar-note", "team-statistics-detailed-note"]) {
      $(id).textContent = note;
      $(id).hidden = !note;
    }
  };
  if (spiderStatsState.key !== state.seasonSlug) loadSpiderStats();
  if (spiderStatsState.state !== "ready") {
    clear(spiderStatsState.state === "unavailable" ? spiderStatsState.message : "Radar verileri yükleniyor…");
    return;
  }
  const rows = spiderStatsState.teams;
  const fixtures = state.tables["fixtures.csv"] || [];
  const played = new Set(rows.filter((row) => row.team_id === teamId).map((row) => row.fixture_id));
  const scope = RadarScoring.fixtureScope(fixtures.find((fixture) => played.has(String(fixture.fixture_id))
    && RadarScoring.fixtureScope(fixture))) || RadarScoring.scopes(fixtures)[0];
  const entities = RadarTeams.entities(rows, fixtures, scope).map((team) => ({ ...team, name: names(team.id) }));
  const target = entities.find((team) => team.id === teamId);
  if (!scope || !target) {
    clear(!scope ? "Radar için fikstürlerde sezon ve lig kimliği gerekli." : "Bu takım için kayıtlı maç istatistiği yok.");
    return;
  }
  const config = { minimumMinutes: statisticsSuggestedMinutes(entities) };
  if (teamHistory.key !== statisticsHistoryKey()) loadTeamHistory(rows);
  const historyReady = teamHistory.state === "ready" && teamHistory.key === statisticsHistoryKey();
  const pool = historyReady ? teamHistory.teams : [];
  const profile = RadarTeams.axes();
  const reference = RadarScoring.createReference(entities, target, profile, config, pool);
  reference.historyRounds = historyReady ? teamHistory.rounds : null;
  const attributes = RadarTeams.attributes();
  const models = attributes.map((attribute) => RadarAttributes.fit(attribute, reference));
  const series = (results) => [{ name: target.name, results,
    line: "var(--statistics-plot-line)", fill: "var(--statistics-plot-fill)" }];
  const renderChart = (chartId, detailsId, axes, entries, title) => {
    $(chartId).innerHTML = RadarChart.svg(axes, entries, statisticsRadarTooltip, title, statisticsRadarReason);
    $(detailsId).replaceChildren();
    if (!entries.some((item) => item.results.some((result) => Number.isFinite(result.score)))) {
      const notice = element("div", "statistics-radar-empty");
      notice.setAttribute("role", "status");
      notice.append(element("strong", "", "Radar puanı hesaplanamıyor."));
      notice.append(element("p", "", reference.peerCount < reference.config.minimumPeers
        ? `${statisticsBarLabel(config.minimumMinutes, "TEAM")} oynamış ${reference.peerCount} takım var; en az ${reference.config.minimumPeers} gerekli.`
        : "Ölçütlerde yeterli geçerli veri yok. Eksik değerler sıfır kabul edilmez."));
      $(chartId).prepend(notice);
    }
  };
  renderChart("team-statistics-radar-chart", "team-statistics-radar-details", attributes,
    series(models.map((model) => RadarAttributes.evaluate(target, model, reference))),
    `${target.name} · genel nitelikler`);
  renderChart("team-statistics-detailed-chart", "team-statistics-detailed-details", profile,
    series(profile.map((axis) => RadarScoring.evaluate(target, axis, reference))),
    `${target.name} · ayrıntılı ölçütler`);
  statisticsAlignRadars(["team-statistics-radar-chart", "team-statistics-detailed-chart"]);
  for (const id of ["team-statistics-radar-note", "team-statistics-detailed-note"]) {
    $(id).textContent = "";
    $(id).hidden = true;
  }
}
