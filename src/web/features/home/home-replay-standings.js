"use strict";

// Find the end of the last regulation, extra-time or penalty period that
// Sportmonks recorded. A first-half whistle alone cannot date a result.
const homeReplayFinishCache = { periods: null, times: new Map() };

function homeReplayFinishTimes() {
  const times = new Map();
  if (teamAnalysisExtras.key !== state.seasonSlug) return times;
  const periods = teamAnalysisExtras.periods;
  if (homeReplayFinishCache.periods === periods) return homeReplayFinishCache.times;
  for (const period of periods || []) {
    const ended = number(period.ended), from = number(period.counts_from);
    if (ended === null || ended <= 0) continue;
    const description = String(period.description || "").toLowerCase();
    const status = /penalt/.test(description) ? "FT_PEN" : from >= 105 ? "AET"
      : from === 45 && number(period.period_length) === 45 ? "FT" : "";
    if (!status) continue;
    const key = `${period.fixture_id}|${status}`;
    times.set(key, Math.max(times.get(key) || 0, ended * 1000));
  }
  Object.assign(homeReplayFinishCache, { periods, times });
  return times;
}

function homeReplayFinishedBy(game, cutoff, finishes) {
  const status = fixtureState(game), start = kickoffTime(game);
  if (!["FT", "AET", "FT_PEN"].includes(status) || !Number.isFinite(start) || start >= cutoff) return false;
  const finalPeriod = finishes.get(`${game.fixture_id}|${status}`);
  const end = finalPeriod && finalPeriod > start ? finalPeriod : start + (status === "FT" ? 135 : 180) * 60000;
  return end <= cutoff;
}

// The round snapshot can include matches played after the chosen kickoff.
// Rebuild this table from results already complete at that kickoff, then add
// only the selected fixture's score as it stood at the replay minute.
function homeReplayStandings(fixture, summary, groupRows = state.tables["standings.csv"] || [], { includeKickoff = false } = {}) {
  const kickoff = kickoffTime(fixture);
  const scope = ["league_id", "season_id", "stage_id", "group_id"];
  const inCompetition = (row) => scope.every((key) => !row[key] || !fixture[key] || row[key] === fixture[key]);
  const rows = groupRows.filter(inCompetition);
  const totals = new Map(rows.map((row) => [row.participant_id, { points: 0, played: 0, draws: 0, losses: 0, scored: 0, conceded: 0 }]));
  if (!Number.isFinite(kickoff) || !totals.has(fixture.home_team_id) || !totals.has(fixture.away_team_id)) return null;

  const scores = currentFixtureScores();
  const finishes = homeReplayFinishTimes();
  for (const game of state.tables["fixtures.csv"] || []) {
    if (game.fixture_id === fixture.fixture_id || !inCompetition(game)) continue;
    const home = totals.get(game.home_team_id), away = totals.get(game.away_team_id);
    if (!home || !away) continue;
    if (!homeReplayFinishedBy(game, kickoff, finishes)) continue;

    const own = homeScoreValue(scores.get(`${game.fixture_id}:${game.home_team_id}`));
    const other = homeScoreValue(scores.get(`${game.fixture_id}:${game.away_team_id}`));
    if (own === null || other === null) continue;
    for (const [record, scored, conceded] of [[home, own, other], [away, other, own]]) {
      record.played += 1;
      record.draws += Number(scored === conceded);
      record.losses += Number(scored < conceded);
      record.points += scored > conceded ? 3 : scored === conceded ? 1 : 0;
      record.scored += scored;
      record.conceded += conceded;
    }
  }

  const teams = new Map();
  const home = homeScoreValue(summary?.home_score), away = homeScoreValue(summary?.away_score);
  if (home !== null && away !== null && (includeKickoff || number(summary.minute) !== 0) && !fixtureUnplayed({ state: summary.state })) {
    const names = homeTeams();
    const sides = [[fixture.home_team_id, fixture.away_team_id, home, away], [fixture.away_team_id, fixture.home_team_id, away, home]];
    for (const [id, opponentId, own, other] of sides) {
      const base = totals.get(id).points;
      const status = own > other ? "win" : own < other ? "loss" : "draw";
      const gained = { win: 3, draw: 1, loss: 0 }[status];
      teams.set(id, { status, own, other, opponentId, opponent: teamName(opponentId, names), game: summary, live: !matchweekFinished(summary),
        base, gained, points: base + gained, played: 1, won: Number(status === "win"), draws: Number(status === "draw"),
        losses: Number(status === "loss"), goalDifference: own - other, goalsFor: own, goalsAgainst: other });
    }
  }

  const names = homeTeams();
  const sorted = rows.map((row) => {
    const { points, played, draws, losses, scored, conceded } = totals.get(row.participant_id);
    const entry = teams.get(row.participant_id);
    const difference = scored - conceded;
    return { row: { ...row, points, "details.overall_matches": played, "details.overall_wins": played - draws - losses,
      "details.overall_draws": draws, "details.overall_lost": losses,
      "details.overall_scored": scored, "details.overall_conceded": conceded, "details.overall_goal_difference": difference },
    points: entry?.points ?? points, difference: difference + (entry?.goalDifference ?? 0), scored: scored + (entry?.goalsFor ?? 0) };
  });
  sorted.sort((a, b) => b.points - a.points || b.difference - a.difference || b.scored - a.scored
    || teamName(a.row.participant_id, names).localeCompare(teamName(b.row.participant_id, names), LOCALE));
  return { order: sorted.map(({ row }) => row), teams };
}
