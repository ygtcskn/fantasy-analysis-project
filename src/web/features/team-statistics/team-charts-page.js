"use strict";

// Page wiring for the charts of Takım İstatistikleri: the four match-by-match
// charts inside Takım Profili, drawn for the open team alone, and the Takım
// Analizi section below it, which compares every team. Depends on
// team-analysis.js and on the page helpers ($, displayNumber, state,
// readFantasyCSV, currentFixtureScores, fantasyState, teamStatisticsState,
// teamMetricsState). Nothing is cached across downloads: each render reads the
// tables in memory, so "Refresh saved data" after the weekly download updates
// every chart.

// Minute-level data the other pages do not need, read on demand. Each file is
// optional: a chart whose file is missing says so and the rest still draw.
const teamAnalysisExtras = { key: null, state: "idle", events: null, pressure: null, periods: null };

async function loadTeamAnalysisExtras() {
  const key = state.seasonSlug;
  if (!key || teamAnalysisExtras.key === key) return;
  Object.assign(teamAnalysisExtras, { key, state: "loading", events: null, pressure: null, periods: null });
  const read = (name, fields) => readFantasyCSV(name, fields, key).catch(() => null);
  const [events, pressure, periods] = await Promise.all([
    read("events.csv", ["fixture_id", "participant_id", "minute", "type.developer_name"]),
    read("fixture_pressure.csv", ["fixture_id", "participant_id", "minute", "pressure"]),
    read("fixture_periods.csv", ["fixture_id", "description", "minutes"]),
  ]);
  if (teamAnalysisExtras.key !== key) return;
  Object.assign(teamAnalysisExtras, { state: "ready", events, pressure, periods });
  if (state.view === "team-statistics" && state.seasonSlug === key) renderTeamStatistics();
}

function teamAnalysisBlock(id, content, note) {
  $(`${id}-chart`).innerHTML = content || "";
  $(`${id}-note`).textContent = note;
}

// The four charts on the profile read one team, but every scale they use is
// the league's, so the open team stays comparable with the panels its
// neighbours would draw. `order` is the open team alone; with no team open
// they draw nothing and say so.
function renderTeamProfileCharts(played, selected, names, statsMissing) {
  const order = selected ? [selected] : [];
  const plain = { interactive: false };
  const missing = selected ? "" : "Profil için takım seçilmedi.";

  const grid = TeamAnalysis.xgGrid(played, order, names, selected, plain);
  teamAnalysisBlock("ta-xg", grid.html, missing || (statsMissing + `Her nokta bir maç: yatayda rakibe verilen xG, dikeyde üretilen xG (0–${grid.scale}). `
    + "Kesikli çizginin üstünde takım rakibinden fazla pozisyon üretti; gölgeli yarıda üretemedi. "
    + `Gri noktalar bu sezonun ${grid.matches} takım-maçı, artı işareti takımın ortalaması. Renk sonucu gösterir.`));

  const form = TeamAnalysis.formGrid(played, order, names, selected, plain);
  teamAnalysisBlock("ta-form", form.html, missing || (statsMissing
    + `Maç maç, eskiden yeniye: çizginin üstü üretilen xG, altı rakibe verilen xG (ölçek 0–${form.scale}). Harf sonucu gösterir.`));

  if (!teamAnalysisExtras.events) {
    teamAnalysisBlock("ta-timing", "", teamAnalysisExtras.state === "ready"
      ? "events.csv okunamadı; src/web/serve.py'yi yeniden başlatın." : "Gol dakikaları yükleniyor…");
  } else {
    const timing = TeamAnalysis.goalTiming(teamAnalysisExtras.events, played);
    const chart = TeamAnalysis.timingGrid(timing, played, order, names, selected, plain);
    teamAnalysisBlock("ta-timing", chart.html, missing || ("Atılan (üstte) ve yenilen (altta) goller 15 dakikalık dilimlerde. Uzatma dakikaları devrenin son dilimine eklenir; "
      + `kendi kalesine atılan gol, golden yararlanan takıma yazılır. Dikey ölçek ligin en yüklü dilimine göre (0–${chart.scale}).`));
  }

  if (!teamAnalysisExtras.pressure) {
    teamAnalysisBlock("ta-momentum", "", teamAnalysisExtras.state === "ready"
      ? "fixture_pressure.csv okunamadı; src/web/serve.py'yi yeniden başlatın." : "Baskı verisi yükleniyor…");
  } else {
    const balance = TeamAnalysis.momentum(teamAnalysisExtras.pressure, teamAnalysisExtras.periods || [], played);
    const chart = TeamAnalysis.momentumGrid(balance, order, names, selected, plain);
    teamAnalysisBlock("ta-momentum", chart.html, missing || ("Sportmonks baskı endeksinde takımın rakibine göre farkı, dilimlere göre ortalama. "
      + "Sıfırın üstünde takım o dakikalarda üstündü. Uzatma dakikaları devre uzunluğuna göre ilgili devrenin son dilimine eklenir. "
      + `Dikey ölçek ligin en büyük farkına göre (±${displayNumber(chart.scale)}).`));
  }
}

function renderTeamAnalysis(list, names) {
  if (teamAnalysisExtras.key !== state.seasonSlug) loadTeamAnalysisExtras();
  const fixtures = state.tables["fixtures.csv"] || [];
  const played = TeamAnalysis.matches({ fixtures, scores: currentFixtureScores(),
    teamRows: teamMetricsState.state === "ready" ? teamMetricsState.rows : [] });
  const order = [...list].sort((a, b) => (a.position ?? 99) - (b.position ?? 99)).map((team) => team.id);
  const selected = teamStatisticsState.selected;
  const when = TeamAnalysis.asOf(fixtures, played);
  $("team-analysis-asof").textContent = when.round === null ? "Maç yok" : `${when.round}. hafta sonrası`;
  const pending = when.round !== null && when.finished < when.scheduled
    ? ` ${when.round}. haftanın ${when.scheduled - when.finished} maçı henüz bitmiş olarak kaydedilmedi; bir sonraki indirmeden sonra eklenir.` : "";
  $("team-analysis-note").textContent = `Bu sezon, ${when.matches} bitmiş maç. Grafikler her indirmeden sonra `
    + "“Kaydedilen veriyi yenile” ile güncellenir. Bir takım adına veya noktaya tıklayarak profili açın." + pending;
  const statsMissing = teamMetricsState.state === "unavailable" ? `${teamMetricsState.message} ` : "";

  renderTeamProfileCharts(played, selected, names, statsMissing);

  const fantasyReady = fantasyState.season === state.seasonSlug;
  const ledger = fantasyReady ? [...fantasyState.matches.values()].flat() : [];
  const roles = TeamAnalysis.fantasyByRole(ledger, names);
  teamAnalysisBlock("ta-fantasy", roles.length ? TeamAnalysis.fantasyChart(roles, names, selected) : "",
    !fantasyReady ? "Fantezi analizi yüklenmedi. Kaydedilen veriyi yenileyin."
      : !roles.length ? "Bu sezon için fantezi puanı bulunamadı."
        : "Yayınlanan puan tablosundaki bu sezonun puanları, oyunun mevkilerine göre toplandı. Hangi takımın defansı veya hücumu puan getiriyor, doğrudan görünür.");

  const luck = TeamAnalysis.luck(played, order);
  const luckKnown = luck.filter((entry) => entry.matches);
  teamAnalysisBlock("ta-luck", luckKnown.length ? TeamAnalysis.luckChart(luck, names, selected) : "",
    statsMissing + (luckKnown.length ? "Sağa uzanan çubuk: sonuçlar pozisyonlardan iyi — xG’den fazla gol ya da xGA’dan az yenilen gol. "
      + "Bu genelde sürmez; solda kalan takımların sonuçları düzelmeye adaydır. "
      + `En az maç: ${Math.min(...luckKnown.map((entry) => entry.matches))}; erken sezonda farklar büyük oynar.` : "xG verisi yok."));

  // One point per team for each pair of season figures. Each card says how
  // many teams and matches it rests on, or what it is missing.
  const finished = new Set(played.map((match) => match.fixtureId));
  const withPoints = TeamAnalysis.withFantasy(played, ledger.filter((row) => finished.has(String(row.fixture_id))));
  const cards = TeamAnalysis.comparisons.map((spec) => {
    const rows = TeamAnalysis.comparisonRows(spec, withPoints, order);
    const basis = rows.length ? `${rows.length} takım, takım başına en az ${Math.min(...rows.map((row) => row.matches))} maç.`
      : spec.id === "fantasy" && !fantasyReady ? "Fantezi analizi yüklenmedi. Kaydedilen veriyi yenileyin."
        : "Bu karşılaştırma için veri yok.";
    return `<figure class="ta-compare-card"><figcaption>${escapeTeamAnalysis(spec.title)}</figcaption>`
      + `${rows.length ? TeamAnalysis.scatter(rows, spec, names, selected) : ""}`
      + `<p class="builder-rating-note">${escapeTeamAnalysis(`${spec.note} ${basis}`)}</p></figure>`;
  });
  $("ta-compare-chart").innerHTML = cards.join("");
  $("ta-compare-note").textContent = statsMissing + "Her nokta bir takım, bu sezonun bitmiş maçlarından. Eşit ölçekli çiftlerde (puan–xPts, gol–xG, "
    + "yenilen–xGA) kesikli çizgi iki değerin eşit olduğu yer; diğerlerinde lig ortalamaları. Köşe yazıları o bölgenin ne anlama geldiğini söyler.";
}

const escapeTeamAnalysis = (value) => String(value ?? "").replace(/[&<>"']/g,
  (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

function setupTeamAnalysis() {
  const open = (target) => {
    const team = target.closest("[data-team]")?.dataset.team;
    if (!team) return;
    teamStatisticsState.selected = team;
    renderTeamStatistics();
    $("team-statistics-profile").scrollIntoView({ behavior: "smooth", block: "start" });
  };
  $("team-analysis").addEventListener("click", (event) => open(event.target));
  $("team-analysis").addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && event.target.matches?.("[data-team][role='button']")) {
      event.preventDefault();
      open(event.target);
    }
  });
}
