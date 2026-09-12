"use strict";

// Page wiring for the two team spider plots on Takım İstatistikleri. The same
// scoring, reference, principal components, chart, tooltips and detail tables
// as the player plots, over RadarTeams. Depends on radar.js, on the shared
// helpers in radar-page.js and on the page helpers ($, element, displayNumber,
// state).

// Earlier seasons widen the population a team is ranked against; the plotted
// team is always measured on the served season alone. Each earlier season is
// read once, in the background, reduced to per-team tallies and released. The
// feed-availability rule is the player plots' rule: a column an earlier season
// clearly did not supply - xG before 2024-25, for one - is unknown there, not
// zero.
const teamHistory = { key: null, state: "idle", teams: [], seasons: [], unsupplied: {}, message: "" };

async function loadTeamHistory(currentRows) {
  const key = state.seasonSlug;
  if (!key || teamHistory.key === key) return;
  Object.assign(teamHistory, { key, state: "loading", teams: [], seasons: [], unsupplied: {}, message: "" });
  try {
    const seasons = (await statisticsHistoryCSV("seasons.csv")).map((row) => row.season)
      .filter((season) => /^\d{4}-\d{4}$/.test(season) && season < key);
    const reference = statisticsFillRates(currentRows, RadarTeams.columns());
    const metrics = Object.values(RadarTeams.metrics), teams = [], used = [], unsupplied = {};
    for (const season of seasons) {
      // A season downloaded before team statistics were captured is skipped,
      // not treated as a failure of the whole history.
      const [fixtures, records] = await Promise.all([statisticsHistoryCSV(`${season}/fixtures.csv`),
        statisticsHistoryCSV(`${season}/team_metrics.csv`).catch(() => null)]);
      if (teamHistory.key !== key) return;
      if (!records) continue;
      const rows = RadarTeams.rows(records);
      const missing = statisticsUnsupplied(statisticsFillRates(rows, [...reference.rates.keys()]), reference);
      for (const row of rows) for (const column of missing) delete row[column];
      if (missing.length) unsupplied[season] = missing;
      for (const scope of RadarScoring.scopes(fixtures)) {
        for (const team of RadarTeams.entities(rows, fixtures, scope)) {
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
  if (state.view === "team-statistics" && state.seasonSlug === key) renderTeamStatistics();
}

// Why the population is still this season alone, while it is.
function teamPoolNote() {
  if (teamHistory.state === "ready") return "";
  if (teamHistory.state === "unavailable") return `${teamHistory.message} Yalnızca bu sezonla karşılaştırılıyor. `;
  return "Önceki sezonlar yükleniyor; şimdilik yalnızca bu sezonla karşılaştırılıyor. ";
}

// Both wheels share one reference per render, with no settings: the served
// season and competition, every team that has played at least half as many
// matches as the busiest, and - once loaded - every earlier season.
function renderTeamRadars(teamId, rows, names) {
  const charts = ["team-statistics-radar-chart", "team-statistics-detailed-chart",
    "team-statistics-radar-details", "team-statistics-detailed-details"];
  const clear = (note) => {
    for (const id of charts) $(id).replaceChildren();
    for (const id of ["team-statistics-radar-note", "team-statistics-detailed-note"]) $(id).textContent = note;
  };
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
  if (teamHistory.key !== state.seasonSlug) loadTeamHistory(rows);
  const pool = teamHistory.state === "ready" ? teamHistory.teams : [];
  const profile = RadarTeams.axes();
  const reference = RadarScoring.createReference(entities, target, profile, config, pool);
  const attributes = RadarTeams.attributes();
  const models = attributes.map((attribute) => RadarAttributes.fit(attribute, reference));
  const series = (results) => [{ name: target.name, results,
    line: "var(--statistics-plot-line)", fill: "var(--statistics-plot-fill)" }];
  const renderChart = (chartId, detailsId, axes, entries, title) => {
    $(chartId).innerHTML = RadarChart.svg(axes, entries, statisticsRadarTooltip, title);
    if (!entries.some((item) => item.results.some((result) => Number.isFinite(result.score)))) {
      const notice = element("div", "statistics-radar-empty");
      notice.setAttribute("role", "status");
      notice.append(element("strong", "", "Radar puanı hesaplanamıyor."));
      notice.append(element("p", "", reference.peerCount < reference.config.minimumPeers
        ? `${statisticsBarLabel(config.minimumMinutes, "TEAM")} oynamış ${reference.peerCount} takım var; en az ${reference.config.minimumPeers} gerekli.`
        : "Ölçütlerde yeterli geçerli veri yok. Eksik değerler sıfır kabul edilmez; nedenler aşağıdaki ölçüt ayrıntılarında gösterilir."));
      $(chartId).prepend(notice);
    }
    renderStatisticsRadarDetails(detailsId, axes, entries, reference);
  };
  renderChart("team-statistics-radar-chart", "team-statistics-radar-details", attributes,
    series(models.map((model) => RadarAttributes.evaluate(target, model, reference))),
    `${target.name} · genel nitelikler`);
  renderChart("team-statistics-detailed-chart", "team-statistics-detailed-details", profile,
    series(profile.map((axis) => RadarScoring.evaluate(target, axis, reference))),
    `${target.name} · ayrıntılı ölçütler`);
  const shortNote = target.minutes < config.minimumMinutes
    ? `Küçük örnek: ${target.name} (${displayNumber(target.rows.length)} maç); referans grubuna alınmadı. ` : "";
  const fitted = models.filter((model) => model.status === "available");
  const explained = fitted.filter((model) => Number.isFinite(model.explained));
  $("team-statistics-radar-note").textContent =
    `${attributes.length} nitelik · ${statisticsReferenceLabel(reference)}. `
    + "Her nitelik, birbiriyle örtüşen maç başına takım ölçütlerinin ilk temel bileşenidir (PCA); "
    + "tekrar eden ölçütler tek bir eksende toplanır. "
    + (explained.length ? `Bileşenler ortak değişimin ortalama %${displayNumber(
      explained.reduce((sum, model) => sum + model.explained, 0) / explained.length * 100)}'ini açıklıyor. ` : "")
    + (fitted.length < models.length ? `${models.length - fitted.length} nitelik için yeterli tam kayıtlı emsal yok. ` : "")
    + (fitted.some((model) => model.dropped.length)
      ? "Önceki sezonlarda kaydı olmayan, emsallerde değişmeyen veya eksenle ters yönde hareket eden ölçütler o eksenden çıkarılır; hangileri olduğu ölçüt ayrıntılarında yazılıdır. " : "")
    + shortNote
    + teamPoolNote()
    + "Puan, takımın bileşen skorunun aynı emsal grubundaki sırasıdır; — eksik veri veya yetersiz örnek.";
  $("team-statistics-detailed-note").textContent = `${profile.length} ölçüt · ${statisticsReferenceLabel(reference)}. `
    + "Maç başına değerler, orta sıra yüzdeliği, sabit 0–100 ölçeği. "
    + "Yüksek puan daha iyi; italik yazılan ‘bağlam’ ölçütlerinde daha fazla etkinlik anlamına gelir. "
    + "Çizilen değerler yalnızca bu sezona aittir; önceki sezonlar yalnızca karşılaştırma ölçeğini genişletir. "
    + teamPoolNote()
    + shortNote
    + "— eksik veya yetersiz örnek; nedenini ölçüt ayrıntılarında görebilirsiniz.";
}
