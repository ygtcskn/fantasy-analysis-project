"use strict";

// A separate live snapshot: never overwrite saved fixtures, odds or analysis.
const liveCentre = { rows: [], selected: "", controller: null, timer: null, nextFetch: 0, season: "" };
const liveStateLabels = {
  INPLAY_1ST_HALF: "İlk yarı", HT: "Devre arası", INPLAY_2ND_HALF: "İkinci yarı",
  BREAK: "Uzatma bekleniyor", INPLAY_ET: "Uzatma", EXTRA_TIME_BREAK: "Uzatma arası",
  PEN_BREAK: "Penaltılar bekleniyor", INPLAY_PENALTIES: "Penaltılar",
  SUSPENDED: "Maç durduruldu", INTERRUPTED: "Ara verildi", AWAITING_UPDATES: "Güncelleme bekleniyor",
};
const liveStatistics = [
  [45, "Topa sahip olma", true], [42, "Toplam şut"], [86, "İsabetli şut"],
  [34, "Korner"], [44, "Tehlikeli atak"], [56, "Faul"], [84, "Sarı kart"],
  // Sportmonks' red-card count (83) includes dismissals for a second yellow;
  // 85 is how many of them were.
  [83, "Kırmızı kart (toplam)"], [85, "İkinci sarıdan kırmızı"],
];
const liveEventLabels = {
  GOAL: "Gol", OWNGOAL: "Kendi kalesine", OWN_GOAL: "Kendi kalesine",
  PENALTY: "Penaltı golü", MISSED_PENALTY: "Kaçan penaltı",
  YELLOWCARD: "Sarı kart", REDCARD: "Kırmızı kart", YELLOWREDCARD: "İkinci sarı kart",
  SUBSTITUTION: "Oyuncu değişikliği", VAR: "VAR", VAR_CARD: "VAR · Kart",
  GOAL_UNDER_REVIEW: "Gol inceleniyor", GOAL_CONFIRMED: "Gol onaylandı",
  GOAL_DISALLOWED: "Gol iptal", GOAL_CANCELLED: "Gol iptal",
  PENALTY_CONFIRMED: "Penaltı onaylandı", PENALTY_DISALLOWED: "Penaltı iptal",
  PENALTY_SHOOTOUT_GOAL: "Seri penaltı · Gol", PENALTY_SHOOTOUT_MISS: "Seri penaltı · Kaçtı",
  CORNER: "Korner",
};

function liveCentreActive() {
  return state.view === "matchweek" && !document.hidden && Boolean(state.seasonSlug)
    && location.protocol === "http:" && ["127.0.0.1", "localhost"].includes(location.hostname);
}

function stopLiveMatchCentre() {
  clearTimeout(liveCentre.timer);
  liveCentre.timer = null;
  liveCentre.controller?.abort();
  liveCentre.controller = null;
  liveCentre.nextFetch = 0;
  liveCentre.rows = [];
  $("live-centre").hidden = true;
}

function syncLiveMatchCentre() {
  if (!liveCentreActive()) { stopLiveMatchCentre(); return; }
  if (liveCentre.season !== state.seasonSlug) {
    stopLiveMatchCentre();
    liveCentre.selected = "";
    liveCentre.season = state.seasonSlug;
  }
  if (!liveCentre.controller && Date.now() >= liveCentre.nextFetch) fetchLiveMatchCentre();
}

async function fetchLiveMatchCentre() {
  clearTimeout(liveCentre.timer);
  const controller = new AbortController(), season = state.seasonSlug;
  liveCentre.controller = controller;
  const timeout = setTimeout(() => controller.abort(), 25000);
  let delay = 120000;
  try {
    const response = await fetch("/local-live.csv", { cache: "no-store", signal: controller.signal });
    if (!response.ok || response.headers.get("X-Superlig-Local") !== "1"
        || response.headers.get("X-Superlig-Season") !== season) throw new Error("Live feed unavailable");
    const { records } = parseCSV(await response.text());
    const metas = records.filter((row) => row.record_type === "meta");
    if (metas.length !== 1 || metas[0].season !== season) throw new Error("Invalid live snapshot");
    const meta = metas[0];
    if (!["ok", "unavailable", "disabled"].includes(meta.status)) throw new Error("Invalid live status");
    const seconds = number(meta.poll_seconds);
    if (seconds !== null) delay = Math.min(2147483000, Math.max(30, seconds) * 1000);
    // Discard a request that completed after navigation, a season change or suspension.
    if (liveCentre.controller !== controller || !liveCentreActive() || season !== state.seasonSlug) return;
    liveCentre.rows = meta.status === "ok" ? records : [];
    if (meta.status === "ok") {
      const fetched = Date.parse(meta.fetched_at);
      if (!Number.isFinite(fetched) || Date.now() - fetched > 120000 || fetched - Date.now() > 60000) {
        throw new Error("Stale live snapshot");
      }
    }
    if (meta.status === "ok") ingestMatchweekResults(records);
    renderLiveMatchCentre(meta);
  } catch {
    if (liveCentre.controller !== controller || !liveCentreActive() || season !== state.seasonSlug) return;
    delay = Math.max(delay, 120000);
    liveCentre.rows = [];
    renderLiveMatchCentre({ status: "unavailable", message: "Canlı bağlantı kesildi. Veriler yeniden alındığında maç merkezi güncellenecek." });
  } finally {
    clearTimeout(timeout);
    if (liveCentre.controller === controller) {
      liveCentre.controller = null;
      liveCentre.nextFetch = Date.now() + delay;
      if (liveCentreActive()) liveCentre.timer = setTimeout(syncLiveMatchCentre, delay);
    }
  }
}

// The CANLI pill beside Maç Haftası in the sidebar. On other pages a light
// poll keeps it current; the server caches one live snapshot for every tab,
// so this adds no requests to Sportmonks beyond what the live centre makes.
const navLive = { timer: null, controller: null };

function setNavLive(count) {
  const pill = document.querySelector(".nav-live");
  if (!pill) return;
  pill.hidden = !(count > 0);
  pill.title = count > 0 ? `${count} canlı maç` : "";
}

async function pollNavLive() {
  clearTimeout(navLive.timer);
  let delay = 60000;
  // A visibility change can arrive before core/app.js has defined the page state.
  if (typeof state === "undefined") { navLive.timer = setTimeout(pollNavLive, 3000); return; }
  const local = location.protocol === "http:" && ["127.0.0.1", "localhost"].includes(location.hostname);
  // Maç Haftası polls for itself; a hidden tab or a page without a season waits.
  if (local && !document.hidden && state.seasonSlug && !liveCentreActive()) {
    navLive.controller?.abort();
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 25000);
    navLive.controller = controller;
    try {
      const response = await fetch("/local-live.csv", { cache: "no-store", signal: controller.signal });
      if (!response.ok || response.headers.get("X-Superlig-Season") !== state.seasonSlug) throw new Error("unavailable");
      const { records } = parseCSV(await response.text());
      const meta = records.find((row) => row.record_type === "meta");
      const seconds = number(meta?.poll_seconds);
      if (seconds !== null) delay = Math.max(30, seconds) * 1000;
      setNavLive(meta?.status === "ok"
        ? records.filter((row) => row.record_type === "fixture" && !matchweekFinished(row)).length : 0);
    } catch {
      setNavLive(0);
      delay = 120000;
    } finally {
      clearTimeout(timeout);
      if (navLive.controller === controller) navLive.controller = null;
    }
  }
  navLive.timer = setTimeout(pollNavLive, delay);
}

document.addEventListener("visibilitychange", () => { if (!document.hidden) pollNavLive(); });
setTimeout(pollNavLive, 3000);

function liveMinute(row) {
  const minute = number(row.minute), extra = number(row.extra_minute);
  return minute === null ? "" : `${minute}${extra !== null && extra > 0 ? `+${extra}` : ""}′`;
}

function liveScore(row) {
  const score = (value) => number(value) === null ? "—" : displayNumber(value);
  return `${score(row.home_score)} – ${score(row.away_score)}`;
}

// The standings as they would be if every live match ended with its current
// score. A match counts while it is in play, and after its final whistle until
// the saved fixtures record it as finished - from then on the saved standings
// already include it, and counting it again would add its points twice.
function matchweekLiveStandings(rows) {
  const saved = new Map((state.tables["fixtures.csv"] || []).map((fixture) => [String(fixture.fixture_id), fixture]));
  const teams = new Map();
  for (const game of liveCentre.rows) {
    if (game.record_type !== "fixture") continue;
    const home = number(game.home_score), away = number(game.away_score);
    if (home === null || away === null) continue;
    const stored = saved.get(String(game.fixture_id));
    if (stored && matchweekFinished(stored)) continue;
    for (const [id, own, other, opponent] of [[game.home_team_id, home, away, game.away_name], [game.away_team_id, away, home, game.home_name]]) {
      const status = own > other ? "win" : own < other ? "loss" : "draw";
      teams.set(String(id), { status, gained: { win: 3, draw: 1, loss: 0 }[status], own, other, opponent, live: !matchweekFinished(game) });
    }
  }
  if (!teams.size) return null;
  const view = rows.map((row) => {
    const entry = teams.get(String(row.participant_id)), base = number(row.points) ?? 0;
    const scored = number(row["details.overall_scored"]) ?? 0, conceded = number(row["details.overall_conceded"]) ?? 0;
    const difference = number(row["details.overall_goal_difference"]) ?? scored - conceded;
    return { row, entry: entry && { ...entry, base, points: base + entry.gained },
      points: base + (entry?.gained ?? 0), difference: difference + (entry ? entry.own - entry.other : 0),
      scored: scored + (entry?.own ?? 0), position: number(row.position) ?? 99 };
  });
  view.sort((a, b) => b.points - a.points || b.difference - a.difference || b.scored - a.scored || a.position - b.position);
  return { order: view.map((item) => item.row), teams: new Map(view.filter((item) => item.entry).map((item) => [String(item.row.participant_id), item.entry])) };
}

function renderLiveMatchCentre(meta = liveCentre.rows.find((row) => row.record_type === "meta")) {
  // Every live update redraws Maç Haftası's standings too.
  if (state.view === "matchweek" && $("matchweek-standings-body")) renderStandings(homeTeams(), "matchweek-standings");
  const fixtures = liveCentre.rows.filter((row) => row.record_type === "fixture" && !matchweekFinished(row));
  setNavLive(meta?.status === "ok" ? fixtures.length : 0);
  const panel = $("live-centre"), unavailable = meta?.status === "unavailable";
  panel.hidden = !liveCentreActive() || (!unavailable && !fixtures.length);
  $("live-centre-badge").hidden = unavailable || !fixtures.length;
  $("live-match-content").hidden = unavailable || !fixtures.length;
  $("live-fixture-control").hidden = unavailable || !fixtures.length;
  if (panel.hidden) { $("live-announcement").textContent = ""; return; }
  if (unavailable) {
    $("live-centre-note").textContent = meta.message || "Canlı veriler şu anda alınamıyor.";
    $("live-announcement").textContent = "Canlı maç bağlantısı kullanılamıyor.";
    return;
  }
  if (!fixtures.some((row) => row.fixture_id === liveCentre.selected)) liveCentre.selected = fixtures[0].fixture_id;
  const fixture = fixtures.find((row) => row.fixture_id === liveCentre.selected);
  // One button per live match; rebuilt on each update, keeping keyboard focus.
  const tabs = $("live-fixture-control"), focused = document.activeElement?.dataset?.liveFixture;
  tabs.replaceChildren(...fixtures.map((row) => {
    const tab = element("button", "live-fixture-tab");
    tab.type = "button";
    tab.dataset.liveFixture = row.fixture_id;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(row.fixture_id === fixture.fixture_id));
    tab.setAttribute("aria-controls", "live-match-content");
    tab.append(element("span", "live-fixture-teams", `${row.home_name} ${liveScore(row)} ${row.away_name}`),
      element("span", "live-fixture-minute", [liveStateLabels[row.state] || "", liveMinute(row)].filter(Boolean).join(" · ")));
    tab.addEventListener("click", () => {
      liveCentre.selected = row.fixture_id;
      $("live-events").scrollTop = 0;
      renderLiveMatchCentre();
    });
    return tab;
  }));
  if (focused) tabs.querySelector(`[data-live-fixture="${focused}"]`)?.focus({ preventScroll: true });
  $("live-centre-note").textContent = "";
  const teams = new Map([
    [fixture.home_team_id, { name: fixture.home_name || "Ev sahibi" }],
    [fixture.away_team_id, { name: fixture.away_name || "Deplasman" }],
  ]);
  const club = (id) => {
    const node = element("div", "live-club");
    node.append(createTeamLogo(id, teams, false), element("strong", "", teams.get(id).name));
    return node;
  };
  // The statistic bars carry the two clubs' own colours, as every club comparison does.
  teamColorPair(fixture.home_team_id, fixture.away_team_id)
    .forEach((color, index) => panel.style.setProperty(`--live-${index ? "away" : "home"}`, color));
  const progress = [liveStateLabels[fixture.state] || fixture.state, liveMinute(fixture)].filter(Boolean).join(" · ");
  const score = element("div", "live-score");
  score.append(element("span", "live-match-state", progress), element("strong", "live-score-value", liveScore(fixture)));
  $("live-scoreboard").replaceChildren(club(fixture.home_team_id), score, club(fixture.away_team_id));
  const announcement = `${fixture.home_name} ${liveScore(fixture)} ${fixture.away_name}. ${liveStateLabels[fixture.state] || fixture.state}.`;
  if ($("live-announcement").textContent !== announcement) $("live-announcement").textContent = announcement;
  renderLiveStatistics(fixture);
  renderLiveEvents(fixture, teams);
}

function renderLiveStatistics(fixture) {
  const rows = liveCentre.rows.filter((row) => row.record_type === "statistic" && row.fixture_id === fixture.fixture_id);
  const content = document.createDocumentFragment();
  for (const [type, label, percent] of liveStatistics) {
    const values = [fixture.home_team_id, fixture.away_team_id].map((id) => {
      const matches = rows.filter((row) => row.type_id === String(type) && row.team_id === id);
      const value = matches.length === 1 ? number(matches[0].value) : null;
      return value !== null && value >= 0 && (!percent || value <= 100) ? value : null;
    });
    const row = element("div", "live-stat-row"), heading = element("div", "live-stat-label");
    const text = (value) => value === null ? "—" : percent ? percentText(value) : displayNumber(value);
    heading.append(element("strong", "live-home-value", text(values[0])), element("span", "", label), element("strong", "live-away-value", text(values[1])));
    const bars = element("div", "live-stat-bars");
    bars.setAttribute("aria-hidden", "true");
    const total = values.every((value) => value !== null) ? values[0] + values[1] : 0;
    values.forEach((value, index) => {
      const track = element("span", "live-stat-track"), fill = element("span", index === 0 ? "live-home-bar" : "live-away-bar");
      fill.style.width = `${total > 0 ? value / total * 100 : 0}%`;
      track.append(fill); bars.append(track);
    });
    row.append(heading, bars); content.append(row);
  }
  $("live-statistics").replaceChildren(content);
}

function renderLiveEvents(fixture, teams, rows = liveCentre.rows, list = $("live-events")) {
  const scroll = list.scrollTop;
  const events = rows.filter((row) => row.record_type === "event" && row.fixture_id === fixture.fixture_id)
    // Newest first, by match clock: minute, then stoppage minute (45+3 comes
    // before the second half's 46'), then the provider's order within a minute.
    .sort((a, b) => (number(b.minute) ?? -1) - (number(a.minute) ?? -1)
      || (number(b.extra_minute) ?? 0) - (number(a.extra_minute) ?? 0)
      || (number(b.sort_order) ?? -1) - (number(a.sort_order) ?? -1));
  const content = document.createDocumentFragment();
  for (const event of events) {
    const row = element("li", "live-event"), details = element("div", "live-event-details");
    const code = String(event.code || "").toUpperCase().replace(/[- ]/g, "_");
    const label = liveEventLabels[code] || translateEventText(event.label) || "Maç olayı";
    // The site's one name per player; the feed's own spelling only for someone it does not know.
    const player = event.player_id ? playerName(event.player_id, event.player_name) : event.player_name || "";
    const relatedName = event.related_player_id ? playerName(event.related_player_id, event.related_player_name) : event.related_player_name || "";
    const related = relatedName ? (code === "SUBSTITUTION" ? `Çıkan: ${relatedName}` : `İlgili oyuncu: ${relatedName}`) : "";
    const person = code === "SUBSTITUTION" && player ? `Giren: ${player}` : player;
    const icon = /RED|YELLOW/.test(code) ? "▮" : /GOAL|PENALTY/.test(code) ? "⚽" : code === "SUBSTITUTION" ? "⇄" : "•";
    const symbol = element("span", `live-event-icon ${/RED/.test(code) ? "is-red" : /YELLOW/.test(code) ? "is-yellow" : ""}`, icon);
    symbol.setAttribute("aria-hidden", "true");
    const title = element("strong", "", `${label}${event.result ? ` · ${translateEventText(event.result)}` : ""}`);
    details.append(title, element("span", "", [person, related].filter(Boolean).join(" · ")));
    const extra = [teams.get(event.team_id)?.name, translateEventText(event.info), translateEventText(event.addition),
      /^(true|1)$/i.test(event.rescinded) ? "Geri alındı" : ""].filter(Boolean).join(" · ");
    if (extra) details.append(element("small", "", extra));
    row.append(element("time", "live-event-minute", liveMinute(event) || "—"), symbol, details);
    content.append(row);
  }
  if (!events.length) content.append(element("li", "live-events-empty", fixture.events_available === "1" ? "Henüz kaydedilen maç olayı yok." : "Maç olayları henüz sağlanmadı."));
  list.replaceChildren(content);
  list.scrollTop = scroll;
}

function setupLiveMatchCentre() {
  document.addEventListener("visibilitychange", syncLiveMatchCentre);
  window.addEventListener("pagehide", stopLiveMatchCentre);
  window.addEventListener("pageshow", syncLiveMatchCentre);
}
