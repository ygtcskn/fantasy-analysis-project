"use strict";

// Distribution profile for the player selected on İstatistikler: one row per
// metric of his Ayrıntılı Ölçütler wheel. The curve is how the comparison
// players are spread on that metric, the dashed line is where he sits, the
// coloured part covers the peers he outperforms, and the number on the right is
// his percentile. It reuses the wheel's
// reference and scores exactly - same peers, same minute bar, same mid-rank
// percentile and zero rule - so the two charts can never disagree.
//
// PlayerDistribution is pure (no DOM, no requests) so Node can test it;
// renderPlayerDistribution below puts it on the page.

const PlayerDistribution = (() => {
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const fixed = (value) => value.toFixed(1);
  const text = (value, digits = 2) => (value === null || !Number.isFinite(value) ? "—"
    : value.toLocaleString("tr-TR", { minimumFractionDigits: 0, maximumFractionDigits: digits }));
  const stops = [0, 25, 50, 75, 100];

  // Linear-interpolated quantile of an ascending list, p from 0 to 1.
  function quantile(sorted, p) {
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * p, low = Math.floor(position), high = Math.ceil(position);
    return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
  }
  // Silverman's rule with the robust spread, so a heap of zeros does not
  // shrink the curve to a spike; a flat list falls back to a tenth of its range.
  function bandwidth(values) {
    const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
    if (n < 2) return 0;
    const mean = sorted.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1));
    const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
    const spread = Math.min(sd, iqr > 0 ? iqr / 1.34 : sd);
    const h = 0.9 * (spread > 0 ? spread : sd) * n ** -0.2;
    return h > 0 ? h : (sorted[n - 1] - sorted[0]) / 10;
  }
  // Gaussian kernel density on an even grid over [low, high].
  function density(values, low, high, steps = 96) {
    const h = bandwidth(values) || (high - low) / 10 || 1;
    const grid = [];
    for (let index = 0; index <= steps; index += 1) {
      const x = low + ((high - low) * index) / steps;
      const y = values.reduce((sum, value) => sum + Math.exp(-0.5 * ((x - value) / h) ** 2), 0) / (values.length * h * Math.sqrt(2 * Math.PI));
      grid.push({ x, y });
    }
    return grid;
  }
  // Which of the five colour stops a percentile shows as.
  const bucket = (score) => stops.reduce((best, stop) => (Math.abs(stop - score) < Math.abs(best - score) ? stop : best), 0);

  // rows: { label, unit, values (the peers' figures), value (the player's),
  // score (his percentile, direction already applied), direction, detail,
  // compare? }. `compare` is a second player { value, score, detail } drawn
  // as his own marker on the same curve; the fill stays the first player's.
  // `colours` names the two markers' colours once a second player is drawn.
  function chart(rows, display = (score) => String(Math.round(score)), colours = null) {
    const width = 640, left = 150, plotRight = 516, rowHeight = 52, top = 8;
    const plot = plotRight - left, legendTop = top + rows.length * rowHeight + 14;
    const height = legendTop + 44;
    const parts = ["<defs>"];
    const body = [];
    rows.forEach((row, index) => {
      const y0 = top + index * rowHeight, base = y0 + 32;
      const values = row.values.filter(Number.isFinite);
      body.push(`<text x="${left - 10}" y="${base - 6}" text-anchor="end" font-size="11" font-weight="600" fill="var(--ink)">${escape(row.label)}</text>`);
      if (values.length < 2) {
        body.push(`<line x1="${left}" y1="${base}" x2="${plotRight}" y2="${base}" stroke="var(--line)"/>`);
        body.push(`<text x="${left + plot / 2}" y="${base - 8}" text-anchor="middle" font-size="10" fill="var(--muted)">Yeterli emsal verisi yok</text>`);
        return;
      }
      const own = Number.isFinite(row.value) ? row.value : null;
      const other = colours && Number.isFinite(row.compare?.value) ? row.compare.value : null;
      let low = Math.min(...values, own ?? Infinity, other ?? Infinity);
      let high = Math.max(...values, own ?? -Infinity, other ?? -Infinity);
      if (high === low) { low -= 0.5; high += 0.5; }
      const x = (value) => left + ((value - low) / (high - low)) * plot;
      const grid = density(values, low, high), peak = Math.max(...grid.map((point) => point.y)) || 1;
      const y = (value) => base - (value / peak) * 26;
      const area = `M${fixed(x(low))},${base} ` + grid.map((point) => `L${fixed(x(point.x))},${fixed(y(point.y))}`).join(" ") + ` L${fixed(x(high))},${base} Z`;
      // The fill is coloured by the percentile each position represents: the
      // stops sit at the peers' own quartiles, reversed where lower is better.
      const sorted = [...values].sort((a, b) => a - b);
      parts.push(`<linearGradient id="pd-grad-${index}" gradientUnits="userSpaceOnUse" x1="${fixed(x(low))}" y1="0" x2="${fixed(x(high))}" y2="0">`
        + stops.map((stop) => {
          const at = quantile(sorted, stop / 100), offset = Math.min(1, Math.max(0, (x(at) - x(low)) / (plot || 1)));
          const colour = row.direction === "lower_better" ? 100 - stop : stop;
          return `<stop offset="${offset.toFixed(4)}" style="stop-color: var(--dist-${colour})"/>`;
        }).join("") + "</linearGradient>");
      body.push(`<path d="${area}" fill="var(--muted)" fill-opacity="0.25"/>`);
      if (own !== null) {
        const reach = row.direction === "lower_better" ? [x(own), x(high)] : [x(low), x(own)];
        parts.push(`<clipPath id="pd-clip-${index}"><rect x="${fixed(reach[0])}" y="${y0}" width="${fixed(Math.max(0, reach[1] - reach[0]))}" height="${rowHeight}"/></clipPath>`);
        body.push(`<path d="${area}" fill="url(#pd-grad-${index})" clip-path="url(#pd-clip-${index})"/>`);
      }
      body.push(`<line x1="${left}" y1="${base}" x2="${plotRight}" y2="${base}" stroke="var(--line)"/>`);
      body.push(`<text x="${left}" y="${base + 17}" font-size="9" fill="var(--muted)">${text(low)}</text>`);
      body.push(`<text x="${plotRight}" y="${base + 17}" text-anchor="end" font-size="9" fill="var(--muted)">${text(high)}</text>`);
      // One marker and one value line per player. Alone, the marker is ink and
      // the value line sits mid-row; compared, each marker takes its player's
      // colour, the values stack primary first, and a short bar of that colour
      // starts each value line.
      const players = [{ value: own, score: row.score, detail: row.detail || row.label },
        ...(colours ? [{ value: other, score: row.compare?.score, detail: row.compare?.detail || row.label }] : [])];
      players.forEach((player, which) => {
        const detail = escape(player.detail);
        const textY = colours ? base - 13 + which * 14 : base - 6;
        if (player.value === null) {
          body.push(`<text x="${plotRight + 14}" y="${textY}" font-size="11" fill="var(--muted)"><title>${detail}</title>—</text>`);
          return;
        }
        const px = x(player.value), stroke = colours ? colours[which] : "var(--ink)";
        body.push(`<line data-dist-marker="${which}" x1="${fixed(px)}" y1="${y0 + 2}" x2="${fixed(px)}" y2="${base}" stroke="${stroke}" stroke-width="${colours ? 1.6 : 1.2}" stroke-dasharray="3 2"/>`);
        body.push(`<path d="M${fixed(px)},${base + 1} l-4,6 h8 Z" fill="${stroke}"/>`);
        const shown = Number.isFinite(player.score) ? display(player.score) : "—";
        body.push(`<g><title>${detail}</title><rect x="${left}" y="${y0}" width="${width - left}" height="${rowHeight - 4}" fill="transparent"/>`
          + (colours ? `<rect x="${plotRight + 6}" y="${textY - 8}" width="3" height="9" rx="1" fill="${stroke}"/>` : "")
          + `<text x="${plotRight + 14}" y="${textY}" font-size="11" fill="var(--ink)"><tspan font-weight="700">${text(player.value)}</tspan>`
          + `<tspan font-size="9" fill="var(--muted)">${escape(row.unit ? ` ${row.unit}` : "")}</tspan></text>`
          + (Number.isFinite(player.score) ? `<circle cx="${plotRight + 88}" cy="${textY - 4}" r="4" style="fill: var(--dist-${bucket(player.score)})"/>` : "")
          + `<text x="${plotRight + 96}" y="${textY}" font-size="11" font-weight="700" fill="var(--ink)">${escape(shown)}</text></g>`);
      });
    });
    parts.push(`<linearGradient id="pd-legend" x1="0" y1="0" x2="1" y2="0">${stops.map((stop) => `<stop offset="${stop / 100}" style="stop-color: var(--dist-${stop})"/>`).join("")}</linearGradient></defs>`);
    parts.push(...body);
    parts.push(`<text x="${left + plot / 2}" y="${legendTop}" text-anchor="middle" font-size="10" fill="var(--muted)">Yüzdelik renklendirme</text>`);
    parts.push(`<rect x="${left}" y="${legendTop + 6}" width="${plot}" height="10" rx="2" fill="url(#pd-legend)"/>`);
    stops.forEach((stop) => parts.push(`<text x="${fixed(left + (plot * stop) / 100)}" y="${legendTop + 30}" text-anchor="middle" font-size="9" fill="var(--muted)">${stop}</text>`));
    return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Ölçüt dağılımları ve oyuncunun yüzdeliği">${parts.join("")}</svg>`;
  }
  return { quantile, bandwidth, density, bucket, chart };
})();

// Page wiring: one row per axis of the Ayrıntılı Ölçütler wheel, from the
// reference renderStatisticsRadars just built. Depends on the page helpers
// ($, displayNumber) and on radar-page.js (statisticsUnit, statisticsReferenceLabel).
function renderPlayerDistribution(radar, selected) {
  if (!radar?.reference) {
    $("statistics-distribution-chart").replaceChildren();
    $("statistics-distribution-note").textContent = radar?.note || "Dağılım için radar verisi yok.";
    return;
  }
  const { player, reference, profile, results, guest } = radar;
  const detail = (who, metric, result, count) => `${who.name} · ${metric.label}: ${displayNumber(result.value)} ${statisticsUnit(metric)}`
    + (result.prior ? ` (gözlenen ${displayNumber(result.observedValue)}, kendi payı %${displayNumber(Math.round(result.reliability * 100))})` : "")
    + ` · yüzdelik ${Number.isFinite(result.score) ? RadarChart.display(result.score) : "—"} · ${count} emsal değeri`;
  const rows = profile.map((metric, index) => {
    const result = results[index], values = reference.metrics.get(metric.id) || [];
    const other = guest?.results[index];
    return { label: metric.label, unit: statisticsUnit(metric), values, value: Number.isFinite(result.value) ? result.value : null,
      score: result.score, direction: metric.direction, detail: detail(player, metric, result, values.length),
      compare: other ? { value: Number.isFinite(other.value) ? other.value : null, score: other.score,
        detail: detail(guest.player, metric, other, values.length) } : null };
  });
  $("statistics-distribution-chart").innerHTML = PlayerDistribution.chart(rows, RadarChart.display,
    guest ? STATISTICS_SERIES.map((series) => series.line) : null);
  $("statistics-distribution-note").textContent = `${selected?.name || player.name} · ${statisticsReferenceLabel(reference)}. `
    + "Her satırda eğri emsallerin o ölçütteki dağılımı, kesikli çizgi oyuncunun değeri, renkli bölüm geride bıraktığı emsaller, "
    + "sağdaki sayı yüzdeliği; Ayrıntılı Ölçütler radarıyla aynı emsaller ve aynı puan. Renk yüzdeliği gösterir: turuncu düşük, "
    + "nötr orta, lacivert yüksek. Düşük değerin iyi olduğu ölçütlerde (ör. yenilen gol) renkli bölüm oyuncunun değerinden yukarı uzanır. "
    + "Değerler ve eğriler az dakikalı oranlar emsal ortalamasına çekildikten sonraki değerlerdir; gözlenen değer satırın üzerinde bekleyince görünür. "
    + (guest ? `Mavi çizgi ${guest.player.name}; aynı emsallere göre sıralanır, renkli bölüm ${player.name} içindir. ` : "")
    + (radar.pool || "");
}

if (typeof module !== "undefined" && module.exports) module.exports = { PlayerDistribution };
