// Offline browser-data regressions. Run with: node --test tests/test_matchweek_results.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

const fixture = (changes = {}) => ({ fixture_id: "100", league_id: "600", season_id: "2026",
  home_team_id: "1", away_team_id: "2", state: "NS", kickoff: "2026-09-13 17:00:00", ...changes });

function setup() {
  const saved = fixture(), scores = new Map();
  const state = { seasonSlug: "2026-2027", view: "matchweek", tables: {
    "fixtures.csv": [saved], "player_match_stats.csv": [],
  } };
  let renders = 0;
  const fantasyState = { season: "2026-2027", matches: new Map() };
  const context = vm.createContext({ state, fantasyState, currentFixtureScores: () => scores,
    renderMatchweek: () => renders++,
    number: (value) => value == null || String(value).trim() === "" || !Number.isFinite(Number(value)) ? null : Number(value),
    // tier-list.js supplies this on the site; without its player index it falls
    // back to the name the row was saved with, as the real one does.
    playerName: (id, fallback = "") => String(fallback || "").trim() || (id ? `Oyuncu ${id}` : "—"),
  });
  // The site's language script and shared match rules load first, as they do
  // in index.html. Outside a browser the language script leaves text as written.
  vm.runInContext(readFileSync(join(__dirname, "../src/web/core/language.js"), "utf8"), context);
  vm.runInContext(readFileSync(join(__dirname, "../src/web/core/match-rules.js"), "utf8"), context);
  vm.runInContext(readFileSync(join(__dirname, "../src/web/features/matchweek/results.js"), "utf8") + `
    globalThis.api = { matchweekFinished, resetMatchweekResults, ingestMatchweekResults,
      matchweekEffectiveFixture, matchweekFinalScore, matchweekResultPlayers, matchweekCompletedSnapshot, matchweekMatchFantasy };
  `, context);
  context.api.resetMatchweekResults();
  return { ...context.api, state, saved, scores, fantasyState, renders: () => renders };
}

test("only provider final states replace predictions", () => {
  const app = setup();
  for (const state of ["FT", "AET", "FT_PEN", "AWARDED", "WO", "5", "7", "8"]) assert.equal(app.matchweekFinished(fixture({ state })), true);
  for (const state of ["NS", "HT", "INPLAY_2ND_HALF", "INTERRUPTED", "POSTPONED", "ABANDONED", ""]) {
    assert.equal(app.matchweekFinished(fixture({ state })), false);
  }
});

test("confirmed finish updates the display without modifying the saved fixture", () => {
  const app = setup();
  const result = fixture({ record_type: "fixture", state: "FT", home_score: "2", away_score: "0" });
  app.ingestMatchweekResults([result]);
  assert.equal(app.matchweekEffectiveFixture(app.saved).state, "FT");
  assert.equal(app.saved.state, "NS");
  assert.equal(app.matchweekFinalScore(app.saved), "2 – 0");
  assert.equal(app.renders(), 1);
  app.ingestMatchweekResults([result]);
  assert.equal(app.renders(), 1);
});

test("wrong fixture, league, season or home-away orientation cannot replace a result", () => {
  for (const changes of [{ fixture_id: "999" }, { league_id: "1" }, { season_id: "2025" },
    { home_team_id: "2", away_team_id: "1" }]) {
    const app = setup();
    app.ingestMatchweekResults([fixture({ record_type: "fixture", state: "FT", ...changes })]);
    assert.equal(app.matchweekEffectiveFixture(app.saved).state, "NS");
    assert.equal(app.renders(), 0);
  }
});

test("zero remains a score while missing and invalid scores remain unknown", () => {
  const app = setup();
  app.scores.set("100:1", 0);
  assert.equal(app.matchweekFinalScore(app.saved), "0 – —");
  for (const value of [-1, 1.5, "invalid", null]) {
    app.scores.set("100:2", value);
    assert.equal(app.matchweekFinalScore(app.saved), "0 – —");
  }
});

test("finished lineup belongs to the selected fixture, never its previous game", () => {
  const app = setup();
  app.state.tables["player_match_stats.csv"] = [
    { fixture_id: "99", team_id: "1", player_id: "999", started: "1" },
  ];
  assert.equal(app.matchweekResultPlayers(app.saved).length, 0);
  app.ingestMatchweekResults([
    fixture({ record_type: "fixture", state: "FT" }),
    { record_type: "lineup", fixture_id: "100", team_id: "1", player_id: "123", player_name: "Starter", started: "1" },
  ]);
  const players = app.matchweekResultPlayers(app.saved);
  assert.equal(players.length, 1);
  assert.equal(players[0].player_id, "123");
  assert.equal(players[0].name, "Starter");
});

test("switching seasons clears the final-result overlay", () => {
  const app = setup();
  app.ingestMatchweekResults([fixture({ record_type: "fixture", state: "FT" })]);
  app.state.seasonSlug = "2025-2026";
  app.resetMatchweekResults();
  assert.equal(app.matchweekCompletedSnapshot(app.saved), null);
});

test("fantasy points use this match's ledger totals, including zero and negative scores", () => {
  const app = setup();
  for (const [id, total] of [["1", "0"], ["2", "-2"], ["3", "12"]]) {
    app.fantasyState.matches.set(id, [{ season: "2026-2027", fixture_id: "100", player_id: id, player_name: `P${id}`,
      team_id: "1", opponent_id: "2", fantasy_position: "OS", points_total: total, bonus: "3", minutes_played: "90" }]);
  }
  // Player 4 played but has no ledger row: he is left out, never given a
  // number from somewhere else such as his Sportmonks rating.
  app.fantasyState.matches.set("4", []);
  const [home, away] = app.matchweekMatchFantasy(app.saved);
  assert.equal(Array.from(home, (row) => row.id).join(","), "3,1,2");
  assert.equal(home[0].points, 12); // Bonus is already included; do not add it again.
  assert.equal(home[1].points, 0);
  assert.equal(home[2].points, -2);
  assert.equal(away.length, 0);
});

test("fantasy ledger rows from another match, team orientation or season are not shown", () => {
  for (const change of [{ fixture_id: "99" }, { team_id: "2" }, { opponent_id: "3" }]) {
    const app = setup();
    app.fantasyState.matches.set("1", [{ season: "2026-2027", fixture_id: "100", player_id: "1", team_id: "1",
      opponent_id: "2", points_total: "10", ...change }]);
    assert.equal(app.matchweekMatchFantasy(app.saved).flat().length, 0, JSON.stringify(change));
  }
  // The ledger loaded for another season is never read against this one.
  const app = setup();
  app.fantasyState.matches.set("1", [{ season: "2026-2027", fixture_id: "100", player_id: "1", team_id: "1",
    opponent_id: "2", points_total: "10" }]);
  app.fantasyState.season = "2025-2026";
  assert.equal(app.matchweekMatchFantasy(app.saved).map((side) => side.length).join(","), "0,0");
});
