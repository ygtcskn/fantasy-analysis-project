"use strict";

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

function renderStandings(teams, prefix = "standings") {
  const source = state.tables["standings.csv"] || [];
  const groups = [...new Set(source.map(standingGroupKey))];
  if (!groups.includes(state.standingsGroup)) state.standingsGroup = groups[0] ?? null;
  const select = $(`${prefix}-group`);
  select.replaceChildren();
  for (const key of groups) {
    const row = source.find((item) => standingGroupKey(item) === key);
    select.add(new Option(`Aşama ${row.stage_id || "bilinmiyor"}${row.group_id ? ` · Grup ${row.group_id}` : ""}`, key));
  }
  select.value = state.standingsGroup || "";
  $(`${prefix}-group-control`).hidden = groups.length <= 1;
  const rows = source.filter((row) => standingGroupKey(row) === state.standingsGroup).sort((a, b) => (number(a.position) ?? Infinity) - (number(b.position) ?? Infinity));
  $(`${prefix}-count`).textContent = `${rows.length} takım`;
  // Maç Haftası shows the table as it would stand if the matches in play ended now.
  const live = prefix === "matchweek-standings" && typeof matchweekLiveStandings === "function" ? matchweekLiveStandings(rows) : null;
  $(`${prefix}-note`).textContent = !state.tables["standings.csv"] ? "Puan tablosu için sezon verilerini yükleyin."
    : prefix === "matchweek-standings" ? "" : "Sıra ve puanlar Sportmonks'un verdiği gibidir.";
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
    if (entry) points.title = `${displayNumber(entry.base)} + ${entry.gained} · ${entry.own}–${entry.other} ${entry.opponent}${entry.live ? " (sürüyor)" : " (bitti, kayda girmedi)"}`;
    tr.append(element("td", "standing-position", displayNumber(live ? index + 1 : row.position)), club, points);
    body.append(tr);
  }
  if (!rows.length) {
    const tr = element("tr"), td = element("td", "no-results", state.tables["standings.csv"] ? "Bu dosyada puan durumu yok." : "Puan tablosu burada görünecek.");
    td.colSpan = 3; tr.append(td); body.append(tr);
  }
  $(`${prefix}-body`).replaceChildren(body);
}

function fixtureRoundKey(row) {
  return row.round_id || row["round.id"] || row["round.name"] || "unassigned";
}

function homeRounds() {
  const fixtures = [...(state.tables["fixtures.csv"] || [])].sort((a, b) => String(a.kickoff || "9999").localeCompare(String(b.kickoff || "9999")));
  const rounds = new Map();
  for (const fixture of fixtures) {
    const key = fixtureRoundKey(fixture);
    if (!rounds.has(key)) rounds.set(key, { key, name: fixture["round.name"] ? `${fixture["round.name"]}. Hafta` : key === "unassigned" ? "Haftası belirsiz maçlar" : `Tur ${key}`, fixtures: [] });
    rounds.get(key).fixtures.push(fixture);
  }
  return [...rounds.values()];
}

function initialHomeRound(rounds) {
  const current = rounds.find((round) => round.fixtures.some((fixture) => String(fixture["round.is_current"]).toLowerCase() === "true"));
  if (current) return current.key;
  const now = Date.now() / 1000;
  const upcoming = rounds.find((round) => round.fixtures.some((fixture) => (number(fixture.starting_at_timestamp) ?? -1) >= now));
  return (upcoming || rounds[rounds.length - 1])?.key ?? null;
}

function currentFixtureScores() {
  const scores = new Map();
  for (const row of state.tables["fixture_scores.csv"] || []) {
    if (row.description !== "CURRENT") continue;
    const key = `${row.fixture_id}:${row.participant_id}`;
    const value = number(row["score.goals"]);
    // A conflicting duplicate is unknown, not a licence to invent a score.
    if (scores.has(key) && scores.get(key) !== value) scores.set(key, null);
    else scores.set(key, value);
  }
  return scores;
}

function renderHomeFixtures(teams) {
  const rounds = homeRounds();
  if (!rounds.some((round) => round.key === state.homeRound)) state.homeRound = initialHomeRound(rounds);
  const select = $("home-round");
  select.replaceChildren();
  for (const round of rounds) select.add(new Option(round.name, round.key));
  if (!rounds.length) select.add(new Option("Yüklü hafta yok", ""));
  select.value = state.homeRound || "";
  select.disabled = !rounds.length;
  const index = rounds.findIndex((round) => round.key === state.homeRound);
  $("home-round-prev").disabled = index <= 0;
  $("home-round-next").disabled = index < 0 || index === rounds.length - 1;
  const fixtures = rounds[index]?.fixtures || [];
  $("home-fixture-count").textContent = `${fixtures.length} maç`;
  $("home-fixtures-note").textContent = !state.tables["fixtures.csv"] ? "Fikstürü görmek için fixtures.csv ve teams.csv dosyalarını açın." : !state.tables["fixture_scores.csv"] ? "Sonuçlar için fixture_scores.csv ekleyin. Başlama saatleri dışa aktarıldığı gibidir." : "Canlı yayın değil, kaydedilen sonuçlar. Başlama saatleri dışa aktarıldığı gibidir.";
  const scores = currentFixtureScores();
  const list = document.createDocumentFragment();
  let previousDate = null;
  for (const fixture of fixtures) {
    const date = fixture.kickoff?.slice(0, 10) || "";
    if (date !== previousDate) { list.append(element("h3", "fixture-date", longDate(date))); previousDate = date; }
    const match = element("article", "home-match");
    const homeName = teamName(fixture.home_team_id, teams), awayName = teamName(fixture.away_team_id, teams);
    match.setAttribute("aria-label", `${homeName} - ${awayName}`);
    const heading = element("div", "home-match-meta");
    heading.append(element("span", "", fixture.kickoff?.slice(11, 16) || "Saat belli değil"), element("span", "fixture-status", fixtureStateLabel(fixture)));
    const homeScore = scores.get(`${fixture.fixture_id}:${fixture.home_team_id}`);
    const awayScore = scores.get(`${fixture.fixture_id}:${fixture.away_team_id}`);
    const notStarted = ["NS", "TBA", "POSTP", "CANC", "CANCELLED"].includes(String(fixture.state || "").toUpperCase());
    const hasScore = !notStarted && homeScore !== undefined && homeScore !== null && awayScore !== undefined && awayScore !== null;
    match.append(heading);
    for (const [teamId, name, score] of [[fixture.home_team_id, homeName, homeScore], [fixture.away_team_id, awayName, awayScore]]) {
      const side = element("div", "home-match-side");
      const club = createTeamLink(teamId, name, "home-match-team");
      club.replaceChildren(createTeamLogo(teamId || "unknown", teams, false), element("span", "home-match-club", name));
      side.append(club, element("strong", "home-match-score", hasScore ? displayNumber(score) : "—"));
      match.append(side);
    }
    list.append(match);
  }
  if (!fixtures.length) list.append(element("p", "no-results", state.tables["fixtures.csv"] ? "Bu dosyada maç yok." : "Haftanın maçları burada görünecek."));
  $("home-fixtures-list").replaceChildren(list);
}

function renderHome() {
  const teams = homeTeams();
  const season = $("season-label").textContent;
  $("home-season-note").textContent = season !== "—" ? `${season} sezonu · Sportmonks verisi` : "Başlamak için standings.csv, fixtures.csv, teams.csv ve fixture_scores.csv dosyalarını açın.";
  renderStandings(teams);
  renderHomeFixtures(teams);
}

function setupHome() {
  $("standings-group").addEventListener("change", (event) => { state.standingsGroup = event.target.value; renderHome(); });
  $("home-round").addEventListener("change", (event) => { state.homeRound = event.target.value; renderHome(); });
  for (const [id, direction] of [["home-round-prev", -1], ["home-round-next", 1]]) $(id).addEventListener("click", () => {
    const rounds = homeRounds();
    const index = rounds.findIndex((round) => round.key === state.homeRound);
    const target = rounds[index + direction];
    if (target) { state.homeRound = target.key; renderHome(); }
  });
}
