"use strict";

// Ana Sayfa: the season's played matches and the league table on the left, and
// one chosen match in the middle: its result, its flow minute by minute, its
// statistics and the two elevens. The newest match is open until another is
// chosen. A right-hand column is kept empty for a future panel.
//
// Shared parts, so every page agrees: standings (renderStandings, also used by
// Maç Haftası), the statistic rule and versus rows (matchweek/results.js), the
// lineup lines (matchweekLineupLines) and the pitch look (styles/pitch.css).
// Minute data (pressure, periods, events) is the copy Takım İstatistikleri
// already reads (teamAnalysisExtras); formations are read here.

const homeExtras = { key: null, state: "idle", formations: null, referees: null };

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
function renderStandings(teams, prefix = "standings", { record = false } = {}) {
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
  // Maç Haftası shows the table as it would stand if the matches in play ended now.
  const live = prefix === "matchweek-standings" && typeof matchweekLiveStandings === "function" ? matchweekLiveStandings(rows) : null;
  $(`${prefix}-note`).textContent = state.tables["standings.csv"] ? "" : t("Puan tablosu için sezon verilerini yükleyin.");
  let scores = null;
  const body = document.createDocumentFragment();
  for (const [index, row] of (live ? live.order : rows).entries()) {
    const tr = element("tr");
    const club = element("td");
    const identity = createTeamLink(row.participant_id, teamName(row.participant_id, teams), "standing-club");
    identity.replaceChildren(createTeamLogo(row.participant_id, teams, false), element("span", "", teamName(row.participant_id, teams)));
    club.append(identity);
    const entry = live?.teams.get(String(row.participant_id));
    const points = element("td", `numeric standing-points${entry ? ` standing-live standing-live-${entry.status}` : ""}`,
      displayNumber(entry ? entry.points : row.points));
    if (entry) points.title = `${displayNumber(entry.base)} + ${entry.gained} · ${entry.own}–${entry.other} ${entry.opponent} (${entry.live ? t("sürüyor") : t("bitti, kayda girmedi")})`;
    const place = displayNumber(live ? index + 1 : row.position);
    tr.append(element("td", "standing-position", record && place !== "—" ? `${place}.` : place), club);
    if (record) {
      const results = () => standingResults(row, scores ??= currentFixtureScores());
      tr.append(standingFigureCell(row, "overall_matches", "played", results), standingFigureCell(row, "overall_wins", "wins", results));
    }
    tr.append(points);
    body.append(tr);
  }
  if (!rows.length) {
    const tr = element("tr"), td = element("td", "no-results", state.tables["standings.csv"] ? t("Bu dosyada puan durumu yok.") : t("Puan tablosu burada görünecek."));
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

// ------------------------------------------------------------ played matches

// Finished matches with a saved score for both sides, newest first.
function homePlayedGames() {
  const scores = currentFixtureScores();
  const valid = (value) => Number.isInteger(value) && value >= 0;
  return (state.tables["fixtures.csv"] || []).filter(fixtureFinished).map((fixture) => ({ fixture,
    score: [scores.get(`${fixture.fixture_id}:${fixture.home_team_id}`), scores.get(`${fixture.fixture_id}:${fixture.away_team_id}`)] }))
    .filter((game) => game.score.every(valid))
    .sort((a, b) => kickoffTime(b.fixture) - kickoffTime(a.fixture) || String(b.fixture.fixture_id).localeCompare(String(a.fixture.fixture_id)));
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
// puts it until the data reloads. Played matches are buttons that open the
// match; the week's other matches are listed with their kickoff, greyed, with
// nothing to open yet.
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
  const fixtures = weeks[index]?.fixtures || [];
  $("home-games-note").textContent = state.tables["fixtures.csv"] ? "" : t("Maçları görmek için sezon verilerini yükleyin.");
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
    const { score } = game;
    const selected = fixture.fixture_id === state.homeFixture;
    const button = element("button", "home-game");
    button.type = "button";
    button.dataset.fixture = fixture.fixture_id;
    button.setAttribute("aria-pressed", String(selected));
    button.setAttribute("aria-controls", "home-detail");
    button.setAttribute("aria-label", `${teamName(fixture.home_team_id, teams)} ${score[0]} – ${score[1]} ${teamName(fixture.away_team_id, teams)}, ${when}`);
    button.append(element("span", "home-game-meta", when), homeGameLine(fixture, teams, `${score[0]} – ${score[1]}`));
    list.append(button);
  }
  $("home-games-list").replaceChildren(list);
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
  const rows = (homeExtras.formations || []).filter((row) => row.fixture_id === fixture.fixture_id && row.participant_id === teamId);
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
  const { fixture, score } = game;
  const card = element("section", "home-panel home-card home-scoreboard");
  const photo = HOME_STADIUM_PHOTOS[fixture.venue_id || fixture["venue.id"]];
  if (photo) {
    card.classList.add("home-scoreboard-photo");
    // A full address: a url() passed through a custom property would be read
    // relative to home.css, not to the page.
    card.style.setProperty("--home-stadium", `url("${new URL(`assets/stadiums/${photo}-stadium.jpg`, document.baseURI).href}")`);
  }
  card.setAttribute("aria-label", t("Maç sonucu: {result}", { result: `${teamName(fixture.home_team_id, teams)} ${score[0]} – ${score[1]} ${teamName(fixture.away_team_id, teams)}` }));
  const grid = element("div", "home-score-grid");
  const side = (id, index) => {
    const box = element("div", `home-score-team${index ? " home-score-away" : ""}`);
    const name = createTeamLink(id, teamName(id, teams), "home-score-name");
    const formation = homeFormation(fixture, id);
    box.append(createTeamLogo(id, teams, true), name,
      element("span", "home-score-role", `${index ? t("Deplasman") : t("Ev sahibi")}${formation ? ` · ${formation}` : ""}`));
    return box;
  };
  const middle = element("div", "home-score-middle");
  const half = currentFixtureScores("1ST_HALF");
  const halfScore = [half.get(`${fixture.fixture_id}:${fixture.home_team_id}`), half.get(`${fixture.fixture_id}:${fixture.away_team_id}`)];
  const halfText = halfScore.every((value) => Number.isInteger(value) && value >= 0) ? ` · ${t("İY {score}", { score: `${halfScore[0]}–${halfScore[1]}` })}` : "";
  middle.append(element("strong", "home-score-value", `${score[0]} – ${score[1]}`),
    element("span", "home-score-state", `${fixtureStateLabel(fixture)}${halfText}`));
  grid.append(side(fixture.home_team_id, 0), middle, side(fixture.away_team_id, 1));
  card.append(grid);
  const venue = [fixture["venue.name"], fixture["venue.city_name"]].filter(Boolean).join(" · ");
  if (venue) card.append(element("p", "home-score-venue", venue));
  const chips = element("div", "home-chips");
  const round = fixture["round.name"] ? `${t("{round}. hafta", { round: fixture["round.name"] })} · ` : "";
  chips.append(element("span", "home-chip", `${round}${homeLongDate.format(kickoffTime(fixture))} ${kickoffClock(fixture)}`));
  const referee = homeReferee(fixture);
  if (referee) chips.append(element("span", "home-chip", t("Hakem: {name}", { name: referee })));
  const weather = homeWeather(fixture);
  if (weather) chips.append(element("span", "home-chip", weather));
  card.append(chips);
  return card;
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

// This match's goals, cards and substitutions on the pressure chart's clock.
function homeMatchEvents(fixture, firstHalf, total) {
  const sides = [String(fixture.home_team_id), String(fixture.away_team_id)];
  const events = [];
  for (const event of teamAnalysisExtras.events || []) {
    if (String(event.fixture_id) !== String(fixture.fixture_id)) continue;
    const kind = String(event["type.developer_name"] || "").toUpperCase();
    if (!HOME_GOALS.has(kind) && !HOME_CARDS.has(kind) && kind !== "SUBSTITUTION") continue;
    if (["true", "1"].includes(String(event.rescinded).toLowerCase())) continue;
    const team = String(event.participant_id || event.team_id || ""), minute = number(event.minute), extra = number(event.extra_minute) || 0;
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
  if (teamAnalysisExtras.key !== state.seasonSlug || teamAnalysisExtras.state !== "ready") return { message: t("Baskı verisi yükleniyor…") };
  if (!teamAnalysisExtras.pressure) return { message: t("fixture_pressure.csv okunamadı.") };
  const id = String(fixture.fixture_id), home = String(fixture.home_team_id), away = String(fixture.away_team_id);
  const byMinute = new Map();
  for (const row of teamAnalysisExtras.pressure) {
    if (String(row.fixture_id) !== id) continue;
    const minute = number(row.minute), value = number(row.pressure);
    if (minute === null || minute < 1 || value === null) continue;
    if (!byMinute.has(minute)) byMinute.set(minute, new Map());
    byMinute.get(minute).set(String(row.participant_id), value);
  }
  const minutes = [...byMinute].filter(([, values]) => values.has(home) && values.has(away))
    .map(([minute, values]) => [minute, values.get(home), values.get(away)]).sort((a, b) => a[0] - b[0]);
  if (!minutes.length) return { message: t("Bu maç için baskı verisi yok.") };
  const last = minutes[minutes.length - 1][0];
  const period = (teamAnalysisExtras.periods || []).find((row) => String(row.fixture_id) === id && String(row.description || "").toLowerCase().includes("1st"));
  const firstHalf = number(period?.minutes) ?? 45 + Math.max(0, Math.round((last - 90) / 2));
  return { minutes, firstHalf, total: Math.max(last, firstHalf + 45) };
}

// The chart alone, with no title row, so all of the card is chart; how to read
// it is the chart's hover text.
function renderHomeMomentum(fixture, teams) {
  const card = element("section", "home-panel home-card home-momentum");
  card.setAttribute("aria-label", t("Maçın akışı: baskı dengesi"));
  const pressure = homePressure(fixture);
  if (pressure.message) {
    card.append(element("p", "home-card-note", pressure.message)); return card;
  }
  const home = String(fixture.home_team_id), away = String(fixture.away_team_id);
  const { firstHalf, total } = pressure;
  const balance = pressure.minutes.map(([minute, own, other]) => [minute, own - other]);
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
    const bar = homeSvg(svg, "rect", { x: x(minute - 1) + slot * 0.1, y: value > 0 ? middle - h : middle, width: slot * 0.8, height: h,
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
      const group = homeSvg(svg, "g", { class: "home-momentum-goal" });
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
    const group = homeSvg(svg, "g");
    homeSvg(group, "title", {}, homeEventText(event));
    if (event.kind === "SUBSTITUTION") {
      homeSvg(group, "text", { x: cx, y: lane + 3, "text-anchor": "middle", class: "home-momentum-sub" }, "⇄");
    } else {
      homeSvg(group, "rect", { x: cx - 3, y: lane - 4.5, width: 6, height: 9, rx: 1,
        class: event.kind === "YELLOWCARD" ? "home-card-yellow" : event.kind === "REDCARD" ? "home-card-red" : "home-card-second" });
    }
  }
  // A slider under the chart walks through the match: a line marks its minute
  // on the chart, and Maç Olayları lights the event nearest to it. Nothing is
  // marked until it is first moved.
  const marker = homeSvg(svg, "line", { x1: 0, y1: top - 2, x2: 0, y2: height, class: "home-momentum-cursor", visibility: "hidden" });
  const slider = element("input", "home-momentum-slider");
  Object.assign(slider, { type: "range", min: 0, max: total, step: 1, value: 0 });
  slider.setAttribute("aria-label", t("Maç olaylarında dakika seç"));
  slider.style.setProperty("--plot-left", `${(left / width) * 100}%`);
  slider.style.setProperty("--plot-right", `${(right / width) * 100}%`);
  slider.addEventListener("input", () => {
    const at = Number(slider.value);
    marker.setAttribute("x1", x(at)); marker.setAttribute("x2", x(at)); marker.setAttribute("visibility", "visible");
    slider.setAttribute("aria-valuetext", homePressureClock(at, firstHalf));
    highlightHomeEvents(at);
  });
  const track = element("div", "home-momentum-track");
  track.append(svg, slider);
  const scroll = element("div", "home-momentum-scroll");
  scroll.append(track);
  // Screen readers get the match's goals and dismissals as a list.
  const key = element("ol", "sr-only");
  for (const event of events.filter((item) => HOME_GOALS.has(item.kind) || item.kind === "REDCARD" || item.kind === "YELLOWREDCARD")) {
    key.append(element("li", "", `${event.home ? teamName(home, teams) : teamName(away, teams)}: ${homeEventText(event)}`));
  }
  card.append(scroll, key);
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

function renderHomeStatistics(fixture, teams) {
  const card = homeCard("home-statistics", t("MAÇ"), t("Maç İstatistikleri"));
  const sides = [fixture.home_team_id, fixture.away_team_id];
  if (matchweekResults.metricsStatus === "idle") loadMatchweekResultMetrics();
  const metrics = matchweekResults.metrics.filter((row) => row.fixture_id === fixture.fixture_id);
  card.append(matchweekVersusHeader(sides, teams));
  for (const row of homeStatisticRows()) {
    const rows = metrics.filter((metric) => (metric.source || "statistics") === row.source);
    const values = matchweekStatisticValues(rows, sides, row.type, row.percent);
    card.append(matchweekVersusRow(row.label, values.map((value) => ({
      value: value === null ? "—" : row.percent ? percentText(value) : row.decimals ? value.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : displayNumber(value),
      note: "" })), values));
  }
  const status = matchweekResults.metricsStatus;
  card.append(element("p", "home-card-note", status === "loading" || status === "idle" ? t("Maç istatistikleri yükleniyor…")
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

function renderHomeLineups(fixture, teams) {
  const card = homeCard("home-lineups", t("KADROLAR"), t("İlk 11'ler"));
  const sides = [fixture.home_team_id, fixture.away_team_id];
  const rows = (state.tables["player_match_stats.csv"] || []).filter((row) => row.fixture_id === fixture.fixture_id);
  const starters = sides.map((team) => rows.filter((row) => row.team_id === team && ["1", "true"].includes(String(row.started).toLowerCase())));
  const pitch = element("div", "home-pitch");
  pitch.setAttribute("role", "group");
  pitch.setAttribute("aria-label", t("{top} üstte, {bottom} altta", { top: teamName(sides[1], teams), bottom: teamName(sides[0], teams) }));
  const markings = element("div", "pitch-markings");
  markings.setAttribute("aria-hidden", "true");
  markings.append(element("span", "pitch-circle"), element("span", "pitch-box pitch-box-top"), element("span", "pitch-box pitch-box-bottom"));
  const away = homePitchHalf(sides[1], starters[1], true), home = homePitchHalf(sides[0], starters[0], false);
  pitch.append(markings, away.half, home.half);
  card.append(homeLineupCaption(fixture, sides[1], teams, 1), pitch, homeLineupCaption(fixture, sides[0], teams, 0));

  // Who came on, from the match's substitution events.
  const subs = homeSubstitutions(fixture);
  if (subs.length) {
    const details = element("details", "home-subs");
    details.append(element("summary", "", t("Oyuncu değişiklikleri ({count})", { count: subs.length })));
    for (const [index, team] of sides.entries()) {
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
    card.append(details);
  }
  // How to read the pitch is its hover text; only the warning that a side's
  // shape is a guess stays on the card.
  const exact = away.exact && home.exact;
  pitch.title = `${exact ? `${t("Kaydedilmiş dizilişler.")} ` : ""}${t("Numara forma numarasıdır; tam ad için oyuncunun üzerine gelin.")}`;
  if (!exact) card.append(element("p", "home-card-note", t("Dizilişi kaydedilmemiş takımın oyuncuları mevkilerine göre gruplandı; sıraları kesin değildir.")));
  return card;
}

function homeSubstitutions(fixture) {
  if (teamAnalysisExtras.key !== state.seasonSlug || !teamAnalysisExtras.events) return [];
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
function homePlayerTotal(fixture, teamId, column) {
  const rows = (state.tables["player_match_stats.csv"] || [])
    .filter((row) => row.fixture_id === fixture.fixture_id && row.team_id === teamId && playerAppeared(row));
  if (!rows.length) return null;
  let total = 0;
  for (const row of rows) {
    const value = countedValue(row, column);
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
  const own = (teamAnalysisExtras.events || []).filter((event) => String(event.fixture_id) === String(fixture.fixture_id));
  if (!own.length) return [null, null];
  const counts = [0, 0];
  for (const event of own) {
    if (["true", "1"].includes(String(event.rescinded).toLowerCase())) continue;
    const kind = String(event["type.developer_name"] || "").toUpperCase();
    if (kind !== "PENALTY" && !(kind === "GOAL" && String(event.info || "").toLowerCase() === "free kick")) continue;
    const index = sides.indexOf(String(event.participant_id || event.team_id || ""));
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
  if (matchweekResults.metricsStatus === "idle") loadMatchweekResultMetrics();
  const metrics = matchweekResults.metrics.filter((row) => row.fixture_id === fixture.fixture_id);
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
function homeSeasonMatches() {
  const fixtures = state.tables["fixtures.csv"] || [];
  if (homeSeason.rows === matchweekResults.metrics && homeSeason.fixtures === fixtures) return homeSeason.matches;
  const finished = new Set(fixtures.filter(fixtureFinished).map((fixture) => String(fixture.fixture_id)));
  const matches = new Map();
  for (const row of matchweekResults.metrics) {
    const fixture = String(row.fixture_id), team = String(row.team_id);
    if (!finished.has(fixture)) continue;
    const key = `${fixture}|${team}`;
    if (!matches.has(key)) matches.set(key, { fixture, team, values: new Map() });
    const values = matches.get(key).values, id = `${row.source || "statistics"}|${row.type_id}`;
    values.set(id, values.has(id) ? null : number(row.value));
  }
  Object.assign(homeSeason, { rows: matchweekResults.metrics, fixtures, matches: [...matches.values()] });
  return homeSeason.matches;
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
  const season = homeSeasonMatches();
  const scale = element("div", "home-rank-scale");
  scale.setAttribute("aria-hidden", "true");
  scale.append(element("span", "", t("en düşük")), element("span", "", t("sezonun en yükseği")));
  card.append(homeDotLegend(fixture, teams), scale);
  for (const measure of HOME_SEASON_RANKS) {
    const row = element("div", "home-rank-row");
    const track = element("div", "home-rank-track");
    const spoken = [];
    sides.forEach((team, index) => {
      const own = season.filter((match) => match.team === team);
      const value = homeMatchValue(own.find((match) => match.fixture === String(fixture.fixture_id)), measure);
      const known = own.map((match) => homeMatchValue(match, measure)).filter((other) => other !== null);
      if (value === null || known.length < 2) { spoken.push(`${teamName(team, teams)}: —`); return; }
      const below = known.filter((other) => other < value).length, equal = known.filter((other) => other === value).length;
      const place = (below + (equal - 1) / 2) / (known.length - 1);
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
function renderHomePassingStyle(fixture, teams) {
  const card = homeCard("home-passing", t("PAS"), t("Ligde Pas Tarzı"));
  if (!homeSeasonStatus(card)) return card;
  const longShare = { ratio: [62, 80] }, accuracy = { ratio: [81, 80] };
  const points = homeSeasonMatches().map((match) => ({ match, x: homeMatchValue(match, longShare), y: homeMatchValue(match, accuracy) }))
    .filter((point) => point.x !== null && point.y !== null);
  if (points.length < 2) {
    card.append(element("p", "home-card-note", t("Bu sezon için pas verisi yok."))); return card;
  }
  // Low enough that the card is no taller than Fiziksel Mücadele.
  const width = 300, height = 180, left = 30, right = 8, top = 18, bottom = 28;
  const span = (values) => {
    const low = Math.min(...values), high = Math.max(...values), pad = (high - low) * 0.06 || 1;
    return [low - pad, high + pad];
  };
  const [x0, x1] = span(points.map((point) => point.x)), [y0, y1] = span(points.map((point) => point.y));
  const x = (value) => left + (value - x0) / (x1 - x0) * (width - left - right);
  const y = (value) => height - bottom - (value - y0) / (y1 - y0) * (height - top - bottom);
  const sides = [String(fixture.home_team_id), String(fixture.away_team_id)];
  const own = sides.map((team) => points.find((point) => point.match.fixture === String(fixture.fixture_id) && point.match.team === team) || null);
  const label = own.map((point, index) => point
    ? t("{team}: uzun pas oranı {long}, pas isabeti {accuracy}", { team: teamName(sides[index], teams),
      long: homeMeasureText({ percent: true }, point.x), accuracy: homeMeasureText({ percent: true }, point.y) })
    : t("{team}: veri yok", { team: teamName(sides[index], teams) }));
  const svg = homeSvg(null, "svg", { viewBox: `0 0 ${width} ${height}`, role: "img", class: "home-passing-chart",
    "aria-label": `${t("Bu sezonun {count} takım-maçında uzun pas oranı ve pas isabeti.", { count: points.length })} ${label.join(". ")}.` });
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
  own.forEach((point, index) => {
    if (!point) return;
    const group = homeSvg(svg, "g");
    homeSvg(group, "title", {}, label[index]);
    homeSvg(group, "circle", { cx: x(point.x), cy: y(point.y), r: 5, class: `home-passing-own home-passing-${index ? "away" : "home"}` });
    const onRight = x(point.x) < width - right - 40;
    homeSvg(group, "text", { x: x(point.x) + (onRight ? 8 : -8), y: y(point.y) + 3.5, "text-anchor": onRight ? "start" : "end", class: "home-passing-name" },
      homeShortName(sides[index], teams));
  });
  // In a box, so the card's side margins fall on the box and the chart fills it.
  const plot = element("div", "home-passing-plot");
  plot.append(svg);
  card.append(plot);
  return card;
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
  const season = homeSeasonMatches(), id = String(fixture.fixture_id);
  const rows = HOME_SEASON_SHIFTS.map((measure) => ({
    measure,
    sides: sides.map((team) => {
      const own = season.filter((match) => match.team === team);
      const value = homeMatchValue(own.find((match) => match.fixture === id), measure);
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
  if (teamAnalysisExtras.key !== state.seasonSlug || teamAnalysisExtras.state !== "ready") return note(t("Maç olayları yükleniyor…"));
  if (!teamAnalysisExtras.events) return note(t("events.csv okunamadı."));
  const id = String(fixture.fixture_id);
  const rows = teamAnalysisExtras.events.filter((event) => String(event.fixture_id) === id).map((event) => ({
    record_type: "event", fixture_id: id, event_id: String(event.event_id || event.id || ""),
    minute: event.minute, extra_minute: event.extra_minute, sort_order: event.sort_order,
    code: event["type.developer_name"], label: event["type.name"], team_id: String(event.participant_id || event.team_id || ""),
    player_id: event.player_id, player_name: event.player_name, related_player_id: event.related_player_id,
    related_player_name: event.related_player_name, result: event.result, info: event.info, addition: event.addition,
    rescinded: event.rescinded,
  }));
  if (list.dataset.fixture !== id) list.scrollTop = 0;
  list.dataset.fixture = id;
  renderLiveEvents({ fixture_id: id, events_available: "1" }, teams, rows, list);
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
function highlightHomeEvents(at) {
  const list = $("home-events-list");
  const items = [...list.querySelectorAll("li[data-at]")];
  if (!items.length) return;
  const distance = (item) => Math.abs(Number(item.dataset.at) - at);
  const nearest = items.reduce((best, item) => (distance(item) < distance(best) ? item : best));
  for (const item of items) item.classList.toggle("is-current", item.dataset.at === nearest.dataset.at);
  const view = list.getBoundingClientRect(), box = nearest.getBoundingClientRect();
  if (box.top < view.top) list.scrollTop -= view.top - box.top;
  else if (box.bottom > view.bottom) list.scrollTop += box.bottom - view.bottom;
}

function renderHomeDetail(game, teams) {
  const detail = $("home-detail");
  renderHomeEvents(game?.fixture, teams);
  if (!game) {
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
  const pair = element("div", "home-pair");
  pair.append(renderHomeStatistics(fixture, teams), renderHomeLineups(fixture, teams));
  // Below them, six cards of one size in two columns: under the statistics,
  // this match against the season; under İlk 11'ler, its battles and phases.
  const more = element("div", "home-more");
  more.append(renderHomeSeasonRanks(fixture, teams), renderHomePassingStyle(fixture, teams), renderHomeSeasonShifts(fixture, teams),
    renderHomePhysical(fixture, teams), renderHomeSetPieces(fixture, teams), renderHomePhases(fixture, teams));
  // Each part sits in a row of its own (home.css) that its cards size themselves against.
  const row = (part) => { const box = element("div", "home-row"); box.append(part); return box; };
  detail.replaceChildren(row(renderHomeScoreboard(game, teams)), row(renderHomeMomentum(fixture, teams)), row(pair), row(more));
}

function renderHome() {
  const teams = homeTeams();
  const season = $("season-label").textContent;
  $("home-season-note").textContent = season !== "—" ? t("{season} sezonu · Sportmonks verisi", { season }) : t("Başlamak için standings.csv, fixtures.csv, teams.csv ve fixture_scores.csv dosyalarını açın.");
  if (state.seasonSlug) {
    if (teamAnalysisExtras.key !== state.seasonSlug) loadTeamAnalysisExtras();
    if (homeExtras.key !== state.seasonSlug) loadHomeExtras();
  }
  const games = homePlayedGames();
  if (!games.some((game) => game.fixture.fixture_id === state.homeFixture)) state.homeFixture = games[0]?.fixture.fixture_id ?? null;
  renderStandings(teams, "standings", { record: true });
  renderHomeGames(games, teams);
  renderHomeDetail(games.find((game) => game.fixture.fixture_id === state.homeFixture), teams);
}

function setupHome() {
  $("standings-group").addEventListener("change", (event) => { state.standingsGroup = event.target.value; renderHome(); });
  // Another week changes only the list; the match on show stays until one is clicked.
  $("home-games-week").addEventListener("change", (event) => {
    state.homeWeek = event.target.value;
    renderHomeGames(homePlayedGames(), homeTeams());
  });
  for (const [id, step] of [["home-week-prev", -1], ["home-week-next", 1]]) {
    $(id).addEventListener("click", () => {
      const weeks = homeWeeks(), next = weeks[weeks.findIndex((week) => week.key === state.homeWeek) + step];
      if (!next) return;
      state.homeWeek = next.key;
      renderHomeGames(homePlayedGames(), homeTeams());
    });
  }
  $("home-games-list").addEventListener("click", (event) => {
    const button = event.target.closest(".home-game");
    if (!button) return;
    state.homeFixture = button.dataset.fixture;
    renderHome();
    $("home-games-list").querySelector(`[data-fixture="${CSS.escape(state.homeFixture)}"]`)?.focus({ preventScroll: true });
    // On a narrow screen the match sits away from the list: bring it into view.
    const box = $("home-detail").getBoundingClientRect();
    if (box.top < 0 || box.top > window.innerHeight * 0.6) $("home-detail").scrollIntoView({ block: "start" });
  });
}
