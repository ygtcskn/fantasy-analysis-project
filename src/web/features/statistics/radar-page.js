"use strict";

// Page wiring for the two spider plots: the earlier-season reference loader,
// tooltips, the details tables and the render itself. Depends on
// radar.js and on the page helpers ($, element, displayNumber, state).

// Why an axis has no score, in the reader's words.
const STATISTICS_RADAR_STATUS = {
  missing: "Veri sağlanmadı", partial_coverage: "Eksik maç kapsamı; puan hesaplanmadı",
  invalid_ratio: "Başarı sayısı deneme sayısını aşıyor", invalid_minutes: "Geçerli dakika verisi yok",
  invalid_value: "Geçersiz değer", insufficient_attempts: "Yetersiz deneme sayısı",
  insufficient_peers: "En az iki geçerli emsal gerekli", no_positive_peers: "Pozitif değerli emsal yok",
  incompatible_group: "Sezon, lig veya mevki grubu uyuşmuyor", available: "Kullanılabilir",
  no_attempts: "Hiç deneme yok; oran hesaplanamaz",
};
// The same reasons in a few words, drawn under a blank axis on the chart.
const STATISTICS_RADAR_SHORT = {
  missing: "veri yok", partial_coverage: "eksik maç verisi", invalid_ratio: "geçersiz oran",
  invalid_minutes: "dakika yok", invalid_value: "geçersiz değer", insufficient_attempts: "az deneme",
  insufficient_peers: "az emsal", no_positive_peers: "pozitif emsal yok", incompatible_group: "farklı grup",
  no_attempts: "deneme yok",
};
function statisticsRadarReason(result) {
  return STATISTICS_RADAR_SHORT[result?.status] || "";
}

// Both wheels read the same prepared season CSV. Player and team metric names
// are prefixed in that file so a column absent from one feed stays absent here.
const spiderStatsState = { key: null, state: "idle", players: [], teams: [], message: "" };

function spiderRows(records, kind) {
  const prefix = kind === "player" ? "p_" : "t_";
  return records.filter((record) => record.entity_type === kind).map((record) => {
    const row = { fixture_id: record.fixture_id, player_id: record.player_id,
      team_id: record.team_id, name: record.name, position: record.position,
      started: record.started, minutes_played: record.minutes_played, rating: record.rating };
    for (const [key, value] of Object.entries(record)) {
      if (key.startsWith(prefix)) row[key.slice(prefix.length)] = value;
    }
    if (kind === "team" && row.opponent_present !== "1") {
      for (const key of ["goals_conceded", "shots_conceded", "shots_on_target_conceded"]) delete row[key];
    }
    return row;
  });
}

async function loadSpiderStats() {
  const key = state.seasonSlug;
  if (!key || spiderStatsState.key === key) return;
  Object.assign(spiderStatsState, { key, state: "loading", players: [], teams: [], message: "" });
  try {
    const records = await readFantasyCSV("spider/spider_stats.csv",
      ["entity_type", "fixture_id", "player_id", "team_id"], key);
    if (spiderStatsState.key !== key) return;
    Object.assign(spiderStatsState, { state: "ready", players: spiderRows(records, "player"),
      teams: spiderRows(records, "team") });
  } catch (error) {
    if (spiderStatsState.key !== key) return;
    Object.assign(spiderStatsState, { state: "unavailable",
      message: error.message === "missing"
        ? "spider_stats.csv bulunamadı; kaydedilmiş verilerden radar hazırlığını çalıştırın."
        : "spider_stats.csv okunamadı; radar verilerini yeniden hazırlayın." });
  }
  if (state.seasonSlug === key && state.view === "statistics") renderStatistics();
  if (state.seasonSlug === key && state.view === "team-statistics") renderTeamStatistics();
}

// Earlier seasons widen the population a score is ranked against; the plotted
// player is always measured on the served season alone. They load once per
// served season, in the background, one season at a time, and each player
// season is reduced straight to its tallies so the raw rows can be released.
// Only seasons before the served one are used: a reference should not know
// about football that had not been played yet.
const statisticsHistory = { key: null, rounds: null, state: "idle", players: [], seasons: [], message: "" };

// Earlier seasons are cut to the rounds the served season has reached (see
// RadarScoring.playedRounds), so the loaded history belongs to that point: a
// new round in a refresh reloads it.
function statisticsHistoryRounds() {
  return RadarScoring.playedRounds(state.tables["fixtures.csv"] || []);
}
function statisticsHistoryKey() {
  return state.seasonSlug ? `${state.seasonSlug}|${statisticsHistoryRounds() ?? "all"}` : null;
}

async function statisticsHistoryCSV(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`/local-data/history/${path}`, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(response.status === 404 ? "missing" : `HTTP ${response.status}`);
    if (response.headers.get("X-Superlig-Local") !== "1") throw new Error("local");
    return parseCSV(await response.text()).records;
  } finally { clearTimeout(timer); }
}

// Feeds arrived at different times. Touches, possession lost, ball recoveries,
// final-third passes and chances created are blank on every row before
// 2024-25; xG fills 13.5% of rows in 2023-24 against ~46% afterwards; long
// balls and blocked shots are partial before 2023-24. Read as omitted zeros,
// those blanks put every earlier player at the bottom of the axis. A column
// therefore counts as supplied in an earlier season only when its fill rate on
// covered rows is in line with the served season's: one that falls below 80%
// of it and is also far outside sampling noise (z < -4) is removed from that
// season's rows, and the existing rule for an absent column makes every axis
// built on it unknown there rather than zero.
function statisticsRadarColumns() {
  return [...new Set(Object.values(RadarScoring.metrics).flatMap((metric) => [metric.sourceColumn,
    metric.fallbackColumn, metric.attemptsColumn, ...(metric.sumColumns || [])]).filter(Boolean))];
}

function statisticsFillRates(rows, columns) {
  const played = rows.filter((row) => RadarScoring.numeric(row.minutes_played) > 0 && RadarScoring.covered(row));
  return { n: played.length, rates: new Map(columns.map((column) => [column, played.length
    ? played.filter((row) => column in row && String(row[column] ?? "").trim() !== "").length / played.length : 0])) };
}

function statisticsUnsupplied(own, reference) {
  return [...reference.rates.keys()].filter((column) => {
    const expected = reference.rates.get(column), observed = own.rates.get(column);
    if (!(expected > 0) || !own.n) return false;
    const spread = Math.sqrt(own.n * expected * (1 - expected)) || 1;
    return observed < 0.8 * expected && (observed - expected) * own.n / spread < -4;
  });
}

function statisticsHistorySeason(season, fixtures, rows, squads, reference) {
  const unsupplied = reference ? statisticsUnsupplied(statisticsFillRates(rows, [...reference.rates.keys()]), reference) : [];
  for (const row of rows) for (const column of unsupplied) delete row[column];
  const players = new Map();
  for (const row of rows) {
    if (!row.player_id) continue;
    if (!players.has(row.player_id)) {
      players.set(row.player_id, { id: row.player_id, name: row.name || `Oyuncu ${row.player_id}`, matches: [] });
    }
    players.get(row.player_id).matches.push(row);
  }
  const metrics = Object.values(RadarScoring.metrics), result = [];
  for (const scope of RadarScoring.scopes(fixtures)) {
    const positions = new Map();
    for (const row of squads) {
      if (String(row.season_id) !== scope.seasonId) continue;
      if (!positions.has(row.player_id)) positions.set(row.player_id, new Set());
      positions.get(row.player_id).add(row["position.name"] || row.position);
    }
    const prepared = RadarScoring.preparePlayers([...players.values()].map((player) => ({ ...player,
      squadPositions: positions.get(player.id) || [] })), fixtures, scope);
    for (const player of prepared) {
      if (!player.rows.length || !player.position || !(player.minutes > 0)) continue;
      result.push({ id: `${season}:${player.id}`, playerId: player.id, name: player.name, season, scope,
        position: player.position, minutes: player.minutes, rows: [],
        tallies: new Map(metrics.map((metric) => [metric.id, RadarScoring.tally(player, metric)])) });
    }
  }
  return { players: result, unsupplied };
}

async function loadStatisticsHistory() {
  const served = state.seasonSlug, key = statisticsHistoryKey(), rounds = statisticsHistoryRounds();
  if (!key || statisticsHistory.key === key) return;
  Object.assign(statisticsHistory, { key, rounds, state: "loading", players: [], seasons: [], unsupplied: {}, message: "" });
  try {
    const seasons = (await statisticsHistoryCSV("seasons.csv")).map((row) => row.season)
      .filter((season) => /^\d{4}-\d{4}$/.test(season) && season < served);
    const reference = statisticsFillRates(spiderStatsState.players, statisticsRadarColumns());
    const players = [], unsupplied = {};
    for (const season of seasons) {
      const [fixtures, records, squads] = await Promise.all([
        statisticsHistoryCSV(`${season}/fixtures.csv`),
        statisticsHistoryCSV(`${season}/spider_stats.csv`),
        statisticsHistoryCSV(`${season}/squads.csv`).catch(() => [])]);
      if (statisticsHistory.key !== key) return;
      // Feed availability is judged on the whole season; only the tallies are cut.
      const loaded = statisticsHistorySeason(season, RadarScoring.throughRound(fixtures, rounds),
        spiderRows(records, "player"), squads, reference);
      players.push(...loaded.players);
      if (loaded.unsupplied.length) unsupplied[season] = loaded.unsupplied;
    }
    Object.assign(statisticsHistory, { state: "ready", players, seasons, unsupplied });
  } catch (error) {
    if (statisticsHistory.key !== key) return;
    Object.assign(statisticsHistory, { state: "unavailable", players: [], seasons: [],
      message: error.message === "missing"
        ? "Sunucu önceki sezonları henüz sunmuyor; src/web/serve.py'yi yeniden başlatın."
        : "Önceki sezonlar okunamadı." });
  }
  if (state.view === "statistics" && statisticsHistoryKey() === key) renderStatistics();
}

// Why the population is still this season alone, while it is.
function statisticsPoolNote() {
  if (statisticsHistory.state === "ready") return "";
  if (statisticsHistory.state === "unavailable") return `${statisticsHistory.message} Yalnızca bu sezonla karşılaştırılıyor. `;
  return "Önceki sezonlar yükleniyor; şimdilik yalnızca bu sezonla karşılaştırılıyor. ";
}

// The default bar of 900 minutes is ten full matches: unreachable before
// midwinter, and after four rounds it leaves the radar with no peers at all.
// The bar follows what the season actually offers instead: half the minutes
// an ever-present player has managed, rounded to a third of a match.
function statisticsSuggestedMinutes(prepared) {
  const played = prepared.map((entry) => entry.minutes).filter((value) => Number.isFinite(value) && value > 0);
  if (!played.length) return RadarScoring.defaults.minimumMinutes;
  return Math.min(RadarScoring.defaults.minimumMinutes,
    Math.max(90, Math.round(Math.max(...played) / 60) * 30));
}

function statisticsScopeLabel(scope) {
  return `${state.seasonSlug || `Sezon ${scope.seasonId}`} · Lig ${scope.competitionId}`;
}

// The minute bar in the reader's unit: minutes for players, matches for teams,
// whose every match counts as ninety minutes.
function statisticsBarLabel(minutes, position) {
  return position === "TEAM" ? `en az ${displayNumber(minutes / 90)} maç` : `en az ${minutes} dakika`;
}

// The unit an axis value is reported in.
function statisticsUnit(metric) {
  return (metric.unit ?? (metric.transform === "per90" ? "/90" : metric.transform === "percentage" ? "%" : "")).trim();
}

function statisticsReferenceLabel(reference) {
  const seasons = reference.historySeasons, cut = reference.historyRounds ? `, ilk ${reference.historyRounds} hafta` : "";
  const earlier = seasons.length
    ? ` + ${reference.historyPeers} önceki sezon (${seasons[0]}${seasons.length > 1 ? ` – ${seasons.at(-1)}` : ""}${cut})` : "";
  return `${statisticsScopeLabel(reference.scope)} · ${RadarScoring.positionLabels[reference.position] || reference.position}`
    + ` · ${statisticsBarLabel(reference.config.minimumMinutes, reference.position)} · ${reference.seasonPeers} bu sezon${earlier}`
    + `${earlier ? ` = ${reference.peerCount}` : ""} emsal`;
}

// The small-sample adjustment in the reader's words: the observed figure, the
// adjusted one that is ranked, the group mean it is pulled toward, how much
// evidence that mean counts as, and how much of the result is the player's own.
function statisticsAdjustmentText(result) {
  const prior = result.prior;
  if (!prior) return "";
  const metric = result.metric, unit = statisticsUnit(metric);
  const scale = metric.transform === "percentage" ? 100 : 90;
  const weight = prior.unit === "attempts" ? `${displayNumber(Math.round(prior.weight))} deneme`
    : result.position === "TEAM" ? `${displayNumber(Math.round(prior.weight / 90))} maç`
      : `${displayNumber(Math.round(prior.weight))} dk`;
  return `Gözlenen ${displayNumber(result.observedValue)} ${unit} → düzeltilmiş ${displayNumber(result.value)} ${unit}`
    + ` · emsal ortalaması ${displayNumber(prior.mean * scale)} ${unit}, ağırlığı ${weight}`
    + ` · ${result.position === "TEAM" ? "takımın" : "oyuncunun"} kendi payı %${displayNumber(Math.round(result.reliability * 100))}`;
}

function statisticsScoreLabel(result) {
  if (result.metric.transform === "pca") return "Bileşen yüzdeliği";
  return result.zeroApplied ? "Sıfır + pozitif yüzdelik skoru" : "Yüzdelik";
}

// Which columns an attribute is made of, and how heavily each one counts. The
// weights are the component's loadings, so a reader can see that "Hücum" is
// mostly shot volume for one squad and mostly xG for another.
function statisticsLoadingText(result) {
  if (!result.loadings?.length) return "";
  return result.loadings.slice().sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .map(({ metric, weight }) => `${metric.rawLabel || metric.label} ${displayNumber(weight.toFixed(2))}`).join(" · ");
}

// Why a member left its attribute: missing from earlier seasons, identical for
// every peer, or moving against the rest of its group.
const STATISTICS_DROP_REASONS = { coverage: "önceki sezonlarda kaydı yok",
  constant: "emsallerde değişmiyor", direction: "eksene ters yönde" };

function statisticsDroppedText(result) {
  return Object.entries(STATISTICS_DROP_REASONS).map(([reason, label]) => {
    const names = result.dropped.filter((entry) => entry.reason === reason)
      .map(({ metric }) => metric.rawLabel || metric.label);
    return names.length ? `${names.join(", ")} (${label})` : "";
  }).filter(Boolean).join(" · ");
}

function statisticsRadarTooltip(entry, result) {
  const metric = result.metric;
  const group = `${statisticsScopeLabel(result.scope)} · ${RadarScoring.positionLabels[result.position] || result.position}`;
  if (metric.transform === "pca") {
    const lines = [entry.name, `${RadarScoring.categories.attribute} · ${metric.label}`,
      `Bileşen skoru: ${displayNumber(result.value)} (standart sapma birimi)`,
      `${statisticsScoreLabel(result)}: ${displayNumber(result.score)} / 100`,
      `${group} · ${statisticsBarLabel(result.minimumMinutes, result.position)}`,
      `Bileşen ${result.sampleSize} emsal üzerinden hesaplandı (${result.peerCount} emsal içinden)`];
    if (Number.isFinite(result.explained)) lines.push(`Ortak değişimin %${displayNumber(result.explained * 100)}'ini açıklıyor.`);
    if (result.loadings?.length) lines.push(`Ağırlıklar: ${statisticsLoadingText(result)}`);
    if (result.dropped?.length) lines.push(`Çıkarılan ölçütler: ${statisticsDroppedText(result)}`);
    lines.push("Birbirini tekrar eden ölçütler tek bir eksende toplanır; ham sütun değil, ortak eğilimdir.");
    if (result.smallSample) lines.push("Küçük veya belirsiz dakika örneği; referans grubuna alınmadı.");
    if (result.status !== "available") lines.push(STATISTICS_RADAR_STATUS[result.status] || result.status);
    return lines.join("\n");
  }
  const unit = statisticsUnit(metric);
  const lines = [entry.name, `${RadarScoring.categories[metric.category]} · ${metric.label}`,
    `Ham toplam (${metric.rawLabel || metric.label}): ${displayNumber(result.rawValue)}`,
    `${result.prior ? "Sıralanan (düzeltilmiş) değer" : "Dönüştürülmüş değer"}: ${displayNumber(result.value)} ${unit}`,
    ...(result.prior ? [`Küçük örnek düzeltmesi: ${statisticsAdjustmentText(result)}`] : []),
    `${statisticsScoreLabel(result)}: ${displayNumber(result.score)} / 100`,
    `${group} · ${statisticsBarLabel(result.minimumMinutes, result.position)}`,
    `Geçerli ölçüt örneği N = ${result.sampleSize} (${result.peerCount} emsal içinden)`,
    `Maç kapsamı: ${result.supplied}/${result.records}${result.position === "TEAM" ? "" : ` · dakika: ${displayNumber(result.minutes)}`}`];
  if (metric.sumColumns) lines.push(`Toplanan sütunlar: ${metric.sumColumns.join(" + ")}`);
  if (metric.transform === "percentage") lines.push(`Deneme: ${displayNumber(result.attempts)} · `
    + (result.required <= 1 ? "en az 1 deneme yeterli; az deneme emsal ortalamasına çekilir"
      : `gereken: ${result.required} (tam sezon karşılığı ${metric.minimumAttempts})`)
    + ` · deneme kapsamı: ${result.attemptsSupplied}/${result.records} maç`);
  if (result.zeroApplied) lines.push(`Sıfır oranı: %${displayNumber(result.zeroShare * 100)} · pozitif N = ${result.positiveN}. Pozitif değerler yalnızca pozitif emsallere göre sıralanır.`);
  if (metric.direction === "lower_better") lines.push("Düşük ham değer daha iyi; puan ters çevrilir.");
  if (metric.direction === "context") lines.push("Bağlam ölçütü: yüksek puan daha fazla etkinliktir; tek başına kalite değildir.");
  if (result.smallSample) lines.push("Küçük veya belirsiz dakika örneği; referans grubuna alınmadı.");
  if (result.status !== "available") lines.push(STATISTICS_RADAR_STATUS[result.status] || result.status);
  return lines.join("\n");
}

// The radars carry no explanatory text: their notes appear only when a plot
// cannot be drawn, and say why. Scores, raw values and the adjustment are in
// each axis's tooltip.
// RadarChart crops each wheel to its own labels, so a six-axis wheel came out
// shorter than its sixteen-axis neighbour and sat higher in its panel. Side
// by side they share one frame instead: the same viewBox, so both circles have
// the same radius, the same centre line and the same height.
function statisticsAlignRadars(chartIds) {
  const svgs = chartIds.map((id) => $(id).querySelector(":scope > svg")).filter(Boolean);
  const boxes = svgs.map((svg) => svg.getAttribute("viewBox")?.split(/\s+/).map(Number))
    .filter((box) => box?.length === 4 && box.every(Number.isFinite));
  if (boxes.length !== svgs.length || svgs.length < 2) return;
  const top = Math.min(...boxes.map((box) => box[1])), bottom = Math.max(...boxes.map((box) => box[1] + box[3]));
  const left = Math.min(...boxes.map((box) => box[0])), right = Math.max(...boxes.map((box) => box[0] + box[2]));
  for (const svg of svgs) svg.setAttribute("viewBox", `${left} ${top} ${right - left} ${bottom - top}`);
}

function statisticsRadarNote(note = "") {
  for (const id of ["statistics-radar-note", "statistics-detailed-note"]) {
    $(id).textContent = note;
    $(id).hidden = !note;
  }
}

// Both wheels share one reference per render, and it has no settings: the
// selected player's own season and competition, his role, the seeded minute
// bar and - once they have loaded - every earlier season. List searches and
// club filters never touch it.
function renderStatisticsRadars(selected, players) {
  if (spiderStatsState.key !== state.seasonSlug) loadSpiderStats();
  if (spiderStatsState.state !== "ready") {
    for (const id of ["statistics-radar-chart", "statistics-detailed-chart",
      "statistics-radar-details", "statistics-detailed-details"]) $(id).replaceChildren();
    const note = spiderStatsState.state === "unavailable" ? spiderStatsState.message : "Radar verileri yükleniyor…";
    statisticsRadarNote(note);
    return { note, reference: null };
  }
  const fixtures = state.tables["fixtures.csv"] || [], scopes = RadarScoring.scopes(fixtures);
  // The player's own season and competition: the scope of his first scoped
  // appearance, else the served season's first.
  const fixtureIds = new Set(spiderStatsState.players.filter((row) => row.player_id === selected.id)
    .map((row) => row.fixture_id));
  const scope = RadarScoring.fixtureScope(fixtures.find((fixture) =>
    fixtureIds.has(fixture.fixture_id) && RadarScoring.fixtureScope(fixture))) || scopes[0];
  const squadPositions = new Map();
  for (const row of state.tables["squads.csv"] || []) {
    if (!scope || String(row.season_id) !== scope.seasonId) continue;
    if (!squadPositions.has(row.player_id)) squadPositions.set(row.player_id, new Set());
    squadPositions.get(row.player_id).add(row["position.name"] || row.position);
  }
  const matches = new Map();
  for (const row of spiderStatsState.players) {
    if (!matches.has(row.player_id)) matches.set(row.player_id, []);
    matches.get(row.player_id).push(row);
  }
  const prepared = RadarScoring.preparePlayers(players.map((other) => ({ ...other,
    matches: matches.get(other.id) || [],
    squadPositions: squadPositions.get(other.id) || [] })), fixtures, scope);
  const config = { minimumMinutes: statisticsSuggestedMinutes(prepared) };
  const player = prepared.find((other) => other.id === selected.id);
  if (!scope || !player?.position) {
    for (const id of ["statistics-radar-chart", "statistics-detailed-chart",
      "statistics-radar-details", "statistics-detailed-details"]) $(id).replaceChildren();
    const note = !scope ? "Radar için fikstürlerde sezon ve lig kimliği gerekli."
      : "Mevki bilinmiyor veya eşit süreli birden fazla mevki var; grup tahmin edilmedi.";
    statisticsRadarNote(note);
    return { note, reference: null };
  }
  const profile = RadarScoring.axes(player.position);
  if (statisticsHistory.key !== statisticsHistoryKey()) loadStatisticsHistory();
  const historyReady = statisticsHistory.state === "ready" && statisticsHistory.key === statisticsHistoryKey();
  const pool = historyReady ? statisticsHistory.players : [];
  const reference = RadarScoring.createReference(prepared, player, profile, config, pool);
  reference.historyRounds = historyReady ? statisticsHistory.rounds : null;
  const attributes = RadarAttributes.forPosition(player.position);
  const models = attributes.map((attribute) => RadarAttributes.fit(attribute, reference));
  const series = (results) => [{ name: player.name, results,
    line: "var(--statistics-plot-line)", fill: "var(--statistics-plot-fill)" }];
  const renderChart = (chartId, detailsId, axes, entries, title) => {
    $(detailsId).replaceChildren();
    $(chartId).innerHTML = RadarChart.svg(axes, entries, statisticsRadarTooltip, title, statisticsRadarReason);
    if (!entries.some((item) => item.results.some((result) => Number.isFinite(result.score)))) {
      const notice = element("div", "statistics-radar-empty");
      notice.setAttribute("role", "status");
      notice.append(element("strong", "", "Radar puanı hesaplanamıyor."));
      notice.append(element("p", "", reference.peerCount < reference.config.minimumPeers
        ? `${config.minimumMinutes}+ dakika oynayan ${reference.peerCount} emsal var; en az ${reference.config.minimumPeers} gerekli.`
        : "Ölçütlerde yeterli geçerli veri yok. Eksik değerler sıfır kabul edilmez; nedenler eksenlerin altında yazılıdır."));
      $(chartId).prepend(notice);
    }
  };
  renderChart("statistics-radar-chart", "statistics-radar-details", attributes,
    series(models.map((model) => RadarAttributes.evaluate(player, model, reference))),
    `${player.name} · genel nitelikler`);
  const results = profile.map((axis) => RadarScoring.evaluate(player, axis, reference));
  renderChart("statistics-detailed-chart", "statistics-detailed-details", profile, series(results),
    `${player.name} · ayrıntılı ölçütler`);
  statisticsAlignRadars(["statistics-radar-chart", "statistics-detailed-chart"]);
  statisticsRadarNote();
  // Handed back so other player charts reuse this exact population and score.
  return { player, reference, profile, results, pool: statisticsPoolNote() };
}
