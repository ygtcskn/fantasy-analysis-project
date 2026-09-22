"use strict";

// Synthetic observations only. Run explicitly with: node --test tests/test_team_analysis.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { TeamAnalysis: analysis } = require("../src/web/lib/team-analysis.js");

const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const names = new Map([["10", { name: "Alpha <FC>", short_code: "ALP" }], ["20", { name: "Beta", short_code: "BET" }],
  ["30", { name: "Gamma", short_code: "GAM" }], ["40", { name: "Delta", short_code: "DEL" }]]);
const fixture = (id, home, away, round, state = "FT", day = round) => ({ fixture_id: id, home_team_id: home, away_team_id: away,
  "round.name": String(round), "state.developer_name": state, starting_at_timestamp: String(1786000000 + day * 86400) });
const fixtures = [
  fixture("1", "10", "20", 1), fixture("2", "30", "40", 1),
  fixture("3", "20", "30", 2), fixture("4", "40", "10", 2, "INPLAY_2ND_HALF"),
  fixture("5", "10", "30", 3, "NS"), fixture("6", "20", "40", 3, "NS"), fixture("7", "10", "40", 4, "NS"), fixture("8", "30", "20", 4, "NS"),
];
const scores = new Map([["1:10", 2], ["1:20", 1], ["2:30", 0], ["2:40", 0], ["3:20", 1], ["3:30", 3], ["4:40", 1], ["4:10", 0]]);
const row = (fixtureId, team, xg, xga, shots, extra = {}) => ({ fixture_id: fixtureId, team_id: team, expected_goals: String(xg),
  expected_goals_against: String(xga), shots_total: String(shots), ...extra });
const teamRows = [row("1", "10", 1.5, 0.5, 12, { expected_points: "2.1", ball_possession: "60", dangerous_attacks: "50", passes: "500",
  tackles: "10", interceptions: "6", fouls: "4", big_chances_created: "3" }),
  row("1", "20", 0.5, 1.5, 6, { expected_points: "0.6", ball_possession: "40", dangerous_attacks: "30", passes: "300",
    tackles: "15", interceptions: "9", fouls: "12", big_chances_created: "" }), row("2", "30", 0.8, 0.8, 9), row("2", "40", 0.8, 0.8, 8),
  row("3", "20", 1.2, 2.4, 10), row("3", "30", 2.4, 1.2, 15), row("4", "40", 1.0, 0.2, 7), row("4", "10", 0.2, 1.0, 3)];
const played = analysis.matches({ fixtures, scores, teamRows });

test("only finished fixtures with a saved score count, from both sides", () => {
  assert.equal(played.length, 6);
  assert.ok(!played.some((match) => match.fixtureId === "4"), "an in-play fixture waits for the next download");
  const alpha = played.find((match) => match.fixtureId === "1" && match.teamId === "10");
  assert.deepEqual([alpha.result, alpha.goalsFor, alpha.goalsAgainst, alpha.home, alpha.xg, alpha.xga], ["W", 2, 1, true, 1.5, 0.5]);
  assert.equal(played.find((match) => match.fixtureId === "2").result, "D");
  assert.equal(played.find((match) => match.fixtureId === "3" && match.teamId === "20").result, "L");
  const missingScore = analysis.matches({ fixtures, scores: new Map([["1:10", 2]]), teamRows });
  assert.equal(missingScore.length, 0);
  const noStats = analysis.matches({ fixtures, scores });
  assert.equal(noStats[0].xg, null);
});

test("the headline says how far the season has got and what is still missing", () => {
  const when = analysis.asOf(fixtures, played);
  assert.deepEqual(when, { round: 2, finished: 1, scheduled: 2, matches: 3 });
});

test("goals fall into fifteen-minute blocks, stoppage time joining the half's last", () => {
  assert.deepEqual([1, 15, 16, 30, 31, 45, 46, 60, 61, 75, 76, 90, 95].map(analysis.bucketOf), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 5]);
  const events = [
    { fixture_id: "1", participant_id: "10", minute: "45", extra_minute: "3", "type.developer_name": "GOAL" },
    { fixture_id: "1", participant_id: "10", minute: "90", extra_minute: "4", "type.developer_name": "PENALTY" },
    // Sportmonks credits an own goal to the side that benefits.
    { fixture_id: "1", participant_id: "20", minute: "12", "type.developer_name": "OWNGOAL" },
    { fixture_id: "1", participant_id: "20", minute: "70", "type.developer_name": "GOAL", rescinded: "True" },
    { fixture_id: "1", participant_id: "20", minute: "80", "type.developer_name": "YELLOWCARD" },
    { fixture_id: "4", participant_id: "40", minute: "10", "type.developer_name": "GOAL" },
  ];
  const timing = analysis.goalTiming(events, played);
  assert.deepEqual(timing.get("10").scored, [0, 0, 1, 0, 0, 1]);
  assert.deepEqual(timing.get("10").conceded, [1, 0, 0, 0, 0, 0]);
  assert.deepEqual(timing.get("20").scored, [1, 0, 0, 0, 0, 0]);
  assert.equal(timing.has("40"), false, "goals in unfinished fixtures are not counted");
});

test("pressure minutes are put back on the match clock before they are averaged", () => {
  // A 52-minute first half: feed minute 50 is 45+5, feed minute 53 is the 46th.
  const pressure = [
    { fixture_id: "1", participant_id: "10", minute: "50", pressure: "60" }, { fixture_id: "1", participant_id: "20", minute: "50", pressure: "20" },
    { fixture_id: "1", participant_id: "10", minute: "53", pressure: "10" }, { fixture_id: "1", participant_id: "20", minute: "53", pressure: "30" },
    { fixture_id: "1", participant_id: "10", minute: "54", pressure: "5" },
  ];
  const balance = analysis.momentum(pressure, [{ fixture_id: "1", description: "1st-half", minutes: "52" }], played);
  assert.deepEqual(balance.get("10"), [null, null, 40, -20, null, null]);
  assert.deepEqual(balance.get("20"), [null, null, -40, 20, null, null]);
});

test("fantasy points are summed by the game's positions, negatives included", () => {
  const ledger = [
    { team_id: "10", fantasy_position: "KL", points_total: "6", fixture_id: "1" }, { team_id: "10", fantasy_position: "FOR", points_total: "9", fixture_id: "1" },
    { team_id: "10", fantasy_position: "DEF", points_total: "-2", fixture_id: "4" }, { team_id: "20", fantasy_position: "OS", points_total: "3", fixture_id: "1" },
    { team_id: "20", fantasy_position: "??", points_total: "50", fixture_id: "1" },
  ];
  const rows = analysis.fantasyByRole(ledger, names);
  assert.deepEqual(rows.map((entry) => [entry.teamId, entry.total, entry.KL, entry.DEF, entry.FOR, entry.matches]), [["10", 13, 6, -2, 9, 2], ["20", 3, 0, 0, 0, 1]]);
  const svg = analysis.fantasyChart(rows, names, "10");
  assert.match(svg, /^<svg /);
  assert.ok(svg.includes("Alpha &lt;FC&gt;") && !svg.includes("Alpha <FC>"));
});

test("luck points right when results beat the chances, at both ends", () => {
  const [alpha, beta, gamma] = analysis.luck(played, ["10", "20", "30"]);
  close(alpha.attack, 2 - 1.5);
  close(alpha.defence, 0.5 - 1);
  close(beta.attack, 2 - 1.7);
  close(beta.defence, 3.9 - 5);
  close(gamma.attack, 3 - 3.2);
  assert.equal(alpha.matches, 1);
});

test("comparison matches carry both sides' statistics, reading an omitted event as none", () => {
  const alpha = played.find((match) => match.fixtureId === "1" && match.teamId === "10");
  const beta = played.find((match) => match.fixtureId === "1" && match.teamId === "20");
  assert.deepEqual([alpha.points, alpha.xpts, alpha.possession, alpha.rivalPasses, alpha.shotsConceded], [3, 2.1, 60, 300, 6]);
  assert.equal(alpha.bigChances, 3);
  assert.equal(beta.bigChances, 0, "blank on a recorded match is none");
  assert.equal(alpha.bigChancesConceded, 0);
  assert.equal(played.find((match) => match.fixtureId === "2").bigChances, null, "no record at all stays unknown");
});

test("ten fixed comparisons, each reading a season figure per team", () => {
  assert.equal(analysis.comparisons.length, 10);
  assert.equal(new Set(analysis.comparisons.map((spec) => spec.id)).size, 10);
  for (const spec of analysis.comparisons) {
    assert.equal(spec.quadrants.length, 4, spec.id);
    assert.ok(spec.title && spec.xLabel && spec.yLabel && spec.note, spec.id);
  }
  const spec = (id) => analysis.comparisons.find((entry) => entry.id === id);
  const [alphaPoints] = analysis.comparisonRows(spec("points"), played, ["10"]);
  assert.deepEqual([alphaPoints.x, alphaPoints.y, alphaPoints.matches], [2.1, 3, 1]);
  // Pressing: opponent passes per tackle, interception and foul.
  const [alphaPress] = analysis.comparisonRows(spec("pressing"), played, ["10"]);
  close(alphaPress.y, 300 / 20);
  assert.equal(analysis.comparisonRows(spec("pressing"), played, ["30"]).length, 0, "a team without the figures is left off");
  const [betaShots] = analysis.comparisonRows(spec("shots-against"), played, ["20"]);
  close(betaShots.x, (12 + 15) / 2);
  close(betaShots.y, (1.5 + 2.4) / 27);
  const fantasy = analysis.withFantasy(played, [{ fixture_id: "1", team_id: "10", points_total: "20" }, { fixture_id: "1", team_id: "10", points_total: "5" }]);
  const [alphaFantasy] = analysis.comparisonRows(spec("fantasy"), fantasy, ["10", "20"]);
  assert.deepEqual([alphaFantasy.teamId, alphaFantasy.y], ["10", 25]);
});

test("gridlines fall on round values, labelled to the precision of the step", () => {
  assert.deepEqual(analysis.niceTicks(0, 4.48), { ticks: [0, 1, 2, 3, 4], digits: 0 });
  assert.deepEqual(analysis.niceTicks(0.043, 0.162), { ticks: [0.06, 0.08, 0.1, 0.12, 0.14, 0.16], digits: 2 });
  assert.deepEqual(analysis.niceTicks(28, 72), { ticks: [30, 40, 50, 60, 70], digits: 0 });
  assert.deepEqual(analysis.niceTicks(0, 13.4), { ticks: [0, 2.5, 5, 7.5, 10, 12.5], digits: 1 });
  assert.deepEqual(analysis.niceTicks(1.9, 12.6), { ticks: [2, 4, 6, 8, 10, 12], digits: 0 });
});

test("like-for-like pairs share one scale and a diagonal; pressing reads upward as more", () => {
  const spec = (id) => analysis.comparisons.find((entry) => entry.id === id);
  // Padding would take both axes below zero here; counts are floored at it.
  const rows = [{ teamId: "10", x: 0.2, y: 0, matches: 4 }, { teamId: "20", x: 3, y: 4, matches: 4 }];
  const diagonal = analysis.scatter(rows, spec("finishing"), names, "10");
  const xTicks = [...diagonal.matchAll(/text-anchor="middle" font-size="10" fill="var\(--muted\)">([^<]+)</g)].map((match) => match[1]);
  const yTicks = [...diagonal.matchAll(/text-anchor="end" font-size="10" fill="var\(--muted\)">([^<]+)</g)].map((match) => match[1]);
  assert.deepEqual(xTicks, yTicks);
  assert.equal(xTicks[0], "0", "counts never scale below zero");
  const pressing = analysis.scatter([{ teamId: "10", x: 50, y: 5, matches: 4 }, { teamId: "20", x: 40, y: 20, matches: 4 }], spec("pressing"), names);
  const cy = (team) => Number(pressing.match(new RegExp(`data-team="${team}" class="ta-link"><circle cx="[^"]+" cy="([^"]+)"`))[1]);
  assert.ok(cy("10") < cy("20"), "fewer opponent passes per action - more pressing - sits higher");
  assert.ok(!diagonal.includes("<FC>"));
  assert.equal(analysis.scatter([], spec("finishing"), names), "");
});

test("small multiples draw one clickable panel per team and one point per known match", () => {
  const grid = analysis.xgGrid(played, ["10", "20", "30", "40"], names, "20");
  assert.equal((grid.html.match(/class="ta-panel[ "]/g) || []).length, 4);
  assert.equal((grid.html.match(/data-ta-match=/g) || []).length, 6);
  assert.equal((grid.html.match(/ta-selected/g) || []).length, 1);
  assert.equal(grid.scale, 3);
  assert.ok(!grid.html.includes("<FC>"));
  for (const html of [analysis.formGrid(played, ["10"], names).html,
    analysis.timingGrid(analysis.goalTiming([], played), played, ["10"], names).html,
    analysis.momentumGrid(new Map(), ["10"], names).html]) assert.match(html, /data-team="10"/);
});

test("on the profile one panel is drawn for the open team alone, and not as a link to itself", () => {
  const plain = { interactive: false };
  const solo = analysis.xgGrid(played, ["10"], names, "10", plain);
  assert.equal((solo.html.match(/class="ta-panel[ "]/g) || []).length, 1);
  assert.ok(!solo.html.includes('role="button"') && !solo.html.includes("tabindex"));
  assert.match(solo.html, /ta-panel-static/);
  assert.match(solo.html, /data-team="10"/);
  // The league still sets the scale, so the open team reads against its peers.
  assert.equal(solo.scale, analysis.xgGrid(played, ["10", "20", "30", "40"], names, "10").scale);
  assert.equal(analysis.xgGrid(played, [], names, null, plain).html, "", "no team open draws nothing");
  for (const html of [analysis.formGrid(played, ["10"], names, "10", plain).html,
    analysis.timingGrid(analysis.goalTiming([], played), played, ["10"], names, "10", plain).html,
    analysis.momentumGrid(new Map(), ["10"], names, "10", plain).html]) {
    assert.equal((html.match(/class="ta-panel[ "]/g) || []).length, 1);
    assert.ok(!html.includes('role="button"'), html.slice(0, 120));
  }
});

test("the charts load with their feature and the website folder is served whole", () => {
  const html = fs.readFileSync(path.join(__dirname, "../src/web/index.html"), "utf8");
  const order = ["lib/team-analysis.js", "features/team-statistics/team-charts-page.js",
    "features/team-statistics/team-statistics.js"].map((file) => html.indexOf(`src="${file}"`));
  assert.ok(order.every((index) => index > 0) && order[0] < order[1] && order[1] < order[2], order.join());
  assert.match(html, /href="lib\/team-analysis\.css"/);
  for (const id of ["ta-xg-chart", "ta-fantasy-chart", "ta-luck-chart", "ta-form-chart", "ta-timing-chart", "ta-momentum-chart", "ta-compare-chart"]) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  // League-wide charts lead the page; match-by-match charts stay in the profile.
  const analysisStart = html.indexOf('id="team-analysis"');
  const listStart = html.indexOf('id="team-statistics-list-title"');
  const profileStart = html.indexOf('id="team-statistics-profile"');
  assert.ok(analysisStart < listStart && listStart < profileStart);
  const analysis = html.slice(analysisStart, listStart);
  const profile = html.slice(profileStart, html.indexOf('id="builder-workspace"'));
  for (const id of ["ta-xg-chart", "ta-form-chart", "ta-timing-chart", "ta-momentum-chart"]) {
    assert.ok(profile.includes(`id="${id}"`), id);
  }
  for (const id of ["ta-fantasy-chart", "ta-luck-chart", "ta-compare-chart"]) {
    assert.ok(!profile.includes(`id="${id}"`) && analysis.includes(`id="${id}"`), id);
  }
  assert.match(analysis, /id="team-analysis-tabs"[^>]*role="tablist"/);
  for (const id of ["team-statistics-scored-body", "team-statistics-conceded-body", "team-statistics-clean-body"]) {
    assert.ok(!html.includes(`id="${id}"`), id);
  }
  for (const id of ["ta-ticker-chart", "team-statistics-timeline-chart", "team-statistics-ratings-chart"]) {
    assert.ok(!html.includes(`id="${id}"`), id);
  }
  const serve = fs.readFileSync(path.join(__dirname, "../src/web/serve.py"), "utf8");
  for (const file of ["events.csv", "fixture_pressure.csv", "fixture_periods.csv"]) assert.match(serve, new RegExp(`OPTIONAL_CSV_NAMES = \\{[^}]*"${file.replace(".", "\\.")}"`), file);
  const css = fs.readFileSync(path.join(__dirname, "../src/web/lib/team-analysis.css"), "utf8");
  for (const variable of ["--ta-W", "--ta-D", "--ta-L", "--ta-kl", "--ta-def", "--ta-os", "--ta-for", "--ta-over", "--ta-under", "--ta-shade"]) {
    assert.equal((css.match(new RegExp(`${variable}:`, "g")) || []).length, 2, `${variable} needs a light and a dark value`);
  }
});
