"use strict";

// One definition, for every page, of when a match counts, when a player row is
// an appearance and what a blank statistic means. src/shared.py holds the same
// lists for the pipeline - change the two together - so a figure the browser
// draws agrees with the one the pipeline publishes. Standalone: team.html loads
// it without the rest of the site.

// A result is final in these states (Sportmonks developer names).
const FINISHED_STATES = new Set(["FT", "AET", "FT_PEN", "AWARDED", "WO"]);
// Not kicked off, or never will be: no score is shown even if one is saved.
const UNPLAYED_STATES = new Set(["NS", "TBA", "PENDING", "DELAYED", "POSTP", "POSTPONED", "CANC", "CANCELLED", "DELETED"]);
// A match the statistics feed described at all. One of these present means a
// blank elsewhere in the row is none; without them a blank stays unknown.
const COVERAGE_COLUMNS = ["touches", "passes", "total_duels", "shots_total", "fouls", "possession_lost"];

const ruleBlank = (value) => value === undefined || value === null || String(value).trim() === "";
const ruleNumber = (value) => (ruleBlank(value) || !Number.isFinite(Number(value)) ? null : Number(value));

function fixtureState(fixture) {
  return String(fixture?.["state.developer_name"] || fixture?.state || "").trim().toUpperCase();
}

function fixtureFinished(fixture) {
  return FINISHED_STATES.has(fixtureState(fixture));
}

function fixtureUnplayed(fixture) {
  return UNPLAYED_STATES.has(fixtureState(fixture));
}

// A player row is an appearance when he was on the pitch. Lineups also list
// unused substitutes, with no minutes: they were in the squad, not in the match.
function playerAppeared(row) {
  return (ruleNumber(row?.minutes_played) ?? 0) > 0;
}

function rowCovered(row) {
  return COVERAGE_COLUMNS.some((column) => !ruleBlank(row?.[column]));
}

// One match's count of something (goals, cards, saves). Sportmonks writes no
// zeros, so a blank on a covered match is none; on an uncovered match it is
// unknown, and a total built from it is marked partial.
function countedValue(row, column) {
  const value = ruleNumber(row?.[column]);
  if (value !== null) return value >= 0 ? value : null;
  return ruleBlank(row?.[column]) && rowCovered(row) ? 0 : null;
}

// A Sportmonks match rating that counts: 1-10, and not on an explicit
// zero-minute record.
function validMatchRating(row) {
  const value = ruleNumber(row?.rating);
  return value !== null && value >= 1 && value <= 10 && ruleNumber(row?.minutes_played) !== 0 ? value : null;
}

// The matchweek a page opens on, as an index into rounds listed in kickoff
// order, each { fixtures: [...] }: the one Sportmonks marks current, else the
// first with a match still to kick off, else the last. -1 when there are none.
function currentRoundIndex(rounds, now = Date.now()) {
  const marked = rounds.findIndex((round) => round.fixtures.some((fixture) => String(fixture["round.is_current"]).toLowerCase() === "true"));
  if (marked >= 0) return marked;
  const upcoming = rounds.findIndex((round) => round.fixtures.some((fixture) => (ruleNumber(fixture.starting_at_timestamp) ?? -1) * 1000 >= now));
  return upcoming >= 0 ? upcoming : rounds.length - 1;
}

// The same rule for a team's match statistics (team_metrics.csv), covered when
// any of these is recorded - TEAM_COVERAGE_COLUMNS in src/shared.py.
// Team card counts come only from here, on every page: Sportmonks counts a
// second yellow as a yellow card, and any dismissal as a red card.
const TEAM_COVERAGE_COLUMNS = ["passes", "shots_total", "fouls", "ball_possession", "duels_won"];

function teamCountedValue(row, column) {
  const value = ruleNumber(row?.[column]);
  if (value !== null) return value >= 0 ? value : null;
  return row && ruleBlank(row[column]) && TEAM_COVERAGE_COLUMNS.some((name) => !ruleBlank(row[name])) ? 0 : null;
}

// The one name a player is shown by, from his Sportmonks profile, whatever
// match row or published file mentions him. Match rows carry the name as it
// was when each match was captured, so one player can appear under several.
// display_name is usually right and is the only field with a nickname
// (Talisca, Fabinho), but the provider has corrupted it on some profiles -
// Stefan Savić's reads "André Hainault", Onur Bulut's "Maksym Bilyi". A display
// name of several words that shares none with the player's own names is not
// trusted, and his registered name is used instead.
function profileName(profile) {
  const fold = (value) => String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i").replace(/ə/g, "a").replace(/ł/g, "l").replace(/ø/g, "o").replace(/æ/g, "ae").replace(/ß/g, "ss")
    .toLocaleLowerCase("en");
  const words = (value) => fold(value).split(/[\s'’.-]+/).filter((word) => word.length > 1);
  const display = String(profile?.display_name || "").trim(), registered = String(profile?.name || "").trim();
  if (!display) return registered;
  const own = new Set([profile?.name, profile?.firstname, profile?.lastname, profile?.common_name].flatMap(words));
  const shown = words(display);
  return shown.length <= 1 || shown.some((word) => own.has(word)) ? display : registered || display;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { FINISHED_STATES, fixtureState, fixtureFinished, fixtureUnplayed, playerAppeared, rowCovered,
    countedValue, validMatchRating, currentRoundIndex, teamCountedValue, profileName };
}
