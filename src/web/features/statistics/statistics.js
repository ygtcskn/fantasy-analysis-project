"use strict";

// The İstatistikler page: leader cards, the player list, season totals and the
// fantasy-points timeline. Both spider plots are built in src/web/lib.

// Season leaders and a searchable player list, built from the same aggregation
// the tier list uses so a player's totals never disagree between two pages.

const statisticsState = { search: "", team: "", sort: "goals", limit: 10, selected: null };

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
    identity.append(element("span", "statistics-club-name", entry.player.teamNames[0] || "—"));
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
  const visible = players
    .filter((player) => (!team || player.teams.has(team))
      && (!query || `${player.name} ${player.teamNames.join(" ")}`.toLocaleLowerCase("tr").includes(query)))
    .sort((a, b) => (accessor(b) ?? -Infinity) - (accessor(a) ?? -Infinity)
      || a.name.localeCompare(b.name, "tr"));
  $("statistics-list-count").textContent = `${visible.length} oyuncu`;
  const body = document.createDocumentFragment();
  for (const player of visible.slice(0, 200)) {
    const row = element("tr");
    const identity = element("td");
    const club = element("div", "statistics-club");
    club.append(createTeamLogo([...player.teams][0] || "unknown", teams, false));
    const open = element("button", "statistics-player-button", player.name);
    open.type = "button";
    open.setAttribute("aria-label", `${player.name} profilini göster`);
    open.addEventListener("click", () => {
      statisticsState.selected = player.id;
      renderStatistics();
    });
    club.append(open);
    identity.append(club);
    if (player.id === statisticsState.selected) row.classList.add("statistics-row-selected");
    row.append(identity);
    row.append(element("td", "numeric", displayNumber(player.totals.minutes_played.value)));
    row.append(element("td", "numeric", displayNumber(player.totals.goals.value)));
    row.append(element("td", "numeric", displayNumber(player.totals.assists.value)));
    row.append(element("td", "numeric", ratingText(player.average)));
    body.append(row);
  }
  if (!visible.length) {
    const row = element("tr"), cell = element("td", "no-results", "Bu filtrelerle oyuncu bulunamadı.");
    cell.colSpan = 5;
    row.append(cell);
    body.append(row);
  }
  $("statistics-list-note").textContent = visible.length > 200
    ? `İlk 200 satır gösteriliyor. Aramayı daraltın.`
    : "";
  $("statistics-list-body").replaceChildren(body);
}

function renderStatistics() {
  const { players, teams } = buildTierPlayers();
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
      : "Fantezi analizi yüklenmedi. Kaydedilen veriyi yenileyin.");
  renderStatisticsList(players, teams);
  renderStatisticsProfile(players);
}

function setupStatistics() {
  $("statistics-search").addEventListener("input", renderStatistics);
  $("statistics-team").addEventListener("change", renderStatistics);
  $("statistics-sort").addEventListener("change", renderStatistics);
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

function statisticsTimelineSvg(rows) {
  const width = 640, height = 220, left = 40, right = 16, top = 18, bottom = 32;
  const values = rows.map((row) => row.points);
  const high = Math.max(4, ...values), low = Math.min(0, ...values);
  const x = (index) => left + (rows.length === 1 ? (width - left - right) / 2
    : (index / (rows.length - 1)) * (width - left - right));
  const y = (value) => height - bottom - ((value - low) / (high - low || 1)) * (height - top - bottom);
  const parts = [];
  for (let step = 0; step <= 4; step += 1) {
    const value = low + ((high - low) * step) / 4;
    parts.push(`<line x1="${left}" y1="${y(value).toFixed(1)}" x2="${width - right}" y2="${y(value).toFixed(1)}" stroke="var(--line)" stroke-width="1"/>`);
    parts.push(`<text x="${left - 6}" y="${(y(value) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--muted)">${Math.round(value)}</text>`);
  }
  if (low < 0) {
    parts.push(`<line x1="${left}" y1="${y(0).toFixed(1)}" x2="${width - right}" y2="${y(0).toFixed(1)}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3"/>`);
  }
  if (rows.length > 1) {
    const path = rows.map((row, index) => `${x(index).toFixed(1)},${y(row.points).toFixed(1)}`).join(" ");
    parts.push(`<polyline points="${path}" fill="none" stroke="var(--statistics-plot-line)" stroke-width="2"/>`);
  }
  rows.forEach((row, index) => {
    parts.push(`<circle cx="${x(index).toFixed(1)}" cy="${y(row.points).toFixed(1)}" r="3.5" fill="var(--statistics-plot-line)"><title>${row.label}: ${row.points}</title></circle>`);
  });
  // Only a handful of date labels, so they never collide over a full season.
  const every = Math.max(1, Math.ceil(rows.length / 8));
  rows.forEach((row, index) => {
    if (index % every && index !== rows.length - 1) return;
    parts.push(`<text x="${x(index).toFixed(1)}" y="${height - 10}" text-anchor="middle" font-size="9" fill="var(--muted)">${row.label}</text>`);
  });
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Fantezi puanı zaman grafiği">${parts.join("")}</svg>`;
}

function renderStatisticsTimeline(player) {
  if (fantasyState.season !== state.seasonSlug) {
    $("statistics-timeline-chart").replaceChildren();
    $("statistics-timeline-note").textContent = "Fantezi analizi yüklenmedi. Kaydedilen veriyi yenileyin.";
    return;
  }
  // fantasyState keeps matches newest first; a timeline reads the other way.
  const rows = [...(fantasyState.matches.get(player.id) || [])]
    .sort((a, b) => fantasyTime(a.kickoff_utc) - fantasyTime(b.kickoff_utc))
    .map((row) => ({ points: number(row.points_total) ?? 0, label: fantasyDate(row.kickoff_utc) }));
  if (!rows.length) {
    $("statistics-timeline-chart").replaceChildren();
    $("statistics-timeline-note").textContent = "Bu oyuncu için kayıtlı fantezi puanı yok.";
    return;
  }
  $("statistics-timeline-chart").innerHTML = statisticsTimelineSvg(rows);
  const total = rows.reduce((sum, row) => sum + row.points, 0);
  $("statistics-timeline-note").textContent =
    `${rows.length} maç · toplam ${displayNumber(total)} puan · maç başına ${displayNumber(total / rows.length)}.`;
}

// ---------------------------------------------------------------- match ratings
// One vertical bar per rated match, in kickoff order from left to right like
// the timeline above. Bars start at zero on the provider's 0-10 scale, so their
// heights compare honestly. The dashed line is the player's own average - the
// same unweighted mean of valid match ratings as "Maç puanı" in the season
// totals and the tier list - and matches below it are drawn paler.

const statisticsEscape = (value) => String(value ?? "").replace(/[&<>"']/g,
  (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

function statisticsRatingRows(player, teams) {
  const fixtures = new Map((state.tables["fixtures.csv"] || []).map((fixture) => [fixture.fixture_id, fixture]));
  return player.matches.map((row) => {
    const rating = validMatchRating(row);
    if (rating === null) return null;
    const fixture = fixtures.get(row.fixture_id);
    const home = fixture ? row.team_id === fixture.home_team_id : null;
    const opponent = fixture ? (home ? fixture.away_team_id : fixture.home_team_id) : null;
    const time = fixture ? fantasyKickoff(fixture) : NaN;
    return { rating, time, minutes: number(row.minutes_played), round: fixture?.["round.name"] || "",
      code: (teams.get(opponent)?.short_code || teamName(opponent, teams)) + (home === null ? "" : home ? " (İ)" : " (D)"),
      opponent: teamName(opponent, teams),
      date: Number.isFinite(time) ? fantasyDate(new Date(time).toISOString()) : "" };
  }).filter(Boolean).sort((a, b) => (Number.isFinite(a.time) ? a.time : Infinity) - (Number.isFinite(b.time) ? b.time : Infinity));
}

function statisticsRatingsSvg(rows, average) {
  const width = 640, height = 250, left = 34, right = 62, top = 14, bottom = 40;
  const plot = width - left - right, slot = plot / rows.length;
  const bar = Math.min(slot * 0.7, 46);
  const x = (index) => left + slot * index + slot / 2;
  const y = (value) => height - bottom - (value / 10) * (height - top - bottom);
  const parts = [];
  for (const tick of [0, 2, 4, 6, 8, 10]) {
    parts.push(`<line x1="${left}" y1="${y(tick).toFixed(1)}" x2="${width - right}" y2="${y(tick).toFixed(1)}" stroke="var(--line)" stroke-width="1"/>`);
    parts.push(`<text x="${left - 6}" y="${(y(tick) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--muted)">${tick}</text>`);
  }
  // Values sit on the bars only while there is room for them; a full season
  // keeps them in each bar's tooltip instead. Labels thin out to about twelve,
  // like the timeline's dates, so they never collide.
  const showValues = slot >= 30, every = Math.max(1, Math.ceil(rows.length / 12));
  rows.forEach((entry, index) => {
    const below = entry.rating < average, centre = x(index).toFixed(1);
    // A row can carry its own tooltip; the team page's bars are averages.
    const detail = statisticsEscape(entry.detail ?? (`${entry.round ? `${entry.round}. hafta · ` : ""}${entry.date ? `${entry.date} · ` : ""}`
      + `${entry.opponent} · ${entry.minutes === null ? "—" : displayNumber(entry.minutes)} dk · Sportmonks puanı ${ratingText(entry.rating)}`));
    parts.push(`<rect data-rating-bar="${index}" x="${(x(index) - bar / 2).toFixed(1)}" y="${y(entry.rating).toFixed(1)}" width="${bar.toFixed(1)}" height="${(y(0) - y(entry.rating)).toFixed(1)}" rx="2" fill="var(--statistics-plot-line)" fill-opacity="${below ? 0.4 : 0.9}"><title>${detail}</title></rect>`);
    if (showValues) parts.push(`<text x="${centre}" y="${(y(entry.rating) - 5).toFixed(1)}" text-anchor="middle" font-size="10" fill="var(--muted)">${ratingText(entry.rating)}</text>`);
    if (index % every && index !== rows.length - 1) return;
    if (entry.round) parts.push(`<text x="${centre}" y="${height - bottom + 15}" text-anchor="middle" font-size="10" fill="var(--ink)">${statisticsEscape(`${entry.round}. hf`)}</text>`);
    parts.push(`<text x="${centre}" y="${height - bottom + 28}" text-anchor="middle" font-size="9" fill="var(--muted)">${statisticsEscape(entry.code)}</text>`);
  });
  // The average runs across every bar and is labelled in the right margin,
  // where no bar can cover it.
  const mean = y(average).toFixed(1);
  parts.push(`<line data-rating-average="${average}" x1="${left}" y1="${mean}" x2="${width - right + 4}" y2="${mean}" stroke="var(--ink)" stroke-width="1.5" stroke-dasharray="4 3"/>`);
  parts.push(`<text x="${width - right + 8}" y="${(y(average) + 4).toFixed(1)}" font-size="10" font-weight="600" fill="var(--ink)">Ort. ${ratingText(average)}</text>`);
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Maç maç Sportmonks puanı; ortalama ${ratingText(average)}">${parts.join("")}</svg>`;
}

function renderStatisticsRatings(player) {
  const { teams } = buildTierPlayers();
  const rows = statisticsRatingRows(player, teams);
  if (!rows.length) {
    $("statistics-ratings-chart").replaceChildren();
    $("statistics-ratings-note").textContent = "Bu oyuncu için geçerli Sportmonks maç puanı yok.";
    return;
  }
  const average = rows.reduce((sum, row) => sum + row.rating, 0) / rows.length;
  $("statistics-ratings-chart").innerHTML = statisticsRatingsSvg(rows, average);
  const ratings = rows.map((row) => row.rating), unrated = player.matches.length - rows.length;
  $("statistics-ratings-note").textContent = `${rows.length} puanlı maç · ortalama ${ratingText(average)}`
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
    }
  }
  renderStatisticsFacts(selected);
  renderStatisticsTimeline(selected);
  renderStatisticsRatings(selected);
  // The distribution chart reuses the wheel's reference and scores.
  if (typeof renderPlayerDistribution === "function") renderPlayerDistribution(radar, selected);
}
