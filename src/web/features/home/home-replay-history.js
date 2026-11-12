"use strict";

const homeReplayHistory = { season: "", fixtures: null, status: "idle", trends: new Map() };
const HOME_REPLAY_TREND_TYPES = new Set(["34", "42", "44", "45", "55", "56", "62", "80", "81", "83", "84", "85", "86", "98", "106", "109"]);
const homeRecordedReplayXg = { season: "", fixtures: null, readings: new Map() };
const HOME_RECORDED_XG_TYPES = new Set(["5304", "7944", "7945"]);
const HOME_RECORDED_XG_FIELDS = ["fixture_id", ...HOME_REPLAY_IDENTITY, "state", "minute", "extra_minute",
  "first_half_minute", "fetched_at", "team_id", "type_id", "value"];

async function loadHomeReplayHistory() {
  const season = state.seasonSlug, fixtures = state.tables["fixtures.csv"];
  if (!season || (homeReplayHistory.season === season && homeReplayHistory.fixtures === fixtures)) return;
  Object.assign(homeReplayHistory, { season, fixtures, status: "loading", trends: new Map() });
  const rows = await readFantasyCSV("fixture_trends.csv",
    ["fixture_id", "id", "minute", "participant_id", "period_id", "type_id", "value"], season, true).catch(() => null);
  if (state.seasonSlug !== season || state.tables["fixtures.csv"] !== fixtures) return;
  const trends = new Map();
  for (const row of rows || []) {
    if (!HOME_REPLAY_TREND_TYPES.has(row.type_id)) continue;
    if (!trends.has(row.fixture_id)) trends.set(row.fixture_id, []);
    trends.get(row.fixture_id).push(row);
  }
  Object.assign(homeReplayHistory, { status: rows ? "ready" : "unavailable", trends });
  if (state.view === "home") renderHome();
}

function homeRecordedXgFrame(row, fixture) {
  if (row.fixture_id !== String(fixture.fixture_id) || HOME_REPLAY_IDENTITY.some((key) => row[key] !== String(fixture[key]))
      || ![fixture.home_team_id, fixture.away_team_id].map(String).includes(row.team_id) || !HOME_RECORDED_XG_TYPES.has(row.type_id)) return null;
  const value = number(row.value), timestamp = Date.parse(row.fetched_at);
  if (value === null || value < 0 || !Number.isFinite(timestamp)
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(row.fetched_at)
      || new Date(timestamp).toISOString().slice(0, 19) !== row.fetched_at.slice(0, 19)) return null;
  const minute = number(row.minute), extra = row.extra_minute === "" ? 0 : number(row.extra_minute);
  const first = number(row.first_half_minute), phase = row.state;
  if (!Number.isInteger(extra) || extra < 0 || (row.first_half_minute !== "" && (!Number.isInteger(first) || first < 0))) return null;
  if (phase === "HT") {
    if (first === null || first < 45 || (row.minute === "" ? extra !== 0 : minute !== 45 || 45 + extra > first)) return null;
  } else {
    const range = phase === "INPLAY_1ST_HALF" ? [0, 45] : phase === "INPLAY_2ND_HALF" ? [45, 90]
      : phase === "INPLAY_ET" ? [90, 120] : null;
    if (!range || !Number.isInteger(minute) || minute < range[0] || minute > range[1]
        || (extra > 0 && minute !== range[1] && (phase !== "INPLAY_ET" || minute !== 105))) return null;
  }
  return { state: phase, minute, extra, first, second: null, timestamp, team_id: row.team_id, type_id: row.type_id, value: row.value };
}

async function loadHomeRecordedReplayXg(fixture) {
  const season = state.seasonSlug, fixtures = state.tables["fixtures.csv"], id = String(fixture.fixture_id);
  if (!season || !/^[1-9]\d*$/.test(id)) return;
  if (homeRecordedReplayXg.season !== season || homeRecordedReplayXg.fixtures !== fixtures) {
    Object.assign(homeRecordedReplayXg, { season, fixtures, readings: new Map() });
  }
  const { readings } = homeRecordedReplayXg;
  if (readings.has(id)) return;
  readings.set(id, []);
  const rows = await readFantasyCSV(`replay_xg/${id}.csv`, HOME_RECORDED_XG_FIELDS, season, true).catch(() => null);
  if (homeRecordedReplayXg.readings !== readings || state.seasonSlug !== season || state.tables["fixtures.csv"] !== fixtures) return;
  const frames = (rows || []).map((row) => homeRecordedXgFrame(row, fixture)).filter(Boolean);
  readings.set(id, frames);
  if (frames.length && state.view === "home" && homeReplay.fixtureId === id && !homeReplay.simulated && homeReplay.at !== null && homeReplay.context) {
    // Repaint the current minute while keeping the slider under the pointer.
    homeReplay.context.paintedAt = null;
    queueHomeReplayPaint();
  }
}

function homeRecordedReplayXgRows(fixture, periods, elapsed, firstHalf) {
  if (homeRecordedReplayXg.season !== state.seasonSlug || homeRecordedReplayXg.fixtures !== state.tables["fixtures.csv"]) return [];
  const fixtureId = String(fixture.fixture_id), latest = new Map();
  const extraPeriods = new Map([...periods.values()].filter((period) => period.start >= 90).map((period) => [period.start, period]));
  for (const frame of homeRecordedReplayXg.readings.get(fixtureId) || []) {
    const extraPeriod = frame.state === "INPLAY_ET" ? extraPeriods.get(frame.minute <= 105 ? 90 : 105) : null;
    const at = extraPeriod ? extraPeriod.offset + frame.minute - extraPeriod.start + frame.extra : homeReplayFrameElapsed(frame, firstHalf);
    if (at === null || at > elapsed) continue;
    const key = `${frame.team_id}:${frame.type_id}`, previous = latest.get(key);
    if (previous && (previous.at > at || (previous.at === at && previous.frame.timestamp >= frame.timestamp))) continue;
    latest.set(key, { at, frame });
  }
  return [...latest.values()].map(({ at, frame }) => ({
    record_type: "statistic", fixture_id: fixtureId, source: "xgfixture", team_id: frame.team_id,
    type_id: frame.type_id, value: frame.value, minute: at, replayTimestamp: frame.timestamp,
  }));
}

// Trend minutes count from the regulation minute where each period starts.
// The match slider instead counts straight through each half's added time.
function homeReplayPeriods(fixture) {
  if (teamAnalysisExtras.key !== state.seasonSlug) return new Map();
  const periods = (teamAnalysisExtras.periods || []).filter((row) => row.fixture_id === String(fixture.fixture_id))
    .sort((a, b) => number(a.counts_from) - number(b.counts_from));
  const result = new Map();
  let added = 0;
  for (const row of periods) {
    const start = number(row.counts_from), length = number(row.period_length), end = number(row.minutes);
    if (!row.id || start === null || start < 0 || !length || length < 0 || end === null || end < start) continue;
    const duration = Math.max(length, end - start);
    result.set(row.id, { start, length, offset: start + added, duration });
    added += duration - length;
  }
  return result;
}

function homeHistoricalReplayDuration(fixture, total) {
  const ends = [...homeReplayPeriods(fixture).values()].map(({ offset, duration }) => offset + duration);
  return Math.max(total, ...ends);
}

function homeReplayEventTime(row, periods, firstHalf) {
  const minute = number(row.minute), extra = number(row.extra_minute) ?? 0;
  if (minute === null || minute < 0 || extra < 0) return null;
  const period = periods.get(row.period_id);
  return period && minute >= period.start ? period.offset + minute - period.start + extra
    : homeChartTime(minute, extra, firstHalf, Infinity);
}

function homeReplayTrendRows(periods, sides, elapsed, fixtureId) {
  if (homeReplayHistory.season !== state.seasonSlug || homeReplayHistory.fixtures !== state.tables["fixtures.csv"]) return [];
  const latest = new Map();
  for (const row of homeReplayHistory.trends.get(fixtureId) || []) {
    const period = periods.get(row.period_id), minute = number(row.minute), value = number(row.value), id = number(row.id);
    if (!sides.includes(row.participant_id) || !period || minute === null || value === null || value < 0 || id === null
        || minute < period.start || minute > period.start + period.duration) continue;
    const at = period.offset + minute - period.start;
    if (at > elapsed) continue;
    const key = `${row.participant_id}:${row.type_id}`, previous = latest.get(key);
    if (previous && (previous.at > at || (previous.at === at && previous.id >= id))) continue;
    latest.set(key, { at, id, row });
  }
  return [...latest.values()].map(({ row, at }) => ({
    record_type: "statistic", fixture_id: fixtureId, source: "statistics", team_id: row.participant_id,
    type_id: row.type_id, value: row.value, minute: at,
  }));
}

function homeReplaySavedScores(fixture, sides, description) {
  const summary = fixture.homeSnapshot?.summary;
  if (summary) {
    return (description === "CURRENT" ? [summary.home_score, summary.away_score] : [summary.home_half_score, summary.away_half_score]).map(homeScoreValue);
  }
  const scores = currentFixtureScores(description);
  return sides.map((id) => homeScoreValue(scores.get(`${fixture.fixture_id}:${id}`)));
}

function homeReplayScore(timed, sides, elapsed, firstHalf, total, finalScore, halfScore) {
  if (elapsed >= total) return finalScore;
  if (elapsed === firstHalf && halfScore.every((value) => value !== null)) return halfScore;
  const goals = timed.filter(({ event }) => {
    const kind = String(event.code || "").toUpperCase().replace(/[- ]/g, "_");
    return (HOME_GOALS.has(kind) || kind === "OWN_GOAL") && !/^(true|1)$/i.test(event.rescinded);
  });
  if (goals.some(({ event, at }) => at === null || at > total || !sides.includes(String(event.team_id)))) return [null, null];
  const count = (limit) => sides.map((side) => goals.filter(({ event, at }) => String(event.team_id) === side && at <= limit).length);
  const final = count(total), half = count(firstHalf);
  // An incomplete event list cannot establish when the saved goals happened.
  if (final.some((value, side) => value !== finalScore[side])
      || half.some((value, side) => halfScore[side] !== null && value !== halfScore[side])) return [null, null];
  return count(elapsed);
}

function homeHistoricalReplayRows(fixture, elapsed, firstHalf, total) {
  const fixtureId = String(fixture.fixture_id), sides = [fixture.home_team_id, fixture.away_team_id].map(String);
  const periods = homeReplayPeriods(fixture);
  const timed = homeEventRows(fixture).map((event) => ({ event, at: homeReplayEventTime(event, periods, firstHalf) }));
  const finalScore = homeReplaySavedScores(fixture, sides, "CURRENT");
  const halfScore = homeReplaySavedScores(fixture, sides, "1ST_HALF");
  const kickoff = elapsed === 0;
  const [home, away] = kickoff ? [0, 0] : homeReplayScore(timed, sides, elapsed, firstHalf, total, finalScore, halfScore);
  const complete = elapsed >= total, halftime = !complete && elapsed === firstHalf;
  const inFirstHalf = elapsed < firstHalf;
  const regulationMinute = inFirstHalf ? elapsed : 45 + elapsed - firstHalf;
  const periodEnd = inFirstHalf ? 45 : 90;
  const matchState = complete ? fixture.homeSnapshot?.summary?.state || fixtureState(fixture)
    : halftime ? "HT" : inFirstHalf ? "INPLAY_1ST_HALF" : "INPLAY_2ND_HALF";
  const stats = kickoff ? sides.flatMap((team_id) => [
    ...[...HOME_REPLAY_TREND_TYPES].map((type_id) => ({
      record_type: "statistic", fixture_id: fixtureId, team_id, source: "statistics",
      type_id, value: type_id === "45" ? "50" : "0", minute: 0,
    })),
    ...["5304", "7944", "7945"].map((type_id) => ({
      record_type: "statistic", fixture_id: fixtureId, team_id, source: "xgfixture", type_id, value: "0", minute: 0,
    })),
  ]) : complete ? homeFixtureMetrics(fixture).map((row) => ({ ...row, record_type: "statistic" }))
    : [...homeReplayTrendRows(periods, sides, elapsed, fixtureId), ...homeRecordedReplayXgRows(fixture, periods, elapsed, firstHalf)];
  const pressure = homePressure(fixture);
  const events = kickoff ? [] : timed.filter(({ at }) => complete || (at !== null && at <= elapsed)).map(({ event }) => event);
  const lineups = homePlayerRows(fixture).filter((row) => /^(1|true)$/i.test(row.started)).map((row) => ({
    record_type: "lineup", fixture_id: fixtureId, team_id: row.team_id, player_id: row.player_id,
    player_name: row.player_name || row.name, started: "1", position: row.position, formation_field: row.formation_field,
    jersey_number: row.jersey_number,
  }));
  const formations = sides.flatMap((side) => {
    const formation = homeFormation(fixture, side);
    return formation ? [{ record_type: "formation", fixture_id: fixtureId, team_id: side, formation }] : [];
  });
  return [{
    record_type: "fixture", fixture_id: fixtureId, league_id: fixture.league_id, season_id: fixture.season_id,
    home_team_id: sides[0], away_team_id: sides[1], state: matchState,
    minute: complete || halftime ? "" : String(Math.min(periodEnd, regulationMinute)),
    extra_minute: complete || halftime || regulationMinute <= periodEnd ? "" : String(regulationMinute - periodEnd),
    home_score: String(home ?? ""), away_score: String(away ?? ""),
    home_half_score: inFirstHalf ? "" : String(halfScore[0] ?? ""),
    away_half_score: inFirstHalf ? "" : String(halfScore[1] ?? ""),
    statistics_available: stats.length ? "1" : "0",
    events_available: kickoff || timed.length || String(fixture.homeSnapshot?.summary?.events_available) === "1" ? "1" : "0",
    pressure_available: pressure.minutes?.length ? "1" : "0",
    periods_available: periods.size ? "1" : "0", lineups_available: lineups.length ? "1" : "0",
    formations_available: formations.length ? "1" : "0",
  }, { record_type: "period", fixture_id: fixtureId, code: "1ST_HALF", minute: String(firstHalf), ticking: inFirstHalf ? "1" : "0" },
  ...stats, ...events, ...lineups, ...formations,
  ...(pressure.minutes || []).filter(([minute]) => minute <= elapsed).flatMap(([minute, ...values]) => values.map((value, side) => ({
    record_type: "pressure", fixture_id: fixtureId, team_id: sides[side], minute: String(minute), value: String(value),
  })))];
}
