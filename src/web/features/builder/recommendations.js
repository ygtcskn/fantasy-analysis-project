"use strict";

const builderRecommendations = { key: "", controller: null, timer: null, rows: [], message: "" };

function renderBuilderRecommendations(force = false) {
  const panel = $("builder-recommendations");
  const count = builderState.selected.size;
  panel.hidden = count === 0;
  document.querySelector(".builder-pool").classList.toggle("has-recommendations", count > 0);
  const generation = fantasyState.projections.values().next().value?.[0]?.pipeline_run_id || "";
  const selected = [...builderState.selected].filter(([key]) => !key.startsWith("BENCH-")).map(([, id]) => id).sort();
  const bench = [...builderState.selected].filter(([key]) => key.startsWith("BENCH-")).map(([, id]) => id).sort();
  const { players, teams } = builderData();
  const activeSlot = builderSlots().find((slot) => slot.key === builderState.activeSlot);
  const activeRole = !activeSlot?.bench && !builderState.selected.has(activeSlot?.key) ? activeSlot?.role || "" : "";
  let problem = "";
  if (activeSlot?.bench) problem = "Yedek oyuncuyu Oyuncular listesinden seçin. Yedeklerin fiyatı ilk 11 önerilerine ayrılan bütçeden düşülür.";
  else if (selected.length === 11) problem = "İlk 11 tamam. Yedekleri Oyuncular listesinden seçebilirsiniz.";
  else if (!generation || fantasyState.season !== state.seasonSlug) problem = "Öneriler için sayfayı yenileyin.";
  else if (!players.some((player) => builderFantasyData(player).projection)) problem = "Güncel oyuncu tahmini yok. Fantezi analizini yenileyin.";
  else if ([...builderState.selected].some(([key, id]) => {
    const player = players.find((p) => p.id === id), slot = builderSlots().find((s) => s.key === key);
    return !player || !slot || !canUseBuilderSlot(player, slot);
  })) problem = "Öneriler için seçilen oyuncuları TFF fantezi mevkilerine taşıyın.";
  const risk = $("builder-risk").value;
  const position = { GK: "KL", DEF: "DEF", MID: "OS", FWD: "FOR" }[activeRole] || "";
  const key = [selected.join(","), bench.join(","), $("builder-formation").value, risk, position, generation, state.seasonSlug, problem].join("|");
  if (force || key !== builderRecommendations.key) {
    builderRecommendations.key = key;
    builderRecommendations.controller?.abort();
    builderRecommendations.controller = null;
    clearTimeout(builderRecommendations.timer);
    builderRecommendations.rows = [];
    builderRecommendations.message = problem;
    if (count && !problem) {
      builderRecommendations.message = "Kadronun kalanı hesaplanıyor…";
      builderRecommendations.timer = setTimeout(() => requestBuilderRecommendations(key, selected, generation, risk, position, bench), 300);
    }
  }
  const body = document.createDocumentFragment();
  const roleMap = { KL: "GK", DEF: "DEF", OS: "MID", FOR: "FWD" };
  const rows = builderRecommendations.rows.filter((row) => row.player_id
    && (!activeRole || roleMap[row.position] === activeRole));
  for (const row of rows) {
    const player = players.find((p) => p.id === row.player_id);
    if (!player || selectedSlotFor(player.id)) continue;
    const tr = element("tr"), name = element("td"), club = element("div", "matchweek-club");
    club.append(createTeamLogo(row.team_id, teams, false), element("span", "", row.player_name));
    name.append(club, element("span", "builder-recommendation-role", row.position));
    const projection = builderFantasyData(player).projection;
    const side = ["KL", "DEF"].includes(row.position) ? "defensive" : "attacking";
    if (number(projection?.[`${side}_fixture_difficulty`]) !== null) {
      name.append(element("span", "builder-recommendation-role", `${side === "defensive" ? "Savunma" : "Hücum"}: ${fantasyFixtureDifficulty(projection, side)}`));
    }
    const rating = number(row.rating);
    if (rating) name.append(element("span", "builder-recommendation-role", `Maç puanı ${ratingText(rating)}`));
    const cost = number(row.points_below_optimal_xi);
    if (cost !== null) {
      const label = cost < 0.005 ? "En iyi seçenek" : `En iyi kadroya göre ${displayNumber(cost)} puan eksik`;
      name.append(element("span", `builder-recommendation-role${cost < 0.005 ? " builder-recommendation-best" : ""}`, label));
    }
    const action = element("td"), add = element("button", "builder-player-add", "+");
    add.type = "button";
    add.setAttribute("aria-label", `Önerilen oyuncuyu ekle: ${row.player_name}`);
    add.addEventListener("click", () => {
      // Never replace a locked player when adding a recommended next pick.
      const starterSlots = builderSlots().filter((slot) => !slot.bench);
      const currentSlot = starterSlots.find((slot) => slot.key === builderState.activeSlot && !builderState.selected.has(slot.key) && canUseBuilderSlot(player, slot));
      const target = currentSlot || starterSlots.find((slot) => !builderState.selected.has(slot.key) && canUseBuilderSlot(player, slot));
      if (target) placeBuilderPlayer(player.id, target.key);
    });
    action.append(add);
    tr.append(name, element("td", "numeric", `₺${displayNumber(number(row.price_million_try))}M`),
      element("td", "numeric", displayNumber(number(row.expected_points))), action);
    body.append(tr);
  }
  $("builder-recommendations-body").replaceChildren(body);
  $("builder-recommendations-note").textContent = builderRecommendations.message
    + (activeRole && builderRecommendations.rows.length
      ? ` Oyuncunun kendi puanına göre değil, tamamladığı kadronun gücüne göre sıralanır.`
      : " Bir mevkinin tüm adaylarını karşılaştırmak için boş bir mevki seçin.");
}

async function requestBuilderRecommendations(key, selected, generation, risk, position, bench = []) {
  const controller = new AbortController();
  builderRecommendations.controller = controller;
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const params = new URLSearchParams({ locked: selected.join(","), bench: bench.join(","), formation: $("builder-formation").value, generation, risk, position });
    const response = await fetch(`/local-recommendations.csv?${params}`, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error("Önerileri açmak için yerel site sunucusunu yeniden başlatın.");
    const parsed = parseCSV(await response.text());
    if (!parsed.header.includes("status") || !parsed.records.length) throw new Error("Öneri yanıtı alınamadı.");
    if (key !== builderRecommendations.key || builderRecommendations.controller !== controller) return;
    const first = parsed.records[0];
    if (first.status !== "complete") throw new Error(first.message || "Kurallara uygun kadro bulunamadı.");
    if (first.pipeline_run_id !== generation) throw new Error("Analiz değişti. Sayfayı yenileyin.");
    builderRecommendations.rows = parsed.records;
    const spread = number(first.xi_standard_deviation);
    const pairs = number(first.same_club_defensive_pairs);
    // Expected points are unchanged by correlation; only the spread moves,
    // so both numbers are shown rather than one implying the other.
    builderRecommendations.message = `₺${displayNumber(number(first.remaining_budget))}M left · Optimized XI: ${displayNumber(number(first.xi_expected_points))} expected points`
      + (spread === null ? "" : `, spread ±${displayNumber(spread)}`)
      + (pairs === null ? "" : ` from ${pairs} same-club defensive pair${pairs === 1 ? "" : "s"}`)
      + ". Seçili yedekler dahil ₺100M ve takım başına 3 oyuncu sınırı uygulanır. Boş yedek yerleri için bütçe ayrılmaz.";
  } catch (error) {
    if (key !== builderRecommendations.key || builderRecommendations.controller !== controller) return;
    builderRecommendations.rows = [];
    builderRecommendations.message = error.name === "AbortError" ? "Hesaplama zaman aşımına uğradı. Yeniden denemek için ↻ kullanın." : error.message;
  } finally {
    clearTimeout(timeout);
    if (key === builderRecommendations.key && builderRecommendations.controller === controller) renderBuilderRecommendations();
  }
}

function setupBuilderRecommendations() {
  $("builder-recommendations-retry").addEventListener("click", () => renderBuilderRecommendations(true));
  $("builder-risk").addEventListener("change", () => renderBuilderRecommendations());
  setInterval(() => { if (state.view === "builder" && builderState.selected.size) renderBuilderRecommendations(); }, 30000);
}
