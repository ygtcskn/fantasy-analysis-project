"use strict";

// Squad totals for the next match, summed from the published player projections.
// Only the starting XI scores, so the bench is reported on its own. A player
// without a current projection, or whose forecast is suppressed for an
// uncertain absence, is left out and the total is marked partial, never zero-filled.
const BUILDER_SUMMARY_METRICS = [
  ["expected_points", t("Beklenen FP")],
  ["expected_player_goals", t("Beklenen gol")],
  ["expected_player_assists", t("Beklenen asist")],
  ["expected_yellow_cards", t("Beklenen sarı kart")],
  ["expected_red_cards", t("Beklenen kırmızı kart")],
  ["expected_minutes", t("Beklenen dakika")],
];

function builderSummaryTotal(projections, field) {
  let total = 0, count = 0;
  for (const projection of projections) {
    // Older projection files predate the card columns; those stay unavailable.
    if (!projection || !(field in projection)) continue;
    const value = fantasyProjectionNumber(projection, field);
    if (value === null) continue;
    total += value;
    count++;
  }
  return { total: count ? total : null, count };
}

function builderSummaryMetric(label, value, detail = "") {
  const item = element("div", "builder-summary-metric");
  item.append(element("dt", "", label), element("dd", "", value));
  if (detail) item.append(element("dd", "builder-summary-detail", detail));
  return item;
}

function renderBuilderSummaryClubs(playersById, teams) {
  const counts = new Map();
  for (const id of builderState.selected.values()) {
    const club = builderPlayerClub(id);
    if (club) counts.set(club, (counts.get(club) || 0) + 1);
  }
  const list = $("builder-summary-clubs");
  const items = [...counts].sort((a, b) => b[1] - a[1] || teamName(a[0], teams).localeCompare(teamName(b[0], teams), LOCALE));
  list.replaceChildren(...items.map(([id, count]) => {
    const item = element("li", "builder-summary-club");
    item.style.setProperty("--club-color", teamColor(id));
    item.title = count >= 3 ? t("{team}: sınıra ulaşıldı", { team: teamName(id, teams) })
      : t("{team}: {count} oyuncu daha seçilebilir", { team: teamName(id, teams), count: 3 - count }, 3 - count);
    item.append(element("span", "builder-summary-club-name", teamName(id, teams)), createTeamLogo(id, teams, false),
      element("span", "builder-summary-club-count", `– ${count}`));
    return item;
  }));
  if (!items.length) list.append(element("li", "builder-summary-empty", t("Henüz oyuncu seçilmedi.")));
}

function renderBuilderSummary(playersById, teams) {
  const starters = [], bench = [];
  for (const [slot, id] of builderState.selected) {
    const player = playersById.get(id);
    if (player) (slot.startsWith("BENCH-") ? bench : starters).push(builderFantasyData(player).projection);
  }
  const covered = starters.filter(Boolean).length;
  $("builder-summary-coverage").textContent = starters.length ? t("{covered} / {count} oyuncu tahminli", { covered, count: starters.length }) : t("İlk 11 boş");

  const metrics = BUILDER_SUMMARY_METRICS.map(([field, label]) => {
    const { total, count } = builderSummaryTotal(starters, field);
    const partial = total !== null && count < starters.length;
    const value = total === null ? "—" : `${displayNumber(field === "expected_minutes" ? Math.round(total) : total.toFixed(2))}${partial ? "*" : ""}`;
    const detail = partial ? t("{count} / {total} oyuncu", { count, total: starters.length }) : field === "expected_minutes" && total !== null ? `/ ${starters.length * 90}` : "";
    return builderSummaryMetric(label, value, detail);
  });
  const benchPoints = builderSummaryTotal(bench, "expected_points");
  metrics.push(builderSummaryMetric(t("Yedekler · beklenen FP"), benchPoints.total === null ? "—" : `${displayNumber(benchPoints.total.toFixed(2))}${benchPoints.count < bench.length ? "*" : ""}`,
    bench.length ? t("{count} yedek", { count: bench.length }, bench.length) : t("Yedek yok")));
  $("builder-summary-metrics").replaceChildren(...metrics);

  const missing = starters.length - covered;
  // No current forecast for anyone usually means the published projections
  // belong to a round that has started; say so instead of leaving bare dashes.
  const expired = starters.length && !covered && fantasyState.generatedAt;
  $("builder-summary-note").classList.toggle("error", Boolean(expired));
  $("builder-summary-note").textContent = !starters.length
    ? t("İlk 11'e oyuncu ekledikçe toplamlar burada görünür. Yalnızca ilk 11 sayılır; yedekler ayrı gösterilir.")
    : expired
      ? t("Seçtiğin oyuncuların hiçbirinin güncel tahmini yok. Kaydedilen tahminler {date} tarihli; maçları başlamış ya da tur son tarihi geçmiş. Yeni Sportmonks verisini indirip fantezi pipeline'ını çalıştır, sonra sayfayı yenile.", { date: fantasyDate(fantasyState.generatedAt, true) })
      : (missing ? `${t("{count} oyuncunun güncel tahmini yok; * işaretli toplamlar eksiktir.", { count: missing }, missing)} ` : "")
        + t("Toplamlar sonraki maç tahminlerinin toplamıdır; oynaması belirsiz oyuncuların tahmini gösterilmez, oynamayacak oyuncular 0 sayılır. Kırmızı kart ikinci sarıyı da içerir.");
  renderBuilderSummaryClubs(playersById, teams);
}

function setupBuilderSummary() {
  // Forecasts expire at the round deadline even while the page stays open.
  setInterval(() => {
    if (state.view !== "builder" || !builderState.selected.size) return;
    const { players, teams } = builderData();
    renderBuilderSummary(new Map(players.map((player) => [player.id, player])), teams);
  }, 60000);
}
