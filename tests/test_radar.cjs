"use strict";

// Synthetic observations only. Run explicitly with: node --test tests/test_radar.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const { RadarScoring: radar, RadarAttributes: attributes, RadarTeams: teams, RadarChart: chart } = require("../src/web/lib/radar.js");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const scope = { key: "1|600", seasonId: "1", competitionId: "600" };
const high = { direction: "higher_better", zeroHeavy: false };
const low = { direction: "lower_better", zeroHeavy: false };
// The page scripts, loaded in the order index.html loads them.
const pageSource = ["../src/web/lib/radar.js", "../src/web/features/statistics/radar-page.js",
  "../src/web/features/team-statistics/team-radar-page.js",
  "../src/web/features/statistics/statistics.js", "../src/web/features/team-statistics/team-statistics.js"]
  .map((file) => fs.readFileSync(path.join(__dirname, file), "utf8")).join("\n");
const player = (id, values, extra = {}) => ({ id, name: id, rows: [{ minutes_played: "900", ...values }],
  minutes: 900, position: "FW", scope, ...extra });
const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test("the spider scripts load before the statistics page and expose what it calls", () => {
  const context = {};
  assert.doesNotThrow(() => vm.runInNewContext(`${pageSource}\nglobalThis.bootstrap = {
    score: RadarScoring.score(2, [1, 2], { direction: "higher_better", zeroHeavy: false }).score,
    svg: RadarChart.svg(RadarScoring.axes("FW"), [], () => ""),
    render: typeof renderStatisticsRadars, page: typeof renderStatistics,
    teamRender: typeof renderTeamRadars, teamPage: typeof renderTeamStatistics
  };`, context));
  assert.equal(context.bootstrap.score, 75);
  assert.match(context.bootstrap.svg, /^<svg /);
  assert.equal(context.bootstrap.render, "function");
  assert.equal(context.bootstrap.page, "function");
  assert.equal(context.bootstrap.teamRender, "function");
  assert.equal(context.bootstrap.teamPage, "function");
  const html = fs.readFileSync(path.join(__dirname, "../src/web/index.html"), "utf8");
  const order = ["lib/radar.js", "features/statistics/radar-page.js",
    "features/team-statistics/team-radar-page.js", "features/statistics/statistics.js",
    "features/team-statistics/team-statistics.js"].map((file) => html.indexOf(`src="${file}"`));
  assert.ok(order.every((index) => index > 0), order.join());
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(html, /href="lib\/radar\.css"/);
  // The page has no settings: one scoring rule, one reference, no comparison.
  for (const id of ["statistics-radar-scope", "statistics-reference-pool", "statistics-minimum-minutes",
    "statistics-scale", "statistics-zero-method", "statistics-compare"]) assert.ok(!html.includes(id), id);
  const serve = fs.readFileSync(path.join(__dirname, "../src/web/serve.py"), "utf8");
  // The website folder is served whole, by suffix, so a page that gains a
  // script needs no new route and nothing without one of those suffixes -
  // serve.py itself, the notes beside the code - is reachable.
  assert.match(serve, /ASSET_TYPES = \{[^}]*"\.js":/);
  assert.match(serve, /ASSET_PATH = re\.compile/);
  assert.ok(!serve.includes("SPIDER_ASSETS") && !serve.includes("TEAM_ANALYSIS_ASSETS"));
  // Takım İstatistikleri reads team_metrics.csv on demand; older exports lack it.
  assert.match(serve, /OPTIONAL_CSV_NAMES = \{[^}]*"team_metrics\.csv"/);
  assert.match(serve, /HISTORY_NAMES = \{[^}]*"team_metrics\.csv"/);
  const sidebar = fs.readFileSync(path.join(__dirname, "../src/web/core/sidebar.js"), "utf8");
  assert.ok(sidebar.indexOf('"statistics", "▩", "İstatistikler"') < sidebar.indexOf('"team-statistics"'));
});

test("mid-rank percentiles share ties and keep a unique leader off 100", () => {
  close(radar.percentile(1, [1, 1, 2, 4]), 25);
  close(radar.percentile(2, [1, 1, 2, 4]), 62.5);
  close(radar.percentile(4, [1, 1, 2, 4]), 87.5);
  close(radar.percentile(4, [1, 4, 4]), 200 / 3);
  close(radar.percentile(1, [1, null, NaN, Infinity, 2]), 25);
  // The best of twenty is 97.5 and the last 2.5; a bigger group edges closer.
  const twenty = Array.from({ length: 20 }, (_, index) => index);
  close(radar.percentile(19, twenty), 97.5);
  close(radar.percentile(0, twenty), 2.5);
  close(radar.percentile(399, Array.from({ length: 400 }, (_, index) => index)), 99.875);
  // Outside the population: placed as one more observation, never added to it.
  close(radar.percentile(3, [1, 2, 4, 5]), 50);
  close(radar.percentile(99, twenty), 20.5 / 21 * 100);
  close(radar.percentile(-1, twenty), 0.5 / 21 * 100);
  // Members and outsiders interleave monotonically.
  const scores = [-1, 0, 0.5, 1, 1.5, 18.5, 19, 20].map((value) => radar.percentile(value, twenty));
  scores.forEach((score, index) => { if (index) assert.ok(score > scores[index - 1]); });
});

test("scores are bounded, monotonic and invert lower-is-better", () => {
  const values = [0, 0.1, 0.2, 0.2, 1, 50];
  const targets = [0, 0.05, 0.1, 0.2, 0.5, 1, 25, 50, 10000];
  const scores = targets.map((value) => radar.score(value, values, high).score);
  scores.forEach((value, index) => {
    assert.ok(Number.isFinite(value) && value > 0 && value < 100);
    if (index) assert.ok(value >= scores[index - 1]);
    close(radar.score(targets[index], values, low).score, 100 - value);
  });
});

test("nulls, blanks, nonfinite values and absent peers never become zero", () => {
  for (const value of [null, undefined, NaN, Infinity, -1]) assert.equal(radar.score(value, [0, 1], high).score, null);
  assert.equal(radar.score(0, [], high).score, null);
  assert.equal(radar.score(0, [0], high).score, null);
  for (const value of [null, undefined, "", " ", "Infinity", "oops", true]) assert.equal(radar.numeric(value), null);
  assert.equal(radar.numeric("0"), 0);
});

test("70% zero-heavy detection ranks positive contributions separately", () => {
  const values = [0, 0, 0, 0, 0, 0, 0, 1, 2, 4];
  const auto = { ...high, zeroHeavy: "auto" };
  assert.equal(radar.score(0, values, auto).score, 0);
  close(radar.score(1, values, auto).score, 100 / 6);
  close(radar.score(4, values, auto).score, 250 / 3);
  assert.equal(radar.score(1, values, auto).positiveN, 3);
  assert.equal(radar.score(1, values, auto).sampleSize, 10);
  assert.equal(radar.score(1, values, high).zeroApplied, false);
  assert.equal(radar.score(0, [0, 0, 1, 2], auto).zeroApplied, false);
  assert.equal(radar.score(0, [0, 1], { ...high, zeroHeavy: true }).score, 0);
});

test("zero-heavy negative events score zero occurrences at 100", () => {
  const values = [0, 0, 0, 0, 0, 0, 0, 1, 2, 5], negative = { ...low, zeroHeavy: "auto" };
  assert.equal(radar.score(0, values, negative).score, 100);
  assert.ok(radar.score(1, values, negative).score > radar.score(2, values, negative).score);
  close(radar.score(5, values, negative).score, 100 / 6);
});

test("all-zero distributions and a single contributor are handled explicitly", () => {
  const metric = { ...high, zeroHeavy: true };
  assert.equal(radar.score(0, [0, 0], metric).score, 0);
  assert.equal(radar.score(0, [0, 0], { ...metric, direction: "lower_better" }).score, 100);
  assert.equal(radar.score(1, [0, 0], metric).status, "no_positive_peers");
  // The only positive contributor sits in the middle of the positive group.
  assert.equal(radar.score(1, [0, 0, 1], metric).score, 50);
});

test("volume normalization preserves full precision and xG prefers one feed per match", () => {
  const target = player("1", {}, { minutes: 270, rows: [
    { minutes_played: "90", xg_expected_goals: "0.3", expected_goals: "0.9" },
    { minutes_played: "180", xg_expected_goals: "", expected_goals: "0.7" },
  ] });
  const observed = radar.observation(target, radar.metrics.xg);
  close(observed.rawValue, 1);
  close(observed.value, 1 / 3);
  assert.equal(radar.observation(player("2", { goals: 2 }, { minutes: 0 }), radar.metrics.goals).value, null);
});

test("partial match coverage is unavailable rather than an understated per-90", () => {
  const target = player("1", {}, { rows: [{ goals: "2" }, { goals: "" }] });
  const observed = radar.observation(target, radar.metrics.goals);
  assert.equal(observed.rawValue, 2);
  assert.equal(observed.supplied, 1);
  assert.equal(observed.records, 2);
  assert.equal(observed.value, null);
  assert.equal(observed.status, "partial_coverage");
  assert.equal(radar.observation(player("2", {}), radar.metrics.goals).rawValue, null);
  assert.equal(radar.observation(player("3", { goals: "0" }), radar.metrics.goals).value, 0);
  assert.equal(radar.observation(player("4", { goals: "-1" }), radar.metrics.goals).value, null);
});

test("percentage thresholds use attempt totals and never average match percentages", () => {
  const metric = radar.metrics.duel_pct;
  assert.equal(radar.observation(player("1", { duels_won: 1, total_duels: 1 }), metric).status, "insufficient_attempts");
  const target = player("2", {}, { rows: [{ duels_won: 1, total_duels: 10 }, { duels_won: 14, total_duels: 20 }] });
  assert.equal(radar.observation(target, metric).value, 50);
  assert.equal(radar.observation(target, metric).attempts, 30);
  assert.equal(radar.observation(player("3", { duels_won: 0, total_duels: 30 }), metric).value, 0);
  assert.equal(radar.observation(player("4", { total_duels: 30 }), metric).value, null);
  assert.equal(radar.observation(player("5", { duels_won: 31, total_duels: 30 }), metric).status, "invalid_ratio");
  assert.equal(radar.observation(player("6", { duels_won: 0, total_duels: 0 }), metric).value, null);
});

test("attempt thresholds scale with the reference's minute bar and never fall under twenty", () => {
  const metric = radar.metrics.pass_accuracy;
  assert.equal(radar.requiredAttempts(metric), 100);
  assert.equal(radar.requiredAttempts(metric, { minimumMinutes: 450 }), 50);
  assert.equal(radar.requiredAttempts(metric, { minimumMinutes: 180 }), 20);
  assert.equal(radar.requiredAttempts(metric, { minimumMinutes: 0 }), 20);
  assert.equal(radar.requiredAttempts(metric, { minimumMinutes: 1800 }), 100);
  assert.equal(radar.requiredAttempts(radar.metrics.duel_pct, { minimumMinutes: 180 }), 20);
  assert.equal(radar.requiredAttempts(radar.metrics.goals, { minimumMinutes: 180 }), 0);
  // A striker reaches 58 passes in four rounds, not 100; the same sample is
  // unavailable against a full season's bar and ranked against the season's own.
  const target = player("1", { accurate_passes: 50, passes: 58 });
  assert.equal(radar.observation(target, metric).status, "insufficient_attempts");
  const scaled = radar.observation(target, metric, { minimumMinutes: 180 });
  assert.equal(scaled.status, "available");
  assert.equal(scaled.required, 20);
  close(scaled.value, 5000 / 58);
});

test("percentage numerator and denominator require the same match coverage", () => {
  const target = player("1", {}, { rows: [{ accurate_passes: 50, passes: 100 }, { accurate_passes: 50, passes: "" }] });
  assert.equal(radar.observation(target, radar.metrics.pass_accuracy).status, "partial_coverage");
  target.rows = [{ accurate_passes: 30, passes: 20 }, { accurate_passes: 50, passes: 100 }];
  assert.equal(radar.observation(target, radar.metrics.pass_accuracy).status, "invalid_ratio");
});

test("reference uses the same role, season, competition and minute threshold", () => {
  const a = player("a", { goals: 1 });
  const b = player("b", { goals: 2 });
  const players = [a, b, player("short", { goals: 99 }, { minutes: 899 }),
    player("other-role", { goals: 99 }, { position: "GK" }),
    player("other-season", { goals: 99 }, { scope: { ...scope, key: "2|600" } }),
    player("other-league", { goals: 99 }, { scope: { ...scope, key: "1|700" } }),
    player("no-minutes", { goals: 99 }, { minutes: null })];
  const ref = radar.createReference(players, a, [radar.metrics.goals]);
  assert.equal(ref.peerCount, 2);
  assert.deepEqual(ref.metrics.get("goals"), [0.1, 0.2]);
  assert.equal(radar.evaluate(a, radar.metrics.goals, ref).score, 25);
  assert.equal(radar.evaluate(b, radar.metrics.goals, ref).score, 75);
  assert.equal(radar.evaluate(players[3], radar.metrics.goals, ref).status, "incompatible_group");
});

test("a compared player from another role is ranked on the primary's reference", () => {
  const a = player("a", { goals: 1 }), b = player("b", { goals: 2 });
  const defender = player("defender", { goals: 3 }, { position: "DEF" });
  const reference = radar.createReference([a, b, defender], a, [radar.metrics.goals]);
  assert.equal(reference.peerCount, 2, "the guest never joins the peers");
  assert.equal(radar.evaluate(defender, radar.metrics.goals, reference).status, "incompatible_group");
  const guest = radar.evaluate(defender, radar.metrics.goals, reference, { guest: true });
  assert.equal(guest.guest, true);
  close(guest.score, 250 / 3);
  // Another season or competition is still refused.
  const elsewhere = player("elsewhere", { goals: 3 }, { scope: { ...scope, key: "2|600" } });
  assert.equal(radar.evaluate(elsewhere, radar.metrics.goals, reference, { guest: true }).score, null);
  // Same role: guest changes nothing.
  assert.equal(radar.evaluate(b, radar.metrics.goals, reference, { guest: true }).guest, false);
});

test("a reference can pool several roles under one label", () => {
  const forward = player("fw", { goals: 3 }), midfielder = player("mid", { goals: 1 }, { position: "MID" });
  const keeper = player("gk", { goals: 0 }, { position: "GK" });
  const pooled = radar.createReference([forward, midfielder, keeper], { position: "ALL", scope },
    [radar.metrics.goals], { positions: ["MID", "FW"] });
  assert.deepEqual(pooled.peers.map((entry) => entry.id), ["fw", "mid"]);
  assert.equal(radar.positionLabels.ALL, "Tüm saha oyuncuları");
  // Members of any pooled role are in the group; others need the guest option.
  assert.equal(radar.evaluate(forward, radar.metrics.goals, pooled).guest, false);
  assert.equal(radar.evaluate(forward, radar.metrics.goals, pooled).score, 75);
  assert.equal(radar.evaluate(keeper, radar.metrics.goals, pooled).status, "incompatible_group");
  assert.equal(radar.evaluate(keeper, radar.metrics.goals, pooled, { guest: true }).guest, true);
});

test("short samples stay outside the reference but can be shown with a warning", () => {
  const a = player("a", { goals: 1 }), b = player("b", { goals: 2 });
  const short = player("short", { goals: 1 }, { minutes: 90 });
  const reference = radar.createReference([a, b, short], a, [radar.metrics.goals]);
  const result = radar.evaluate(short, radar.metrics.goals, reference);
  close(result.score, 250 / 3);
  assert.equal(result.smallSample, true);
  assert.equal(reference.peerCount, 2);
  assert.equal(radar.createReference([a, b], a, [radar.metrics.goals], { minimumMinutes: 1200 }).peerCount, 0);
});

test("a changed peer threshold recomputes scores; two players use one definition", () => {
  const a = player("a", { goals: 1 }), b = player("b", { goals: 1 });
  const c = player("c", { goals: 2 }, { minutes: 450 });
  const ref900 = radar.createReference([a, b, c], a, [radar.metrics.goals]);
  const ref450 = radar.createReference([a, b, c], a, [radar.metrics.goals], { minimumMinutes: 450 });
  assert.notEqual(radar.evaluate(a, radar.metrics.goals, ref900).score, radar.evaluate(a, radar.metrics.goals, ref450).score);
  assert.equal(radar.evaluate(a, radar.metrics.goals, ref450).score, radar.evaluate(b, radar.metrics.goals, ref450).score);
  assert.deepEqual(radar.evaluate(a, radar.metrics.goals, ref450).scope, radar.evaluate(b, radar.metrics.goals, ref450).scope);
});

test("metric-specific reference N excludes unavailable values and low attempts", () => {
  const a = player("a", { accurate_passes: 90, passes: 100 });
  const b = player("b", { accurate_passes: 100, passes: 100 });
  const reference = radar.createReference([a, b, player("blank", {}), player("short-attempts", { accurate_passes: 1, passes: 1 })], a, [radar.metrics.pass_accuracy]);
  const result = radar.evaluate(a, radar.metrics.pass_accuracy, reference);
  assert.equal(result.peerCount, 4);
  assert.equal(result.sampleSize, 2);
  assert.equal(result.score, 25);
});

test("fixture scoping precedes minutes, position and metric aggregation", () => {
  const fixtures = [
    { fixture_id: "1", season_id: "1", league_id: "600" },
    { fixture_id: "2", season_id: "2", league_id: "600" },
    { fixture_id: "3", season_id: "1", league_id: "700" },
    { fixture_id: "4", season_id: "1" },
  ];
  const original = { id: "a", name: "A", positions: new Set(["Attacker"]), matches: [
    { fixture_id: "1", position: "Attacker", minutes_played: 900, goals: 1 },
    { fixture_id: "2", position: "Defender", minutes_played: 2000, goals: 99 },
    { fixture_id: "3", position: "Defender", minutes_played: 2000, goals: 99 },
    { fixture_id: "4", position: "Defender", minutes_played: 2000, goals: 99 },
    { fixture_id: "unknown", position: "Defender", minutes_played: 2000, goals: 99 },
    { fixture_id: "1", position: "Attacker", minutes_played: 90, goals: 99, season_id: "2" },
  ] };
  const [prepared] = radar.preparePlayers([original], fixtures, scope);
  assert.equal(prepared.minutes, 900);
  assert.equal(prepared.position, "FW");
  assert.equal(radar.observation(prepared, radar.metrics.goals).rawValue, 1);
  assert.equal(radar.scopes(fixtures).length, 3);
  const [otherSeason] = radar.preparePlayers([original], fixtures, radar.scopes(fixtures)[1]);
  assert.equal(otherSeason.minutes, 2000);
  assert.equal(otherSeason.position, "DEF");
});

test("unplayed bench rows do not create false missing metrics; missing minutes exclude peers", () => {
  const fixtures = [{ fixture_id: "1", season_id: "1", league_id: "600" }];
  const source = { id: "a", name: "A", positions: new Set(["Attacker"]), matches: [
    { fixture_id: "1", minutes_played: 900, goals: 2 }, { fixture_id: "1", minutes_played: 0 },
  ] };
  const [prepared] = radar.preparePlayers([source], fixtures, scope);
  assert.equal(radar.observation(prepared, radar.metrics.goals).value, 0.2);
  // Sportmonks leaves minutes blank for an unused substitute, exactly as it
  // omits every other zero: not started, no statistics, no rating.
  source.matches[1] = { fixture_id: "1", minutes_played: "", started: "0", touches: "", rating: "" };
  const [benched] = radar.preparePlayers([source], fixtures, scope);
  assert.equal(benched.minutes, 900);
  assert.equal(radar.unplayed(source.matches[1]), true);
  // A blank-minute row that records play is an appearance of unknown length.
  for (const played of [{ touches: "12" }, { rating: "6.4" }, { started: "1" }]) {
    source.matches[1] = { fixture_id: "1", minutes_played: "", started: "0", ...played };
    const [uncertain] = radar.preparePlayers([source], fixtures, scope);
    assert.equal(uncertain.minutes, null);
    assert.equal(radar.createReference([uncertain], uncertain, [radar.metrics.goals]).peerCount, 0);
  }
  assert.equal(radar.unplayed({ minutes_played: "0" }), true);
  assert.equal(radar.unplayed({ minutes_played: "oops" }), false);
});

test("a lineup published before kickoff is not an appearance", () => {
  const fixtures = [{ fixture_id: "1", season_id: "1", league_id: "600", state: "FT" },
    { fixture_id: "2", season_id: "1", league_id: "600", state: "NS" }];
  const source = { id: "a", name: "A", positions: new Set(["Attacker"]), matches: [
    { fixture_id: "1", minutes_played: 900, goals: 2 },
    { fixture_id: "2", minutes_played: "", started: "1", rating: "" },
  ] };
  const [prepared] = radar.preparePlayers([source], fixtures, scope);
  assert.equal(prepared.rows.length, 1);
  assert.equal(prepared.minutes, 900);
  fixtures[1].state = "FT";
  assert.equal(radar.preparePlayers([source], fixtures, scope)[0].minutes, null);
});

test("earlier seasons are cut to the rounds the served season has reached", () => {
  const fixture = (id, round, state) => ({ fixture_id: id, season_id: "1", league_id: "600", "round.name": String(round), state });
  const served = [fixture("1", 1, "FT"), fixture("2", 2, "FT"), fixture("3", 3, "NS"), fixture("4", 2, "POSTPONED")];
  assert.equal(radar.playedRounds(served), 2);
  // A complete season, an unstarted one and unnumbered rounds are not cut.
  assert.equal(radar.playedRounds(served.map((item) => ({ ...item, state: "FT" }))), null);
  assert.equal(radar.playedRounds([fixture("1", 1, "NS")]), null);
  assert.equal(radar.playedRounds([fixture("1", "Final", "FT"), fixture("2", 2, "NS")]), null);
  const earlier = [fixture("a", 1, "FT"), fixture("b", 2, "FT"), fixture("c", 3, "FT"), fixture("d", "x", "FT")];
  assert.deepEqual(radar.throughRound(earlier, 2).map((item) => item.fixture_id), ["a", "b"]);
  assert.equal(radar.throughRound(earlier, null), earlier);
});

test("small samples are pulled toward the group by measured noise", () => {
  // Twenty peers: true rates differ (0.1 to 0.29 goals per 90), each seen over
  // ten steady matches, so most of the spread is real and the weight is small.
  const steady = [...Array(20)].map((_, index) => {
    const rows = [...Array(10)].map(() => ({ minutes_played: "90", touches: "40", goals: String(0.1 + index * 0.01) }));
    return { id: `s${index}`, name: `s${index}`, rows, minutes: 900, position: "FW", scope };
  });
  const reference = radar.createReference(steady, steady[0], [radar.metrics.goals]);
  const prior = reference.priors.get("goals");
  close(prior.mean * 90, 0.195);
  // No match-to-match noise at all: the weight is zero and nothing moves.
  close(prior.weight, 0);
  const top = radar.evaluate(steady[19], radar.metrics.goals, reference);
  close(top.value, top.observedValue);
  close(top.reliability, 1);
  // The same spread produced by luck - every peer scoring in one match of ten
  // and a different number of goals - is mostly noise, so the weight is large
  // and a short hot streak is pulled hard toward the mean.
  const lucky = [...Array(20)].map((_, index) => {
    const rows = [...Array(10)].map((__, match) => ({ minutes_played: "90", touches: "40", goals: match === 0 ? String(1 + (index % 3)) : "" }));
    return { id: `l${index}`, name: `l${index}`, rows, minutes: 900, position: "FW", scope };
  });
  const noisy = radar.createReference(lucky, lucky[0], [radar.metrics.goals]);
  assert.ok(noisy.priors.get("goals").weight > 900);
  const hot = { id: "hot", name: "hot", position: "FW", scope, minutes: 180,
    rows: [{ minutes_played: "90", touches: "40", goals: "2" }, { minutes_played: "90", touches: "40", goals: "1" }] };
  const result = radar.evaluate(hot, radar.metrics.goals, noisy);
  close(result.observedValue, 1.5);
  assert.ok(result.value < 0.5 && result.value > noisy.priors.get("goals").mean * 90);
  assert.ok(result.reliability < 0.2);
  // Below ten peers, or switched off, the observed value is ranked unchanged.
  assert.equal(radar.createReference(lucky.slice(0, 9), lucky[0], [radar.metrics.goals]).priors.get("goals"), null);
  const off = radar.createReference(lucky, lucky[0], [radar.metrics.goals], { shrinkage: false });
  close(radar.evaluate(hot, radar.metrics.goals, off).value, 1.5);
});

test("with a prior, a percentage needs one attempt instead of the scaled minimum", () => {
  // Twelve peers clear the 100-attempt minimum; a striker who made 9 of 10.
  const peers = [...Array(12)].map((_, index) => player(`p${index}`,
    { touches: "40", accurate_passes: String(140 + index * 5), passes: "200" }));
  const striker = player("striker", { touches: "40", accurate_passes: "9", passes: "10" });
  const reference = radar.createReference(peers, peers[0], [radar.metrics.pass_accuracy]);
  const result = radar.evaluate(striker, radar.metrics.pass_accuracy, reference);
  assert.equal(result.status, "available");
  assert.equal(result.required, 1);
  close(result.observedValue, 90);
  // Ten attempts barely move a group mean of about 83.75%.
  assert.ok(result.value < 90 && result.value > reference.priors.get("pass_accuracy").mean * 100);
  assert.ok(Number.isFinite(result.score));
  // The prior itself is fitted only on peers meeting the full minimum.
  assert.equal(reference.priors.get("pass_accuracy").peers, 12);
  // Without a prior the old minimum still applies, and no attempts stays blank.
  const off = radar.createReference(peers, peers[0], [radar.metrics.pass_accuracy], { shrinkage: false });
  assert.equal(radar.evaluate(striker, radar.metrics.pass_accuracy, off).status, "insufficient_attempts");
  const none = player("none", { touches: "40", accurate_passes: "", passes: "" });
  assert.equal(radar.evaluate(none, radar.metrics.pass_accuracy, reference).status, "no_attempts");
});

test("a faded second series is drawn underneath the first and recedes", () => {
  const axes = Object.values(radar.metrics).slice(0, 6);
  const results = axes.map(() => ({ score: 50, status: "available" }));
  const svg = chart.svg(axes, [{ name: "A", results, line: "red", fill: "pink" },
    { name: "B", results, line: "blue", fill: "lightblue", faded: true }], () => "");
  // The faded shape comes first in the document, so the primary paints over it.
  assert.ok(svg.indexOf('stroke="blue"') < svg.indexOf('stroke="red"'));
  assert.match(svg, /stroke="blue" stroke-width="2" stroke-opacity="0.65" data-radar-faded="true"/);
  assert.match(svg, /stroke="red" stroke-width="3"/);
  // Score labels keep the series order: primary first.
  assert.ok(svg.indexOf('<tspan fill="red">50</tspan>') < svg.indexOf('<tspan fill="blue">50</tspan>'));
});

test("a blank axis says why under its dash", () => {
  const axes = Object.values(radar.metrics).slice(0, 6);
  const results = axes.map((_, index) => (index === 2 ? { score: null, status: "no_attempts" } : { score: 50, status: "available" }));
  const svg = chart.svg(axes, [{ name: "A", results, line: "red", fill: "pink" }], () => "", "t",
    (result) => (result.status === "no_attempts" ? "deneme yok" : ""));
  assert.equal((svg.match(/data-radar-reason="2"/g) || []).length, 1);
  assert.ok(svg.includes(">deneme yok</text>"));
  // Without a reason callback the chart is unchanged.
  assert.ok(!chart.svg(axes, [{ name: "A", results, line: "red", fill: "pink" }], () => "").includes("data-radar-reason"));
});

test("match-level sums in a tally give the ratio estimator's variance", () => {
  const player = { rows: [{ minutes_played: "90", touches: "40", goals: "2" }, { minutes_played: "45", touches: "20", goals: "" }] };
  const counted = radar.tally(player, radar.metrics.goals);
  assert.deepEqual(counted.moments, { n: 2, sx: 2, sm: 135, sx2: 4, sxm: 180, sm2: 10125 });
  // rate 2/135 per minute; residuals 2 - 90r and -45r; two matches, n/(n-1) = 2.
  const rate = 2 / 135;
  close(radar.sampleVariance(counted.moments), ((2 - 90 * rate) ** 2 + (45 * rate) ** 2) / 135 ** 2 * 2);
  assert.equal(radar.sampleVariance({ ...counted.moments, n: 1 }), null);
});

test("position mapping preserves broad roles and leaves tied roles unresolved", () => {
  assert.equal(radar.groupFor("Defender"), "DEF");
  assert.equal(radar.groupFor("Centre-back"), "CB");
  assert.equal(radar.groupFor("999"), null);
  assert.equal(radar.positionFor([{ position: "Defender", minutes_played: 100 }, { position: "Midfielder", minutes_played: 100 }]), null);
  assert.equal(radar.positionFor([{ position: "Defender", minutes_played: 101 }, { position: "Midfielder", minutes_played: 100 }]), "DEF");
  assert.equal(radar.groupFor("Defender", { BACKS: ["defender"] }), "BACKS");
  assert.equal(radar.groupFor("Defender", { CB: ["defender"], FB: ["defender"] }), null);
});

test("fallback positions come from a scoped squad, not other competitions' appearances", () => {
  const source = { id: "a", name: "A", positions: new Set(["Defender"]), matches: [
    { fixture_id: "1", minutes_played: 900, goals: 1 },
    { fixture_id: "2", minutes_played: 2000, goals: 2, position: "Defender" },
  ] };
  const fixtures = [{ fixture_id: "1", season_id: "1", league_id: "600" },
    { fixture_id: "2", season_id: "2", league_id: "600" }];
  assert.equal(radar.preparePlayers([source], fixtures, scope)[0].position, null);
  source.squadPositions = ["Attacker"];
  assert.equal(radar.preparePlayers([source], fixtures, scope)[0].position, "FW");
});

test("every role's fixed metric wheel is unique, drawable and position-relevant", () => {
  for (const position of ["GK", "CB", "FB", "DM", "CM", "AM", "W", "FW", "DEF", "MID"]) {
    const axes = radar.axes(position);
    assert.ok(axes.length >= 5 && axes.length <= 18, `${position}: ${axes.length}`);
    assert.equal(new Set(axes.map((axis) => axis.id)).size, axes.length);
    for (const axis of axes) {
      assert.ok(axis.positions.includes(position));
      assert.ok(["higher_better", "lower_better", "context"].includes(axis.direction));
      assert.ok(Object.keys(radar.categories).includes(axis.category));
      if (axis.transform === "percentage") assert.ok(axis.minimumAttempts > 0 && axis.attemptsColumn);
      if (axis.sumColumns) assert.ok(axis.sumColumns.length > 1);
    }
  }
  assert.equal(radar.axes("GK").every((axis) => axis.positions.includes("GK")), true);
  assert.notDeepEqual(radar.axes("GK").map((axis) => axis.id), radar.axes("FW").map((axis) => axis.id));
});

test("an omitted counting column is a zero on a covered match and unknown otherwise", () => {
  // The provider writes no literal zeroes: every zero arrives as an empty cell.
  const covered = player("a", {}, { rows: [
    { minutes_played: "90", touches: "40", goals: "1" },
    { minutes_played: "90", touches: "35", goals: "" },
  ], minutes: 180 });
  const observed = radar.observation(covered, radar.metrics.goals);
  assert.equal(observed.status, "available");
  assert.equal(observed.supplied, 2);
  close(observed.value, 0.5);
  // A match the statistics feed did not cover at all stays unknown; reading it
  // as ninety minutes of nothing would understate every rate the player has.
  const uncovered = player("b", {}, { rows: [
    { minutes_played: "90", touches: "40", goals: "1" }, { minutes_played: "90", goals: "" },
  ], minutes: 180 });
  assert.equal(radar.observation(uncovered, radar.metrics.goals).status, "partial_coverage");
  assert.equal(radar.covered({ minutes_played: "90" }), false);
  assert.equal(radar.covered({ touches: "1" }), true);
  // An absent column is never an omission, and an invalid one is never a zero.
  assert.equal(radar.observation(player("c", { touches: "40" }), radar.metrics.goals).status, "partial_coverage");
  assert.equal(radar.observation(player("d", { touches: "40", goals: "-1" }), radar.metrics.goals).status, "partial_coverage");
});

test("combined axes need every part of the match and add them at match level", () => {
  const target = player("a", {}, { rows: [
    { minutes_played: "90", touches: "40", goals: "1", assists: "" },
    { minutes_played: "90", touches: "30", goals: "", assists: "2" },
  ], minutes: 180 });
  const observed = radar.observation(target, radar.metrics.goal_contribution);
  assert.equal(observed.rawValue, 3);
  close(observed.value, 1.5);
  const partial = player("b", {}, { rows: [{ minutes_played: "90", touches: "40", goals: "1" }], minutes: 90 });
  assert.equal(radar.observation(partial, radar.metrics.goal_contribution).status, "partial_coverage");
});

test("an omitted percentage denominator is only zero attempts when nothing was made", () => {
  // Sportmonks omits `aerials` on rows that still record aerials won, so a
  // blank denominator beside a positive numerator has to stay unknown.
  const both = player("a", { touches: "40", duels_won: "", total_duels: "" });
  assert.equal(radar.observation(both, radar.metrics.duel_pct).attempts, 0);
  assert.equal(radar.observation(both, radar.metrics.duel_pct).status, "no_attempts");
  const made = player("b", { touches: "40", duels_won: "3", total_duels: "" });
  assert.equal(radar.observation(made, radar.metrics.duel_pct).status, "partial_coverage");
  const full = player("c", { touches: "40", duels_won: "20", total_duels: "40" });
  assert.equal(radar.observation(full, radar.metrics.duel_pct).value, 50);
});

test("the first principal component is scale free and oriented so higher is better", () => {
  const perfect = attributes.principal([[-1, -1], [0, 0], [1, 1]]);
  close(perfect.vector[0], Math.SQRT1_2);
  close(perfect.vector[1], Math.SQRT1_2);
  close(perfect.explained, 1);
  // An opposing pair has no "positive" direction of its own; the component is
  // still deterministic rather than flipping between renders.
  const opposed = attributes.principal([[-1, 1], [0, 0], [1, -1]]);
  assert.ok(opposed.vector[0] > 0);
  close(Math.abs(opposed.vector[1]), Math.SQRT1_2);
  assert.equal(attributes.principal([[0, 0], [0, 0]]), null);
  const single = attributes.principal([[-1], [0], [1]]);
  close(single.vector[0], 1);
  close(single.explained, 1);
});

test("an attribute ranks the component, adjusts direction and needs full member coverage", () => {
  const attribute = { id: "test", label: "Test", transform: "pca", direction: "higher_better",
    category: "attribute", members: [radar.metrics.goals, radar.metrics.fouls] };
  // More goals with fewer fouls: after direction adjustment both members rise
  // together, so the component is the shared trend and the cleanest scorer tops it.
  const squad = [0, 1, 2, 3, 4, 5, 6].map((index) =>
    player(`p${index}`, { touches: "40", goals: String(index), fouls: String(6 - index), redcards: "" }));
  const reference = radar.createReference(squad, squad[0], []);
  assert.equal(reference.peers.length, 7);
  const model = attributes.fit(attribute, reference);
  assert.equal(model.status, "available");
  assert.equal(model.sampleSize, 7);
  assert.ok(model.loadings.every((loading) => loading.weight > 0));
  close(model.explained, 1);
  const scores = squad.map((target) => attributes.evaluate(target, model, reference).score);
  scores.forEach((score, index) => { if (index) assert.ok(score > scores[index - 1]); });
  close(scores[6], 650 / 7);
  // A member the whole group scores identically carries no information, and a
  // player missing any member is not projected onto a component he half fits.
  const flat = attributes.fit({ ...attribute, members: [radar.metrics.goals, radar.metrics.redcards] }, reference);
  assert.equal(flat.loadings.length, 1);
  assert.deepEqual(flat.dropped.map((entry) => [entry.metric.id, entry.reason]), [["redcards", "constant"]]);
  const incomplete = player("x", { touches: "40", goals: "3" });
  assert.equal(attributes.evaluate(incomplete, model, reference).status, "partial_coverage");
  assert.equal(attributes.evaluate(player("gk", { touches: "40", goals: "3", fouls: "0" },
    { position: "GK" }), model, reference).status, "incompatible_group");
  const thin = radar.createReference(squad.slice(0, 2), squad[0], []);
  assert.equal(attributes.fit(attribute, thin).status, "insufficient_peers");
});

test("attribute groups cover every role and draw only supported members", () => {
  for (const position of ["GK", "CB", "FB", "DM", "CM", "AM", "W", "FW", "DEF", "MID"]) {
    const groups = attributes.forPosition(position);
    assert.ok(groups.length >= 5 && groups.length <= 18, `${position}: ${groups.length}`);
    assert.equal(new Set(groups.map((group) => group.id)).size, groups.length);
    for (const group of groups) {
      assert.ok(group.members.length >= 1);
      assert.equal(group.transform, "pca");
      assert.equal(group.category, "attribute");
      for (const metric of group.members) assert.ok(metric.positions.includes(position));
    }
  }
  assert.notDeepEqual(attributes.forPosition("GK").map((group) => group.id),
    attributes.forPosition("FW").map((group) => group.id));
});

test("stored season tallies score exactly like the rows they came from", () => {
  const rows = [{ minutes_played: "90", touches: "40", goals: "1", assists: "", accurate_passes: "25", passes: "30" },
    { minutes_played: "90", touches: "35", goals: "", assists: "", accurate_passes: "30", passes: "40" }];
  const live = player("live", {}, { rows, minutes: 180 });
  const metrics = [radar.metrics.goals, radar.metrics.pass_accuracy, radar.metrics.goal_contribution];
  const stored = { ...live, rows: [], tallies: new Map(metrics.map((metric) => [metric.id, radar.tally(live, metric)])) };
  for (const metric of metrics) {
    for (const config of [undefined, { minimumMinutes: 180 }]) {
      const a = radar.observation(live, metric, config), b = radar.observation(stored, metric, config);
      assert.equal(b.status, a.status, metric.id);
      assert.equal(b.value, a.value, metric.id);
      assert.equal(b.records, 2);
    }
  }
  // The attempt threshold still follows the live minute bar.
  assert.equal(radar.observation(stored, radar.metrics.pass_accuracy).status, "insufficient_attempts");
  assert.equal(radar.observation(stored, radar.metrics.pass_accuracy, { minimumMinutes: 180 }).status, "available");
});

test("earlier seasons join the reference only for the same role, competition and bar", () => {
  const earlier = { ...scope, key: "0|600", seasonId: "0" };
  const history = (id, goals, extra = {}) => ({ ...player(id, { goals }), season: "2025-2026", scope: earlier, ...extra });
  const a = player("a", { goals: 1 }), b = player("b", { goals: 2 });
  const pool = [history("h1", 3), history("h2", 4), history("gk", 9, { position: "GK" }),
    history("short", 9, { minutes: 100 }), history("cup", 9, { scope: { ...earlier, key: "0|700", competitionId: "700" } }),
    history("same-season", 9, { scope })];
  const ref = radar.createReference([a, b], a, [radar.metrics.goals], {}, pool);
  assert.equal(ref.seasonPeers, 2);
  assert.equal(ref.historyPeers, 2);
  assert.equal(ref.peerCount, 4);
  assert.deepEqual(ref.historySeasons, ["2025-2026"]);
  assert.deepEqual(ref.metrics.get("goals").map((value) => +value.toFixed(3)), [0.1, 0.2, 0.3, 0.4]);
  // The target is still measured on its own season; only the scale widened.
  assert.equal(radar.evaluate(b, radar.metrics.goals, ref).value, 0.2);
  assert.equal(radar.evaluate(b, radar.metrics.goals, ref).score, 37.5);
  assert.equal(radar.createReference([a, b], a, [radar.metrics.goals]).historyPeers, 0);
});

test("a feed an earlier season did not supply is unknown there, not zero", () => {
  const context = {};
  vm.runInNewContext(`${pageSource}
    const row = (extra) => ({ minutes_played: "90", passes: "30", ...extra });
    const served = [...Array(200)].map((_, index) => row({ touches: "40", tackles: index % 2 ? "1" : "" }));
    const reference = statisticsFillRates(served, ["touches", "tackles"]);
    // Touches blank everywhere; tackles filled a little less often than now.
    const earlier = [...Array(2000)].map((_, index) => row({ touches: "", tackles: index % 20 < 9 ? "1" : "" }));
    globalThis.result = { missing: statisticsUnsupplied(statisticsFillRates(earlier, ["touches", "tackles"]), reference) };`, context);
  assert.deepEqual([...context.result.missing], ["touches"]);
});

test("a member missing from earlier seasons leaves the attribute instead of the peers", () => {
  const attribute = { id: "test", label: "Test", transform: "pca", direction: "higher_better",
    category: "attribute", members: [radar.metrics.goals, radar.metrics.shots, radar.metrics.chances] };
  const current = [0, 1, 2, 3].map((index) => player(`c${index}`,
    { touches: "40", goals: String(index), shots_total: String(index + 1), chances_created: String(index) }));
  // Earlier seasons never had the chances column at all.
  const earlier = [...Array(12)].map((_, index) => ({ ...player(`h${index}`,
    { touches: "40", goals: String(index % 5), shots_total: String(index % 5 + 1) }),
  season: "2025-2026", scope: { ...scope, key: "0|600", seasonId: "0" } }));
  const reference = radar.createReference(current, current[0], [], {}, earlier);
  const model = attributes.fit(attribute, reference);
  assert.equal(model.status, "available");
  assert.equal(model.sampleSize, 16);
  assert.deepEqual(model.dropped.map((entry) => [entry.metric.id, entry.reason]), [["chances", "coverage"]]);
  assert.deepEqual(model.loadings.map((loading) => loading.metric.id), ["goals", "shots"]);
  assert.equal(attributes.evaluate(current[3], model, reference).status, "available");
});

test("displayed scores show 0 and 100 only where a rule puts them", () => {
  assert.equal(chart.display(99.875), "99");
  assert.equal(chart.display(0.2), "1");
  assert.equal(chart.display(97.5), "98");
  assert.equal(chart.display(100), "100");
  assert.equal(chart.display(0), "0");
  assert.equal(chart.display(null), "—");
});

const teamRecords = (fixture, team, values) => Object.entries(values)
  .map(([name, value]) => ({ fixture_id: fixture, team_id: team, name, value }));

test("team rows are wide, blank where a statistic was omitted, and know what was conceded", () => {
  const rows = teams.rows([
    ...teamRecords("1", "10", { GOALS: "2", SHOTS_TOTAL: "12", PASSES: "400", FOULS: "11", REDCARDS: "1", EXPECTED_GOALS: "1.4" }),
    // No goals and no red card record: omitted, not unknown.
    ...teamRecords("1", "20", { SHOTS_TOTAL: "7", PASSES: "350", FOULS: "9", EXPECTED_GOALS: "0.6" }),
    // A fixture with only one side saved knows nothing about what was conceded.
    ...teamRecords("2", "10", { GOALS: "1", SHOTS_TOTAL: "9", PASSES: "410", FOULS: "10" }),
  ]);
  const find = (fixture, team) => rows.find((row) => row.fixture_id === fixture && row.team_id === team);
  const away = find("1", "20"), home = find("1", "10"), alone = find("2", "10");
  assert.equal(away.goals, "");
  assert.equal(away.redcards, "");
  assert.equal(home.goals_conceded, "");
  assert.equal(away.goals_conceded, "2");
  assert.equal(home.shots_conceded, "7");
  assert.equal(home.expected_goals_against, "0.6");
  assert.equal(away.opponent_id, "10");
  assert.ok(!("goals_conceded" in alone) && !("opponent_id" in alone));
  assert.equal(home.minutes_played, "90");
  // Read through the shared rules: an omitted goal is none, on a covered match.
  const team = { id: "20", rows: [away], minutes: 90, position: "TEAM", scope };
  assert.equal(radar.observation(team, teams.metrics.goals).value, 0);
  assert.equal(radar.observation(team, teams.metrics.redcards).value, 0);
  assert.equal(radar.observation({ ...team, id: "10", rows: [home] }, teams.metrics.conceded).value, 0);
});

test("team volume statistics never read a blank as zero; possession is averaged", () => {
  const rows = teams.rows([
    ...teamRecords("1", "10", { SHOTS_TOTAL: "12", PASSES: "400", FOULS: "11", KEY_PASSES: "9", BALL_POSSESSION: "60" }),
    ...teamRecords("2", "10", { SHOTS_TOTAL: "15", PASSES: "500", FOULS: "8", BALL_POSSESSION: "70" }),
    ...teamRecords("3", "30", { SHOTS_TOTAL: "5", PASSES: "300", FOULS: "8", KEY_PASSES: "4", BALL_POSSESSION: "40" }),
  ]);
  const team = { id: "10", rows: rows.filter((row) => row.team_id === "10"), minutes: 180, position: "TEAM", scope };
  // Fixture 2 has no key-pass value; a team cannot make none, so it is a gap.
  assert.equal(radar.observation(team, teams.metrics.key_passes).status, "partial_coverage");
  assert.equal(radar.observation(team, teams.metrics.possession).value, 65);
  assert.equal(radar.observation(team, teams.metrics.passes).value, 450);
  assert.equal(chart.svg(teams.axes(), [], () => "").includes(" /maç"), true);
});

test("the team catalogue draws one valid wheel and six attributes", () => {
  const axes = teams.axes();
  assert.ok(axes.length >= 5 && axes.length <= 18);
  assert.equal(new Set(axes.map((axis) => axis.id)).size, axes.length);
  for (const metric of Object.values(teams.metrics)) {
    assert.deepEqual(metric.positions, ["TEAM"]);
    assert.ok(Object.keys(radar.categories).includes(metric.category), metric.id);
    assert.ok(["higher_better", "lower_better", "context"].includes(metric.direction), metric.id);
  }
  const groups = teams.attributes();
  assert.deepEqual(groups.map((group) => group.id), ["attack", "creation", "ball", "defence", "duels", "discipline"]);
  for (const group of groups) assert.ok(group.members.length >= 1 && group.members.every((metric) => metric.positions.includes("TEAM")));
  assert.equal(radar.positionLabels.TEAM, "Takım");
  // Every column the catalogue reads is one the feed-availability rule checks.
  for (const metric of Object.values(teams.metrics)) assert.ok(teams.columns().includes(metric.sourceColumn), metric.id);
});

test("team-seasons group by scope and count ninety minutes a match", () => {
  const fixtures = [{ fixture_id: "1", season_id: "1", league_id: "600" }, { fixture_id: "2", season_id: "1", league_id: "600" },
    { fixture_id: "3", season_id: "2", league_id: "600" }];
  const rows = teams.rows([
    ...teamRecords("1", "10", { PASSES: "400" }), ...teamRecords("2", "10", { PASSES: "420" }), ...teamRecords("3", "10", { PASSES: "380" }),
  ]);
  const [team] = teams.entities(rows, fixtures, scope);
  assert.equal(team.rows.length, 2);
  assert.equal(team.minutes, 180);
  assert.equal(team.position, "TEAM");
  assert.equal(teams.entities(rows, fixtures, null).length, 0);
});

test("a team match the download caught in play is not a team-season match", () => {
  const fixtures = [{ fixture_id: "1", season_id: "1", league_id: "600", "state.developer_name": "FT" },
    { fixture_id: "2", season_id: "1", league_id: "600", "state.developer_name": "INPLAY_2ND_HALF" },
    { fixture_id: "3", season_id: "1", league_id: "600", state: "NS" }];
  const rows = teams.rows([
    ...teamRecords("1", "10", { PASSES: "400" }), ...teamRecords("2", "10", { PASSES: "210" }), ...teamRecords("3", "10", { PASSES: "5" }),
  ]);
  const [team] = teams.entities(rows, fixtures, scope);
  assert.deepEqual(team.rows.map((row) => row.fixture_id), ["1"]);
  assert.equal(team.minutes, 90);
});

test("radar settings reject nonsensical thresholds", () => {
  for (const options of [{ minimumMinutes: -1 }, { minimumMinutes: NaN }, { minimumPeers: 1 },
    { minimumPeers: 2.5 }, { zeroShareThreshold: 2 }, { zeroShareThreshold: -0.1 }]) {
    assert.throws(() => radar.settings(options));
  }
  // There is one scoring rule; nothing else is configurable.
  assert.deepEqual(Object.keys(radar.defaults).sort(), ["minimumMinutes", "minimumPeers", "zeroShareThreshold"]);
});

const chartAxes = radar.axes("FW").slice(0, 6);
const series = (scores) => [{ name: '<Player & "A">', results: scores.map((score) => ({ score })), line: "red", fill: "pink" }];
test("SVG missing axes have no point or fabricated filled polygon", () => {
  const svg = chart.svg(chartAxes, series([0, 25, null, 75, 100, 50]), (entry) => entry.name);
  assert.ok(!svg.includes('data-radar-series="complete"'));
  assert.ok(!svg.includes('data-radar-point="2"'));
  assert.equal((svg.match(/data-radar-point=/g) || []).length, 5);
  assert.equal((svg.match(/data-radar-series="partial"/g) || []).length, 4);
  assert.match(svg, /data-radar-point="0" cx="320" cy="320"/);
  assert.ok(svg.includes("&lt;Player &amp; &quot;A&quot;&gt;"));
  assert.ok(!svg.includes('<Player & "A">'));
});

test("SVG label blocks never collide and the view crops to what was drawn", () => {
  const scores = (axes) => [{ name: "A", line: "red", fill: "pink",
    results: axes.map(() => ({ score: 50 })) }, { name: "B", line: "blue", fill: "cyan",
    results: axes.map(() => ({ score: 70 })) }];
  const wide = radar.axes("FW"), keeper = attributes.forPosition("GK");
  const height = (svg) => Number(svg.match(/viewBox="0 [-\d.]+ 640 ([\d.]+)"/)[1]);
  const sixteen = chart.svg(wide, scores(wide), () => ""), five = chart.svg(keeper, scores(keeper), () => "");
  assert.ok(height(five) < height(sixteen));
  // Every block's first baseline, per axis: with two players on sixteen axes,
  // neighbours just off the vertical must have been pushed at least a block apart.
  const baselines = [...sixteen.matchAll(/<text x="([\d.]+)" y="([-\d.]+)" text-anchor="(\w+)" font-size="18"/g)]
    .map((match) => Number(match[2]));
  assert.equal(baselines.length, wide.length);
  const lines = wide.map((axis) => (axis.label.length > 14 ? 2 : 1));
  for (const [a, b] of [[6, 7], [9, 10], [14, 15]]) {
    const upper = Math.min(baselines[a], baselines[b]), first = baselines[a] < baselines[b] ? a : b;
    assert.ok(Math.max(baselines[a], baselines[b]) - upper >= lines[first] * 20 + 18, `${wide[a].id}/${wide[b].id}`);
  }
  // A trailing "%" stays with the word before it.
  assert.ok(!/<tspan[^>]*>%<\/tspan>/.test(sixteen));
});

test("SVG all-missing series has no plotted data; valid series has fixed 20-step rings", () => {
  const missing = chart.svg(chartAxes, series(Array(6).fill(null)), () => "unavailable");
  assert.ok(!missing.includes("data-radar-point="));
  assert.ok(!missing.includes("data-radar-series="));
  const svg = chart.svg(chartAxes, series([0, 20, 40, 60, 80, 100]), () => "observed");
  assert.equal((svg.match(/data-radar-series="complete"/g) || []).length, 1);
  for (const ring of [0, 20, 40, 60, 80, 100]) assert.ok(svg.includes(`>${ring}</text>`));
});
