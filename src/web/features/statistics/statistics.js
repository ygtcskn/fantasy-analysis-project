"use strict";

// The İstatistikler page: leader cards, the player list, season totals and the
// fantasy-points timeline. Both spider plots are built in src/web/lib.

// Season leaders and a searchable player list, built from the same aggregation
// the tier list uses so a player's totals never disagree between two pages.

const statisticsState = { search: "", team: "", role: "", sort: "rating", limit: 10, selected: null };

const STATISTICS_SORTS = [
  ["goals", "Gol", (player) => player.totals.goals.value],
  ["assists", "Asist", (player) => player.totals.assists.value],
  ["fantasy", "Fantezi puanı", (player) => statisticsFantasyPoints(player.id)],
  ["rating", "Puan", (player) => player.average],
  ["minutes_played", "Dakika", (player) => player.totals.minutes_played.value],
  ["key_passes", "Kilit pas", (player) => player.totals.key_passes.value],
];

function statisticsFantasyPoints(playerId) {
  if (!fantasyState.season || fantasyState.season !== state.seasonSlug) return null;
  return number(fantasyState.summaries.get(playerId)?.points_total);
}

function statisticsShortName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return parts.length < 2 ? (parts[0] || "—") : `${parts[0][0].toLocaleUpperCase("tr-TR")}. ${parts.at(-1)}`;
}

function statisticsListLayout() {
  const workspace = $("statistics-workspace");
  if (workspace.hidden) return;
  const panel = workspace.querySelector(".statistics-players");
  const ratings = $("statistics-ratings-chart").closest(".statistics-ratings");
  if (window.matchMedia("(min-width: 1101px)").matches) {
    const height = ratings.getBoundingClientRect().bottom - panel.getBoundingClientRect().top;
    if (height > 0 && panel.style.height !== `${Math.ceil(height)}px`) panel.style.height = `${Math.ceil(height)}px`;
  } else if (panel.style.height) panel.style.height = "";
  // Shrink only unusually long abbreviated names; keep every row on one line.
  for (const button of panel.querySelectorAll(".statistics-player-list-table .statistics-player-button")) {
    button.style.fontSize = "";
    for (let size = 12; size >= 8 && button.scrollWidth > button.clientWidth; size--) {
      button.style.fontSize = `${size}px`;
    }
  }
}

function statisticsLeaders(players, accessor, limit) {
  return players
    .map((player) => ({ player, value: accessor(player) }))
    .filter((entry) => entry.value !== null && entry.value > 0)
    .sort((a, b) => b.value - a.value
      || (b.player.totals.minutes_played.value ?? 0) - (a.player.totals.minutes_played.value ?? 0)
      || a.player.name.localeCompare(b.player.name, "tr"))
    .slice(0, limit);
}

function renderStatisticsCard(bodyId, noteId, players, teams, accessor, format, emptyNote) {
  const leaders = statisticsLeaders(players, accessor, statisticsState.limit);
  const body = document.createDocumentFragment();
  // Equal values share a rank, so two players on nine goals both read 1.
  let rank = 0;
  leaders.forEach((entry, index) => {
    if (index === 0 || entry.value !== leaders[index - 1].value) rank = index + 1;
    const row = element("tr");
    row.append(element("td", "numeric statistics-rank", String(rank)));
    const identity = element("td");
    const club = element("div", "statistics-club");
    club.append(createTeamLogo([...entry.player.teams][0] || "unknown", teams, false));
    const open = element("button", "statistics-player-button", entry.player.name);
    open.type = "button";
    open.setAttribute("aria-label", `${entry.player.name} maç istatistiklerini aç`);
    open.addEventListener("click", () => openTierPlayer(entry.player.id));
    club.append(open);
    identity.append(club);
    row.append(identity, element("td", "numeric statistics-value", format(entry.value)));
    body.append(row);
  });
  if (!leaders.length) {
    const row = element("tr"), cell = element("td", "no-results", emptyNote);
    cell.colSpan = 3;
    row.append(cell);
    body.append(row);
  }
  $(bodyId).replaceChildren(body);
  $(noteId).textContent = leaders.length
    ? `İlk ${leaders.length} oyuncu gösteriliyor.`
    : "";
}

function renderStatisticsList(players, teams) {
  const teamIds = [...new Set(players.flatMap((player) => [...player.teams]))];
  options($("statistics-team"), teamIds.map((id) => [id, teamName(id, teams)])
    .sort((a, b) => a[1].localeCompare(b[1], "tr")), "Tüm takımlar");
  const query = $("statistics-search").value.trim().toLocaleLowerCase("tr");
  const team = $("statistics-team").value;
  const [, , accessor] = STATISTICS_SORTS.find(([key]) => key === $("statistics-sort").value)
    || STATISTICS_SORTS[0];
  const role = statisticsState.role;
  const visible = players
    .filter((player) => (!team || player.teams.has(team))
      && (!role || playerPrimaryRole(player) === role)
      && (!query || `${player.name} ${player.teamNames.join(" ")}`.toLocaleLowerCase("tr").includes(query)))
    .sort((a, b) => (accessor(b) ?? -Infinity) - (accessor(a) ?? -Infinity)
      || a.name.localeCompare(b.name, "tr"));
  const body = document.createDocumentFragment();
  for (const player of visible) {
    const row = element("tr");
    const identity = element("td");
    const club = element("div", "statistics-club");
    club.append(createTeamLogo([...player.teams][0] || "unknown", teams, false));
    const open = element("button", "statistics-player-button", statisticsShortName(player.name));
    open.type = "button";
    open.title = player.name;
    open.setAttribute("aria-label", `${player.name} profilini göster`);
    open.addEventListener("click", () => {
      statisticsState.selected = player.id;
      renderStatistics();
    });
    club.append(open);
    identity.append(club);
    if (player.id === statisticsState.selected) row.classList.add("statistics-row-selected");
    row.append(identity);
    row.append(element("td", "statistics-role", playerRoleLabel(playerPrimaryRole(player))));
    row.append(element("td", "numeric", displayNumber(player.totals.minutes_played.value)));
    row.append(element("td", "numeric", ratingText(player.average)));
    row.append(element("td", "numeric", displayNumber(statisticsFantasyPoints(player.id))));
    body.append(row);
  }
  if (!visible.length) {
    const row = element("tr"), cell = element("td", "no-results", "Bu filtrelerle oyuncu bulunamadı.");
    cell.colSpan = 5;
    row.append(cell);
    body.append(row);
  }
  $("statistics-list-body").replaceChildren(body);
}

function renderStatistics() {
  const { players, teams } = leaguePlayers();
  renderStatisticsCard("statistics-scorers-body", "statistics-scorers-note", players, teams,
    (player) => player.totals.goals.value, (value) => displayNumber(value),
    "Kayıtlı gol bulunamadı.");
  renderStatisticsCard("statistics-assists-body", "statistics-assists-note", players, teams,
    (player) => player.totals.assists.value, (value) => displayNumber(value),
    "Kayıtlı asist bulunamadı.");
  // Fantasy points are the currency this whole project is built around, and
  // they are not visible anywhere else on the site, so they earn the third card
  // rather than a fourth attacking metric that mostly repeats the first two.
  const fantasyReady = fantasyState.season && fantasyState.season === state.seasonSlug;
  renderStatisticsCard("statistics-fantasy-body", "statistics-fantasy-note", players, teams,
    (player) => statisticsFantasyPoints(player.id), (value) => displayNumber(value),
    fantasyReady ? "Fantezi puanı bulunamadı."
      : "Fantezi analizi yüklenmedi. Sayfayı yenileyin.");
  renderStatisticsList(players, teams);
  renderStatisticsProfile(players);
  requestAnimationFrame(statisticsListLayout);
}

function setupStatistics() {
  $("statistics-search").addEventListener("input", renderStatistics);
  $("statistics-team").addEventListener("change", renderStatistics);
  $("statistics-sort").addEventListener("change", renderStatistics);
  document.querySelectorAll("[data-statistics-role]").forEach((button) => button.addEventListener("click", () => {
    statisticsState.role = button.dataset.statisticsRole;
    document.querySelectorAll("[data-statistics-role]").forEach((other) =>
      other.setAttribute("aria-pressed", String(other === button)));
    renderStatistics();
  }));
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => requestAnimationFrame(statisticsListLayout));
    observer.observe($("statistics-ratings-chart").closest(".statistics-ratings"));
    observer.observe($("statistics-workspace").querySelector(".statistics-players"));
  }
  window.addEventListener("resize", () => requestAnimationFrame(statisticsListLayout));
}

// ---------------------------------------------------------------- player profile
// Selecting a player in the list fills the profile: two spider plots (built in
// src/web/lib), his season totals, his fantasy points match by match, his
// Sportmonks rating match by match, and the distribution of each wheel metric
// (src/web/features/statistics).

function renderStatisticsFacts(player) {
  const list = document.createDocumentFragment();
  const current = fantasyState.season === state.seasonSlug;
  const matches = current ? fantasyState.matches.get(player.id) || [] : [];
  const summary = current ? fantasyState.summaries.get(player.id) : null;
  const entries = [
    ["Maç", displayNumber(player.matches.length)],
    ["Dakika", displayNumber(player.totals.minutes_played.value)],
    ["Gol", displayNumber(player.totals.goals.value)],
    ["Asist", displayNumber(player.totals.assists.value)],
    ["Şut", displayNumber(player.totals.shots_total.value)],
    ["Kilit pas", displayNumber(player.totals.key_passes.value)],
    ["Maç puanı", ratingText(player.average)],
    ["Fantezi puanı", summary ? displayNumber(number(summary.points_total)) : "—"],
    ["Maç başına", summary ? displayNumber(number(summary.points_per_match)) : "—"],
    ["En iyi maç", matches.length
      ? displayNumber(Math.max(...matches.map((row) => number(row.points_total) ?? 0))) : "—"],
  ];
  for (const [label, value] of entries) {
    const item = element("div");
    item.append(element("dt", "", label), element("dd", "", value));
    list.append(item);
  }
  $("statistics-facts-list").replaceChildren(list);
}

// The fantasy timeline and the Sportmonks rating bars below share one frame -
// size, margins, plot area, fonts and six evenly spaced gridlines - so a match
// sits at the same x in both and the two read as one pair. The rating axis is
// the provider's fixed 0-10; fantasy points use 0-10 too unless a player's
// points leave it, and then the smallest round step (1, 2 or 5 x 10^k) that
// keeps six gridlines and covers every match.
const STATISTICS_PROFILE_PLOT = { width: 640, height: 250, left: 34, right: 62, top: 14, bottom: 40 };

function statisticsTicks(low, high, intervals = 5) {
  for (let power = 1; power <= 1e6; power *= 10) {
    for (const step of [power, 2 * power, 5 * power]) {
      const start = Math.floor(low / step) * step;
      if (start + step * intervals >= high) return Array.from({ length: intervals + 1 }, (_, index) => start + index * step);
    }
  }
  return [low, high];
}

// Both match charts share one x axis: every match with a valid Sportmonks
// rating or recorded fantasy points, in kickoff order, labelled from
// fixtures.csv. A match therefore sits in the same column in both charts; a
// chart with no value for it leaves the column empty rather than closing up.
function statisticsMatchSlots(player) {
  const { teams } = buildTierPlayers();
  const fixtures = new Map((state.tables["fixtures.csv"] || []).map((fixture) => [fixture.fixture_id, fixture]));
  const fantasy = fantasyState.season === state.seasonSlug ? fantasyState.matches.get(player.id) || [] : [];
  const ratings = new Map(), points = new Map(), sides = new Map(), spares = new Map();
  for (const row of player.matches) {
    sides.set(row.fixture_id, row.team_id);
    const rating = validMatchRating(row);
    if (rating !== null) ratings.set(row.fixture_id, { rating, minutes: number(row.minutes_played) });
  }
  for (const row of fantasy) {
    points.set(row.fixture_id, number(row.points_total) ?? 0);
    if (!sides.has(row.fixture_id)) sides.set(row.fixture_id, row.team_id);
    spares.set(row.fixture_id, row);
  }
  return [...new Set([...ratings.keys(), ...points.keys()])].map((id) => {
    const fixture = fixtures.get(id), team = sides.get(id), spare = spares.get(id);
    const home = fixture ? team === fixture.home_team_id : spare ? spare.venue === "home" : null;
    const opponent = fixture ? (home ? fixture.away_team_id : fixture.home_team_id) : spare?.opponent_id ?? null;
    const time = fixture ? fantasyKickoff(fixture) : fantasyTime(spare?.kickoff_utc);
    return { fixture_id: id, time, round: fixture?.["round.name"] || spare?.round || "",
      date: Number.isFinite(time) ? fantasyDate(new Date(time).toISOString()) : "",
      opponent: teamName(opponent, teams),
      code: (teams.get(opponent)?.short_code || teamName(opponent, teams)) + (home === null ? "" : home ? " (İ)" : " (D)"),
      rating: ratings.get(id)?.rating ?? null, minutes: ratings.get(id)?.minutes ?? null,
      points: points.has(id) ? points.get(id) : null };
  }).sort((a, b) => (Number.isFinite(a.time) ? a.time : Infinity) - (Number.isFinite(b.time) ? b.time : Infinity));
}

// The shared frame's horizontal parts: one column per match, values over the
// marks while there is room, round and opponent under each column thinned to
// about twelve labels so a full season never collides.
function statisticsMatchColumns(slots) {
  const { width, left, right } = STATISTICS_PROFILE_PLOT;
  const slot = (width - left - right) / slots.length;
  return { slot, x: (index) => left + slot * index + slot / 2, showValues: slot >= 30,
    every: Math.max(1, Math.ceil(slots.length / 12)) };
}

function statisticsMatchLabels(parts, slots, columns) {
  const { height, bottom } = STATISTICS_PROFILE_PLOT;
  slots.forEach((entry, index) => {
    if (index % columns.every && index !== slots.length - 1) return;
    const centre = columns.x(index).toFixed(1);
    if (entry.round) parts.push(`<text x="${centre}" y="${height - bottom + 15}" text-anchor="middle" font-size="10" fill="var(--ink)">${statisticsEscape(`${entry.round}. hf`)}</text>`);
    parts.push(`<text x="${centre}" y="${height - bottom + 28}" text-anchor="middle" font-size="9" fill="var(--muted)">${statisticsEscape(entry.code)}</text>`);
  });
}

function statisticsTimelineSvg(slots, average) {
  const { width, height, left, right, top, bottom } = STATISTICS_PROFILE_PLOT;
  const values = slots.map((entry) => entry.points).filter((value) => value !== null);
  const ticks = statisticsTicks(Math.min(0, ...values), Math.max(10, ...values));
  const low = ticks[0], high = ticks.at(-1), columns = statisticsMatchColumns(slots), x = columns.x;
  const y = (value) => height - bottom - ((value - low) / (high - low)) * (height - top - bottom);
  const parts = [];
  for (const tick of ticks) {
    parts.push(`<line x1="${left}" y1="${y(tick).toFixed(1)}" x2="${width - right}" y2="${y(tick).toFixed(1)}" stroke="var(--line)" stroke-width="1"/>`);
    parts.push(`<text x="${left - 6}" y="${(y(tick) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--muted)">${tick}</text>`);
  }
  if (low < 0) {
    parts.push(`<line x1="${left}" y1="${y(0).toFixed(1)}" x2="${width - right}" y2="${y(0).toFixed(1)}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3"/>`);
  }
  // The line breaks across a match without fantasy points.
  let run = [];
  const flush = () => {
    if (run.length > 1) parts.push(`<polyline points="${run.join(" ")}" fill="none" stroke="var(--statistics-plot-line)" stroke-width="2"/>`);
    run = [];
  };
  slots.forEach((entry, index) => {
    if (entry.points === null) flush();
    else run.push(`${x(index).toFixed(1)},${y(entry.points).toFixed(1)}`);
  });
  flush();
  slots.forEach((entry, index) => {
    if (entry.points === null) return;
    const centre = x(index).toFixed(1);
    const detail = statisticsEscape(`${entry.round ? `${entry.round}. hafta · ` : ""}${entry.date ? `${entry.date} · ` : ""}`
      + `${entry.opponent} · ${displayNumber(entry.points)} fantezi puanı`);
    parts.push(`<circle cx="${centre}" cy="${y(entry.points).toFixed(1)}" r="3.5" fill="var(--statistics-plot-line)"><title>${detail}</title></circle>`);
    if (columns.showValues) parts.push(`<text x="${centre}" y="${(y(entry.points) - 8).toFixed(1)}" text-anchor="middle" font-size="10" fill="var(--muted)">${displayNumber(entry.points)}</text>`);
  });
  statisticsMatchLabels(parts, slots, columns);
  const mean = y(average).toFixed(1);
  parts.push(`<line data-timeline-average="${average}" x1="${left}" y1="${mean}" x2="${width - right + 4}" y2="${mean}" stroke="var(--ink)" stroke-width="1.5" stroke-dasharray="4 3"/>`);
  parts.push(`<text x="${width - right + 8}" y="${(y(average) + 4).toFixed(1)}" font-size="10" font-weight="600" fill="var(--ink)">Ort. ${displayNumber(average)}</text>`);
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Maç maç fantezi puanı; ortalama ${displayNumber(average)}">${parts.join("")}</svg>`;
}

function renderStatisticsTimeline(player, slots = statisticsMatchSlots(player)) {
  if (fantasyState.season !== state.seasonSlug) {
    $("statistics-timeline-chart").replaceChildren();
    $("statistics-timeline-note").textContent = "Fantezi analizi yüklenmedi. Sayfayı yenileyin.";
    return;
  }
  const scored = slots.filter((entry) => entry.points !== null);
  if (!scored.length) {
    $("statistics-timeline-chart").replaceChildren();
    $("statistics-timeline-note").textContent = "Bu oyuncu için kayıtlı fantezi puanı yok.";
    return;
  }
  const total = scored.reduce((sum, entry) => sum + entry.points, 0);
  $("statistics-timeline-chart").innerHTML = statisticsTimelineSvg(slots, total / scored.length);
  $("statistics-timeline-note").textContent =
    `${scored.length} maç · toplam ${displayNumber(total)} puan · maç başına ${displayNumber(total / scored.length)}.`;
}

// ---------------------------------------------------------------- match ratings
// One vertical bar per rated match, in the same columns as the timeline above.
// Bars start at zero on the provider's 0-10 scale, so their heights compare
// honestly. The dashed line is the player's own average - the same unweighted
// mean of valid match ratings as "Maç puanı" in the season totals and the tier
// list - and matches below it are drawn paler.

const statisticsEscape = (value) => String(value ?? "").replace(/[&<>"']/g,
  (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

function statisticsRatingsSvg(slots, average) {
  const { width, height, left, right, top, bottom } = STATISTICS_PROFILE_PLOT;
  const columns = statisticsMatchColumns(slots), x = columns.x, bar = Math.min(columns.slot * 0.7, 46);
  const y = (value) => height - bottom - (value / 10) * (height - top - bottom);
  const parts = [];
  for (const tick of [0, 2, 4, 6, 8, 10]) {
    parts.push(`<line x1="${left}" y1="${y(tick).toFixed(1)}" x2="${width - right}" y2="${y(tick).toFixed(1)}" stroke="var(--line)" stroke-width="1"/>`);
    parts.push(`<text x="${left - 6}" y="${(y(tick) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--muted)">${tick}</text>`);
  }
  // Values sit on the bars only while there is room for them; a full season
  // keeps them in each bar's tooltip instead. A match without a valid rating
  // keeps its empty column, so the bars stay under the timeline's points.
  slots.forEach((entry, index) => {
    if (entry.rating === null) return;
    const below = entry.rating < average, centre = x(index).toFixed(1);
    const detail = statisticsEscape(`${entry.round ? `${entry.round}. hafta · ` : ""}${entry.date ? `${entry.date} · ` : ""}`
      + `${entry.opponent} · ${entry.minutes === null ? "—" : displayNumber(entry.minutes)} dk · Sportmonks puanı ${ratingText(entry.rating)}`);
    parts.push(`<rect data-rating-bar="${index}" x="${(x(index) - bar / 2).toFixed(1)}" y="${y(entry.rating).toFixed(1)}" width="${bar.toFixed(1)}" height="${(y(0) - y(entry.rating)).toFixed(1)}" rx="2" fill="var(--statistics-plot-line)" fill-opacity="${below ? 0.4 : 0.9}"><title>${detail}</title></rect>`);
    if (columns.showValues) parts.push(`<text x="${centre}" y="${(y(entry.rating) - 5).toFixed(1)}" text-anchor="middle" font-size="10" fill="var(--muted)">${ratingText(entry.rating)}</text>`);
  });
  statisticsMatchLabels(parts, slots, columns);
  // The average runs across every bar and is labelled in the right margin,
  // where no bar can cover it.
  const mean = y(average).toFixed(1);
  parts.push(`<line data-rating-average="${average}" x1="${left}" y1="${mean}" x2="${width - right + 4}" y2="${mean}" stroke="var(--ink)" stroke-width="1.5" stroke-dasharray="4 3"/>`);
  parts.push(`<text x="${width - right + 8}" y="${(y(average) + 4).toFixed(1)}" font-size="10" font-weight="600" fill="var(--ink)">Ort. ${ratingText(average)}</text>`);
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Maç maç Sportmonks puanı; ortalama ${ratingText(average)}">${parts.join("")}</svg>`;
}

function renderStatisticsRatings(player, slots = statisticsMatchSlots(player)) {
  const rated = slots.filter((entry) => entry.rating !== null);
  if (!rated.length) {
    $("statistics-ratings-chart").replaceChildren();
    $("statistics-ratings-note").textContent = "Bu oyuncu için geçerli Sportmonks maç puanı yok.";
    return;
  }
  const ratings = rated.map((entry) => entry.rating);
  const average = ratings.reduce((sum, value) => sum + value, 0) / ratings.length;
  $("statistics-ratings-chart").innerHTML = statisticsRatingsSvg(slots, average);
  const unrated = player.matches.length - rated.length;
  $("statistics-ratings-note").textContent = `${rated.length} puanlı maç · ortalama ${ratingText(average)}`
    + ` (dakikaya göre ağırlıksız) · en yüksek ${ratingText(Math.max(...ratings))} · en düşük ${ratingText(Math.min(...ratings))}. `
    + "Kesikli çizgi oyuncunun ortalamasıdır; altındaki maçlar soluk gösterilir."
    + (unrated > 0 ? ` ${unrated} kayıtta geçerli puan yok (oynamadı veya puan verilmedi).` : "");
}

function renderStatisticsProfile(players) {
  const selected = players.find((player) => player.id === statisticsState.selected)
    || statisticsLeaders(players, (player) => player.totals.goals.value, 1)[0]?.player
    || players[0];
  if (!selected) {
    $("statistics-profile-name").textContent = "—";
    $("statistics-profile-note").textContent = "Oyuncu bulunamadı.";
    for (const id of ["statistics-radar-chart", "statistics-detailed-chart", "statistics-radar-details",
      "statistics-detailed-details", "statistics-facts-list", "statistics-timeline-chart", "statistics-ratings-chart",
      "statistics-distribution-chart"]) {
      $(id).replaceChildren();
    }
    for (const id of ["statistics-radar-note", "statistics-detailed-note", "statistics-timeline-note",
      "statistics-ratings-note", "statistics-distribution-note"]) $(id).textContent = "";
    return;
  }
  statisticsState.selected = selected.id;
  $("statistics-profile-name").textContent = selected.name;
  $("statistics-profile-note").textContent =
    `${selected.teamNames[0] || "—"} · listeden bir oyuncuya tıklayarak profili değiştirin.`;
  $("statistics-open-history").onclick = () => openTierPlayer(selected.id);
  // The spider plots are separate assets in src/web/lib. A server started
  // before they moved there answers 404 for them; the rest of the page still
  // renders and says what to do.
  let radar = null;
  if (typeof renderStatisticsRadars === "function") radar = renderStatisticsRadars(selected, players);
  else {
    for (const id of ["statistics-radar-chart", "statistics-detailed-chart", "statistics-radar-details",
      "statistics-detailed-details"]) $(id).replaceChildren();
    for (const id of ["statistics-radar-note", "statistics-detailed-note"]) {
      $(id).textContent = "Radar dosyaları yüklenemedi; src/web/serve.py'yi yeniden başlatıp sayfayı yenileyin.";
      $(id).hidden = false;
    }
  }
  renderStatisticsFacts(selected);
  const slots = statisticsMatchSlots(selected);
  renderStatisticsTimeline(selected, slots);
  renderStatisticsRatings(selected, slots);
  // The distribution chart reuses the wheel's reference and scores.
  if (typeof renderPlayerDistribution === "function") renderPlayerDistribution(radar, selected);
}
