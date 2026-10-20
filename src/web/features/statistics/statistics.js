"use strict";

// The İstatistikler page: leader cards, the player list, season totals and the
// fantasy-points timeline. Both spider plots are built in src/web/lib.

// Season leaders and a searchable player list, built from the same aggregation
// the tier list uses so a player's totals never disagree between two pages.

// `selected` is the primary player, `compare` the secondary; `picked` turns
// true at the first click, so the default leader is replaced, not compared.
const statisticsState = { search: "", team: "", role: "", sort: "rating", limit: 10,
  selected: null, compare: null, picked: false };

const STATISTICS_SORTS = [
  ["goals", "Gol", (player) => player.totals.goals.value],
  ["assists", "Asist", (player) => player.totals.assists.value],
  ["fantasy", "Fantezi puanı", (player) => statisticsFantasyPoints(player.id)],
  ["rating", "Reyting", (player) => player.average],
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
    club.append(createTeamLogo(entry.player.club || "unknown", teams, false));
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
    club.append(createTeamLogo(player.club || "unknown", teams, false));
    const open = element("button", "statistics-player-button", statisticsShortName(player.name));
    open.type = "button";
    open.title = player.name;
    open.setAttribute("aria-label", `${player.name} profilini göster`);
    open.addEventListener("click", () => statisticsPick(player.id));
    club.append(open);
    identity.append(club);
    if (player.id === statisticsState.selected) row.classList.add("statistics-row-selected");
    if (player.id === statisticsState.compare) row.classList.add("statistics-row-selected", "statistics-row-compare");
    row.append(identity);
    row.append(element("td", "statistics-role", roleLabel(playerPrimaryRole(player))));
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
//
// The first player picked is the primary. Picking another adds him as the
// secondary, drawn beside the primary on every chart in the second colour;
// picking a third replaces the secondary. Picking the secondary again removes
// him, and picking the primary while comparing hands the primary role to the
// secondary. The × on each name chip does the same.

function statisticsPick(id) {
  const pick = statisticsState;
  if (!pick.picked) Object.assign(pick, { selected: id, compare: null, picked: true });
  else if (id === pick.compare) pick.compare = null;
  else if (id === pick.selected) {
    if (pick.compare) Object.assign(pick, { selected: pick.compare, compare: null });
  } else pick.compare = id;
  renderStatistics();
}

// One swatch per player at the start of his name chip, and a legend after each
// chart title while two players are shown.
function statisticsSwatch(index) {
  const swatch = element("span", "statistics-swatch");
  swatch.style.background = STATISTICS_SERIES[index].line;
  swatch.setAttribute("aria-hidden", "true");
  return swatch;
}

function renderStatisticsHeader(profiles) {
  const chips = profiles.map((player, index) => {
    const chip = element("span", "statistics-player-chip");
    chip.append(statisticsSwatch(index), element("strong", "", player.name),
      element("small", "", player.clubName || "—"));
    if (profiles.length > 1) {
      const remove = element("button", "statistics-chip-remove", "×");
      remove.type = "button";
      remove.title = `${player.name} karşılaştırmadan çıkar`;
      remove.setAttribute("aria-label", remove.title);
      remove.addEventListener("click", () => statisticsPick(player.id));
      chip.append(remove);
    }
    return chip;
  });
  $("statistics-profile-name").replaceChildren(...chips);
  $("statistics-profile-note").textContent = profiles.length > 1
    ? "Listeden başka bir oyuncuya tıklayarak ikinci oyuncuyu değiştirin; × ya da listede adına tıklayarak çıkarın. "
      + "Radarlarda ve dağılımda ikinci oyuncu birincil oyuncunun emsal grubunda sıralanır."
    : "Karşılaştırmak için listeden ikinci bir oyuncuya tıklayın.";
}

const STATISTICS_LEGEND_TITLES = ["statistics-radar-title", "statistics-detailed-title", "statistics-facts-title",
  "statistics-timeline-title", "statistics-ratings-title", "statistics-distribution-title"];

function renderStatisticsLegends(profiles) {
  for (const id of STATISTICS_LEGEND_TITLES) {
    $(id).querySelector(".statistics-legend")?.remove();
    if (profiles.length < 2) continue;
    const legend = element("span", "statistics-legend");
    profiles.forEach((player, index) => {
      const item = element("span", "statistics-legend-item");
      item.append(statisticsSwatch(index), document.createTextNode(statisticsShortName(player.name)));
      legend.append(item);
    });
    $(id).append(legend);
  }
}

function renderStatisticsFacts(profiles) {
  const current = fantasyState.season === state.seasonSlug;
  const rows = profiles.map((player) => {
    const matches = current ? fantasyState.matches.get(player.id) || [] : [];
    const summary = current ? fantasyState.summaries.get(player.id) : null;
    return [
      displayNumber(player.matches.length),
      displayNumber(player.totals.minutes_played.value),
      displayNumber(player.totals.goals.value),
      displayNumber(player.totals.assists.value),
      displayNumber(player.totals.shots_total.value),
      displayNumber(player.totals.key_passes.value),
      ratingText(player.average),
      summary ? displayNumber(number(summary.points_total)) : "—",
      summary ? displayNumber(number(summary.points_per_match)) : "—",
      matches.length ? displayNumber(Math.max(...matches.map((row) => number(row.points_total) ?? 0))) : "—",
    ];
  });
  const labels = ["Maç", "Dakika", "Gol", "Asist", "Şut", "Kilit pas", "Reyting", "Fantezi puanı", "FP / maç", "En iyi maç (FP)"];
  const list = document.createDocumentFragment();
  labels.forEach((label, row) => {
    const item = element("div"), value = element("dd");
    // Compared, each value follows its player's swatch, primary first.
    rows.forEach((values, index) => {
      if (rows.length < 2) { value.textContent = values[row]; return; }
      const part = element("span", "statistics-fact-value");
      part.append(statisticsSwatch(index), document.createTextNode(values[row]));
      value.append(part);
    });
    item.append(element("dt", "", label), value);
    list.append(item);
  });
  $("statistics-facts-list").replaceChildren(list);
}

// The fantasy timeline and the Sportmonks rating bars below share one frame -
// size, margins, plot area, fonts and six evenly spaced gridlines - so a match
// sits at the same x in both and the two read as one pair. The rating axis is
// the provider's fixed 0-10; fantasy points use 0-10 too unless a player's
// points leave it, and then the smallest round step (1, 2 or 5 x 10^k) that
// keeps six gridlines and covers every match. Compared, the frame grows by one
// label line so each player's opponent sits under the column.
const STATISTICS_PROFILE_PLOT = { width: 640, height: 250, left: 34, right: 62, top: 14, bottom: 40 };

function statisticsFrame(count) {
  const extra = 12 * Math.max(0, count - 1);
  return { ...STATISTICS_PROFILE_PLOT, height: STATISTICS_PROFILE_PLOT.height + extra,
    bottom: STATISTICS_PROFILE_PLOT.bottom + extra };
}

function statisticsTicks(low, high, intervals = 5) {
  for (let power = 1; power <= 1e6; power *= 10) {
    for (const step of [power, 2 * power, 5 * power]) {
      const start = Math.floor(low / step) * step;
      if (start + step * intervals >= high) return Array.from({ length: intervals + 1 }, (_, index) => start + index * step);
    }
  }
  return [low, high];
}

// One player's matches with a valid Sportmonks rating or recorded fantasy
// points, labelled from fixtures.csv.
function statisticsPlayerMatches(player, teams, fixtures) {
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
    return { fixture_id: id, time, round: String(fixture?.["round.name"] || spare?.round || ""),
      date: Number.isFinite(time) ? fantasyDate(new Date(time).toISOString()) : "",
      opponent: teamName(opponent, teams),
      code: (teams.get(opponent)?.short_code || teamName(opponent, teams)) + (home === null ? "" : home ? " (İ)" : " (D)"),
      rating: ratings.get(id)?.rating ?? null, minutes: ratings.get(id)?.minutes ?? null,
      points: points.has(id) ? points.get(id) : null };
  });
}

// Both match charts share one x axis: one column per round (two players play
// different fixtures in the same week), each holding every compared player's
// match that round, in kickoff order. A chart with no value for a player in a
// column leaves it empty rather than closing up. A second match in one round
// for the same player gets a column of its own.
function statisticsMatchSlots(profiles) {
  const { teams } = buildTierPlayers();
  const fixtures = new Map((state.tables["fixtures.csv"] || []).map((fixture) => [fixture.fixture_id, fixture]));
  const slots = new Map();
  profiles.forEach((player, which) => {
    for (const match of statisticsPlayerMatches(player, teams, fixtures)) {
      let key = match.round ? `r${match.round}` : `f${match.fixture_id}`;
      if (slots.get(key)?.entries[which]) key += `:${match.fixture_id}`;
      if (!slots.has(key)) slots.set(key, { round: match.round, time: match.time, entries: profiles.map(() => null) });
      const slot = slots.get(key);
      slot.entries[which] = match;
      if (Number.isFinite(match.time) && !(slot.time <= match.time)) slot.time = match.time;
    }
  });
  const order = (slot) => (Number.isFinite(slot.time) ? slot.time : Infinity);
  return [...slots.values()].sort((a, b) => order(a) - order(b)
    || (Number(a.round) || Infinity) - (Number(b.round) || Infinity));
}

// The shared frame's horizontal parts: one column per round, values over the
// marks while there is room and only one player is shown, round and each
// player's opponent under the column, thinned to about twelve columns so a
// full season never collides.
function statisticsMatchColumns(slots, frame) {
  const slot = (frame.width - frame.left - frame.right) / slots.length;
  return { slot, x: (index) => frame.left + slot * index + slot / 2,
    showValues: slot >= 30 && (slots[0]?.entries.length ?? 1) < 2,
    every: Math.max(1, Math.ceil(slots.length / 12)) };
}

function statisticsMatchLabels(parts, slots, columns, frame) {
  const compared = (slots[0]?.entries.length ?? 1) > 1;
  slots.forEach((slot, index) => {
    if (index % columns.every && index !== slots.length - 1) return;
    const centre = columns.x(index).toFixed(1), base = frame.height - frame.bottom;
    if (slot.round) parts.push(`<text x="${centre}" y="${base + 15}" text-anchor="middle" font-size="10" fill="var(--ink)">${statisticsEscape(`${slot.round}. hf`)}</text>`);
    // One opponent line per player, primary first; compared, each line takes
    // its player's colour so the column says whose fixture it is.
    slot.entries.forEach((entry, which) => {
      if (!entry) return;
      const fill = compared ? STATISTICS_SERIES[which].line : "var(--muted)";
      parts.push(`<text x="${centre}" y="${base + 28 + which * 12}" text-anchor="middle" font-size="9" fill="${fill}">${statisticsEscape(entry.code)}</text>`);
    });
  });
}

// Each player's average as a dashed line across the plot, labelled in the
// right margin; labels closer than a line apart are pushed apart.
function statisticsAverageLines(parts, averages, y, frame, format, attribute) {
  const compared = averages.length > 1;
  const placed = averages.map((entry) => ({ ...entry, at: y(entry.value) })).sort((a, b) => a.at - b.at);
  placed.forEach((entry, index) => { if (index && entry.at - placed[index - 1].at < 12) entry.at = placed[index - 1].at + 12; });
  for (const entry of placed) {
    const stroke = compared ? STATISTICS_SERIES[entry.which].line : "var(--ink)";
    const mean = y(entry.value).toFixed(1);
    parts.push(`<line ${attribute}="${entry.value}" x1="${frame.left}" y1="${mean}" x2="${frame.width - frame.right + 4}" y2="${mean}" stroke="${stroke}" stroke-width="1.5" stroke-dasharray="4 3"/>`);
    parts.push(`<text x="${frame.width - frame.right + 8}" y="${(entry.at + 4).toFixed(1)}" font-size="10" font-weight="600" fill="${stroke}">Ort. ${format(entry.value)}</text>`);
  }
}

const statisticsEscape = (value) => String(value ?? "").replace(/[&<>"']/g,
  (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

function statisticsMatchDetail(entry, tail) {
  return statisticsEscape(`${entry.round ? `${entry.round}. hafta · ` : ""}${entry.date ? `${entry.date} · ` : ""}${entry.opponent} · ${tail}`);
}

function statisticsTimelineSvg(slots, averages, names) {
  const frame = statisticsFrame(slots[0].entries.length);
  const { width, height, left, right, top, bottom } = frame;
  const values = slots.flatMap((slot) => slot.entries.map((entry) => entry?.points ?? null)).filter((value) => value !== null);
  const ticks = statisticsTicks(Math.min(0, ...values), Math.max(10, ...values));
  const low = ticks[0], high = ticks.at(-1), columns = statisticsMatchColumns(slots, frame), x = columns.x;
  const y = (value) => height - bottom - ((value - low) / (high - low)) * (height - top - bottom);
  const parts = [];
  for (const tick of ticks) {
    parts.push(`<line x1="${left}" y1="${y(tick).toFixed(1)}" x2="${width - right}" y2="${y(tick).toFixed(1)}" stroke="var(--line)" stroke-width="1"/>`);
    parts.push(`<text x="${left - 6}" y="${(y(tick) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--muted)">${tick}</text>`);
  }
  if (low < 0) {
    parts.push(`<line x1="${left}" y1="${y(0).toFixed(1)}" x2="${width - right}" y2="${y(0).toFixed(1)}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3"/>`);
  }
  // Secondary first, so the primary's line and points sit on top.
  for (const which of slots[0].entries.map((_, index) => index).reverse()) {
    const colour = STATISTICS_SERIES[which].line;
    // The line breaks across a column without this player's fantasy points.
    let run = [];
    const flush = () => {
      if (run.length > 1) parts.push(`<polyline points="${run.join(" ")}" fill="none" stroke="${colour}" stroke-width="2"/>`);
      run = [];
    };
    slots.forEach((slot, index) => {
      const entry = slot.entries[which];
      if (entry?.points == null) flush();
      else run.push(`${x(index).toFixed(1)},${y(entry.points).toFixed(1)}`);
    });
    flush();
    slots.forEach((slot, index) => {
      const entry = slot.entries[which];
      if (entry?.points == null) return;
      const centre = x(index).toFixed(1);
      const detail = statisticsMatchDetail(entry, `${names[which]} · ${displayNumber(entry.points)} fantezi puanı`);
      parts.push(`<circle data-timeline-point="${which}" cx="${centre}" cy="${y(entry.points).toFixed(1)}" r="4" fill="${colour}" stroke="var(--surface)" stroke-width="1.5"><title>${detail}</title></circle>`);
      if (columns.showValues) parts.push(`<text x="${centre}" y="${(y(entry.points) - 8).toFixed(1)}" text-anchor="middle" font-size="10" fill="var(--muted)">${displayNumber(entry.points)}</text>`);
    });
  }
  statisticsMatchLabels(parts, slots, columns, frame);
  statisticsAverageLines(parts, averages, y, frame, displayNumber, "data-timeline-average");
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Maç maç fantezi puanı: ${statisticsEscape(averages.map((entry) => `${names[entry.which]} ortalama ${displayNumber(entry.value)}`).join(", "))}">${parts.join("")}</svg>`;
}

function renderStatisticsTimeline(profiles, slots) {
  if (fantasyState.season !== state.seasonSlug) {
    $("statistics-timeline-chart").replaceChildren();
    $("statistics-timeline-note").textContent = "Fantezi analizi yüklenmedi. Sayfayı yenileyin.";
    return;
  }
  const summaries = profiles.map((player, which) => {
    const scored = slots.map((slot) => slot.entries[which]).filter((entry) => entry?.points != null);
    const total = scored.reduce((sum, entry) => sum + entry.points, 0);
    return { player, which, count: scored.length, total, average: scored.length ? total / scored.length : null };
  });
  const averages = summaries.filter((entry) => entry.count).map((entry) => ({ which: entry.which, value: entry.average }));
  if (!averages.length) {
    $("statistics-timeline-chart").replaceChildren();
    $("statistics-timeline-note").textContent = profiles.length > 1
      ? "Bu oyuncular için kayıtlı fantezi puanı yok." : "Bu oyuncu için kayıtlı fantezi puanı yok.";
    return;
  }
  $("statistics-timeline-chart").innerHTML = statisticsTimelineSvg(slots, averages, profiles.map((player) => player.name));
  const line = (entry) => (entry.count
    ? `${entry.count} maç · toplam ${displayNumber(entry.total)} fantezi puanı · maç başına ${displayNumber(entry.average)}`
    : "kayıtlı fantezi puanı yok");
  $("statistics-timeline-note").textContent = profiles.length > 1
    ? `${summaries.map((entry) => `${entry.player.name}: ${line(entry)}`).join(" · ")}.`
    : `${line(summaries[0])}.`;
}

// ---------------------------------------------------------------- match ratings
// One vertical bar per rated match, in the same columns as the timeline above;
// compared, the two players' bars stand side by side in each round. Bars start
// at zero on the provider's 0-10 scale, so their heights compare honestly. A
// dashed line is each player's own average - the same unweighted mean of valid
// match ratings as "Reyting" in the season totals and the tier list - and his
// matches below it are drawn paler.

function statisticsRatingsSvg(slots, averages, names) {
  const count = slots[0].entries.length, frame = statisticsFrame(count);
  const { width, height, left, right, top, bottom } = frame;
  const columns = statisticsMatchColumns(slots, frame), x = columns.x;
  // Side by side with a 2px gap; a lone player keeps the wide bar.
  const bar = count > 1 ? Math.min(columns.slot * 0.36, 22) : Math.min(columns.slot * 0.7, 46);
  const offset = (which) => (count > 1 ? (which ? 1 : -1) * (bar / 2 + 1) : 0);
  const y = (value) => height - bottom - (value / 10) * (height - top - bottom);
  const mean = new Map(averages.map((entry) => [entry.which, entry.value]));
  const parts = [];
  for (const tick of [0, 2, 4, 6, 8, 10]) {
    parts.push(`<line x1="${left}" y1="${y(tick).toFixed(1)}" x2="${width - right}" y2="${y(tick).toFixed(1)}" stroke="var(--line)" stroke-width="1"/>`);
    parts.push(`<text x="${left - 6}" y="${(y(tick) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--muted)">${tick}</text>`);
  }
  // Values sit on the bars only while there is room and one player is shown;
  // otherwise they are in each bar's tooltip.
  slots.forEach((slot, index) => {
    slot.entries.forEach((entry, which) => {
      if (entry?.rating == null) return;
      const centre = x(index) + offset(which), below = entry.rating < mean.get(which);
      const detail = statisticsMatchDetail(entry, `${names[which]} · ${entry.minutes === null ? "—" : displayNumber(entry.minutes)} dk · Reyting ${ratingText(entry.rating)}`);
      parts.push(`<rect data-rating-bar="${index}" data-rating-player="${which}" x="${(centre - bar / 2).toFixed(1)}" y="${y(entry.rating).toFixed(1)}" width="${bar.toFixed(1)}" height="${(y(0) - y(entry.rating)).toFixed(1)}" rx="2" fill="${STATISTICS_SERIES[which].line}" fill-opacity="${below ? 0.4 : 0.9}"><title>${detail}</title></rect>`);
      if (columns.showValues) parts.push(`<text x="${centre.toFixed(1)}" y="${(y(entry.rating) - 5).toFixed(1)}" text-anchor="middle" font-size="10" fill="var(--muted)">${ratingText(entry.rating)}</text>`);
    });
  });
  statisticsMatchLabels(parts, slots, columns, frame);
  statisticsAverageLines(parts, averages, y, frame, ratingText, "data-rating-average");
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Maç maç reyting: ${statisticsEscape(averages.map((entry) => `${names[entry.which]} ortalama ${ratingText(entry.value)}`).join(", "))}">${parts.join("")}</svg>`;
}

function renderStatisticsRatings(profiles, slots) {
  const summaries = profiles.map((player, which) => {
    const ratings = slots.map((slot) => slot.entries[which]?.rating).filter((value) => value != null);
    return { player, which, ratings, average: ratings.length ? ratings.reduce((sum, value) => sum + value, 0) / ratings.length : null,
      unrated: player.matches.length - ratings.length };
  });
  const averages = summaries.filter((entry) => entry.ratings.length).map((entry) => ({ which: entry.which, value: entry.average }));
  if (!averages.length) {
    $("statistics-ratings-chart").replaceChildren();
    $("statistics-ratings-note").textContent = profiles.length > 1
      ? "Bu oyuncular için geçerli reyting yok." : "Bu oyuncu için geçerli reyting yok.";
    return;
  }
  $("statistics-ratings-chart").innerHTML = statisticsRatingsSvg(slots, averages, profiles.map((player) => player.name));
  const line = (entry, weighting = "") => (entry.ratings.length
    ? `${entry.ratings.length} reytingli maç · ortalama ${ratingText(entry.average)}${weighting}`
      + ` · en yüksek ${ratingText(Math.max(...entry.ratings))} · en düşük ${ratingText(Math.min(...entry.ratings))}`
    : "geçerli reyting yok");
  if (profiles.length > 1) {
    $("statistics-ratings-note").textContent = `${summaries.map((entry) => `${entry.player.name}: ${line(entry)}`).join(" · ")}. `
      + "Ortalamalar dakikaya göre ağırlıksızdır; kesikli çizgiler oyuncuların ortalamasıdır, altındaki maçlar soluk gösterilir.";
    return;
  }
  const [only] = summaries;
  $("statistics-ratings-note").textContent = `${line(only, " (dakikaya göre ağırlıksız)")}. `
    + "Kesikli çizgi oyuncunun ortalamasıdır; altındaki maçlar soluk gösterilir."
    + (only.unrated > 0 ? ` ${only.unrated} maçta Sportmonks reyting vermedi.` : "");
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
    renderStatisticsLegends([]);
    return;
  }
  statisticsState.selected = selected.id;
  // A secondary who has left the list (filters never do this; a refresh can)
  // ends the comparison rather than pointing at nobody.
  const secondary = statisticsState.compare && statisticsState.compare !== selected.id
    ? players.find((player) => player.id === statisticsState.compare) || null : null;
  if (!secondary) statisticsState.compare = null;
  const profiles = secondary ? [selected, secondary] : [selected];
  renderStatisticsHeader(profiles);
  renderStatisticsLegends(profiles);
  $("statistics-open-history").onclick = () => openTierPlayer(selected.id);
  // The spider plots are separate assets in src/web/lib. A server started
  // before they moved there answers 404 for them; the rest of the page still
  // renders and says what to do.
  let radar = null;
  if (typeof renderStatisticsRadars === "function") radar = renderStatisticsRadars(selected, players, secondary);
  else {
    for (const id of ["statistics-radar-chart", "statistics-detailed-chart", "statistics-radar-details",
      "statistics-detailed-details"]) $(id).replaceChildren();
    for (const id of ["statistics-radar-note", "statistics-detailed-note"]) {
      $(id).textContent = "Radar dosyaları yüklenemedi; src/web/serve.py'yi yeniden başlatıp sayfayı yenileyin.";
      $(id).hidden = false;
    }
  }
  renderStatisticsFacts(profiles);
  const slots = statisticsMatchSlots(profiles);
  renderStatisticsTimeline(profiles, slots);
  renderStatisticsRatings(profiles, slots);
  // The distribution chart reuses the wheel's reference and scores; the
  // secondary is a second marker on the primary's curves.
  if (typeof renderPlayerDistribution === "function") renderPlayerDistribution(radar, selected);
}
