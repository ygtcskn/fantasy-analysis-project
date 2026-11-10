// The chatbot's tools for the online chat: the same nine tools, with the same
// SQL and the same answers, as src/chat/tools.py, reading Cloudflare D1 (the
// copy src/chat/sync_chat_d1.py keeps) instead of chat.sqlite. Change the two
// together; tests/test_chat_cloud.py checks they still agree.
//
// The same safety rules: the AI never writes SQL (what it sends only fills
// "?" placeholders), stat names come from a fixed list, and a blank means
// "not recorded".

import { csvRow } from "./assistant.js";

// src/shared.py: matches that will never be played.
const CALLED_OFF_STATES = ["CANC", "CANCELLED", "DELETED"];

export const POSITIONS = ["Goalkeeper", "Defender", "Midfielder", "Attacker"];
const POSITION_ORDER = "CASE pm.position WHEN 'Goalkeeper' THEN 0 WHEN 'Defender' THEN 1 "
  + "WHEN 'Midfielder' THEN 2 WHEN 'Attacker' THEN 3 ELSE 4 END";

// Every stat a leaderboard can rank by: the SQL that totals it, and the column
// whose blanks show how well the season recorded it (null: always recorded).
export const STATS = {
  goals: ["SUM(pm.goals)", "goals"],
  assists: ["SUM(pm.assists)", "assists"],
  goals_and_assists: ["SUM(pm.goals) + SUM(pm.assists)", "assists"],
  expected_goals: ["ROUND(SUM(pm.expected_goals), 2)", "expected_goals"],
  shots_total: ["SUM(pm.shots_total)", "shots_total"],
  shots_on_target: ["SUM(pm.shots_on_target)", "shots_on_target"],
  key_passes: ["SUM(pm.key_passes)", "key_passes"],
  big_chances_created: ["SUM(pm.big_chances_created)", "big_chances_created"],
  passes: ["SUM(pm.passes)", "passes"],
  tackles: ["SUM(pm.tackles)", "tackles"],
  interceptions: ["SUM(pm.interceptions)", "interceptions"],
  clearances: ["SUM(pm.clearances)", "clearances"],
  saves: ["SUM(pm.saves)", "saves"],
  yellowcards: ["SUM(pm.yellowcards)", "yellowcards"],
  redcards: ["SUM(pm.redcards)", "redcards"],
  penalties_scored: ["SUM(pm.penalties_scored)", "penalties_scored"],
  own_goals: ["SUM(pm.own_goals)", "own_goals"],
  minutes: ["SUM(pm.minutes)", null],
  appearances: ["COUNT(*)", null],
  starts: ["SUM(pm.started = 1)", null],
  average_rating: ["ROUND(AVG(pm.rating), 2)", "rating"],
};
const RATING_MIN_MINUTES = 900;

const MATCH_COLUMNS = `m.fixture_id, m.season, m.round,
    strftime('%Y-%m-%d %H:%M', m.kickoff_utc, '+3 hours') AS kickoff_turkey,
    COALESCE(h.name, 'team ' || m.home_team_id) AS home_team, m.home_goals, m.away_goals,
    COALESCE(a.name, 'team ' || m.away_team_id) AS away_team`;
const MATCH_JOINS = `FROM matches m
    LEFT JOIN teams h ON h.team_id = m.home_team_id
    LEFT JOIN teams a ON a.team_id = m.away_team_id`;
// Statistics count only appearances in finished matches.
const APPEARANCES = "JOIN matches m ON m.fixture_id = pm.fixture_id AND m.finished = 1 WHERE pm.minutes > 0";

// A problem with what the AI asked for. Its message goes back to the AI.
class ToolError extends Error {}

// ------------------------------------------------------------------ answers

// 90 stays 90, 7.2345 -> 7.23, null -> blank.
function tidy(value) {
  if (typeof value === "number" && !Number.isInteger(value)) return Math.round(value * 100) / 100;
  return value;
}

// Each table as CSV under a "## title" line, then the notes.
function answerText(tables, notes = []) {
  const parts = [];
  for (const [title, found] of tables) {
    parts.push(`## ${title}`);
    if (!found.length) {
      parts.push("(no rows)");
      continue;
    }
    const columns = Object.keys(found[0]);
    parts.push(csvRow(columns));
    for (const row of found) parts.push(csvRow(columns.map((column) => tidy(row[column]))));
  }
  for (const note of notes) parts.push(`Note: ${note}`);
  return parts.join("\n");
}

// ------------------------------------------------------------------ helpers

async function rows(db, sql, params = []) {
  const result = await db.prepare(sql).bind(...params).all();
  return result.results || [];
}

async function first(db, sql, params = []) {
  return (await db.prepare(sql).bind(...params).first()) || null;
}

async function seasons(db) {
  return (await rows(db, "SELECT season FROM seasons ORDER BY season")).map((row) => row.season);
}

// src/shared.py's season_label: 2026/2027 or 2026-2027 as 2026/2027.
function seasonLabel(value) {
  const text = String(value ?? "").trim().replace(/\//g, "-");
  const match = /^(\d{4})-(\d{4})$/.exec(text);
  if (!match || Number(match[2]) !== Number(match[1]) + 1) return null;
  return `${match[1]}/${match[2]}`;
}

// A season the database has, from 2023/2024, 2023-2024 or 2023-24. No season
// means the latest one, or null when defaultLatest is false.
async function seasonArg(db, value, defaultLatest = true) {
  const available = await seasons(db);
  if (value === null || value === undefined || String(value).trim() === "") {
    return defaultLatest && available.length ? available[available.length - 1] : null;
  }
  let text = String(value).trim();
  const short = /^(\d{4})[-/](\d{2})$/.exec(text);
  if (short) text = `${short[1]}/${short[1].slice(0, 2)}${short[2]}`;
  const season = seasonLabel(text);
  if (!season) throw new ToolError(`'${value}' is not a season. Use the form 2023/2024.`);
  if (!available.includes(season)) throw new ToolError(`There is no data for ${season}. Seasons available: ${available.join(", ")}.`);
  return season;
}

async function teamName(db, teamId) {
  const row = await first(db, "SELECT name FROM teams WHERE team_id = ?", [teamId]);
  if (!row) throw new ToolError(`No team has team_id ${teamId}. Use find_team to get the id.`);
  return row.name;
}

async function playerName(db, playerId) {
  const row = await first(db, "SELECT name FROM players WHERE player_id = ?", [playerId]);
  if (!row) throw new ToolError(`No player has player_id ${playerId}. Use find_player to get the id.`);
  return row.name;
}

// src/chat/build_chat_db.py's search_name: "Beşiktaş" and "besiktas" both become "besiktas".
const TURKISH = { "ı": "i", "İ": "i", "ş": "s", "Ş": "s", "ğ": "g", "Ğ": "g", "ç": "c", "Ç": "c", "ö": "o", "Ö": "o", "ü": "u", "Ü": "u" };
export function searchName(text) {
  const folded = String(text ?? "").replace(/[ıİşŞğĞçÇöÖüÜ]/g, (letter) => TURKISH[letter]).normalize("NFKD").replace(/\p{M}/gu, "");
  return folded.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

// SQL that matches every word of a name, its parameters, and the folded name.
function nameFilter(text) {
  const folded = searchName(text);
  if (!folded) throw new ToolError("Give a name to search for.");
  const words = folded.split(" ").map((word) => word.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_"));
  return [words.map(() => "search_name LIKE ? ESCAPE '\\'").join(" AND "), words.map((word) => `%${word}%`), folded];
}

function ambiguityNote(found, folded, what) {
  if (!found.length) return [`No ${what} matches '${folded}'. Try another spelling or part of the name.`];
  const exact = found.filter((row) => searchName(row.name) === folded);
  if (found.length > 1 && exact.length !== 1) return [`Several ${what}s match. If it is not clear which one the user means, ask them.`];
  return [];
}

function minuteText(minute, extra) {
  if (minute === null || minute === undefined) return "";
  return extra ? `${minute}+${extra}` : String(minute);
}

// Matches of the season still to be played (called-off matches never will be).
async function unfinishedCount(db, season) {
  const marks = CALLED_OFF_STATES.map(() => "?").join(", ");
  const row = await first(db, `SELECT COUNT(*) AS count FROM matches WHERE season = ? AND finished = 0 `
    + `AND COALESCE(state, '') NOT IN (${marks})`, [season, ...CALLED_OFF_STATES]);
  return row ? row.count : 0;
}

// Played, won, drawn, lost, goals and points from one team's point of view.
function record(teamId, matches) {
  const totals = { played: 0, won: 0, drawn: 0, lost: 0, goals_for: 0, goals_against: 0, points: 0 };
  for (const match of matches) {
    const home = match.home_team_id === teamId;
    const [mine, theirs] = home ? [match.home_goals, match.away_goals] : [match.away_goals, match.home_goals];
    if (mine === null || mine === undefined || theirs === null || theirs === undefined) continue;
    totals.played += 1;
    totals.goals_for += mine;
    totals.goals_against += theirs;
    const outcome = mine > theirs ? "won" : mine === theirs ? "drawn" : "lost";
    totals[outcome] += 1;
    totals.points += { won: 3, drawn: 1, lost: 0 }[outcome];
  }
  return totals;
}

// -------------------------------------------------------------------- tools

async function listSeasons(db) {
  const table = await rows(db, `
        SELECT s.season, COUNT(m.fixture_id) AS matches, COALESCE(SUM(m.finished), 0) AS finished,
               date(MIN(m.kickoff_utc)) AS first_match, date(MAX(m.kickoff_utc)) AS last_match
        FROM seasons s LEFT JOIN matches m ON m.season = s.season
        GROUP BY s.season ORDER BY s.season`);
  const coverage = new Map((await rows(db, `
        SELECT pm.season, ROUND(100.0 * SUM(pm.expected_goals IS NOT NULL) / COUNT(*)) AS percent
        FROM player_matches pm ${APPEARANCES} GROUP BY pm.season`)).map((row) => [row.season, row.percent]));
  for (const row of table) row.expected_goals_recorded_percent = coverage.get(row.season) ?? null;
  return answerText([["Seasons", table]],
    ["expected_goals_recorded_percent: share of appearances with expected goals (xG) recorded."]);
}

async function findTeam(db, { name }) {
  const [sql, params, folded] = nameFilter(name);
  const found = await rows(db, `
        SELECT t.team_id, t.name, t.short_code,
               MIN(m.season) AS first_season, MAX(m.season) AS last_season
        FROM teams t LEFT JOIN matches m ON t.team_id IN (m.home_team_id, m.away_team_id)
        WHERE (${sql}) OR lower(t.short_code) = ?
        GROUP BY t.team_id ORDER BY (t.search_name = ?) DESC, t.name LIMIT 10`, [...params, folded, folded]);
  return answerText([["Teams", found]], ambiguityNote(found, folded, "team"));
}

async function findPlayer(db, { name, season }) {
  const [sql, params, folded] = nameFilter(name);
  season = await seasonArg(db, season, false);
  const inSeason = season ? "AND EXISTS (SELECT 1 FROM player_matches x WHERE x.player_id = p.player_id "
    + "AND x.season = ? AND x.minutes > 0)" : "";
  const found = await rows(db, `
        SELECT p.player_id, p.name,
               MIN(pm.season) AS first_season, MAX(pm.season) AS last_season,
               COUNT(pm.player_id) AS appearances, SUM(pm.goals) AS goals
        FROM players p
        LEFT JOIN player_matches pm ON pm.player_id = p.player_id AND pm.minutes > 0
        WHERE (${sql}) ${inSeason}
        GROUP BY p.player_id ORDER BY (p.search_name = ?) DESC, appearances DESC, p.name LIMIT 10`,
  [...params, ...(season ? [season] : []), folded]);
  for (const row of found) {
    const latest = await first(db, `
            SELECT t.name FROM player_matches pm JOIN matches m ON m.fixture_id = pm.fixture_id
            LEFT JOIN teams t ON t.team_id = pm.team_id
            WHERE pm.player_id = ? AND pm.minutes > 0 ORDER BY m.kickoff_utc DESC LIMIT 1`, [row.player_id]);
    row.latest_team = latest ? latest.name : null;
  }
  return answerText([["Players", found]], ambiguityNote(found, folded, "player"));
}

async function findMatches(db, { team_id: teamId, opponent_id: opponentId = null, season = null, venue = "any", limit = 10 }) {
  const team = await teamName(db, teamId);
  const where = ["m.finished = 1", "? IN (m.home_team_id, m.away_team_id)"], params = [teamId];
  if (opponentId !== null && opponentId !== undefined) {
    await teamName(db, opponentId);
    where.push("? IN (m.home_team_id, m.away_team_id)");
    params.push(opponentId);
  }
  season = await seasonArg(db, season, false);
  if (season) {
    where.push("m.season = ?");
    params.push(season);
  }
  if (venue === "home") {
    where.push("m.home_team_id = ?");
    params.push(teamId);
  } else if (venue === "away") {
    where.push("m.away_team_id = ?");
    params.push(teamId);
  }
  const found = await rows(db, `SELECT ${MATCH_COLUMNS}, m.home_team_id, m.away_team_id ${MATCH_JOINS} `
    + `WHERE ${where.join(" AND ")} ORDER BY m.kickoff_utc DESC`, params);
  const { points, ...totals } = record(teamId, found);
  const summary = { team, ...totals };
  for (const row of found) {
    const home = row.home_team_id === teamId;
    delete row.home_team_id;
    delete row.away_team_id;
    const [mine, theirs] = home ? [row.home_goals, row.away_goals] : [row.away_goals, row.home_goals];
    row.result_for_team = mine === null || theirs === null ? "" : mine > theirs ? "win" : mine === theirs ? "draw" : "loss";
  }
  const notes = ["Only finished matches. kickoff_turkey is Turkish time."];
  if (found.length > limit) notes.push(`Showing the ${limit} most recent of ${found.length} matches; the summary counts all of them.`);
  return answerText([["Summary", [summary]], ["Matches", found.slice(0, limit)]], notes);
}

const EVENT_KINDS = { GOAL: "goal", PENALTY: "penalty goal", OWNGOAL: "own goal", MISSED_PENALTY: "missed penalty",
  YELLOWCARD: "yellow card", REDCARD: "red card", YELLOWREDCARD: "second yellow (red card)" };

async function matchDetails(db, { fixture_id: fixtureId }) {
  const match = await rows(db, `SELECT ${MATCH_COLUMNS}, m.state, m.finished, m.home_team_id ${MATCH_JOINS} `
    + "WHERE m.fixture_id = ?", [fixtureId]);
  if (!match.length) throw new ToolError(`No match has fixture_id ${fixtureId}. Use find_matches to get the id.`);
  const homeTeamId = match[0].home_team_id;
  delete match[0].home_team_id;
  const events = await rows(db, `
        SELECT e.type, e.minute, e.extra_minute, t.name AS team, p.name AS player,
               CASE WHEN e.type = 'GOAL' THEN r.name END AS assist
        FROM events e
        LEFT JOIN teams t ON t.team_id = e.team_id
        LEFT JOIN players p ON p.player_id = e.player_id
        LEFT JOIN players r ON r.player_id = e.related_player_id
        WHERE e.fixture_id = ? AND e.type != 'SUBSTITUTION'
        ORDER BY e.minute, COALESCE(e.extra_minute, 0), e.event_id`, [fixtureId]);
  const goals = [], cards = [];
  for (const event of events) {
    const row = { minute: minuteText(event.minute, event.extra_minute), kind: EVENT_KINDS[event.type],
      team: event.team, player: event.player, assist: event.assist };
    if (["goal", "penalty goal", "own goal"].includes(row.kind)) {
      goals.push(row);
    } else {
      delete row.assist;
      cards.push(row);
    }
  }
  const players = await rows(db, `
        SELECT t.name AS team, p.name AS player, pm.position, pm.started, pm.minutes,
               pm.goals, pm.assists, pm.rating
        FROM player_matches pm
        LEFT JOIN teams t ON t.team_id = pm.team_id
        LEFT JOIN players p ON p.player_id = pm.player_id
        WHERE pm.fixture_id = ? AND pm.minutes > 0
        ORDER BY pm.team_id != ?, pm.started DESC, ${POSITION_ORDER}, p.name`, [fixtureId, homeTeamId]);
  const notes = match[0].finished ? [] : ["This match has not finished, so it has no result yet."];
  return answerText([["Match", match], ["Goals", goals], ["Cards and missed penalties", cards],
    ["Players who played", players]], notes);
}

async function playerSeasonStats(db, { player_id: playerId, season = null, last_matches: lastMatches = 0 }) {
  const player = await playerName(db, playerId);
  season = await seasonArg(db, season, false);
  const where = "pm.player_id = ?" + (season ? " AND pm.season = ?" : ""), params = [playerId, ...(season ? [season] : [])];
  const totals = await rows(db, `
        SELECT pm.season, GROUP_CONCAT(DISTINCT t.name) AS teams,
               COUNT(*) AS appearances, SUM(pm.started = 1) AS starts, SUM(pm.minutes) AS minutes,
               SUM(pm.goals) AS goals, SUM(pm.assists) AS assists,
               ROUND(SUM(pm.expected_goals), 2) AS expected_goals,
               SUM(pm.shots_total) AS shots, SUM(pm.shots_on_target) AS shots_on_target,
               SUM(pm.key_passes) AS key_passes, SUM(pm.yellowcards) AS yellow_cards,
               SUM(pm.redcards) + SUM(pm.yellowred_cards) AS red_cards,
               ROUND(AVG(pm.rating), 2) AS average_rating,
               SUM(pm.expected_goals IS NOT NULL) AS xg_recorded
        FROM player_matches pm LEFT JOIN teams t ON t.team_id = pm.team_id
        ${APPEARANCES} AND ${where}
        GROUP BY pm.season ORDER BY pm.season`, params);
  const notes = [];
  for (const row of totals) {
    const recorded = row.xg_recorded;
    delete row.xg_recorded;
    if (recorded < row.appearances) notes.push(`${row.season}: expected goals recorded in only ${recorded} of ${row.appearances} appearances.`);
  }
  if (!totals.length) notes.push(`${player} has no appearances` + (season ? ` in ${season}.` : " in the database."));
  const tables = [[`${player}: season totals`, totals]];
  if (lastMatches) {
    const recent = await rows(db, `
            SELECT pm.season, strftime('%Y-%m-%d', m.kickoff_utc, '+3 hours') AS date,
                   CASE WHEN pm.team_id = m.home_team_id THEN 'home' ELSE 'away' END AS venue,
                   COALESCE(CASE WHEN pm.team_id = m.home_team_id THEN a.name ELSE h.name END, '') AS opponent,
                   m.home_goals, m.away_goals, pm.minutes, pm.goals, pm.assists, pm.rating, m.fixture_id
            FROM player_matches pm
            JOIN matches m ON m.fixture_id = pm.fixture_id AND m.finished = 1
            LEFT JOIN teams h ON h.team_id = m.home_team_id
            LEFT JOIN teams a ON a.team_id = m.away_team_id
            WHERE pm.minutes > 0 AND ${where}
            ORDER BY m.kickoff_utc DESC LIMIT ?`, [...params, lastMatches]);
    tables.push([`${player}: last ${lastMatches} matches`, recent]);
  }
  return answerText(tables, notes);
}

async function leaderboard(db, { stat, season = null, position = null, team_id: teamId = null, min_minutes: minMinutes = null, limit = 10 }) {
  const [expression, recordedColumn] = STATS[stat];
  season = await seasonArg(db, season);
  const notes = [];
  if (minMinutes === null || minMinutes === undefined) {
    minMinutes = stat === "average_rating" ? RATING_MIN_MINUTES : 0;
    if (minMinutes) notes.push(`Only players with at least ${minMinutes} minutes are ranked.`);
  }
  const where = ["pm.season = ?"], params = [season];
  if (position) {
    where.push("pm.position = ?");
    params.push(position);
  }
  if (teamId !== null && teamId !== undefined) {
    where.push("pm.team_id = ?");
    params.push(teamId);
    notes.push(`Only appearances for ${await teamName(db, teamId)}.`);
  }
  const found = await rows(db, `
        SELECT pm.player_id, p.name AS player, GROUP_CONCAT(DISTINCT t.name) AS teams,
               ${expression} AS ${stat}, COUNT(*) AS appearances, SUM(pm.minutes) AS minutes
        FROM player_matches pm
        LEFT JOIN players p ON p.player_id = pm.player_id
        LEFT JOIN teams t ON t.team_id = pm.team_id
        ${APPEARANCES} AND ${where.join(" AND ")}
        GROUP BY pm.player_id
        HAVING (${expression}) IS NOT NULL AND SUM(pm.minutes) >= ?
        ORDER BY ${stat} DESC, minutes ASC, player LIMIT ?`, [...params, minMinutes, limit]);
  if (recordedColumn) {
    const share = await first(db, `SELECT 100.0 * SUM(pm.${recordedColumn} IS NOT NULL) / COUNT(*) AS share `
      + `FROM player_matches pm ${APPEARANCES} AND pm.season = ?`, [season]);
    if (share && share.share !== null && share.share < 90) {
      notes.push(`${stat} is recorded in only ${Math.round(share.share)}% of appearances in ${season}, so these totals undercount.`);
    }
  }
  if (await unfinishedCount(db, season)) notes.push(`${season} is still being played; these are the totals so far.`);
  const positionText = position ? ` ${position.toLowerCase()}s` : "";
  return answerText([[`${season}${positionText} by ${stat}`, found]], notes);
}

async function standings(db, { season = null }) {
  season = await seasonArg(db, season);
  const table = await rows(db, `
        SELECT s.stage_id, s.group_id, s.position, COALESCE(t.name, 'team ' || s.team_id) AS team, s.team_id,
               s.played, s.won, s.drawn, s.lost, s.goals_for, s.goals_against,
               s.goals_for - s.goals_against AS goal_difference, s.points
        FROM standings s LEFT JOIN teams t ON t.team_id = s.team_id
        WHERE s.season = ? ORDER BY s.stage_id, s.group_id, s.position`, [season]);
  if (new Set(table.map((row) => `${row.stage_id}|${row.group_id}`)).size <= 1) {
    for (const row of table) {
      delete row.stage_id;
      delete row.group_id;
    }
  }
  const notes = [];
  if (await unfinishedCount(db, season)) notes.push(`${season} is still being played; this is the table as last saved.`);
  return answerText([[`${season} league table`, table]], notes);
}

async function teamSeasonStats(db, { team_id: teamId, season = null }) {
  const team = await teamName(db, teamId);
  season = await seasonArg(db, season);
  const matches = await rows(db, "SELECT home_team_id, away_team_id, home_goals, away_goals FROM matches "
    + "WHERE season = ? AND finished = 1 AND ? IN (home_team_id, away_team_id)", [season, teamId]);
  const records = [];
  for (const [venue, chosen] of [["overall", matches], ["home", matches.filter((m) => m.home_team_id === teamId)],
    ["away", matches.filter((m) => m.away_team_id === teamId)]]) {
    records.push({ venue, ...record(teamId, chosen) });
  }
  const position = await first(db, "SELECT position, points FROM standings WHERE season = ? AND team_id = ? "
    + "ORDER BY stage_id LIMIT 1", [season, teamId]);
  const scorers = await rows(db, `
        SELECT pm.player_id, p.name AS player, SUM(pm.goals) AS goals, SUM(pm.assists) AS assists,
               COUNT(*) AS appearances, SUM(pm.minutes) AS minutes
        FROM player_matches pm LEFT JOIN players p ON p.player_id = pm.player_id
        ${APPEARANCES} AND pm.team_id = ? AND pm.season = ?
        GROUP BY pm.player_id ORDER BY goals DESC, assists DESC, minutes DESC LIMIT 5`, [teamId, season]);
  const notes = [];
  if (position) notes.push(`League position in the saved table: ${position.position} with ${position.points} points.`);
  if (await unfinishedCount(db, season)) notes.push(`${season} is still being played; these are the numbers so far.`);
  return answerText([[`${team} ${season} record`, records], [`${team} ${season} top scorers`, scorers]], notes);
}

// ------------------------------------------------------ the list the AI sees

function schema(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

const SEASON = { type: "string", description: "Season such as 2023/2024." };
const SEASON_LATEST = { type: "string", description: "Season such as 2023/2024. Leave out for the latest season." };

const TOOLS = [
  ["list_seasons",
    "List the seasons in the database, how many matches each has, and how well expected goals (xG) "
    + "were recorded. Use it when the user asks which seasons you know about.",
    schema({}), listSeasons],
  ["find_team",
    "Find a club's team_id from its name or short code (for example 'fener', 'Beşiktaş', 'GS'). "
    + "Call this before any tool that needs a team_id.",
    schema({ name: { type: "string", description: "Club name, part of it, or short code." } }, ["name"]),
    findTeam],
  ["find_player",
    "Find a player's player_id from their name, with the seasons they played and their latest club. "
    + "Call this before any tool that needs a player_id. If several players match, ask the user which one.",
    schema({ name: { type: "string", description: "Player name or part of it." },
      season: { ...SEASON, description: "Optional: only players who played in this season." } }, ["name"]),
    findPlayer],
  ["find_matches",
    "Finished matches of one team, newest first, with a win/draw/loss summary. Add opponent_id for "
    + "head-to-head results, season to limit to one season, and venue for home or away games only.",
    schema({ team_id: { type: "integer" },
      opponent_id: { type: "integer", description: "Optional second team, for head-to-head." },
      season: { ...SEASON, description: "Optional. Leave out for every season." },
      venue: { type: "string", enum: ["any", "home", "away"] },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "How many matches to list (default 10)." } },
    ["team_id"]),
    findMatches],
  ["match_details",
    "Everything about one match: score, goals with scorers and assists, cards, and the players "
    + "who played with their minutes and ratings.",
    schema({ fixture_id: { type: "integer" } }, ["fixture_id"]),
    matchDetails],
  ["player_season_stats",
    "A player's totals per season: appearances, minutes, goals, assists, xG, shots, cards and average "
    + "rating. Set last_matches to also list their most recent matches.",
    schema({ player_id: { type: "integer" },
      season: { ...SEASON, description: "Optional. Leave out for every season." },
      last_matches: { type: "integer", minimum: 0, maximum: 20, description: "How many recent matches to list (default 0)." } },
    ["player_id"]),
    playerSeasonStats],
  ["leaderboard",
    "Rank players in one season by a stat, for questions like 'top scorers' or 'most assists by a "
    + "defender'. Can be limited to one position or one team.",
    schema({ stat: { type: "string", enum: Object.keys(STATS) },
      season: SEASON_LATEST,
      position: { type: "string", enum: POSITIONS },
      team_id: { type: "integer", description: "Optional: only appearances for this team." },
      min_minutes: { type: "integer", minimum: 0,
        description: `Optional minimum minutes played (default 0; ${RATING_MIN_MINUTES} for average_rating).` },
      limit: { type: "integer", minimum: 1, maximum: 30, description: "How many players to list (default 10)." } },
    ["stat"]),
    leaderboard],
  ["standings",
    "The league table for a season: position, played, won, drawn, lost, goals and points.",
    schema({ season: SEASON_LATEST }),
    standings],
  ["team_season_stats",
    "One club's season: overall, home and away record, league position, and its top scorers.",
    schema({ team_id: { type: "integer" }, season: SEASON_LATEST }, ["team_id"]),
    teamSeasonStats],
].map(([name, description, parameters, run]) => ({ name, description, parameters, run }));
const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

// The inputs, checked against the tool's list. Whole-number text such as "12" is accepted as 12.
function checkArguments(tool, args) {
  const properties = tool.parameters.properties;
  const unknown = Object.keys(args).filter((name) => !(name in properties)).sort();
  if (unknown.length) {
    throw new ToolError(`${tool.name} has no input called ${unknown.join(", ")}. `
      + `Its inputs are: ${Object.keys(properties).join(", ") || "none"}.`);
  }
  const missing = tool.parameters.required.filter((name) => args[name] === null || args[name] === undefined || args[name] === "");
  if (missing.length) throw new ToolError(`${tool.name} needs ${missing.join(", ")}.`);
  const checked = {};
  for (let [name, value] of Object.entries(args)) {
    const spec = properties[name];
    if (value === null || value === undefined) continue;
    if (spec.type === "integer") {
      if (typeof value === "string" && /^\s*-?\d+\s*$/.test(value)) value = Number(value.trim());
      if (typeof value !== "number" || !Number.isInteger(value)) throw new ToolError(`${name} must be a whole number.`);
      if (value < (spec.minimum ?? value) || value > (spec.maximum ?? value)) {
        throw new ToolError(`${name} must be between ${spec.minimum ?? "-"} and ${spec.maximum ?? "-"}.`);
      }
    } else if (spec.type === "string") {
      if (typeof value !== "string") throw new ToolError(`${name} must be text.`);
      value = value.trim();
      if (spec.enum && !spec.enum.includes(value)) throw new ToolError(`${name} must be one of: ${spec.enum.join(", ")}.`);
    }
    checked[name] = value;
  }
  return checked;
}

// Run one tool and return its answer as text. Mistakes come back as "Error: ..."
// text, so the AI can read them and try again.
export async function runTool(db, name, args) {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) return `Error: there is no tool called ${name}. Tools: ${[...TOOLS_BY_NAME.keys()].join(", ")}.`;
  try {
    return await tool.run(db, checkArguments(tool, args && typeof args === "object" ? args : {}));
  } catch (error) {
    if (error instanceof ToolError) return `Error: ${error.message}`;
    throw error;
  }
}

// The tools in the form AI providers expect: name, description, input schema.
export function definitions() {
  return TOOLS.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
}
