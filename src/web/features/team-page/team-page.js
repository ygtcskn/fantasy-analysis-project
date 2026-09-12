"use strict";

const params = new URLSearchParams(location.search);
const clubId = params.get("id") || "";
const validClub = /^\d+$/.test(clubId);
const el = (id) => document.getElementById(id);
const num = (value) => value === undefined || value === null || String(value).trim() === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const node = (tag, className = "", text) => {
  const item = document.createElement(tag);
  item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
};
const requiredFiles = {
  "fixtures.csv": ["fixture_id", "season_id", "kickoff", "state", "home_team_id", "away_team_id"],
  "teams.csv": ["id", "name"],
  "player_match_stats.csv": ["fixture_id", "player_id", "team_id", "name", "started", "position"],
  "fixture_scores.csv": ["fixture_id", "participant_id", "description", "score.goals"],
};
const optionalFiles = { "fixture_formations.csv": ["fixture_id", "participant_id", "formation"] };
const club = { tables: {}, teams: new Map(), fixtures: [], scores: new Map(), selected: params.get("match"), busy: false };
const clubName = (id) => club.teams.get(id)?.name || (id === clubId ? el("team-name").textContent : `Team ${id || "unknown"}`);
const status = (fixture) => String(fixture?.["state.developer_name"] || fixture?.state || "").toUpperCase();
const completed = (fixture) => ["FT", "AET", "FT_PEN", "AWARDED", "WO"].includes(status(fixture));
const rating = (row) => {
  const value = num(row.rating);
  return value !== null && value >= 1 && value <= 10 && num(row.minutes_played) !== 0 ? value : null;
};
const week = (fixture) => fixture["round.name"] ? `Matchweek ${fixture["round.name"]}` : "Matchweek TBC";
const opponent = (fixture) => fixture.home_team_id === clubId ? fixture.away_team_id : fixture.home_team_id;
const venueSide = (fixture) => fixture.home_team_id === clubId ? "H" : "A";
const orderFixtures = (a, b) => String(a.kickoff || "9999").localeCompare(String(b.kickoff || "9999")) || a.fixture_id.localeCompare(b.fixture_id);

function setClubName(name) {
  el("team-name").textContent = name;
  document.title = `${name} — Süper Lig Lab`;
  el("team-crest").alt = `${name} logo`;
}

function crest(id) {
  const badge = node("span", "club-logo");
  const fallback = node("span", "club-logo-fallback", club.teams.get(id)?.short_code || clubName(id).split(/\s+/).map((part) => part[0]).join("").slice(0, 3));
  const img = node("img");
  img.alt = `${clubName(id)} logo`; img.width = 32; img.height = 32;
  let png = false;
  img.addEventListener("load", () => { fallback.hidden = true; img.classList.add("loaded"); });
  img.addEventListener("error", () => { if (!png) { png = true; img.src = `assets/team-logos/${encodeURIComponent(id)}.png`; } else img.remove(); });
  img.src = `assets/team-logos/${encodeURIComponent(id)}.svg`;
  badge.append(fallback, img);
  return badge;
}

function teamLink(id) {
  const link = node("a", "team-link score-club");
  link.href = `team.html?${new URLSearchParams({ id, name: clubName(id) })}`;
  link.append(crest(id), node("span", "", clubName(id)));
  return link;
}

function scorePair(fixture) {
  if (["NS", "TBA", "POSTP", "CANC", "CANCELLED"].includes(status(fixture))) return null;
  const home = club.scores.get(`${fixture.fixture_id}:${fixture.home_team_id}`);
  const away = club.scores.get(`${fixture.fixture_id}:${fixture.away_team_id}`);
  return home !== undefined && home !== null && away !== undefined && away !== null ? [home, away] : null;
}

function matchRows(fixture, teamOnly = false) {
  return (club.tables["player_match_stats.csv"] || []).filter((row) => row.fixture_id === fixture?.fixture_id && (!teamOnly || row.team_id === clubId));
}

function chooseMatch(id) {
  club.selected = id;
  const url = new URL(location.href);
  url.searchParams.set("match", id);
  // Some browsers restrict history changes for directly opened local files.
  if (location.protocol !== "file:") history.replaceState(null, "", url);
  renderClub();
}

function renderMatchList(target, fixtures, emptyText) {
  const list = el(target);
  list.replaceChildren();
  for (const fixture of fixtures) {
    const button = node("button", "team-game-row");
    button.type = "button";
    button.classList.toggle("selected", fixture.fixture_id === club.selected);
    button.setAttribute("aria-pressed", String(fixture.fixture_id === club.selected));
    button.setAttribute("aria-label", `Select ${week(fixture)}: ${clubName(opponent(fixture))}`);
    const info = node("span", "team-game-info");
    info.append(node("strong", "", clubName(opponent(fixture))), node("small", "", `${week(fixture)} · ${fixture.kickoff || "Date TBC"}`));
    const scores = scorePair(fixture);
    const result = node("span", "team-game-result", scores ? scores.join(" – ") : "—");
    if (scores) result.title = "Home score – away score";
    if (scores && completed(fixture)) {
      const [ours, theirs] = fixture.home_team_id === clubId ? scores : [...scores].reverse();
      const outcome = ours > theirs ? "W" : ours < theirs ? "L" : "D";
      result.append(node("small", `result-${outcome.toLowerCase()}`, outcome));
    }
    button.append(node("span", "venue-chip", venueSide(fixture)), crest(opponent(fixture)), info, result);
    button.addEventListener("click", () => chooseMatch(fixture.fixture_id));
    list.append(button);
  }
  if (!fixtures.length) list.append(node("p", "team-empty", emptyText));
}

function playerToken(player) {
  const token = node("div", "pitch-player");
  token.title = `${player.name || `Player ${player.player_id}`} · ${player.position || "Position not supplied"}`;
  token.append(node("span", "player-shirt", player.jersey_number || "—"), node("span", "pitch-player-name", player.name || `Player ${player.player_id}`), node("span", "pitch-rating", rating(player)?.toFixed(2) || "—"));
  return token;
}

function renderLineup(fixture) {
  const field = el("team-lineup");
  field.replaceChildren();
  field.classList.remove("role-grouped");
  const formations = new Set((club.tables["fixture_formations.csv"] || []).filter((row) => row.fixture_id === fixture?.fixture_id && row.participant_id === clubId).map((row) => row.formation).filter(Boolean));
  const formation = formations.size === 1 ? [...formations][0] : null;
  el("team-formation").textContent = formation ? `Formation ${formation}` : "Formation —";
  const starters = matchRows(fixture, true).filter((row) => ["1", "true"].includes(String(row.started).toLowerCase()));
  if (!starters.length) {
    el("lineup-note").textContent = "Starting players appear when they are supplied in the saved match data.";
    field.append(node("p", "pitch-empty", fixture ? "Starting eleven not available for this match." : "Choose a matchday to view the starting eleven."));
    return;
  }
  const widths = formation && /^\d+(?:-\d+)+$/.test(formation) ? [1, ...formation.split("-").map(Number)] : [];
  const positions = starters.map((player) => {
    const match = /^(\d+):(\d+)$/.exec(player.formation_field || "");
    return match ? { player, line: Number(match[1]), slot: Number(match[2]) } : null;
  });
  const exact = widths.length > 1 && widths.every((width) => width > 0) && widths.reduce((a, b) => a + b, 0) === 11 && starters.length === 11
    && positions.every((p) => p && p.line >= 1 && p.line <= widths.length && p.slot >= 1 && p.slot <= widths[p.line - 1])
    && new Set(positions.map((p) => p && `${p.line}:${p.slot}`)).size === 11;
  let lines;
  if (exact) {
    lines = widths.map((_, index) => ({ players: positions.filter((p) => p.line === index + 1).sort((a, b) => a.slot - b.slot).map((p) => p.player) })).reverse();
    el("lineup-note").textContent = "11 starters · Formation slots supplied by Sportmonks. Attacking direction ↑";
  } else {
    const groups = new Map();
    for (const player of starters) {
      const role = player.position || "Position not supplied";
      if (!groups.has(role)) groups.set(role, []);
      groups.get(role).push(player);
    }
    const roleOrder = (role) => /goalkeeper/i.test(role) ? 0 : /defender/i.test(role) ? 1 : /midfielder/i.test(role) ? 2 : /attacker|forward|striker/i.test(role) ? 3 : 4;
    lines = [...groups].sort((a, b) => roleOrder(b[0]) - roleOrder(a[0])).map(([label, players]) => ({ label, players }));
    el("lineup-note").textContent = `${starters.length} starter records · Grouped by recorded role; exact formation slots are unavailable or incomplete. The formation label is supplied separately.`;
  }
  field.classList.toggle("role-grouped", !exact);
  for (const line of lines) {
    const row = node("div", "pitch-line");
    if (line.label) row.append(node("span", "pitch-role", line.label));
    const players = node("div", "pitch-line-players");
    line.players.forEach((player) => players.append(playerToken(player)));
    row.append(players); field.append(row);
  }
}

function bestPlayerRow(player, index, subtitle, value) {
  const row = node("div", "team-best-player");
  const identity = node("div", "best-player-info");
  identity.append(node("strong", "", player.name || `Player ${player.player_id}`), node("small", "", subtitle));
  row.append(node("span", "best-player-rank", String(index + 1).padStart(2, "0")), identity, node("strong", "team-rating", value.toFixed(2)));
  return row;
}

function renderSelected(fixture) {
  const box = el("team-score"), best = el("team-match-best");
  box.replaceChildren(); best.replaceChildren();
  el("selected-title").textContent = fixture ? week(fixture) : "Selected matchweek";
  if (!fixture) {
    box.append(node("p", "team-empty", "Select a match to see its details."));
    best.append(node("p", "team-empty", "Match ratings will appear here."));
    return;
  }
  const scores = scorePair(fixture);
  box.append(node("p", "team-muted", `${fixture.kickoff || "Date TBC"} · ${fixture["state.name"] || fixture.state || "Status not supplied"}`));
  const scoreline = node("div", "team-scoreline");
  scoreline.append(teamLink(fixture.home_team_id), node("strong", "team-score-value", scores ? scores.join(" – ") : "— : —"), teamLink(fixture.away_team_id));
  box.append(scoreline, node("p", "team-muted", fixture["venue.name"] || "Venue not supplied"));
  const rated = matchRows(fixture).filter((row) => rating(row) !== null).sort((a, b) => rating(b) - rating(a) || String(a.name).localeCompare(String(b.name)));
  rated.slice(0, 3).forEach((player, index) => best.append(bestPlayerRow(player, index, `${clubName(player.team_id)} · ${num(player.minutes_played) ?? "—"} min`, rating(player))));
  if (!rated.length) best.append(node("p", "team-empty", "No eligible match ratings supplied yet."));
}

function renderOverall() {
  const finished = new Set(club.fixtures.filter(completed).map((fixture) => fixture.fixture_id));
  const players = new Map();
  for (const row of club.tables["player_match_stats.csv"] || []) {
    const value = rating(row);
    if (row.team_id !== clubId || !finished.has(row.fixture_id) || value === null) continue;
    if (!players.has(row.player_id)) players.set(row.player_id, { ...row, sum: 0, count: 0 });
    const player = players.get(row.player_id);
    player.sum += value; player.count++;
  }
  const minimum = Number(el("team-min-rated").value);
  const ranked = [...players.values()].filter((player) => player.count >= minimum).map((player) => ({ ...player, average: player.sum / player.count })).sort((a, b) => b.average - a.average || b.count - a.count || String(a.name).localeCompare(String(b.name)));
  const list = el("team-overall");
  list.replaceChildren();
  ranked.slice(0, 5).forEach((player, index) => list.append(bestPlayerRow(player, index, `${player.position || "Role not supplied"} · ${player.count} rated matches`, player.average)));
  if (!ranked.length) list.append(node("p", "team-empty", `No players with at least ${minimum} rated matches. Try a lower minimum or load more match data.`));
}

function renderClub() {
  const fixtures = club.fixtures;
  const played = fixtures.filter(completed);
  // Preserve a requested match while the initial CSV load is still pending.
  if (fixtures.length && !fixtures.some((fixture) => fixture.fixture_id === club.selected)) club.selected = (played[played.length - 1] || fixtures[0]).fixture_id;
  const select = el("team-match");
  select.replaceChildren();
  fixtures.forEach((fixture) => select.add(new Option(`${week(fixture)} · ${clubName(opponent(fixture))} (${venueSide(fixture)})`, fixture.fixture_id)));
  if (!fixtures.length) select.add(new Option("No matches loaded", ""));
  select.value = club.selected || ""; select.disabled = !fixtures.length;
  const index = fixtures.findIndex((fixture) => fixture.fixture_id === club.selected);
  el("team-week-prev").disabled = index <= 0;
  el("team-week-next").disabled = index < 0 || index >= fixtures.length - 1;
  el("played-count").textContent = `${played.length} matches`;
  renderMatchList("team-played", [...played].reverse(), "No completed matches in the saved data.");
  const now = Date.now() / 1000;
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = fixtures.filter((fixture) => {
    if (completed(fixture) || ["CANC", "CANCELLED", "POSTP", "ABANDONED"].includes(status(fixture))) return false;
    const timestamp = num(fixture.starting_at_timestamp);
    if (timestamp !== null) return timestamp >= now;
    return ["NS", "TBA"].includes(status(fixture)) && (!fixture.kickoff || fixture.kickoff.slice(0, 10) >= today);
  });
  renderMatchList("team-upcoming", upcoming.slice(0, 5), "No upcoming scheduled games in the saved data.");
  renderLineup(fixtures[index]); renderSelected(fixtures[index]); renderOverall();
}

function validateTables(tables) {
  for (const name of Object.keys(requiredFiles)) if (!tables[name]) throw new Error(`Include ${name}.`);
  const seasons = new Set(tables["fixtures.csv"].map((row) => row.season_id).filter(Boolean));
  if (seasons.size > 1) throw new Error("Select files from one season together.");
  for (const [name, key] of [["fixtures.csv", (r) => r.fixture_id], ["teams.csv", (r) => r.id], ["player_match_stats.csv", (r) => `${r.fixture_id}:${r.player_id}`]]) {
    const ids = new Set();
    for (const row of tables[name]) {
      const id = key(row);
      if (ids.has(id)) throw new Error(`Duplicate records in ${name}.`);
      ids.add(id);
    }
  }
  const fixtures = new Map(tables["fixtures.csv"].map((row) => [row.fixture_id, row]));
  for (const name of ["player_match_stats.csv", "fixture_scores.csv", "fixture_formations.csv"]) {
    for (const row of tables[name] || []) {
      const fixture = fixtures.get(row.fixture_id);
      if (!fixture || ![fixture.home_team_id, fixture.away_team_id].includes(row.team_id || row.participant_id)) throw new Error(`${name} contains records that do not match these fixtures.`);
    }
  }
}

async function loadClubData(files) {
  if (club.busy || !validClub) return;
  club.busy = true;
  el("team-open").disabled = el("team-refresh").disabled = true;
  el("team-message").classList.remove("error");
  el("team-message").textContent = "Reading saved team data…";
  try {
    const tables = {};
    if (!files) {
      const results = await Promise.allSettled(Object.keys({ ...requiredFiles, ...optionalFiles }).map(async (name) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
          const response = await fetch(`/local-data/${name}`, { cache: "no-store", signal: controller.signal });
          if (response.status === 404 && optionalFiles[name]) return null;
          if (!response.ok || response.headers.get("X-Superlig-Local") !== "1") throw new Error(`Cannot load ${name}. Restart the local server and check the saved CSVs.`);
          return new File([await response.blob()], name);
        } finally { clearTimeout(timeout); }
      }));
      const errors = results.filter((result) => result.status === "rejected");
      if (errors.length) throw new Error(errors.map((result) => result.reason.message).join(" "));
      files = results.map((result) => result.value).filter(Boolean);
    }
    for (const file of files) {
      const columns = requiredFiles[file.name] || optionalFiles[file.name];
      if (!columns) continue;
      if (tables[file.name]) throw new Error(`Select only one ${file.name}.`);
      if (file.size > 40 * 1024 * 1024) throw new Error(`${file.name} exceeds 40 MB.`);
      const parsed = parseCSV(await file.text());
      if (columns.some((column) => !parsed.header.includes(column))) throw new Error(`Missing required columns in ${file.name}.`);
      tables[file.name] = parsed.records;
    }
    validateTables(tables);
    club.tables = tables;
    club.teams = new Map(tables["teams.csv"].map((row) => [row.id, row]));
    club.fixtures = tables["fixtures.csv"].filter((fixture) => [fixture.home_team_id, fixture.away_team_id].includes(clubId)).sort(orderFixtures);
    club.scores = new Map();
    for (const row of tables["fixture_scores.csv"]) {
      if (row.description !== "CURRENT") continue;
      const key = `${row.fixture_id}:${row.participant_id}`;
      const n = num(row["score.goals"]);
      const value = n !== null && Number.isInteger(n) && n >= 0 ? n : null;
      club.scores.set(key, club.scores.has(key) && club.scores.get(key) !== value ? null : value);
    }
    if (club.teams.has(clubId)) setClubName(clubName(clubId));
    el("team-season").textContent = `${club.fixtures.length} season fixtures · Sportmonks`;
    renderClub();
    el("team-message").textContent = `Saved data loaded at ${new Date().toLocaleTimeString()}.${tables["fixture_formations.csv"] ? "" : " Add fixture_formations.csv to show supplied formations."}`;
  } catch (error) {
    el("team-message").classList.add("error");
    el("team-message").textContent = `${error.message} Previously displayed data is kept. After a download finishes, refresh saved data.`;
  } finally {
    club.busy = false;
    el("team-open").disabled = el("team-refresh").disabled = false;
    el("team-files").value = "";
  }
}

setClubName(validClub ? (params.get("name") || `Team ${clubId}`).slice(0, 160) : "Team not found");
if (validClub) {
  const img = el("team-crest");
  let png = false;
  img.addEventListener("load", () => { img.hidden = false; });
  img.addEventListener("error", () => { if (!png) { png = true; img.src = `assets/team-logos/${clubId}.png`; } else img.hidden = true; });
  img.src = `assets/team-logos/${clubId}.svg`;
}
el("team-match").addEventListener("change", (event) => chooseMatch(event.target.value));
for (const [id, delta] of [["team-week-prev", -1], ["team-week-next", 1]]) el(id).addEventListener("click", () => {
  const index = club.fixtures.findIndex((fixture) => fixture.fixture_id === club.selected);
  const fixture = club.fixtures[index + delta];
  if (fixture) chooseMatch(fixture.fixture_id);
});
el("team-min-rated").addEventListener("change", renderOverall);
el("team-refresh").addEventListener("click", () => loadClubData());
el("team-open").addEventListener("click", () => el("team-files").click());
el("team-files").addEventListener("change", (event) => loadClubData([...event.target.files]));
renderClub();
if (validClub && location.protocol === "http:" && ["127.0.0.1", "localhost"].includes(location.hostname)) {
  el("team-refresh").hidden = false;
  loadClubData();
} else {
  el("team-message").textContent = validClub ? "Open fixtures.csv, teams.csv, player_match_stats.csv, fixture_scores.csv and fixture_formations.csv together, or use the local server for automatic loading." : "Choose a team from the league overview.";
  el("team-open").disabled = !validClub;
}
