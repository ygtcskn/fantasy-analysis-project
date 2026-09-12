"use strict";

const builderRecommendations = { key: "", controller: null, timer: null, rows: [], message: "" };

function renderBuilderRecommendations(force = false) {
  const panel = $("builder-recommendations");
  const count = builderState.selected.size;
  panel.hidden = count === 0;
  document.querySelector(".builder-pool").classList.toggle("has-recommendations", count > 0);
  const generation = fantasyState.projections.values().next().value?.[0]?.pipeline_run_id || "";
  const selected = [...builderState.selected.values()].sort();
  const { players, teams } = builderData();
  const activeRole = builderSlots().find((slot) => slot.key === builderState.activeSlot && !builderState.selected.has(slot.key))?.role || "";
  let problem = "";
  if (count === 11) problem = "Your XI is complete. Remove a player to see recommendations.";
  else if (!generation || fantasyState.season !== state.seasonSlug) problem = "Refresh saved fantasy analysis to get recommendations.";
  else if (!players.some((player) => builderFantasyData(player).projection)) problem = "No current player projections. Refresh the fantasy analysis.";
  else if ([...builderState.selected].some(([key, id]) => {
    const player = players.find((p) => p.id === id), slot = builderSlots().find((s) => s.key === key);
    return !player || !slot || !canUseBuilderSlot(player, slot);
  })) problem = "Move selected players into their TFF fantasy positions to get recommendations.";
  const risk = $("builder-risk").value;
  const position = { GK: "KL", DEF: "DEF", MID: "OS", FWD: "FOR" }[activeRole] || "";
  const key = [count ? selected.join(",") : "", $("builder-formation").value, risk, position, generation, state.seasonSlug, problem].join("|");
  if (force || key !== builderRecommendations.key) {
    builderRecommendations.key = key;
    builderRecommendations.controller?.abort();
    builderRecommendations.controller = null;
    clearTimeout(builderRecommendations.timer);
    builderRecommendations.rows = [];
    builderRecommendations.message = problem;
    if (count && !problem) {
      builderRecommendations.message = "Optimizing your remaining XI…";
      builderRecommendations.timer = setTimeout(() => requestBuilderRecommendations(key, selected, generation, risk, position), 300);
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
      name.append(element("span", "builder-recommendation-role", `${side === "defensive" ? "Defence" : "Attack"}: ${fantasyFixtureDifficulty(projection, side)}`));
    }
    const rating = number(row.rating);
    if (rating) name.append(element("span", "builder-recommendation-role", `Rating ${ratingText(rating)}`));
    const cost = number(row.points_below_optimal_xi);
    if (cost !== null) {
      const label = cost < 0.005 ? "Best available" : `Costs ${displayNumber(cost)} vs best XI`;
      name.append(element("span", `builder-recommendation-role${cost < 0.005 ? " builder-recommendation-best" : ""}`, label));
    }
    const action = element("td"), add = element("button", "builder-player-add", "+");
    add.type = "button";
    add.setAttribute("aria-label", `Add recommended player ${row.player_name}`);
    add.addEventListener("click", () => {
      // Never replace a locked player when adding a recommended next pick.
      const currentSlot = builderSlots().find((slot) => slot.key === builderState.activeSlot && !builderState.selected.has(slot.key) && canUseBuilderSlot(player, slot));
      const target = currentSlot || builderSlots().find((slot) => !builderState.selected.has(slot.key) && canUseBuilderSlot(player, slot));
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
      ? ` Ranked by the XI each ${activeRole} completes, not by their own points.`
      : " Select an empty position to compare every candidate for it.");
}

async function requestBuilderRecommendations(key, selected, generation, risk, position) {
  const controller = new AbortController();
  builderRecommendations.controller = controller;
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const params = new URLSearchParams({ locked: selected.join(","), formation: $("builder-formation").value, generation, risk, position });
    const response = await fetch(`/local-recommendations.csv?${params}`, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error("Restart the local website server to enable recommendations.");
    const parsed = parseCSV(await response.text());
    if (!parsed.header.includes("status") || !parsed.records.length) throw new Error("Recommendation response unavailable.");
    if (key !== builderRecommendations.key || builderRecommendations.controller !== controller) return;
    const first = parsed.records[0];
    if (first.status !== "complete") throw new Error(first.message || "No legal XI found.");
    if (first.pipeline_run_id !== generation) throw new Error("Analysis changed. Refresh saved data.");
    builderRecommendations.rows = parsed.records;
    const spread = number(first.xi_standard_deviation);
    const pairs = number(first.same_club_defensive_pairs);
    // Expected points are unchanged by correlation; only the spread moves,
    // so both numbers are shown rather than one implying the other.
    builderRecommendations.message = `₺${displayNumber(number(first.remaining_budget))}M left · Optimized XI: ${displayNumber(number(first.xi_expected_points))} expected points`
      + (spread === null ? "" : `, spread ±${displayNumber(spread)}`)
      + (pairs === null ? "" : ` from ${pairs} same-club defensive pair${pairs === 1 ? "" : "s"}`)
      + ". Picks fit together within ₺100M and 3 per club.";
  } catch (error) {
    if (key !== builderRecommendations.key || builderRecommendations.controller !== controller) return;
    builderRecommendations.rows = [];
    builderRecommendations.message = error.name === "AbortError" ? "Optimization timed out. Use ↻ to retry." : error.message;
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
