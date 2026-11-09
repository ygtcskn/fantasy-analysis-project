"""Build the chatbot's database: past matches and season stats in one SQLite file.

Step 2 of the chatbot guide (docs/chatbot/02-build-the-database.md).

    python src/chat/build_chat_db.py

Reads every season folder in data/final/sportmonks/ (2021-2022, 2022-2023, ...)
and writes data/temp/chat/chat.sqlite. The file is rebuilt from scratch on
every run, so it can always be deleted and made again. Nothing in data/final
is changed.

Tables:
    seasons         one row per season
    teams           every club, with the name from its latest season
    players         every player, with the name from their latest season
    matches         every fixture: date, round, teams, final score
    events          goals, penalties, own goals, cards and substitutions
    player_matches  one row per player per match: minutes, goals, shots, ...
    standings       the league table as saved for each season

A blank in the provider's files is stored as NULL ("not recorded"), never as
0, so the chatbot can tell "no goals" from "not recorded".
"""
from __future__ import annotations

import argparse
import os
import re
import sqlite3
import sys
import unicodedata
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.shared import (counted, fixture_state, is_finished, number, parse_utc,  # noqa: E402
                        read_csv, season_label, utc_stamp, whole)

SOURCE = ROOT / "data" / "final" / "sportmonks"
OUTPUT = ROOT / "data" / "temp" / "chat" / "chat.sqlite"

# Event types the chatbot can talk about, as Sportmonks names them.
# PENALTY is a scored penalty; MISSED_PENALTY is a missed one.
EVENT_TYPES = {"GOAL", "PENALTY", "OWNGOAL", "MISSED_PENALTY",
               "YELLOWCARD", "REDCARD", "YELLOWREDCARD", "SUBSTITUTION"}

# Counted statistics: a blank is 0 only when the feed covered that match
# (shared.counted), otherwise NULL.
COUNTED_STATS = (
    "goals", "assists", "shots_total", "shots_on_target", "key_passes",
    "big_chances_created", "passes", "accurate_passes", "tackles", "interceptions",
    "clearances", "saves", "goals_conceded", "yellowcards", "redcards",
    "yellowred_cards", "own_goals", "penalties_scored", "penalties_misses",
    "fouls", "fouls_drawn", "touches",
)
# Measured statistics: a blank is always NULL.
MEASURED_STATS = {"minutes": "minutes_played", "rating": "rating", "expected_goals": "expected_goals"}

SCHEMA = f"""
CREATE TABLE seasons (
    season      TEXT PRIMARY KEY,      -- 2023/2024
    season_id   INTEGER
);
CREATE TABLE teams (
    team_id     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    short_code  TEXT,
    search_name TEXT NOT NULL          -- lower case, Turkish letters folded: fenerbahce
);
CREATE TABLE players (
    player_id   INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    short_name  TEXT,
    search_name TEXT NOT NULL
);
CREATE TABLE matches (
    fixture_id   INTEGER PRIMARY KEY,
    season       TEXT NOT NULL REFERENCES seasons(season),
    round        TEXT,
    kickoff_utc  TEXT,                 -- 2023-08-14T18:00:00Z
    state        TEXT,                 -- FT, NS, POSTPONED, ...
    finished     INTEGER NOT NULL,     -- 1 when the result is final
    home_team_id INTEGER NOT NULL REFERENCES teams(team_id),
    away_team_id INTEGER NOT NULL REFERENCES teams(team_id),
    home_goals   INTEGER,              -- NULL until finished, or when unknown
    away_goals   INTEGER
);
CREATE TABLE events (
    fixture_id        INTEGER NOT NULL REFERENCES matches(fixture_id),
    event_id          INTEGER NOT NULL,
    season            TEXT NOT NULL,
    type              TEXT NOT NULL,   -- GOAL, PENALTY, OWNGOAL, YELLOWCARD, ...
    minute            INTEGER,
    extra_minute      INTEGER,
    team_id           INTEGER,
    player_id         INTEGER,         -- the scorer, the booked player, the player coming on
    related_player_id INTEGER,         -- the assist, or the player going off
    PRIMARY KEY (fixture_id, event_id)
);
CREATE TABLE player_matches (
    fixture_id INTEGER NOT NULL REFERENCES matches(fixture_id),
    player_id  INTEGER NOT NULL,
    season     TEXT NOT NULL,
    team_id    INTEGER,
    position   TEXT,                   -- Goalkeeper, Defender, Midfielder, Attacker
    started    INTEGER,                -- 1 in the starting XI, 0 on the bench
    minutes    REAL,
    rating     REAL,
    expected_goals REAL,
    {", ".join(f"{name} REAL" for name in COUNTED_STATS)},
    PRIMARY KEY (fixture_id, player_id)
);
CREATE TABLE standings (
    season        TEXT NOT NULL,
    stage_id      INTEGER NOT NULL,
    group_id      TEXT NOT NULL,       -- '' when the stage has no groups
    team_id       INTEGER NOT NULL,
    position      INTEGER,
    points        INTEGER,
    played        INTEGER,
    won           INTEGER,
    drawn         INTEGER,
    lost          INTEGER,
    goals_for     INTEGER,
    goals_against INTEGER,
    PRIMARY KEY (season, stage_id, group_id, team_id)
);
CREATE INDEX idx_matches_season ON matches (season);
CREATE INDEX idx_matches_home ON matches (home_team_id);
CREATE INDEX idx_matches_away ON matches (away_team_id);
CREATE INDEX idx_events_player ON events (player_id);
CREATE INDEX idx_player_matches_player ON player_matches (player_id);
CREATE INDEX idx_player_matches_season ON player_matches (season);
"""

TURKISH = str.maketrans({"ı": "i", "İ": "i", "ş": "s", "Ş": "s", "ğ": "g", "Ğ": "g",
                         "ç": "c", "Ç": "c", "ö": "o", "Ö": "o", "ü": "u", "Ü": "u"})


def search_name(text) -> str:
    """A name as people type it: "Beşiktaş" and "besiktas" both become "besiktas"."""
    folded = unicodedata.normalize("NFKD", str(text or "").translate(TURKISH))
    plain = "".join(char for char in folded if not unicodedata.combining(char))
    return " ".join(plain.lower().split())


def integer(value) -> int | None:
    """A whole number from a cell, or None for a blank or anything else."""
    result = number(value)
    return int(result) if result is not None and result == int(result) else None


def final_scores(score_rows, fixtures) -> dict[str, tuple[int | None, int | None]]:
    """(home goals, away goals) per finished fixture, from its CURRENT score rows.

    The same rule as the website's home page: two different CURRENT values for
    one side make that side's score unknown (None) rather than a guess.
    """
    sides = {}
    for row in score_rows:
        if row.get("description") != "CURRENT":
            continue
        key = (row.get("fixture_id"), row.get("participant_id"))
        value = whole(row.get("score.goals"))
        sides[key] = None if key in sides and sides[key] != value else value
    scores = {}
    for fixture in fixtures:
        if not is_finished(fixture):
            continue
        fixture_id = fixture["fixture_id"]
        scores[fixture_id] = (sides.get((fixture_id, fixture.get("home_team_id"))),
                              sides.get((fixture_id, fixture.get("away_team_id"))))
    return scores


def season_folders(source: Path) -> list[Path]:
    """Season folders that have a fixtures file, oldest first."""
    if not source.is_dir():
        raise SystemExit(f"{source} is missing. Pull the data first: python src/sync_data.py pull")
    folders = sorted(path for path in source.iterdir()
                     if path.is_dir() and re.fullmatch(r"\d{4}-\d{4}", path.name))
    usable = [path for path in folders if (path / "fixtures.csv").is_file()]
    for path in folders:
        if path not in usable:
            print(f"skip {path.name}: no fixtures.csv")
    if not usable:
        raise SystemExit(f"No season folders with fixtures.csv in {source}.")
    return usable


def load_season(db: sqlite3.Connection, folder: Path, teams: dict, players: dict) -> dict[str, int]:
    """Insert one season. Team and player names are collected in teams/players."""
    season = season_label(folder.name)
    fixtures = read_csv(folder / "fixtures.csv", required=True)
    season_ids = {row.get("season_id") for row in fixtures if row.get("season_id")}
    db.execute("INSERT INTO seasons VALUES (?, ?)",
               (season, integer(next(iter(season_ids))) if len(season_ids) == 1 else None))

    for row in read_csv(folder / "teams.csv"):
        if integer(row.get("id")) is not None and row.get("name"):
            teams[int(row["id"])] = (row["name"], row.get("short_code") or None)
    for row in read_csv(folder / "players.csv"):
        name = row.get("display_name") or row.get("name")
        if integer(row.get("id")) is not None and name:
            players[int(row["id"])] = (name, row.get("common_name") or None)

    scores = final_scores(read_csv(folder / "fixture_scores.csv"), fixtures)
    match_ids = set()
    for row in fixtures:
        fixture_id, home, away = (integer(row.get(name)) for name in ("fixture_id", "home_team_id", "away_team_id"))
        if fixture_id is None or home is None or away is None:
            continue
        kickoff = parse_utc(row.get("kickoff") or row.get("starting_at"), required=False)
        home_goals, away_goals = scores.get(row["fixture_id"], (None, None))
        db.execute("INSERT INTO matches VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                   (fixture_id, season, row.get("round.name") or None, utc_stamp(kickoff) or None,
                    fixture_state(row) or None, int(is_finished(row)), home, away, home_goals, away_goals))
        match_ids.add(fixture_id)

    event_count = 0
    for row in read_csv(folder / "events.csv"):
        kind = row.get("type.developer_name", "")
        fixture_id, event_id = integer(row.get("fixture_id")), integer(row.get("event_id"))
        if (kind not in EVENT_TYPES or fixture_id not in match_ids or event_id is None
                or str(row.get("rescinded", "")).strip().lower() in {"true", "1"}):
            continue
        db.execute("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                   (fixture_id, event_id, season, kind, integer(row.get("minute")),
                    integer(row.get("extra_minute")), integer(row.get("team_id")),
                    integer(row.get("player_id")), integer(row.get("related_player_id"))))
        event_count += 1

    stat_count = 0
    for row in read_csv(folder / "player_match_stats.csv"):
        fixture_id, player_id = integer(row.get("fixture_id")), integer(row.get("player_id"))
        if fixture_id not in match_ids or player_id is None:
            continue
        if player_id not in players and row.get("name"):
            players[player_id] = (row["name"], None)
        values = [fixture_id, player_id, season, integer(row.get("team_id")), row.get("position") or None,
                  integer(row.get("started"))]
        values += [number(row.get(column)) for column in MEASURED_STATS.values()]
        values += [counted(row, column) for column in COUNTED_STATS]
        db.execute(f"INSERT INTO player_matches VALUES ({', '.join('?' for _ in values)})", values)
        stat_count += 1

    standing_count = 0
    for row in read_csv(folder / "standings.csv"):
        team_id, stage_id = integer(row.get("participant_id")), integer(row.get("stage_id"))
        if team_id is None or stage_id is None:
            continue
        if team_id not in teams and row.get("participant.name"):
            teams[team_id] = (row["participant.name"], row.get("participant.short_code") or None)
        db.execute("INSERT INTO standings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                   (season, stage_id, row.get("group_id") or "", team_id, integer(row.get("position")),
                    integer(row.get("points")), integer(row.get("details.overall_matches")),
                    integer(row.get("details.overall_wins")), integer(row.get("details.overall_draws")),
                    integer(row.get("details.overall_lost")), integer(row.get("details.overall_scored")),
                    integer(row.get("details.overall_conceded"))))
        standing_count += 1
    return {"matches": len(match_ids), "events": event_count,
            "player_matches": stat_count, "standings": standing_count}


def build(source: Path = SOURCE, output: Path = OUTPUT) -> dict[str, dict[str, int]]:
    """Build the whole database in a temporary file, then swap it in.

    If anything fails, the previous chat.sqlite (if there is one) is untouched.
    """
    folders = season_folders(source)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.{uuid.uuid4().hex}.tmp")
    report = {}
    try:
        db = sqlite3.connect(temporary)
        try:
            db.executescript(SCHEMA)
            teams, players = {}, {}
            for folder in folders:
                try:
                    report[season_label(folder.name)] = load_season(db, folder, teams, players)
                except sqlite3.IntegrityError as error:
                    raise SystemExit(f"{folder.name}: the data has a duplicate or broken row ({error}).") from None
            db.executemany("INSERT INTO teams VALUES (?, ?, ?, ?)",
                           [(team_id, name, short, search_name(name)) for team_id, (name, short) in teams.items()])
            db.executemany("INSERT INTO players VALUES (?, ?, ?, ?)",
                           [(player_id, name, short, search_name(name))
                            for player_id, (name, short) in players.items()])
            db.commit()
        finally:
            db.close()
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", type=Path, default=SOURCE, help="Folder of season folders.")
    parser.add_argument("--output", type=Path, default=OUTPUT, help="The SQLite file to write.")
    args = parser.parse_args()
    try:
        report = build(args.source, args.output)
    except PermissionError:
        raise SystemExit(f"Cannot replace {args.output}: close any program that has it open, then run again.") from None
    print(f"{'season':<11}{'matches':>9}{'events':>9}{'player rows':>13}{'table rows':>12}")
    for season, counts in report.items():
        print(f"{season:<11}{counts['matches']:>9}{counts['events']:>9}"
              f"{counts['player_matches']:>13}{counts['standings']:>12}")
    print(f"Built {args.output}")


if __name__ == "__main__":
    main()
