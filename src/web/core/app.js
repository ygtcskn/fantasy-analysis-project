"use strict";

// CSVs come from the local server or file picker and stay in browser memory.
const state = { tables: {}, seasonSlug: "", view: "home", page: 0, sort: "date", direction: -1, busy: false, tierCache: null, homeFixture: null, homeWeek: null, standingsGroup: null };
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
const displayNumber = (value) => number(value) === null ? "—" : new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 }).format(Number(value));
const teamName = (id, teams) => teams.get(id)?.name || (id ? t("Takım {id}", { id }) : "—");

async function loadFiles(files, { replace = false, local = false } = {}) {
  if (state.busy) return;
  state.busy = true;
  const incoming = {}, messages = [], accepted = [], names = new Set();
  const sourceSeasons = new Set();
  if (typeof files === "function") {
    try { files = await files(); }
    catch (error) { messages.push(`${error.message} ${t("Önceden yüklenen veriler korundu.")}`); files = []; }
  }
  for (const file of files) {
    if (!expected[file.name]) continue;
    if (names.has(file.name)) { messages.push(t("Her yüklemede yalnızca bir {file} seçin.", { file: file.name })); continue; }
    names.add(file.name);
    try {
      if (file.size > 40 * 1024 * 1024) throw new Error(t("Dosya 40 MB sınırını aşıyor."));
      const table = parseCSV(await file.text());
      const missing = expected[file.name].filter((field) => !table.header.includes(field));
      if (missing.length) throw new Error(t("Eksik sütunlar: {columns}.", { columns: missing.join(", ") }));
      incoming[file.name] = table.records;
      accepted.push(file.name);
      if (file.sourceSeason) sourceSeasons.add(file.sourceSeason);
    } catch (error) { messages.push(`${file.name}: ${error.message}`); }
  }
  // A new fixture file starts a new dataset to avoid silently mixing seasons.
  const next = replace || (incoming["fixtures.csv"] && state.tables["fixtures.csv"]) ? { ...incoming } : { ...state.tables, ...incoming };
  const fixtures = next["fixtures.csv"] || [];
  if (sourceSeasons.size > 1) messages.push(t("Yükleme sırasında sunucunun sezonu değişti. Sayfayı yeniden yükleyin."));
  const seasonIds = new Set(fixtures.map((row) => row.season_id).filter(Boolean));
  if (seasonIds.size > 1) messages.push(t("Lütfen tek bir sezonun fikstürünü seçin."));
  const squadSeasons = new Set((next["squads.csv"] || []).map((row) => row.season_id).filter(Boolean));
  if (squadSeasons.size > 1 || (seasonIds.size && [...squadSeasons].some((id) => !seasonIds.has(id)))) messages.push(t("Kadro ve fikstür dosyalarını aynı sezondan seçin."));
  const standingSeasons = new Set((next["standings.csv"] || []).map((row) => row.season_id).filter(Boolean));
  const allSeasons = new Set([...seasonIds, ...squadSeasons, ...standingSeasons]);
  if (allSeasons.size > 1) messages.push(t("Puan durumu, kadro ve fikstür dosyalarını aynı sezondan seçin."));
  for (const [file, key] of [["fixtures.csv", (row) => row.fixture_id], ["player_match_stats.csv", (row) => `${row.fixture_id}:${row.player_id}`], ["players.csv", (row) => row.id], ["teams.csv", (row) => row.id]]) {
    const ids = new Set();
    for (const row of next[file] || []) {
      const id = key(row);
      if (id && ids.has(id)) { messages.push(t("{file} dosyasında yinelenen kayıtlar var; iki kez sayılmamaları için yüklemeden önce düzeltin.", { file })); break; }
      ids.add(id);
    }
  }
  if (fixtures.length && next["player_match_stats.csv"]) {
    const ids = new Set(fixtures.map((row) => row.fixture_id));
    if (next["player_match_stats.csv"].some((row) => !ids.has(row.fixture_id))) messages.push(t("Bazı oyuncu kayıtları bu fikstürle eşleşmiyor. Aynı sezonun dosyalarını birlikte seçin."));
  }
  if (fixtures.length && next["fixture_scores.csv"]) {
    const ids = new Set(fixtures.map((row) => row.fixture_id));
    if (next["fixture_scores.csv"].some((row) => !ids.has(row.fixture_id))) messages.push(t("Bazı skorlar bu fikstürle eşleşmiyor. Aynı sezonun dosyalarını birlikte seçin."));
  }
  if (!messages.length && accepted.length) {
    const previousSeason = state.tables["fixtures.csv"]?.find((row) => row.season_id)?.season_id;
    const incomingSeason = incoming["fixtures.csv"]?.find((row) => row.season_id)?.season_id;
    if (previousSeason && incomingSeason && previousSeason !== incomingSeason) resetSquadBuilder();
    state.tables = next;
    state.seasonSlug = local && sourceSeasons.size === 1 ? [...sourceSeasons][0] : "";
    currentSquad = null;
    resetFantasyData();
    resetMatchweekOdds();
    resetMatchweekResults();
    state.tierCache = null;
    // New tables may bring new match statistics for the same season. Cleared
    // here, before render() below starts the radar loads, so one refresh
    // fetches the spider and history CSVs once rather than twice.
    if (typeof spiderStatsState !== "undefined") spiderStatsState.key = null;
    if (typeof statisticsHistory !== "undefined") statisticsHistory.key = null;
    if (typeof teamHistory !== "undefined") teamHistory.key = null;
    if (typeof teamMetricsState !== "undefined") teamMetricsState.key = null;
    if (typeof teamAnalysisExtras !== "undefined") teamAnalysisExtras.key = null;
    state.homeFixture = null;
    state.homeWeek = null;
    homeExtras.key = null;
    state.standingsGroup = null;
    resetTierFilters();
    resetFilters();
    if (!local) messages.push(t("{files} yüklendi. Sezon değiştirirken yeni sezonun dosyalarını birlikte seçin.", { files: accepted.join(", ") }));
    $("message").classList.remove("error");
  } else {
    if (!messages.length) messages.push(t("Sezonun csv klasöründen desteklenen dosyaları seçin: {files}.", { files: Object.keys(expected).join(", ") }));
    $("message").classList.add("error");
  }
  $("message").textContent = messages.join(" ");
  state.busy = false;
  render();
  return Boolean(accepted.length && state.tables === next);
}

async function loadLocalData() {
  if (state.busy) return;
  resetFantasyData(t("Fantezi analizi okunuyor…"));
  resetMatchweekOdds();
  $("message").classList.remove("error");
  $("message").textContent = "";
  const loaded = await loadFiles(async () => {
    const results = await Promise.allSettled(Object.keys(expected).map(async (name) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        // no-cache still asks the server every time; an unchanged file returns as a short 304.
        const response = await fetch(`/local-data/${name}`, { cache: "no-cache", signal: controller.signal });
        if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
        if (response.headers.get("X-Superlig-Local") !== "1") throw new Error(t("Siteyi src/web/serve.py ile başlatın."));
        const blob = await response.blob();
        const file = new File([blob], name, { type: "text/csv" });
        file.sourceSeason = response.headers.get("X-Superlig-Season") || "";
        return file;
      } finally { clearTimeout(timeout); }
    }));
    const failures = results.filter((result) => result.status === "rejected");
    const advice = siteMode === "local" ? t("Yerel sunucunun çalıştığını ve indirmenin bittiğini kontrol edin.") : t("Sayfayı yeniden yükleyin.");
    if (failures.length) throw new Error(`${t("Kaydedilen CSV dosyaları okunamadı.")} ${failures.map((result) => result.reason.message).join("; ")}. ${advice}`);
    return results.map((result) => result.value);
  }, { replace: true, local: true });
  if (loaded) await Promise.allSettled([loadFantasyData(), loadMatchweekOdds(), loadCurrentSquads()]);
  else resetFantasyData(t("Kaydedilen sezon verisi yenilenemediği için fantezi analizi kullanılamıyor."));
  if (state.view === "builder") renderSquadBuilder();
  if (state.view === "matchweek") renderMatchweek();
  if (state.view === "tiers") renderTierList();
  if (state.view === "statistics") renderStatistics();
  if (state.view === "team-statistics") renderTeamStatistics();
  // Kadrolar's actual points come from the fantasy ledger loaded just above.
  if (state.view === "squads") renderSharedSquads();
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
      const time = kickoffDay(row) ? kickoffClock(row) : "—";
      const homeScore = scores.get(`${row.fixture_id}:${row.home_team_id}`);
      const awayScore = scores.get(`${row.fixture_id}:${row.away_team_id}`);
      const hasScore = !fixtureUnplayed(row) && [homeScore, awayScore].every((value) => Number.isInteger(value) && value >= 0);
      return { ...row, date: row.kickoff, day: kickoffDay(row), time, home: teamName(row.home_team_id, teams), away: teamName(row.away_team_id, teams),
        score: hasScore ? `${homeScore} – ${awayScore}` : "—", round: row["round.name"], venue: row["venue.name"] };
    });
  }
  return (state.tables["player_match_stats.csv"] || []).map((row) => {
    const fixture = fixtures.get(row.fixture_id);
    return { ...row, date: fixture?.kickoff, dateText: fixture ? kickoffText(fixture) : "—", team: teamName(row.team_id, teams),
      match: fixture?.name || (fixture ? `${teamName(fixture.home_team_id, teams)} - ${teamName(fixture.away_team_id, teams)}` : t("Maç {id}", { id: row.fixture_id })),
      xg: number(row.xg_expected_goals) ?? number(row.expected_goals),
    };
  });
}

function render() {
  const socialView = state.view === "social";
  const squadsView = state.view === "squads";
  const matchweekView = state.view === "matchweek";
  const builderView = state.view === "builder";
  const statisticsView = state.view === "statistics";
  const teamStatisticsView = state.view === "team-statistics";
  const standingsView = state.view === "standings";
  const playerView = state.view === "players";
  const tierView = state.view === "tiers";
  const homeView = state.view === "home";
  const fixtureView = state.view === "fixtures";
  const loaded = Object.keys(state.tables).length > 0;
  $("data-table-container").setAttribute("aria-label", fixtureView ? t("Kaydırılabilir fikstür tablosu") : t("Kaydırılabilir veri tablosu"));
  document.body.classList.toggle("home-view", homeView);
  document.body.classList.toggle("standings-view", standingsView);
  document.body.classList.toggle("fixtures-view", fixtureView);
  document.body.classList.toggle("tiers-view", tierView);
  $("home-workspace").hidden = !homeView;
  $("home-season-note").hidden = !homeView;
  $("dataset-stats").hidden = homeView || standingsView || builderView || fixtureView || tierView || matchweekView || statisticsView || teamStatisticsView;
  // Its serve.py instructions are for this computer, not for visitors to the public site.
  $("empty-state").hidden = loaded || siteMode === "published" || homeView || standingsView || matchweekView;
  $("statistics-workspace").hidden = !loaded || !statisticsView;
  $("team-statistics-workspace").hidden = !loaded || !teamStatisticsView;
  $("workspace").hidden = !loaded || tierView || homeView || standingsView || builderView || matchweekView || statisticsView || teamStatisticsView;
  $("matchweek-workspace").hidden = !matchweekView;
  syncLiveMatchCentre();
  $("standings-workspace").hidden = !standingsView;
  $("builder-workspace").hidden = !loaded || !builderView;
  $("tier-workspace").hidden = !loaded || !tierView;
  $("social-workspace").hidden = !socialView;
  $("squads-workspace").hidden = !squadsView;
  if (socialView || squadsView) {
    for (const id of ["dataset-stats", "empty-state", "workspace"]) $(id).hidden = true;
  }
  $("view-title").textContent = homeView ? t("Ana Sayfa") : tierView ? t("Oyuncu Listesi") : playerView ? t("Oyuncu Katılımları") : t("Fikstür");
  $("view-description").textContent = homeView ? t("Oynanan maçlar, puan durumu ve seçtiğin maçın özeti.") : tierView ? t("Tüm oyuncular, sezon performansları ve reytinglerini oluşturan maçlar.") : playerView ? t("Dakikalar, fırsatlar ve hücum katkısı. Her satır bir oyuncunun bir maçıdır.") : t("Sezonun bütün maçları, haftalara göre sıralanır.");
  if (standingsView) {
    $("view-title").textContent = t("Puan Durumu");
    $("view-description").textContent = t("Maçlar, galibiyetler, goller ve form durumu — sezonun ayrıntılı tablosu.");
  }
  if (builderView) {
    $("view-title").textContent = t("Kadro Kur");
    $("view-description").textContent = t("Kaydedilen sezon verisindeki oyunculardan ilk on birini kurun.");
  }
  if (matchweekView) {
    $("view-title").textContent = t("Maç Haftası");
    $("view-description").textContent = t("Haftalık fantezi futbol analizleri.");
  }
  if (statisticsView) {
    $("view-title").textContent = t("Oyuncu İstatistikleri");
    $("view-description").textContent = t("Sezonun önde gelen oyuncuları ve tüm oyuncu listesi.");
  }
  if (teamStatisticsView) {
    $("view-title").textContent = t("Takım İstatistikleri");
    $("view-description").textContent = t("Takımları sezon sonuçları, maç istatistikleri ve fantezi puanlarıyla karşılaştırın.");
  }
  $("table-heading").textContent = playerView ? t("Oyuncu katılımları") : t("Fikstür");
  $("table-caption").textContent = playerView ? t("Kaydedilen maç istatistikleri. Sıralamak için sütun başlığına tıklayın.") : t("Saatler Türkiye saatiyledir.");
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
  $("view-eyebrow").textContent = years.length ? t("SÜPER LİG · {season} SEZONU", { season: $("season-label").textContent }) : t("SÜPER LİG");
  if (socialView) {
    $("view-title").textContent = t("Maç Tribünü");
    $("view-description").textContent = t("Haftanın maçlarını konuş, kendi konunu aç, tribünün sesine katıl.");
    $("view-eyebrow").textContent = t("SOSYAL · MAÇ TRİBÜNÜ");
    renderSocial();
    return;
  }
  if (squadsView) {
    $("view-title").textContent = t("Kadrolar");
    $("view-description").textContent = t("Paylaşılan fantezi kadroları, maç haftalarına göre.");
    $("view-eyebrow").textContent = t("SOSYAL · KADROLAR");
    renderSharedSquads();
    return;
  }
  if (homeView) { renderHome(); return; }
  if (matchweekView) { renderMatchweek(); return; }
  if (standingsView) { renderDetailedStandings(); return; }
  if (builderView) { renderSquadBuilder(); return; }
  if (statisticsView) { renderStatistics(); return; }
  if (teamStatisticsView) { renderTeamStatistics(); return; }
  if (tierView) { renderTierList(); return; }
  const teamEntries = (state.tables["teams.csv"] || []).map((row) => [row.id, row.name]);
  const knownTeams = new Set(teamEntries.map(([id]) => id));
  for (const row of [...(state.tables["player_match_stats.csv"] || []), ...(state.tables["fixtures.csv"] || [])]) {
    for (const id of [row.team_id, row.home_team_id, row.away_team_id].filter(Boolean)) {
      if (!knownTeams.has(id)) { teamEntries.push([id, t("Takım {id}", { id })]); knownTeams.add(id); }
    }
  }
  options($("team"), teamEntries.sort((a, b) => a[1].localeCompare(b[1], LOCALE)), t("Tüm takımlar"));
  const positions = [...new Set((state.tables["player_match_stats.csv"] || []).map((row) => row.position).filter(Boolean))].sort();
  options($("position"), positions.map((value) => [value, value]), t("Tüm mevkiler"));
  const search = $("search").value.toLocaleLowerCase().trim();
  const minimum = Math.max(0, number($("minutes").value) ?? 0);
  const rows = records().filter((row) => {
    if (playerView && $("team").value && row.team_id !== $("team").value) return false;
    if (playerView && $("position").value && row.position !== $("position").value) return false;
    if (playerView && minimum > 0 && (number(row.minutes_played) === null || number(row.minutes_played) < minimum)) return false;
    return !playerView || !search || [row.name, row.team, row.match, row.date].filter(Boolean).join(" ").toLocaleLowerCase().includes(search);
  });
  const columns = playerView ? [
    ["name", t("Oyuncu")], ["team", t("Takım")], ["position", t("Mevki")], ["date", t("Başlama")], ["match", t("Maç")],
    ["rating", t("Reyting"), true], ["minutes_played", t("Dakika"), true], ["started", t("İlk 11"), true], ["goals", t("Gol"), true], ["assists", t("Asist"), true],
    ["xg", "xG", true], ["shots_total", t("Şut"), true], ["shots_on_target", t("İsabetli şut"), true], ["key_passes", t("Kilit pas"), true],
  ] : [["time", t("Saat")], ["home", t("Ev Sahibi")], ["score", t("Skor")], ["away", t("Deplasman")]];
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
    const date = String(row.day || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
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
      groupCell.textContent = `${round ? t("Maç Haftası {round}", { round: roundName }) : t("Diğer Maçlar")}${date ? ` - ${date}` : ""}`;
      groupRow.append(groupCell);
      fragment.append(groupRow);
      previousRound = row.round;
    }
    const tr = document.createElement("tr");
    if (!playerView) tr.className = `fixture-game-row ${fixtureStripe++ % 2 ? "zebra-light" : "zebra-purple"}`;
    columns.forEach(([key, , numeric]) => {
      const td = document.createElement("td");
      if (!playerView) td.className = `fixture-${key}-cell`;
      td.textContent = numeric ? displayNumber(row[key]) : key === "date" && playerView ? row.dateText : row[key] || "—";
      const clubId = key === "team" ? row.team_id : key === "home" ? row.home_team_id : key === "away" ? row.away_team_id : null;
      if (clubId) {
        const name = row[key] || t("Takım {id}", { id: clubId });
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
    td.textContent = !state.tables[playerView ? "player_match_stats.csv" : "fixtures.csv"] ? playerView ? t("Bu kayıtları görmek için player_match_stats.csv dosyasını açın.") : t("Fikstürü görüntülemek için fixtures.csv dosyasını açın.") : playerView ? t("Bu filtrelerle eşleşen kayıt yok. Filtreleri sıfırlamayı deneyin.") : t("Gösterilecek maç bulunamadı.");
    tr.append(td); fragment.append(tr);
  }
  $("table-body").replaceChildren(fragment);
  $("result-count").textContent = t("{count} kayıt", { count: displayNumber(rows.length) }, rows.length);
  $("page-label").textContent = t("Sayfa {page} / {pages}", { page: state.page + 1, pages: pageCount });
  $("previous").disabled = state.page === 0;
  $("next").disabled = state.page + 1 >= pageCount;
  $("table-note").textContent = playerView ? t("— sıfır değil, veri sağlanmadı demektir. İlk 11: 1 = evet, 0 = hayır.") : t("Kaydedilen sonuçlar · Önce ev sahibi skoru · — veri sağlanmadı demektir · Saatler Türkiye saatiyle.");
}

function goToTablePage(page) {
  state.page = Math.max(0, Math.min(page, renderedPageCount - 1));
  render();
}

$("reset").addEventListener("click", () => { resetFilters(); render(); });
["search", "team", "position", "minutes"].forEach((id) => $(id).addEventListener(id === "search" || id === "minutes" ? "input" : "change", () => { state.page = 0; render(); }));
$("previous").addEventListener("click", () => goToTablePage(state.page - 1));
$("next").addEventListener("click", () => goToTablePage(state.page + 1));
const siteViews = ["home", "standings", "fixtures", "matchweek", "builder", "statistics", "team-statistics", "tiers", "players", "social", "squads"];
function navigateView(view) {
  state.view = siteViews.includes(view) ? view : "home";
  state.sort = "date"; state.direction = state.view === "fixtures" ? 1 : -1; state.page = 0;
  render();
}
document.querySelectorAll("[data-view]").forEach((link) => link.addEventListener("click", (event) => {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (location.protocol !== "file:") {
    const url = new URL(location.href);
    url.searchParams.set("view", link.dataset.view);
    // A sidebar link opens the page itself, not the squad Kadrolar last showed.
    url.searchParams.delete("squad");
    history.pushState(null, "", url);
  }
  navigateView(link.dataset.view);
}));
window.addEventListener("popstate", () => navigateView(new URLSearchParams(location.search).get("view")));

setupTierList();
setupHome();
setupHomeChat();
setupDetailedStandings();
setupSquadBuilder();
setupBuilderRecommendations();
setupBuilderSummary();
setupBuilderSave();
setupStatistics();
setupTeamStatistics();
setupMatchweek();
setupLiveMatchCentre();
// The local server supplies the saved season on every page load; reloading the
// page is how new data arrives after a download or a pipeline run.
navigateView(new URLSearchParams(location.search).get("view"));
if (siteMode !== "none") {
  loadLocalData();
} else {
  $("message").textContent = t("Siteyi görmek için python src/web/serve.py --season 2026/2027 komutunu çalıştırıp http://127.0.0.1:8000 adresini açın.");
}
