"use strict";

// Ana Sayfa: the season's played matches and the league table on the left, and
// one chosen match in the middle: its result, its flow minute by minute, its
// statistics and the two elevens. Local live snapshots use the same dashboard
// as saved matches. The right column contains the events and the assistant.
//
// Shared parts, so every page agrees: standings (renderStandings, also used by
// Maç Haftası), the statistic rule and versus rows (matchweek/results.js), the
// lineup lines (matchweekLineupLines) and the pitch look (styles/pitch.css).
// Minute data (pressure, periods, events) is the copy Takım İstatistikleri
// already reads (teamAnalysisExtras); formations are read here.

const homeExtras = { key: null, state: "idle", formations: null, referees: null };
const homeSelection = { season: "", manual: false, observed: new Map() };
const HOME_REPLAY_PAINT_INTERVAL = 90;
const homeReplay = { fixtureId: null, simulated: false, at: null, context: null, dragging: false, refresh: false, frame: 0, timer: 0 };

function homeTeams() {
  const teams = new Map((state.tables["teams.csv"] || []).map((row) => [row.id, row]));
  for (const row of state.tables["standings.csv"] || []) {
    if (!teams.has(row.participant_id)) teams.set(row.participant_id, { name: row["participant.name"] || `Team ${row.participant_id}`, short_code: row["participant.short_code"] });
  }
  return teams;
}

function standingGroupKey(row) {
  return [row.league_id || "", row.stage_id || "", row.group_id || ""].join(":");
}

// The league table. With `record`, as on Ana Sayfa, each club's played and won
// matches come between its name and its points (Puan Durumu's figures, by the
// same standingFigureCell), and the place reads "1.".
function renderStandings(teams, prefix = "standings", { record = false, snapshot = [], simulated = false, replay = null } = {}) {
  const source = state.tables["standings.csv"] || [];
  const groups = [...new Set(source.map(standingGroupKey))];
  if (!groups.includes(state.standingsGroup)) state.standingsGroup = groups[0] ?? null;
  const select = $(`${prefix}-group`);
  select.replaceChildren();
  for (const key of groups) {
    const row = source.find((item) => standingGroupKey(item) === key);
    select.add(new Option(`${t("Aşama {stage}", { stage: row.stage_id || t("bilinmiyor") })}${row.group_id ? ` · ${t("Grup {group}", { group: row.group_id })}` : ""}`, key));
  }
  select.value = state.standingsGroup || "";
  $(`${prefix}-group-control`).hidden = groups.length <= 1;
  const rows = source.filter((row) => standingGroupKey(row) === state.standingsGroup).sort((a, b) => (number(a.position) ?? Infinity) - (number(b.position) ?? Infinity));
  const count = $(`${prefix}-count`);
  if (count) count.textContent = t("{count} takım", { count: rows.length }, rows.length);
  const live = replay ? homeReplayStandings(replay.fixture, replay.fixture.homeSnapshot.summary, rows)
    : simulated ? homeSimulationStandings(rows)
    : matchweekLiveStandings(rows, prefix === "matchweek-standings" ? undefined : snapshot);
  if (prefix === "standings") {
    const eyebrow = $("home-standings-eyebrow");
    const inPlay = live && [...live.teams.values()].some((entry) => entry.live);
    eyebrow.classList.toggle("home-standings-live-label", Boolean(!replay && inPlay));
    eyebrow.textContent = replay ? t("Maç tekrarı · Geçici") : !live ? t("SÜPER LİG")
      : simulated ? (inPlay ? t("Simülasyon · Canlı") : t("Simülasyon · Geçici"))
      : inPlay ? t("Canlı puan durumu") : t("Geçici puan durumu");
    eyebrow.title = replay ? t("Maç öncesi sonuçlar ve seçilen dakikadaki skor kullanılarak hesaplandı.")
      : live && simulated ? t("Simülasyon · Geçici puan durumu") : "";
  }
  $(`${prefix}-note`).textContent = state.tables["standings.csv"] ? "" : t("Puan tablosu için sezon verilerini yükleyin.");
  let scores = null;
  const body = document.createDocumentFragment();
  const standingsRows = replay ? live?.order || [] : live?.order || rows;
  for (const [index, row] of standingsRows.entries()) {
    const tr = element("tr");
    const club = element("td");
    const identity = createTeamLink(row.participant_id, teamName(row.participant_id, teams), "standing-club");
    const name = element("span", "", teamName(row.participant_id, teams));
    const entry = live?.teams.get(String(row.participant_id));
    identity.replaceChildren(createTeamLogo(row.participant_id, teams, false), name);
    club.append(identity);
    if (record && entry) addStandingMatch(identity, name, entry, teams, `home-standing-match-${row.participant_id}`, !replay);
    const points = element("td", `numeric standing-points${entry ? ` standing-live standing-live-${entry.status}` : ""}`,
      displayNumber(entry ? entry.points : row.points));
    if (entry) points.title = `${displayNumber(entry.base)} + ${entry.gained} · ${entry.own}–${entry.other} ${entry.opponent} (${entry.live ? t("sürüyor") : t("bitti, kayda girmedi")})`;
    const place = displayNumber(live ? index + 1 : row.position);
    tr.append(element("td", "standing-position", record && place !== "—" ? `${place}.` : place), club);
    if (record) {
      const results = () => standingResults(row, scores ??= currentFixtureScores());
      tr.append(standingFigureCell(row, "overall_matches", "played", results, entry?.played),
        standingFigureCell(row, "overall_wins", "wins", results, entry?.won));
    }
    tr.append(points);
    body.append(tr);
  }
  if (!standingsRows.length) {
    const tr = element("tr"), td = element("td", "no-results", replay ? t("Bu maç için geçmiş puan durumu oluşturulamadı.")
      : state.tables["standings.csv"] ? t("Bu dosyada puan durumu yok.") : t("Puan tablosu burada görünecek."));
    td.colSpan = record ? 5 : 3; tr.append(td); body.append(tr);
  }
  $(`${prefix}-body`).replaceChildren(body);
}

// Saved scores of one kind, by "fixture:team": CURRENT (the result, the
// default) or 1ST_HALF (the half-time score).
function currentFixtureScores(description = "CURRENT") {
  const scores = new Map();
  for (const row of state.tables["fixture_scores.csv"] || []) {
    if (row.description !== description) continue;
    const key = `${row.fixture_id}:${row.participant_id}`;
    const value = number(row["score.goals"]);
    // A conflicting duplicate is unknown, not a licence to invent a score.
    if (scores.has(key) && scores.get(key) !== value) scores.set(key, null);
    else scores.set(key, value);
  }
  return scores;
}

async function loadHomeExtras() {
  const key = state.seasonSlug;
  if (!key || homeExtras.key === key) return;
  Object.assign(homeExtras, { key, state: "loading", formations: null, referees: null });
  const [formations, referees] = await Promise.all([
    readFantasyCSV("fixture_formations.csv", ["fixture_id", "participant_id", "formation"], key, true).catch(() => null),
    readFantasyCSV("fixture_referees.csv", ["fixture_id", "referee_id", "type_id"], key, true).catch(() => null),
  ]);
  if (homeExtras.key !== key) return;
  Object.assign(homeExtras, { state: "ready", formations, referees });
  if (state.view === "home" && state.seasonSlug === key) renderHome();
}

// ------------------------------------------------------------ match selection

function homeScoreValue(value) {
  const score = number(value);
  return Number.isInteger(score) && score >= 0 ? score : null;
}

function homeScoreText(score) {
  return score.map(displayNumber).join(" – ");
}

function homeSnapshotGames() {
  if (homeSelection.season !== state.seasonSlug || !state.homeFixture) {
    if (homeSelection.season !== state.seasonSlug) homeSelection.observed.clear();
    homeSelection.season = state.seasonSlug;
    homeSelection.manual = false;
  }
  const simulated = siteMode === "local" && homeSimulationActive();
  const feed = simulated ? homeSimulationRows() : siteMode === "local" && state.seasonSlug ? liveCentre.rows : [];
  const byFixture = new Map();
  for (const row of feed) {
    if (!row.fixture_id) continue;
    if (!byFixture.has(row.fixture_id)) byFixture.set(row.fixture_id, []);
    byFixture.get(row.fixture_id).push(row);
  }

  const scores = currentFixtureScores();
  const games = [], standings = [];
  for (const fixture of state.tables["fixtures.csv"] || []) {
    const id = fixture.fixture_id;
    const savedScore = [fixture.home_team_id, fixture.away_team_id].map((team) => homeScoreValue(scores.get(`${id}:${team}`)));
    const savedFinished = fixtureFinished(fixture);
    const useConfirmed = !simulated && siteMode === "local" && (!savedFinished || savedScore.includes(null));
    const rows = byFixture.get(id) || (useConfirmed ? matchweekCompletedSnapshot(fixture) : null);
    const summaries = rows?.filter((row) => row.record_type === "fixture") || [];
    const summary = summaries[0];
    const match = summaries.length === 1 && ["league_id", "season_id", "home_team_id", "away_team_id"]
      .every((key) => String(summary[key]) === String(fixture[key]));
    if (match && (simulated || !savedFinished || (savedScore.includes(null) && matchweekFinished(summary)))) {
      const inPlay = !matchweekFinished(summary);
      if (inPlay && !simulated) homeSelection.observed.set(id, Date.now());
      if (!inPlay && !simulated) homeSelection.observed.delete(id);
      const snapshot = { rows, summary, inPlay, simulated };
      games.push({ fixture: { ...fixture, homeSnapshot: snapshot }, score: [homeScoreValue(summary.home_score), homeScoreValue(summary.away_score)] });
      if (!savedFinished || simulated) standings.push(summary);
      continue;
    }
    if (savedFinished) {
      homeSelection.observed.delete(id);
      if (!savedScore.includes(null)) games.push({ fixture, score: savedScore });
    } else if (!simulated && id === state.homeFixture && Date.now() - homeSelection.observed.get(id) < 10 * 60000) {
      // The in-play row can disappear before the fixture endpoint confirms the
      // result. Keep the selected match open and clear its old live figures.
      games.push({ fixture: { ...fixture, homeSnapshot: { rows: [], pending: true } }, score: [null, null] });
    }
  }
  games.sort((a, b) => kickoffTime(b.fixture) - kickoffTime(a.fixture) || String(b.fixture.fixture_id).localeCompare(String(a.fixture.fixture_id)));
  return { games, standings, simulated };
}

function homeGameStatus(fixture) {
  const snapshot = fixture.homeSnapshot;
  if (snapshot?.replay) return t("Maç tekrarı · {minute}", { minute: homePressureClock(snapshot.replay.at, snapshot.replay.firstHalf) });
  if (snapshot?.pending) return t("Maç durumu bekleniyor");
  if (!snapshot) return fixtureStateLabel(fixture);
  const summary = snapshot.summary;
  const status = liveStateLabels[summary.state] || fixtureStateLabel({ state: summary.state });
  return [snapshot.simulated ? t("Simülasyon") : snapshot.inPlay ? t("CANLI") : "", status, liveMinute(summary)].filter(Boolean).join(" · ");
}

const homeShortDate = new Intl.DateTimeFormat(LOCALE, { timeZone: MATCH_TIME_ZONE, day: "numeric", month: "short" });
const homeLongDate = new Intl.DateTimeFormat(LOCALE, { timeZone: MATCH_TIME_ZONE, day: "numeric", month: "long", weekday: "long" });

function homeShortName(id, teams) {
  return teams.get(id)?.short_code || teamName(id, teams);
}

// The season's matchweeks in kickoff order, each { key, name, fixtures }, as
// Maç Tribünü lists them.
function homeWeeks() {
  const fixtures = [...(state.tables["fixtures.csv"] || [])]
    .sort((a, b) => String(a.kickoff || "9999").localeCompare(String(b.kickoff || "9999")));
  const weeks = new Map();
  for (const fixture of fixtures) {
    const key = String(fixture.round_id || fixture["round.id"] || fixture["round.name"] || "");
    if (!weeks.has(key)) weeks.set(key, { key, name: fixture["round.name"] ? t("{round}. Hafta", { round: fixture["round.name"] }) : t("Haftası belirsiz"), fixtures: [] });
    weeks.get(key).fixtures.push(fixture);
  }
  return [...weeks.values()];
}

// The chosen week's matches, earliest first. It opens on the current week
// (currentRoundIndex, the rule every page uses) and stays where the visitor
// puts it until the data reloads. Live matches from another week are also
// selectable, without resetting the week the visitor is browsing.
function renderHomeGames(games, teams) {
  const weeks = homeWeeks();
  if (!weeks.some((week) => week.key === state.homeWeek)) state.homeWeek = weeks[currentRoundIndex(weeks)]?.key ?? null;
  const select = $("home-games-week");
  select.replaceChildren(...weeks.map((week) => new Option(week.name, week.key)));
  if (!weeks.length) select.add(new Option(t("Yüklü hafta yok"), ""));
  select.disabled = !weeks.length;
  select.value = state.homeWeek ?? "";
  const index = weeks.findIndex((week) => week.key === state.homeWeek);
  $("home-week-prev").disabled = index <= 0;
  $("home-week-next").disabled = index < 0 || index >= weeks.length - 1;
  const played = new Map(games.map((game) => [game.fixture.fixture_id, game]));
  const inWeek = weeks[index]?.fixtures || [];
  const ids = new Set(inWeek.map((fixture) => fixture.fixture_id));
  const outsideWeek = games.filter(({ fixture }) => fixture.homeSnapshot?.inPlay && !ids.has(fixture.fixture_id)).map(({ fixture }) => fixture);
  const fixtures = [...outsideWeek, ...inWeek];
  const unavailable = siteMode === "local" && !homeSimulationActive() && liveCentre.meta?.status === "unavailable";
  $("home-games-note").textContent = unavailable ? t("Canlı veriler şu anda alınamıyor.")
    : state.tables["fixtures.csv"] ? "" : t("Maçları görmek için sezon verilerini yükleyin.");
  const focused = document.activeElement?.dataset.fixture;
  const list = document.createDocumentFragment();
  for (const fixture of fixtures) {
    const time = kickoffTime(fixture);
    const when = Number.isFinite(Number(time)) ? `${homeShortDate.format(time)} · ${kickoffClock(fixture)}` : t("Tarih belli değil");
    const game = played.get(fixture.fixture_id);
    if (!game) {
      const row = element("div", "home-game home-game-upcoming");
      row.setAttribute("aria-label", `${teamName(fixture.home_team_id, teams)} – ${teamName(fixture.away_team_id, teams)}, ${when}, ${t("henüz oynanmadı")}`);
      row.append(element("span", "home-game-meta", when), homeGameLine(fixture, teams, "–"));
      list.append(row);
      continue;
    }
    const selected = fixture.fixture_id === state.homeFixture;
    const button = element("button", "home-game");
    button.type = "button";
    button.dataset.fixture = fixture.fixture_id;
    button.setAttribute("aria-pressed", String(selected));
    button.setAttribute("aria-controls", "home-detail");
    button.append(element("span", "home-game-meta"), homeGameLine(fixture, teams, ""));
    updateHomeGameButton(button, game, teams, when);
    list.append(button);
  }
  const gamesList = $("home-games-list");
  gamesList.classList.toggle("has-other-week", outsideWeek.length > 0);
  gamesList.style.setProperty("--home-week-games", Math.max(1, inWeek.length));
  gamesList.replaceChildren(list);
  if (focused) gamesList.querySelector(`[data-fixture="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}

function updateHomeGameButton(button, game, teams, kickoff) {
  if (!button) return;
  const { fixture, score } = game;
  const snapshot = fixture.homeSnapshot;
  const when = kickoff ?? button.dataset.kickoff;
  button.dataset.kickoff = when;
  const status = snapshot ? homeGameStatus(fixture) : when;
  const text = homeScoreText(score);
  const scoreNode = button.querySelector(".home-game-score");
  if (scoreNode.textContent !== text) scoreNode.textContent = text;
  const meta = button.querySelector(".home-game-meta");
  if (meta.textContent !== status) meta.textContent = status;
  button.classList.toggle("home-game-live", Boolean(snapshot?.inPlay || snapshot?.simulated));
  const label = `${teamName(fixture.home_team_id, teams)} ${text} ${teamName(fixture.away_team_id, teams)}, ${status}`;
  if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);
}

// Home logo and code, the score (or a dash), away code and logo.
function homeGameLine(fixture, teams, middle) {
  const line = element("span", "home-game-line");
  for (const [index, id] of [fixture.home_team_id, fixture.away_team_id].entries()) {
    const club = element("span", `home-game-team${index ? " home-game-away" : ""}`);
    const logo = createTeamLogo(id, teams, false), code = element("span", "", homeShortName(id, teams));
    club.append(...(index ? [code, logo] : [logo, code]));
    line.append(club);
    if (!index) line.append(element("strong", "home-game-score", middle));
  }
  return line;
}

// ------------------------------------------------------------- match detail

function homeCard(className, eyebrow, title) {
  const card = element("section", `home-panel home-card ${className}`);
  const heading = element("div", "home-panel-heading");
  const titles = element("div");
  const id = `${className}-title`;
  const h2 = element("h2", "", title);
  h2.id = id;
  titles.append(element("p", "eyebrow", eyebrow), h2);
  heading.append(titles);
  card.setAttribute("aria-labelledby", id);
  card.append(heading);
  return card;
}

const HOME_WEATHER = {
  "clear sky": t("Açık"), "few clouds": t("Az bulutlu"), "scattered clouds": t("Parçalı bulutlu"), "broken clouds": t("Çok bulutlu"),
  "overcast clouds": t("Kapalı"), "light rain": t("Hafif yağmur"), "moderate rain": t("Yağmurlu"), "rain": t("Yağmurlu"),
  "heavy intensity rain": t("Şiddetli yağmur"), "shower rain": t("Sağanak"), "light intensity shower rain": t("Hafif sağanak"),
  "thunderstorm": t("Gök gürültülü"), "snow": t("Karlı"), "light snow": t("Hafif kar"), "mist": t("Sisli"), "fog": t("Sisli"),
  "haze": t("Puslu"), "drizzle": t("Çisenti"), "light intensity drizzle": t("Çisenti"),
};

// "12°C · Kapalı" from the fixture's Sportmonks weather report; a description
// with no word of the site's own here is left out rather than shown as sent.
function homeWeather(fixture) {
  const temperature = number(fixture["weatherreport.current.temp"]) ?? number(fixture["weatherreport.temperature.current"]);
  const metric = String(fixture["weatherreport.metric"] || "").toLowerCase();
  const description = HOME_WEATHER[String(fixture["weatherreport.current.description"] || fixture["weatherreport.description"] || "").toLowerCase()];
  const parts = [temperature !== null && /^cel[cs]ius$/.test(metric) ? `${Math.round(temperature)}°C` : "", description || ""].filter(Boolean);
  return parts.join(" · ");
}

function homeFormation(fixture, teamId) {
  const snapshot = fixture.homeSnapshot;
  const rows = snapshot ? snapshot.rows.filter((row) => row.record_type === "formation" && row.team_id === teamId)
    : (homeExtras.formations || []).filter((row) => row.fixture_id === fixture.fixture_id && row.participant_id === teamId);
  return rows.length === 1 && /^\d(-\d){1,4}$/.test(rows[0].formation || "") ? rows[0].formation : "";
}

// The match's referee from fixture_referees.csv: Sportmonks lists four
// officials a match, and type 6 is the referee (7 and 8 the assistants, 9 the
// fourth official). Exports made before the downloader asked for the
// officials' details have ids only; then, or if there is not exactly one
// referee, nothing is shown.
const HOME_REFEREE_TYPE = "6";
function homeReferee(fixture) {
  const rows = (homeExtras.referees || []).filter((row) => row.fixture_id === fixture.fixture_id && row.type_id === HOME_REFEREE_TYPE);
  if (rows.length !== 1) return "";
  const row = rows[0];
  return String(row["referee.display_name"] || row["referee.common_name"] || row["referee.name"] || "").trim();
}

// Stadium photos (assets/stadiums/) by Sportmonks venue id: the ground a
// match was played at, not the home club, so a club playing away from its own
// ground shows that ground or none. Two grounds have a second Sportmonks
// record that is the same stadium under another name:
//   2090   "Seyrantepe Spor Kompleksi Stadyumu 1" (Diyarbakır), where most of
//          Amed SK's home games are filed; the photo is Diyarbakır Stadyumu.
//   181426 "Kazım Karabekir Stadı Yanı 2 Nolu Sentetik Çim Sahası", filed
//          with the stadium's 23,700 capacity for Erzurumspor's played games.
const HOME_STADIUM_PHOTOS = {
  148509: "samsunspor", 72011: "gaziantep-fk", 171292: "rizespor", 72107: "alanyaspor",
  4693: "amed-sk", 2090: "amed-sk", 1886: "eyupspor", 340174: "goztepe", 9695: "fenerbahce",
  9667: "galatasaray", 9606: "erzurumspor-fk", 181426: "erzurumspor-fk", 316385: "genclerbirligi",
  9628: "kocaelispor", 214665: "trabzonspor", 340175: "besiktas", 9633: "corum-fk",
  2168: "istanbul-basaksehir", 71803: "konyaspor", 417: "kasimpasa",
};

function renderHomeScoreboard(game, teams) {
  const { fixture } = game;
  const card = element("section", "home-panel home-card home-scoreboard");
  const photo = HOME_STADIUM_PHOTOS[fixture.venue_id || fixture["venue.id"]];
  if (photo) {
    card.classList.add("home-scoreboard-photo");
    // A full address: a url() passed through a custom property would be read
    // relative to home.css, not to the page.
    card.style.setProperty("--home-stadium", `url("${new URL(`assets/stadiums/${photo}-stadium.jpg`, document.baseURI).href}")`);
  }
  const grid = element("div", "home-score-grid");
  const side = (id, index) => {
    const box = element("div", `home-score-team${index ? " home-score-away" : ""}`);
    const name = createTeamLink(id, teamName(id, teams), "home-score-name");
    box.append(createTeamLogo(id, teams, true), name, element("span", "home-score-role"));
    return box;
  };
  const middle = element("div", "home-score-middle");
  middle.append(element("strong", "home-score-value"), element("span", "home-score-state"));
  grid.append(side(fixture.home_team_id, 0), middle, side(fixture.away_team_id, 1));
  card.append(grid);
  const venue = [fixture["venue.name"], fixture["venue.city_name"]].filter(Boolean).join(" · ");
  card.append(element("p", "home-score-venue", venue));
  const chips = element("div", "home-chips");
  const round = fixture["round.name"] ? `${t("{round}. hafta", { round: fixture["round.name"] })} · ` : "";
  const kickoff = kickoffTime(fixture);
  if (Number.isFinite(Number(kickoff))) chips.append(element("span", "home-chip", `${round}${homeLongDate.format(kickoff)} ${kickoffClock(fixture)}`));
  const referee = homeReferee(fixture);
  if (referee) chips.append(element("span", "home-chip", t("Hakem: {name}", { name: referee })));
  const weather = homeWeather(fixture);
  if (weather) chips.append(element("span", "home-chip", weather));
  card.append(chips);
  updateHomeScoreboard(card, game, teams);
  return card;
}

function updateHomeScoreboard(card, game, teams) {
  const { fixture, score } = game;
  const snapshot = fixture.homeSnapshot;
  const sides = [fixture.home_team_id, fixture.away_team_id];
  const scoreText = homeScoreText(score), status = homeGameStatus(fixture);
  const half = snapshot ? null : currentFixtureScores("1ST_HALF");
  const halfSummary = snapshot?.summary?.state === "INPLAY_1ST_HALF" ? null : snapshot?.summary;
  const halfScore = (snapshot ? [halfSummary?.home_half_score, halfSummary?.away_half_score]
    : sides.map((team) => half.get(`${fixture.fixture_id}:${team}`))).map(homeScoreValue);
  const halfText = halfScore.includes(null) ? "" : ` · ${t("İY {score}", { score: halfScore.map(displayNumber).join("–") })}`;
  const value = card.querySelector(".home-score-value"), clock = card.querySelector(".home-score-state");
  if (value.textContent !== scoreText) value.textContent = scoreText;
  if (clock.textContent !== status + halfText) clock.textContent = status + halfText;
  card.setAttribute("aria-label", `${teamName(sides[0], teams)} ${scoreText} ${teamName(sides[1], teams)} · ${status}`);
  card.querySelectorAll(".home-score-role").forEach((role, index) => {
    const formation = homeFormation(fixture, sides[index]);
    const text = `${index ? t("Deplasman") : t("Ev sahibi")}${formation ? ` · ${formation}` : ""}`;
    if (role.textContent !== text) role.textContent = text;
  });
}

// ----------------------------------------------------------------- momentum

const HOME_SVG = "http://www.w3.org/2000/svg";
function homeSvg(parent, tag, attributes = {}, text) {
  const node = document.createElementNS(HOME_SVG, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  if (parent) parent.append(node);
  return node;
}

const HOME_GOALS = new Set(["GOAL", "PENALTY", "OWNGOAL"]);
const HOME_CARDS = new Set(["YELLOWCARD", "REDCARD", "YELLOWREDCARD"]);

// A match minute on the pressure chart's clock. The feed counts pressure
// minutes straight through stoppage time, so a second-half minute is placed
// after the first half's real length.
function homeChartTime(minute, extra, firstHalf, total) {
  const at = minute <= 45 ? Math.min(minute + extra, firstHalf) : firstHalf + (minute - 45) + extra;
  return Math.max(0, Math.min(at, total));
}

function homeEventRows(fixture) {
  const snapshot = fixture.homeSnapshot;
  if (snapshot) return snapshot.rows.filter((row) => row.record_type === "event");
  return (teamAnalysisExtras.events || []).filter((row) => String(row.fixture_id) === String(fixture.fixture_id)).map((event) => ({
    ...event, record_type: "event", event_id: String(event.event_id || event.id || ""),
    code: event["type.developer_name"], label: event["type.name"], team_id: String(event.participant_id || event.team_id || ""),
  }));
}

// This match's goals, cards and substitutions on the pressure chart's clock.
function homeMatchEvents(fixture, firstHalf, total) {
  const sides = [String(fixture.home_team_id), String(fixture.away_team_id)];
  const events = [];
  for (const event of homeEventRows(fixture)) {
    const code = String(event.code || "").toUpperCase().replace(/[- ]/g, "_");
    const kind = code === "OWN_GOAL" ? "OWNGOAL" : code;
    if (!HOME_GOALS.has(kind) && !HOME_CARDS.has(kind) && kind !== "SUBSTITUTION") continue;
    if (["true", "1"].includes(String(event.rescinded).toLowerCase())) continue;
    const team = event.team_id, minute = number(event.minute), extra = number(event.extra_minute) || 0;
    if (!sides.includes(team) || minute === null) continue;
    events.push({ kind, home: team === sides[0], at: homeChartTime(minute, extra, firstHalf, total), sort: number(event.sort_order) ?? 0,
      clock: `${minute}${extra ? `+${extra}` : ""}'`, player: playerName(event.player_id, event.player_name),
      related: event.related_player_name ? playerName(event.related_player_id, event.related_player_name) : "",
      result: String(event.result || "").replace("-", "–") });
  }
  return events.sort((a, b) => a.at - b.at || a.sort - b.sort);
}

// A pressure minute as the match clock: 45+1' in first-half stoppage time,
// 90+3' in the second.
function homePressureClock(minute, firstHalf) {
  if (minute <= firstHalf) return minute <= 45 ? `${minute}'` : `45+${minute - 45}'`;
  const clock = 45 + minute - firstHalf;
  return clock <= 90 ? `${clock}'` : `90+${clock - 90}'`;
}

function homeEventText(event) {
  const label = liveEventLabels[event.kind] || event.kind;
  if (event.kind === "SUBSTITUTION") {
    return `${event.clock} · ${label}: ${event.related ? t("{player} girdi, {related} çıktı", { player: event.player, related: event.related }) : t("{player} girdi", { player: event.player })}`;
  }
  const assist = HOME_GOALS.has(event.kind) && event.kind !== "OWNGOAL" && event.related ? ` · ${t("Asist: {name}", { name: event.related })}` : "";
  return `${event.clock} · ${label}${event.result && HOME_GOALS.has(event.kind) ? ` ${event.result}` : ""} · ${event.player}${assist}`;
}

// This match's pressure index for both sides, minute by minute: [minute, home,
// away] for every minute that has both. The first half's real length (from
// fixture_periods, else guessed from the last minute) puts a minute on the
// match clock. A message instead while the files load, or when there is none.
function homePressure(fixture) {
  const snapshot = fixture.homeSnapshot;
  if (snapshot?.replay) {
    const { at, firstHalf, total, minutes, message } = snapshot.replay;
    return { firstHalf, total, minutes: minutes.filter(([minute]) => minute <= at), message };
  }
  if (!snapshot && (teamAnalysisExtras.key !== state.seasonSlug || teamAnalysisExtras.state !== "ready")) return { message: t("Baskı verisi yükleniyor…") };
  if (!snapshot && !teamAnalysisExtras.pressure) return { message: t("fixture_pressure.csv okunamadı.") };
  const id = String(fixture.fixture_id), home = String(fixture.home_team_id), away = String(fixture.away_team_id);
  const rows = snapshot ? snapshot.rows.filter((row) => row.record_type === "pressure") : teamAnalysisExtras.pressure;
  const byMinute = new Map();
  for (const row of rows) {
    if (String(row.fixture_id) !== id) continue;
    const minute = number(row.minute), value = number(snapshot ? row.value : row.pressure);
    if (minute === null || minute < 1 || value === null) continue;
    if (!byMinute.has(minute)) byMinute.set(minute, new Map());
    byMinute.get(minute).set(String(snapshot ? row.team_id : row.participant_id), value);
  }
  const minutes = [...byMinute].filter(([, values]) => values.has(home) && values.has(away))
    .map(([minute, values]) => [minute, values.get(home), values.get(away)]).sort((a, b) => a[0] - b[0]);
  if (!minutes.length) return { message: t("Bu maç için baskı verisi yok.") };
  const last = minutes[minutes.length - 1][0];
  const period = snapshot ? snapshot.rows.find((row) => row.record_type === "period" && row.code === "1ST_HALF")
    : (teamAnalysisExtras.periods || []).find((row) => String(row.fixture_id) === id && String(row.description || "").toLowerCase().includes("1st"));
  const clock = number(snapshot?.summary?.minute);
  const extra = number(snapshot?.summary?.extra_minute) ?? 0;
  const firstHalf = snapshot ? Math.max(45, number(period?.minute) ?? 0, snapshot.summary?.state === "INPLAY_1ST_HALF" && clock !== null ? clock + extra : 0)
    : number(period?.minutes) ?? 45 + Math.max(0, Math.round((last - 90) / 2));
  const current = clock === null ? 0 : homeChartTime(clock, extra, firstHalf, Infinity);
  const total = Math.max(last, firstHalf + 45, current);
  const through = snapshot?.inPlay ? Math.max(last, current) : total;
  return { minutes, firstHalf, total, through };
}

function homeReplayTimeline(fixture) {
  const pressure = homePressure(fixture);
  const snapshot = fixture.homeSnapshot;
  const periods = snapshot ? snapshot.rows.filter((row) => row.record_type === "period")
    : (teamAnalysisExtras.periods || []).filter((row) => String(row.fixture_id) === String(fixture.fixture_id));
  const periodMinute = (code) => {
    const period = periods.find((row) => String(row.code || row.description).toUpperCase().replace(/[- ]/g, "_").includes(code));
    return number(period?.minute ?? period?.minutes);
  };
  const firstHalf = Math.max(45, pressure.firstHalf ?? 0, periodMinute("1ST") ?? 0);
  const secondHalf = periodMinute("2ND");
  const normalEnd = Math.max(pressure.total ?? 0, firstHalf + 45, secondHalf === null ? 0 : firstHalf + secondHalf - 45);
  const total = snapshot ? normalEnd : homeHistoricalReplayDuration(fixture, normalEnd);
  const clock = number(snapshot?.summary?.minute);
  const current = clock === null ? 0 : homeChartTime(clock, number(snapshot.summary.extra_minute) ?? 0, firstHalf, total);
  const atBreak = snapshot?.summary?.state === "HT" ? firstHalf : 0;
  const through = snapshot?.inPlay || snapshot?.pending ? Math.max(pressure.through ?? 0, current, atBreak) : total;
  const liveAt = snapshot?.inPlay ? (clock === null ? atBreak || through : current) : null;
  return { ...pressure, firstHalf, total, through, liveAt, minutes: pressure.minutes || [] };
}

// The chart alone, with no title row, so all of the card is chart; how to read
// it is the chart's hover text.
function renderHomeMomentum(fixture, teams, timeline) {
  const card = element("section", "home-panel home-card home-momentum");
  card.setAttribute("aria-label", t("Maçın akışı: baskı dengesi"));
  const pressure = timeline;
  const home = String(fixture.home_team_id), away = String(fixture.away_team_id);
  const { firstHalf = 45, total = 90, minutes = [] } = pressure;
  const balance = minutes.map(([minute, own, other]) => [minute, own - other]);
  const events = homeMatchEvents(fixture, firstHalf, total);
  const [homeColor, awayColor] = teamColorPair(fixture.home_team_id, fixture.away_team_id);

  // A low strip: minute ticks, the pressure bars (home above the line, away
  // below), then a lane each for the two sides' cards and substitutions.
  const width = 640, left = 30, right = 6, top = 12, half = 30, middle = top + half, bottom = middle + half;
  const laneHome = bottom + 8, laneAway = laneHome + 10, height = laneAway + 6;
  const reach = Math.max(10, ...balance.map(([, value]) => Math.abs(value)));
  const x = (at) => left + (at / total) * (width - left - right);
  const slot = (width - left - right) / total;
  const svg = homeSvg(null, "svg", { viewBox: `0 0 ${width} ${height}`, role: "img", class: "home-momentum-chart",
    "aria-label": t("{home} – {away} baskı dengesi, dakika dakika. Üstte {home}, altta {away} üstün.", { home: teamName(home, teams), away: teamName(away, teams) }) });
  // Hovering the chart anywhere but a mark explains how to read it.
  homeSvg(svg, "title", {}, [
    t("Sportmonks baskı endeksinde {home} ile {away} arasındaki fark, dakika dakika.", { home: teamName(home, teams), away: teamName(away, teams) }),
    t("Çubuk üstteyse ev sahibi, alttaysa deplasman takımı o dakikada üstündü. Kesik çizgi devre arası; uzatma dakikaları kendi devresinde gösterilir."),
    t("Toplar gol, sarı ve kırmızı dikdörtgenler kart, ⇄ oyuncu değişikliği. Ayrıntı için bir işaretin üzerine gelin."),
  ].join(" "));
  homeSvg(svg, "rect", { x: left, y: top, width: width - left - right, height: half, fill: homeColor, opacity: 0.08 });
  homeSvg(svg, "rect", { x: left, y: middle, width: width - left - right, height: half, fill: awayColor, opacity: 0.08 });
  for (const [minute, value] of balance) {
    if (!value) continue;
    const h = (Math.abs(value) / reach) * (half - 1);
    const bar = homeSvg(svg, "rect", { "data-replay-at": minute, x: x(minute - 1) + slot * 0.1, y: value > 0 ? middle - h : middle, width: slot * 0.8, height: h,
      fill: value > 0 ? homeColor : awayColor, rx: 0.5 });
    homeSvg(bar, "title", {}, `${homePressureClock(minute, firstHalf)} · ${homeShortName(value > 0 ? home : away, teams)} +${displayNumber(Math.abs(value))}`);
  }
  homeSvg(svg, "line", { x1: left, y1: middle, x2: width - right, y2: middle, class: "home-momentum-axis" });
  homeSvg(svg, "line", { x1: x(firstHalf), y1: top, x2: x(firstHalf), y2: bottom, class: "home-momentum-half" });
  for (const [label, at] of [["0'", 0], ["15'", 15], ["30'", 30], ["45'", 45], ["60'", firstHalf + 15], ["75'", firstHalf + 30], ["90'", firstHalf + 45]]) {
    homeSvg(svg, "text", { x: x(at), y: top - 3, "text-anchor": at ? "middle" : "start", class: "home-momentum-tick" }, label);
  }
  homeSvg(svg, "text", { x: 0, y: top + 9, class: "home-momentum-team" }, homeShortName(home, teams));
  homeSvg(svg, "text", { x: 0, y: bottom - 2, class: "home-momentum-team" }, homeShortName(away, teams));
  homeSvg(svg, "text", { x: 0, y: laneHome + 3, class: "home-momentum-lane" }, homeShortName(home, teams));
  homeSvg(svg, "text", { x: 0, y: laneAway + 3, class: "home-momentum-lane" }, homeShortName(away, teams));
  // A goal's label goes on the first row, counted inward from its edge of the
  // chart, where it does not run into an earlier label on the same side.
  const labelRows = [[], []];
  for (const event of events) {
    const cx = x(event.at), color = event.home ? homeColor : awayColor;
    if (HOME_GOALS.has(event.kind)) {
      const group = homeSvg(svg, "g", { class: "home-momentum-goal", "data-replay-at": event.at });
      homeSvg(group, "title", {}, homeEventText(event));
      homeSvg(group, "line", { x1: cx, y1: top, x2: cx, y2: bottom, stroke: color, opacity: 0.7 });
      const cy = event.home ? top + 5 : bottom - 5;
      homeSvg(group, "circle", { cx, cy, r: 4.5, fill: color, class: "home-momentum-ball" });
      const label = `${event.clock} ${event.result}`.trim(), span = label.length * 5.6 + 8;
      const end = cx > width - right - span;
      const from = end ? cx - span : cx, to = end ? cx : cx + span;
      const rows = labelRows[event.home ? 0 : 1];
      let row = rows.findIndex((taken) => taken.every(([a, b]) => to < a || from > b));
      if (row < 0) { row = rows.length; rows.push([]); }
      rows[row].push([from, to]);
      const y = cy + 3.5 + (event.home ? 1 : -1) * row * 12;
      homeSvg(group, "text", { x: end ? cx - 7 : cx + 7, y, "text-anchor": end ? "end" : "start", class: "home-momentum-label" }, label);
      continue;
    }
    const lane = event.home ? laneHome : laneAway;
    const group = homeSvg(svg, "g", { "data-replay-at": event.at });
    homeSvg(group, "title", {}, homeEventText(event));
    if (event.kind === "SUBSTITUTION") {
      homeSvg(group, "text", { x: cx, y: lane + 3, "text-anchor": "middle", class: "home-momentum-sub" }, "⇄");
    } else {
      homeSvg(group, "rect", { x: cx - 3, y: lane - 4.5, width: 6, height: 9, rx: 1,
        class: event.kind === "YELLOWCARD" ? "home-card-yellow" : event.kind === "REDCARD" ? "home-card-red" : "home-card-second" });
    }
  }
  // Keep the range input in place while repainting the replayed panels.
  const marker = homeSvg(svg, "line", { x1: 0, y1: top - 2, x2: 0, y2: height, class: "home-momentum-cursor", visibility: "hidden" });
  const slider = element("input", "home-momentum-slider");
  Object.assign(slider, { type: "range", min: 0, max: total, step: 1, value: homeReplay.at ?? pressure.through });
  slider.setAttribute("aria-label", t("Maçın tekrar dakikasını seç"));
  slider.style.setProperty("--plot-left", `${(left / width) * 100}%`);
  slider.style.setProperty("--plot-right", `${(right / width) * 100}%`);
  const summary = fixture.homeSnapshot?.summary;
  const liveClock = pressure.liveAt === null ? "" : liveMinute(summary) ||
    (summary.state === "HT" ? t("Devre arası") : pressure.liveAt ? homePressureClock(pressure.liveAt, firstHalf) : "");
  const liveLabel = liveClock ? t("CANLI · {minute}", { minute: liveClock }) : "";
  const mark = () => {
    const at = Math.min(Number(slider.value), pressure.through);
    slider.value = at;
    marker.setAttribute("x1", x(at));
    marker.setAttribute("x2", x(at));
    marker.setAttribute("visibility", at < pressure.through ? "visible" : "hidden");
    const viewedMinute = at < pressure.through ? homePressureClock(at, firstHalf) : t("En güncel maç görünümü");
    slider.setAttribute("aria-valuetext", [viewedMinute, liveLabel].filter(Boolean).join(" · "));
    return at;
  };
  slider.addEventListener("pointerdown", () => { homeReplay.dragging = true; });
  slider.addEventListener("input", () => {
    const at = mark();
    homeReplay.at = at < pressure.through ? at : null;
    if (homeReplay.at !== null && !fixture.homeSnapshot?.simulated) loadHomeReplayHistory();
    queueHomeReplayPaint();
  });
  const track = element("div", "home-momentum-track");
  track.append(svg, slider);
  if (liveLabel) {
    const live = element("span", "home-momentum-live");
    live.setAttribute("aria-hidden", "true");
    live.style.setProperty("--live-position", `${x(pressure.liveAt) / width * 100}%`);
    live.append(element("span", "home-momentum-live-label", liveLabel));
    track.append(live);
  }
  const scroll = element("div", "home-momentum-scroll");
  scroll.append(track);
  // Screen readers get the match's goals and dismissals as a list.
  const key = element("ol", "sr-only");
  for (const event of events.filter((item) => HOME_GOALS.has(item.kind) || item.kind === "REDCARD" || item.kind === "YELLOWREDCARD")) {
    const item = element("li", "", `${event.home ? teamName(home, teams) : teamName(away, teams)}: ${homeEventText(event)}`);
    item.dataset.replayAt = event.at;
    key.append(item);
  }
  card.append(scroll, key);
  if (pressure.message) card.append(element("p", "home-momentum-status", pressure.message));
  mark();
  const timedMarks = [...card.querySelectorAll("[data-replay-at]")];
  homeReplay.context.updateMarks = () => {
    for (const item of timedMarks) {
      item.classList.toggle("home-replay-future", homeReplay.at !== null && Number(item.dataset.replayAt) > homeReplay.at);
    }
  };
  return card;
}

// --------------------------------------------------------------- statistics

// The rows of Maç Haftası's match statistics (liveStatistics), with expected
// goals and passes added after the shots and attacks they belong with.
function homeStatisticRows() {
  const rows = liveStatistics.map(([type, label, percent]) => ({ type, label, percent: Boolean(percent), source: "statistics" }));
  const at = (type) => rows.findIndex((row) => row.type === type);
  rows.splice(at(42), 0, { type: 5304, label: "xG", percent: false, source: "xgfixture", decimals: true });
  rows.splice(at(56), 0, { type: 80, label: t("Pas"), percent: false, source: "statistics" });
  return rows;
}

function homeFixtureMetrics(fixture) {
  if (fixture.homeSnapshot) return fixture.homeSnapshot.rows.filter((row) => row.record_type === "statistic");
  if (matchweekResults.metricsStatus === "idle") loadMatchweekResultMetrics();
  return matchweekResults.metrics.filter((row) => row.fixture_id === fixture.fixture_id);
}

function renderHomeStatistics(fixture, teams) {
  const card = homeCard("home-statistics", t("MAÇ"), t("Maç İstatistikleri"));
  const sides = [fixture.home_team_id, fixture.away_team_id];
  const metrics = homeFixtureMetrics(fixture);
  card.append(matchweekVersusHeader(sides, teams));
  for (const row of homeStatisticRows()) {
    const rows = metrics.filter((metric) => (metric.source || "statistics") === row.source);
    const values = matchweekStatisticValues(rows, sides, row.type, row.percent);
    card.append(matchweekVersusRow(row.label, values.map((value) => ({
      value: value === null ? "—" : row.percent ? percentText(value) : row.decimals ? value.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : displayNumber(value),
      note: "" })), values));
  }
  const status = fixture.homeSnapshot ? "ready" : matchweekResults.metricsStatus;
  card.append(element("p", "home-card-note", fixture.homeSnapshot?.simulated ? t("Simülasyon istatistikleri.")
    : fixture.homeSnapshot?.replay ? t("Bu dakika için kaydedilen değerler gösteriliyor.")
    : status === "loading" || status === "idle" ? t("Maç istatistikleri yükleniyor…")
    : status === "unavailable" ? t("team_metrics.csv okunamadı; değerler gösterilemiyor.")
      : t("Bu maçın Sportmonks istatistikleri. — sağlanmayan veya doğrulanamayan değer.")));
  return card;
}

// ------------------------------------------------------------------ lineups

function homeSurname(name) {
  const parts = String(name || "").trim().split(/\s+/);
  return parts[parts.length - 1] || "—";
}

// One side's eleven on its half of a full pitch. The home side attacks
// upward from the bottom goal; the away side is the same picture turned
// round, so its keeper is at the top and its left is on the viewer's right.
function homePitchHalf(teamId, players, away) {
  const half = element("div", `home-pitch-half${away ? " home-pitch-top" : " home-pitch-bottom"}`);
  const ids = new Set(players.map((row) => row.player_id));
  if (players.length !== 11 || ids.size !== 11 || ids.has("") || ids.has(undefined)) {
    half.append(element("p", "home-pitch-missing", t("İlk 11 verisi eksik veya belirsiz.")));
    return { half, exact: false };
  }
  const { exact, lines } = matchweekLineupLines(players);
  for (const { goalkeeper, players: linePlayers } of away ? lines : [...lines].reverse()) {
    const line = element("div", "home-pitch-line");
    for (const player of away ? [...linePlayers].reverse() : linePlayers) {
      const name = playerName(player.player_id, player.name);
      const person = element("div", "home-pitch-player"), shirt = element("span", "pitch-shirt");
      person.title = `${name}${player.jersey_number ? ` · ${player.jersey_number}` : ""}`;
      shirt.innerHTML = shirtSVG(teamId, { size: 64, number: player.jersey_number, showName: false, goalkeeper });
      shirt.setAttribute("aria-hidden", "true");
      person.append(shirt, element("span", "pitch-player-name", homeSurname(name)), element("span", "sr-only", name));
      line.append(person);
    }
    half.append(line);
  }
  return { half, exact };
}

function homeLineupCaption(fixture, teamId, teams, index) {
  const caption = element("p", "home-lineup-caption");
  const formation = homeFormation(fixture, teamId);
  caption.append(createTeamLogo(teamId, teams, false), element("span", "", `${teamName(teamId, teams)}${formation ? ` · ${formation}` : ""}`),
    element("small", "", index ? t("Deplasman") : t("Ev sahibi")));
  return caption;
}

function renderHomeLineups(fixture, teams, starters) {
  const card = homeCard("home-lineups", t("KADROLAR"), t("İlk 11'ler"));
  const sides = [fixture.home_team_id, fixture.away_team_id];
  const pitch = element("div", "home-pitch");
  pitch.setAttribute("role", "group");
  pitch.setAttribute("aria-label", t("{top} üstte, {bottom} altta", { top: teamName(sides[1], teams), bottom: teamName(sides[0], teams) }));
  const markings = element("div", "pitch-markings");
  markings.setAttribute("aria-hidden", "true");
  markings.append(element("span", "pitch-circle"), element("span", "pitch-box pitch-box-top"), element("span", "pitch-box pitch-box-bottom"));
  const away = homePitchHalf(sides[1], starters[1], true), home = homePitchHalf(sides[0], starters[0], false);
  pitch.append(markings, away.half, home.half);
  card.append(homeLineupCaption(fixture, sides[1], teams, 1), pitch, homeLineupCaption(fixture, sides[0], teams, 0));

  // How to read the pitch is its hover text; only the warning that a side's
  // shape is a guess stays on the card.
  const exact = away.exact && home.exact;
  pitch.title = `${exact ? `${t("Kaydedilmiş dizilişler.")} ` : ""}${t("Numara forma numarasıdır; tam ad için oyuncunun üzerine gelin.")}`;
  if (!exact && starters.some((players) => players.length === 11)) {
    const note = t("Dizilişi kaydedilmemiş takımın oyuncuları mevkilerine göre gruplandı; sıraları kesin değildir.");
    pitch.title = `${pitch.title} ${note}`;
    pitch.setAttribute("aria-description", note);
  }
  return card;
}

function renderHomeSubstitutions(fixture, teams, subs) {
  const count = t("Oyuncu değişiklikleri ({count})", { count: subs.length });
  if (!subs.length) return element("p", "home-subs home-subs-empty", count);
  const details = element("details", "home-subs");
  details.append(element("summary", "", count));
  for (const [index, team] of [fixture.home_team_id, fixture.away_team_id].entries()) {
    const own = subs.filter((event) => event.home === !index);
    if (!own.length) continue;
    const list = element("ul");
    list.setAttribute("aria-label", teamName(team, teams));
    for (const event of own) {
      const item = element("li");
      item.append(element("span", "home-subs-minute", event.clock), element("span", "home-subs-in", `↑ ${event.player}`),
        element("span", "home-subs-out", event.related ? `↓ ${event.related}` : ""));
      list.append(item);
    }
    details.append(element("h3", "", teamName(team, teams)), list);
  }
  return details;
}

function updateHomeLineups(pair, fixture, teams, context) {
  const sides = [fixture.home_team_id, fixture.away_team_id];
  const rows = homePlayerRows(fixture).filter((row) => /^(1|true)$/i.test(String(row.started)));
  const starters = sides.map((team) => rows.filter((row) => row.team_id === team));
  const formations = sides.map((team) => homeFormation(fixture, team));
  const lineupKey = [formations, ...rows.map((row) => [row.team_id, row.player_id, row.name, row.position, row.formation_field, row.jersey_number])]
    .map((fields) => fields.join("\x1f")).join("\x1e");
  const subs = homeSubstitutions(fixture);
  const subsKey = subs.map(({ home, clock, player, related }) => [home, clock, player, related].join("\x1f")).join("\x1e");
  let card = pair.querySelector(".home-lineups");
  if (card && context.lineupKey === lineupKey && context.subsKey === subsKey) return;
  const oldSubs = card?.querySelector(".home-subs");
  const wasFocused = oldSubs?.contains(document.activeElement);
  if (!card || context.lineupKey !== lineupKey) {
    const next = renderHomeLineups(fixture, teams, starters);
    if (card) card.replaceWith(next);
    else pair.append(next);
    card = next;
  }
  const nextSubs = renderHomeSubstitutions(fixture, teams, subs);
  if (nextSubs.tagName === "DETAILS") nextSubs.open = Boolean(oldSubs?.open);
  if (oldSubs?.parentElement === card) oldSubs.replaceWith(nextSubs);
  else card.append(nextSubs);
  if (wasFocused) nextSubs.querySelector("summary")?.focus({ preventScroll: true });
  context.lineupKey = lineupKey;
  context.subsKey = subsKey;
}

function homeSubstitutions(fixture) {
  if (!fixture.homeSnapshot && (teamAnalysisExtras.key !== state.seasonSlug || !teamAnalysisExtras.events)) return [];
  return homeMatchEvents(fixture, 45, 200).filter((event) => event.kind === "SUBSTITUTION");
}

// --------------------------------------------------------------------- page

// ------------------------------------------------- battle, set pieces, phases

// One home-against-away line: the label in the middle, each side's bar growing
// out from it towards that club, as long as its value against the larger one.
// The side with more is in full colour, the other faded.
function homeMirrorRow(label, values, format) {
  const row = element("div", "home-mirror-row");
  row.setAttribute("role", "group");
  const shown = values.map((value) => (value === null ? "—" : format(value)));
  row.setAttribute("aria-label", `${label}: ${shown.join(" – ")}`);
  const top = Math.max(0, ...values.filter((value) => value !== null));
  const lead = values.every((value) => value !== null) ? Math.sign(values[0] - values[1]) : 0;
  const [home, away] = values.map((value, index) => {
    const side = element("div", `home-mirror-side home-mirror-${index ? "away" : "home"}`);
    side.setAttribute("aria-hidden", "true");
    const bar = element("i", `home-mirror-bar${(index ? lead > 0 : lead < 0) ? " home-mirror-behind" : ""}`);
    bar.style.setProperty("--share", value === null || !top ? "0" : String(value / top));
    const text = element("b", "", shown[index]);
    if (index) side.append(bar, text); else side.append(text, bar);
    return side;
  });
  row.append(home, element("span", "home-mirror-label", label), away);
  return row;
}

// A team's total of a player statistic: its players who were on the pitch,
// each blank read by the site's one rule (countedValue). Unknown when any of
// them is unknown.
function homePlayerRows(fixture) {
  if (fixture.homeSnapshot) {
    return fixture.homeSnapshot.rows.filter((row) => row.record_type === "lineup").map((row) => ({ ...row, name: row.player_name }));
  }
  return (state.tables["player_match_stats.csv"] || []).filter((row) => row.fixture_id === fixture.fixture_id);
}

function homePlayerTotal(fixture, teamId, column) {
  if (fixture.homeSnapshot?.replay?.at === 0) return 0;
  const rows = homePlayerRows(fixture).filter((row) => row.team_id === teamId);
  let appeared = rows.filter(playerAppeared);
  const justEntered = new Set();
  if (fixture.homeSnapshot) {
    const starters = new Set(rows.filter((row) => String(row.started) === "1").map((row) => row.player_id));
    const incoming = new Set(homeEventRows(fixture).filter((row) =>
      row.team_id === teamId && row.player_id && String(row.code).toUpperCase() === "SUBSTITUTION"
      && !/^(true|1)$/i.test(row.rescinded)).map((row) => row.player_id));
    if (starters.size !== 11 || starters.has("")) return null;
    appeared = rows.filter((row) => starters.has(row.player_id) || incoming.has(row.player_id) || playerAppeared(row));
    const ids = new Set(appeared.map((row) => row.player_id));
    if (ids.size !== appeared.length || [...incoming].some((id) => !ids.has(id))) return null;
    // A substitution establishes participation even when the incoming
    // player's elapsed minutes still round down to zero.
    for (const row of appeared) {
      if (incoming.has(row.player_id) && number(row.minutes_played) === 0) justEntered.add(row.player_id);
    }
    if (!appeared.some((row) => number(row[column]) !== null)) return null;
  }
  if (!appeared.length) return null;
  let total = 0;
  for (const row of appeared) {
    const value = justEntered.has(row.player_id) && ruleBlank(row[column]) ? 0 : countedValue(row, column);
    if (value === null) return null;
    total += value;
  }
  return total;
}

// Goals from a penalty or straight from a free kick. The events record how a
// goal was struck, not how the move began, so a header from a corner is not
// told apart from any other header. Unknown when the match has no events.
function homeDeadBallGoals(fixture) {
  const sides = [String(fixture.home_team_id), String(fixture.away_team_id)];
  const own = homeEventRows(fixture);
  if (!own.length && String(fixture.homeSnapshot?.summary?.events_available) !== "1") return [null, null];
  const counts = [0, 0];
  for (const event of own) {
    if (["true", "1"].includes(String(event.rescinded).toLowerCase())) continue;
    const kind = String(event.code || "").toUpperCase();
    if (kind !== "PENALTY" && !(kind === "GOAL" && String(event.info || "").toLowerCase() === "free kick")) continue;
    const index = sides.indexOf(event.team_id);
    if (index >= 0) counts[index] += 1;
  }
  return counts;
}

const homeDecimal = (value) => value.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// A mirror card: the versus header, then a row per measure. Each measure is a
// team statistic (team_metrics type), a sum over the team's players, or its
// own function of the fixture.
function homeMirrorCard(className, eyebrow, title, fixture, teams, measures) {
  const card = homeCard(className, eyebrow, title);
  const sides = [fixture.home_team_id, fixture.away_team_id];
  const metrics = homeFixtureMetrics(fixture);
  card.append(matchweekVersusHeader(sides, teams));
  for (const measure of measures) {
    const values = measure.type ? matchweekStatisticValues(metrics.filter((metric) => (metric.source || "statistics") === (measure.source || "statistics")), sides, measure.type)
      : measure.column ? sides.map((team) => homePlayerTotal(fixture, team, measure.column))
        : measure.values(fixture);
    card.append(homeMirrorRow(measure.label, values, measure.decimals ? homeDecimal : displayNumber));
  }
  return card;
}

// Duels and dribbles are the team's own Sportmonks totals, as on the team
// radar; aerials, fouls won and dispossessions have no team total, so they are
// the sum of the team's players. Names as on the player radar.
function renderHomePhysical(fixture, teams) {
  return homeMirrorCard("home-physical", t("MÜCADELE"), t("Fiziksel Mücadele"), fixture, teams, [
    { label: t("Kazanılan ikili"), type: 106 },
    { label: t("Kazanılan hava topu"), column: "aerials_won" },
    { label: t("Başarılı dribling"), type: 109 },
    { label: t("Kazanılan faul"), column: "fouls_drawn" },
    { label: t("Top kaptırma"), column: "dispossessed" },
  ]);
}

function renderHomeSetPieces(fixture, teams) {
  return homeMirrorCard("home-set-pieces", t("TEHLİKE"), t("Duran Top ve Akan Oyun"), fixture, teams, [
    { label: t("Korner"), type: 34 },
    { label: t("Serbest vuruş"), type: 55 },
    { label: t("Duran top xG"), type: 7944, source: "xgfixture", decimals: true },
    { label: t("Akan oyun xG"), type: 7945, source: "xgfixture", decimals: true },
    { label: t("Penaltı ve serbest vuruş golü"), values: homeDeadBallGoals },
  ]);
}

// Each side's share of the pressure index in every fifteen-minute block (the
// team page's blocks, stoppage time in a half's last block).
function renderHomePhases(fixture, teams) {
  const card = homeCard("home-phases", t("MAÇIN AKIŞI"), t("Dönem Dönem Hakimiyet"));
  const pressure = homePressure(fixture);
  if (pressure.message) {
    card.append(element("p", "home-card-note", pressure.message)); return card;
  }
  const sides = [fixture.home_team_id, fixture.away_team_id];
  card.append(matchweekVersusHeader(sides, teams));
  const sums = TeamAnalysis.buckets.map(() => [0, 0]);
  for (const [minute, home, away] of pressure.minutes) {
    const block = sums[TeamAnalysis.bucketOf(TeamAnalysis.matchClock(minute, pressure.firstHalf))];
    block[0] += home; block[1] += away;
  }
  TeamAnalysis.buckets.forEach((name, index) => {
    const [home, away] = sums[index], total = home + away;
    // Rounded so the two always add up to 100.
    const homeShare = total > 0 ? Math.round(home / total * 100) : null;
    const shares = homeShare === null ? [null, null] : [homeShare, 100 - homeShare];
    const label = `${name.replace("-", "–")}'`;
    const row = element("div", "home-phase-row");
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", `${label}: ${shares.map((share) => percentText(share)).join(" – ")}`);
    const bar = element("span", "matchweek-versus-bar home-phase-bar");
    bar.setAttribute("aria-hidden", "true");
    if (total > 0) {
      shares.forEach((share, side) => {
        const part = element("span", side ? "matchweek-versus-bar-away" : "matchweek-versus-bar-home");
        part.style.flexGrow = String(share);
        bar.append(part);
      });
    }
    const values = shares.map((share) => {
      const value = element("b", "", percentText(share));
      value.setAttribute("aria-hidden", "true");
      return value;
    });
    row.append(element("span", "home-phase-label", label), values[0], bar, values[1]);
    card.append(row);
  });
  return card;
}

// ------------------------------------------------ this match against the season

// Every finished match's team statistics this season, one entry per team and
// match, its values keyed "source|type". A statistic recorded twice is
// unknown, as on Maç İstatistikleri. Built once per loaded team_metrics.csv.
const homeSeason = { rows: null, fixtures: null, matches: [] };
function homeSeasonMatches(fixture) {
  const fixtures = state.tables["fixtures.csv"] || [];
  const relevant = (matches) => {
    if (!fixture?.homeSnapshot?.replay) return matches;
    const kickoff = kickoffTime(fixture), finishes = homeReplayFinishTimes();
    return matches.filter((match) => homeReplayFinishedBy(match.saved, kickoff, finishes));
  };
  if (homeSeason.rows === matchweekResults.metrics && homeSeason.fixtures === fixtures) return relevant(homeSeason.matches);
  const finished = new Map(fixtures.filter(fixtureFinished).map((row) => [String(row.fixture_id), row]));
  const matches = new Map();
  for (const row of matchweekResults.metrics) {
    const fixture = String(row.fixture_id), team = String(row.team_id);
    if (!finished.has(fixture)) continue;
    const key = `${fixture}|${team}`;
    if (!matches.has(key)) matches.set(key, { fixture, team, saved: finished.get(fixture), values: new Map() });
    const values = matches.get(key).values, id = `${row.source || "statistics"}|${row.type_id}`;
    values.set(id, values.has(id) ? null : number(row.value));
  }
  Object.assign(homeSeason, { rows: matchweekResults.metrics, fixtures, matches: [...matches.values()] });
  return relevant(homeSeason.matches);
}

function homeSeasonFixture(fixture, team, history) {
  if (!fixture.homeSnapshot) return history.find((match) => match.fixture === String(fixture.fixture_id) && match.team === team);
  const values = new Map();
  for (const row of homeFixtureMetrics(fixture)) {
    if (row.team_id !== team) continue;
    const key = `${row.source || "statistics"}|${row.type_id}`;
    values.set(key, values.has(key) ? null : number(row.value));
  }
  return { values };
}

// One team's value in one match: a statistic, or one statistic as a share of
// another (pass accuracy, long-pass share).
function homeMatchValue(match, measure) {
  const get = (type, source = "statistics") => match?.values.get(`${source}|${type}`) ?? null;
  if (measure.ratio) {
    const [part, whole] = measure.ratio.map((type) => get(type));
    return part === null || !whole || part < 0 || part > whole ? null : part / whole * 100;
  }
  const value = get(measure.type, measure.source);
  return value === null || value < 0 || (measure.percent && value > 100) ? null : value;
}

function homeMeasureText(measure, value) {
  if (value === null) return "—";
  if (measure.decimals) return homeDecimal(value);
  const rounded = Math.round(value * 10) / 10;
  if (measure.percent) return percentText(rounded, Number.isInteger(rounded) ? 0 : 1);
  return Number.isInteger(rounded) ? displayNumber(rounded) : rounded.toLocaleString(LOCALE, { maximumFractionDigits: 1 });
}

// The two clubs as coloured dots with their short names, for the cards whose
// marks are dots and bars rather than Maç Haftası's versus columns.
function homeDotLegend(fixture, teams) {
  const legend = element("div", "home-dot-legend");
  legend.setAttribute("aria-hidden", "true");
  [fixture.home_team_id, fixture.away_team_id].forEach((team, index) => {
    const item = element("span", "home-dot-legend-item");
    item.append(element("i", `home-dot home-dot-${index ? "away" : "home"}`), homeShortName(team, teams));
    legend.append(item);
  });
  return legend;
}

// The season cards wait for team_metrics.csv like Maç İstatistikleri does.
function homeSeasonStatus(card) {
  if (matchweekResults.metricsStatus === "idle") loadMatchweekResultMetrics();
  const status = matchweekResults.metricsStatus;
  if (status === "ready") return true;
  card.append(element("p", "home-card-note", status === "unavailable" ? t("team_metrics.csv okunamadı; sezon karşılaştırması gösterilemiyor.") : t("Sezon istatistikleri yükleniyor…")));
  return false;
}

function homeProvisionalNote(card, fixture, text) {
  if (!fixture.homeSnapshot?.inPlay) return;
  const label = card.querySelector(".eyebrow");
  label.append(` · ${t("CANLI")}`);
  label.title = text;
  card.setAttribute("aria-description", text);
}

const HOME_SEASON_RANKS = [
  { label: "xG", type: 5304, source: "xgfixture", decimals: true },
  { label: t("Toplam şut"), type: 42 },
  { label: t("Topa sahip olma"), type: 45, percent: true },
  { label: t("Tehlikeli atak"), type: 44 },
  { label: t("Faul"), type: 56 },
];

// Where this match sits among each club's own matches this season: at the
// left end its lowest, at the right its highest. Ties share the middle place.
function renderHomeSeasonRanks(fixture, teams) {
  const card = homeCard("home-season-ranks", t("SEZON"), t("Sezona Göre Bu Maç"));
  if (!homeSeasonStatus(card)) return card;
  const sides = [String(fixture.home_team_id), String(fixture.away_team_id)];
  const season = homeSeasonMatches(fixture);
  const scale = element("div", "home-rank-scale");
  scale.setAttribute("aria-hidden", "true");
  scale.append(element("span", "", t("en düşük")), element("span", "", t("sezonun en yükseği")));
  card.append(homeDotLegend(fixture, teams), scale);
  homeProvisionalNote(card, fixture, t("Şu ana kadarki değerler tamamlanan maçlarla karşılaştırılıyor."));
  for (const measure of HOME_SEASON_RANKS) {
    const row = element("div", "home-rank-row");
    const track = element("div", "home-rank-track");
    const spoken = [];
    sides.forEach((team, index) => {
      const own = season.filter((match) => match.team === team && (!fixture.homeSnapshot || match.fixture !== String(fixture.fixture_id)));
      const value = homeMatchValue(homeSeasonFixture(fixture, team, own), measure);
      const known = own.map((match) => homeMatchValue(match, measure)).filter((other) => other !== null);
      if (value === null || known.length < 2) {
        spoken.push(`${teamName(team, teams)}: ${homeMeasureText(measure, value)}`);
        return;
      }
      const below = known.filter((other) => other < value).length, equal = known.filter((other) => other === value).length;
      const place = fixture.homeSnapshot ? (below + equal / 2) / known.length : (below + (equal - 1) / 2) / (known.length - 1);
      const dot = element("i", `home-dot home-dot-${index ? "away" : "home"}`);
      dot.style.left = `${place * 100}%`;
      const range = t("sezonda {count} maç: en düşük {low}, en yüksek {high}", { count: known.length,
        low: homeMeasureText(measure, Math.min(...known)), high: homeMeasureText(measure, Math.max(...known)) });
      dot.title = `${teamName(team, teams)} · ${measure.label} ${homeMeasureText(measure, value)} (${range})`;
      track.append(dot);
      spoken.push(`${teamName(team, teams)}: ${homeMeasureText(measure, value)}, ${range}`);
    });
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", `${measure.label}. ${spoken.join(". ")}`);
    row.append(element("span", "home-rank-label", measure.label), track);
    card.append(row);
  }
  return card;
}

// Every team-match this season as a grey point: how many of its passes were
// long, against how many found a teammate. This match's two sides stand out
// in their colours. Short, patient passing sits top left; direct long balls
// bottom right.
function renderHomePassingStyle(fixture, teams, context) {
  const makeCard = () => homeCard("home-passing", t("PAS"), t("Ligde Pas Tarzı"));
  if (matchweekResults.metricsStatus !== "ready") {
    const card = makeCard();
    homeSeasonStatus(card);
    return card;
  }
  const longShare = { ratio: [62, 80] }, accuracy = { ratio: [81, 80] };
  const mode = fixture.homeSnapshot?.replay ? "replay" : fixture.homeSnapshot ? "snapshot" : "saved";
  let plot = context.passing;
  if (!plot || plot.mode !== mode || plot.metrics !== matchweekResults.metrics || plot.periods !== teamAnalysisExtras.periods) {
    const season = homeSeasonMatches(fixture).filter((match) => mode === "saved" || match.fixture !== String(fixture.fixture_id));
    const points = season.map((match) => ({ match, x: homeMatchValue(match, longShare), y: homeMatchValue(match, accuracy) }))
      .filter((point) => point.x !== null && point.y !== null);
    plot = { mode, season, points, metrics: matchweekResults.metrics, periods: teamAnalysisExtras.periods };
    context.passing = plot;
  }
  const { season, points } = plot;
  if (points.length < 2 && !fixture.homeSnapshot?.replay) {
    const card = makeCard();
    card.append(element("p", "home-card-note", t("Bu sezon için pas verisi yok."))); return card;
  }
  // Low enough that the card is no taller than Fiziksel Mücadele.
  const width = 300, height = 180, left = 30, right = 8, top = 18, bottom = 28;
  const span = (values) => {
    const low = Math.min(...values), high = Math.max(...values), pad = (high - low) * 0.06 || 1;
    return [low - pad, high + pad];
  };
  const sides = [String(fixture.home_team_id), String(fixture.away_team_id)];
  const own = sides.map((team) => {
    if (!fixture.homeSnapshot) return points.find((point) => point.match.fixture === String(fixture.fixture_id) && point.match.team === team) || null;
    const match = homeSeasonFixture(fixture, team, season);
    const x = homeMatchValue(match, longShare), y = homeMatchValue(match, accuracy);
    return x === null || y === null ? null : { x, y };
  });
  const plotted = [...points, ...own.filter(Boolean)];
  const [x0, x1] = plotted.length >= 2 ? span(plotted.map((point) => point.x)) : [0, 100];
  const [y0, y1] = plotted.length >= 2 ? span(plotted.map((point) => point.y)) : [0, 100];
  const x = (value) => left + (value - x0) / (x1 - x0) * (width - left - right);
  const y = (value) => height - bottom - (value - y0) / (y1 - y0) * (height - top - bottom);
  const label = own.map((point, index) => point
    ? t("{team}: uzun pas oranı {long}, pas isabeti {accuracy}", { team: teamName(sides[index], teams),
      long: homeMeasureText({ percent: true }, point.x), accuracy: homeMeasureText({ percent: true }, point.y) })
    : t("{team}: veri yok", { team: teamName(sides[index], teams) }));
  const axisKey = [x0, x1, y0, y1].join(":");
  if (plot.axisKey !== axisKey) {
    const svg = homeSvg(null, "svg", { viewBox: `0 0 ${width} ${height}`, role: "img", class: "home-passing-chart" });
    const card = makeCard();
    for (const value of TeamAnalysis.niceTicks(x0, x1, 5).ticks) {
      homeSvg(svg, "line", { x1: x(value), y1: top, x2: x(value), y2: height - bottom, class: "home-passing-grid" });
      homeSvg(svg, "text", { x: x(value), y: height - bottom + 11, "text-anchor": "middle", class: "home-passing-tick" }, displayNumber(value));
    }
    for (const value of TeamAnalysis.niceTicks(y0, y1, 5).ticks) {
      homeSvg(svg, "line", { x1: left, y1: y(value), x2: width - right, y2: y(value), class: "home-passing-grid" });
      homeSvg(svg, "text", { x: left - 4, y: y(value) + 3, "text-anchor": "end", class: "home-passing-tick" }, displayNumber(value));
    }
    homeSvg(svg, "text", { x: width - right, y: height - 4, "text-anchor": "end", class: "home-passing-axis" }, t("uzun pas oranı % →"));
    homeSvg(svg, "text", { x: 0, y: 9, class: "home-passing-axis" }, t("pas isabeti % ↑"));
    homeSvg(svg, "text", { x: left + 4, y: top + 10, class: "home-passing-corner" }, t("kısa ve sabırlı"));
    homeSvg(svg, "text", { x: width - right - 4, y: height - bottom - 5, "text-anchor": "end", class: "home-passing-corner" }, t("uzun ve direkt"));
    for (const point of points) {
      if (own.includes(point)) continue;
      homeSvg(svg, "circle", { cx: x(point.x), cy: y(point.y), r: 2.2, class: "home-passing-dot" });
    }
    const box = element("div", "home-passing-plot");
    const layer = homeSvg(svg, "g");
    box.append(svg);
    homeProvisionalNote(card, fixture, t("Maç sürüyor · Geçici karşılaştırma"));
    card.append(box);
    Object.assign(plot, { axisKey, card, svg, layer, label: null });
  }
  const description = `${t("Bu sezonun {count} takım-maçında uzun pas oranı ve pas isabeti.", { count: points.length })} ${label.join(". ")}.`;
  const values = own.map((point) => point ? `${point.x}:${point.y}` : "").join("|");
  if (plot.label === values) return plot.card;
  plot.label = values;
  plot.svg.setAttribute("aria-label", description);
  plot.layer.replaceChildren();
  own.forEach((point, index) => {
    if (!point) return;
    const group = homeSvg(plot.layer, "g");
    homeSvg(group, "title", {}, label[index]);
    homeSvg(group, "circle", { cx: x(point.x), cy: y(point.y), r: 5, class: `home-passing-own home-passing-${index ? "away" : "home"}` });
    const onRight = x(point.x) < width - right - 40;
    homeSvg(group, "text", { x: x(point.x) + (onRight ? 8 : -8), y: y(point.y) + 3.5, "text-anchor": onRight ? "start" : "end", class: "home-passing-name" },
      homeShortName(sides[index], teams));
  });
  return plot.card;
}

const HOME_SEASON_SHIFTS = [
  { label: t("Topa sahip olma"), type: 45, percent: true },
  { label: t("Pas isabeti"), ratio: [81, 80], percent: true },
  { label: t("Uzun pas oranı"), ratio: [62, 80], percent: true },
  { label: t("Orta"), type: 98 },
  { label: t("Tehlikeli atak"), type: 44 },
  { label: t("Faul"), type: 56 },
];

// This match against each club's average over its other matches this season,
// as a change in per cent: right of the line it did more than usual.
function renderHomeSeasonShifts(fixture, teams) {
  const card = homeCard("home-season-shifts", t("OYUN TARZI"), t("Sezon Ortalamasına Göre"));
  if (!homeSeasonStatus(card)) return card;
  const sides = [String(fixture.home_team_id), String(fixture.away_team_id)];
  const season = homeSeasonMatches(fixture), id = String(fixture.fixture_id);
  const rows = HOME_SEASON_SHIFTS.map((measure) => ({
    measure,
    sides: sides.map((team) => {
      const own = season.filter((match) => match.team === team);
      const value = homeMatchValue(homeSeasonFixture(fixture, team, own), measure);
      const others = own.filter((match) => match.fixture !== id).map((match) => homeMatchValue(match, measure)).filter((other) => other !== null);
      const average = others.length ? others.reduce((sum, other) => sum + other, 0) / others.length : null;
      const change = value === null || !average ? null : (value - average) / average * 100;
      return { team, value, average, change, matches: others.length };
    }),
  }));
  // Bars share one scale, the largest change in the card, from 10% to 100%;
  // a larger change fills its half and its number says how far it went.
  const reach = Math.min(100, Math.max(10, ...rows.flatMap((row) => row.sides.map((side) => Math.abs(side.change ?? 0)))));
  const head = element("div", "home-shift-head");
  head.setAttribute("aria-hidden", "true");
  head.append(homeDotLegend(fixture, teams), element("span", "home-shift-zero", t("sezon ortalaması")));
  card.append(head);
  homeProvisionalNote(card, fixture, t("Şu ana kadarki değerler tamamlanan maçlarla karşılaştırılıyor."));
  for (const { measure, sides: values } of rows) {
    const row = element("div", "home-shift-row");
    row.setAttribute("role", "group");
    const track = element("div", "home-shift-track");
    const spoken = values.map(({ team, value, average, change, matches }, index) => {
      const shown = change === null ? "—" : `${change > 0.5 ? "+" : change < -0.5 ? "−" : ""}${percentSign(displayNumber(Math.round(Math.abs(change))))}`;
      const bar = element("div", `home-shift-bar home-shift-${index ? "away" : "home"}${change !== null && change < 0 ? " home-shift-down" : ""}`);
      bar.style.setProperty("--w", change === null ? "0" : String(Math.min(1, Math.abs(change) / reach)));
      bar.title = t("{team} · {measure}: bu maç {value}, sezon ortalaması {average} ({count} maç)", { team: teamName(team, teams),
        measure: measure.label, value: homeMeasureText(measure, value), average: homeMeasureText(measure, average), count: matches });
      bar.append(element("i"), element("b", "", shown));
      track.append(bar);
      return `${teamName(team, teams)} ${shown}`;
    });
    row.setAttribute("aria-label", t("{measure}, sezon ortalamasına göre: {values}", { measure: measure.label, values: spoken.join(", ") }));
    row.append(element("span", "home-shift-label", measure.label), track);
    card.append(row);
  }
  return card;
}

// Maç Olayları: the chosen match's events as text, drawn by Maç Haftası's own
// list (renderLiveEvents) so both pages word and order them alike. Rows of
// events.csv are put in the live feed's shape first.
function renderHomeEvents(fixture, teams) {
  const list = $("home-events-list");
  const note = (text) => list.replaceChildren(element("li", "live-events-empty", text));
  if (!fixture) return note(t("Maç seçildiğinde olayları burada görünür."));
  const snapshot = fixture.homeSnapshot;
  if (!snapshot && (teamAnalysisExtras.key !== state.seasonSlug || teamAnalysisExtras.state !== "ready")) return note(t("Maç olayları yükleniyor…"));
  if (!snapshot && !teamAnalysisExtras.events) return note(t("events.csv okunamadı."));
  const id = String(fixture.fixture_id);
  const rows = homeEventRows(fixture);
  if (list.dataset.fixture !== id) list.scrollTop = 0;
  list.dataset.fixture = id;
  renderLiveEvents({ fixture_id: id, events_available: snapshot ? String(snapshot.summary?.events_available || "") : "1" }, teams, rows, list);
  // Each event's place on the pressure chart's clock, for its slider.
  const pressure = homePressure(fixture);
  if (pressure.message) return;
  const times = new Map();
  for (const row of rows) {
    const minute = number(row.minute);
    if (row.event_id && minute !== null) times.set(row.event_id, homeChartTime(minute, number(row.extra_minute) || 0, pressure.firstHalf, pressure.total));
  }
  for (const item of list.children) {
    if (times.has(item.dataset.eventId)) item.dataset.at = String(times.get(item.dataset.eventId));
  }
}

// Light the event (or events, when several share a minute) nearest to a
// minute on the pressure chart's clock, and bring it into the list's view
// without moving the page.
function highlightHomeEvents(at, scroll = true) {
  const list = $("home-events-list");
  const items = [...list.querySelectorAll("li[data-at]")];
  if (!items.length) return;
  const distance = (item) => Math.abs(Number(item.dataset.at) - at);
  const nearest = items.reduce((best, item) => (distance(item) < distance(best) ? item : best));
  for (const item of items) item.classList.toggle("is-current", item.dataset.at === nearest.dataset.at);
  if (!scroll) return;
  const view = list.getBoundingClientRect(), box = nearest.getBoundingClientRect();
  if (box.top < view.top) list.scrollTop -= view.top - box.top;
  else if (box.bottom > view.bottom) list.scrollTop += box.bottom - view.bottom;
}

function homeReplayGame(game, timeline) {
  const at = homeReplay.at;
  if (at === null || at >= timeline.through) return game;
  const fixture = game.fixture;
  const simulated = Boolean(fixture.homeSnapshot?.simulated);
  const saved = simulated ? homeSimulationReplayRows(at) : homeHistoricalReplayRows(fixture, at, timeline.firstHalf, timeline.total);
  const [summary, ...rows] = saved;
  if (!summary) return game;
  if (!simulated) {
    const frame = homeCapturedReplayFrame(fixture, at, timeline.firstHalf);
    if (frame) {
      const [captured, ...capturedRows] = frame.rows;
      const metricKey = (row) => `${row.team_id}|${row.source || "statistics"}|${row.type_id}`;
      const metrics = new Map();
      rows.forEach((row, index) => { if (row.record_type === "statistic") metrics.set(metricKey(row), index); });
      const players = new Map(rows.filter((row) => row.record_type === "lineup").map((row) => [row.player_id, row]));
      for (const row of capturedRows) {
        if (row.record_type === "statistic" && number(row.value) !== null) {
          const index = metrics.get(metricKey(row));
          if (index === undefined) rows.push(row);
          else if (frame.elapsed > rows[index].minute) rows[index] = row;
        }
        if (row.record_type === "lineup") {
          const player = players.get(row.player_id);
          if (player) Object.assign(player, row);
          else rows.push(row);
        }
      }
      for (const field of ["home_score", "away_score", "home_half_score", "away_half_score"]) {
        if (number(summary[field]) === null) summary[field] = captured[field];
      }
    }
  }
  const snapshot = { rows, summary, inPlay: true, simulated, replay: { ...timeline, at } };
  return {
    fixture: { ...fixture, homeSnapshot: snapshot },
    score: [homeScoreValue(summary.home_score), homeScoreValue(summary.away_score)],
  };
}

function cancelHomeReplayPaint() {
  cancelAnimationFrame(homeReplay.frame);
  clearTimeout(homeReplay.timer);
  homeReplay.frame = 0;
  homeReplay.timer = 0;
}

function queueHomeReplayPaint() {
  if (homeReplay.frame || homeReplay.timer) return;
  if (homeReplay.dragging) {
    homeReplay.timer = setTimeout(() => {
      homeReplay.timer = 0;
      paintHomeReplay();
    }, HOME_REPLAY_PAINT_INTERVAL);
  } else {
    homeReplay.frame = requestAnimationFrame(() => {
      homeReplay.frame = 0;
      paintHomeReplay();
    });
  }
}

function paintHomeReplay() {
  const context = homeReplay.context;
  if (state.view !== "home" || !context || context.paintedAt === homeReplay.at) return;
  const firstPaint = context.paintedAt === undefined;
  context.paintedAt = homeReplay.at;
  context.updateMarks();
  const { baseGame, timeline, teams, games, standings, simulated } = context;
  const game = homeReplayGame(baseGame, timeline);
  const fixture = game.fixture;
  const replay = fixture.homeSnapshot?.replay ? game : null;
  const standingsKey = replay ? `${game.score.join(":")}|${homeReplay.at === 0}` : "latest";
  if (context.standingsKey !== standingsKey) {
    renderStandings(teams, "standings", { record: true, snapshot: standings, simulated, replay });
    context.standingsKey = standingsKey;
  }
  if (firstPaint) {
    renderHomeGames(games, teams);
    context.matchButton = $("home-games-list").querySelector(`[data-fixture="${CSS.escape(fixture.fixture_id)}"]`);
  }
  updateHomeGameButton(context.matchButton, game, teams);
  const eventCount = homeEventRows(fixture).length;
  const eventsKey = `${Boolean(replay)}|${fixture.homeSnapshot?.summary?.events_available ?? ""}|${eventCount}`;
  if (context.eventsKey !== eventsKey || context.savedEvents !== teamAnalysisExtras.events) {
    renderHomeEvents(fixture, teams);
    context.eventsKey = eventsKey;
    context.savedEvents = teamAnalysisExtras.events;
  }
  if (replay) highlightHomeEvents(homeReplay.at, false);
  const detail = $("home-detail");
  const pair = detail.children[2].firstElementChild;
  const statistics = renderHomeStatistics(fixture, teams);
  updateHomeCard(pair, statistics, 0);
  updateHomeLineups(pair, fixture, teams, context);
  const more = detail.children[3].firstElementChild;
  const cards = [renderHomeSeasonRanks(fixture, teams), renderHomePassingStyle(fixture, teams, context), renderHomeSeasonShifts(fixture, teams),
    renderHomePhysical(fixture, teams), renderHomeSetPieces(fixture, teams), renderHomePhases(fixture, teams)];
  cards.forEach((card, index) => updateHomeCard(more, card, index));
  const scoreboard = detail.children[0].firstElementChild;
  if (scoreboard) updateHomeScoreboard(scoreboard, game, teams);
  else detail.children[0].append(renderHomeScoreboard(game, teams));
}

function updateHomeCard(parent, next, index) {
  const current = parent.children[index];
  if (!current) parent.append(next);
  else if (!current.isEqualNode(next)) current.replaceWith(next);
}

function renderHomeDetail(game, teams, games, standings, simulated) {
  const detail = $("home-detail");
  const events = $("home-events");
  events.classList.toggle("has-match", Boolean(game));
  const sameMatch = detail.dataset.fixture && detail.dataset.fixture === game?.fixture.fixture_id;
  const fixtureId = game?.fixture.fixture_id ?? null;
  const isSimulation = Boolean(game?.fixture.homeSnapshot?.simulated);
  if (homeReplay.fixtureId !== fixtureId || homeReplay.simulated !== isSimulation) homeReplay.at = null;
  homeReplay.fixtureId = fixtureId;
  homeReplay.simulated = isSimulation;
  const oldSlider = sameMatch && detail.querySelector(".home-momentum-slider");
  const oldScroll = sameMatch && detail.querySelector(".home-momentum-scroll");
  const oldSubs = sameMatch && detail.querySelector("details.home-subs");
  const focused = document.activeElement;
  detail.dataset.fixture = game?.fixture.fixture_id || "";
  cancelHomeReplayPaint();
  if (!game) {
    homeReplay.context = null;
    renderStandings(teams, "standings", { record: true, snapshot: standings, simulated });
    renderHomeGames(games, teams);
    renderHomeEvents(null, teams);
    detail.style.removeProperty("--matchweek-home");
    detail.style.removeProperty("--matchweek-away");
    const empty = element("section", "home-panel home-card home-empty");
    empty.append(element("p", "message", state.tables["fixtures.csv"] ? t("Maç seçildiğinde sonucu, akışı, istatistikleri ve ilk 11'ler burada görünür.")
      : t("Maç ayrıntıları için sezon verilerini yükleyin.")));
    detail.replaceChildren(empty);
    return;
  }
  const { fixture } = game;
  // Every comparison here draws each club in its own colour; the away side
  // takes its second colour when the two would be hard to tell apart.
  teamColorPair(fixture.home_team_id, fixture.away_team_id)
    .forEach((color, index) => detail.style.setProperty(`--matchweek-${index ? "away" : "home"}`, color));
  const timeline = homeReplayTimeline(fixture);
  homeReplay.context = { baseGame: game, timeline, teams, games, standings, simulated };
  if (homeReplay.at !== null && homeReplay.at >= timeline.through) homeReplay.at = null;
  const row = () => element("div", "home-row");
  detail.replaceChildren(row(), row(), row(), row());
  detail.children[1].append(renderHomeMomentum(fixture, teams, timeline));
  detail.children[2].append(element("div", "home-pair"));
  detail.children[3].append(element("div", "home-more"));
  paintHomeReplay();
  if (oldSlider) {
    const slider = detail.querySelector(".home-momentum-slider");
    if (slider && focused === oldSlider) slider.focus({ preventScroll: true });
  }
  const momentumScroll = oldScroll && detail.querySelector(".home-momentum-scroll");
  if (momentumScroll) momentumScroll.scrollLeft = oldScroll.scrollLeft;
  const subs = oldSubs && detail.querySelector("details.home-subs");
  if (subs) {
    subs.open = oldSubs.open;
    if (oldSubs.contains(focused)) subs.querySelector("summary")?.focus({ preventScroll: true });
  }
}

function renderHome() {
  if (homeReplay.dragging) {
    homeReplay.refresh = true;
    return;
  }
  const teams = homeTeams();
  const season = $("season-label").textContent;
  $("home-season-note").textContent = season !== "—" ? t("{season} sezonu · Sportmonks verisi", { season }) : t("Başlamak için standings.csv, fixtures.csv, teams.csv ve fixture_scores.csv dosyalarını açın.");
  if (state.seasonSlug) {
    if (teamAnalysisExtras.key !== state.seasonSlug) loadTeamAnalysisExtras();
    if (homeExtras.key !== state.seasonSlug) loadHomeExtras();
  }
  syncHomeSimulationControl();
  const { games, standings, simulated } = homeSnapshotGames();
  const selected = games.find((game) => game.fixture.fixture_id === state.homeFixture);
  const active = games.find((game) => game.fixture.homeSnapshot?.inPlay);
  const game = selected && (simulated || homeSelection.manual || selected.fixture.homeSnapshot || !active) ? selected : active || games[0];
  state.homeFixture = game?.fixture.fixture_id ?? null;
  renderHomeDetail(game, teams, games, standings, simulated);
}

function renderHomeLive() {
  if (state.view === "home") renderHome();
}

function setupHome() {
  setupHomeSimulation();
  const finishDrag = () => {
    if (!homeReplay.dragging) return;
    homeReplay.dragging = false;
    cancelHomeReplayPaint();
    if (state.view !== "home") {
      homeReplay.refresh = false;
      return;
    }
    if (!homeReplay.refresh) {
      paintHomeReplay();
      return;
    }
    homeReplay.refresh = false;
    renderHome();
  };
  document.addEventListener("pointerup", finishDrag);
  document.addEventListener("pointercancel", finishDrag);
  window.addEventListener("blur", finishDrag);
  $("standings-group").addEventListener("change", (event) => { state.standingsGroup = event.target.value; renderHome(); });
  // Another week changes only the list; the match on show stays until one is clicked.
  $("home-games-week").addEventListener("change", (event) => {
    state.homeWeek = event.target.value;
    renderHome();
  });
  for (const [id, step] of [["home-week-prev", -1], ["home-week-next", 1]]) {
    $(id).addEventListener("click", () => {
      const weeks = homeWeeks(), next = weeks[weeks.findIndex((week) => week.key === state.homeWeek) + step];
      if (!next) return;
      state.homeWeek = next.key;
      renderHome();
    });
  }
  $("home-games-list").addEventListener("click", (event) => {
    const button = event.target.closest(".home-game");
    if (!button) return;
    homeSelection.manual = true;
    state.homeFixture = button.dataset.fixture;
    renderHome();
    $("home-games-list").querySelector(`[data-fixture="${CSS.escape(state.homeFixture)}"]`)?.focus({ preventScroll: true });
    // On a narrow screen the match sits away from the list: bring it into view.
    const box = $("home-detail").getBoundingClientRect();
    if (box.top < 0 || box.top > window.innerHeight * 0.6) $("home-detail").scrollIntoView({ block: "start" });
  });
}
