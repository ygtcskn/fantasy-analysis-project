"use strict";

// CSVs come from the local server or file picker and stay in browser memory.
const state = { tables: {}, view: "home", page: 0, sort: "date", direction: -1, busy: false, tierCache: null, homeRound: null, standingsGroup: null };
const pageSize = 40;
let renderedPageCount = 1;
const expected = {
  "player_match_stats.csv": ["fixture_id", "player_id", "team_id", "name"],
  "fixtures.csv": ["fixture_id", "kickoff", "home_team_id", "away_team_id"],
  "teams.csv": ["id", "name"],
  "players.csv": ["id", "name"],
  "squads.csv": ["player_id", "team_id", "season_id"],
  "standings.csv": ["participant_id", "position", "points", "season_id"],
  "fixture_scores.csv": ["fixture_id", "participant_id", "description", "score.goals"],
};
const $ = (id) => document.getElementById(id);
const number = (value) => value === undefined || value === null || String(value).trim() === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const displayNumber = (value) => number(value) === null ? "—" : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(Number(value));
const teamName = (id, teams) => teams.get(id)?.name || (id ? `Team ${id}` : "—");

async function loadFiles(files, { replace = false, local = false } = {}) {
  if (state.busy) return;
  state.busy = true;
  $("open-files").disabled = true;
  $("clear-files").disabled = true;
  $("refresh-data").disabled = true;
  const incoming = {}, messages = [], accepted = [], names = new Set();
  if (typeof files === "function") {
    try { files = await files(); }
    catch (error) { messages.push(`${error.message} Existing loaded data has been kept.`); files = []; }
  }
  for (const file of files) {
    if (!expected[file.name]) continue;
    if (names.has(file.name)) { messages.push(`Select only one ${file.name} per import.`); continue; }
    names.add(file.name);
    try {
      if (file.size > 40 * 1024 * 1024) throw new Error("This file exceeds the 40 MB limit.");
      const table = parseCSV(await file.text());
      const missing = expected[file.name].filter((field) => !table.header.includes(field));
      if (missing.length) throw new Error(`Missing columns: ${missing.join(", ")}.`);
      incoming[file.name] = table.records;
      accepted.push(file.name);
    } catch (error) { messages.push(`${file.name}: ${error.message}`); }
  }
  // A new fixture file starts a new dataset to avoid silently mixing seasons.
  const next = replace || (incoming["fixtures.csv"] && state.tables["fixtures.csv"]) ? { ...incoming } : { ...state.tables, ...incoming };
  const fixtures = next["fixtures.csv"] || [];
  const seasonIds = new Set(fixtures.map((row) => row.season_id).filter(Boolean));
  if (seasonIds.size > 1) messages.push("Please select fixtures from a single season.");
  const squadSeasons = new Set((next["squads.csv"] || []).map((row) => row.season_id).filter(Boolean));
  if (squadSeasons.size > 1 || (seasonIds.size && [...squadSeasons].some((id) => !seasonIds.has(id)))) messages.push("Select squad and fixture files from the same season.");
  const standingSeasons = new Set((next["standings.csv"] || []).map((row) => row.season_id).filter(Boolean));
  const allSeasons = new Set([...seasonIds, ...squadSeasons, ...standingSeasons]);
  if (allSeasons.size > 1) messages.push("Select standings, squads, and fixtures from the same season.");
  for (const [file, key] of [["fixtures.csv", (row) => row.fixture_id], ["player_match_stats.csv", (row) => `${row.fixture_id}:${row.player_id}`], ["players.csv", (row) => row.id], ["teams.csv", (row) => row.id]]) {
    const ids = new Set();
    for (const row of next[file] || []) {
      const id = key(row);
      if (id && ids.has(id)) { messages.push(`${file} has duplicate records; fix these before importing to avoid counting them twice.`); break; }
      ids.add(id);
    }
  }
  if (fixtures.length && next["player_match_stats.csv"]) {
    const ids = new Set(fixtures.map((row) => row.fixture_id));
    if (next["player_match_stats.csv"].some((row) => !ids.has(row.fixture_id))) messages.push("Some player appearances do not match these fixtures. Select files from the same season together.");
  }
  if (fixtures.length && next["fixture_scores.csv"]) {
    const ids = new Set(fixtures.map((row) => row.fixture_id));
    if (next["fixture_scores.csv"].some((row) => !ids.has(row.fixture_id))) messages.push("Some scores do not match these fixtures. Select files from the same season together.");
  }
  if (!messages.length && accepted.length) {
    const previousSeason = state.tables["fixtures.csv"]?.find((row) => row.season_id)?.season_id;
    const incomingSeason = incoming["fixtures.csv"]?.find((row) => row.season_id)?.season_id;
    if (previousSeason && incomingSeason && previousSeason !== incomingSeason) resetSquadBuilder();
    state.tables = next;
    state.tierCache = null;
    state.homeRound = null;
    state.standingsGroup = null;
    resetTierFilters();
    resetFilters();
    messages.push(local
      ? `Saved season data loaded at ${new Date().toLocaleTimeString()}. After your next download finishes, click Refresh saved data or reload this page.`
      : `Loaded ${accepted.join(", ")}. Select the files for your new season together when switching seasons.`);
    $("message").classList.remove("error");
  } else {
    if (!messages.length) messages.push(`Choose supported files from your season’s csv folder: ${Object.keys(expected).join(", ")}.`);
    $("message").classList.add("error");
  }
  $("message").textContent = messages.join(" ");
  state.busy = false;
  $("open-files").disabled = false;
  $("clear-files").disabled = false;
  $("refresh-data").disabled = false;
  $("files").value = "";
  render();
}

async function loadLocalData() {
  if (state.busy) return;
  $("message").classList.remove("error");
  $("message").textContent = "Reading saved season CSVs…";
  await loadFiles(async () => {
    const results = await Promise.allSettled(Object.keys(expected).map(async (name) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(`/local-data/${name}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
        if (response.headers.get("X-Superlig-Local") !== "1") throw new Error("Start the website with src/web/serve.py.");
        const blob = await response.blob();
        return new File([blob], name, { type: "text/csv" });
      } finally { clearTimeout(timeout); }
    }));
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) throw new Error(`Could not read the saved CSVs. ${failures.map((result) => result.reason.message).join("; ")}. Check that the local server is running and the download has finished.`);
    return results.map((result) => result.value);
  }, { replace: true, local: true });
}

function options(select, values, first) {
  const previous = select.value;
  select.replaceChildren(new Option(first, ""));
  for (const [value, label] of values) select.add(new Option(label, value));
  select.value = values.some(([value]) => value === previous) ? previous : "";
}

function resetFilters() {
  $("search").value = "";
  $("team").value = "";
  $("position").value = "";
  $("minutes").value = "0";
  state.page = 0;
}

function records() {
  const teams = new Map((state.tables["teams.csv"] || []).map((row) => [row.id, row]));
  const fixtures = new Map((state.tables["fixtures.csv"] || []).map((row) => [row.fixture_id, row]));
  if (state.view === "fixtures") {
    const scores = currentFixtureScores();
    return [...fixtures.values()].map((row) => {
      const kickoff = String(row.kickoff || "");
      const time = kickoff.match(/(?:T|\s)(\d{2}:\d{2})/)?.[1] || "—";
      const homeScore = scores.get(`${row.fixture_id}:${row.home_team_id}`);
      const awayScore = scores.get(`${row.fixture_id}:${row.away_team_id}`);
      const notStarted = ["NS", "TBA", "POSTP", "CANC", "CANCELLED"].includes(String(row.state).toUpperCase());
      const hasScore = !notStarted && [homeScore, awayScore].every((value) => Number.isInteger(value) && value >= 0);
      return { ...row, date: row.kickoff, time, home: teamName(row.home_team_id, teams), away: teamName(row.away_team_id, teams),
        score: hasScore ? `${homeScore} – ${awayScore}` : "—", round: row["round.name"], venue: row["venue.name"] };
    });
  }
  return (state.tables["player_match_stats.csv"] || []).map((row) => {
    const fixture = fixtures.get(row.fixture_id);
    return { ...row, date: fixture?.kickoff, team: teamName(row.team_id, teams),
      match: fixture?.name || (fixture ? `${teamName(fixture.home_team_id, teams)} vs ${teamName(fixture.away_team_id, teams)}` : `Fixture ${row.fixture_id}`),
      xg: number(row.xg_expected_goals) ?? number(row.expected_goals),
    };
  });
}

function render() {
  const builderView = state.view === "builder";
  const standingsView = state.view === "standings";
  const playerView = state.view === "players";
  const tierView = state.view === "tiers";
  const homeView = state.view === "home";
  const fixtureView = state.view === "fixtures";
  const turkishView = standingsView || fixtureView || tierView;
  const loaded = Object.keys(state.tables).length > 0;
  document.documentElement.lang = turkishView ? "tr" : "en";
  $("data-table-container").setAttribute("aria-label", fixtureView ? "Kaydırılabilir fikstür tablosu" : "Scrollable data table");
  $("clear-files").hidden = !loaded;
  document.body.classList.toggle("home-view", homeView);
  document.body.classList.toggle("standings-view", standingsView);
  document.body.classList.toggle("fixtures-view", fixtureView);
  document.body.classList.toggle("tiers-view", tierView);
  $("home-workspace").hidden = !homeView;
  $("home-season-note").hidden = !homeView;
  $("dataset-stats").hidden = homeView || standingsView || builderView || fixtureView || tierView;
  $("empty-state").hidden = loaded || homeView || standingsView;
  $("workspace").hidden = !loaded || tierView || homeView || standingsView || builderView;
  $("standings-workspace").hidden = !standingsView;
  $("builder-workspace").hidden = !loaded || !builderView;
  $("tier-workspace").hidden = !loaded || !tierView;
  $("view-title").textContent = homeView ? "League overview" : tierView ? "Oyuncu Listesi" : playerView ? "Every appearance. A little more context." : "Fikstür";
  $("view-description").textContent = homeView ? "League standings and fixtures, together in one place." : tierView ? "Tüm oyuncular, sezon performansları ve puanlarını oluşturan maçlar." : playerView ? "Explore minutes, chances and attacking output. One row is one player in one match." : "Sezonun bütün maçları, haftalara göre sıralanır.";
  if (standingsView) {
    $("view-title").textContent = "Puan Durumu";
    $("view-description").textContent = "Maçlar, galibiyetler, goller ve form durumu — sezonun ayrıntılı tablosu.";
  }
  if (builderView) {
    $("view-title").textContent = "Fantasy XI Builder";
    $("view-description").textContent = "Craft a starting eleven from the players in your saved season data.";
  }
  $("table-heading").textContent = playerView ? "Player appearances" : "Fikstür";
  $("table-caption").textContent = playerView ? "Recorded match statistics. Click a column heading to sort." : "Başlama saatleri kaydedildiği biçimde gösterilir.";
  $("footer-lead").textContent = turkishView ? "Sorularınız için hazırlandı." : "Built for your questions.";
  $("footer-source").textContent = turkishView ? "Kaynak: Sportmonks dışa aktarımlarınız · Dosyalar bu cihazda kalır" : "Source: your Sportmonks exports · Files remain on this device";
  $("position-filter").hidden = !playerView;
  $("minutes-filter").hidden = !playerView;
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.view);
    if (button.dataset.view === state.view) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  });
  for (const [id, file] of [["appearance-count", "player_match_stats.csv"], ["fixture-count", "fixtures.csv"], ["team-count", "teams.csv"]]) {
    $(id).textContent = state.tables[file] ? displayNumber(state.tables[file].length) : "—";
  }
  const years = [...new Set((state.tables["fixtures.csv"] || []).map((row) => row.kickoff?.slice(0, 4)).filter(Boolean))].sort();
  $("season-label").textContent = years.length ? years.length === 1 ? years[0] : `${years[0]} / ${years[years.length - 1].slice(2)}` : "—";
  if (homeView) { renderHome(); return; }
  if (standingsView) { renderDetailedStandings(); return; }
  if (builderView) { renderSquadBuilder(); return; }
  if (tierView) { renderTierList(); return; }
  const teamEntries = (state.tables["teams.csv"] || []).map((row) => [row.id, row.name]);
  const knownTeams = new Set(teamEntries.map(([id]) => id));
  for (const row of [...(state.tables["player_match_stats.csv"] || []), ...(state.tables["fixtures.csv"] || [])]) {
    for (const id of [row.team_id, row.home_team_id, row.away_team_id].filter(Boolean)) {
      if (!knownTeams.has(id)) { teamEntries.push([id, `Team ${id}`]); knownTeams.add(id); }
    }
  }
  options($("team"), teamEntries.sort((a, b) => a[1].localeCompare(b[1])), "All teams");
  const positions = [...new Set((state.tables["player_match_stats.csv"] || []).map((row) => row.position).filter(Boolean))].sort();
  options($("position"), positions.map((value) => [value, value]), "All positions");
  const search = $("search").value.toLocaleLowerCase().trim();
  const minimum = Math.max(0, number($("minutes").value) ?? 0);
  const rows = records().filter((row) => {
    if (playerView && $("team").value && row.team_id !== $("team").value) return false;
    if (playerView && $("position").value && row.position !== $("position").value) return false;
    if (playerView && minimum > 0 && (number(row.minutes_played) === null || number(row.minutes_played) < minimum)) return false;
    return !playerView || !search || [row.name, row.team, row.match, row.date].filter(Boolean).join(" ").toLocaleLowerCase().includes(search);
  });
  const columns = playerView ? [
    ["name", "Player"], ["team", "Team"], ["position", "Position"], ["date", "Kickoff"], ["match", "Match"],
    ["rating", "Sportmonks rating", true], ["minutes_played", "Minutes", true], ["started", "Started", true], ["goals", "Goals", true], ["assists", "Assists", true],
    ["xg", "xG", true], ["shots_total", "Shots", true], ["shots_on_target", "On target", true], ["key_passes", "Key passes", true],
  ] : [["time", "Saat"], ["home", "Ev Sahibi"], ["score", "Skor"], ["away", "Deplasman"]];
  const numeric = columns.find(([key]) => key === state.sort)?.[2];
  rows.sort(playerView ? (a, b) => {
    const left = numeric ? number(a[state.sort]) : a[state.sort];
    const right = numeric ? number(b[state.sort]) : b[state.sort];
    const leftMissing = left === null || left === undefined || left === "";
    const rightMissing = right === null || right === undefined || right === "";
    if (leftMissing || rightMissing) return leftMissing === rightMissing ? 0 : leftMissing ? 1 : -1;
    return state.direction * (numeric ? left - right : String(left).localeCompare(String(right), undefined, { numeric: true }));
  } : (a, b) => (number(a.round) ?? Infinity) - (number(b.round) ?? Infinity)
    || String(a.round || "").localeCompare(String(b.round || ""), undefined, { numeric: true })
    || String(a.date || "").localeCompare(String(b.date || ""))
    || String(a.fixture_id || "").localeCompare(String(b.fixture_id || "")));
  const head = document.createElement("tr");
  if (playerView) columns.forEach(([key, title, numeric]) => {
    const cell = document.createElement("th");
    cell.scope = "col";
    if (numeric) cell.className = "numeric";
    const button = document.createElement("button");
    cell.setAttribute("aria-sort", state.sort === key ? state.direction > 0 ? "ascending" : "descending" : "none");
    button.textContent = `${title}${state.sort === key ? state.direction > 0 ? " ↑" : " ↓" : ""}`;
    button.addEventListener("click", () => { state.direction = state.sort === key ? -state.direction : numeric ? -1 : 1; state.sort = key; state.page = 0; render(); });
    cell.append(button);
    head.append(cell);
  });
  $("table-head").replaceChildren(...(playerView ? [head] : []));
  const rowsPerPage = playerView ? pageSize : Math.max(1, rows.length);
  const pageCount = Math.max(1, Math.ceil(rows.length / rowsPerPage));
  renderedPageCount = pageCount;
  state.page = Math.min(state.page, pageCount - 1);
  const fragment = document.createDocumentFragment();
  const fixtureTeams = homeTeams();
  const roundDates = new Map();
  if (!playerView) for (const row of rows) {
    const date = String(row.date || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!date) continue;
    const key = String(row.round || "");
    const sortable = `${date[1]}-${date[2]}-${date[3]}`;
    if (!roundDates.has(key) || sortable < roundDates.get(key).sortable) roundDates.set(key, { sortable, display: `${date[3]}/${date[2]}` });
  }
  let previousRound = Symbol("first fixture group");
  let fixtureStripe = 0;
  rows.slice(state.page * rowsPerPage, (state.page + 1) * rowsPerPage).forEach((row) => {
    if (!playerView && row.round !== previousRound) {
      const groupRow = document.createElement("tr"), groupCell = document.createElement("td");
      groupRow.className = "fixture-matchweek-row";
      groupCell.colSpan = columns.length;
      const round = String(row.round || "").trim();
      const roundName = round.replace(/^matchweek\s*/i, "");
      const date = roundDates.get(String(row.round || ""))?.display;
      groupCell.textContent = `${round ? `Maç Haftası ${roundName}` : "Diğer Maçlar"}${date ? ` - ${date}` : ""}`;
      groupRow.append(groupCell);
      fragment.append(groupRow);
      previousRound = row.round;
    }
    const tr = document.createElement("tr");
    if (!playerView) tr.className = `fixture-game-row ${fixtureStripe++ % 2 ? "zebra-light" : "zebra-purple"}`;
    columns.forEach(([key, , numeric]) => {
      const td = document.createElement("td");
      if (!playerView) td.className = `fixture-${key}-cell`;
      td.textContent = numeric ? displayNumber(row[key]) : row[key] || "—";
      const clubId = key === "team" ? row.team_id : key === "home" ? row.home_team_id : key === "away" ? row.away_team_id : null;
      if (clubId) {
        const name = row[key] || `Team ${clubId}`;
        const link = createTeamLink(clubId, name, `fixture-team-link fixture-${key}-team`);
        link.replaceChildren(createTeamLogo(clubId, fixtureTeams, false), element("span", "", name));
        td.replaceChildren(link);
      }
      if (numeric) td.className = "numeric";
      tr.append(td);
    });
    fragment.append(tr);
  });
  if (!rows.length) {
    const tr = document.createElement("tr"), td = document.createElement("td");
    td.colSpan = columns.length; td.className = "no-results";
    td.textContent = !state.tables[playerView ? "player_match_stats.csv" : "fixtures.csv"] ? playerView ? "Open player_match_stats.csv to view these records." : "Fikstürü görüntülemek için fixtures.csv dosyasını açın." : playerView ? "No records match these filters. Try resetting them." : "Gösterilecek maç bulunamadı.";
    tr.append(td); fragment.append(tr);
  }
  $("table-body").replaceChildren(fragment);
  $("result-count").textContent = `${displayNumber(rows.length)} records`;
  $("page-label").textContent = `Page ${state.page + 1} of ${pageCount}`;
  $("previous").disabled = state.page === 0;
  $("next").disabled = state.page + 1 >= pageCount;
  $("table-note").textContent = playerView ? "— means not supplied, not zero. Started: 1 = yes, 0 = no." : "Saved results · Home score first · — means not supplied · Kickoff shown as exported.";
}

function goToTablePage(page) {
  state.page = Math.max(0, Math.min(page, renderedPageCount - 1));
  render();
}

$("open-files").addEventListener("click", () => $("files").click());
$("refresh-data").addEventListener("click", loadLocalData);
$("files").addEventListener("change", (event) => loadFiles([...event.target.files]));
$("clear-files").addEventListener("click", () => { state.tables = {}; state.tierCache = null; state.homeRound = null; state.standingsGroup = null; resetFilters(); resetTierFilters(); resetSquadBuilder(); $("message").textContent = "Loaded files cleared from browser memory."; $("message").classList.remove("error"); render(); });
$("reset").addEventListener("click", () => { resetFilters(); render(); });
["search", "team", "position", "minutes"].forEach((id) => $(id).addEventListener(id === "search" || id === "minutes" ? "input" : "change", () => { state.page = 0; render(); }));
$("previous").addEventListener("click", () => goToTablePage(state.page - 1));
$("next").addEventListener("click", () => goToTablePage(state.page + 1));
function navigateView(view) {
  state.view = ["home", "standings", "fixtures", "builder", "tiers", "players"].includes(view) ? view : "home";
  state.sort = "date"; state.direction = state.view === "fixtures" ? 1 : -1; state.page = 0;
  render();
}
document.querySelectorAll("[data-view]").forEach((link) => link.addEventListener("click", (event) => {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (location.protocol !== "file:") {
    const url = new URL(location.href);
    url.searchParams.set("view", link.dataset.view);
    history.pushState(null, "", url);
  }
  navigateView(link.dataset.view);
}));
window.addEventListener("popstate", () => navigateView(new URLSearchParams(location.search).get("view")));

setupTierList();
setupHome();
setupDetailedStandings();
setupSquadBuilder();
navigateView(new URLSearchParams(location.search).get("view"));
if (location.protocol === "http:" && ["127.0.0.1", "localhost"].includes(location.hostname)) {
  $("open-files").before($("refresh-data"));
  $("refresh-data").className = "primary";
  $("open-files").className = "text-button";
  $("refresh-data").hidden = false;
  loadLocalData();
} else if (location.protocol === "file:") {
  $("message").textContent = "For automatic loading, run python src/web/serve.py --season 2026/2027 and open http://127.0.0.1:8000. Or click Open season CSVs.";
}
