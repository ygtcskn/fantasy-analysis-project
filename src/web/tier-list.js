"use strict";

// Display bands belong to this site; underlying match ratings belong to Sportmonks.
const tierBands = [
  { id: "S", label: "Üstün", range: "8,00–10,00", minimum: 8 },
  { id: "A", label: "Mükemmel", range: "7,50–7,99", minimum: 7.5 },
  { id: "B", label: "Güçlü", range: "7,00–7,49", minimum: 7 },
  { id: "C", label: "İstikrarlı", range: "6,50–6,99", minimum: 6.5 },
  { id: "D", label: "6,50 Altı", range: "1,00–6,49", minimum: 1 },
  { id: "P", label: "Ön Değerlendirme", range: "Daha fazla puanlı maç gerekli" },
  { id: "U", label: "Puansız", range: "Geçerli maç puanı yok" },
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

function validMatchRating(row) {
  const value = number(row.rating);
  return value !== null && value >= 1 && value <= 10 && number(row.minutes_played) !== 0 ? value : null;
}

function totalMetric(rows, key) {
  const values = rows.map((row) => key === "xg" ? number(row.xg_expected_goals) ?? number(row.expected_goals) : number(row[key])).filter((value) => value !== null);
  return { value: values.length ? values.reduce((a, b) => a + b, 0) : null, supplied: values.length, records: rows.length };
}

function metricText(metric) {
  const value = number(metric.value);
  return (value === null ? "—" : new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 2 }).format(value)) + (metric.supplied > 0 && metric.supplied < metric.records ? "*" : "");
}

function metricTitle(metric) {
  return `${metric.records} maç kaydının ${metric.supplied} tanesinde sağlandı. Eksik değerler sıfır kabul edilmez.`;
}

function ratingText(value) {
  return value === null ? "—" : value.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function createTeamLink(id, name, className = "") {
  const link = element(/^\d+$/.test(String(id || "")) ? "a" : "span", `team-link ${className}`, name);
  if (link.tagName === "A") {
    link.href = `team.html?${new URLSearchParams({ id, name })}`;
    link.setAttribute("aria-label", document.documentElement.lang === "tr" ? `${name} takım sayfasını aç` : `Open ${name} team page`);
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
    fallback.setAttribute("aria-label", document.documentElement.lang === "tr" ? `${name} (logo bulunamadı)` : `${name} (logo unavailable)`);
    const img = document.createElement("img");
    img.alt = `${name} logo`;
    img.width = 32;
    img.height = 32;
    img.loading = "lazy";
    img.decoding = "async";
    const base = `assets/team-logos/${encodeURIComponent(id)}`;
    let triedPng = false;
    img.addEventListener("load", () => { img.classList.add("loaded"); fallback.hidden = true; });
    img.addEventListener("error", () => {
      if (!triedPng) { triedPng = true; img.src = `${base}.png`; }
      else img.remove();
    });
    img.src = `${base}.svg`;
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

function tierRoleForPosition(position) {
  const value = String(position || "").toLocaleLowerCase().trim();
  if (/goalkeeper|keeper|kaleci|\bgk\b|\bkl\b/.test(value)) return "goalkeeper";
  if (/defender|defence|defense|defans|centre.?back|center.?back|full.?back|left.?back|right.?back|\bcb\b|\blb\b|\brb\b|\bdef\b/.test(value)) return "defender";
  if (/midfielder|midfield|orta saha|\bdm\b|\bcm\b|\bam\b|\blm\b|\brm\b|\bos\b/.test(value)) return "midfielder";
  if (/attacker|forward|striker|forvet|centre.?forward|center.?forward|winger|\bst\b|\bcf\b|\blw\b|\brw\b|\bfor\b/.test(value)) return "attacker";
  return "";
}

function playerHasTierRole(player, role) {
  return !role || [...player.positions].some((position) => tierRoleForPosition(position) === role);
}

function tierPositionLabel(position) {
  const labels = { goalkeeper: "Kaleci", defender: "Defans", midfielder: "Orta Saha", attacker: "Forvet" };
  return labels[tierRoleForPosition(position)] || position;
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
  $("tier-page-range").textContent = total ? `${total} oyuncunun ${first}–${last} arası gösteriliyor` : "0 oyuncu gösteriliyor";
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
    button.setAttribute("aria-label", `Oyuncu listesinin ${item + 1}. sayfasına git`);
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
    if (!players.has(id)) players.set(id, { id, name: profiles.get(id)?.display_name || profiles.get(id)?.name || name || `Oyuncu ${id}`, teams: new Set(), positions: new Set(), matches: [] });
    const player = players.get(id);
    if (name && player.name === `Oyuncu ${id}`) player.name = name;
    return player;
  };
  for (const profile of profiles.values()) ensure(profile.id, profile.name);
  for (const row of state.tables["squads.csv"] || []) {
    const player = ensure(row.player_id);
    if (!player) continue;
    if (row.team_id) player.teams.add(row.team_id);
    if (row.team_id) player.squadTeam = row.team_id;
    if (row.jersey_number) player.jersey = row.jersey_number;
    if (row["position.name"]) player.positions.add(row["position.name"]);
  }
  for (const row of state.tables["player_match_stats.csv"] || []) {
    const player = ensure(row.player_id, row.name);
    if (!player) continue;
    if (row.team_id) player.teams.add(row.team_id);
    if (row.position) player.positions.add(row.position);
    player.matches.push(row);
  }
  for (const player of players.values()) {
    player.teamNames = [...player.teams].map((id) => teamName(id, teams));
    player.matches.sort((a, b) => String(fixtures.get(b.fixture_id)?.kickoff || "").localeCompare(String(fixtures.get(a.fixture_id)?.kickoff || "")) || String(b.fixture_id).localeCompare(String(a.fixture_id), undefined, { numeric: true }));
    player.ratings = player.matches.map(validMatchRating).filter((value) => value !== null);
    player.average = player.ratings.length ? player.ratings.reduce((a, b) => a + b, 0) / player.ratings.length : null;
    player.totals = Object.fromEntries(["minutes_played", "goals", "assists", "xg", "shots_total", "key_passes", "saves"].map((key) => [key, totalMetric(player.matches, key)]));
  }
  state.tierCache = { players: [...players.values()], teams, fixtures };
  return state.tierCache;
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
  const { players, teams } = buildTierPlayers();
  const teamIds = [...new Set(players.flatMap((player) => [...player.teams]))];
  options($("tier-team"), teamIds.map((id) => [id, teamName(id, teams)]).sort((a, b) => a[1].localeCompare(b[1])), "Tüm takımlar");
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
    && playerHasTierRole(player, selectedTierRole)
    && (!query || `${player.name} ${player.teamNames.join(" ")}`.toLocaleLowerCase().includes(query)));
  const pageCount = Math.max(1, Math.ceil(filtered.length / tierPageSize));
  tierPage = Math.max(0, Math.min(tierPage, pageCount - 1));
  const visiblePlayers = filtered.slice(tierPage * tierPageSize, (tierPage + 1) * tierPageSize);
  const scroller = element("div", "table-container tier-ranking-scroll");
  scroller.tabIndex = 0;
  scroller.setAttribute("aria-label", "Oyuncu sıralaması. Diğer istatistikler için yatay kaydırın.");
  const table = element("table", "tier-ranking-table");
  const caption = element("caption", "sr-only", "Ortalama Sportmonks puanına göre sezon oyuncu sıralaması. Tüm maç istatistikleri için oyuncu adına tıklayın.");
  const head = element("thead"), header = element("tr");
  const columns = ["Sıra", "Logo", "Mevki", "Oyuncu", "Kademe", "Ort. Puan", "Puanlı Maç", "Maç Kaydı", "Dakika", "Gol", "Asist", "xG", "Şut", "Kilit Pas", "Kurtarış"];
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
    tr.append(element("td", "role-cell", [...player.positions].map(tierPositionLabel).join(" / ") || "—"));
    const playerCell = element("td", "player-cell");
    const name = element("button", "player-name-button", player.name);
    name.type = "button";
    name.setAttribute("aria-label", `${player.name} için tüm maç ve istatistikleri göster`);
    name.addEventListener("click", () => openTierPlayer(player.id));
    playerCell.append(name);
    const tierCell = element("td");
    const badge = element("span", "tier-tag", tier === "P" ? "Ön Değerlendirme" : tier === "U" ? "Puansız" : tier);
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
    const tr = element("tr"), td = element("td", "no-results", players.length ? "Bu filtrelerle eşleşen oyuncu yok." : "Oyuncuları eklemek için player_match_stats.csv, players.csv veya squads.csv dosyasını açın.");
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
  if (!player.teams.size) meta.append("Takım bilgisi yok");
  meta.append(` · ${[...player.positions].map(tierPositionLabel).join(" / ") || "Mevki bilgisi yok"} · Oyuncu ID: ${player.id}`);
  const summary = document.createDocumentFragment();
  const add = (label, value, title) => {
    const card = element("div");
    card.append(element("span", "", label), element("strong", "", value));
    if (title) card.title = title;
    summary.append(card);
  };
  add("ORT. SPORTMONKS PUANI", ratingText(player.average), "Sağlanan geçerli maç puanlarının aritmetik ortalaması. Dakikaya göre ağırlıklandırılmaz.");
  add("PUANLI / KAYITLI MAÇ", `${player.ratings.length} / ${player.matches.length}`);
  for (const [key, label] of [["minutes_played", "DAKİKA"], ["goals", "GOL"], ["assists", "ASİST"], ["xg", "xG"], ["shots_total", "ŞUT"], ["key_passes", "KİLİT PAS"]]) add(label, metricText(player.totals[key]), metricTitle(player.totals[key]));
  $("player-detail-summary").replaceChildren(summary);
  $("player-detail-coverage").textContent = `${player.matches.length} maç kaydı · ${player.ratings.length} geçerli puan · ${tierBands.find((band) => band.id === tierFor(player)).label}. Bir kayıt sıfır dakikalık katılım içerebilir. * işaretli toplamların girdileri eksiktir; veri kapsamı için toplamın üzerinde bekleyin. Kaydedilmemiş maçlar sıfırla doldurulmaz.`;
  renderPlayerHistory();
  $("player-dialog").showModal();
}

function prettyField(key) {
  const names = { xg_expected_goals: "xG · özel kaynak", expected_goals: "xG · standart kaynak", xg_expected_goals_on_target: "İsabetli xG · özel kaynak", expected_goals_on_target: "İsabetli xG · standart kaynak", rating: "Sportmonks puanı", minutes_played: "Dakika", started: "İlk 11 (1/0)", goals: "Gol", assists: "Asist", shots_total: "Şut", shots_on_target: "İsabetli şut", key_passes: "Kilit pas", chances_created: "Yaratılan fırsat", tackles: "Müdahale", interceptions: "Top kesme", saves: "Kurtarış", yellowcards: "Sarı kart", redcards: "Kırmızı kart" };
  return names[key] || key.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function renderPlayerHistory() {
  const { players, fixtures, teams } = buildTierPlayers();
  const player = players.find((item) => item.id === selectedTierPlayer);
  if (!player) return;
  const allFields = [...new Set(player.matches.flatMap((row) => Object.keys(row)))];
  const core = ["rating", "minutes_played", "started", "goals", "assists", "xg_expected_goals", "expected_goals", "shots_total", "shots_on_target", "key_passes", "chances_created", "tackles", "interceptions", "saves", "yellowcards", "redcards"];
  const fields = $("all-match-stats").checked ? [...core.filter((key) => allFields.includes(key)), ...allFields.filter((key) => !core.includes(key))] : core.filter((key) => allFields.includes(key));
  const heading = element("tr");
  for (const label of ["Başlama", "Maç", "Takım", "Hafta", "Durum", ...fields.map(prettyField)]) {
    const th = element("th", "", label); th.scope = "col"; heading.append(th);
  }
  $("history-head").replaceChildren(heading);
  const body = document.createDocumentFragment();
  for (const row of player.matches) {
    const fixture = fixtures.get(row.fixture_id);
    const match = fixture?.name || (fixture ? `${teamName(fixture.home_team_id, teams)} - ${teamName(fixture.away_team_id, teams)}` : `Fikstür ${row.fixture_id}`);
    const tr = element("tr");
    for (const value of [fixture?.kickoff, match, teamName(row.team_id, teams), fixture?.["round.name"], fixture?.state]) tr.append(element("td", "", value || "—"));
    tr.children[2].replaceChildren(createTeamLink(row.team_id, teamName(row.team_id, teams)));
    for (const key of fields) {
      const value = row[key];
      const td = element("td", number(value) !== null ? "numeric" : "", value === undefined || value === "" ? "—" : value);
      if (key === "rating" && value && validMatchRating(row) === null) td.title = "Sağlayıcı değeri geldiği biçimde gösterilir; 1–10 aralığı dışında olduğu veya kayıt açıkça sıfır dakika gösterdiği için ortalamaya alınmaz.";
      tr.append(td);
    }
    body.append(tr);
  }
  if (!player.matches.length) {
    const tr = element("tr"), td = element("td", "no-results", "Bu oyuncu için maç istatistiği sağlanmadı. Oyuncu, uydurma bir puan verilmeden kadroda gösterilir.");
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
