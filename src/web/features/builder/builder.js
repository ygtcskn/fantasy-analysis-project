"use strict";

const builderState = { selected: new Map(), activeSlot: null, expandedPlayerId: null, role: "" };
// Slots keep internal role codes; the reader sees the fantasy game's own labels.
const BUILDER_ROLE_CODE = { GK: "KL", DEF: "DEF", MID: "OS", FWD: "FOR" };
const BUILDER_ROLE_NAME = { GK: "kaleci", DEF: "defans", MID: "orta saha", FWD: "forvet" };

function builderFormationRows() {
  const parts = $("builder-formation").value.split("-").map(Number);
  let defenderIndex = 0, midfielderIndex = 0, forwardIndex = 0;
  const rows = [];
  parts.forEach((count, index) => {
    const role = index === 0 ? "DEF" : index === parts.length - 1 ? "FWD" : "MID";
    const label = role === "DEF" ? "Defans" : role === "FWD" ? "Forvet" : index === parts.length - 2 ? "Ofansif orta saha" : "Orta saha";
    const slots = [];
    for (let item = 0; item < count; item++) {
      const roleIndex = role === "DEF" ? defenderIndex++ : role === "FWD" ? forwardIndex++ : midfielderIndex++;
      slots.push({ key: `${role}-${roleIndex}`, role });
    }
    rows.push({ label, slots });
  });
  rows.reverse();
  rows.push({ label: "Kaleci", slots: [{ key: "GK-0", role: "GK" }] });
  return rows;
}

function builderSlots() {
  return [...builderFormationRows().flatMap((row) => row.slots), ...builderBenchSlots()];
}

function builderBenchSlots() {
  return Array.from({ length: 4 }, (_, index) => ({ key: `BENCH-${index}`, role: "BENCH", bench: true, label: `Yedek ${index + 1}` }));
}

function builderPrice(playerId) {
  if (fantasyState.season !== state.seasonSlug) return null;
  const price = number(fantasyState.projections.get(playerId)?.[0]?.price_million_try);
  return price !== null && price > 0 ? Math.round(price * 1_000_000) : null;
}

function builderBudget(selection = builderState.selected) {
  let spent = 0, bench = 0, missing = 0;
  for (const [slot, id] of selection) {
    const price = builderPrice(id);
    if (price === null) missing++;
    else { spent += price; if (slot.startsWith("BENCH-")) bench += price; }
  }
  return { spent, bench, missing, remaining: 100_000_000 - spent };
}

function builderData() {
  return buildTierPlayers();
}

function builderPlayer(id) {
  return builderData().players.find((player) => player.id === id);
}

function builderPlayerRoles(player) {
  if (fantasyState.season && fantasyState.season === state.seasonSlug) {
    const position = fantasyState.projections.get(player.id)?.[0]?.position || fantasyState.summaries.get(player.id)?.fantasy_position;
    const role = { KL: "GK", DEF: "DEF", OS: "MID", FOR: "FWD" }[position];
    if (role) return new Set([role]);
  }
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
  if (slot.bench) return true;
  const roles = builderPlayerRoles(player);
  return !roles.size || roles.has(slot.role);
}

// Back-view club shirt for a filled slot. Falls back to a neutral kit when the
// player has no squad row, and prints nothing when the jersey number is missing.
function builderShirt(player, goalkeeper = false) {
  const shirt = element("span", "builder-shirt");
  const teamId = player.squadTeam || [...player.teams][0] || null;
  shirt.innerHTML = shirtSVG(teamId, { size: 64, number: player.jersey, surname: player.name, goalkeeper });
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
      builderMessage(`${player.name} zaten kadroda. Taşımak veya değiştirmek için uygun başka bir mevki seçin.`);
      renderSquadBuilder();
      return;
    }
    targetKey = slots.find((slot) => !builderState.selected.has(slot.key) && canUseBuilderSlot(player, slot))?.key;
    if (!targetKey) {
      const roles = [...builderPlayerRoles(player)].map((role) => BUILDER_ROLE_CODE[role]).join("/") || "uygun";
      builderMessage(`${player.name} için boş ${roles} mevkisi yok. Değiştirmek için dolu bir mevki seçin.`, true);
      return;
    }
  }
  const target = slots.find((slot) => slot.key === targetKey);
  if (!target) return;
  if (!canUseBuilderSlot(player, target)) {
    builderMessage(`${player.name} oraya yerleştirilemez. Bir ${BUILDER_ROLE_NAME[target.role]} oyuncusu seçin.`, true);
    return;
  }
  const displacedId = builderState.selected.get(targetKey);
  const next = new Map(builderState.selected);
  if (sourceKey && sourceKey !== targetKey && displacedId) {
    const displaced = builderPlayer(displacedId);
    const source = slots.find((slot) => slot.key === sourceKey);
    if (displaced && source && !canUseBuilderSlot(displaced, source)) {
      builderMessage(`${player.name} ile ${displaced.name} yer değiştiremez; mevkileri uyumsuz.`, true);
      return;
    }
    next.set(sourceKey, displacedId);
  } else if (sourceKey && sourceKey !== targetKey) {
    next.delete(sourceKey);
  }
  next.set(targetKey, playerId);
  const budget = builderBudget(next);
  if (budget.missing) {
    builderMessage("Kadrodaki her oyuncunun fiyatı bilinmeli. Fiyatı olmayan oyuncuyu çıkarın veya fantezi verisini yenileyin.", true);
    return;
  }
  if (budget.remaining < 0) {
    builderMessage("İlk 11 ve yedeklerin toplam fiyatı ₺100M bütçesini aşıyor.", true);
    return;
  }
  const clubs = new Map();
  for (const id of next.values()) {
    const club = fantasyState.projections.get(id)?.[0]?.team_id || builderPlayer(id)?.squadTeam;
    if (club) clubs.set(club, (clubs.get(club) || 0) + 1);
  }
  if ([...clubs.values()].some((count) => count > 3)) {
    builderMessage("İlk 11 ve yedekler dahil bir takımdan en fazla 3 oyuncu seçebilirsiniz.", true);
    return;
  }
  builderState.selected = next;
  builderState.activeSlot = null;
  builderMessage(displacedId && displacedId !== playerId ? `${player.name}, ${builderPlayer(displacedId)?.name || "önceki oyuncunun"} yerine girdi.` : `${player.name} kadroya eklendi.`);
  renderSquadBuilder();
  focusBuilderSlot(targetKey);
}

function removeBuilderPlayer(slotKey) {
  const player = builderPlayer(builderState.selected.get(slotKey));
  builderState.selected.delete(slotKey);
  if (builderState.activeSlot === slotKey) builderState.activeSlot = null;
  builderMessage(player ? `${player.name} kadrodan çıkarıldı.` : "Mevki boşaltıldı.");
  renderSquadBuilder();
  focusBuilderSlot(slotKey);
}

function focusBuilderSlot(slotKey) {
  requestAnimationFrame(() => document.querySelector(`.builder-position[data-slot="${slotKey}"] .builder-position-select`)?.focus({ preventScroll: true }));
}

function changeBuilderFormation() {
  const players = [...builderState.selected].filter(([key]) => !key.startsWith("BENCH-")).map(([, id]) => builderPlayer(id)).filter(Boolean);
  const slots = builderFormationRows().flatMap((row) => row.slots);
  const next = new Map([...builderState.selected].filter(([key]) => key.startsWith("BENCH-")));
  let removed = 0;
  for (const player of players) {
    const target = slots.find((slot) => !next.has(slot.key) && canUseBuilderSlot(player, slot));
    if (target) next.set(target.key, player.id);
    else removed++;
  }
  builderState.selected = next;
  builderState.activeSlot = null;
  builderMessage(removed ? `Diziliş ${$("builder-formation").value} oldu. Uyumsuz ${removed} oyuncu listeye geri döndü.` : `Diziliş ${$("builder-formation").value} oldu.`);
  renderSquadBuilder();
}

function builderDragStart(event, playerId) {
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", playerId);
  const player = builderPlayer(playerId);
  if (!player) return;
  const preview = element("div", "builder-drag-preview");
  preview.setAttribute("aria-hidden", "true");
  const roles = builderPlayerRoles(player);
  preview.append(builderShirt(player, roles.size === 1 && roles.has("GK")));
  document.body.append(preview);
  event.dataTransfer.setDragImage(preview, preview.offsetWidth / 2, 36);
  // Keep the element mounted until the browser captures the native drag image.
  requestAnimationFrame(() => preview.remove());
}

function toggleBuilderPlayerDetails(playerId) {
  builderState.expandedPlayerId = builderState.expandedPlayerId === playerId ? null : playerId;
  const { players, teams } = builderData();
  renderBuilderPool(players, teams);
  requestAnimationFrame(() => $(`builder-player-toggle-${playerId}`)?.focus({ preventScroll: true }));
}

function builderFantasyMetrics(label, entries) {
  const section = element("section", "builder-fantasy-section");
  section.append(element("h4", "builder-fantasy-heading", label));
  const list = element("dl", "builder-fantasy-metrics");
  for (const [name, value] of entries) {
    const item = element("div");
    const detail = element("dd");
    detail.append(value);
    item.append(element("dt", "", name), detail);
    list.append(item);
  }
  section.append(list);
  return section;
}

function builderPlayerDetails(player, teams) {
  const { summary, projection, note } = builderFantasyData(player);
  const wrapper = element("div", "builder-player-details");
  const heading = element("div", "builder-player-details-heading");
  const identity = element("div");
  identity.append(
    element("span", "builder-player-details-label", "Fantezi istatistikleri"),
    element("span", "builder-player-details-meta", `${fantasyState.season || "Bu sezon"} · ${summary?.fantasy_position || projection?.position || [...player.positions].join(" / ") || "Mevki bilgisi yok"}`),
  );
  const actions = element("div", "builder-player-details-actions");
  if (player.matches.length) {
    const history = element("button", "secondary builder-detail-history", "Maç geçmişi");
    history.type = "button";
    history.addEventListener("click", () => openTierPlayer(player.id));
    actions.append(history);
  }
  heading.append(identity, actions);

  wrapper.append(heading);
  if (projection) {
    const opponent = element("span", "builder-opponent");
    opponent.append(createTeamLogo(projection.opponent_id, teams, false), element("span", "", projection.venue ? `(${projection.venue})` : ""));
    const next = builderFantasyMetrics(`Sonraki maç · ${projection.matchweek}. Hafta`, [
      ["Beklenen puan", displayNumber(fantasyProjectionNumber(projection, "expected_points"))],
      ["İlk 11 olasılığı", fantasyProbability(projection, "chance_starting")],
      ["Gol olasılığı", fantasyProbability(projection, "chance_scoring")],
      ["Fiyat", number(projection.price_million_try) === null ? "—" : `₺${displayNumber(Number(projection.price_million_try).toFixed(1))}M`],
      ["Rakip", opponent],
      ["Beklenen dakika", displayNumber(fantasyProjectionNumber(projection, "expected_minutes"))],
      ["Hücum zorluğu", fantasyFixtureDifficulty(projection, "attacking")],
      ["Savunma zorluğu", fantasyFixtureDifficulty(projection, "defensive")],
    ]);
    next.append(element("p", "builder-player-details-note", "Maç zorluğu: 1 en kolay, 5 en zor. Rakip ve saha için deneysel değerlendirmedir; beklenen puan bu eşleşmeyi zaten içerir."));
    if (projection.strength_context_status === "league_average_fallback") next.append(element("p", "builder-player-details-note", "Takım geçmişinin bir kısmı eksik; lig ortalaması güç kullanıldı."));
    if (projection.availability_status !== "no_reported_absence") {
      const availability = element("p", `builder-availability builder-availability-${["out", "expected_out", "doubtful"].includes(projection.availability_status) ? "caution" : "neutral"}`, fantasyAvailability(projection));
      if (projection.estimated_return_date) availability.append(document.createTextNode(` · Tahmini dönüş ${fantasyDate(projection.estimated_return_date)}`));
      next.append(availability);
      if (projection.availability_reason) next.append(element("p", "builder-player-details-note", projection.availability_reason.replaceAll("_", " ")));
      if (["expected_out", "doubtful", "unknown"].includes(projection.availability_status)) next.append(element("p", "builder-player-details-note", "Oynama durumu belirsizken tahmin gösterilmez."));
    }
    wrapper.append(next);
  } else {
    wrapper.append(element("p", "builder-player-details-note", note));
  }
  return wrapper;
}

function renderBuilderPitch(playersById) {
  const pitch = $("builder-slots");
  const bench = $("builder-bench-slots");
  pitch.replaceChildren();
  bench.replaceChildren();
  for (const rowData of [...builderFormationRows(), { label: "Yedekler", bench: true, slots: builderBenchSlots() }]) {
    const row = element("div", "builder-line");
    if (!rowData.bench) row.append(element("span", "builder-line-label", rowData.label));
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
      const label = slot.label || BUILDER_ROLE_CODE[slot.role];
      select.setAttribute("aria-label", player ? `${player.name}, ${label}. Bu mevkiyi seç.` : `Boş ${label} mevkisi. Seç.`);
      if (player) {
        select.append(builderShirt(player, slot.role === "GK" || (slot.bench && builderPlayerRoles(player).has("GK"))), element("span", "builder-position-name", player.name), element("span", "builder-position-rating", ratingText(player.average)));
        const price = builderPrice(player.id);
        select.append(element("span", "builder-position-price", price === null ? "Fiyat yok" : `₺${displayNumber(price / 1_000_000)}M`));
      } else {
        select.append(element("span", "builder-empty-plus", "+"), element("span", "builder-position-name", `Boş ${label}`));
      }
      select.addEventListener("click", () => {
        builderState.activeSlot = builderState.activeSlot === slot.key ? null : slot.key;
        builderMessage(builderState.activeSlot ? `${label} seçildi. Listeden uygun bir oyuncu seçin veya sürükleyin.` : "Mevki seçimi kaldırıldı.");
        renderSquadBuilder();
        focusBuilderSlot(slot.key);
      });
      position.append(select);
      if (player) {
        const remove = element("button", "builder-remove", "×");
        remove.type = "button";
        remove.setAttribute("aria-label", `${player.name} oyuncusunu çıkar`);
        remove.addEventListener("click", () => removeBuilderPlayer(slot.key));
        position.append(remove);
      }
      positions.append(position);
    }
    row.append(positions); (rowData.bench ? bench : pitch).append(row);
  }
}

function renderBuilderPool(players, teams) {
  const teamIds = [...new Set(players.flatMap((player) => [...player.teams]))];
  options($("builder-team"), teamIds.map((id) => [id, teamName(id, teams)]).sort((a, b) => a[1].localeCompare(b[1], "tr")), "Tüm takımlar");
  const query = $("builder-search").value.trim().toLocaleLowerCase();
  const team = $("builder-team").value;
  document.querySelectorAll("[data-builder-role]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.builderRole === builderState.role)));
  const matchesRole = (player) => {
    if (!builderState.role) return true;
    const current = fantasyState.season && fantasyState.season === state.seasonSlug;
    const position = current ? fantasyState.projections.get(player.id)?.[0]?.position || fantasyState.summaries.get(player.id)?.fantasy_position : null;
    const role = { KL: "GK", DEF: "DEF", OS: "MID", FOR: "FWD" }[position];
    return role ? role === builderState.role : builderPlayerRoles(player).has(builderState.role);
  };
  const pointsPerMatch = (player) => fantasyState.season && fantasyState.season === state.seasonSlug
    ? number(fantasyState.summaries.get(player.id)?.points_per_match) : null;
  const sortValue = $("builder-sort").value === "points" ? pointsPerMatch : (player) => player.average;
  const visible = players.filter((player) => matchesRole(player) && (!team || player.teams.has(team)) && (!query || `${player.name} ${player.teamNames.join(" ")}`.toLocaleLowerCase().includes(query)))
    .sort((a, b) => (sortValue(b) ?? -Infinity) - (sortValue(a) ?? -Infinity) || b.ratings.length - a.ratings.length || a.name.localeCompare(b.name));
  $("builder-result-count").textContent = `${visible.length} oyuncu`;
  const body = document.createDocumentFragment();
  for (const player of visible) {
    const selected = Boolean(selectedSlotFor(player.id));
    const expanded = builderState.expandedPlayerId === player.id;
    const tr = element("tr", `${selected ? "builder-player-selected " : ""}${expanded ? "builder-player-expanded" : ""}`.trim());
    tr.draggable = true;
    tr.addEventListener("dragstart", (event) => builderDragStart(event, player.id));
    const logoCell = element("td", "builder-club-cell");
    const logos = element("div", "club-logos");
    [...player.teams].forEach((id) => logos.append(createTeamLogo(id, teams)));
    if (!player.teams.size) logos.append(element("span", "", "—"));
    logoCell.append(logos);
    const nameCell = element("td", "builder-player-cell");
    const nameRow = element("div", "builder-player-name-row");
    const toggle = element("button", "builder-player-button builder-player-toggle", player.name);
    toggle.id = `builder-player-toggle-${player.id}`;
    toggle.type = "button";
    toggle.title = `${[...player.positions].join(" / ") || "Mevki bilgisi yok"} · ${player.ratings.length} geçerli maç puanı`;
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.setAttribute("aria-controls", `builder-player-details-${player.id}`);
    toggle.setAttribute("aria-label", `${player.name} fantezi istatistiklerini ${expanded ? "gizle" : "göster"}`);
    toggle.addEventListener("click", () => toggleBuilderPlayerDetails(player.id));
    const add = element("button", "builder-player-add", "+");
    add.type = "button";
    add.setAttribute("aria-label", `${player.name} oyuncusunu ${selected ? "taşı" : "ekle"}; ${[...player.positions].join(" veya ") || "mevki bilgisi yok"}`);
    add.addEventListener("click", () => placeBuilderPlayer(player.id));
    nameRow.append(toggle, add);
    nameCell.append(nameRow);
    const rating = element("td", "numeric builder-pool-rating", ratingText(player.average));
    rating.title = `${player.ratings.length} geçerli maç puanı`;
    rating.setAttribute("aria-label", player.average === null ? "Maç puanı yok" : `Ortalama maç puanı ${ratingText(player.average)}`);
    const points = element("td", "numeric builder-pool-rating", displayNumber(pointsPerMatch(player)));
    points.title = "Bu sezon oynadığı maç başına ortalama fantezi puanı";
    tr.append(logoCell, nameCell, rating, points);
    body.append(tr);
    if (expanded) {
      const detailsRow = element("tr", `builder-player-details-row${selected ? " builder-player-selected" : ""}`);
      const detailsCell = element("td");
      detailsCell.colSpan = 4;
      detailsCell.id = `builder-player-details-${player.id}`;
      const details = builderPlayerDetails(player, teams);
      details.setAttribute("role", "region");
      details.setAttribute("aria-labelledby", toggle.id);
      detailsCell.append(details);
      detailsRow.append(detailsCell);
      body.append(detailsRow);
    }
  }
  if (!visible.length) {
    const tr = element("tr"), cell = element("td", "no-results", players.length ? "Bu filtrelerle eşleşen oyuncu yok." : "Oyuncu havuzunu görmek için oyuncu, kadro ve maç CSV dosyalarını yükleyin.");
    cell.colSpan = 4; tr.append(cell); body.append(tr);
  }
  $("builder-player-list").replaceChildren(body);
}

function renderSquadBuilder() {
  const { players, teams } = builderData();
  const playersById = new Map(players.map((player) => [player.id, player]));
  for (const [slot, playerId] of builderState.selected) if (!playersById.has(playerId) || !builderSlots().some((item) => item.key === slot)) builderState.selected.delete(slot);
  $("builder-count").textContent = `${builderState.selected.size} / 15`;
  const budget = builderBudget();
  $("builder-budget").textContent = budget.missing ? "— / 100" : `${displayNumber(budget.spent / 1_000_000)} / 100`;
  $("builder-budget").title = budget.missing ? "Oyuncu fiyatı eksik; bütçe hesaplanamadı." : `Yedekler ₺${displayNumber(budget.bench / 1_000_000)}M · Kalan ₺${displayNumber(budget.remaining / 1_000_000)}M`;
  $("builder-budget").classList.toggle("error", Boolean(budget.missing || budget.remaining < 0));
  $("builder-fantasy-note").textContent = fantasyState.note;
  renderBuilderPitch(playersById);
  renderBuilderPool(players, teams);
  renderBuilderRecommendations();
}

function resetSquadBuilder() {
  builderState.selected.clear();
  builderState.activeSlot = null;
  builderState.expandedPlayerId = null;
  $("builder-search").value = "";
  $("builder-team").value = "";
  builderState.role = "";
  $("builder-sort").value = "rating";
  $("builder-risk").value = "balanced";
  $("builder-formation").value = "4-3-3";
  builderMessage("");
}

function setupSquadBuilder() {
  $("builder-formation").addEventListener("change", changeBuilderFormation);
  $("builder-clear").addEventListener("click", () => { resetSquadBuilder(); renderSquadBuilder(); });
  $("builder-search").addEventListener("input", renderSquadBuilder);
  $("builder-team").addEventListener("change", renderSquadBuilder);
  $("builder-sort").addEventListener("change", renderSquadBuilder);
  document.querySelectorAll("[data-builder-role]").forEach((button) => button.addEventListener("click", () => {
    builderState.role = button.dataset.builderRole;
    renderSquadBuilder();
  }));
  // An open page must stop showing a forecast after the round deadline passes.
  setInterval(() => { if (state.view === "builder" && builderState.expandedPlayerId) renderSquadBuilder(); }, 60000);
}
