"""Validated, read-only SQLite tools for answering questions about football."""

from __future__ import annotations

import csv
from dataclasses import dataclass, field
import io
from pathlib import Path
import re
import sqlite3
import sys
from typing import Callable

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.chat.build_chat_db import OUTPUT as DATABASE, search_name
from src.chat.dashboard_data import PHASES, SEASON_COMPARISONS, TEAM_PERCENTAGES, TEAM_STATS
from src.shared import CALLED_OFF_STATES, SeasonError, season_label

POSITIONS = ["Goalkeeper", "Defender", "Midfielder", "Attacker"]
POSITION_ORDER = ("CASE pm.position WHEN 'Goalkeeper' THEN 0 WHEN 'Defender' THEN 1 "
                  "WHEN 'Midfielder' THEN 2 WHEN 'Attacker' THEN 3 ELSE 4 END")

# Every stat a leaderboard can rank by: the SQL that totals it, and the column
# whose blanks show how well the season recorded it (None: always recorded).
STATS = {
    "goals":              ("SUM(pm.goals)", "goals"),
    "assists":            ("SUM(pm.assists)", "assists"),
    "goals_and_assists":  ("SUM(pm.goals) + SUM(pm.assists)", "assists"),
    "expected_goals":     ("ROUND(SUM(pm.expected_goals), 2)", "expected_goals"),
    "shots_total":        ("SUM(pm.shots_total)", "shots_total"),
    "shots_on_target":    ("SUM(pm.shots_on_target)", "shots_on_target"),
    "key_passes":         ("SUM(pm.key_passes)", "key_passes"),
    "big_chances_created": ("SUM(pm.big_chances_created)", "big_chances_created"),
    "passes":             ("SUM(pm.passes)", "passes"),
    "accurate_passes":    ("SUM(pm.accurate_passes)", "accurate_passes"),
    "tackles":            ("SUM(pm.tackles)", "tackles"),
    "interceptions":      ("SUM(pm.interceptions)", "interceptions"),
    "clearances":         ("SUM(pm.clearances)", "clearances"),
    "saves":              ("SUM(pm.saves)", "saves"),
    "goals_conceded":     ("SUM(pm.goals_conceded)", "goals_conceded"),
    "fouls":              ("SUM(pm.fouls)", "fouls"),
    "fouls_drawn":        ("SUM(pm.fouls_drawn)", "fouls_drawn"),
    "yellowcards":        ("SUM(pm.yellowcards)", "yellowcards"),
    "redcards":           ("SUM(pm.redcards)", "redcards"),
    "yellowred_cards":    ("SUM(pm.yellowred_cards)", "yellowred_cards"),
    "penalties_scored":   ("SUM(pm.penalties_scored)", "penalties_scored"),
    "penalties_misses":   ("SUM(pm.penalties_misses)", "penalties_misses"),
    "own_goals":          ("SUM(pm.own_goals)", "own_goals"),
    "touches":           ("SUM(pm.touches)", "touches"),
    "minutes":            ("SUM(pm.minutes)", None),
    "appearances":        ("COUNT(*)", None),
    "starts":             ("SUM(pm.started = 1)", None),
    "average_rating":     ("ROUND(AVG(pm.rating), 2)", "rating"),
}
RATING_MIN_MINUTES = 900

MATCH_COLUMNS = """m.fixture_id, m.season, m.round,
    strftime('%Y-%m-%d %H:%M', m.kickoff_utc, '+3 hours') AS kickoff_turkey,
    COALESCE(h.name, 'team ' || m.home_team_id) AS home_team, m.home_goals, m.away_goals,
    COALESCE(a.name, 'team ' || m.away_team_id) AS away_team"""
MATCH_JOINS = """FROM matches m
    LEFT JOIN teams h ON h.team_id = m.home_team_id
    LEFT JOIN teams a ON a.team_id = m.away_team_id"""
# Statistics count only appearances in finished matches.
APPEARANCES = "JOIN matches m ON m.fixture_id = pm.fixture_id AND m.finished = 1 WHERE pm.minutes > 0"


class ToolError(Exception):
    """A problem with what the AI asked for. Its message goes back to the AI."""

@dataclass
class Table:
    title: str
    rows: list[dict]


@dataclass
class Answer:
    tables: list[Table]
    notes: list[str] = field(default_factory=list)

    def as_text(self) -> str:
        """Each table as CSV under a "## title" line, then the notes."""
        parts = []
        for table in self.tables:
            parts.append(f"## {table.title}")
            if not table.rows:
                parts.append("(no rows)")
                continue
            buffer = io.StringIO()
            writer = csv.DictWriter(buffer, fieldnames=list(table.rows[0]), lineterminator="\n")
            writer.writeheader()
            writer.writerows({key: tidy(value) for key, value in row.items()} for row in table.rows)
            parts.append(buffer.getvalue().rstrip("\n"))
        parts += [f"Note: {note}" for note in self.notes]
        return "\n".join(parts)


def tidy(value):
    """90.0 -> 90, 7.2345 -> 7.23, None -> blank."""
    if isinstance(value, float):
        return int(value) if value.is_integer() else round(value, 2)
    return value

def open_database(path: Path = DATABASE) -> sqlite3.Connection:
    """The chatbot database, read-only."""
    if not Path(path).is_file():
        raise SystemExit(f"{path} is missing. Build it first: python src/chat/build_chat_db.py")
    db = sqlite3.connect(f"{Path(path).resolve().as_uri()}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    return db


def rows(db, sql, params=()) -> list[dict]:
    return [dict(row) for row in db.execute(sql, params)]


def seasons(db) -> list[str]:
    return [row[0] for row in db.execute("SELECT season FROM seasons ORDER BY season")]


def season_arg(db, value, *, default_latest=True) -> str | None:
    """A season the database has, from 2023/2024, 2023-2024 or 2023-24.

    No season means the latest one, or None when default_latest is False.
    """
    available = seasons(db)
    if value is None or str(value).strip() == "":
        return available[-1] if default_latest and available else None
    text = str(value).strip()
    short = re.fullmatch(r"(\d{4})[-/](\d{2})", text)
    if short:
        text = f"{short[1]}/{short[1][:2]}{short[2]}"
    try:
        season = season_label(text)
    except SeasonError:
        raise ToolError(f"'{value}' is not a season. Use the form 2023/2024.") from None
    if season not in available:
        raise ToolError(f"There is no data for {season}. Seasons available: {', '.join(available)}.")
    return season


def team_name(db, team_id: int) -> str:
    row = db.execute("SELECT name FROM teams WHERE team_id = ?", (team_id,)).fetchone()
    if row is None:
        raise ToolError(f"No team has team_id {team_id}. Use find_team to get the id.")
    return row[0]


def player_name(db, player_id: int) -> str:
    row = db.execute("SELECT name FROM players WHERE player_id = ?", (player_id,)).fetchone()
    if row is None:
        raise ToolError(f"No player has player_id {player_id}. Use find_player to get the id.")
    return row[0]


def name_filter(text: str) -> tuple[str, list[str], str]:
    """SQL that matches every word of a name, its parameters, and the folded name."""
    folded = search_name(text)
    if not folded:
        raise ToolError("Give a name to search for.")
    words = [word.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") for word in folded.split()]
    sql = " AND ".join("search_name LIKE ? ESCAPE '\\'" for _ in words)
    return sql, [f"%{word}%" for word in words], folded


def ambiguity_note(found: list[dict], folded: str, what: str) -> list[str]:
    if not found:
        return [f"No {what} matches '{folded}'. Try another spelling or part of the name."]
    exact = [row for row in found if search_name(row["name"]) == folded]
    if len(found) > 1 and len(exact) != 1:
        return [f"Several {what}s match. If it is not clear which one the user means, ask them."]
    return []


def minute_text(minute, extra) -> str:
    if minute is None:
        return ""
    return f"{minute}+{extra}" if extra else str(minute)


def unfinished_count(db, season: str) -> int:
    """Matches of the season still to be played (called-off matches never will be)."""
    marks = ", ".join("?" for _ in CALLED_OFF_STATES)
    return db.execute(f"SELECT COUNT(*) FROM matches WHERE season = ? AND finished = 0 "
                      f"AND COALESCE(state, '') NOT IN ({marks})", (season, *sorted(CALLED_OFF_STATES))).fetchone()[0]


def record(team_id: int, matches: list[dict]) -> dict:
    """Played, won, drawn, lost, goals and points from one team's point of view."""
    totals = dict(played=0, won=0, drawn=0, lost=0, goals_for=0, goals_against=0, points=0)
    for match in matches:
        home = match["home_team_id"] == team_id
        mine, theirs = ((match["home_goals"], match["away_goals"]) if home
                        else (match["away_goals"], match["home_goals"]))
        if mine is None or theirs is None:
            continue
        totals["played"] += 1
        totals["goals_for"] += mine
        totals["goals_against"] += theirs
        outcome = "won" if mine > theirs else "drawn" if mine == theirs else "lost"
        totals[outcome] += 1
        totals["points"] += {"won": 3, "drawn": 1, "lost": 0}[outcome]
    return totals

def list_seasons(db) -> Answer:
    table = rows(db, f"""
        SELECT s.season, COUNT(m.fixture_id) AS matches, COALESCE(SUM(m.finished), 0) AS finished,
               date(MIN(m.kickoff_utc)) AS first_match, date(MAX(m.kickoff_utc)) AS last_match
        FROM seasons s LEFT JOIN matches m ON m.season = s.season
        GROUP BY s.season ORDER BY s.season""")
    coverage = {row["season"]: row["percent"] for row in rows(db, f"""
        SELECT pm.season, ROUND(100.0 * SUM(pm.expected_goals IS NOT NULL) / COUNT(*)) AS percent
        FROM player_matches pm {APPEARANCES} GROUP BY pm.season""")}
    for row in table:
        row["expected_goals_recorded_percent"] = coverage.get(row["season"])
    return Answer([Table("Seasons", table)],
                  ["expected_goals_recorded_percent: share of appearances with expected goals (xG) recorded."])


def find_team(db, name: str) -> Answer:
    sql, params, folded = name_filter(name)
    found = rows(db, f"""
        SELECT t.team_id, t.name, t.short_code,
               MIN(m.season) AS first_season, MAX(m.season) AS last_season
        FROM teams t LEFT JOIN matches m ON t.team_id IN (m.home_team_id, m.away_team_id)
        WHERE ({sql}) OR lower(t.short_code) = ?
        GROUP BY t.team_id ORDER BY (t.search_name = ?) DESC, t.name LIMIT 10""",
                 (*params, folded, folded))
    return Answer([Table("Teams", found)], ambiguity_note(found, folded, "team"))


def find_player(db, name: str, season: str | None = None) -> Answer:
    sql, params, folded = name_filter(name)
    season = season_arg(db, season, default_latest=False)
    in_season = ("AND EXISTS (SELECT 1 FROM player_matches x WHERE x.player_id = p.player_id "
                 "AND x.season = ? AND x.minutes > 0)") if season else ""
    found = rows(db, f"""
        SELECT p.player_id, p.name,
               MIN(pm.season) AS first_season, MAX(pm.season) AS last_season,
               COUNT(pm.player_id) AS appearances, SUM(pm.goals) AS goals
        FROM players p
        LEFT JOIN player_matches pm ON pm.player_id = p.player_id AND pm.minutes > 0
        WHERE ({sql}) {in_season}
        GROUP BY p.player_id ORDER BY (p.search_name = ?) DESC, appearances DESC, p.name LIMIT 10""",
                 (*params, *([season] if season else []), folded))
    for row in found:
        latest = db.execute("""
            SELECT t.name FROM player_matches pm JOIN matches m ON m.fixture_id = pm.fixture_id
            LEFT JOIN teams t ON t.team_id = pm.team_id
            WHERE pm.player_id = ? AND pm.minutes > 0 ORDER BY m.kickoff_utc DESC LIMIT 1""",
                            (row["player_id"],)).fetchone()
        row["latest_team"] = latest[0] if latest else None
    return Answer([Table("Players", found)], ambiguity_note(found, folded, "player"))

def find_matches(db, team_id: int, opponent_id: int | None = None, season: str | None = None,
                 venue: str = "any", limit: int = 10) -> Answer:
    team = team_name(db, team_id)
    where, params = ["m.finished = 1", "? IN (m.home_team_id, m.away_team_id)"], [team_id]
    if opponent_id is not None:
        team_name(db, opponent_id)
        where.append("? IN (m.home_team_id, m.away_team_id)")
        params.append(opponent_id)
    season = season_arg(db, season, default_latest=False)
    if season:
        where.append("m.season = ?")
        params.append(season)
    if venue == "home":
        where.append("m.home_team_id = ?")
        params.append(team_id)
    elif venue == "away":
        where.append("m.away_team_id = ?")
        params.append(team_id)
    found = rows(db, f"SELECT {MATCH_COLUMNS}, m.home_team_id, m.away_team_id {MATCH_JOINS} "
                     f"WHERE {' AND '.join(where)} ORDER BY m.kickoff_utc DESC", params)
    summary = {"team": team, **record(team_id, found)}
    summary.pop("points")
    for row in found:
        home = row.pop("home_team_id") == team_id
        row.pop("away_team_id")
        mine, theirs = (row["home_goals"], row["away_goals"]) if home else (row["away_goals"], row["home_goals"])
        row["result_for_team"] = ("" if mine is None or theirs is None
                                  else "win" if mine > theirs else "draw" if mine == theirs else "loss")
    notes = ["Only finished matches. kickoff_turkey is Turkish time."]
    if len(found) > limit:
        notes.append(f"Showing the {limit} most recent of {len(found)} matches; the summary counts all of them.")
    return Answer([Table("Summary", [summary]), Table("Matches", found[:limit])], notes)

def match_details(db, fixture_id: int) -> Answer:
    match = rows(db, f"SELECT {MATCH_COLUMNS}, m.state, m.finished, m.home_team_id {MATCH_JOINS} "
                     "WHERE m.fixture_id = ?", (fixture_id,))
    if not match:
        raise ToolError(f"No match has fixture_id {fixture_id}. Use find_matches to get the id.")
    home_team_id = match[0].pop("home_team_id")
    kinds = {"GOAL": "goal", "PENALTY": "penalty goal", "OWNGOAL": "own goal", "MISSED_PENALTY": "missed penalty",
             "YELLOWCARD": "yellow card", "REDCARD": "red card", "YELLOWREDCARD": "second yellow (red card)"}
    events = rows(db, """
        SELECT e.type, e.minute, e.extra_minute, t.name AS team, p.name AS player,
               CASE WHEN e.type = 'GOAL' THEN r.name END AS assist
        FROM events e
        LEFT JOIN teams t ON t.team_id = e.team_id
        LEFT JOIN players p ON p.player_id = e.player_id
        LEFT JOIN players r ON r.player_id = e.related_player_id
        WHERE e.fixture_id = ? AND e.type != 'SUBSTITUTION'
        ORDER BY e.minute, COALESCE(e.extra_minute, 0), e.event_id""", (fixture_id,))
    goals, cards = [], []
    for event in events:
        row = {"minute": minute_text(event.pop("minute"), event.pop("extra_minute")),
               "kind": kinds[event.pop("type")], **event}
        if row["kind"] in {"goal", "penalty goal", "own goal"}:
            goals.append(row)
        else:
            row.pop("assist")
            cards.append(row)
    players = rows(db, f"""
        SELECT t.name AS team, p.name AS player, pm.position, pm.started, pm.minutes,
               pm.goals, pm.assists, pm.rating
        FROM player_matches pm
        LEFT JOIN teams t ON t.team_id = pm.team_id
        LEFT JOIN players p ON p.player_id = pm.player_id
        WHERE pm.fixture_id = ? AND pm.minutes > 0
        ORDER BY pm.team_id != ?, pm.started DESC, {POSITION_ORDER}, p.name""", (fixture_id, home_team_id))
    notes = [] if match[0]["finished"] else ["This match has not finished, so it has no result yet."]
    return Answer([Table("Match", match), Table("Goals", goals), Table("Cards and missed penalties", cards),
                   Table("Players who played", players)], notes)

def player_season_stats(db, player_id: int, season: str | None = None, last_matches: int = 0) -> Answer:
    player = player_name(db, player_id)
    season = season_arg(db, season, default_latest=False)
    where, params = "pm.player_id = ?" + (" AND pm.season = ?" if season else ""), [player_id] + ([season] if season else [])
    totals = rows(db, f"""
        SELECT pm.season, GROUP_CONCAT(DISTINCT t.name) AS teams,
               COUNT(*) AS appearances, SUM(pm.started = 1) AS starts, SUM(pm.minutes) AS minutes,
               SUM(pm.goals) AS goals, SUM(pm.assists) AS assists,
               ROUND(SUM(pm.expected_goals), 2) AS expected_goals,
               SUM(pm.shots_total) AS shots, SUM(pm.shots_on_target) AS shots_on_target,
               SUM(pm.key_passes) AS key_passes, SUM(pm.yellowcards) AS yellow_cards,
               SUM(pm.redcards) + SUM(pm.yellowred_cards) AS red_cards,
               ROUND(AVG(pm.rating), 2) AS average_rating,
               SUM(pm.expected_goals IS NOT NULL) AS xg_recorded
        FROM player_matches pm LEFT JOIN teams t ON t.team_id = pm.team_id
        {APPEARANCES} AND {where}
        GROUP BY pm.season ORDER BY pm.season""", params)
    notes = []
    for row in totals:
        recorded = row.pop("xg_recorded")
        if recorded < row["appearances"]:
            notes.append(f"{row['season']}: expected goals recorded in only {recorded} of "
                         f"{row['appearances']} appearances.")
    if not totals:
        notes.append(f"{player} has no appearances" + (f" in {season}." if season else " in the database."))
    tables = [Table(f"{player}: season totals", totals)]
    if last_matches:
        recent = rows(db, f"""
            SELECT pm.season, strftime('%Y-%m-%d', m.kickoff_utc, '+3 hours') AS date,
                   CASE WHEN pm.team_id = m.home_team_id THEN 'home' ELSE 'away' END AS venue,
                   COALESCE(CASE WHEN pm.team_id = m.home_team_id THEN a.name ELSE h.name END, '') AS opponent,
                   m.home_goals, m.away_goals, pm.minutes, pm.goals, pm.assists, pm.rating, m.fixture_id
            FROM player_matches pm
            JOIN matches m ON m.fixture_id = pm.fixture_id AND m.finished = 1
            LEFT JOIN teams h ON h.team_id = m.home_team_id
            LEFT JOIN teams a ON a.team_id = m.away_team_id
            WHERE pm.minutes > 0 AND {where}
            ORDER BY m.kickoff_utc DESC LIMIT ?""", (*params, last_matches))
        tables.append(Table(f"{player}: last {last_matches} matches", recent))
    return Answer(tables, notes)

def matchweek(db, season: str, week: str) -> dict:
    called_off = sorted(CALLED_OFF_STATES)
    placeholders = ", ".join("?" for _ in called_off)
    rounds = rows(db, f"""
        SELECT m.round AS week, MIN(m.kickoff_utc) AS first_kickoff,
               MAX(m.kickoff_utc >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) AS upcoming,
               SUM(m.finished) AS finished,
               SUM(COALESCE(m.state, '') NOT IN ({placeholders})) AS fixtures
        FROM matches m
        WHERE m.season = ? AND m.round IS NOT NULL
        GROUP BY m.round
        ORDER BY first_kickoff IS NULL, first_kickoff, MIN(m.fixture_id)
        """, (*called_off, season))
    if not rounds:
        raise ToolError(f"No matchweek schedule is available for {season}.")
    if week not in {"current", "previous"}:
        for row in rounds:
            if row["week"] == week:
                return row
        raise ToolError(f"Matchweek {week} is not available in {season}.")

    # Older caches have the fixtures but have yet to save Sportmonks' marker.
    marker = None
    if db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'current_rounds'").fetchone():
        marked = db.execute("SELECT round FROM current_rounds WHERE season = ?", (season,)).fetchone()
        marker = marked[0] if marked else None
    current = next((index for index, row in enumerate(rounds) if row["week"] == marker), None)
    if current is None:
        current = next((index for index, row in enumerate(rounds) if row["upcoming"]), len(rounds) - 1)
    if week == "current":
        return rounds[current]
    if current == 0:
        raise ToolError(f"There is no previous matchweek in {season}.")
    return rounds[current - 1]


def leaderboard(db, stat: str, season: str | None = None, position: str | None = None,
                team_id: int | None = None, min_minutes: int | None = None, limit: int = 10,
                week: str | None = None, player_id: int | None = None) -> Answer:
    expression, recorded_column = STATS[stat]
    season = season_arg(db, season)
    notes = []
    selected_week = matchweek(db, season, week) if week is not None else None
    scope = season
    if selected_week:
        scope = f"{season} matchweek {selected_week['week']}"
        notes.append(f"{selected_week['finished']} of {selected_week['fixtures']} "
                     "scheduled matches in this matchweek are finished in the database.")
    if min_minutes is None:
        min_minutes = RATING_MIN_MINUTES if stat == "average_rating" and not selected_week and player_id is None else 0
        if min_minutes:
            notes.append(f"Only players with at least {min_minutes} minutes are ranked.")
    where, params = ["pm.season = ?"], [season]
    if selected_week:
        where.append("m.round = ?")
        params.append(selected_week["week"])
    if player_id is not None:
        player_name(db, player_id)
        where.append("pm.player_id = ?")
        params.append(player_id)
    if position:
        where.append("pm.position = ?")
        params.append(position)
    if team_id is not None:
        where.append("pm.team_id = ?")
        params.append(team_id)
        notes.append(f"Only appearances for {team_name(db, team_id)}.")
    minimum_stat = f"AND ({expression}) > 0" if selected_week and player_id is None else ""
    found = rows(db, f"""
        SELECT pm.player_id, p.name AS player, GROUP_CONCAT(DISTINCT t.name) AS teams,
               {expression} AS {stat}, COUNT(*) AS appearances, SUM(pm.minutes) AS minutes
        FROM player_matches pm
        LEFT JOIN players p ON p.player_id = pm.player_id
        LEFT JOIN teams t ON t.team_id = pm.team_id
        {APPEARANCES} AND {' AND '.join(where)}
        GROUP BY pm.player_id
        HAVING ({expression}) IS NOT NULL AND SUM(pm.minutes) >= ? {minimum_stat}
        ORDER BY {stat} DESC, minutes ASC, player, pm.player_id LIMIT ?""", (*params, min_minutes, limit + 1))
    if len(found) > limit:
        notes.append("More players qualify. Only the requested number of rows is shown.")
        found = found[:limit]
    if selected_week:
        coverage_column = "pm." + recorded_column if recorded_column else "pm.player_id"
        coverage = db.execute(f"""
            SELECT COUNT(*) AS appearances, COUNT({coverage_column}) AS recorded,
                   COUNT(DISTINCT CASE WHEN {coverage_column} IS NOT NULL THEN pm.fixture_id END) AS matches
            FROM player_matches pm {APPEARANCES} AND {' AND '.join(where)}""", params).fetchone()
        if not coverage["recorded"]:
            notes.append(f"No {stat} data is recorded for this selection.")
        elif coverage["recorded"] < coverage["appearances"] or (
            player_id is None and team_id is None and position is None
            and coverage["matches"] < selected_week["finished"]
        ):
            notes.append(f"{stat} coverage is incomplete for this selection. Report recorded totals only.")
    elif recorded_column:
        share = db.execute(f"SELECT 100.0 * SUM(pm.{recorded_column} IS NOT NULL) / COUNT(*) "
                           f"FROM player_matches pm {APPEARANCES} AND pm.season = ?", (season,)).fetchone()[0]
        if share is not None and share < 90:
            notes.append(f"{stat} is recorded in only {round(share)}% of appearances in {season}, "
                         "so these totals undercount.")
    if not selected_week and unfinished_count(db, season):
        notes.append(f"{season} is still being played; these are the totals so far.")
    position_text = f" {position.lower()}s" if position else ""
    return Answer([Table(f"{scope}{position_text} by {stat}", found)], notes)

def standings(db, season: str | None = None) -> Answer:
    season = season_arg(db, season)
    table = rows(db, """
        SELECT s.stage_id, s.group_id, s.position, COALESCE(t.name, 'team ' || s.team_id) AS team, s.team_id,
               s.played, s.won, s.drawn, s.lost, s.goals_for, s.goals_against,
               s.goals_for - s.goals_against AS goal_difference, s.points
        FROM standings s LEFT JOIN teams t ON t.team_id = s.team_id
        WHERE s.season = ? ORDER BY s.stage_id, s.group_id, s.position""", (season,))
    if len({(row["stage_id"], row["group_id"]) for row in table}) <= 1:
        for row in table:
            del row["stage_id"], row["group_id"]
    notes = []
    if unfinished_count(db, season):
        notes.append(f"{season} is still being played; this is the table as last saved.")
    return Answer([Table(f"{season} league table", table)], notes)


def team_season_stats(db, team_id: int, season: str | None = None) -> Answer:
    team = team_name(db, team_id)
    season = season_arg(db, season)
    matches = rows(db, "SELECT home_team_id, away_team_id, home_goals, away_goals FROM matches "
                       "WHERE season = ? AND finished = 1 AND ? IN (home_team_id, away_team_id)", (season, team_id))
    records = []
    for venue, chosen in (("overall", matches),
                          ("home", [m for m in matches if m["home_team_id"] == team_id]),
                          ("away", [m for m in matches if m["away_team_id"] == team_id])):
        records.append({"venue": venue, **record(team_id, chosen)})
    position = db.execute("SELECT position, points FROM standings WHERE season = ? AND team_id = ? "
                          "ORDER BY stage_id LIMIT 1", (season, team_id)).fetchone()
    scorers = rows(db, f"""
        SELECT pm.player_id, p.name AS player, SUM(pm.goals) AS goals, SUM(pm.assists) AS assists,
               COUNT(*) AS appearances, SUM(pm.minutes) AS minutes
        FROM player_matches pm LEFT JOIN players p ON p.player_id = pm.player_id
        {APPEARANCES} AND pm.team_id = ? AND pm.season = ?
        GROUP BY pm.player_id ORDER BY goals DESC, assists DESC, minutes DESC LIMIT 5""", (team_id, season))
    notes = []
    if position:
        notes.append(f"League position in the saved table: {position['position']} with {position['points']} points.")
    if unfinished_count(db, season):
        notes.append(f"{season} is still being played; these are the numbers so far.")
    return Answer([Table(f"{team} {season} record", records), Table(f"{team} {season} top scorers", scorers)], notes)

TEAM_SCORE_STATS = {
    "goals": "s.goals_for",
    "goals_conceded": "s.goals_against",
    "clean_sheets": "(s.goals_against = 0)",
}
TEAM_RANK_STATS = (*TEAM_STATS, *TEAM_SCORE_STATS)
DASHBOARD_SECTIONS = ("overview", "metrics", "lineups", "events", "pressure", "season_comparison")


def dashboard_available(db):
    return db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dashboard_matches'").fetchone()


def matchweek_fixtures(db, season: str | None = None, week: str = "current", team_id: int | None = None) -> Answer:
    season = season_arg(db, season)
    selected = matchweek(db, season, week)
    if team_id is not None:
        team_name(db, team_id)
    fixtures = rows(db, f"""
        SELECT {MATCH_COLUMNS}, m.state, m.finished {MATCH_JOINS}
        WHERE m.season = ? AND m.round = ? AND (? IS NULL OR ? IN (m.home_team_id, m.away_team_id))
        ORDER BY m.kickoff_utc IS NULL, m.kickoff_utc, m.fixture_id
        """, (season, selected["week"], team_id, team_id))
    return Answer([Table(f"{season} matchweek {selected['week']} fixtures", fixtures)],
                  ["Kickoff times are local to Turkey. Blank scores are unavailable."])


def team_leaderboard(db, stat: str, season: str | None = None, week: str | None = None,
                     team_id: int | None = None, limit: int = 20) -> Answer:
    if stat not in TEAM_RANK_STATS:
        raise ToolError(f"No team statistic called {stat}.")
    season = season_arg(db, season)
    selected = matchweek(db, season, week) if week is not None else None
    round_name = selected["week"] if selected else None
    scope = f"{season} matchweek {round_name}" if selected else season
    title = f"{scope} teams by {stat}"
    if team_id is not None:
        team_name(db, team_id)
    notes = []
    if selected:
        notes.append(f"{selected['finished']} of {selected['fixtures']} scheduled matches are finished.")
        if not selected["finished"]:
            return Answer([Table(title, [])], notes)
    value = TEAM_SCORE_STATS.get(stat, f"d.{stat}")
    join = ""
    if stat not in TEAM_SCORE_STATS:
        if not dashboard_available(db):
            return Answer([Table(title, [])], notes + ["The saved dashboard stats have not been loaded."])
        join = "LEFT JOIN dashboard_team_stats d ON d.fixture_id = s.fixture_id AND d.team_id = s.team_id"
    aggregate = "AVG" if stat in TEAM_PERCENTAGES else "SUM"
    found = rows(db, f"""
        WITH sides AS (
            SELECT m.fixture_id,
                   CASE s.side WHEN 0 THEN m.home_team_id ELSE m.away_team_id END AS team_id,
                   CASE s.side WHEN 0 THEN m.home_goals ELSE m.away_goals END AS goals_for,
                   CASE s.side WHEN 0 THEN m.away_goals ELSE m.home_goals END AS goals_against
            FROM matches m CROSS JOIN (SELECT 0 AS side UNION ALL SELECT 1) s
            WHERE m.finished = 1 AND m.season = ? AND (? IS NULL OR m.round = ?)
        )
        SELECT s.team_id, COALESCE(t.name, 'team ' || s.team_id) AS team,
               ROUND({aggregate}({value}), 2) AS value,
               COUNT({value}) AS matches_recorded, COUNT(*) AS matches_played
        FROM sides s LEFT JOIN teams t ON t.team_id = s.team_id
        {join}
        WHERE (? IS NULL OR s.team_id = ?)
        GROUP BY s.team_id, t.name
        ORDER BY value IS NULL, value DESC, team, s.team_id
        """, (season, round_name, round_name, team_id, team_id))
    recorded = sum(row["matches_recorded"] for row in found)
    expected = sum(row["matches_played"] for row in found)
    known = [row for row in found if row["value"] is not None]
    if not expected:
        notes.append("No finished matches are available for this selection.")
    elif not recorded:
        notes.append(f"No {stat} values were recorded for the {expected} team-match appearances.")
    elif recorded < expected:
        notes.append(f"{stat} is recorded for {recorded} of {expected} team-match appearances. "
                     "These are recorded values only. A leader across the full selection cannot be confirmed.")
    if stat in TEAM_PERCENTAGES:
        notes.append("Values are average match percentages over recorded matches.")
    if len(known) > limit:
        total = len(known)
        cutoff = known[limit - 1]["value"]
        known = [row for row in known if row["value"] >= cutoff]
        if len(known) < total:
            notes.append(f"Showing the leading {limit} ranked teams, including ties at the cutoff.")
    return Answer([Table(title, known)], notes)


def dashboard_comparison(db, fixture) -> list[dict]:
    history = rows(db, """
        SELECT d.* FROM dashboard_team_stats d JOIN matches m ON m.fixture_id = d.fixture_id
        WHERE m.season = ? AND m.finished = 1 AND d.team_id IN (?, ?)""",
        (fixture["season"], fixture["home_team_id"], fixture["away_team_id"]))
    found = []
    for side in ("home", "away"):
        own = [row for row in history if row["team_id"] == fixture[f"{side}_team_id"]]
        selected = next((row for row in own if row["fixture_id"] == fixture["fixture_id"]), {})
        for stat in SEASON_COMPARISONS:
            value = selected.get(stat)
            known = [row[stat] for row in own if row[stat] is not None]
            others = [row[stat] for row in own if row["fixture_id"] != fixture["fixture_id"] and row[stat] is not None]
            average = sum(others) / len(others) if others else None
            below = sum(other < value for other in known) if value is not None else 0
            tied = known.count(value)
            percentile = (below + (tied - 1) / 2) * 100 / (len(known) - 1) if value is not None and len(known) > 1 else None
            found.append(dict(team=fixture[f"{side}_team"], stat=stat, match_value=value, season_matches=len(known),
                              season_low=min(known, default=None), season_high=max(known, default=None),
                              season_percentile=percentile, other_matches=len(others), other_match_average=average,
                              change_percent=(value - average) / average * 100 if value is not None and average else None))
    return found


def match_dashboard(db, fixture_id: int, section: str = "overview", minute: str | None = None) -> Answer:
    matches = rows(db, f"""
        SELECT {MATCH_COLUMNS}, m.state, m.finished, m.home_team_id, m.away_team_id {MATCH_JOINS}
        WHERE m.fixture_id = ?
        """, (fixture_id,))
    if not matches:
        raise ToolError(f"No saved match has fixture_id {fixture_id}. Use matchweek_fixtures or find_matches.")
    fixture = matches[0]
    home, away = fixture["home_team"], fixture["away_team"]
    week = f" matchweek {fixture['round']}" if fixture["round"] else ""
    title = f"{home} vs {away}, {fixture['season']}{week} — {section}"
    if not dashboard_available(db):
        return Answer([Table(title, [fixture] if section == "overview" else [])],
                      ["The saved dashboard stats have not been loaded."])
    notes = []
    if not fixture["finished"]:
        notes.append("The match is not recorded as finished. Live and replay values are unavailable to this tool.")

    if section == "overview":
        metadata = rows(db, """SELECT venue, city, referee, temperature_c, weather, home_formation, away_formation,
                                  home_half_goals, away_half_goals FROM dashboard_matches WHERE fixture_id = ?""",
                        (fixture_id,))
        found = [{**fixture, **(metadata[0] if metadata else {})}]
        notes.append("Kickoff time is local to Turkey.")
    elif section == "metrics":
        saved = {row["team_id"]: row for row in rows(db, "SELECT * FROM dashboard_team_stats WHERE fixture_id = ?", (fixture_id,))}
        found = [dict(stat=stat, home=saved.get(fixture["home_team_id"], {}).get(stat),
                      away=saved.get(fixture["away_team_id"], {}).get(stat)) for stat in TEAM_STATS] if saved else []
        notes.append(f"Home: {home}. Away: {away}. Possession, pass accuracy and long-pass share are percentages.")
    elif section == "lineups":
        found = rows(db, """
            SELECT COALESCE(t.name, 'team ' || l.team_id) AS team, COALESCE(p.name, l.player) AS player,
                   l.started, l.position, l.formation_slot, l.shirt, l.minutes, l.rating
            FROM dashboard_lineups l LEFT JOIN teams t ON t.team_id = l.team_id
            LEFT JOIN players p ON p.player_id = l.player_id
            WHERE l.fixture_id = ?
            ORDER BY l.team_id != ?, l.started DESC, l.formation_slot, player, l.player_id""", (fixture_id, fixture["home_team_id"]))
        notes.append("started=1 means a starter and started=0 a substitute. Use the events section for substitutions.")
    elif section == "events":
        found = rows(db, """
            SELECT kind, minute, extra_minute, t.name AS team, COALESCE(p.name, e.player) AS player,
                   COALESCE(r.name, e.related_player) AS related_player, info, score, e.rescinded
            FROM dashboard_events e LEFT JOIN teams t ON t.team_id = e.team_id
            LEFT JOIN players p ON p.player_id = e.player_id
            LEFT JOIN players r ON r.player_id = e.related_player_id
            WHERE e.fixture_id = ?
            ORDER BY minute, COALESCE(extra_minute, 0), sort_order, event_id""", (fixture_id,))
        notes.append("Rescinded events are kept as recorded and do not count as final outcomes.")
    elif section == "pressure":
        if minute is not None:
            found = rows(db, """SELECT clock, home_pressure, away_pressure FROM dashboard_pressure
                                 WHERE fixture_id = ? AND clock = ?""", (fixture_id, minute.rstrip("'’")))
        else:
            phases = rows(db, """
                SELECT phase, COUNT(*) AS samples,
                   ROUND(100 * SUM(home_pressure) / NULLIF(SUM(home_pressure + away_pressure), 0)) AS home_share
            FROM dashboard_pressure WHERE fixture_id = ? GROUP BY phase ORDER BY phase""", (fixture_id,))
            found = [dict(phase=PHASES[row["phase"]], recorded_minutes=row["samples"], home_share=row["home_share"],
                          away_share=100 - row["home_share"] if row["home_share"] is not None else None) for row in phases]
        notes.append(f"Home: {home}. Away: {away}. Phase shares use the recorded pressure index, not ball possession.")
    elif section == "season_comparison":
        found = dashboard_comparison(db, fixture)
        notes.append("Season ranges include known finished matches. Averages and percentage changes exclude this fixture.")
    else:
        raise ToolError(f"No dashboard section called {section}.")
    if not found:
        notes.append("No saved data is available for this section.")
    return Answer([Table(title, found)], notes)


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict
    function: Callable[..., Answer]


def schema(properties: dict, required=()) -> dict:
    return {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False}


SEASON = {"type": "string", "description": "Season such as 2023/2024."}
SEASON_LATEST = {"type": "string", "description": "Season such as 2023/2024. Leave out for the latest season."}
WEEK = {"type": "string", "description": "Matchweek: 'current', 'previous', or a number as text, such as '11'."}
TEAM_FILTER = {"type": "integer", "description": "Optional club ID from find_team."}

TOOLS = [
    Tool("list_seasons",
         "List the seasons in the database, how many matches each has, and how well expected goals (xG) "
         "were recorded. Use it when the user asks which seasons you know about.",
         schema({}), list_seasons),
    Tool("find_team",
         "Find a club's team_id from its name or short code (for example 'fener', 'Beşiktaş', 'GS'). "
         "Call this before any tool that needs a team_id.",
         schema({"name": {"type": "string", "description": "Club name, part of it, or short code."}}, ["name"]),
         find_team),
    Tool("find_player",
         "Find a player's player_id from their name, with the seasons they played and their latest club. "
         "Call this before any tool that needs a player_id. If several players match, ask the user which one.",
         schema({"name": {"type": "string", "description": "Player name or part of it."},
                 "season": {**SEASON, "description": "Optional: only players who played in this season."}},
                ["name"]),
         find_player),
    Tool("find_matches",
         "Finished matches of one team, newest first, with a win/draw/loss summary. Add opponent_id for "
         "head-to-head results, season to limit to one season, and venue for home or away games only.",
         schema({"team_id": {"type": "integer"},
                 "opponent_id": {"type": "integer", "description": "Optional second team, for head-to-head."},
                 "season": {**SEASON, "description": "Optional. Leave out for every season."},
                 "venue": {"type": "string", "enum": ["any", "home", "away"]},
                 "limit": {"type": "integer", "minimum": 1, "maximum": 50,
                           "description": "How many matches to list (default 10)."}},
                ["team_id"]),
         find_matches),
    Tool("match_details",
         "Everything about one match: score, goals with scorers and assists, cards, and the players "
         "who played with their minutes and ratings.",
         schema({"fixture_id": {"type": "integer"}}, ["fixture_id"]),
         match_details),
    Tool("player_season_stats",
         "A player's totals per season: appearances, minutes, goals, assists, xG, shots, cards and average "
         "rating. Set last_matches to also list their most recent matches.",
         schema({"player_id": {"type": "integer"},
                 "season": {**SEASON, "description": "Optional. Leave out for every season."},
                 "last_matches": {"type": "integer", "minimum": 0, "maximum": 20,
                                  "description": "How many recent matches to list (default 0)."}},
                ["player_id"]),
         player_season_stats),
    Tool("leaderboard",
         "Rank players by a recorded stat across a season or matchweek. Can be limited to one player, position "
         "or team. Use week for matchweek questions. Use limit 100 to list players with a positive count, "
         "or a shorter limit for a ranking.",
         schema({"stat": {"type": "string", "enum": list(STATS)},
                 "season": SEASON_LATEST,
                 "week": {"type": "string", "description": "Current matchweek ('current'), previous ('previous'), "
                          "or a round number like '8'. Omit for the whole season."},
                 "player_id": {"type": "integer", "description": "Optional. Find the player in the requested season first."},
                 "position": {"type": "string", "enum": POSITIONS},
                 "team_id": {"type": "integer", "description": "Optional: only appearances for this team."},
                 "min_minutes": {"type": "integer", "minimum": 0,
                                 "description": f"Optional minimum minutes played (default 0; {RATING_MIN_MINUTES} "
                                                "for full-season average_rating rankings)."},
                 "limit": {"type": "integer", "minimum": 1, "maximum": 100,
                           "description": "How many players to list (default 10)."}},
                ["stat"]),
         leaderboard),
    Tool("standings",
         "The league table for a season: position, played, won, drawn, lost, goals and points.",
         schema({"season": SEASON_LATEST}),
         standings),
    Tool("team_season_stats",
         "One club's season: overall, home and away record, league position, and its top scorers.",
         schema({"team_id": {"type": "integer"}, "season": SEASON_LATEST}, ["team_id"]),
         team_season_stats),
    Tool("matchweek_fixtures",
         "List saved fixtures, scores, kickoff times and statuses in a matchweek, including upcoming games. "
         "Use to find a fixture ID before match_dashboard. Defaults to the current matchweek.",
         schema({"season": SEASON_LATEST, "week": WEEK, "team_id": TEAM_FILTER}),
         matchweek_fixtures),
    Tool("team_leaderboard",
         "Rank clubs directly by a team stat across a matchweek or season, including shots, xG, passing, "
         "possession, cards, fouls, duels, corners and set plays. Use for which team or one club's total. "
         "Omit week for the full season. Coverage notes distinguish a confirmed leader from partial data.",
         schema({"stat": {"type": "string", "enum": list(TEAM_RANK_STATS)}, "season": SEASON_LATEST,
                 "week": WEEK, "team_id": TEAM_FILTER, "limit": {"type": "integer", "minimum": 1, "maximum": 30}},
                ["stat"]),
         team_leaderboard),
    Tool("match_dashboard",
         "Saved Ana Sayfa details for a fixture: overview (score, halftime, referee, venue, weather, formations), "
         "metrics (team stats), lineups, events, pressure (15-minute shares or a displayed minute such as '45+2'), "
         "or season_comparison (season ranges, passing style, and changes against the usual average).",
         schema({"fixture_id": {"type": "integer"}, "section": {"type": "string", "enum": list(DASHBOARD_SECTIONS)},
                 "minute": {"type": "string", "description": "Optional displayed match clock for pressure."}},
                ["fixture_id"]),
         match_dashboard),
]
TOOLS_BY_NAME = {tool.name: tool for tool in TOOLS}

def check_arguments(tool: Tool, arguments: dict) -> dict:
    """The inputs, checked against the tool's list. Whole-number text such as "12" is accepted as 12."""
    properties = tool.parameters["properties"]
    unknown = sorted(set(arguments) - set(properties))
    if unknown:
        raise ToolError(f"{tool.name} has no input called {', '.join(unknown)}. "
                        f"Its inputs are: {', '.join(properties) or 'none'}.")
    missing = [name for name in tool.parameters["required"] if arguments.get(name) in (None, "")]
    if missing:
        raise ToolError(f"{tool.name} needs {', '.join(missing)}.")
    checked = {}
    for name, value in arguments.items():
        spec = properties[name]
        if value is None:
            continue
        if spec["type"] == "integer":
            if isinstance(value, str) and re.fullmatch(r"\s*-?\d+\s*", value):
                value = int(value)
            if isinstance(value, bool) or not isinstance(value, int):
                raise ToolError(f"{name} must be a whole number.")
            if value < spec.get("minimum", value) or value > spec.get("maximum", value):
                raise ToolError(f"{name} must be between {spec.get('minimum', '-')} and {spec.get('maximum', '-')}.")
        elif spec["type"] == "string":
            if not isinstance(value, str):
                raise ToolError(f"{name} must be text.")
            value = value.strip()
            if "enum" in spec and value not in spec["enum"]:
                raise ToolError(f"{name} must be one of: {', '.join(spec['enum'])}.")
        checked[name] = value
    return checked


def run_tool(db, name: str, arguments: dict | None = None) -> str:
    """Run one tool and return its answer as text. Mistakes come back as "Error: ..." text,
    so the AI can read them and try again."""
    tool = TOOLS_BY_NAME.get(name)
    if tool is None:
        return f"Error: there is no tool called {name}. Tools: {', '.join(TOOLS_BY_NAME)}."
    try:
        return tool.function(db, **check_arguments(tool, arguments or {})).as_text()
    except ToolError as error:
        return f"Error: {error}"


def definitions() -> list[dict]:
    """The tools in the form AI providers expect: name, description, input schema."""
    return [{"name": tool.name, "description": tool.description, "input_schema": tool.parameters}
            for tool in TOOLS]
