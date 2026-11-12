"use strict";

// The local demo sends the same flat records to Home as /local-live.csv.
// Its fixture and players are selected from saved data, and its play is scripted.
const homeSimulation = { session: null, rows: [], frame: 0, timer: null };
const homeSimulationFrames = [
  ...[0, 1, 6, 12, 18, 24, 30, 36, 42, 45].map((minute) => [minute, 0, "INPLAY_1ST_HALF"]),
  [45, 1, "INPLAY_1ST_HALF"], [45, 2, "HT"],
  ...[49, 54, 59, 64, 69, 73, 78, 83, 88, 90].map((minute) => [minute, 0, "INPLAY_2ND_HALF"]),
  [90, 3, "INPLAY_2ND_HALF"], [90, 3, "FT"],
];
const homeSimulationFirstHalf = 47;
const homeSimulationFinalMinute = 95;
const homeSimulationShape = [1, 4, 2, 3, 1];
const homeSimulationPositions = ["Goalkeeper", "Defender", "Midfielder", "Midfielder", "Attacker"];
const homeSimulationEvents = [
  { minute: 12, side: 1, code: "YELLOWCARD", player: 3 },
  { minute: 18, side: 0, code: "GOAL", player: 10, related: 9, result: "1-0" },
  { minute: 45, extra: 1, side: 1, code: "GOAL", player: 10, related: 7, result: "1-1" },
  { minute: 59, side: 0, code: "SUBSTITUTION", player: 11, related: 8 },
  { minute: 69, side: 1, code: "SUBSTITUTION", player: 11, related: 8 },
  { minute: 73, side: 0, code: "PENALTY", player: 10, result: "2-1" },
  { minute: 82, side: 1, code: "REDCARD", player: 3 },
  { minute: 88, side: 0, code: "GOAL", player: 7, result: "3-1", info: "Free Kick" },
];

function homeSimulationRows() {
  return homeSimulation.rows;
}

// The pressure chart includes stoppage time in its continuous elapsed minutes.
// Convert those minutes to the same match clock the simulated feed reports.
function homeSimulationReplayRows(elapsed) {
  const { session, rows, frame } = homeSimulation;
  if (!session) return [];
  const [minute, extra] = homeSimulationFrames[frame];
  const latest = homeSimulationElapsed(minute, extra);
  const requested = Number(elapsed);
  if (!Number.isFinite(requested) || requested >= latest) return rows;
  const through = Math.max(0, Math.floor(requested));
  if (through <= homeSimulationFirstHalf) {
    const status = through === homeSimulationFirstHalf ? "HT" : "INPLAY_1ST_HALF";
    return homeSimulationSnapshot(session, [Math.min(45, through), Math.max(0, through - 45), status]);
  }
  const matchMinute = 45 + through - homeSimulationFirstHalf;
  return homeSimulationSnapshot(session, [Math.min(90, matchMinute), Math.max(0, matchMinute - 90), "INPLAY_2ND_HALF"]);
}

function homeSimulationActive() {
  return Boolean(homeSimulation.session);
}

function homeSimulationStandings(rows) {
  const fixture = homeSimulation.session?.fixture;
  const snapshot = homeSimulationRows();
  if (!fixture) return null;
  if (!fixtureFinished(fixture)) return matchweekLiveStandings(rows, snapshot);
  const summary = snapshot.find((row) => row.record_type === "fixture");
  return homeReplayStandings(fixture, summary, rows, { includeKickoff: true });
}

function homeSimulationEligible(fixture) {
  return Boolean(fixture.fixture_id && fixture.home_team_id && fixture.away_team_id
    && fixture.home_team_id !== fixture.away_team_id && Number.isFinite(kickoffTime(fixture))
    && ["NS", "FT", "AET", "FT_PEN"].includes(fixtureState(fixture)));
}

function homeSimulationChooseFixture() {
  const weeks = homeWeeks();
  const current = weeks[currentRoundIndex(weeks)];
  const options = (week) => week?.fixtures.filter(homeSimulationEligible) || [];
  const scheduled = (fixture) => fixtureState(fixture) === "NS";
  const currentFixture = options(current).find(scheduled);
  if (currentFixture) return { fixture: currentFixture, week: current.key };
  for (const week of weeks) {
    const fixture = options(week).find(scheduled);
    if (fixture) return { fixture, week: week.key };
  }
  for (const week of [...weeks].reverse()) {
    const fixture = options(week).at(-1);
    if (fixture) return { fixture, week: week.key };
  }
  return null;
}

function homeSimulationPlayers(teamId) {
  const role = (player) => {
    const position = player.position || player["position.name"] || "";
    return /goalkeeper/i.test(position) ? 0 : /defender|back/i.test(position) ? 1 : /midfield/i.test(position) ? 2 : 3;
  };
  const appearances = new Map();
  for (const row of state.tables["player_match_stats.csv"] || []) {
    if (row.team_id !== teamId || !row.player_id) continue;
    if (!appearances.has(row.fixture_id)) appearances.set(row.fixture_id, []);
    appearances.get(row.fixture_id).push(row);
  }
  const started = (row) => /^(1|true)$/i.test(row.started);
  const recent = (state.tables["fixtures.csv"] || []).filter((fixture) => fixtureFinished(fixture) && appearances.has(fixture.fixture_id))
    .sort((a, b) => kickoffTime(b) - kickoffTime(a));
  const last = recent.map((fixture) => appearances.get(fixture.fixture_id))
    .find((rows) => new Set(rows.filter(started).map((row) => row.player_id)).size === 11);
  const roster = (state.tables["squads.csv"] || []).filter((row) => row.team_id === teamId && row.player_id);
  const candidates = last ? [...last.filter(started).sort((a, b) => role(a) - role(b)), ...last.filter((row) => !started(row)), ...roster]
    : roster.sort((a, b) => role(a) - role(b));
  const unique = new Map();
  for (const player of candidates) {
    if (!unique.has(player.player_id)) unique.set(player.player_id, player);
    if (unique.size === 12) break;
  }
  const players = [...unique.values()];
  const positions = homeSimulationShape.flatMap((size, line) => Array.from({ length: size }, (_, column) => ({
    position: homeSimulationPositions[line], formation_field: `${line + 1}:${column + 1}`,
  })));
  return Array.from({ length: 12 }, (_, index) => {
    const saved = players[index];
    return {
      player_id: saved?.player_id || `simulation-${teamId}-${index + 1}`,
      player_name: saved ? playerName(saved.player_id, saved.name) : t("Oyuncu {id}", { id: index + 1 }),
      jersey_number: saved?.jersey_number || String(index + 1),
      started: index < 11 ? "1" : "0",
      ...positions[index],
    };
  });
}

function homeSimulationElapsed(minute, extra = 0) {
  return minute + extra + (minute > 45 ? homeSimulationFirstHalf - 45 : 0);
}

// Keep each passing count cumulative while changing how the clubs play in
// three stretches, so their dots move as the match unfolds.
function homeSimulationPasses(passes, fullMatchPasses, side) {
  const rates = side ? [[0.25, 0.81, 0.11], [0.65, 0.72, 0.21], [1, 0.78, 0.15]]
    : [[0.25, 0.78, 0.15], [0.65, 0.90, 0.08], [1, 0.88, 0.05]];
  let through = 0, accurate = 0, long = 0;
  for (const [end, accuracy, longShare] of rates) {
    const next = Math.min(passes, Math.round(end * fullMatchPasses));
    const count = next - through;
    accurate += Math.round(count * accuracy);
    long += Math.round(count * longShare);
    through = next;
  }
  return { accurate, long };
}

function homeSimulationSnapshot(session, [minute, extra, matchState]) {
  const { fixture, teams, players } = session;
  const { fixture_id, league_id, season_id, home_team_id, away_team_id } = fixture;
  const sides = [home_team_id, away_team_id];
  const elapsed = homeSimulationElapsed(minute, extra);
  const knownEvents = homeSimulationEvents.filter((event) => event.minute < minute
    || (event.minute === minute && (event.extra || 0) <= extra));
  const score = knownEvents.filter((event) => event.result).at(-1)?.result.split("-") || ["0", "0"];
  const hasHalfScore = elapsed >= homeSimulationFirstHalf;
  const isTicking = matchState !== "HT" && matchState !== "FT";
  const rows = [{ record_type: "fixture", fixture_id, league_id, season_id,
    state: matchState, simulated: "1", minute: isTicking ? String(minute) : "", extra_minute: isTicking && extra ? String(extra) : "",
    home_team_id, away_team_id, home_name: teamName(home_team_id, teams), away_name: teamName(away_team_id, teams),
    home_score: score[0], away_score: score[1], home_half_score: hasHalfScore ? "1" : "", away_half_score: hasHalfScore ? "1" : "",
    statistics_available: "1", events_available: "1", pressure_available: "1", periods_available: "1", xg_available: "1",
    formations_available: "1", lineups_available: "1",
  }];
  const add = (record_type, fields) => rows.push({ record_type, fixture_id, ...fields });
  add("period", { code: "1ST_HALF", minute: String(Math.min(elapsed, homeSimulationFirstHalf)), ticking: matchState === "INPLAY_1ST_HALF" ? "1" : "0" });
  if (minute > 45) add("period", { code: "2ND_HALF", minute: String(minute + extra), ticking: isTicking ? "1" : "0" });

  knownEvents.forEach((event, index) => {
    const player = players[event.side][event.player], related = players[event.side][event.related];
    add("event", { team_id: sides[event.side], code: event.code, event_id: `simulation-${index + 1}`,
      minute: String(event.minute), extra_minute: event.extra ? String(event.extra) : "", sort_order: String(index + 1),
      player_id: player.player_id, player_name: player.player_name, related_player_id: related?.player_id || "",
      related_player_name: related?.player_name || "", result: event.result || "", info: event.info || "", rescinded: "0",
    });
  });

  for (let sample = 1; sample <= elapsed; sample += 1) {
    const pressure = Math.round(44 * Math.sin(sample / 4) + 18 * Math.sin(sample / 1.9) + 8);
    sides.forEach((team_id, side) => add("pressure", { team_id, minute: String(sample), value: String(Math.max(0, side ? -pressure : pressure)) }));
  }

  const fraction = elapsed / homeSimulationFinalMinute;
  const possession = 50 + Math.round(Math.min(1, elapsed / 15) * (4 + 6 * Math.sin(elapsed / 16)));
  sides.forEach((team_id, side) => {
    const ownEvents = knownEvents.filter((event) => event.side === side);
    const count = (code) => ownEvents.filter((event) => event.code === code).length;
    const total = (home, away) => Math.floor(fraction * (side ? away : home));
    const fullMatchPasses = side ? 384 : 510, passes = Math.floor(fraction * fullMatchPasses);
    const shots = Math.max(Number(score[side]), total(17, 11));
    const penalties = count("PENALTY");
    const nonPenaltyShotShare = (shots - penalties) / (side ? 11 : 16);
    const openPlayXg = nonPenaltyShotShare * (side ? 0.77 : 1.43);
    const setPlayXg = nonPenaltyShotShare * (side ? 0.21 : 0.59);
    const passing = homeSimulationPasses(passes, fullMatchPasses, side);
    const penaltyXg = penalties * 0.79;
    for (const [type_id, value] of [[45, side ? 100 - possession : possession], [42, shots],
      [86, Math.max(Number(score[side]), total(8, 4))], [34, total(6, 4)], [44, total(55, 36)], [56, total(11, 15)],
      [84, count("YELLOWCARD")], [83, count("REDCARD")], [85, 0], [80, passes], [81, passing.accurate],
      [62, passing.long], [98, total(21, 15)], [55, total(15, 11)], [106, total(59, 46)], [109, total(13, 8)]]) {
      add("statistic", { team_id, source: "statistics", type_id: String(type_id), value: String(value) });
    }
    for (const [type_id, value] of [[5304, openPlayXg + setPlayXg + penaltyXg], [7944, setPlayXg], [7945, openPlayXg]]) {
      add("statistic", { team_id, source: "xgfixture", type_id: String(type_id), value: value.toFixed(2) });
    }
    add("formation", { team_id, formation: homeSimulationShape.slice(1).join("-") });
    const substitution = ownEvents.find((event) => event.code === "SUBSTITUTION");
    const substitutionMinute = substitution ? homeSimulationElapsed(substitution.minute, substitution.extra) : elapsed;
    const departure = new Map();
    if (substitution) departure.set(substitution.related, substitutionMinute);
    for (const event of ownEvents) {
      if (event.code === "REDCARD") departure.set(event.player, homeSimulationElapsed(event.minute, event.extra));
    }
    players[side].forEach((player, index) => {
      const minutes = index === 11 ? elapsed - substitutionMinute : departure.get(index) ?? elapsed;
      const playerCount = (factor) => String(Math.floor(minutes * (index % 3 + 1) / factor));
      add("lineup", { team_id, ...player, minutes_played: String(minutes),
        aerials_won: playerCount(55), fouls_drawn: playerCount(64), dispossessed: playerCount(80),
      });
    });
  });
  return rows;
}

function stopHomeSimulation() {
  const session = homeSimulation.session;
  if (!session) return;
  clearTimeout(homeSimulation.timer);
  if (state.homeFixture === session.fixture.fixture_id) {
    state.homeFixture = session.previousFixture;
    homeSelection.manual = session.previousManual;
  }
  if (state.homeWeek === session.week) state.homeWeek = session.previousWeek;
  Object.assign(homeSimulation, { session: null, rows: [], frame: 0, timer: null });
}

function syncHomeSimulationControl() {
  const button = $("home-simulation"), status = $("home-simulation-status");
  button.hidden = siteMode !== "local";
  if (button.hidden) return;
  if (homeSimulation.session && state.tables["fixtures.csv"] !== homeSimulation.session.fixtures) stopHomeSimulation();
  const active = homeSimulationActive();
  const available = active || (state.tables["fixtures.csv"] || []).some(homeSimulationEligible);
  button.disabled = !available;
  button.dataset.active = String(active);
  const label = active ? t("Simülasyonu durdur") : t("Maç simülasyonu");
  if (button.textContent !== label) button.textContent = label;
  const message = !available ? t("Simülasyon için fikstür verisi gerekiyor.")
    : active && homeSimulation.frame === homeSimulationFrames.length - 1 ? t("Simülasyon tamamlandı") : "";
  if (status.textContent !== message) status.textContent = message;
}

function advanceHomeSimulation() {
  const session = homeSimulation.session;
  if (!session) return;
  if (state.tables["fixtures.csv"] !== session.fixtures) {
    stopHomeSimulation();
  } else {
    const frame = homeSimulationFrames[homeSimulation.frame];
    homeSimulation.rows = homeSimulationSnapshot(session, frame);
    if (homeSimulation.frame + 1 < homeSimulationFrames.length) {
      homeSimulation.timer = setTimeout(() => {
        homeSimulation.frame += 1;
        advanceHomeSimulation();
      }, frame[2] === "HT" ? 2800 : frame[0] === 0 ? 2500 : 1700);
    }
  }
  if (state.view === "home") renderHomeLive();
  else if (state.view === "standings") renderDetailedStandings();
}

function setupHomeSimulation() {
  $("home-simulation").addEventListener("click", () => {
    if (siteMode !== "local") return;
    if (homeSimulationActive()) {
      stopHomeSimulation();
      renderHomeLive();
      return;
    }
    const selection = homeSimulationChooseFixture();
    if (!selection) return;
    const { fixture, week } = selection;
    homeSimulation.session = { ...selection, fixtures: state.tables["fixtures.csv"], teams: homeTeams(),
      players: [fixture.home_team_id, fixture.away_team_id].map(homeSimulationPlayers),
      previousFixture: state.homeFixture, previousWeek: state.homeWeek, previousManual: homeSelection.manual,
    };
    state.homeFixture = fixture.fixture_id;
    state.homeWeek = week;
    advanceHomeSimulation();
  });
}
