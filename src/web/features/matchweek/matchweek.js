"use strict";

const matchweekOdds = { request: 0, season: "", rows: [], note: "" };
const matchweekZone = "Europe/Istanbul";
const matchweekDayMs = 86400000;
let selectedMatchweekFixture = null;

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
    Object.assign(matchweekOdds, { season, rows: [], note: "Kaydedilmiş maç tahminleri yüklenemedi." });
  }
  if (state.view === "matchweek") renderMatchweek();
}

function renderMatchweek() {
  const today = matchweekDay(Date.now());
  const start = today - ((new Date(today).getUTCDay() + 5) % 7) * matchweekDayMs;
  const end = start + 7 * matchweekDayMs;
  const dateLabel = (date) => new Intl.DateTimeFormat("tr-TR", {
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
  if (!candidates.length) select.add(new Option("Tahmin yok", ""));
  select.value = candidates.includes(previous) ? previous : candidates[0] || "";
  select.disabled = !candidates.length;
  const teams = homeTeams(), body = document.createDocumentFragment();
  renderStandings(teams, "matchweek-standings");
  let missing = 0;
  let selectedAnalysis = null;
  for (const fixture of fixtures) {
    const kickoff = fantasyKickoff(fixture), tr = element("tr");
    tr.className = "matchweek-selectable";
    tr.classList.toggle("matchweek-selected", fixture.fixture_id === selectedMatchweekFixture);
    tr.addEventListener("click", () => {
      selectedMatchweekFixture = fixture.fixture_id;
      renderMatchweek();
      document.getElementById(`matchweek-select-${fixture.fixture_id}`)?.focus({ preventScroll: true });
    });
    tr.append(element("td", "", new Intl.DateTimeFormat("tr-TR", { timeZone: matchweekZone, weekday: "long", day: "numeric", month: "short" }).format(kickoff)),
      element("td", "", new Intl.DateTimeFormat("tr-TR", { timeZone: matchweekZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(kickoff)));
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
    if (!valid) missing++;
    if (fixture.fixture_id === selectedMatchweekFixture) selectedAnalysis = { fixture, prediction: valid ? prediction : null };
    const oddsCell = element("td"), odds = element("button", "matchweek-odds matchweek-select");
    odds.type = "button";
    odds.id = `matchweek-select-${fixture.fixture_id}`;
    odds.setAttribute("aria-label", `${teamName(fixture.home_team_id, teams)} – ${teamName(fixture.away_team_id, teams)} maç analizini göster`);
    odds.setAttribute("aria-controls", "matchweek-analysis");
    odds.setAttribute("aria-pressed", String(fixture.fixture_id === selectedMatchweekFixture));
    probabilities.forEach((probability, index) => {
      const label = ["1", "X", "2"][index];
      const badge = element("span", `matchweek-odd${valid ? ` matchweek-odd-${index}` : ""}`);
      badge.append(element("span", "", label), element("strong", "", valid
        ? `${(probability * 100).toLocaleString("tr-TR", { maximumFractionDigits: 1, minimumFractionDigits: 1 })}%` : "—"));
      odds.append(badge);
    });
    oddsCell.append(odds);
    tr.append(clubCells[0], oddsCell, clubCells[1]);
    body.append(tr);
  }
  if (!fixtures.length) {
    const row = element("tr"), cell = element("td", "no-results", state.tables["fixtures.csv"]
      ? "Bu hafta için kaydedilmiş maç bulunmuyor." : "Haftanın maçları için sezon verilerini yükleyin.");
    cell.colSpan = 5; row.append(cell); body.append(row);
  }
  $("matchweek-matches").replaceChildren(body);
  renderMatchweekAnalysis(selectedAnalysis, teams);
  $("matchweek-note").textContent = `${fixtures.length} maç · Saatler Türkiye saatidir. Hafta her salı 00.00'da yenilenir. `
    + ((matchweekOdds.season === state.seasonSlug && matchweekOdds.note) || (missing ? "— Bu maç için eşleşen tahmin yok; analiz çıktısını yenileyin." : ""));
}

function renderMatchweekAnalysis(selection, teams) {
  const content = $("matchweek-analysis-content");
  content.replaceChildren();
  if (!selection) {
    content.append(element("p", "message", "Analizi görmek için yukarıdan bir maç seçin."));
    return;
  }
  const { fixture, prediction } = selection;
  const scores = currentFixtureScores();
  const homeScore = scores.get(`${fixture.fixture_id}:${fixture.home_team_id}`);
  const awayScore = scores.get(`${fixture.fixture_id}:${fixture.away_team_id}`);
  if (["FT", "INPLAY_1ST_HALF", "INPLAY_2ND_HALF", "HT"].includes(String(fixture.state).toUpperCase())
      && homeScore != null && awayScore != null) {
    content.append(element("p", "", `Kaydedilmiş skor: ${homeScore} – ${awayScore}`));
  }
  const sides = [fixture.home_team_id, fixture.away_team_id];
  const matchup = element("div", "matchweek-matchup");
  const clubs = sides.map((id) => {
    const club = element("div", "matchweek-club");
    club.append(createTeamLogo(id, teams, false), element("strong", "", teamName(id, teams)));
    return club;
  });
  const odds = element("div", "matchweek-odds");
  ["home_probability", "draw_probability", "away_probability"].forEach((field, index) => {
    const badge = element("span", `matchweek-odd${prediction ? ` matchweek-odd-${index}` : ""}`);
    badge.append(element("span", "", ["1", "X", "2"][index]), element("strong", "", prediction
      ? `${(Number(prediction[field]) * 100).toLocaleString("tr-TR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%` : "—"));
    odds.append(badge);
  });
  matchup.append(clubs[0], odds, clubs[1]);
  content.append(matchup);
  const histories = sides.map((id) => matchweekTeamHistory(id, fixture));
  const lineups = element("div", "matchweek-lineups");
  sides.forEach((id, index) => {
    if (index) lineups.append(element("span", "matchweek-versus", "VS"));
    lineups.append(matchweekLastXI(id, histories[index][0], teams));
  });
  content.append(lineups);
  const table = element("table", "matchweek-comparison");
  table.append(element("caption", "", "Takım karşılaştırması"));
  const head = element("thead"), titles = element("tr"), body = element("tbody");
  for (const label of [teamName(sides[0], teams), "İstatistik", teamName(sides[1], teams)]) {
    const th = element("th", "", label); th.scope = "col"; titles.append(th);
  }
  head.append(titles);
  const percent = (field) => prediction ? `${displayNumber(Number(prediction[field]) * 100)}%` : "—";
  const recent = histories.map((history, index) => matchweekRecentStats(history, sides[index], scores));
  const contexts = sides.map((teamId) => {
    for (const [id, rows] of fantasyState.projections) {
      if (!rows.some((row) => row.fixture_id === fixture.fixture_id && row.team_id === teamId)) continue;
      const candidate = builderFantasyData({ id, squadTeam: teamId }).projection;
      if (candidate?.fixture_id === fixture.fixture_id) return candidate;
    }
    return null;
  });
  const strength = (index, field) => number(contexts[index]?.[field]) === null ? "—" : `${displayNumber(number(contexts[index][field]))}×`;
  const difficulty = (index, side) => number(contexts[index]?.[`${side}_fixture_difficulty`]) === null ? "—" : `${contexts[index][`${side}_fixture_difficulty`]}/5`;
  const entries = [
    [percent("home_probability"), "Kazanma olasılığı", percent("away_probability")],
    [percent("draw_probability"), "Beraberlik olasılığı", percent("draw_probability")],
    [displayNumber(number(prediction?.home_expected_goals)), "Beklenen gol", displayNumber(number(prediction?.away_expected_goals))],
    [recent[0].form, "Son 5 maç · eski → yeni", recent[1].form],
    [recent[0].scored, "Atılan gol / maç", recent[1].scored],
    [recent[0].conceded, "Yenilen gol / maç", recent[1].conceded],
    [recent[0].clean, "Gol yenmeyen maç", recent[1].clean],
    [strength(0, "team_attack_strength"), "Hücum gücü", strength(1, "team_attack_strength")],
    [strength(0, "team_defense_strength"), "Savunma gücü", strength(1, "team_defense_strength")],
    [difficulty(0, "attacking"), "Hücum fikstür zorluğu", difficulty(1, "attacking")],
    [difficulty(0, "defensive"), "Savunma fikstür zorluğu", difficulty(1, "defensive")],
  ];
  for (const [home, label, away] of entries) {
    const row = element("tr"), name = element("th", "", label); name.scope = "row";
    row.append(element("td", "", home), name, element("td", "", away)); body.append(row);
  }
  table.append(head, body); content.append(table);
  content.append(element("p", "message", "Güç: 1× lig ortalaması, yüksek değer daha güçlüdür. Fikstür zorluğu: 1 kolay, 5 zor; rakip ve iç/dış saha etkisini gösteren deneysel aralıklardır. Beklenen oyuncu puanları bu eşleşmeyi zaten içerir; ek çarpan uygulanmaz."));
  if (contexts.some((row) => row?.strength_context_status === "league_average_fallback")) content.append(element("p", "message", "Bazı takım geçmişleri eksik; lig ortalaması kullanılıyor."));
  content.append(matchweekFantasyComparison(fixture, teams));
  content.append(matchweekLeagueComparison(fixture, teams));
  content.append(element("p", "message", "Form, gol ortalamaları ve gol yenmeyen maç sayıları, seçilen maç öncesindeki son 5 tamamlanmış sezon maçına dayanır. G: galibiyet, B: beraberlik, M: mağlubiyet. Eksik skorlar — olarak kalır. Son 11, geçmiş maçın kadrosudur; tahmini kadro değildir."));
  content.append(element("p", "message", prediction
    ? `Tahmin modeli: ${$("matchweek-model").selectedOptions[0].textContent}.`
    : "Seçili modelde bu maç için geçerli bir tahmin bulunmuyor."));
}

function matchweekFantasyComparison(fixture, teams) {
  const section = element("section", "matchweek-fantasy-comparison");
  const table = element("table", "matchweek-comparison");
  table.append(element("caption", "", "Fantezi · Maç başına beklenen puan (sakatlıklar hariç)"));
  const head = element("thead"), titles = element("tr"), body = element("tbody");
  for (const label of [teamName(fixture.home_team_id, teams), "Oyuncu grubu", teamName(fixture.away_team_id, teams)]) {
    const cell = element("th", "", label); cell.scope = "col"; titles.append(cell);
  }
  head.append(titles);
  const groups = [["ALL", "Takım toplamı"], ["KL", "Kaleciler"], ["DEF", "Defans"], ["OS", "Orta saha"], ["FOR", "Forvetler"], ["UNKNOWN", "Mevki belirsiz"]];
  const totals = [fixture.home_team_id, fixture.away_team_id].map((teamId) => {
    const buckets = new Map(groups.map(([key]) => [key, { count: 0, available: 0, points: 0, players: [] }]));
    if (!fantasyState.season || fantasyState.season !== state.seasonSlug) return buckets;
    for (const [playerId, rows] of fantasyState.projections) {
      const matching = rows.filter((row) => row.fixture_id === fixture.fixture_id && row.team_id === teamId);
      if (!matching.length) continue;
      const positions = new Set(matching.map((row) => row.position));
      const position = positions.size === 1 && buckets.has(matching[0].position) && matching[0].position !== "ALL" ? matching[0].position : "UNKNOWN";
      // Keep fixture/deadline guards, but compare totals before availability adjustments.
      const projection = matching.length === 1 ? builderFantasyData({ id: playerId, squadTeam: teamId }).projection : null;
      const points = projection?.fixture_id === fixture.fixture_id ? number(projection.baseline_expected_points) : null;
      for (const key of ["ALL", position]) {
        const bucket = buckets.get(key);
        bucket.count++;
        if (points !== null) {
          bucket.available++; bucket.points += points;
          bucket.players.push({ id: playerId, name: projection.player_name || playerId, points });
        }
      }
    }
    return buckets;
  });
  for (const [key, label] of groups) {
    if (key === "UNKNOWN" && totals.every((team) => !team.get(key).count)) continue;
    const row = element("tr"), name = element("th", "", key === "ALL" ? "Takım · En iyi 3 oyuncu" : label); name.scope = "row";
    const cells = totals.map((team) => {
      const bucket = team.get(key), cell = element("td");
      const best = key === "ALL" ? [...bucket.players].filter((player) => player.points > 0)
        .sort((a, b) => b.points - a.points || String(a.id).localeCompare(String(b.id))).slice(0, 3) : [];
      const points = key === "ALL" ? best.reduce((sum, player) => sum + player.points, 0) : bucket.points;
      cell.append(element("strong", "", bucket.available ? displayNumber(points) : "—"));
      if (key === "ALL" && bucket.available) {
        cell.append(element("span", "matchweek-fantasy-coverage", `${best.length}/3 oyuncu seçildi`));
        for (const player of best) cell.append(element("span", "matchweek-fantasy-coverage", `${player.name}: ${displayNumber(player.points)}`));
      }
      cell.append(element("span", "matchweek-fantasy-coverage", bucket.count
        ? `${bucket.available}/${bucket.count} oyuncu${bucket.available > 0 && bucket.available < bucket.count ? " · Kısmi toplam" : ""}`
        : "Oyuncu tahmini yok"));
      return cell;
    });
    row.append(cells[0], name, cells[1]); body.append(row);
  }
  table.append(head, body); section.append(table);
  section.append(element("p", "message", "Takım değeri, seçilen maçta en yüksek beklenen puana sahip en fazla 3 oyuncunun toplamıdır. Sıfır veya negatif puanlı oyuncular seçilmez. Sakatlıklar dikkate alınmaz; bütçe ve diziliş optimizasyonu uygulanmaz. Mevki satırları tüm dışa aktarılan oyuncuların toplamıdır; en iyi 3 oyuncunun dağılımı değildir. Oyuncu sayısı, kullanılabilir tahmin / dışa aktarılan oyuncu sayısıdır. Eksik tahminler sıfır sayılmaz; kısmi sonuçlar işaretlenir. Geçerlilik süresi dolan tahminler gösterilmez."));
  section.append(element("p", "message", "Bu değerler oyuncu puan tahminlerinden gelir; üstteki maç sonucu modeli seçimiyle değişmez."));
  return section;
}

function matchweekLeagueComparison(fixture, teams) {
  const scores = currentFixtureScores(), clubs = new Map(), matchTeams = new Map();
  for (const game of state.tables["fixtures.csv"] || []) {
    if (String(game.state).toUpperCase() !== "FT" || fantasyKickoff(game) > Date.now()) continue;
    for (const [id, opponent] of [[game.home_team_id, game.away_team_id], [game.away_team_id, game.home_team_id]]) {
      if (!clubs.has(id)) clubs.set(id, { games: 0, scored: 0, conceded: 0, clean: 0, scores: 0, yellow: 0, red: 0, yellowRecords: 0, redRecords: 0, yellowGames: new Set(), redGames: new Set() });
      const club = clubs.get(id); club.games++;
      matchTeams.set(`${game.fixture_id}:${id}`, club);
      const a = scores.get(`${game.fixture_id}:${id}`), b = scores.get(`${game.fixture_id}:${opponent}`);
      if (a != null && b != null) { club.scored += a; club.conceded += b; club.clean += b === 0 ? 1 : 0; club.scores++; }
    }
  }
  const seen = new Set();
  for (const row of state.tables["player_match_stats.csv"] || []) {
    const club = matchTeams.get(`${row.fixture_id}:${row.team_id}`);
    const key = `${row.fixture_id}:${row.player_id}`;
    if (!club || !row.player_id || seen.has(key)) continue;
    seen.add(key);
    const yellow = number(row.yellowcards), red = number(row.redcards), second = number(row.yellowred_cards);
    if (yellow !== null && yellow >= 0) { club.yellow += yellow; club.yellowRecords++; club.yellowGames.add(row.fixture_id); }
    if ((red !== null && red >= 0 && second !== null && second >= 0) || red > 0 || second > 0) {
      club.red += red > 0 || second > 0 ? 1 : 0;
      club.redRecords++; club.redGames.add(row.fixture_id);
    }
  }
  const section = element("section", "matchweek-fantasy-comparison"), table = element("table", "matchweek-comparison");
  table.append(element("caption", "", "Lig sıralamaları · Sezon geneli"));
  const head = element("thead"), header = element("tr"), body = element("tbody");
  for (const label of [teamName(fixture.home_team_id, teams), "En çok…", teamName(fixture.away_team_id, teams)]) {
    const cell = element("th", "", label); cell.scope = "col"; header.append(cell);
  }
  head.append(header);
  for (const [metric, label] of [["scored", "Gol atan"], ["conceded", "Gol yiyen"], ["clean", "Gol yemeden bitiren"], ["yellow", "Kaydedilen sarı kart"], ["red", "Kaydedilen kırmızı kart"]]) {
    const card = ["yellow", "red"].includes(metric);
    const eligible = [...clubs.entries()].filter(([, club]) => card ? club[`${metric}Records`] > 0 : club.scores === club.games && club.games > 0);
    const row = element("tr"), title = element("th", "", label); title.scope = "row";
    const cells = [fixture.home_team_id, fixture.away_team_id].map((id) => {
      const club = eligible.find(([key]) => key === id)?.[1], cell = element("td");
      if (!club) { cell.textContent = "—"; return cell; }
      const rank = 1 + eligible.filter(([, other]) => other[metric] > club[metric]).length;
      const games = card ? club[`${metric}Games`].size : club.games;
      cell.append(element("strong", "", `${rank}. sıra`), element("span", "matchweek-fantasy-coverage", `${club[metric]} toplam · ${displayNumber(club[metric] / games)} / maç`),
        element("span", "matchweek-fantasy-coverage", card ? `${games}/${club.games} maçta kart verisi · ${eligible.length} takım arasında` : `${games} maç · ${eligible.length} takım arasında`));
      return cell;
    });
    row.append(cells[0], title, cells[1]); body.append(row);
  }
  table.append(head, body); section.append(table, element("p", "message", "Sıralamalar kaydedilmiş sezonun tamamlanmış maçlarında toplam değere göre büyükten küçüğedir; eşit toplamlar aynı sırayı alır. Seçilen maç tarihinden bağımsız güncel sezon verisidir. Gol yeme ve kart sıralamasında 1. olmak en yüksek sayıyı gösterir. Kartlar yalnızca mevcut oyuncu kayıtlarını kapsar; eksik kayıtlar sıfır sayılmaz ve maç başına değer yalnızca kart verisi bulunan maçlara bölünür. Kırmızı kart, doğrudan veya ikinci sarıdan oyundan atılmayı oyuncu başına bir kez sayar."));
  return section;
}

function matchweekTeamHistory(teamId, selected) {
  const cutoff = Math.min(Date.now(), fantasyKickoff(selected));
  return (state.tables["fixtures.csv"] || []).filter((game) => game.fixture_id !== selected.fixture_id
    && [game.home_team_id, game.away_team_id].includes(teamId)
    && String(game.state).toUpperCase() === "FT"
    && fantasyKickoff(game) + 3 * 3600000 <= cutoff)
    .sort((a, b) => fantasyKickoff(b) - fantasyKickoff(a));
}

function matchweekLastXI(teamId, game, teams) {
  const panel = element("section", "matchweek-last-xi");
  panel.setAttribute("aria-label", `${teamName(teamId, teams)} son 11`);
  panel.append(element("p", "message", "Son 11"));
  if (!game) {
    panel.append(element("p", "message", "Önceki tamamlanmış maç bulunmuyor.")); return panel;
  }
  const opponent = game.home_team_id === teamId ? game.away_team_id : game.home_team_id;
  panel.append(element("p", "message", `${new Intl.DateTimeFormat("tr-TR", { timeZone: matchweekZone, day: "numeric", month: "short" }).format(fantasyKickoff(game))} · ${teamName(opponent, teams)}`));
  const players = (state.tables["player_match_stats.csv"] || []).filter((row) => row.fixture_id === game.fixture_id
    && row.team_id === teamId && ["1", "true"].includes(String(row.started).toLowerCase()));
  const ids = new Set(players.map((row) => row.player_id));
  if (!players.length || ids.size !== players.length || ids.has("") || ids.has(undefined)) {
    panel.append(element("p", "message", "Başlangıç kadrosu verisi eksik veya belirsiz.")); return panel;
  }
  const pitch = element("div", "matchweek-mini-pitch");
  const groups = new Map();
  const exact = players.length === 11 && players.every((row) => /^[1-6]:[1-6]$/.test(row.formation_field || ""))
    && new Set(players.map((row) => row.formation_field)).size === 11;
  const role = (position) => /goalkeeper/i.test(position) ? 1 : /defender|back/i.test(position) ? 2 : /midfield/i.test(position) ? 3 : /forward|attacker|striker|winger/i.test(position) ? 4 : 5;
  for (const player of players) {
    const group = exact ? Number(player.formation_field.split(":")[0]) : role(player.position);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(player);
  }
  for (const group of [...groups.keys()].sort((a, b) => b - a)) {
    const line = element("div", "matchweek-mini-line");
    for (const player of groups.get(group).sort((a, b) => exact ? Number(a.formation_field.split(":")[1]) - Number(b.formation_field.split(":")[1]) : String(a.name).localeCompare(String(b.name)))) {
      const person = element("div", "matchweek-mini-player"), shirt = element("span", "builder-shirt");
      shirt.innerHTML = shirtSVG(teamId, { size: 64, number: player.jersey_number, showName: false });
      person.append(shirt, element("span", "", player.name || `Oyuncu ${player.player_id}`)); line.append(person);
    }
    pitch.append(line);
  }
  panel.append(pitch, element("p", "message", exact ? "Kaydedilmiş diziliş · Hücum yönü ↑" : `${players.length}/11 oyuncu · Kaydedilmiş mevkilere göre gruplandı; kesin diziliş yok.`));
  return panel;
}

function matchweekRecentStats(history, teamId, scores) {
  const games = history.slice(0, 5).reverse();
  const results = games.map((game) => {
    const opponent = game.home_team_id === teamId ? game.away_team_id : game.home_team_id;
    return [scores.get(`${game.fixture_id}:${teamId}`), scores.get(`${game.fixture_id}:${opponent}`)];
  });
  const complete = results.length && results.every(([a, b]) => a != null && b != null);
  return {
    form: results.map(([a, b]) => a == null || b == null ? "—" : a > b ? "G" : a === b ? "B" : "M").join(" · ") || "—",
    scored: complete ? displayNumber(results.reduce((sum, [a]) => sum + a, 0) / results.length) : "—",
    conceded: complete ? displayNumber(results.reduce((sum, [, b]) => sum + b, 0) / results.length) : "—",
    clean: complete ? `${results.filter(([, b]) => b === 0).length} / ${results.length}` : "—",
  };
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
