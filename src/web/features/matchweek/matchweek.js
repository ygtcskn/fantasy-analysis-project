"use strict";

const matchweekOdds = { request: 0, season: "", rows: [], note: "" };
const matchweekZone = MATCH_TIME_ZONE;
const matchweekDayMs = 86400000;
let selectedMatchweekFixture = null;
// The analysis opens as a row of the odds table under the chosen match, and
// waits in a hidden holder whenever no match is open.
const matchweekAnalysisSection = document.getElementById("matchweek-analysis");

function resetMatchweekOdds() {
  matchweekOdds.request++;
  Object.assign(matchweekOdds, { season: "", rows: [], note: "" });
}

// Compare calendar dates in Turkey, independently of the visitor's time zone.
function matchweekDay(time) {
  const parts = new Intl.DateTimeFormat("en", { timeZone: matchweekZone,
    year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(time);
  const value = (type) => Number(parts.find((part) => part.type === type).value);
  return Date.UTC(value("year"), value("month") - 1, value("day"));
}

async function loadMatchweekOdds() {
  const request = ++matchweekOdds.request, season = state.seasonSlug;
  if (!season) return;
  try {
    const rows = await readFantasyCSV("odds/predictions.csv", ["fixture_id", "season", "phase",
      "candidate", "home_team_id", "away_team_id", "kickoff_utc", "generated_at_utc",
      "home_probability", "draw_probability", "away_probability"], season);
    if (request !== matchweekOdds.request || season !== state.seasonSlug) return;
    Object.assign(matchweekOdds, { season, rows: rows.filter((row) => row.season.replace("/", "-") === season && row.phase === "forecast"), note: "" });
  } catch {
    if (request !== matchweekOdds.request || season !== state.seasonSlug) return;
    Object.assign(matchweekOdds, { season, rows: [], note: t("Kaydedilmiş maç tahminleri yüklenemedi.") });
  }
  if (state.view === "matchweek") renderMatchweek();
}

function renderMatchweek() {
  const today = matchweekDay(Date.now());
  const start = today - ((new Date(today).getUTCDay() + 5) % 7) * matchweekDayMs;
  const end = start + 7 * matchweekDayMs;
  const dateLabel = (date) => new Intl.DateTimeFormat(LOCALE, {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  }).format(date);
  $("matchweek-range").textContent = `${dateLabel(start)} – ${dateLabel(end - matchweekDayMs)}`;
  const fixtures = (state.tables["fixtures.csv"] || []).filter((fixture) => {
    const kickoff = fantasyKickoff(fixture);
    return Number.isFinite(kickoff) && matchweekDay(kickoff) >= start && matchweekDay(kickoff) < end;
  }).sort((a, b) => fantasyKickoff(a) - fantasyKickoff(b) || String(a.fixture_id).localeCompare(String(b.fixture_id)));
  const ids = new Set(fixtures.map((fixture) => fixture.fixture_id));
  if (!ids.has(selectedMatchweekFixture)) selectedMatchweekFixture = null;
  const rows = matchweekOdds.season === state.seasonSlug ? matchweekOdds.rows.filter((row) => ids.has(row.fixture_id)) : [];
  const candidates = [...new Set(rows.map((row) => row.candidate).filter(Boolean))].sort();
  const select = $("matchweek-model"), previous = select.value;
  select.replaceChildren(...candidates.map((candidate) => new Option(candidate.replace("poisson", "Poisson").replace("xgboost", "XGBoost").replace("_hl", " · "), candidate)));
  if (!candidates.length) select.add(new Option(t("Tahmin yok"), ""));
  select.value = candidates.includes(previous) ? previous : candidates[0] || "";
  select.disabled = !candidates.length;
  const teams = homeTeams(), body = document.createDocumentFragment();
  renderStandings(teams, "matchweek-standings");
  let missing = 0;
  let selectedAnalysis = null;
  for (const savedFixture of fixtures) {
    const fixture = matchweekEffectiveFixture(savedFixture), finished = matchweekFinished(fixture);
    const kickoff = fantasyKickoff(fixture), tr = element("tr");
    tr.className = "matchweek-selectable";
    tr.classList.toggle("matchweek-selected", fixture.fixture_id === selectedMatchweekFixture);
    tr.addEventListener("click", () => {
      selectedMatchweekFixture = selectedMatchweekFixture === fixture.fixture_id ? null : fixture.fixture_id;
      renderMatchweek();
      document.getElementById(`matchweek-select-${fixture.fixture_id}`)?.focus({ preventScroll: true });
    });
    tr.append(element("td", "", new Intl.DateTimeFormat(LOCALE, { timeZone: matchweekZone, weekday: "long", day: "numeric", month: "short" }).format(kickoff)),
      element("td", "", new Intl.DateTimeFormat(LOCALE, { timeZone: matchweekZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(kickoff)));
    const clubCells = [fixture.home_team_id, fixture.away_team_id].map((id) => {
      const cell = element("td"), club = element("div", "matchweek-club");
      club.append(createTeamLogo(id, teams, false), element("span", "", teamName(id, teams)));
      cell.append(club); return cell;
    });
    const matching = rows.filter((row) => row.fixture_id === fixture.fixture_id && row.candidate === select.value
      && row.home_team_id === fixture.home_team_id && row.away_team_id === fixture.away_team_id
      && fantasyTime(row.kickoff_utc) === kickoff
      && fantasyTime(row.generated_at_utc) <= Math.min(Date.now(), kickoff));
    const prediction = matching.length === 1 ? matching[0] : null;
    const probabilities = ["home_probability", "draw_probability", "away_probability"].map((field) => number(prediction?.[field]));
    const valid = prediction && probabilities.every((value) => value !== null && value >= 0 && value <= 1)
      && Math.abs(probabilities.reduce((sum, value) => sum + value, 0) - 1) < 0.001;
    if (!valid && !finished) missing++;
    if (fixture.fixture_id === selectedMatchweekFixture) selectedAnalysis = { fixture, prediction: valid ? prediction : null };
    const oddsCell = element("td"), odds = element("button", "matchweek-odds matchweek-select");
    odds.type = "button";
    // 1 and 2 carry the clubs' own colours, as every club comparison does.
    teamColorPair(fixture.home_team_id, fixture.away_team_id)
      .forEach((color, index) => odds.style.setProperty(`--matchweek-${index ? "away" : "home"}`, color));
    odds.id = `matchweek-select-${fixture.fixture_id}`;
    const pairing = `${teamName(fixture.home_team_id, teams)} – ${teamName(fixture.away_team_id, teams)}`;
    odds.setAttribute("aria-label", finished ? t("{match} maç sonucunu ve istatistiklerini göster", { match: pairing }) : t("{match} maç analizini göster", { match: pairing }));
    odds.setAttribute("aria-controls", "matchweek-analysis");
    odds.setAttribute("aria-expanded", String(fixture.fixture_id === selectedMatchweekFixture));
    if (finished) odds.append(matchweekResultBadge(fixture));
    else probabilities.forEach((probability, index) => {
      const label = ["1", "X", "2"][index];
      const badge = element("span", `matchweek-odd${valid ? ` matchweek-odd-${index}` : ""}`);
      badge.append(element("span", "", label), element("strong", "", valid ? percentText(probability * 100, 1) : "—"));
      odds.append(badge);
    });
    oddsCell.append(odds);
    tr.append(clubCells[0], oddsCell, clubCells[1]);
    body.append(tr);
    if (fixture.fixture_id === selectedMatchweekFixture) {
      const details = element("tr", "matchweek-details-row"), cell = element("td", "matchweek-details-cell");
      cell.colSpan = 5;
      cell.append(matchweekAnalysisSection);
      details.append(cell);
      body.append(details);
    }
  }
  if (!selectedAnalysis) $("matchweek-analysis-home").append(matchweekAnalysisSection);
  if (!fixtures.length) {
    const row = element("tr"), cell = element("td", "no-results", state.tables["fixtures.csv"]
      ? t("Bu hafta için kaydedilmiş maç bulunmuyor.") : t("Haftanın maçları için sezon verilerini yükleyin."));
    cell.colSpan = 5; row.append(cell); body.append(row);
  }
  $("matchweek-matches").replaceChildren(body);
  renderMatchweekAnalysis(selectedAnalysis, teams);
  $("matchweek-note").textContent = missing
    ? (matchweekOdds.season === state.seasonSlug && matchweekOdds.note)
      // Only the person running the site can refresh the analysis; visitors just learn there is no forecast.
      || (siteMode === "published" ? t("— Bu maç için tahmin yok.") : t("— Bu maç için eşleşen tahmin yok; analiz çıktısını yenileyin.")) : "";
}

function renderMatchweekAnalysis(selection, teams) {
  const content = $("matchweek-analysis-content");
  $("matchweek-analysis-title").textContent = selection && matchweekFinished(selection.fixture) ? t("Maç Sonucu ve İstatistikleri") : t("Maç Analizi");
  content.replaceChildren();
  if (!selection) {
    content.append(element("p", "message", t("Analizi görmek için yukarıdan bir maç seçin.")));
    return;
  }
  const { fixture } = selection;
  if (matchweekFinished(fixture)) {
    renderMatchweekResult(fixture, teams, content);
    return;
  }
  const scores = currentFixtureScores();
  const homeScore = scores.get(`${fixture.fixture_id}:${fixture.home_team_id}`);
  const awayScore = scores.get(`${fixture.fixture_id}:${fixture.away_team_id}`);
  if (!fixtureUnplayed(fixture) && homeScore != null && awayScore != null) {
    content.append(element("p", "", t("Kaydedilmiş skor: {score}", { score: `${homeScore} – ${awayScore}` })));
  }
  // Laid out top to bottom: last elevens face to face, the season's league
  // statistics side by side, each club's last five beside its fantasy points
  // per game, then the fantasy comparison and each club's best fantasy picks.
  // A finished match reuses these cards (results.js).
  const sides = [fixture.home_team_id, fixture.away_team_id];
  const histories = sides.map((id) => matchweekTeamHistory(id, fixture));
  const xi = matchweekElevensCard(sides, t("Son 11'ler"), (id, index) => matchweekLastXI(id, histories[index][0], teams));

  const fantasy = matchweekFantasyTeams(fixture);
  const fantasyCard = matchweekCard("matchweek-preview-fantasy", t("Fantezi istatistikleri"));
  fantasyCard.append(matchweekVersusHeader(sides, teams));
  for (const [key, label] of matchweekFantasyGroups) {
    if (key === "UNKNOWN" && fantasy.every((team) => !team.buckets.get(key).count)) continue;
    fantasyCard.append(matchweekVersusRow(label, fantasy.map((team) => {
      const bucket = team.buckets.get(key);
      if (!bucket.available) return { value: "—", note: "", title: bucket.count ? t("Geçerli tahmin yok") : t("Oyuncu tahmini yok") };
      const partial = bucket.available < bucket.count;
      return { value: `${displayNumber(bucket.points)}${partial ? "*" : ""}`, note: "",
        title: `${t("{available}/{count} oyuncunun tahmini", { available: bucket.available, count: bucket.count })}${partial ? ` · ${t("Kısmi toplam")}` : ""}` };
    })));
  }
  const best = sides.map((id, index) => matchweekPlayersCard(id, index, teams, t("En iyi oyuncular · Sezon"),
    matchweekSeasonPlayers(id, fixture).slice(0, 5), t("Bu sezon için fantezi puanı yok."),
    (player) => t("{name} · {position} · {matches} maç · {average} FP / maç · Reyting {ratings} maçın ortalaması", { name: player.name,
      position: player.position ? fantasyPositionCode(player.position) : t("Mevki yok"), matches: player.matches,
      average: displayNumber(player.points / player.matches), ratings: player.ratings })));

  const notes = element("details", "matchweek-notes");
  notes.append(element("summary", "", t("Açıklamalar")),
    element("p", "", t("Son 11, geçmiş maçın kadrosudur; tahmini kadro değildir.")),
    element("p", "", matchweekSeasonStatsNote),
    element("p", "", matchweekFormNote),
    element("p", "", t("Fantezi değerleri bu maç için beklenen oyuncu puanlarıdır, Kadro Kur'dakiyle aynı: sakatlık ve ceza bildirimi dikkate alınır, oynamayacak oyuncu 0 sayılır, durumu belirsiz oyuncunun tahmini gösterilmez. En iyi 3, en yüksek beklenen puanlı 3 oyuncunun toplamıdır; mevki satırları o mevkideki tüm oyuncuların toplamıdır. * kısmi toplam: bazı oyuncuların geçerli tahmini yok. Bu değerler üstteki maç sonucu modeli seçimiyle değişmez.")),
    element("p", "", matchweekTrendNote),
    element("p", "", t("En iyi oyuncular, bu sezon kulüp için aldıkları toplam fantezi puanına (FP) göre sıralanır. Reyting, Sportmonks maç reytinglerinin ortalamasıdır (yalnızca süre alınan ve reytingi olan maçlar). Son maçını başka bir kulüpte oynayan ve ligden ayrılan oyuncular listelenmez.")));
  content.append(matchweekCardGrid(sides, [xi, matchweekSeasonStatsCard(fixture, sides, teams),
    matchweekFormCard(sides, histories, teams, scores), matchweekTrendCard(fixture, sides, teams), fantasyCard, ...best]), notes);
}

const matchweekSeasonStatsNote = t("Sezon istatistikleri kaydedilmiş sezonun tamamlanmış maçlarındaki toplamlardır. Altındaki sayı lig sırasıdır: en yüksek toplam 1. olur, eşit toplamlar aynı sırayı alır. Kartlar, maç sonucu tablosu ve canlı maç merkezindeki gibi takım istatistiğinden sayılır: Sportmonks ikinci sarıyı da sarı kart sayar; kırmızı kart, doğrudan veya ikinci sarıdan her oyundan atılmadır. İstatistiği kaydedilmiş bir maçta boş kart değeri 0 kabul edilir.");
const matchweekFormNote = t("Son 5 maç, seçilen maçtan önceki tamamlanmış sezon maçlarıdır, yeniden eskiye. G: galibiyet, B: beraberlik, M: mağlubiyet; İ: iç saha, D: deplasman.");
const matchweekTrendNote = t("Fantezi puanları grafiği, takımın seçilen maçtan önceki her tamamlanmış maçta oyuncularının aldığı fantezi puanlarının toplamıdır (bonus dahil); yatay eksen hafta, dikey eksen puandır. Her takım kendi rengiyle çizilir. Ayrıntı için bir haftanın üzerine gelin.");

function matchweekCard(className, title) {
  const section = element("section", `matchweek-card ${className}`);
  if (title) section.append(element("h3", "", title));
  return section;
}

// The cards of one match, each club drawn in its own colour; the away side
// falls back to its second colour when the two would be hard to tell apart.
function matchweekCardGrid(sides, cards) {
  const grid = element("div", "matchweek-preview");
  teamColorPair(...sides).forEach((color, index) => grid.style.setProperty(`--matchweek-${index ? "away" : "home"}`, color));
  grid.append(...cards);
  return grid;
}

// The two elevens face to face; draw(id, index) returns one club's pitch.
function matchweekElevensCard(sides, label, draw) {
  const lineups = element("div", "matchweek-lineups");
  sides.forEach((id, index) => {
    if (index) lineups.append(element("span", "matchweek-versus", "VS"));
    lineups.append(draw(id, index));
  });
  const xi = matchweekCard("matchweek-preview-xi");
  xi.setAttribute("aria-label", label);
  xi.append(lineups);
  return xi;
}

function matchweekSeasonStatsCard(fixture, sides, teams) {
  const stats = matchweekCard("matchweek-preview-stats", t("Sezon istatistikleri"));
  stats.append(matchweekVersusHeader(sides, teams));
  for (const row of matchweekLeagueRanks(fixture)) {
    const values = row.sides.map((side) => side ? side.value : null);
    stats.append(matchweekVersusRow(row.versusLabel, row.sides.map((side, index) => side
      ? { value: String(side.value), note: ordinalText(side.rank), title: row.card
        ? t("{games}/{played} maçta kart verisi · {teams} takım arasında {rank}", { games: side.games, played: side.played, teams: row.teams, rank: ordinalText(side.rank) })
        : t("{played} maç · {teams} takım arasında {rank}", { played: side.played, teams: row.teams, rank: ordinalText(side.rank) }) }
      : { value: "—", note: "", title: t("{team} için yeterli veri yok", { team: teamName(sides[index], teams) }) }), values));
  }
  return stats;
}

function matchweekFormCard(sides, histories, teams, scores) {
  const form = matchweekCard("matchweek-preview-form", t("Son 5 maç"));
  const formTeams = element("div", "matchweek-form-teams");
  sides.forEach((id, index) => formTeams.append(matchweekLastFive(id, histories[index], teams, scores)));
  form.append(formTeams);
  return form;
}

function matchweekTrendCard(fixture, sides, teams) {
  const graph = matchweekCard("matchweek-preview-graph", t("Fantezi puanları · Maç başına"));
  graph.append(matchweekFantasyTrend(fixture, sides, teams));
  return graph;
}

// One club's five best players: name, Sportmonks rating and fantasy points.
// describe(player) is the hover text.
function matchweekPlayersCard(teamId, index, teams, subtitle, players, empty, describe) {
  const section = matchweekCard(`matchweek-preview-players matchweek-preview-players-${index ? "away" : "home"}`);
  const heading = element("h3", "matchweek-card-club");
  heading.append(createTeamLogo(teamId, teams, false), element("span", "", teamName(teamId, teams)));
  section.append(heading, element("p", "matchweek-card-subtitle", subtitle));
  if (!players.length) { section.append(element("p", "message", empty)); return section; }
  const list = element("ol", "matchweek-best-players"), head = element("li", "matchweek-best-head");
  head.setAttribute("aria-hidden", "true");
  head.append(element("span", "", t("Oyuncu")), element("span", "", t("Reyting")), element("span", "", "FP"));
  list.append(head);
  for (const player of players) {
    const item = element("li");
    item.title = describe(player);
    item.setAttribute("aria-label", t("{name}: reyting {rating}, fantezi puanı {points}", { name: player.name, rating: ratingText(player.rating), points: displayNumber(player.points) }));
    item.append(element("span", "matchweek-best-name", player.name), element("span", "matchweek-best-rating", ratingText(player.rating)),
      element("strong", "", displayNumber(player.points)));
    list.append(item);
  }
  section.append(list);
  return section;
}

// A row of club logos over the two value columns of a side-by-side card.
function matchweekVersusHeader(sides, teams) {
  const header = element("div", "matchweek-versus-head");
  header.setAttribute("aria-hidden", "true");
  sides.forEach((id, index) => {
    if (index) header.append(element("span"));
    const club = element("span", "matchweek-versus-club");
    club.append(createTeamLogo(id, teams, false), element("span", "", teams.get(id)?.short_code || teamName(id, teams)));
    header.append(club);
  });
  return header;
}

// One home-vs-away line: value and note on each side, the label between, and
// when numbers are given, a bar splitting their total.
function matchweekVersusRow(label, cells, values = null) {
  const row = element("div", "matchweek-versus-row");
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", `${label}: ${cells.map((cell) => `${cell.value}${cell.note ? ` (${cell.note})` : ""}`).join(" – ")}`);
  const side = (cell, className) => {
    const box = element("span", `matchweek-versus-value ${className}`);
    box.title = cell.title || "";
    box.append(element("strong", "", cell.value));
    if (cell.note) box.append(element("small", "", cell.note));
    return box;
  };
  row.append(side(cells[0], "matchweek-versus-home"), element("span", "matchweek-versus-label", label), side(cells[1], "matchweek-versus-away"));
  if (values && values.every((value) => value !== null)) {
    const bar = element("span", "matchweek-versus-bar"), total = values[0] + values[1];
    values.forEach((value, index) => {
      const part = element("span", index ? "matchweek-versus-bar-away" : "matchweek-versus-bar-home");
      // Shares fill the track even when the raw values add up to less than one.
      part.style.flexGrow = String(total > 0 ? value / total : 0.5);
      bar.append(part);
    });
    bar.setAttribute("aria-hidden", "true");
    row.append(bar);
  }
  return row;
}

const matchweekFantasyGroups = [["ALL", t("En iyi 3")], ["KL", t("Kaleci")], ["DEF", t("Defans")], ["OS", t("Orta saha")], ["FOR", t("Forvet")], ["UNKNOWN", t("Mevki belirsiz")]];

// Each side's expected fantasy points for this match, by position, and its
// players ranked by them. "ALL" is the sum of the best three positive players.
function matchweekFantasyTeams(fixture) {
  return [fixture.home_team_id, fixture.away_team_id].map((teamId) => {
    const buckets = new Map(matchweekFantasyGroups.map(([key]) => [key, { count: 0, available: 0, points: 0 }]));
    const players = [];
    if (!fantasyState.season || fantasyState.season !== state.seasonSlug) return { buckets, players };
    for (const [playerId, rows] of fantasyState.projections) {
      const matching = rows.filter((row) => row.fixture_id === fixture.fixture_id && row.team_id === teamId);
      if (!matching.length) continue;
      const positions = new Set(matching.map((row) => row.position));
      const position = positions.size === 1 && buckets.has(matching[0].position) && matching[0].position !== "ALL" ? matching[0].position : "UNKNOWN";
      // The same expected points Kadro Kur shows: fixture and deadline guards,
      // and availability applied (out counts 0, uncertain shows nothing).
      const projection = matching.length === 1 ? builderFantasyData({ id: playerId, squadTeam: teamId }).projection : null;
      const points = projection?.fixture_id === fixture.fixture_id ? fantasyProjectionNumber(projection, "expected_points") : null;
      for (const key of ["ALL", position]) buckets.get(key).count++;
      if (points === null) continue;
      const bucket = buckets.get(position);
      bucket.available++; bucket.points += points;
      players.push({ id: playerId, name: playerName(playerId, projection.player_name), position, points, availability: projection.availability_status });
    }
    players.sort((a, b) => b.points - a.points || String(a.id).localeCompare(String(b.id)));
    const all = buckets.get("ALL");
    all.available = players.length;
    all.points = players.filter((player) => player.points > 0).slice(0, 3).reduce((sum, player) => sum + player.points, 0);
    return { buckets, players };
  });
}

// The club's current players ranked by season fantasy points, with their mean
// Sportmonks rating. Only the club's own games before the selected match count.
// A player whose latest game was for another club is left out, and so is one
// who has left the league - the rule every other player list follows
// (leaguePlayers in tier-list.js).
function matchweekSeasonPlayers(teamId, fixture) {
  if (!fantasyState.season || fantasyState.season !== state.seasonSlug) return [];
  const cutoff = Math.min(Date.now(), fantasyKickoff(fixture)), players = [];
  for (const [id, rows] of fantasyState.matches) {
    if (rows[0]?.team_id !== teamId || (currentSquad && !currentSquad.has(id))) continue;
    const own = rows.filter((row) => row.team_id === teamId && row.fixture_id !== fixture.fixture_id && fantasyTime(row.kickoff_utc) < cutoff);
    const points = own.map((row) => number(row.points_total)).filter((value) => value !== null);
    if (!points.length) continue;
    const ratings = own.map(validMatchRating).filter((value) => value !== null);
    players.push({ id, name: playerName(id, fantasyState.summaries.get(id)?.player_name || own[0].player_name),
      position: own[0].fantasy_position, matches: points.length, points: points.reduce((sum, value) => sum + value, 0),
      rating: ratings.length ? ratings.reduce((sum, value) => sum + value, 0) / ratings.length : null, ratings: ratings.length });
  }
  return players.sort((a, b) => b.points - a.points || (b.rating ?? 0) - (a.rating ?? 0) || a.name.localeCompare(b.name, LOCALE));
}

// A club's fantasy points per completed game before the selected match: the
// sum of its players' points, keyed by round.
function matchweekTeamFantasyRounds(teamId, fixture) {
  const games = new Map(), rounds = new Map();
  if (!fantasyState.season || fantasyState.season !== state.seasonSlug) return rounds;
  const cutoff = Math.min(Date.now(), fantasyKickoff(fixture));
  for (const rows of fantasyState.matches.values()) {
    for (const row of rows) {
      const points = number(row.points_total), kickoff = fantasyTime(row.kickoff_utc);
      if (row.team_id !== teamId || row.fixture_id === fixture.fixture_id || points === null || !(kickoff < cutoff)) continue;
      if (!games.has(row.fixture_id)) games.set(row.fixture_id, { round: String(row.round), opponent: row.opponent_id, home: row.venue === "home", kickoff, points: 0, players: 0 });
      const game = games.get(row.fixture_id);
      game.points += points; game.players++;
    }
  }
  // A rescheduled game can share a round with another; it keeps its own row.
  for (const game of [...games.values()].sort((a, b) => a.kickoff - b.kickoff)) {
    let key = game.round;
    for (let n = 2; rounds.has(key); n++) key = `${game.round}·${n}`;
    rounds.set(key, game);
  }
  return rounds;
}

// Both clubs' fantasy points per game: weeks along the x axis, oldest on the
// left, points up the y axis. Weeks sit at percentage positions, so the plot
// fills whatever width the card has; the height is fixed.
function matchweekFantasyTrend(fixture, sides, teams) {
  const wrap = element("div", "matchweek-trend");
  const series = sides.map((id) => matchweekTeamFantasyRounds(id, fixture));
  const rounds = [...new Set(series.flatMap((games) => [...games.keys()]))]
    .sort((a, b) => parseFloat(a) - parseFloat(b) || a.localeCompare(b));
  if (!rounds.length) { wrap.append(element("p", "message", t("Fantezi puanı olan tamamlanmış maç yok."))); return wrap; }
  const code = (id) => teams.get(id)?.short_code || teamName(id, teams);
  const kinds = ["home", "away"];

  const legend = element("div", "matchweek-trend-legend");
  sides.forEach((id, index) => {
    const values = [...series[index].values()].map((game) => game.points);
    const item = element("span", "matchweek-trend-key");
    item.append(element("span", `matchweek-trend-swatch matchweek-trend-swatch-${kinds[index]}`), element("span", "",
      `${code(id)}${values.length ? ` · ${t("ort. {value}", { value: displayNumber(values.reduce((sum, value) => sum + value, 0) / values.length) })}` : ""}`));
    legend.append(item);
  });

  const points = series.flatMap((games) => [...games.values()].map((game) => game.points));
  const span = Math.max(...points.map(Math.abs), 1), step = span > 100 ? 50 : span > 40 ? 20 : 10;
  const low = Math.min(0, Math.floor(Math.min(...points) / step) * step), high = Math.max(step, Math.ceil(Math.max(...points) / step) * step);
  const height = 150, inset = 6, axis = 16;
  const y = (value) => inset + ((high - value) / (high - low)) * (height - 2 * inset);
  const x = (index) => `${((index + 0.5) / rounds.length) * 100}%`;
  const svgNS = "http://www.w3.org/2000/svg";
  const draw = (tag, attributes, parent) => {
    const node = document.createElementNS(svgNS, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    parent.append(node); return node;
  };
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("height", String(height + axis));
  svg.setAttribute("aria-hidden", "true");
  // One hover column per week, under everything else.
  rounds.forEach((round, index) => {
    const hit = draw("rect", { class: "matchweek-trend-hit", x: `${(index / rounds.length) * 100}%`, y: 0, width: `${100 / rounds.length}%`, height }, svg);
    const parts = sides.map((id, side) => {
      const game = series[side].get(round);
      return game ? `${code(id)}: ${displayNumber(game.points)} FP (${code(game.opponent)}, ${game.home ? t("İ") : t("D")})` : t("{team}: maç yok", { team: code(id) });
    });
    draw("title", {}, hit).textContent = `${t("{round}. hafta", { round: round.replace("·", " · ") })} · ${parts.join(" · ")}`;
  });
  const ticks = [];
  for (let tick = low; tick <= high; tick += step) {
    ticks.push(tick);
    draw("line", { class: "matchweek-trend-grid", x1: 0, x2: "100%", y1: y(tick), y2: y(tick) }, svg);
  }
  // Week numbers under the plot; a long season labels every few weeks.
  const every = Math.ceil(rounds.length / 10);
  rounds.forEach((round, index) => {
    if (index % every && index !== rounds.length - 1) return;
    draw("text", { class: "matchweek-trend-tick", x: x(index), y: height + axis - 3, "text-anchor": "middle" }, svg).textContent = round;
  });
  series.forEach((games, side) => {
    rounds.forEach((round, index) => {
      const next = rounds[index + 1], game = games.get(round), following = next && games.get(next);
      if (game && following) draw("line", { class: `matchweek-trend-line matchweek-trend-line-${kinds[side]}`, x1: x(index), x2: x(index + 1), y1: y(game.points), y2: y(following.points) }, svg);
    });
  });
  series.forEach((games, side) => rounds.forEach((round, index) => {
    const game = games.get(round);
    if (game) draw("circle", { class: `matchweek-trend-dot matchweek-trend-dot-${kinds[side]}`, cx: x(index), cy: y(game.points), r: 4 }, svg);
  }));

  // Point values beside the plot, at the heights of their grid lines.
  const scale = element("div", "matchweek-trend-scale");
  scale.setAttribute("aria-hidden", "true");
  scale.style.height = `${height}px`;
  for (const tick of ticks) {
    const label = element("span", "", String(tick));
    label.style.top = `${y(tick)}px`;
    scale.append(label);
  }
  const plot = element("div", "matchweek-trend-plot");
  const canvas = element("div", "matchweek-trend-canvas");
  canvas.append(svg);
  plot.append(scale, canvas);

  // The same numbers as a table for screen readers. A table ignores overflow,
  // so it is hidden inside a div; on the table itself the caption showed.
  const hidden = element("div", "sr-only"), table = element("table");
  hidden.append(table);
  table.append(element("caption", "", t("Hafta hafta takım fantezi puanları")));
  const head = element("tr");
  for (const label of [t("Hafta"), teamName(sides[0], teams), teamName(sides[1], teams)]) { const cell = element("th", "", label); cell.scope = "col"; head.append(cell); }
  table.append(head);
  for (const round of rounds) {
    const row = element("tr"), name = element("th", "", t("{round}. hafta", { round: round.replace("·", " · ") })); name.scope = "row";
    row.append(name, ...series.map((games) => element("td", "", games.has(round) ? displayNumber(games.get(round).points) : "—")));
    table.append(row);
  }
  wrap.append(legend, element("p", "matchweek-trend-axis-y", t("Takım toplam fantezi puanı")), plot, hidden, element("p", "matchweek-trend-axis", t("Hafta →")));
  return wrap;
}

// A club's last five completed games, newest first, with result, venue and score.
function matchweekLastFive(teamId, history, teams, scores) {
  const section = element("div", "matchweek-form-team");
  const heading = element("h4", "matchweek-card-club");
  heading.append(createTeamLogo(teamId, teams, false), element("span", "", teamName(teamId, teams)));
  section.append(heading);
  const games = history.slice(0, 5);
  if (!games.length) { section.append(element("p", "message", t("Tamamlanmış maç yok."))); return section; }
  const list = element("ol", "matchweek-form-list"), tally = { G: 0, B: 0, M: 0 };
  let scored = 0, conceded = 0, complete = true;
  for (const game of games) {
    const home = game.home_team_id === teamId, opponent = home ? game.away_team_id : game.home_team_id;
    const own = scores.get(`${game.fixture_id}:${teamId}`), other = scores.get(`${game.fixture_id}:${opponent}`);
    const known = own != null && other != null;
    const result = !known ? "—" : own > other ? "G" : own === other ? "B" : "M";
    if (known) { tally[result]++; scored += own; conceded += other; } else complete = false;
    const item = element("li");
    item.title = `${new Intl.DateTimeFormat(LOCALE, { timeZone: matchweekZone, day: "numeric", month: "short" }).format(fantasyKickoff(game))} · ${home ? t("İç saha") : t("Deplasman")} · ${teamName(opponent, teams)}`;
    // The result and venue letters in the page's language (RESULT_LETTERS, standings.js).
    item.append(element("span", `matchweek-form-result matchweek-form-${{ G: "win", B: "draw", M: "loss" }[result] || "unknown"}`, RESULT_LETTERS[result] || result),
      createTeamLogo(opponent, teams, false),
      element("span", "matchweek-form-opponent", teams.get(opponent)?.short_code || teamName(opponent, teams)),
      element("span", "matchweek-form-venue", home ? t("İ") : t("D")),
      element("strong", "matchweek-form-score", known ? `${own}–${other}` : "—"));
    list.append(item);
  }
  section.append(list, element("p", "matchweek-form-summary",
    `${tally.G}${RESULT_LETTERS.G} ${tally.B}${RESULT_LETTERS.B} ${tally.M}${RESULT_LETTERS.M}${complete ? ` · ${scored}–${conceded}` : ""}`));
  return section;
}

const matchweekLeagueMetrics = [["scored", t("Gol atan"), t("En çok gol atan")], ["conceded", t("Gol yiyen"), t("En çok gol yiyen")],
  ["clean", t("Gol yemeden bitiren"), t("Gol yemeden bitirilen")], ["yellow", t("Kaydedilen sarı kart"), t("En çok sarı kart")],
  ["red", t("Kaydedilen kırmızı kart"), t("En çok kırmızı kart")]];

// Season totals and league ranks for both sides of a fixture, from the saved
// season's completed games. Rank 1 is the highest total; ties share a rank.
function matchweekLeagueRanks(fixture) {
  // Cards are the team statistic (team_metrics.csv), the same figure the match
  // result table and the live centre show, read on demand.
  if (teamMetricsState.key !== state.seasonSlug) loadTeamMetrics();
  const teamRows = new Map((teamMetricsState.state === "ready" ? teamMetricsState.rows : [])
    .map((row) => [`${row.fixture_id}:${row.team_id}`, row]));
  const scores = currentFixtureScores(), clubs = new Map();
  for (const game of state.tables["fixtures.csv"] || []) {
    if (!fixtureFinished(game) || fantasyKickoff(game) > Date.now()) continue;
    for (const [id, opponent] of [[game.home_team_id, game.away_team_id], [game.away_team_id, game.home_team_id]]) {
      if (!clubs.has(id)) clubs.set(id, { games: 0, scored: 0, conceded: 0, clean: 0, scores: 0, yellow: 0, red: 0, yellowRecords: 0, redRecords: 0, yellowGames: new Set(), redGames: new Set() });
      const club = clubs.get(id); club.games++;
      const a = scores.get(`${game.fixture_id}:${id}`), b = scores.get(`${game.fixture_id}:${opponent}`);
      if (a != null && b != null) { club.scored += a; club.conceded += b; club.clean += b === 0 ? 1 : 0; club.scores++; }
      // A blank card count is none on a covered team row, else unknown (teamCountedValue).
      const row = teamRows.get(`${game.fixture_id}:${id}`);
      const yellow = teamCountedValue(row, "yellowcards"), red = teamCountedValue(row, "redcards");
      if (yellow !== null) { club.yellow += yellow; club.yellowRecords++; club.yellowGames.add(game.fixture_id); }
      if (red !== null) { club.red += red; club.redRecords++; club.redGames.add(game.fixture_id); }
    }
  }
  return matchweekLeagueMetrics.map(([metric, label, versusLabel]) => {
    const card = ["yellow", "red"].includes(metric);
    const eligible = [...clubs.entries()].filter(([, club]) => card ? club[`${metric}Records`] > 0 : club.scores === club.games && club.games > 0);
    const sides = [fixture.home_team_id, fixture.away_team_id].map((id) => {
      const club = eligible.find(([key]) => key === id)?.[1];
      return club ? { value: club[metric], rank: 1 + eligible.filter(([, other]) => other[metric] > club[metric]).length,
        games: card ? club[`${metric}Games`].size : club.games, played: club.games } : null;
    });
    return { metric, label, versusLabel, card, teams: eligible.length, sides };
  });
}

function matchweekTeamHistory(teamId, selected) {
  const cutoff = Math.min(Date.now(), fantasyKickoff(selected));
  return (state.tables["fixtures.csv"] || []).filter((game) => game.fixture_id !== selected.fixture_id
    && [game.home_team_id, game.away_team_id].includes(teamId)
    && fixtureFinished(game)
    && fantasyKickoff(game) + 3 * 3600000 <= cutoff)
    .sort((a, b) => fantasyKickoff(b) - fantasyKickoff(a));
}

// A starting eleven as lines, own goal first: by the recorded formation
// ("row:column") when all eleven have one, otherwise by recorded position,
// with no exact order inside a line. The keeper is the first line, or the
// recorded goalkeeper. Shared by Maç Haftası and Ana Sayfa.
function matchweekLineupLines(players) {
  const exact = players.length === 11 && players.every((row) => /^[1-6]:[1-6]$/.test(row.formation_field || ""))
    && new Set(players.map((row) => row.formation_field)).size === 11;
  const role = (position) => /goalkeeper/i.test(position) ? 1 : /defender|back/i.test(position) ? 2 : /midfield/i.test(position) ? 3 : /forward|attacker|striker|winger/i.test(position) ? 4 : 5;
  const groups = new Map();
  for (const player of players) {
    const group = exact ? Number(player.formation_field.split(":")[0]) : role(player.position);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(player);
  }
  const column = (player) => Number(player.formation_field.split(":")[1]);
  const lines = [...groups.keys()].sort((a, b) => a - b).map((group) => ({ group, goalkeeper: group === 1,
    players: groups.get(group).sort((a, b) => exact ? column(a) - column(b) : String(a.name).localeCompare(String(b.name))) }));
  return { exact, lines };
}

function matchweekLastXI(teamId, game, teams, { players: matchPlayers = state.tables["player_match_stats.csv"] || [], title = t("Son 11") } = {}) {
  const panel = element("section", "matchweek-last-xi");
  panel.setAttribute("aria-label", `${teamName(teamId, teams)} ${title}`);
  panel.append(element("h3", "", `${teamName(teamId, teams)} · ${title}`));
  if (!game) {
    panel.append(element("p", "message", t("Önceki tamamlanmış maç bulunmuyor."))); return panel;
  }
  const opponent = game.home_team_id === teamId ? game.away_team_id : game.home_team_id;
  panel.append(element("p", "message", `${new Intl.DateTimeFormat(LOCALE, { timeZone: matchweekZone, day: "numeric", month: "short" }).format(fantasyKickoff(game))} · ${teamName(opponent, teams)}`));
  const players = matchPlayers.filter((row) => row.fixture_id === game.fixture_id
    && row.team_id === teamId && ["1", "true"].includes(String(row.started).toLowerCase()));
  const ids = new Set(players.map((row) => row.player_id));
  if (!players.length || ids.size !== players.length || ids.has("") || ids.has(undefined)) {
    panel.append(element("p", "message", t("Başlangıç kadrosu verisi eksik veya belirsiz."))); return panel;
  }
  const pitch = element("div", "matchweek-mini-pitch");
  // Half-pitch markings behind the players: halfway line and centre circle at
  // the top, this side's penalty area and goal at the bottom.
  const markings = element("div", "mini-pitch-markings");
  markings.setAttribute("aria-hidden", "true");
  for (const part of ["centre-circle", "centre-spot", "penalty-box", "goal-box", "penalty-arc", "penalty-spot"]) markings.append(element("span", `mini-pitch-${part}`));
  pitch.append(markings);
  const { exact, lines } = matchweekLineupLines(players);
  for (const { goalkeeper, players: linePlayers } of [...lines].reverse()) {
    const line = element("div", "matchweek-mini-line");
    for (const player of linePlayers) {
      const person = element("div", "matchweek-mini-player"), shirt = element("span", "pitch-shirt");
      shirt.innerHTML = shirtSVG(teamId, { size: 64, number: player.jersey_number, showName: false, goalkeeper });
      person.append(shirt, element("span", "pitch-player-name", playerName(player.player_id, player.name))); line.append(person);
    }
    pitch.append(line);
  }
  panel.append(pitch, element("p", "message", exact ? t("Kaydedilmiş diziliş · Hücum yönü ↑") : t("{count}/11 oyuncu · Kaydedilmiş mevkilere göre gruplandı; kesin diziliş yok.", { count: players.length })));
  return panel;
}

function setupMatchweek() {
  $("matchweek-standings-group").addEventListener("change", (event) => {
    state.standingsGroup = event.target.value;
    renderMatchweek();
  });
  $("matchweek-model").addEventListener("change", renderMatchweek);
  setInterval(() => { if (state.view === "matchweek") renderMatchweek(); }, 30000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.view === "matchweek") renderMatchweek();
  });
}
