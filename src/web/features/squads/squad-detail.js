"use strict";

// One shared squad's page (index.html?view=squads&squad=<id>): who saved it and
// for which week, the eleven and bench on the site's one pitch
// (styles/pitch.css), and Kadro Kur's "Kadro beklentisi" as it stood when the
// squad was saved, with the clubs it draws on. Players are shown by their
// Sportmonks profile, rating and club shirt as everywhere else, so a player who
// has since left the league still appears.

const squadDetailState = { id: "", request: 0, status: "idle", error: "", squad: null };
// Kadro Kur's summary, in its order and words (features/builder/summary.js),
// read from the totals saved with the squad.
const SQUAD_DETAIL_METRICS = [
  ["expected_points", "Beklenen FP"],
  ["expected_goals", "Beklenen gol"],
  ["expected_assists", "Beklenen asist"],
  ["expected_yellow_cards", "Beklenen sarı kart"],
  ["expected_red_cards", "Beklenen kırmızı kart"],
  ["expected_minutes", "Beklenen dakika"],
];

async function loadSharedSquad(id) {
  const request = ++squadDetailState.request;
  Object.assign(squadDetailState, { id, status: "loading", error: "", squad: null });
  try {
    const client = await loadAuth();
    // Every column, so totals added to the table later show once they exist.
    const { data, error } = await client.from("shared_squads").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    if (request !== squadDetailState.request) return;
    Object.assign(squadDetailState, data
      ? { status: "ready", squad: data }
      : { status: "error", error: "Bu kadro bulunamadı; silinmiş olabilir." });
  } catch (error) {
    if (request !== squadDetailState.request) return;
    Object.assign(squadDetailState, { status: "error", error: squadFeedErrorText(error) });
  }
  if (state.view === "squads" && sharedSquadParam() === id) renderSharedSquads();
}

// The eleven in Kadro Kur's lines: the goalkeeper, then one line per number in
// the formation, defenders first, as the table keeps them. Drawn forwards at
// the top, with Kadro Kur's line names.
function squadDetailLines(formation, starters) {
  const parts = String(formation).split("-").map(Number);
  const lines = [{ label: "Kaleci", ids: starters.slice(0, 1), goalkeeper: true }];
  let next = 1;
  parts.forEach((count, index) => {
    const label = index === 0 ? "Defans" : index === parts.length - 1 ? "Forvet" : index === parts.length - 2 ? "Ofansif orta saha" : "Orta saha";
    lines.push({ label, ids: starters.slice(next, next + count) });
    next += count;
  });
  return lines.reverse();
}

// points: the starter's actual fantasy points this week (null while his match
// is still to finish), or undefined to show none, as for the bench.
function squadDetailPlayer(id, goalkeeper, points) {
  const player = buildTierPlayers().byId.get(String(id));
  const item = squadFeedNode("div", "squad-pitch-player");
  const shirt = squadFeedNode("span", "pitch-shirt");
  const keeper = goalkeeper || (player && playerPrimaryRole(player) === "goalkeeper");
  const name = player?.name || `Oyuncu ${id}`;
  shirt.innerHTML = shirtSVG(player?.squadTeam || [...(player?.teams || [])][0] || null, { size: 64, number: player?.jersey, surname: name, goalkeeper: keeper });
  const rating = squadFeedNode("span", "pitch-rating", ratingText(player?.average ?? null));
  rating.title = "Sezon reyting ortalaması";
  item.append(shirt, squadFeedNode("span", "pitch-player-name", name), rating);
  if (points !== undefined) {
    const chip = squadFeedNode("span", "squad-player-points", points === null ? "— FP" : `${displayNumber(points)} FP`);
    chip.title = points === null ? "Maçı henüz bitmedi" : "Bu haftaki fantezi puanı";
    item.append(chip);
  }
  return item;
}

function squadDetailHeader(squad, roundName) {
  const header = squadFeedNode("header", "squad-detail-head");
  const avatar = squadAvatar(squad, 46);
  avatar.classList.add("squad-avatar-large");
  const identity = squadFeedNode("div", "squad-detail-identity");
  const title = squadFeedNode("h2", "", squad.author_nickname);
  if (siteAuth.user?.id === squad.user_id) title.append(squadFeedNode("span", "squad-detail-own", "Senin kadron"));
  const time = squadFeedNode("time", "", squadFeedTimeFormat.format(new Date(squad.shared_at)));
  time.dateTime = squad.shared_at;
  const meta = squadFeedNode("p", "squad-detail-meta", `${roundName} · `);
  meta.append(time, document.createTextNode(" kaydedildi"));
  identity.append(title, meta);
  const side = squadFeedNode("div", "squad-detail-side");
  const points = squadFeedNode("div", "squad-detail-points");
  points.append(squadFeedNode("span", "", "Beklenen FP"), squadFeedNode("strong", "", squadPointsText(squad)));
  side.append(points, squadActualBlock(squad));
  if (siteAuth.user?.id && siteAuth.user.id === squad.user_id) side.append(squadDeleteButton(squad, "squad-delete squad-detail-delete"));
  header.append(avatar, identity, side);
  return header;
}

function squadDetailPitch(squad) {
  const starters = (squad.starters || []).map(String), bench = (squad.bench || []).map(String);
  const panel = squadFeedNode("section", "squad-pitch-panel");
  panel.setAttribute("aria-label", "Kadro sahası");
  const heading = squadFeedNode("div", "squad-pitch-heading");
  const identity = squadFeedNode("div");
  identity.append(squadFeedNode("p", "eyebrow", "KADRO"), squadFeedNode("h3", "", "İlk 11"));
  const totals = squadFeedNode("dl", "squad-pitch-totals");
  const budget = number(squad.budget_million);
  for (const [label, value, title] of [
    ["Bütçe · ₺M", budget === null ? "—" : `${displayNumber(budget)} / 100`, "Kaydedildiği günün fiyatlarıyla"],
    ["Kadro", `${starters.length + bench.length} / 15`, ""],
  ]) {
    const item = squadFeedNode("div");
    if (title) item.title = title;
    item.append(squadFeedNode("dt", "", label), squadFeedNode("dd", "", value));
    totals.append(item);
  }
  heading.append(identity, totals, squadFeedNode("span", "badge squad-formation", squad.formation));

  const pitch = squadFeedNode("div", "squad-pitch");
  pitch.innerHTML = '<div class="pitch-markings" aria-hidden="true"><span class="pitch-circle"></span><span class="pitch-box pitch-box-top"></span><span class="pitch-box pitch-box-bottom"></span></div>';
  const lines = squadFeedNode("div", "squad-pitch-lines");
  // Each starter's points once the week has begun; none before it.
  const actual = squadActualPoints(squad);
  const pointsFor = (id) => (actual && actual.finished > 0 ? actual.byPlayer.get(id) : undefined);
  for (const line of squadDetailLines(squad.formation, starters)) {
    const row = squadFeedNode("div", "squad-pitch-line");
    const players = squadFeedNode("div", "squad-pitch-line-players");
    players.append(...line.ids.map((id) => squadDetailPlayer(id, line.goalkeeper, pointsFor(id))));
    row.append(squadFeedNode("span", "pitch-line-label", line.label), players);
    lines.append(row);
  }
  pitch.append(lines);

  const benchSection = squadFeedNode("section", "squad-bench");
  benchSection.append(squadFeedNode("h3", "", "Yedekler"));
  const benchPlayers = squadFeedNode("div", "squad-pitch-line-players");
  benchPlayers.append(...bench.map((id) => squadDetailPlayer(id, false)));
  if (!bench.length) benchPlayers.append(squadFeedNode("p", "squad-empty", "Yedek seçilmemiş."));
  benchSection.append(benchPlayers);
  panel.append(heading, pitch, benchSection);
  return panel;
}

function squadDetailMetric(label, value, detail = "") {
  const item = squadFeedNode("div", "squad-metric");
  item.append(squadFeedNode("dt", "", label), squadFeedNode("dd", "", value));
  if (detail) item.append(squadFeedNode("dd", "squad-metric-detail", detail));
  return item;
}

function squadDetailSummary(squad) {
  const section = squadFeedNode("section", "squad-details");
  const projected = number(squad.projected_starters) ?? 0;
  const heading = squadFeedNode("div", "squad-details-heading");
  const title = squadFeedNode("div");
  title.append(squadFeedNode("p", "eyebrow", "KAYDEDİLDİĞİNDE"), squadFeedNode("h3", "", "Kadro beklentisi"));
  heading.append(title, squadFeedNode("span", "badge", `${projected} / 11 oyuncu tahminli`));

  // Formatted as Kadro Kur formats its own summary.
  const metrics = squadFeedNode("dl", "squad-metrics");
  for (const [field, label] of SQUAD_DETAIL_METRICS) {
    const value = number(squad[field]);
    const partial = value !== null && projected < 11;
    const shown = value === null ? "—" : `${displayNumber(field === "expected_minutes" ? Math.round(value) : value)}${partial ? "*" : ""}`;
    const detail = partial ? `${projected} / 11 oyuncu` : field === "expected_minutes" && value !== null ? "/ 990" : "";
    metrics.append(squadDetailMetric(label, shown, detail));
  }
  const bench = number(squad.bench_expected_points), benchCount = (squad.bench || []).length;
  metrics.append(squadDetailMetric("Yedekler · beklenen FP", bench === null ? "—" : displayNumber(bench), benchCount ? `${benchCount} yedek` : "Yedek yok"));

  const note = squadFeedNode("p", "squad-details-note");
  const detailsSaved = ["expected_goals", "expected_minutes", "budget_million"].some((field) => number(squad[field]) !== null);
  note.textContent = !detailsSaved && number(squad.expected_points) !== null
    ? "Bu kadro, ayrıntılar kaydedilmeye başlamadan önce kaydedildi; yalnızca beklenen FP var. Kadro Kur'da yeniden kaydedilince hepsi görünür."
    : "Toplamlar, kadro kaydedildiği andaki sonraki maç tahminlerinin toplamıdır; yalnızca ilk 11 sayılır, yedekler ayrı gösterilir. Oynaması belirsiz oyuncuların tahmini yoktur; * işaretli toplamlar eksiktir.";

  // Every one of the fifteen counts toward the three-per-club rule.
  const teams = new Map((state.tables["teams.csv"] || []).map((row) => [row.id, row]));
  const counts = new Map();
  for (const id of [...(squad.starters || []), ...(squad.bench || [])]) {
    const player = buildTierPlayers().byId.get(String(id));
    const club = player?.squadTeam || player?.club;
    if (club) counts.set(club, (counts.get(club) || 0) + 1);
  }
  const clubsHeading = squadFeedNode("div", "squad-details-heading");
  clubsHeading.append(squadFeedNode("h3", "", "Takımlara göre"), squadFeedNode("span", "badge", "Takım başına en fazla 3"));
  const clubs = squadFeedNode("ul", "squad-clubs");
  clubs.append(...[...counts].sort((a, b) => b[1] - a[1] || teamName(a[0], teams).localeCompare(teamName(b[0], teams), "tr")).map(([id, count]) => {
    const item = squadFeedNode("li", "squad-club");
    item.style.setProperty("--club-color", teamColor(id));
    item.append(squadFeedNode("span", "", teamName(id, teams)), createTeamLogo(id, teams, false), squadFeedNode("span", "squad-club-count", `– ${count}`));
    return item;
  }));
  section.append(heading, metrics, note, clubsHeading, clubs);
  return section;
}

function renderSharedSquadDetail(id) {
  const container = document.getElementById("squads-detail");
  const back = squadFeedNode("a", "secondary squad-back", "← Tüm kadrolar");
  back.href = "index.html?view=squads";
  back.addEventListener("click", (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    openSharedSquadPage();
  });
  container.replaceChildren(back);
  if (!authEnabled()) {
    container.append(squadFeedNode("p", "squad-empty", "Kadrolar şu anda gösterilemiyor."));
    return;
  }
  if (id !== squadDetailState.id) loadSharedSquad(id);
  if (squadDetailState.status === "loading") {
    container.append(squadFeedNode("p", "squad-empty", "Kadro yükleniyor…"));
    return;
  }
  if (squadDetailState.status === "error") {
    container.append(squadFeedNode("p", "squad-empty squad-load-error", squadDetailState.error));
    return;
  }
  const squad = squadDetailState.squad;
  // Names, shirts and ratings come from the season files, read on page load.
  if (!squad || !state.tables["players.csv"]) {
    container.append(squadFeedNode("p", "squad-empty", "Oyuncular yükleniyor…"));
    return;
  }
  const round = squadFeedRounds().find((item) => item.id === String(squad.round_id));
  const layout = squadFeedNode("div", "squad-detail-layout");
  layout.append(squadDetailPitch(squad), squadDetailSummary(squad));
  const status = squadFeedNode("p", "squad-detail-status");
  status.id = "squads-detail-status";
  status.setAttribute("role", "status");
  container.append(squadDetailHeader(squad, round?.name || "Haftası bilinmiyor"), status, layout);
}

// A squad saved again on Kadro Kur is read afresh when its page next opens.
document.addEventListener("shared-squad-saved", () => { squadDetailState.id = ""; });
