"use strict";

// Kadrolar: the fantasy squads visitors have shared, grouped by matchweek with
// the current week first, kept in Supabase (supabase/shared_squads.sql).
// Anyone can read; squads are saved from Kadro Kur (features/builder/save.js).
// Each card shows who shared the squad, when, and the eleven's expected
// fantasy points at that time, and opens that squad's own page
// (index.html?view=squads&squad=<id>, drawn by squad-detail.js).

const SQUAD_FEED_FIELDS = "id, season, round_id, user_id, author_nickname, author_team_id, starters, expected_points, projected_starters, shared_at";
const squadFeedState = { loadedKey: "", request: 0, status: "idle", error: "", squads: [] };
const squadFeedTimeFormat = new Intl.DateTimeFormat(LOCALE, { timeZone: MATCH_TIME_ZONE, dateStyle: "medium", timeStyle: "short" });

function squadFeedNode(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function squadFeedErrorText(error) {
  // The database refused a delete: a session that has ended, or someone else's squad.
  if (error?.code === "42501") return "Bu kadroyu yalnızca sahibi silebilir. Giriş yaptığından emin ol, sonra tekrar dene.";
  // A missing table, or one created before a column this page reads.
  if (["PGRST205", "42P01", "PGRST204", "42703"].includes(error?.code)) {
    return siteMode === "local"
      ? "Kadro tablosu eksik: supabase/shared_squads.sql dosyasını Supabase → SQL Editor'da çalıştır."
      : "Kadrolar şu anda gösterilemiyor. Daha sonra tekrar dene.";
  }
  return error?.message ? `Bir sorun çıktı: ${error.message}` : "Bir sorun çıktı. Tekrar dene.";
}

async function loadSharedSquads(key) {
  const request = ++squadFeedState.request;
  Object.assign(squadFeedState, { loadedKey: key, status: "loading", error: "" });
  try {
    const client = await loadAuth();
    const { data, error } = await client.from("shared_squads").select(SQUAD_FEED_FIELDS)
      .eq("season", state.seasonSlug).order("shared_at", { ascending: false }).limit(1000);
    if (error) throw error;
    if (request !== squadFeedState.request) return;
    Object.assign(squadFeedState, { squads: data, status: "ready" });
  } catch (error) {
    if (request !== squadFeedState.request) return;
    Object.assign(squadFeedState, { squads: [], status: "error", error: squadFeedErrorText(error) });
  }
  if (state.view === "squads") renderSharedSquads();
}

// The season's matchweeks in kickoff order, keyed by Sportmonks round ID.
function squadFeedRounds() {
  const fixtures = [...(state.tables["fixtures.csv"] || [])].sort((a, b) => String(a.kickoff || "9999").localeCompare(String(b.kickoff || "9999")));
  const rounds = new Map();
  for (const fixture of fixtures) {
    const id = String(fixture.round_id || fixture["round.id"] || "");
    if (!id) continue;
    if (!rounds.has(id)) rounds.set(id, { id, name: fixture["round.name"] ? `Maç Haftası ${fixture["round.name"]}` : `Tur ${id}`, fixtures: [] });
    rounds.get(id).fixtures.push(fixture);
  }
  return [...rounds.values()];
}

// Highest expected points first; a squad without them goes last, newest first.
function compareSharedSquads(a, b) {
  const left = number(a.expected_points), right = number(b.expected_points);
  if (left !== right) return left === null ? 1 : right === null ? -1 : right - left;
  return String(b.shared_at).localeCompare(String(a.shared_at));
}

// The sharer's club crest in a ring of the club's colour, over the first letter
// of their nickname, which shows when there is no club or the crest fails.
function squadAvatar(squad, crestSize = 36) {
  const avatar = squadFeedNode("span", "squad-avatar");
  avatar.setAttribute("aria-hidden", "true");
  avatar.append(squadFeedNode("span", "squad-avatar-initial", String(squad.author_nickname || "?").charAt(0).toLocaleUpperCase(LOCALE)));
  if (squad.author_team_id) {
    avatar.style.setProperty("--squad-ring", teamColor(squad.author_team_id));
    avatar.append(profileCrest(squad.author_team_id, crestSize));
  }
  return avatar;
}

// "42,22", or "42,22*" when the total left out an eleven without a projection,
// as Kadro Kur marks it.
function squadPointsText(squad) {
  const value = number(squad.expected_points), projected = number(squad.projected_starters) ?? 0;
  return value === null ? "—" : `${displayNumber(value)}${projected < 11 ? "*" : ""}`;
}

// The eleven's actual fantasy points in the squad's week, from the published
// points ledger (points/player_match_points.csv): each starter's points in the
// week's finished matches, so the total grows as each match ends and the site's
// data is refreshed. Only the eleven score, with no captain and no bench
// substitutions, as in Kadro Kur. A starter whose club has played without him
// scores 0. Null when the ledger is not loaded or the squad is from another
// season. byPlayer holds each starter's points, or null while his club's match
// is still to finish.
function squadActualPoints(squad) {
  if (!fantasyState.season || fantasyState.season !== state.seasonSlug || squad.season !== state.seasonSlug) return null;
  const fixtures = (state.tables["fixtures.csv"] || []).filter((fixture) => String(fixture.round_id || fixture["round.id"] || "") === String(squad.round_id));
  const finished = fixtures.filter(fixtureFinished);
  const finishedIds = new Set(finished.map((fixture) => fixture.fixture_id));
  const playedClubs = new Set(finished.flatMap((fixture) => [fixture.home_team_id, fixture.away_team_id]));
  const byPlayer = new Map();
  let total = 0;
  for (const id of (squad.starters || []).map(String)) {
    const rows = (fantasyState.matches.get(id) || []).filter((row) => finishedIds.has(row.fixture_id));
    const player = buildTierPlayers().byId.get(id);
    const club = player?.squadTeam || player?.club;
    const points = rows.length ? rows.reduce((sum, row) => sum + (number(row.points_total) ?? 0), 0) : club && playedClubs.has(club) ? 0 : null;
    byPlayer.set(id, points);
    total += points ?? 0;
  }
  return { total, finished: finished.length, fixtures: fixtures.length, byPlayer };
}

// "Gerçekleşen FP" and how much of the week it covers.
function squadActualBlock(squad) {
  const block = squadFeedNode("div", "squad-actual");
  const actual = squadActualPoints(squad);
  const started = actual && actual.finished > 0;
  block.append(squadFeedNode("span", "", "Gerçekleşen FP"), squadFeedNode("strong", "", started ? displayNumber(actual.total) : "—"),
    squadFeedNode("small", "", !actual ? "Puanlar yüklenmedi" : started ? `${actual.finished} / ${actual.fixtures} maç` : "Maçlar başlamadı"));
  block.title = "İlk 11'in bu haftaki fantezi puanları; her maç bitip site verisi yenilendikçe artar. Kaptan ve yedek değişikliği yok.";
  return block;
}

// The author's own squads carry a "Sil" button; the database refuses anyone
// else's delete in any case.
function squadDeleteButton(squad, className = "squad-delete") {
  const button = squadFeedNode("button", className, "Sil");
  button.type = "button";
  button.setAttribute("aria-label", "Kadronu sil");
  button.title = "Kadronu sil";
  button.addEventListener("click", () => deleteSharedSquad(squad, button));
  return button;
}

function setSquadsStatus(text, error = false) {
  const status = document.getElementById(sharedSquadParam() ? "squads-detail-status" : "squads-status");
  if (!status) return;
  status.textContent = text;
  status.classList.toggle("squad-load-error", error);
}

async function deleteSharedSquad(squad, button) {
  if (!confirm("Bu kadro silinsin mi? Kadrolar sayfasından kalkar; istersen Kadro Kur'dan yeniden kaydedebilirsin.")) return;
  button.disabled = true;
  try {
    const client = await loadAuth();
    // Row-level security lets only the author delete; a row it refuses is simply not deleted.
    const { data, error } = await client.from("shared_squads").delete().eq("id", squad.id).select("id");
    if (error) throw error;
    if (!data.length) throw new Error("Bu kadro silinemedi.");
    squadFeedState.squads = squadFeedState.squads.filter((item) => String(item.id) !== String(squad.id));
    squadDetailState.id = "";
    if (sharedSquadParam()) openSharedSquadPage(); else renderSharedSquads();
    setSquadsStatus("Kadron silindi.");
  } catch (error) {
    button.disabled = false;
    setSquadsStatus(squadFeedErrorText(error), true);
  }
}

function squadFeedCard(squad) {
  const card = squadFeedNode("article", "squad-card");
  // The name is the link; it stretches over the whole card, under the button.
  const link = squadFeedNode("a", "squad-card-link", squad.author_nickname);
  link.href = `index.html?view=squads&squad=${encodeURIComponent(squad.id)}`;
  link.setAttribute("aria-label", `${squad.author_nickname} kadrosunu aç`);
  link.addEventListener("click", (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    openSharedSquadPage(squad.id);
  });
  const text = squadFeedNode("div", "squad-card-text");
  const name = squadFeedNode("h3", "squad-card-name");
  name.append(link);
  const time = squadFeedNode("time", "squad-card-date", squadFeedTimeFormat.format(new Date(squad.shared_at)));
  time.dateTime = squad.shared_at;
  const points = squadFeedNode("p", "squad-card-points");
  const projected = number(squad.projected_starters) ?? 0;
  points.append(squadFeedNode("span", "", "Beklenen FP"), squadFeedNode("strong", "", squadPointsText(squad)));
  if (number(squad.expected_points) !== null && projected < 11) points.title = `${projected} / 11 oyuncu tahminli; toplam eksik.`;
  text.append(name, time, points);
  const side = squadFeedNode("div", "squad-card-side");
  if (siteAuth.user?.id && siteAuth.user.id === squad.user_id) side.append(squadDeleteButton(squad));
  side.append(squadActualBlock(squad));
  card.append(squadAvatar(squad), text, side);
  return card;
}

// The squad a page address names, or "" for the week list.
function sharedSquadParam() {
  const id = new URLSearchParams(location.search).get("squad") || "";
  return /^\d+$/.test(id) ? id : "";
}

// One squad's page, or back to the list with no id. Each is its own address,
// so the browser's back button and a shared link both work.
function openSharedSquadPage(id = "") {
  if (location.protocol !== "file:") {
    const url = new URL(location.href);
    url.searchParams.set("view", "squads");
    if (id) url.searchParams.set("squad", id); else url.searchParams.delete("squad");
    history.pushState(null, "", url);
  }
  renderSharedSquads();
  document.getElementById("squads-workspace").scrollIntoView({ block: "start" });
}

function squadFeedWeek(name, squads, current) {
  const section = squadFeedNode("section", "squad-week");
  const header = squadFeedNode("header", "squad-week-header");
  const title = squadFeedNode("h2", "", name);
  if (current) title.append(squadFeedNode("span", "squad-week-current", "Bu hafta"));
  header.append(title, squadFeedNode("span", "squad-week-count", `${squads.length} kadro`));
  section.append(header);
  if (!squads.length) {
    section.append(squadFeedNode("p", "squad-empty", "Bu hafta henüz kadro paylaşılmadı."));
    return section;
  }
  const grid = squadFeedNode("div", "squad-grid");
  grid.append(...[...squads].sort(compareSharedSquads).map(squadFeedCard));
  section.append(grid);
  return section;
}

function renderSharedSquads() {
  const squadId = sharedSquadParam();
  document.getElementById("squads-list").hidden = Boolean(squadId);
  document.getElementById("squads-detail").hidden = !squadId;
  if (squadId) {
    renderSharedSquadDetail(squadId);
    return;
  }
  const container = document.getElementById("squads-weeks");
  container.replaceChildren();
  const rounds = squadFeedRounds();
  if (!rounds.length) {
    container.append(squadFeedNode("p", "squad-empty", "Henüz fikstür yüklenmedi. Sezon verileri yüklendiğinde paylaşılan kadrolar haftalara göre burada görünecek."));
    return;
  }
  if (!authEnabled()) {
    container.append(squadFeedNode("p", "squad-empty", "Kadrolar şu anda gösterilemiyor."));
    return;
  }
  const loadKey = `season:${state.seasonSlug}`;
  if (loadKey !== squadFeedState.loadedKey) loadSharedSquads(loadKey);
  if (squadFeedState.status === "loading") {
    container.append(squadFeedNode("p", "squad-empty", "Kadrolar yükleniyor…"));
    return;
  }
  if (squadFeedState.status === "error") {
    container.append(squadFeedNode("p", "squad-empty squad-load-error", squadFeedState.error));
    return;
  }
  const byRound = new Map();
  for (const squad of squadFeedState.squads) {
    const id = String(squad.round_id);
    if (!byRound.has(id)) byRound.set(id, []);
    byRound.get(id).push(squad);
  }
  // The current week always, then every other week someone shared a squad
  // for, newest first.
  const current = rounds[currentRoundIndex(rounds)];
  const weeks = rounds.filter((round) => round === current || byRound.has(round.id)).reverse();
  container.append(...weeks.map((round) => squadFeedWeek(round.name, byRound.get(round.id) || [], round === current)));
  // A week the loaded fixtures do not know, rather than silently leaving it out.
  const known = new Set(rounds.map((round) => round.id));
  const unknown = [...byRound].filter(([id]) => !known.has(id)).flatMap(([, squads]) => squads);
  if (unknown.length) container.append(squadFeedWeek("Haftası bilinmeyen kadrolar", unknown, false));
}

// A squad saved on Kadro Kur shows the next time this page is opened.
document.addEventListener("shared-squad-saved", () => { squadFeedState.loadedKey = ""; });
// Signing in or out changes whose squads carry "Sil" and "Senin kadron".
document.addEventListener("site-auth-change", () => {
  if (typeof state !== "undefined" && state.view === "squads") renderSharedSquads();
});
document.getElementById("squads-refresh").addEventListener("click", () => {
  squadFeedState.loadedKey = "";
  renderSharedSquads();
  document.getElementById("squads-status").textContent = "Kadrolar yenilendi.";
});
