"use strict";

// Kadrolar: the fantasy squads visitors have shared, grouped by matchweek with
// the current week first, kept in Supabase (supabase/shared_squads.sql).
// Anyone can read; squads are saved from Kadro Kur (features/builder/save.js).
// Each card shows who shared the squad, when, and the eleven's expected
// fantasy points at that time.

const SQUAD_FEED_FIELDS = "id, round_id, author_nickname, author_team_id, expected_points, projected_starters, shared_at";
const squadFeedState = { loadedKey: "", request: 0, status: "idle", error: "", squads: [] };
const squadFeedTimeFormat = new Intl.DateTimeFormat(LOCALE, { timeZone: MATCH_TIME_ZONE, dateStyle: "medium", timeStyle: "short" });

function squadFeedNode(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function squadFeedErrorText(error) {
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

function squadFeedCard(squad) {
  const card = squadFeedNode("article", "squad-card");
  const avatar = squadFeedNode("span", "squad-avatar");
  avatar.setAttribute("aria-hidden", "true");
  avatar.append(squadFeedNode("span", "squad-avatar-initial", String(squad.author_nickname || "?").charAt(0).toLocaleUpperCase(LOCALE)));
  if (squad.author_team_id) {
    avatar.style.setProperty("--squad-ring", teamColor(squad.author_team_id));
    avatar.append(profileCrest(squad.author_team_id, 36));
  }
  const text = squadFeedNode("div", "squad-card-text");
  const time = squadFeedNode("time", "squad-card-date", squadFeedTimeFormat.format(new Date(squad.shared_at)));
  time.dateTime = squad.shared_at;
  const points = squadFeedNode("p", "squad-card-points");
  // A total from fewer than all eleven is marked, as Kadro Kur marks it.
  const value = number(squad.expected_points), projected = number(squad.projected_starters) ?? 0;
  const partial = value !== null && projected < 11;
  points.append(squadFeedNode("span", "", "Beklenen FP"), squadFeedNode("strong", "", value === null ? "—" : `${displayNumber(value)}${partial ? "*" : ""}`));
  if (partial) points.title = `${projected} / 11 oyuncu tahminli; toplam eksik.`;
  text.append(squadFeedNode("h3", "squad-card-name", squad.author_nickname), time, points);
  card.append(avatar, text);
  return card;
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
document.getElementById("squads-refresh").addEventListener("click", () => {
  squadFeedState.loadedKey = "";
  renderSharedSquads();
  document.getElementById("squads-status").textContent = "Kadrolar yenilendi.";
});
