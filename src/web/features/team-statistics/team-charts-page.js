"use strict";

// Page wiring for the charts of Takım İstatistikleri: the four match-by-match
// charts inside Takım Profili, drawn for the open team alone, and the Takım
// Analizi section above it, which compares every team. Depends on
// team-analysis.js and on the page helpers ($, displayNumber, state,
// readFantasyCSV, currentFixtureScores, fantasyState, teamStatisticsState,
// teamMetricsState). Nothing is cached across downloads: each render reads the
// tables in memory, so "Refresh saved data" after the weekly download updates
// every chart.

// Minute-level data the other pages do not need, read on demand. Each file is
// optional: a chart whose file is missing says so and the rest still draw.
const teamAnalysisExtras = { key: null, state: "idle", events: null, pressure: null, periods: null };
let teamAnalysisSelectedTab = "fantasy";

function showTeamAnalysisTab(id, focus = false) {
  const tabs = [...$("team-analysis-tabs").querySelectorAll("[data-analysis-tab]")];
  if (!tabs.some((tab) => tab.dataset.analysisTab === id)) id = "fantasy";
  teamAnalysisSelectedTab = id;
  for (const tab of tabs) {
    const selected = tab.dataset.analysisTab === id;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  }
  // Every panel keeps its place, stacked in one grid cell, and only the open
  // one is visible (team-analysis.css). The section is therefore always as
  // tall as its tallest chart, and changing tabs never moves the page.
  const open = (panel, shown) => panel.classList.toggle("ta-open", shown);
  open($("ta-fantasy-panel"), id === "fantasy");
  open($("ta-luck-panel"), id === "luck");
  open($("ta-compare-group"), id.startsWith("compare-"));
  for (const panel of $("ta-compare-chart").querySelectorAll("[data-analysis-panel]")) {
    open(panel, panel.dataset.analysisPanel === id);
  }
}

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
    // A match whose feed lacks either side's pressure is left out of the
    // average; the note says so rather than letting it pass as complete.
    const measured = new Set(teamAnalysisExtras.pressure.map((row) => `${row.fixture_id}|${row.participant_id}`));
    const unmeasured = played.filter((match) => match.teamId === selected
      && !(measured.has(`${match.fixtureId}|${match.teamId}`) && measured.has(`${match.fixtureId}|${match.opponentId}`))).length;
    teamAnalysisBlock("ta-momentum", chart.html, missing || ((unmeasured ? `${unmeasured} maçta baskı verisi yok; ortalama kalan maçlardan. ` : "")
      + "Sportmonks baskı endeksinde takımın rakibine göre farkı, dilimlere göre ortalama. "
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
    + "sayfa yenilenince güncellenir. Bir takım adına veya noktaya tıklayarak profili açın." + pending;
  const statsMissing = teamMetricsState.state === "unavailable" ? `${teamMetricsState.message} ` : "";

  renderTeamProfileCharts(played, selected, names, statsMissing);

  const fantasyReady = fantasyState.season === state.seasonSlug;
  const ledger = fantasyReady ? [...fantasyState.matches.values()].flat() : [];
  const roles = TeamAnalysis.fantasyByRole(ledger, names);
  // While the ledger is not ready its loader's note says why - still reading,
  // older than the match data, or absent - and what to do about it.
  teamAnalysisBlock("ta-fantasy", roles.length ? TeamAnalysis.fantasyChart(roles, names, selected) : "",
    !fantasyReady ? fantasyState.note
      : !roles.length ? "Bu sezon için fantezi puanı bulunamadı."
        : "Yayımlanan fantezi puanı kayıtlarındaki bu sezonun puanları, oyunun mevkilerine göre toplandı. Hangi takımın defansı veya hücumu fantezi puanı getiriyor, doğrudan görünür.");

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
      : spec.id === "fantasy" && !fantasyReady ? fantasyState.note
        : "Bu karşılaştırma için veri yok.";
    return `<figure id="team-analysis-panel-compare-${spec.id}" class="ta-compare-card" role="tabpanel" aria-labelledby="team-analysis-tab-compare-${spec.id}" data-analysis-panel="compare-${spec.id}" tabindex="0"><figcaption>${escapeTeamAnalysis(spec.title)}</figcaption>`
      + `${rows.length ? `<div class="ta-chart">${TeamAnalysis.scatter(rows, spec, names, selected, teamColor)}</div>` : ""}`
      + `<p class="builder-rating-note">${escapeTeamAnalysis(`${spec.note} ${basis}`)}</p></figure>`;
  });
  $("ta-compare-chart").innerHTML = cards.join("");
  $("ta-compare-note").textContent = statsMissing + "Her nokta bir takım, kulübün kendi renginde, bu sezonun bitmiş maçlarından. Eşit ölçekli çiftlerde (puan–xPts, gol–xG, "
    + "yenilen–xGA) kesikli çizgi iki değerin eşit olduğu yer; diğerlerinde lig ortalamaları. Köşe yazıları o bölgenin ne anlama geldiğini söyler.";
  showTeamAnalysisTab(teamAnalysisSelectedTab);
}

const escapeTeamAnalysis = (value) => String(value ?? "").replace(/[&<>"']/g,
  (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

function setupTeamAnalysis() {
  const tabs = [
    { id: "fantasy", title: "Fantezi Puanı · Mevkiye Göre", panel: "ta-fantasy-panel" },
    { id: "luck", title: "Şans Göstergesi · Sonuç ve Pozisyon Farkı", panel: "ta-luck-panel" },
    ...TeamAnalysis.comparisons.map((spec) => ({ id: `compare-${spec.id}`, title: spec.title,
      panel: `team-analysis-panel-compare-${spec.id}` })),
  ];
  const tabList = $("team-analysis-tabs");
  for (const tab of tabs) {
    const button = element("button", "team-analysis-tab", tab.title);
    button.type = "button";
    button.id = `team-analysis-tab-${tab.id}`;
    button.dataset.analysisTab = tab.id;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", tab.panel);
    tabList.append(button);
  }
  showTeamAnalysisTab(teamAnalysisSelectedTab);
  tabList.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-analysis-tab]");
    if (tab) showTeamAnalysisTab(tab.dataset.analysisTab);
  });
  tabList.addEventListener("keydown", (event) => {
    const current = event.target.closest("[data-analysis-tab]");
    if (!current || !["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = tabs.findIndex((tab) => tab.id === current.dataset.analysisTab);
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (index + (["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1) + tabs.length) % tabs.length;
    showTeamAnalysisTab(tabs[next].id, true);
  });
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
