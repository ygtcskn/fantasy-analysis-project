"use strict";

// Synthetic observations only. Run explicitly with: node --test tests/test_distribution.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PlayerDistribution: distribution } = require("../src/web/features/statistics/distribution.js");

const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const peers = [0.1, 0.2, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.1, 1.5];

test("quantiles interpolate between neighbouring observations", () => {
  const sorted = [1, 2, 3, 4];
  close(distribution.quantile(sorted, 0), 1);
  close(distribution.quantile(sorted, 1), 4);
  close(distribution.quantile(sorted, 0.5), 2.5);
  close(distribution.quantile(sorted, 0.25), 1.75);
  assert.equal(distribution.quantile([], 0.5), null);
});

test("bandwidth is positive, robust to a heap of zeros, and never zero on a spread list", () => {
  assert.ok(distribution.bandwidth(peers) > 0);
  const zeros = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2];
  assert.ok(distribution.bandwidth(zeros) > 0, "an IQR of zero falls back to the standard deviation");
  assert.equal(distribution.bandwidth([3]), 0);
  assert.equal(distribution.bandwidth([2, 2, 2]), 0);
});

test("the density is a proper curve: it integrates to about one and peaks where the peers bunch", () => {
  const grid = distribution.density(peers, -2, 4, 600);
  const step = grid[1].x - grid[0].x;
  close(grid.reduce((sum, point) => sum + point.y, 0) * step, 1, 0.02);
  const peak = grid.reduce((best, point) => (point.y > best.y ? point : best));
  assert.ok(peak.x > 0 && peak.x < 0.8, `peak at ${peak.x}`);
  assert.equal(distribution.density(peers, 0, 1, 10).length, 11);
});

test("percentiles show as the nearest of five colour stops", () => {
  assert.deepEqual([0, 12, 13, 37, 38, 62, 63, 87, 88, 99].map(distribution.bucket), [0, 0, 25, 25, 50, 50, 75, 75, 100, 100]);
});

test("the coloured part covers the peers a player outperforms, in either direction", () => {
  const rows = [
    { label: "Gol <katkısı>", unit: "/90", values: peers, value: 0.6, score: 70, direction: "higher_better" },
    { label: "Az gol yeme", unit: "/90", values: peers, value: 0.3, score: 75, direction: "lower_better" },
    { label: "Eksik", unit: "/90", values: peers, value: null, score: null, direction: "higher_better" },
    { label: "Tek emsal", unit: "/90", values: [0.4], value: 0.4, score: 50, direction: "higher_better" },
  ];
  const svg = distribution.chart(rows, (score) => String(Math.round(score)));
  assert.match(svg, /^<svg /);
  assert.ok(svg.includes("Gol &lt;katkısı&gt;") && !svg.includes("Gol <katkısı>"));
  // Higher is better: from the left edge to the player.
  const clip = (index) => svg.match(new RegExp(`<clipPath id="pd-clip-${index}"><rect x="([^"]+)" y="[^"]+" width="([^"]+)"`)).slice(1).map(Number);
  const [x0, width0] = clip(0);
  assert.equal(x0, 150);
  assert.ok(width0 > 0);
  // Lower is better: from the player to the right edge, colours reversed.
  const [x1, width1] = clip(1);
  close(x1 + width1, 516, 0.11);
  assert.ok(x1 > 150);
  const colours = (index) => [...svg.match(new RegExp(`<linearGradient id="pd-grad-${index}"[^>]*>(.*?)</linearGradient>`))[1]
    .matchAll(/var\(--dist-(\d+)\)/g)].map((match) => Number(match[1]));
  assert.deepEqual(colours(0), [0, 25, 50, 75, 100]);
  assert.deepEqual(colours(1), [100, 75, 50, 25, 0]);
  // A missing value draws the peers but no marker or fill; one peer is not a distribution.
  assert.ok(!svg.includes('id="pd-clip-2"'));
  assert.ok(svg.includes("Yeterli emsal verisi yok"));
  assert.equal((svg.match(/l-4,6 h8 Z/g) || []).length, 2, "one marker per player value");
  assert.ok(svg.includes("fill: var(--dist-75)"), "the percentile swatch uses its colour stop");
});

test("a compared player gets his own marker and value line; the fill stays the first player's", () => {
  const rows = [
    { label: "Gol", unit: "/90", values: peers, value: 0.6, score: 70, direction: "higher_better",
      compare: { value: 1.4, score: 95 } },
    { label: "Şut", unit: "/90", values: peers, value: 0.3, score: 30, direction: "higher_better",
      compare: { value: null, score: null } },
  ];
  const svg = distribution.chart(rows, (score) => String(Math.round(score)), ["purple", "blue"]);
  assert.equal((svg.match(/data-dist-marker="0"/g) || []).length, 2);
  assert.equal((svg.match(/data-dist-marker="1"/g) || []).length, 1, "no marker for a missing second value");
  assert.ok(svg.includes('stroke="blue"') && svg.includes('stroke="purple"'));
  // The fill is clipped to the first player's value only.
  const [x0, width0] = svg.match(/<clipPath id="pd-clip-0"><rect x="([^"]+)" y="[^"]+" width="([^"]+)"/).slice(1).map(Number);
  const marker = Number(svg.match(/data-dist-marker="0" x1="([^"]+)"/)[1]);
  close(x0 + width0, marker, 0.11);
  // Without colours a compare entry is ignored and the chart is unchanged.
  const single = distribution.chart(rows, (score) => String(Math.round(score)));
  assert.ok(!single.includes('data-dist-marker="1"'));
});

test("metric labels are buttons that pick the ranked metric", () => {
  const rows = [
    { id: "goals", selected: true, label: "Gol", unit: "/90", values: peers, value: 0.6, score: 70, direction: "higher_better" },
    { id: "xg", selected: false, label: "xG", unit: "/90", values: peers, value: 0.3, score: 30, direction: "higher_better" },
    { label: "Etiket", unit: "/90", values: peers, value: 0.3, score: 30, direction: "higher_better" },
  ];
  const svg = distribution.chart(rows, (score) => String(Math.round(score)));
  assert.match(svg, /data-dist-metric="goals" class="dist-metric-label is-selected" role="button" tabindex="0" aria-pressed="true"/);
  assert.match(svg, /data-dist-metric="xg" class="dist-metric-label" role="button" tabindex="0" aria-pressed="false"/);
  assert.equal((svg.match(/data-dist-metric=/g) || []).length, 2, "a row without an id stays plain text");
  const html = fs.readFileSync(path.join(__dirname, "../src/web/index.html"), "utf8");
  for (const id of ["statistics-ranking", "statistics-ranking-body", "statistics-ranking-metric", "statistics-ranking-note",
    "statistics-ranking-group", "statistics-list-panel"]) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  // One section holds both halves, with a role button per comparison group.
  const section = html.slice(html.indexOf('id="statistics-ranking"'), html.indexOf('id="statistics-distribution-note"'));
  for (const role of ["ALL", "GK", "DEF", "MID", "FW"]) assert.ok(section.includes(`data-rank-role="${role}"`), role);
  assert.ok(section.includes('id="statistics-ranking-body"') && section.includes('id="statistics-distribution-chart"'));
});

test("the chart is loaded with its feature, before the statistics page that draws it", () => {
  const html = fs.readFileSync(path.join(__dirname, "../src/web/index.html"), "utf8");
  const order = ["features/statistics/distribution.js", "features/statistics/statistics.js"]
    .map((file) => html.indexOf(`src="${file}"`));
  assert.ok(order.every((index) => index > 0) && order[0] < order[1], order.join());
  assert.match(html, /href="features\/statistics\/distribution\.css"/);
  assert.ok(html.includes('id="statistics-distribution-chart"'));
  const css = fs.readFileSync(path.join(__dirname, "../src/web/features/statistics/distribution.css"), "utf8");
  for (const stop of [0, 25, 50, 75, 100]) {
    assert.equal((css.match(new RegExp(`--dist-${stop}:`, "g")) || []).length, 2, `--dist-${stop} needs a light and a dark value`);
  }
  const radarPage = fs.readFileSync(path.join(__dirname, "../src/web/features/statistics/radar-page.js"), "utf8");
  assert.match(radarPage, /return \{ player, reference, profile, results/, "the chart reuses the wheel's reference");
});
