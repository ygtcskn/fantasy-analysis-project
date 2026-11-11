"use strict";

const builderRecommendations = { key: "", controller: null, timer: null, rows: [], message: "" };

function renderBuilderRecommendations(force = false) {
  const panel = $("builder-recommendations");
  // The optimizer runs in src/web/serve.py; the published site has no server to ask.
  const count = siteMode === "local" ? builderState.selected.size : 0;
  panel.hidden = count === 0;
  document.querySelector(".builder-pool").classList.toggle("has-recommendations", count > 0);
  const generation = fantasyState.projections.values().next().value?.[0]?.pipeline_run_id || "";
  const selected = [...builderState.selected].filter(([key]) => !key.startsWith("BENCH-")).map(([, id]) => id).sort();
  const bench = [...builderState.selected].filter(([key]) => key.startsWith("BENCH-")).map(([, id]) => id).sort();
  const { players, teams } = builderData();
  const activeSlot = builderSlots().find((slot) => slot.key === builderState.activeSlot);
  const activeRole = !activeSlot?.bench && !builderState.selected.has(activeSlot?.key) ? activeSlot?.role || "" : "";
  let problem = "";
  if (activeSlot?.bench) problem = t("Yedek oyuncuyu Oyuncular listesinden seçin. Yedeklerin fiyatı ilk 11 önerilerine ayrılan bütçeden düşülür.");
  else if (selected.length === 11) problem = t("İlk 11 tamam. Yedekleri Oyuncular listesinden seçebilirsiniz.");
  else if (!generation || fantasyState.season !== state.seasonSlug) problem = t("Öneriler için sayfayı yenileyin.");
  else if (!players.some((player) => builderFantasyData(player).projection)) problem = t("Güncel oyuncu tahmini yok. Fantezi analizini yenileyin.");
  else if ([...builderState.selected].some(([key, id]) => {
    const player = players.find((p) => p.id === id), slot = builderSlots().find((s) => s.key === key);
    return !player || !slot || !canUseBuilderSlot(player, slot);
  })) problem = t("Öneriler için seçilen oyuncuları TFF fantezi mevkilerine taşıyın.");
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
      builderRecommendations.message = t("Kadronun kalanı hesaplanıyor…");
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
    club.append(createTeamLogo(row.team_id, teams, false), element("span", "", player.name));
    name.append(club, element("span", "builder-recommendation-role", fantasyPositionCode(row.position)));
    const projection = builderFantasyData(player).projection;
    const side = ["KL", "DEF"].includes(row.position) ? "defensive" : "attacking";
    if (number(projection?.[`${side}_fixture_difficulty`]) !== null) {
      name.append(element("span", "builder-recommendation-role", `${side === "defensive" ? t("Savunma") : t("Hücum")}: ${fantasyFixtureDifficulty(projection, side)}`));
    }
    // The season average the player list shows. The optimizer's own rating
    // column is a recency-weighted form figure it only uses to break ties.
    if (player.average !== null) name.append(element("span", "builder-recommendation-role", t("Reyting {rating}", { rating: ratingText(player.average) })));
    const cost = number(row.points_below_optimal_xi);
    if (cost !== null) {
      const label = cost < 0.005 ? t("En iyi seçenek") : t("En iyi kadroya göre {points} FP eksik", { points: displayNumber(cost) });
      name.append(element("span", `builder-recommendation-role${cost < 0.005 ? " builder-recommendation-best" : ""}`, label));
    }
    const action = element("td"), add = element("button", "builder-player-add", "+");
    add.type = "button";
    add.setAttribute("aria-label", t("Önerilen oyuncuyu ekle: {name}", { name: row.player_name }));
    add.addEventListener("click", () => {
      // Never replace a locked player when adding a recommended next pick.
      const starterSlots = builderSlots().filter((slot) => !slot.bench);
      const currentSlot = starterSlots.find((slot) => slot.key === builderState.activeSlot && !builderState.selected.has(slot.key) && canUseBuilderSlot(player, slot));
      const target = currentSlot || starterSlots.find((slot) => !builderState.selected.has(slot.key) && canUseBuilderSlot(player, slot));
      if (target) placeBuilderPlayer(player.id, target.key);
    });
    action.append(add);
    // SO% is TFF's selection rate; an older server or an unmatched player sends none.
    const ownership = number(row.so_percent);
    tr.append(name, element("td", "numeric", `₺${displayNumber(number(row.price_million_try))}M`),
      element("td", "numeric", percentText(ownership, Number.isInteger(ownership) ? 0 : 1)),
      element("td", "numeric", displayNumber(number(row.expected_points)?.toFixed(2))), action);
    body.append(tr);
  }
  $("builder-recommendations-body").replaceChildren(body);
  $("builder-recommendations-note").textContent = builderRecommendations.message
    || (activeRole && builderRecommendations.rows.length
      ? t("Oyuncunun kendi beklenen FP'sine göre değil, tamamladığı kadronun gücüne göre sıralanır.") : "");
}

async function requestBuilderRecommendations(key, selected, generation, risk, position, bench = []) {
  const controller = new AbortController();
  builderRecommendations.controller = controller;
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const params = new URLSearchParams({ locked: selected.join(","), bench: bench.join(","), formation: $("builder-formation").value, generation, risk, position });
    const response = await fetch(`/local-recommendations.csv?${params}`, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(t("Önerileri açmak için yerel site sunucusunu yeniden başlatın."));
    const parsed = parseCSV(await response.text());
    if (!parsed.header.includes("status") || !parsed.records.length) throw new Error(t("Öneri yanıtı alınamadı."));
    if (key !== builderRecommendations.key || builderRecommendations.controller !== controller) return;
    const first = parsed.records[0];
    if (first.status !== "complete") throw new Error(first.message || t("Kurallara uygun kadro bulunamadı."));
    if (first.pipeline_run_id !== generation) throw new Error(t("Analiz değişti. Sayfayı yenileyin."));
    builderRecommendations.rows = parsed.records;
    // A successful solve needs no note; only problems are explained.
    builderRecommendations.message = "";
  } catch (error) {
    if (key !== builderRecommendations.key || builderRecommendations.controller !== controller) return;
    builderRecommendations.rows = [];
    builderRecommendations.message = error.name === "AbortError" ? t("Hesaplama zaman aşımına uğradı. Yeniden denemek için ↻ kullanın.") : error.message;
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
