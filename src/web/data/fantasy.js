"use strict";

// Published analysis is optional. Every refresh replaces this snapshot, including
// failures, so an old projection can never follow a new season into the builder.
const fantasyState = {
  request: 0, season: "", summaries: new Map(), matches: new Map(), projections: new Map(),
  generatedAt: "", note: t("Fantezi analizi henüz yüklenmedi."),
};

function resetFantasyData(note = t("Fantezi analizi henüz yüklenmedi.")) {
  fantasyState.request++;
  fantasyState.season = "";
  fantasyState.summaries = new Map();
  fantasyState.matches = new Map();
  fantasyState.projections = new Map();
  fantasyState.generatedAt = "";
  fantasyState.note = note;
}

// Sportmonks' exported unzoned timestamps are UTC, as are ledger kickoffs; the
// parsing and the Turkish-time display live in core/locale.js.
function fantasyTime(value) {
  return utcTime(value);
}

function fantasyKickoff(fixture) {
  return kickoffTime(fixture);
}

function fantasyDate(value, includeTime = false) {
  const time = fantasyTime(value);
  if (!Number.isFinite(time)) return t("Bilinmiyor");
  return new Intl.DateTimeFormat(LOCALE, {
    day: "numeric", month: "short", year: "numeric", timeZone: MATCH_TIME_ZONE,
    ...(includeTime ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : {}),
  }).format(time);
}

async function readFantasyCSV(path, fields, season, optional = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    // no-cache still asks the server every time; an unchanged file returns as a short 304.
    const response = await fetch(`/local-data/${path}`, { cache: "no-cache", signal: controller.signal });
    if (optional && response.status === 404) return null;
    if (!response.ok) throw new Error(response.status === 404 ? "missing" : "unavailable");
    if (response.headers.get("X-Superlig-Local") !== "1" || response.headers.get("X-Superlig-Season") !== season) throw new Error("season");
    const blob = await response.blob();
    if (blob.size > 40 * 1024 * 1024) throw new Error("unavailable");
    const parsed = parseCSV(await blob.text());
    if (fields.some((field) => !parsed.header.includes(field))) throw new Error("incomplete");
    return parsed.records;
  } finally { clearTimeout(timer); }
}

function fantasyManifest(rows, season) {
  if (rows.length !== 1 || rows[0].status !== "complete" || rows[0].season.replace("/", "-") !== season
      || !rows[0].pipeline_run_id || !Number.isFinite(fantasyTime(rows[0].generated_at_utc))) throw new Error("incomplete");
  return rows[0];
}

async function loadFantasyData() {
  const season = state.seasonSlug;
  resetFantasyData(t("Fantezi analizi okunuyor…"));
  const request = fantasyState.request, tables = state.tables;
  if (!season) {
    fantasyState.note = t("Bu sezonun fantezi analizini yüklemek için yerel site sunucusunu açın.");
    return;
  }
  const statusPath = "fantasy_pipeline/pipeline_status.csv";
  const statusFields = ["status", "season", "pipeline_run_id", "generated_at_utc", "sportmonks_finished_at_utc"];
  try {
    const before = fantasyManifest(await readFantasyCSV(statusPath, statusFields, season), season);
    const results = await Promise.allSettled([
      readFantasyCSV("points/player_season_summary.csv", ["season", "player_id", "points_total", "points_per_match", "minutes", "matches", "pipeline_run_id"], season),
      readFantasyCSV("points/player_match_points.csv", ["season", "fixture_id", "player_id", "points_total", "minutes_played", "pipeline_run_id"], season),
      readFantasyCSV("player_projections/player_projections.csv", ["season", "fixture_id", "player_id", "team_id", "opponent_id", "kickoff_utc", "matchweek", "expected_points", "chance_starting", "chance_scoring", "availability_status", "eligible_for_selection", "generated_at_utc", "pipeline_run_id"], season),
      readFantasyCSV("download_status.csv", ["season", "finished_at_utc", "status"], season, true),
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
    const [summaryRows, matchRows, projectionRows, downloadRows] = results.map((result) => result.value);
    const after = fantasyManifest(await readFantasyCSV(statusPath, statusFields, season), season);
    if (before.pipeline_run_id !== after.pipeline_run_id || before.generated_at_utc !== after.generated_at_utc) throw new Error("changed");
    if ([summaryRows, matchRows, projectionRows].some((rows) => rows.some((row) => row.pipeline_run_id !== after.pipeline_run_id))) throw new Error("changed");
    if (downloadRows?.some((row) => row.status !== "complete" || row.season.replace("/", "-") !== season
      || fantasyTime(row.finished_at_utc) > fantasyTime(after.sportmonks_finished_at_utc))) throw new Error("stale");

    const fixtures = new Map((tables["fixtures.csv"] || []).map((row) => [row.fixture_id, row]));
    const summaries = new Map(), matches = new Map(), projections = new Map(), matchKeys = new Set(), projectionKeys = new Set();
    for (const row of summaryRows.filter((item) => item.season === season)) {
      if (!row.player_id || summaries.has(row.player_id)) throw new Error("incomplete");
      summaries.set(row.player_id, row);
    }
    for (const row of matchRows.filter((item) => item.season === season)) {
      const key = `${row.fixture_id}:${row.player_id}`;
      if (!row.player_id || !fixtures.has(row.fixture_id) || matchKeys.has(key)) throw new Error("incomplete");
      matchKeys.add(key);
      if (!matches.has(row.player_id)) matches.set(row.player_id, []);
      matches.get(row.player_id).push(row);
    }
    for (const rows of matches.values()) rows.sort((a, b) => fantasyTime(b.kickoff_utc) - fantasyTime(a.kickoff_utc));
    for (const row of projectionRows) {
      if (row.season !== season || !row.player_id || !fixtures.has(row.fixture_id)) throw new Error("season");
      const key = `${row.fixture_id}:${row.player_id}`;
      if (projectionKeys.has(key)) throw new Error("incomplete");
      projectionKeys.add(key);
      if (!projections.has(row.player_id)) projections.set(row.player_id, []);
      projections.get(row.player_id).push(row);
    }
    for (const rows of projections.values()) rows.sort((a, b) => fantasyTime(a.kickoff_utc) - fantasyTime(b.kickoff_utc));
    if (request !== fantasyState.request || tables !== state.tables) return;
    Object.assign(fantasyState, { season, summaries, matches, projections, generatedAt: after.generated_at_utc,
      note: t("Fantezi analizi güncellendi: {date}. Fantezi puanları ve sonraki maçı için bir oyuncu açın.", { date: fantasyDate(after.generated_at_utc, true) }) });
  } catch (error) {
    if (request !== fantasyState.request || tables !== state.tables) return;
    fantasyState.note = error.message === "stale"
      ? t("Kaydedilen maç verisi fantezi analizinden daha yeni. Pipeline'ı çalıştırın, sonra sayfayı yenileyin.")
      : error.message === "changed"
        ? t("Fantezi analizi güncelleniyor. Pipeline bitince sayfayı yenileyin.")
        : t("Bu sezon için fantezi analizi yok. Pipeline'ı çalıştırın, sonra sayfayı yenileyin.");
  }
}

// The fantasy game's deadline for a matchweek, given its fixtures: one hour
// before the first kickoff. NaN when none of them has a known kickoff.
function fantasyDeadline(roundFixtures) {
  const kickoffs = roundFixtures.map(fantasyKickoff).filter(Number.isFinite);
  return kickoffs.length ? Math.min(...kickoffs) - 60 * 60 * 1000 : NaN;
}

function builderFantasyData(player) {
  if (fantasyState.season !== state.seasonSlug || !fantasyState.season) return { summary: null, matches: [], projection: null, note: fantasyState.note };
  const summary = fantasyState.summaries.get(player.id) || null;
  const matches = fantasyState.matches.get(player.id) || [];
  const fixtures = state.tables["fixtures.csv"] || [], now = Date.now();
  const rows = fantasyState.projections.get(player.id) || [];
  // Re-check time whenever the row is opened, and on the builder's minute tick.
  // No forecast once the round's fantasy deadline has passed.
  const projection = rows.find((row) => {
    const fixture = fixtures.find((item) => item.fixture_id === row.fixture_id);
    if (!fixture || !fixtureScheduled(fixture)) return false;
    const kickoff = fantasyKickoff(fixture), projectedKickoff = fantasyTime(row.kickoff_utc);
    if (!Number.isFinite(kickoff) || kickoff <= now || kickoff !== projectedKickoff) return false;
    if (player.squadTeam && row.team_id !== player.squadTeam) return false;
    const opponent = row.team_id === fixture.home_team_id ? fixture.away_team_id : row.team_id === fixture.away_team_id ? fixture.home_team_id : null;
    if (!opponent || row.opponent_id !== opponent || String(fixture["round.name"]) !== row.matchweek) return false;
    const deadline = fantasyDeadline(fixtures.filter((item) => String(item["round.name"]) === row.matchweek));
    if (!Number.isFinite(deadline) || now >= deadline) return false;
    return Number.isFinite(fantasyTime(row.generated_at_utc)) && fantasyTime(row.generated_at_utc) <= now + 300000;
  }) || null;
  return { summary, matches, projection, note: projection ? "" : rows.length
    ? t("Bu tahmin, kaydedilen maç veya seçim son tarihi için artık güncel değil. Fantezi analizini yenileyin.")
    : t("Bu oyuncu için sonraki maç tahmini yok.") };
}

function fantasyProjectionNumber(projection, field) {
  if (!projection) return null;
  if (projection.availability_status === "out") return 0;
  if (projection.availability_status !== "no_reported_absence" || String(projection.eligible_for_selection).toLowerCase() !== "true") return null;
  return number(projection[field]);
}

function fantasyProbability(projection, field) {
  const value = fantasyProjectionNumber(projection, field);
  return value === null || value < 0 || value > 1 ? "—" : percentText(Math.round(value * 100));
}

function fantasyAvailability(projection) {
  return ({ out: t("Oynamayacak"), expected_out: t("Oynaması beklenmiyor"), doubtful: t("Şüpheli"), no_reported_absence: t("Bildirilen eksiklik yok"), unknown: t("Durumu bilinmiyor") })[projection?.availability_status] || t("Durumu bilinmiyor");
}

function fantasyFixtureDifficulty(projection, side) {
  const value = number(projection?.[`${side}_fixture_difficulty`]);
  return value !== null && value >= 1 && value <= 5
    ? `${value}/5 · ${["", t("Kolay"), t("Elverişli"), t({ tr: "Orta", en: "Medium" }), t("Zor"), t("Çok zor")][value]}` : "—";
}
