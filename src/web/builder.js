"use strict";

const builderState = { selected: new Map(), activeSlot: null };

function builderFormationRows() {
  const parts = $("builder-formation").value.split("-").map(Number);
  let defenderIndex = 0, midfielderIndex = 0, forwardIndex = 0;
  const rows = [];
  parts.forEach((count, index) => {
    const role = index === 0 ? "DEF" : index === parts.length - 1 ? "FWD" : "MID";
    const label = role === "DEF" ? "Defenders" : role === "FWD" ? "Forwards" : index === parts.length - 2 ? "Attacking midfield" : "Midfield";
    const slots = [];
    for (let item = 0; item < count; item++) {
      const roleIndex = role === "DEF" ? defenderIndex++ : role === "FWD" ? forwardIndex++ : midfielderIndex++;
      slots.push({ key: `${role}-${roleIndex}`, role });
    }
    rows.push({ label, slots });
  });
  rows.reverse();
  rows.push({ label: "Goalkeeper", slots: [{ key: "GK-0", role: "GK" }] });
  return rows;
}

function builderSlots() {
  return builderFormationRows().flatMap((row) => row.slots);
}

function builderData() {
  return buildTierPlayers();
}

function builderPlayer(id) {
  return builderData().players.find((player) => player.id === id);
}

function builderPlayerRoles(player) {
  const roles = new Set();
  for (const position of player.positions) {
    if (/goalkeeper/i.test(position)) roles.add("GK");
    if (/defender|back/i.test(position)) roles.add("DEF");
    if (/midfielder|midfield/i.test(position)) roles.add("MID");
    if (/attacker|forward|striker|winger/i.test(position)) roles.add("FWD");
  }
  return roles;
}

function canUseBuilderSlot(player, slot) {
  const roles = builderPlayerRoles(player);
  return !roles.size || roles.has(slot.role);
}

// Back-view club shirt for a filled slot. Falls back to a neutral kit when the
// player has no squad row, and prints nothing when the jersey number is missing.
function builderShirt(player) {
  const shirt = element("span", "builder-shirt");
  const teamId = player.squadTeam || [...player.teams][0] || null;
  shirt.innerHTML = shirtSVG(teamId, { size: 64, number: player.jersey, surname: player.name });
  return shirt;
}

function builderMessage(text, error = false) {
  $("builder-message").textContent = text;
  $("builder-message").classList.toggle("error", error);
}

function selectedSlotFor(playerId) {
  return [...builderState.selected].find(([, id]) => id === playerId)?.[0] || null;
}

function placeBuilderPlayer(playerId, targetKey = builderState.activeSlot) {
  const player = builderPlayer(playerId);
  if (!player) return;
  const slots = builderSlots();
  const sourceKey = selectedSlotFor(playerId);
  if (!targetKey) {
    if (sourceKey) {
      builderState.activeSlot = sourceKey;
      builderMessage(`${player.name} is already selected. Choose another compatible position to move or replace the player.`);
      renderSquadBuilder();
      return;
    }
    targetKey = slots.find((slot) => !builderState.selected.has(slot.key) && canUseBuilderSlot(player, slot))?.key;
    if (!targetKey) {
      const roles = [...builderPlayerRoles(player)].join("/") || "compatible";
      builderMessage(`There is no empty ${roles} position for ${player.name}. Select a filled position to replace its player.`, true);
      return;
    }
  }
  const target = slots.find((slot) => slot.key === targetKey);
  if (!target) return;
  if (!canUseBuilderSlot(player, target)) {
    builderMessage(`${player.name} cannot be placed there. Choose a ${target.role} player.`, true);
    return;
  }
  const displacedId = builderState.selected.get(targetKey);
  if (sourceKey && sourceKey !== targetKey && displacedId) {
    const displaced = builderPlayer(displacedId);
    const source = slots.find((slot) => slot.key === sourceKey);
    if (displaced && source && !canUseBuilderSlot(displaced, source)) {
      builderMessage(`${player.name} and ${displaced.name} cannot swap because their positions are incompatible.`, true);
      return;
    }
    builderState.selected.set(sourceKey, displacedId);
  } else if (sourceKey && sourceKey !== targetKey) {
    builderState.selected.delete(sourceKey);
  }
  builderState.selected.set(targetKey, playerId);
  builderState.activeSlot = null;
  builderMessage(displacedId && displacedId !== playerId ? `${player.name} replaced ${builderPlayer(displacedId)?.name || "the previous player"}.` : `${player.name} added to your XI.`);
  renderSquadBuilder();
  focusBuilderSlot(targetKey);
}

function removeBuilderPlayer(slotKey) {
  const player = builderPlayer(builderState.selected.get(slotKey));
  builderState.selected.delete(slotKey);
  if (builderState.activeSlot === slotKey) builderState.activeSlot = null;
  builderMessage(player ? `${player.name} removed from your XI.` : "Position cleared.");
  renderSquadBuilder();
  focusBuilderSlot(slotKey);
}

function focusBuilderSlot(slotKey) {
  requestAnimationFrame(() => document.querySelector(`.builder-position[data-slot="${slotKey}"] .builder-position-select`)?.focus({ preventScroll: true }));
}

function changeBuilderFormation() {
  const players = [...new Set(builderState.selected.values())].map(builderPlayer).filter(Boolean);
  const slots = builderSlots();
  const next = new Map();
  let removed = 0;
  for (const player of players) {
    const target = slots.find((slot) => !next.has(slot.key) && canUseBuilderSlot(player, slot));
    if (target) next.set(target.key, player.id);
    else removed++;
  }
  builderState.selected = next;
  builderState.activeSlot = null;
  builderMessage(removed ? `Formation changed to ${$("builder-formation").value}. ${removed} incompatible player${removed === 1 ? " was" : "s were"} returned to the list.` : `Formation changed to ${$("builder-formation").value}.`);
  renderSquadBuilder();
}

function builderDragStart(event, playerId) {
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", playerId);
}

function renderBuilderPitch(playersById) {
  const pitch = $("builder-slots");
  pitch.replaceChildren();
  for (const rowData of builderFormationRows()) {
    const row = element("div", "builder-line");
    row.append(element("span", "builder-line-label", rowData.label));
    const positions = element("div", "builder-line-slots");
    for (const slot of rowData.slots) {
      const player = playersById.get(builderState.selected.get(slot.key));
      const position = element("div", `builder-position${builderState.activeSlot === slot.key ? " active" : ""}${player ? " filled" : ""}`);
      position.dataset.slot = slot.key;
      position.addEventListener("dragover", (event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; });
      position.addEventListener("drop", (event) => {
        event.preventDefault();
        const playerId = event.dataTransfer.getData("text/plain");
        if (playerId) placeBuilderPlayer(playerId, slot.key);
      });
      if (player) {
        position.draggable = true;
        position.addEventListener("dragstart", (event) => builderDragStart(event, player.id));
      }
      const select = element("button", "builder-position-select");
      select.type = "button";
      select.setAttribute("aria-pressed", String(builderState.activeSlot === slot.key));
      select.setAttribute("aria-label", player ? `${player.name}, ${slot.role}, average rating ${player.average === null ? "unavailable" : ratingText(player.average)}. Select this position.` : `Empty ${slot.role} position. Select it.`);
      if (player) {
        select.append(builderShirt(player), element("span", "builder-position-name", player.name), element("span", "builder-position-rating", ratingText(player.average)));
      } else {
        select.append(element("span", "builder-empty-plus", "+"), element("span", "builder-position-name", `Empty ${slot.role}`));
      }
      select.addEventListener("click", () => {
        builderState.activeSlot = builderState.activeSlot === slot.key ? null : slot.key;
        builderMessage(builderState.activeSlot ? `${slot.role} position selected. Choose or drag a compatible player from the list.` : "Position selection cleared.");
        renderSquadBuilder();
        focusBuilderSlot(slot.key);
      });
      position.append(select);
      if (player) {
        const remove = element("button", "builder-remove", "×");
        remove.type = "button";
        remove.setAttribute("aria-label", `Remove ${player.name}`);
        remove.addEventListener("click", () => removeBuilderPlayer(slot.key));
        position.append(remove);
      }
      positions.append(position);
    }
    row.append(positions); pitch.append(row);
  }
}

function renderBuilderPool(players, teams) {
  const teamIds = [...new Set(players.flatMap((player) => [...player.teams]))];
  options($("builder-team"), teamIds.map((id) => [id, teamName(id, teams)]).sort((a, b) => a[1].localeCompare(b[1])), "All clubs");
  const query = $("builder-search").value.trim().toLocaleLowerCase();
  const team = $("builder-team").value;
  const visible = players.filter((player) => (!team || player.teams.has(team)) && (!query || `${player.name} ${player.teamNames.join(" ")}`.toLocaleLowerCase().includes(query)))
    .sort((a, b) => (b.average ?? -Infinity) - (a.average ?? -Infinity) || b.ratings.length - a.ratings.length || a.name.localeCompare(b.name));
  $("builder-result-count").textContent = `${visible.length} players`;
  const body = document.createDocumentFragment();
  for (const player of visible) {
    const tr = element("tr", selectedSlotFor(player.id) ? "builder-player-selected" : "");
    tr.draggable = true;
    tr.addEventListener("dragstart", (event) => builderDragStart(event, player.id));
    const logoCell = element("td", "builder-club-cell");
    const logos = element("div", "club-logos");
    [...player.teams].forEach((id) => logos.append(createTeamLogo(id, teams)));
    if (!player.teams.size) logos.append(element("span", "", "—"));
    logoCell.append(logos);
    const nameCell = element("td");
    const add = element("button", "builder-player-button", player.name);
    add.type = "button";
    add.title = `${[...player.positions].join(" / ") || "Position not supplied"} · ${player.ratings.length} eligible ratings`;
    add.setAttribute("aria-label", `${selectedSlotFor(player.id) ? "Move" : "Add"} ${player.name}; ${[...player.positions].join(" or ") || "position not supplied"}`);
    add.addEventListener("click", () => placeBuilderPlayer(player.id));
    nameCell.append(add);
    const rating = element("td", "numeric builder-pool-rating", ratingText(player.average));
    rating.title = `${player.ratings.length} eligible match rating${player.ratings.length === 1 ? "" : "s"}`;
    rating.setAttribute("aria-label", player.average === null ? "Rating unavailable" : `Average rating ${ratingText(player.average)}`);
    tr.append(logoCell, nameCell, rating); body.append(tr);
  }
  if (!visible.length) {
    const tr = element("tr"), cell = element("td", "no-results", players.length ? "No players match these filters." : "Load player, squad, and match CSVs to see the player pool.");
    cell.colSpan = 3; tr.append(cell); body.append(tr);
  }
  $("builder-player-list").replaceChildren(body);
}

function renderSquadBuilder() {
  const { players, teams } = builderData();
  const playersById = new Map(players.map((player) => [player.id, player]));
  for (const [slot, playerId] of builderState.selected) if (!playersById.has(playerId) || !builderSlots().some((item) => item.key === slot)) builderState.selected.delete(slot);
  $("builder-count").textContent = `${builderState.selected.size} / 11 selected`;
  $("builder-formation-label").textContent = $("builder-formation").value;
  renderBuilderPitch(playersById);
  renderBuilderPool(players, teams);
}

function resetSquadBuilder() {
  builderState.selected.clear();
  builderState.activeSlot = null;
  $("builder-search").value = "";
  $("builder-team").value = "";
  $("builder-formation").value = "4-3-3";
  builderMessage("Select an empty pitch position, then choose a player. You can also drag players.");
}

function setupSquadBuilder() {
  $("builder-formation").addEventListener("change", changeBuilderFormation);
  $("builder-clear").addEventListener("click", () => { resetSquadBuilder(); renderSquadBuilder(); });
  $("builder-search").addEventListener("input", renderSquadBuilder);
  $("builder-team").addEventListener("change", renderSquadBuilder);
}
