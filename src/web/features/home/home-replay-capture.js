"use strict";

// The normalized live feed is cumulative. Keep observed frames in memory so
// revisiting a minute uses the figures Sportmonks supplied at that time.
const homeReplayCapture = { season: "", fixtures: new Map() };
const HOME_REPLAY_FIXTURES = 12;
const HOME_REPLAY_FRAMES = 128;
const HOME_REPLAY_IDENTITY = ["league_id", "season_id", "home_team_id", "away_team_id"];

function rememberHomeReplay(rows, season) {
  if (homeReplayCapture.season !== season) {
    homeReplayCapture.season = season;
    homeReplayCapture.fixtures.clear();
  }
  const timestamp = Date.parse(rows.find((row) => row.record_type === "meta")?.fetched_at);
  if (!Number.isFinite(timestamp)) return;

  const byFixture = new Map();
  for (const row of rows) {
    if (!row.fixture_id) continue;
    const id = String(row.fixture_id);
    if (!byFixture.has(id)) byFixture.set(id, []);
    byFixture.get(id).push(row);
  }
  for (const [id, records] of byFixture) {
    const summaries = records.filter((row) => row.record_type === "fixture");
    if (summaries.length !== 1 || summaries[0].simulated === "1") continue;
    const summary = summaries[0], previous = homeReplayCapture.fixtures.get(id);
    const finished = matchweekFinished(summary);
    // The server repeats cached results for days. Only the first confirmed
    // result of a match this browser observed belongs in its replay.
    if (finished && (!previous || previous.finished)) continue;
    if (previous && (previous.timestamp >= timestamp
      || HOME_REPLAY_IDENTITY.some((key) => summary[key] !== previous.identity[key]))) continue;

    const firstHalf = records.find((row) => row.record_type === "period" && row.code === "1ST_HALF");
    const secondHalf = records.find((row) => row.record_type === "period" && row.code === "2ND_HALF");
    const minute = ruleNumber(summary.minute), extra = ruleNumber(summary.extra_minute) ?? 0;
    const first = ruleNumber(firstHalf?.minute), second = ruleNumber(secondHalf?.minute);
    const key = [summary.state, minute, extra, first, second].join(":");
    const frames = previous?.frames || new Map();
    frames.delete(key);
    // The CSV parser includes every column on every row. Compact blank cells
    // to keep the per-minute copies small.
    const compact = records.map((row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== "")));
    frames.set(key, { timestamp, state: summary.state, minute, extra, first, second, rows: compact });
    if (frames.size > HOME_REPLAY_FRAMES) frames.delete(frames.keys().next().value);

    homeReplayCapture.fixtures.delete(id);
    homeReplayCapture.fixtures.set(id, { identity: summary, timestamp, finished, frames });
    if (homeReplayCapture.fixtures.size > HOME_REPLAY_FIXTURES) {
      homeReplayCapture.fixtures.delete(homeReplayCapture.fixtures.keys().next().value);
    }
  }
}

function homeReplayFrameElapsed(frame, firstHalf) {
  const { state: phase, minute, extra, first, second } = frame;
  if (phase === "INPLAY_1ST_HALF") return minute === null ? first : minute + extra;
  if (phase === "HT") return Math.max(firstHalf, first ?? 45);
  const offset = Math.max(firstHalf, first ?? 45) - 45;
  if (minute !== null && ["INPLAY_2ND_HALF", "INPLAY_ET", "INPLAY_PENALTIES"].includes(phase)) return minute + extra + offset;
  if (phase === "INPLAY_2ND_HALF" && second !== null) return second + offset;
  if (phase === "FT" && second >= 90) return second + offset;
  return null;
}

function homeCapturedReplayFrame(fixture, elapsed, firstHalf) {
  const entry = homeReplayCapture.fixtures.get(String(fixture.fixture_id));
  if (!entry || !Number.isFinite(elapsed)
    || HOME_REPLAY_IDENTITY.some((key) => String(entry.identity[key]) !== String(fixture[key]))) return null;

  let closest = null, closestMinute = -1;
  for (const frame of entry.frames.values()) {
    const minute = homeReplayFrameElapsed(frame, Math.max(45, firstHalf || 45));
    if (minute === null || minute > elapsed || minute < closestMinute) continue;
    if (minute === closestMinute && closest && frame.timestamp <= closest.timestamp) continue;
    closest = frame;
    closestMinute = minute;
  }
  return closest && { elapsed: closestMinute, rows: closest.rows };
}
