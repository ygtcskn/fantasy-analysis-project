"use strict";

// Oyuncu Listesi on Takım İstatistikleri: the Oyuncu İstatistikleri player
// list - same markup, rows, search, role buttons and sorting - limited to the
// open team, with figures from that team's matches only, so a player who
// changed clubs is not credited here with what he did elsewhere. Its columns
// are the ones a team view needs: rating, fantasy points per match, goals and
// assists. Depends on the page helpers ($, element, number, displayNumber,
// state, fantasyState, teamName, homeTeams, teamStatisticsState), the shared
// player aggregation in tier-list.js (buildTierPlayers, leaguePlayers,
// validMatchRating, ratingText, playerPrimaryRole, playerRoleLabel,
// createTeamLogo, openTierPlayer), statisticsShortName from statistics.js and
// RadarScoring's coverage rules.

const teamPlayersState = { role: "" };

const TEAM_PLAYER_SORTS = {
  rating: (player) => player.rating,
  fantasy: (player) => player.fantasy,
  goals: (player) => player.goals.value,
  assists: (player) => player.assists.value,
};

// A bench row - a lineup published before kickoff, or an unused substitute -
// is not an appearance; RadarScoring.unplayed is the site's rule for that.
function teamPlayerPlayed(row) {
  return typeof RadarScoring !== "undefined" ? !RadarScoring.unplayed(row) : (number(row.minutes_played) ?? 0) > 0;
}

// Sportmonks writes no zeros. A blank goal on a match its statistics covered is
// none; on a match they did not cover it is unknown, and the total is marked
// with an asterisk as the tier list marks one.
function teamPlayerCount(rows, key) {
  let value = 0, known = 0;
  for (const row of rows) {
    const own = number(row[key]) ?? (typeof RadarScoring !== "undefined" && RadarScoring.covered(row) ? 0 : null);
    if (own === null) continue;
    value += own;
    known += 1;
  }
  return { value: known ? value : null, known, records: rows.length };
}

// Every player who has appeared for the team. `current` is false for one who
// has since left the league's squads (Talisca, for one): like every other
// player list on the site, the list leaves him out, and its note counts him.
function teamPlayers(teamId) {
  const fantasyReady = Boolean(fantasyState.season) && fantasyState.season === state.seasonSlug;
  const current = new Set(leaguePlayers().players.map((player) => player.id));
  return buildTierPlayers().players.flatMap((player) => {
    const rows = player.matches.filter((row) => row.team_id === teamId && teamPlayerPlayed(row));
    if (!rows.length) return [];
    const ratings = rows.map(validMatchRating).filter((value) => value !== null);
    // The published ledger has one row per appearance, with the club he played for.
    const ledger = fantasyReady ? (fantasyState.matches.get(player.id) || []).filter((row) => String(row.team_id) === teamId) : [];
    return [{ id: player.id, name: player.name, role: playerPrimaryRole(player), current: current.has(player.id),
      rating: ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null,
      fantasy: ledger.length ? ledger.reduce((sum, row) => sum + (number(row.points_total) ?? 0), 0) / ledger.length : null,
      fantasyMatches: ledger.length,
      goals: teamPlayerCount(rows, "goals"), assists: teamPlayerCount(rows, "assists") }];
  });
}

function teamPlayerCountCell(count) {
  const partial = count.known > 0 && count.known < count.records;
  const cell = element("td", "numeric", `${displayNumber(count.value)}${partial ? "*" : ""}`);
  if (count.known < count.records) cell.title = `${count.records} maçın ${count.known} tanesinde kayıtlı; eksikler sıfır sayılmadı.`;
  return cell;
}

function renderTeamPlayers(teamId) {
  const names = homeTeams();
  $("team-statistics-players-team").textContent = teamId ? teamName(teamId, names) : "—";
  const query = $("team-statistics-players-search").value.trim().toLocaleLowerCase("tr");
  const accessor = TEAM_PLAYER_SORTS[$("team-statistics-players-sort").value] || TEAM_PLAYER_SORTS.rating;
  const role = teamPlayersState.role;
  const everyone = teamId ? teamPlayers(teamId) : [];
  const departed = everyone.filter((player) => !player.current).length;
  // Filtered and ordered exactly as Oyuncu İstatistikleri orders its list.
  const visible = everyone
    .filter((player) => player.current && (!role || player.role === role)
      && (!query || player.name.toLocaleLowerCase("tr").includes(query)))
    .sort((a, b) => (accessor(b) ?? -Infinity) - (accessor(a) ?? -Infinity)
      || a.name.localeCompare(b.name, "tr"));
  const body = document.createDocumentFragment();
  for (const player of visible) {
    const row = element("tr");
    const identity = element("td");
    const club = element("div", "statistics-club");
    club.append(createTeamLogo(teamId, names, false));
    const open = element("button", "statistics-player-button",
      typeof statisticsShortName === "function" ? statisticsShortName(player.name) : player.name);
    open.type = "button";
    open.title = player.name;
    open.setAttribute("aria-label", `${player.name} maç istatistiklerini aç`);
    open.addEventListener("click", () => openTierPlayer(player.id));
    club.append(open);
    identity.append(club);
    row.append(identity);
    row.append(element("td", "statistics-role", playerRoleLabel(player.role)));
    row.append(element("td", "numeric", ratingText(player.rating)));
    const fantasy = element("td", "numeric", player.fantasy === null ? "—"
      : player.fantasy.toLocaleString("tr-TR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
    if (player.fantasy !== null) fantasy.title = `${player.fantasyMatches} maçta ${displayNumber(player.fantasy * player.fantasyMatches)} puan`;
    row.append(fantasy, teamPlayerCountCell(player.goals), teamPlayerCountCell(player.assists));
    body.append(row);
  }
  if (!visible.length) {
    const row = element("tr"), cell = element("td", "no-results",
      !teamId ? "Takım seçilmedi." : everyone.length ? "Bu filtrelerle oyuncu bulunamadı." : "Bu takım için kayıtlı oyuncu maçı yok.");
    cell.colSpan = 6;
    row.append(cell);
    body.append(row);
  }
  $("team-statistics-players-body").replaceChildren(body);
  const fantasyReady = Boolean(fantasyState.season) && fantasyState.season === state.seasonSlug;
  const partial = visible.some((player) => [player.goals, player.assists].some((count) => count.known < count.records));
  $("team-statistics-players-note").textContent = !everyone.length ? ""
    : `Rakamlar yalnızca ${teamName(teamId, names)} formasıyla oynanan maçlardan; FP/Maç yayımlanan fantezi puanının maç başı ortalaması.`
      + (departed ? ` Bu takımda oynayıp ligden ayrılan ${departed} oyuncu gösterilmiyor.` : "")
      + (fantasyReady ? "" : ` ${fantasyState.note}`)
      + (partial ? " * işaretli toplamların bazı maçlarında istatistik yok; eksikler sıfır sayılmadı." : "");
  requestAnimationFrame(teamStatisticsFitNames);
}

function setupTeamPlayers() {
  const render = () => renderTeamPlayers(teamStatisticsState.selected);
  $("team-statistics-players-search").addEventListener("input", render);
  $("team-statistics-players-sort").addEventListener("change", render);
  document.querySelectorAll("[data-team-players-role]").forEach((button) => button.addEventListener("click", () => {
    teamPlayersState.role = button.dataset.teamPlayersRole;
    document.querySelectorAll("[data-team-players-role]").forEach((other) =>
      other.setAttribute("aria-pressed", String(other === button)));
    render();
  }));
}
