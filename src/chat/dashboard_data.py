"""Load saved Sportmonks match dashboard records into the assistant's SQLite cache."""

from collections import defaultdict
import math
import re

from src.shared import counted, nonnegative, number, read_csv, whole


# Sportmonks type IDs and feeds used by the dashboard's match cards.
STATISTICS = {
    "shots_total": ("statistics", "42"),
    "shots_on_target": ("statistics", "86"),
    "possession": ("statistics", "45"),
    "passes": ("statistics", "80"),
    "accurate_passes": ("statistics", "81"),
    "long_passes": ("statistics", "62"),
    "crosses": ("statistics", "98"),
    "dangerous_attacks": ("statistics", "44"),
    "fouls": ("statistics", "56"),
    "yellow_cards": ("statistics", "84"),
    "red_cards": ("statistics", "83"),
    "second_yellow_dismissals": ("statistics", "85"),
    "duels_won": ("statistics", "106"),
    "successful_dribbles": ("statistics", "109"),
    "corners": ("statistics", "34"),
    "free_kicks": ("statistics", "55"),
    "xg": ("xgfixture", "5304"),
    "set_piece_xg": ("xgfixture", "7944"),
    "open_play_xg": ("xgfixture", "7945"),
}
PLAYER_TOTALS = ("aerials_won", "fouls_drawn", "dispossessed")
TEAM_STATS = (*STATISTICS, "pass_accuracy", "long_pass_share", *PLAYER_TOTALS, "penalty_and_free_kick_goals")
TEAM_PERCENTAGES = ("possession", "pass_accuracy", "long_pass_share")
SEASON_COMPARISONS = ("xg", "shots_total", "possession", "dangerous_attacks", "fouls",
                      "pass_accuracy", "long_pass_share", "crosses")
PHASES = ("0–15", "16–30", "31–45+", "46–60", "61–75", "76–90+")

# Key each table by fixture first for match lookups.
SCHEMA = f"""
CREATE TABLE IF NOT EXISTS dashboard_matches (
    fixture_id INTEGER PRIMARY KEY, venue TEXT, city TEXT, referee TEXT, temperature_c INTEGER, weather TEXT,
    home_formation TEXT, away_formation TEXT, home_half_goals INTEGER, away_half_goals INTEGER
);
CREATE TABLE IF NOT EXISTS dashboard_team_stats (
    fixture_id INTEGER NOT NULL, team_id INTEGER NOT NULL,
    {", ".join(f"{stat} REAL" for stat in TEAM_STATS)},
    PRIMARY KEY (fixture_id, team_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS dashboard_lineups (
    fixture_id INTEGER NOT NULL, player_id INTEGER NOT NULL, team_id INTEGER NOT NULL,
    player TEXT, started INTEGER, position TEXT, formation_slot TEXT, shirt INTEGER,
    minutes REAL, rating REAL,
    PRIMARY KEY (fixture_id, player_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS dashboard_events (
    fixture_id INTEGER NOT NULL, event_id INTEGER NOT NULL, team_id INTEGER, player_id INTEGER, related_player_id INTEGER,
    player TEXT, related_player TEXT, kind TEXT, minute INTEGER, extra_minute INTEGER, info TEXT, score TEXT,
    sort_order INTEGER, rescinded INTEGER NOT NULL,
    PRIMARY KEY (fixture_id, event_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS dashboard_pressure (
    fixture_id INTEGER NOT NULL, elapsed_minute INTEGER NOT NULL, clock TEXT NOT NULL, phase INTEGER NOT NULL,
    home_pressure REAL NOT NULL, away_pressure REAL NOT NULL,
    PRIMARY KEY (fixture_id, elapsed_minute)
) WITHOUT ROWID;
"""


def side_rows(rows, participants, team_column):
    for row in rows:
        fixture_id, team_id = whole(row.get("fixture_id")), whole(row.get(team_column))
        if team_id is not None and team_id in participants.get(fixture_id, ()):
            yield fixture_id, team_id, row


def unique_value(records):
    return records[0] if len(records) == 1 else None


def insert(db, table, records):
    columns = len(db.execute(f"PRAGMA table_info({table})").fetchall())
    db.executemany(f"INSERT INTO {table} VALUES ({', '.join('?' for _ in range(columns))})", records)


def save_match_metadata(db, folder, fixtures, participants, score_rows):
    formations, officials, halves = defaultdict(list), defaultdict(list), defaultdict(list)
    for fixture_id, team_id, row in side_rows(read_csv(folder / "fixture_formations.csv"), participants, "participant_id"):
        formation = row.get("formation", "")
        formations[fixture_id, team_id].append(formation if re.fullmatch(r"\d(-\d){1,4}", formation) else None)
    for row in read_csv(folder / "fixture_referees.csv"):
        if row.get("type_id") == "6":
            referee = row.get("referee.display_name") or row.get("referee.common_name") or row.get("referee.name")
            officials[whole(row.get("fixture_id"))].append(referee)
    for fixture_id, team_id, row in side_rows(score_rows, participants, "participant_id"):
        if row.get("description") == "1ST_HALF":
            halves[fixture_id, team_id].append(whole(row.get("score.goals")))

    for row in fixtures:
        fixture_id = whole(row.get("fixture_id"))
        if fixture_id not in participants:
            continue
        home, away = participants[fixture_id]
        temp = number(row.get("weatherreport.current.temp"))
        if temp is None:
            temp = number(row.get("weatherreport.temperature.current"))
        if temp is not None and str(row.get("weatherreport.metric", "")).lower() in {"celsius", "celcius"}:
            temp = math.floor(temp + 0.5)
        else:
            temp = None
        weather = row.get("weatherreport.current.description") or row.get("weatherreport.description")
        db.execute("INSERT INTO dashboard_matches VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                   (fixture_id, row.get("venue.name"), row.get("venue.city_name"), unique_value(officials[fixture_id]),
                    temp, weather, unique_value(formations[fixture_id, home]), unique_value(formations[fixture_id, away]),
                    unique_value(halves[fixture_id, home]), unique_value(halves[fixture_id, away])))


def save_lineups(db, player_rows, participants, players):
    for fixture_id, team_id, row in side_rows(player_rows, participants, "team_id"):
        player_id = whole(row.get("player_id"))
        if player_id is None:
            continue
        name = players.get(player_id, (None,))[0] or row.get("name")
        db.execute("INSERT INTO dashboard_lineups VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                   (fixture_id, player_id, team_id, name, whole(row.get("started")), row.get("position"),
                    row.get("formation_field"), whole(row.get("jersey_number")),
                    nonnegative(row.get("minutes_played")), number(row.get("rating"))))


def save_events(db, event_rows, participants, players):
    for row in event_rows:
        fixture_id, event_id = whole(row.get("fixture_id")), whole(row.get("event_id") or row.get("id"))
        if fixture_id not in participants or event_id is None:
            continue
        player_id, related_id = whole(row.get("player_id")), whole(row.get("related_player_id"))
        team_id = whole(row.get("participant_id") or row.get("team_id"))
        name = players.get(player_id, (None,))[0] or row.get("player_name")
        related = players.get(related_id, (None,))[0] or row.get("related_player_name")
        kind = row.get("type.developer_name") or row.get("type.name")
        rescinded = str(row.get("rescinded", "")).strip().lower() in {"true", "1"}
        db.execute("INSERT INTO dashboard_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                   (fixture_id, event_id, team_id, player_id, related_id, name, related, kind,
                    whole(row.get("minute")), whole(row.get("extra_minute")), row.get("info"),
                    row.get("result"), whole(row.get("sort_order")), int(rescinded)))


def ratio(values, part):
    whole_value, part_value = values["passes"], values[part]
    return 100 * part_value / whole_value if whole_value and part_value is not None and part_value <= whole_value else None


def save_team_stats(db, folder, participants, finished, player_rows, event_rows):
    recorded = defaultdict(lambda: defaultdict(list))
    for fixture_id, team_id, row in side_rows(read_csv(folder / "team_metrics.csv"), participants, "team_id"):
        if fixture_id in finished:
            source = row.get("source") or "statistics"
            recorded[fixture_id, team_id][source, row.get("type_id")].append(nonnegative(row.get("value")))

    appearances = defaultdict(list)
    for fixture_id, team_id, row in side_rows(player_rows, participants, "team_id"):
        if fixture_id in finished and (number(row.get("minutes_played")) or 0) > 0:
            appearances[fixture_id, team_id].append(row)

    dead_ball, event_fixtures = defaultdict(int), set()
    for row in event_rows:
        fixture_id = whole(row.get("fixture_id"))
        team_id = whole(row.get("participant_id") or row.get("team_id"))
        if fixture_id not in finished:
            continue
        event_fixtures.add(fixture_id)
        if str(row.get("rescinded", "")).strip().lower() in {"true", "1"}:
            continue
        kind = str(row.get("type.developer_name", "")).upper()
        if kind == "PENALTY" or (kind == "GOAL" and str(row.get("info", "")).lower() == "free kick"):
            dead_ball[fixture_id, team_id] += 1

    for fixture_id in finished:
        for team_id in participants[fixture_id]:
            key = (fixture_id, team_id)
            metrics = recorded[key]
            values = {stat: unique_value(metrics.get(mapping, [])) for stat, mapping in STATISTICS.items()}
            if values["possession"] is not None and values["possession"] > 100:
                values["possession"] = None
            # Only bookings use the site's covered-match zero rule in rankings. Missing shots,
            # xG and other metrics leave the leaderboard incomplete.
            if any(source == "statistics" for source, _ in metrics):
                for stat in ("yellow_cards", "red_cards", "second_yellow_dismissals"):
                    if STATISTICS[stat] not in metrics:
                        values[stat] = 0
            values["pass_accuracy"] = ratio(values, "accurate_passes")
            values["long_pass_share"] = ratio(values, "long_passes")
            for stat in PLAYER_TOTALS:
                counts = [counted(row, stat) for row in appearances[key]]
                values[stat] = sum(counts) if counts and all(value is not None for value in counts) else None
            values["penalty_and_free_kick_goals"] = dead_ball[key] if fixture_id in event_fixtures else None
            yield (fixture_id, team_id, *(values[stat] for stat in TEAM_STATS))


def pressure_clock(elapsed, first_half):
    if elapsed <= first_half:
        return str(elapsed) if elapsed <= 45 else f"45+{elapsed - 45}"
    clock = 45 + elapsed - first_half
    return str(clock) if clock <= 90 else f"90+{clock - 90}"


def pressure_rows(folder, participants, finished):
    first_halves = {}
    for row in read_csv(folder / "fixture_periods.csv"):
        if "1st" in str(row.get("description", "")).lower():
            first_halves.setdefault(whole(row.get("fixture_id")), whole(row.get("minutes")))

    pressure = defaultdict(lambda: defaultdict(dict))
    for fixture_id, team_id, row in side_rows(read_csv(folder / "fixture_pressure.csv"), participants, "participant_id"):
        minute, value = whole(row.get("minute")), number(row.get("pressure"))
        if fixture_id in finished and minute and value is not None:
            pressure[fixture_id][minute][team_id] = value
    for fixture_id, samples in pressure.items():
        home, away = participants[fixture_id]
        paired = sorted(minute for minute, values in samples.items() if home in values and away in values)
        if not paired:
            continue
        first_half = first_halves.get(fixture_id) or 45 + math.floor(max(0, (paired[-1] - 90) / 2) + 0.5)
        for elapsed in paired:
            clock = min(elapsed, 45) if elapsed <= first_half else min(45 + elapsed - first_half, 90)
            phase = (clock - 1) // 15
            yield fixture_id, elapsed, pressure_clock(elapsed, first_half), phase, samples[elapsed][home], samples[elapsed][away]


def save_dashboard(db, folder, fixtures, participants, finished, score_rows, event_rows, player_rows, players):
    save_match_metadata(db, folder, fixtures, participants, score_rows)
    save_lineups(db, player_rows, participants, players)
    save_events(db, event_rows, participants, players)
    insert(db, "dashboard_team_stats", save_team_stats(db, folder, participants, finished, player_rows, event_rows))
    insert(db, "dashboard_pressure", pressure_rows(folder, participants, finished))
