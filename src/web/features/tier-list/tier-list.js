"use strict";

// Display bands belong to this site; underlying match ratings belong to Sportmonks.
const tierBands = [
  { id: "S", label: t("Üstün"), range: t("8,00–10,00"), minimum: 8 },
  { id: "A", label: t("Mükemmel"), range: t("7,50–7,99"), minimum: 7.5 },
  { id: "B", label: t("Güçlü"), range: t("7,00–7,49"), minimum: 7 },
  { id: "C", label: t("İstikrarlı"), range: t("6,50–6,99"), minimum: 6.5 },
  { id: "D", label: t("6,50 Altı"), range: t("1,00–6,49"), minimum: 1 },
  { id: "P", label: t("Ön Değerlendirme"), range: t("Daha fazla reytingli maç gerekli") },
  { id: "U", label: t("Reytingsiz"), range: t("Geçerli reyting yok") },
];
let selectedTierPlayer = null;
let selectedTierRole = "";
let tierPage = 0;
let tierPageSize = 30;
const tierMinimumRatedMatches = 3;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// A season total over the player's appearances. Counts follow the site's one
// blank rule (countedValue in core/match-rules.js): a blank on a covered match
// is none. xG is a measurement, not a count, so a blank xG stays unknown; the
// dedicated feed is preferred per match and the two are never added together.
function totalMetric(rows, key) {
  const values = rows.map((row) => key === "xg" ? number(row.xg_expected_goals) ?? number(row.expected_goals) : countedValue(row, key)).filter((value) => value !== null);
  return { value: values.length ? values.reduce((a, b) => a + b, 0) : null, supplied: values.length, records: rows.length };
}

function metricText(metric) {
  const value = number(metric.value);
  return (value === null ? "—" : new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 }).format(value)) + (metric.supplied > 0 && metric.supplied < metric.records ? "*" : "");
}

function metricTitle(metric) {
  return t("{records} maçın {supplied} tanesinde kayıtlı. İstatistiği kaydedilmemiş maçlar sıfır sayılmaz.", { records: metric.records, supplied: metric.supplied });
}

function ratingText(value) {
  return value === null ? "—" : value.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function createTeamLink(id, name, className = "") {
  const link = element(/^\d+$/.test(String(id || "")) ? "a" : "span", `team-link ${className}`, name);
  if (link.tagName === "A") {
    link.href = `team.html?${new URLSearchParams({ id, name })}`;
    link.setAttribute("aria-label", t("{name} takım sayfasını aç", { name }));
  }
  return link;
}

function createTeamLogo(id, teams, clickable = true) {
    const name = teamName(id, teams);
    const badge = element("span", "club-logo");
    badge.title = name;
    const initials = teams.get(id)?.short_code || name.split(/\s+/).map((part) => part[0]).join("").slice(0, 3);
    const fallback = element("span", "club-logo-fallback", initials);
    fallback.setAttribute("role", "img");
    fallback.setAttribute("aria-label", t("{name} (logo bulunamadı)", { name }));
    const img = document.createElement("img");
    img.alt = `${name} logo`;
    img.width = 32;
    img.height = 32;
    img.loading = "lazy";
    img.decoding = "async";
    img.addEventListener("load", () => { img.classList.add("loaded"); fallback.hidden = true; });
    img.addEventListener("error", () => img.remove());
    img.src = `assets/team-logos/${encodeURIComponent(id)}.svg`;
    badge.append(fallback, img);
    if (!clickable) return badge;
    const link = createTeamLink(id, name, "team-logo-link");
    link.replaceChildren(badge);
    return link;
}

function teamLogoCell(player, teams) {
  const cell = element("td", "club-logo-cell");
  const logos = element("div", "club-logos");
  for (const id of player.teams) logos.append(createTeamLogo(id, teams));
  if (!player.teams.size) logos.append(element("span", "", "—"));
  cell.append(logos);
  return cell;
}

function tierFor(player) {
  if (player.average === null) return "U";
  if (player.ratings.length < tierMinimumRatedMatches) return "P";
  return tierBands.find((band) => band.minimum !== undefined && player.average >= band.minimum).id;
}

// One role per player, used by every list, filter and profile. The radar's
// rule: the match position he has played the most minutes in this season,
// else his registered squad position. Sportmonks registers Salah as a
// midfielder, but he plays - and is compared on the radar - as an attacker.
// Kadro Kur alone uses the TFF game's own position, because that is what the
// game's squad rules count.
function playerPrimaryRole(player) {
  const minutes = new Map();
  for (const row of player.matches) {
    const role = positionRole(row.position), played = number(row.minutes_played) ?? 0;
    if (role && played > 0) minutes.set(role, (minutes.get(role) || 0) + played);
  }
  return [...minutes].sort((a, b) => b[1] - a[1])[0]?.[0]
    || positionRole(player.squadPosition)
    || [...player.positions].map(positionRole).find(Boolean) || "";
}

function updateTierRoleButtons() {
  document.querySelectorAll("[data-tier-role]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.tierRole === selectedTierRole));
  });
}

function setTierSearchOpen(open, focus = false) {
  const control = $("tier-search-control");
  const search = $("tier-search");
  control.classList.toggle("is-open", open);
  $("tier-search-toggle").setAttribute("aria-expanded", String(open));
  $("tier-search-close").hidden = !open;
  search.tabIndex = open ? 0 : -1;
  if (open && focus) requestAnimationFrame(() => search.focus());
}

function tierPageItems(pageCount) {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index);
  const shown = [...new Set([0, 1, tierPage - 1, tierPage, tierPage + 1, pageCount - 2, pageCount - 1])]
    .filter((page) => page >= 0 && page < pageCount)
    .sort((a, b) => a - b);
  const items = [];
  shown.forEach((page, index) => {
    if (index && page - shown[index - 1] > 1) items.push("ellipsis");
    items.push(page);
  });
  return items;
}

function goToTierPage(page) {
  tierPage = page;
  renderTierList();
  $("tier-board").scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

function renderTierPagination(total, pageCount) {
  const first = total ? tierPage * tierPageSize + 1 : 0;
  const last = Math.min(total, (tierPage + 1) * tierPageSize);
  $("tier-page-range").textContent = total ? t("{total} oyuncunun {first}–{last} arası gösteriliyor", { total, first, last }) : t("0 oyuncu gösteriliyor");
  $("tier-page-previous").disabled = tierPage === 0;
  $("tier-page-next").disabled = tierPage + 1 >= pageCount;
  const buttons = document.createDocumentFragment();
  tierPageItems(pageCount).forEach((item) => {
    if (item === "ellipsis") {
      const ellipsis = element("span", "tier-page-ellipsis", "…");
      ellipsis.setAttribute("aria-hidden", "true");
      buttons.append(ellipsis);
      return;
    }
    const button = element("button", "tier-page-number", String(item + 1));
    button.type = "button";
    button.setAttribute("aria-label", t("Oyuncu listesinin {page}. sayfasına git", { page: item + 1 }));
    if (item === tierPage) button.setAttribute("aria-current", "page");
    button.addEventListener("click", () => goToTierPage(item));
    buttons.append(button);
  });
  $("tier-page-buttons").replaceChildren(buttons);
}

function buildTierPlayers() {
  if (state.tierCache) return state.tierCache;
  const teams = new Map((state.tables["teams.csv"] || []).map((row) => [row.id, row]));
  const profiles = new Map((state.tables["players.csv"] || []).map((row) => [row.id, row]));
  const fixtures = new Map((state.tables["fixtures.csv"] || []).map((row) => [row.fixture_id, row]));
  const players = new Map();
  const ensure = (id, name) => {
    if (!id) return null;
    // One name per player, from his profile (profileName in core/match-rules.js).
    if (!players.has(id)) players.set(id, { id, name: profileName(profiles.get(id)) || name?.trim() || t("Oyuncu {id}", { id }), teams: new Set(), positions: new Set(), matches: [] });
    const player = players.get(id);
    if (name?.trim() && player.name === t("Oyuncu {id}", { id })) player.name = name.trim();
    return player;
  };
  for (const profile of profiles.values()) ensure(profile.id, profile.name);
  for (const row of state.tables["squads.csv"] || []) {
    const player = ensure(row.player_id);
    if (!player) continue;
    if (row.team_id) player.teams.add(row.team_id);
    if (row.team_id) player.squadTeam = row.team_id;
    if (row.jersey_number) player.jersey = row.jersey_number;
    if (row["position.name"]) {
      player.positions.add(row["position.name"]);
      player.squadPosition = row["position.name"];
    }
  }
  // A match is an appearance only in a finished fixture and only if he played:
  // lineups arrive before kickoff and list unused substitutes, and neither is
  // a match he played (core/match-rules.js; the fantasy ledger's rule too).
  for (const row of state.tables["player_match_stats.csv"] || []) {
    const player = ensure(row.player_id, row.name);
    if (!player) continue;
    if (row.team_id) player.teams.add(row.team_id);
    if (row.position) player.positions.add(row.position);
    if (fixtureFinished(fixtures.get(row.fixture_id)) && playerAppeared(row)) player.matches.push(row);
  }
  for (const player of players.values()) {
    player.teamNames = [...player.teams].map((id) => teamName(id, teams));
    player.matches.sort((a, b) => String(fixtures.get(b.fixture_id)?.kickoff || "").localeCompare(String(fixtures.get(a.fixture_id)?.kickoff || "")) || String(b.fixture_id).localeCompare(String(a.fixture_id), undefined, { numeric: true }));
    // His club now: the one he last played for, else his squad registration.
    player.club = player.matches[0]?.team_id || player.squadTeam || [...player.teams][0] || null;
    player.clubName = player.club ? teamName(player.club, teams) : "";
    player.ratings = player.matches.map(validMatchRating).filter((value) => value !== null);
    player.average = player.ratings.length ? player.ratings.reduce((a, b) => a + b, 0) / player.ratings.length : null;
    player.totals = Object.fromEntries(["minutes_played", "goals", "assists", "xg", "shots_total", "key_passes", "saves"].map((key) => [key, totalMetric(player.matches, key)]));
  }
  state.tierCache = { players: [...players.values()], teams, fixtures, byId: players };
  return state.tierCache;
}

// The one name a player is shown by on this page, whatever row or file
// mentions him: match rows, the fantasy ledger, projections, the optimizer and
// the live feed each carry their own copy, and those differ.
function playerName(id, fallback = "") {
  return buildTierPlayers().byId.get(String(id ?? ""))?.name || String(fallback || "").trim() || (id ? t("Oyuncu {id}", { id }) : "—");
}

// Players still in the league, from Sportmonks' current domestic squads. The
// season squad also keeps players who left after appearing (Talisca, for one);
// they are dropped from every player list, leader card and the builder, and
// stay only in past match records. Null means the export predates current
// squads or misses a club, and then nobody is filtered out.
let currentSquad = null;
let leaguePlayersCache = { source: null, current: null, result: null };

async function loadCurrentSquads() {
  currentSquad = null;
  if (!state.seasonSlug) return;
  try {
    const rows = await readFantasyCSV("current_squads.csv", ["team_id", "player_id"], state.seasonSlug, true);
    const clubs = new Set((rows || []).map((row) => row.team_id));
    const covered = rows && (state.tables["teams.csv"] || []).every((team) => clubs.has(team.id));
    currentSquad = covered ? new Set(rows.map((row) => row.player_id)) : null;
  } catch {
    currentSquad = null;
  }
}

function leaguePlayers() {
  const source = buildTierPlayers();
  if (leaguePlayersCache.source !== source || leaguePlayersCache.current !== currentSquad) {
    leaguePlayersCache = { source, current: currentSquad, result: currentSquad
      ? { ...source, players: source.players.filter((player) => currentSquad.has(player.id)) }
      : source };
  }
  return leaguePlayersCache.result;
}

function resetTierFilters() {
  $("tier-search").value = "";
  $("tier-team").value = "";
  selectedTierRole = "";
  tierPage = 0;
  tierPageSize = 30;
  $("tier-page-size").value = "30";
  updateTierRoleButtons();
  setTierSearchOpen(false);
  selectedTierPlayer = null;
  if ($("player-dialog").open) $("player-dialog").close();
}

function renderTierList() {
  const { players, teams } = leaguePlayers();
  const teamIds = [...new Set(players.flatMap((player) => [...player.teams]))];
  options($("tier-team"), teamIds.map((id) => [id, teamName(id, teams)]).sort((a, b) => a[1].localeCompare(b[1])), t("Tüm takımlar"));
  const query = $("tier-search").value.toLocaleLowerCase().trim();
  const byRating = (a, b) => (b.average ?? -1) - (a.average ?? -1) || b.ratings.length - a.ratings.length || a.name.localeCompare(b.name);
  const eligible = players.filter((player) => !["P", "U"].includes(tierFor(player))).sort(byRating);
  const ranks = new Map();
  let rank = 0;
  eligible.forEach((player, index) => {
    if (index === 0 || player.average !== eligible[index - 1].average) rank = index + 1;
    ranks.set(player.id, rank);
  });
  const ordered = [...eligible, ...players.filter((player) => !ranks.has(player.id)).sort(byRating)];
  const filtered = ordered.filter((player) => (!$("tier-team").value || player.teams.has($("tier-team").value))
    && (!selectedTierRole || playerPrimaryRole(player) === selectedTierRole)
    && (!query || `${player.name} ${player.teamNames.join(" ")}`.toLocaleLowerCase().includes(query)));
  const pageCount = Math.max(1, Math.ceil(filtered.length / tierPageSize));
  tierPage = Math.max(0, Math.min(tierPage, pageCount - 1));
  const visiblePlayers = filtered.slice(tierPage * tierPageSize, (tierPage + 1) * tierPageSize);
  const scroller = element("div", "table-container tier-ranking-scroll");
  scroller.tabIndex = 0;
  scroller.setAttribute("aria-label", t("Oyuncu sıralaması. Diğer istatistikler için yatay kaydırın."));
  const table = element("table", "tier-ranking-table");
  const caption = element("caption", "sr-only", t("Ortalama Sportmonks reytingine göre sezon oyuncu sıralaması. Tüm maç istatistikleri için oyuncu adına tıklayın."));
  const head = element("thead"), header = element("tr");
  const columns = [t("Sıra"), "Logo", t("Mevki"), t("Oyuncu"), t("Kademe"), t("Ort. Reyting"), t("Reytingli Maç"), t({ tr: "Maç", en: "Matches" }), t("Dakika"), t("Gol"), t("Asist"), "xG", t("Şut"), t("Kilit Pas"), t("Kurtarış")];
  columns.forEach((label, index) => {
    const th = element("th", index === 0 || index >= 5 ? "numeric" : index === 1 ? "club-logo-heading" : "", label);
    th.scope = "col";
    if (index === 0) th.setAttribute("aria-sort", "ascending");
    header.append(th);
  });
  head.append(header);
  const body = element("tbody");
  visiblePlayers.forEach((player, rowIndex) => {
    const tier = tierFor(player);
    const tr = element("tr", `tier-${tier.toLowerCase()} ${rowIndex % 2 ? "zebra-light" : "zebra-purple"}`);
    tr.append(element("td", "numeric rank-cell", ranks.has(player.id) ? String(ranks.get(player.id)) : "—"));
    tr.append(teamLogoCell(player, teams));
    tr.append(element("td", "role-cell", roleLabel(playerPrimaryRole(player))));
    const playerCell = element("td", "player-cell");
    const name = element("button", "player-name-button", player.name);
    name.type = "button";
    name.setAttribute("aria-label", t("{name} için tüm maç ve istatistikleri göster", { name: player.name }));
    name.addEventListener("click", () => openTierPlayer(player.id));
    playerCell.append(name);
    const tierCell = element("td");
    const badge = element("span", "tier-tag", tier === "P" ? t("Ön Değerlendirme") : tier === "U" ? t("Reytingsiz") : tier);
    badge.title = tierBands.find((band) => band.id === tier).label;
    tierCell.append(badge);
    const ratingCell = element("td", "numeric");
    ratingCell.append(element("span", "rating-pill", ratingText(player.average)));
    tr.append(playerCell, tierCell, ratingCell, element("td", "numeric", String(player.ratings.length)), element("td", "numeric", String(player.matches.length)));
    for (const key of ["minutes_played", "goals", "assists", "xg", "shots_total", "key_passes", "saves"]) {
      const metric = element("td", "numeric", metricText(player.totals[key]));
      metric.title = metricTitle(player.totals[key]);
      tr.append(metric);
    }
    body.append(tr);
  });
  if (!filtered.length) {
    const tr = element("tr"), td = element("td", "no-results", players.length ? t("Bu filtrelerle eşleşen oyuncu yok.") : t("Oyuncuları eklemek için player_match_stats.csv, players.csv veya squads.csv dosyasını açın."));
    td.colSpan = columns.length;
    tr.append(td); body.append(tr);
  }
  table.append(caption, head, body);
  scroller.append(table);
  $("tier-board").replaceChildren(scroller);
  renderTierPagination(filtered.length, pageCount);
}

function openTierPlayer(id) {
  const player = buildTierPlayers().players.find((item) => item.id === id);
  if (!player) return;
  selectedTierPlayer = id;
  $("all-match-stats").checked = false;
  $("player-detail-name").textContent = player.name;
  const meta = $("player-detail-meta");
  meta.replaceChildren();
  [...player.teams].forEach((teamId, index) => {
    if (index) meta.append(" / ");
    meta.append(createTeamLink(teamId, player.teamNames[index]));
  });
  if (!player.teams.size) meta.append(t("Takım bilgisi yok"));
  meta.append(` · ${playerPrimaryRole(player) ? roleLabel(playerPrimaryRole(player)) : t("Mevki bilgisi yok")} · ${t("Oyuncu ID: {id}", { id: player.id })}`);
  const summary = document.createDocumentFragment();
  const add = (label, value, title) => {
    const card = element("div");
    card.append(element("span", "", label), element("strong", "", value));
    if (title) card.title = title;
    summary.append(card);
  };
  add(t("ORT. REYTİNG"), ratingText(player.average), t("Geçerli Sportmonks maç reytinglerinin aritmetik ortalaması. Dakikaya göre ağırlıklandırılmaz."));
  add(t("REYTİNGLİ / OYNADIĞI MAÇ"), `${player.ratings.length} / ${player.matches.length}`);
  for (const [key, label] of [["minutes_played", t("DAKİKA")], ["goals", t("GOL")], ["assists", t("ASİST")], ["xg", "xG"], ["shots_total", t("ŞUT")], ["key_passes", t("KİLİT PAS")]]) add(label, metricText(player.totals[key]), metricTitle(player.totals[key]));
  $("player-detail-summary").replaceChildren(summary);
  $("player-detail-coverage").textContent = `${t("{count} maç", { count: player.matches.length }, player.matches.length)} · ${t("{count} geçerli reyting", { count: player.ratings.length }, player.ratings.length)} · ${tierBands.find((band) => band.id === tierFor(player)).label}. ${t("Yalnızca sahaya çıktığı bitmiş maçlar sayılır. * işaretli toplamlarda istatistiği kaydedilmemiş maç var; veri kapsamı için toplamın üzerinde bekleyin. Kaydedilmemiş maçlar sıfırla doldurulmaz.")}`;
  renderPlayerHistory();
  $("player-dialog").showModal();
}

function prettyField(key) {
  const names = { xg_expected_goals: t("xG · özel kaynak"), expected_goals: t("xG · standart kaynak"), xg_expected_goals_on_target: t("İsabetli xG · özel kaynak"), expected_goals_on_target: t("İsabetli xG · standart kaynak"), rating: t("Reyting"), minutes_played: t("Dakika"), started: t("İlk 11 (1/0)"), goals: t("Gol"), assists: t("Asist"), shots_total: t("Şut"), shots_on_target: t("İsabetli şut"), key_passes: t("Kilit pas"), chances_created: t("Yaratılan fırsat"), tackles: t("Müdahale"), interceptions: t("Top kesme"), saves: t("Kurtarış"), yellowcards: t("Sarı kart"), redcards: t("Kırmızı kart") };
  return names[key] || key.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

const HISTORY_COUNT_FIELDS = new Set(["goals", "assists", "shots_total", "shots_on_target", "key_passes", "chances_created",
  "tackles", "interceptions", "saves", "yellowcards", "redcards"]);

function renderPlayerHistory() {
  const { players, fixtures, teams } = buildTierPlayers();
  const player = players.find((item) => item.id === selectedTierPlayer);
  if (!player) return;
  const allFields = [...new Set(player.matches.flatMap((row) => Object.keys(row)))];
  const core = ["rating", "minutes_played", "started", "goals", "assists", "xg_expected_goals", "expected_goals", "shots_total", "shots_on_target", "key_passes", "chances_created", "tackles", "interceptions", "saves", "yellowcards", "redcards"];
  const fields = $("all-match-stats").checked ? [...core.filter((key) => allFields.includes(key)), ...allFields.filter((key) => !core.includes(key))] : core.filter((key) => allFields.includes(key));
  const heading = element("tr");
  for (const label of [t("Tarih"), t("Maç"), t("Takım"), t("Hafta"), t("Durum"), ...fields.map(prettyField)]) {
    const th = element("th", "", label); th.scope = "col"; heading.append(th);
  }
  $("history-head").replaceChildren(heading);
  const body = document.createDocumentFragment();
  for (const row of player.matches) {
    const fixture = fixtures.get(row.fixture_id);
    const match = fixture?.name || (fixture ? `${teamName(fixture.home_team_id, teams)} - ${teamName(fixture.away_team_id, teams)}` : t("Fikstür {id}", { id: row.fixture_id }));
    const tr = element("tr");
    for (const value of [fixture ? kickoffText(fixture) : "", match, teamName(row.team_id, teams), fixture?.["round.name"], fixture ? fixtureStateLabel(fixture) : ""]) tr.append(element("td", "", value || "—"));
    tr.children[2].replaceChildren(createTeamLink(row.team_id, teamName(row.team_id, teams)));
    for (const key of fields) {
      const value = row[key];
      // The match counts the totals add up, with the totals' blank rule: none
      // on a covered match. Every other field is shown as sent, numbers in
      // the page's format.
      const count = HISTORY_COUNT_FIELDS.has(key) ? countedValue(row, key) : number(value);
      const shown = key === "rating" && number(value) !== null ? ratingText(number(value))
        : count !== null ? displayNumber(count) : value === undefined || value === "" ? "—" : value;
      const td = element("td", count !== null ? "numeric" : "", shown);
      if (key === "rating" && value && validMatchRating(row) === null) td.title = t("Sağlayıcı değeri geldiği biçimde gösterilir; 1–10 aralığı dışında olduğu veya kayıt açıkça sıfır dakika gösterdiği için ortalamaya alınmaz.");
      tr.append(td);
    }
    body.append(tr);
  }
  if (!player.matches.length) {
    const tr = element("tr"), td = element("td", "no-results", t("Bu oyuncu bu sezon henüz sahaya çıkmadı. Oyuncu, uydurma bir reyting verilmeden kadroda gösterilir."));
    td.colSpan = fields.length + 5; tr.append(td); body.append(tr);
  }
  $("history-body").replaceChildren(body);
}

function setupTierList() {
  $("tier-search").addEventListener("input", () => { tierPage = 0; renderTierList(); });
  $("tier-team").addEventListener("change", () => { tierPage = 0; renderTierList(); });
  document.querySelectorAll("[data-tier-role]").forEach((button) => button.addEventListener("click", () => {
    selectedTierRole = button.dataset.tierRole;
    tierPage = 0;
    updateTierRoleButtons();
    renderTierList();
  }));
  $("tier-page-size").addEventListener("change", (event) => {
    tierPageSize = Number(event.target.value) || 30;
    tierPage = 0;
    renderTierList();
  });
  $("tier-page-previous").addEventListener("click", () => goToTierPage(tierPage - 1));
  $("tier-page-next").addEventListener("click", () => goToTierPage(tierPage + 1));
  $("tier-search-toggle").addEventListener("click", () => setTierSearchOpen(true, true));
  $("tier-search-close").addEventListener("click", () => {
    $("tier-search").value = "";
    tierPage = 0;
    setTierSearchOpen(false);
    renderTierList();
    $("tier-search-toggle").focus();
  });
  $("tier-search").addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    $("tier-search").value = "";
    tierPage = 0;
    setTierSearchOpen(false);
    renderTierList();
    $("tier-search-toggle").focus();
  });
  $("close-player").addEventListener("click", () => $("player-dialog").close());
  $("player-dialog").addEventListener("close", () => { selectedTierPlayer = null; });
  $("all-match-stats").addEventListener("change", renderPlayerHistory);
}
