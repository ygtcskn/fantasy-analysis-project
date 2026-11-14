"use strict";

// Kadrolar: the fantasy squads visitors have shared, grouped by matchweek with
// the current week first, kept in Supabase (supabase/shared_squads.sql).
// Anyone can read; squads are saved from Kadro Kur (features/builder/save.js).
// Each card shows who shared the squad, when, and the eleven's expected
// fantasy points at that time, and opens that squad's own page
// (index.html?view=squads&squad=<id>, drawn by squad-detail.js).

// Every column, as Maç Tribünü reads its posts: a column added to
// supabase/shared_squads.sql later (author_avatar_path) is used once the file
// has been run again, and its absence until then never empties the page.
const SQUAD_FEED_FIELDS = "*";
const squadFeedState = { loadedKey: "", request: 0, status: "idle", error: "", squads: [] };
const squadFeedTimeFormat = new Intl.DateTimeFormat(LOCALE, { timeZone: MATCH_TIME_ZONE, dateStyle: "medium", timeStyle: "short" });

function squadFeedErrorText(error) {
  // The database refused a delete: a session that has ended, or someone else's squad.
  if (error?.code === "42501") return t("Bu kadroyu yalnızca sahibi silebilir. Giriş yaptığından emin ol, sonra tekrar dene.");
  // A missing table, or one created before a column this page reads.
  if (["PGRST205", "42P01", "PGRST204", "42703"].includes(error?.code)) {
    return siteMode === "local"
      ? t("Kadro tablosu eksik: supabase/shared_squads.sql dosyasını Supabase → SQL Editor'da çalıştır.")
      : t("Kadrolar şu anda gösterilemiyor. Daha sonra tekrar dene.");
  }
  return error?.message ? t("Bir sorun çıktı: {reason}", { reason: error.message }) : t("Bir sorun çıktı. Tekrar dene.");
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
    if (!rounds.has(id)) rounds.set(id, { id, name: fixture["round.name"] ? t("Maç Haftası {round}", { round: fixture["round.name"] }) : t("Tur {id}", { id }), fixtures: [] });
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

// The sharer as everywhere a person appears (core/profile.js): their photo,
// else the first letter of their nickname. Not their club's crest.
function squadAvatar(squad, size = 64) {
  const avatar = profileAvatar({ nickname: squad.author_nickname, avatar_path: squad.author_avatar_path }, size);
  avatar.classList.add("squad-avatar");
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
  const block = element("div", "squad-actual");
  const actual = squadActualPoints(squad);
  const started = actual && actual.finished > 0;
  block.append(element("span", "", t("Gerçekleşen FP")), element("strong", "", started ? displayNumber(actual.total) : "—"),
    element("small", "", !actual ? t("Puanlar yüklenmedi") : started ? t("{finished} / {total} maç", { finished: actual.finished, total: actual.fixtures }) : t("Maçlar başlamadı")));
  block.title = t("İlk 11'in bu haftaki fantezi puanları; her maç bitip site verisi yenilendikçe artar. Kaptan ve yedek değişikliği yok.");
  return block;
}

// The author's own squads carry a "Sil" button; the database refuses anyone
// else's delete in any case.
function squadDeleteButton(squad, className = "squad-delete") {
  const button = element("button", className, t("Sil"));
  button.type = "button";
  button.setAttribute("aria-label", t("Kadronu sil"));
  button.title = t("Kadronu sil");
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
  if (!confirm(t("Bu kadro silinsin mi? Kadrolar sayfasından kalkar; istersen Kadro Kur'dan yeniden kaydedebilirsin."))) return;
  button.disabled = true;
  try {
    const client = await loadAuth();
    // Row-level security lets only the author delete; a row it refuses is simply not deleted.
    const { data, error } = await client.from("shared_squads").delete().eq("id", squad.id).select("id");
    if (error) throw error;
    if (!data.length) throw new Error(t("Bu kadro silinemedi."));
    squadFeedState.squads = squadFeedState.squads.filter((item) => String(item.id) !== String(squad.id));
    squadDetailState.id = "";
    if (sharedSquadParam()) openSharedSquadPage(); else renderSharedSquads();
    setSquadsStatus(t("Kadron silindi."));
  } catch (error) {
    button.disabled = false;
    setSquadsStatus(squadFeedErrorText(error), true);
  }
}

function squadFeedCard(squad) {
  const card = element("article", "squad-card");
  // The name is the link; it stretches over the whole card, under the button.
  const link = element("a", "squad-card-link", squad.author_nickname);
  link.href = `index.html?view=squads&squad=${encodeURIComponent(squad.id)}`;
  link.setAttribute("aria-label", t("{name} kadrosunu aç", { name: squad.author_nickname }));
  link.addEventListener("click", (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    openSharedSquadPage(squad.id);
  });
  const text = element("div", "squad-card-text");
  const name = element("h3", "squad-card-name");
  name.append(link);
  const time = element("time", "squad-card-date", squadFeedTimeFormat.format(new Date(squad.shared_at)));
  time.dateTime = squad.shared_at;
  const points = element("p", "squad-card-points");
  const projected = number(squad.projected_starters) ?? 0;
  points.append(element("span", "", t("Beklenen FP")), element("strong", "", squadPointsText(squad)));
  if (number(squad.expected_points) !== null && projected < 11) points.title = t("{count} / 11 oyuncu tahminli; toplam eksik.", { count: projected });
  text.append(name, time, points);
  const side = element("div", "squad-card-side");
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
  const section = element("section", "squad-week");
  const header = element("header", "squad-week-header");
  const title = element("h2", "", name);
  if (current) title.append(element("span", "squad-week-current", t("Bu hafta")));
  header.append(title, element("span", "squad-week-count", t("{count} kadro", { count: squads.length }, squads.length)));
  section.append(header);
  if (!squads.length) {
    section.append(element("p", "squad-empty", t("Bu hafta henüz kadro paylaşılmadı.")));
    return section;
  }
  const grid = element("div", "squad-grid");
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
    container.append(element("p", "squad-empty", t("Henüz fikstür yüklenmedi. Sezon verileri yüklendiğinde paylaşılan kadrolar haftalara göre burada görünecek.")));
    return;
  }
  if (!authEnabled()) {
    container.append(element("p", "squad-empty", t("Kadrolar şu anda gösterilemiyor.")));
    return;
  }
  const loadKey = `season:${state.seasonSlug}`;
  if (loadKey !== squadFeedState.loadedKey) loadSharedSquads(loadKey);
  if (squadFeedState.status === "loading") {
    container.append(element("p", "squad-empty", t("Kadrolar yükleniyor…")));
    return;
  }
  if (squadFeedState.status === "error") {
    container.append(element("p", "squad-empty squad-load-error", squadFeedState.error));
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
  if (unknown.length) container.append(squadFeedWeek(t("Haftası bilinmeyen kadrolar"), unknown, false));
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
  document.getElementById("squads-status").textContent = t("Kadrolar yenilendi.");
});
