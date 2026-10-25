"""Read and audit completed Sportmonks CSV snapshots without changing inputs.

Only CURRENT scores from 90-minute FT fixtures become observed results.
Sportmonks documents 2ND_HALF as cumulative, so it is a consistency check,
never a second-half goal count to add to 1ST_HALF:
https://docs.sportmonks.com/v3/tutorials-and-guides/tutorials/includes/scores
https://docs.sportmonks.com/v3/tutorials-and-guides/tutorials/includes/states

Historical results are reconstructed from today's saved provider snapshot. The
CSV exports do not establish when a corrected result or kickoff became known.
``available_at`` uses the later of kickoff + 3 hours and a valid saved second-half
period end, where supplied. The buffer is not an observed publication time.
Naive exported kickoff values are interpreted as UTC, as in the downloader's
default Sportmonks requests, and checked against the Unix timestamp if present.
"""

from __future__ import annotations

import csv
import hashlib
import io
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

from src.shared import CALLED_OFF_STATES, FINISHED_STATES, UTC, number, parse_utc, utc_stamp

RESULT_AVAILABILITY_BUFFER = timedelta(hours=3)
REQUIRED_FILES = ("fixtures.csv", "fixture_scores.csv", "teams.csv")
OPTIONAL_FILES = ("fixture_participants.csv", "fixture_periods.csv", "fixture_metadata.csv",
                  "team_metrics.csv", "file_inventory.csv")
SEASON_PATTERN = re.compile(r"^\d{4}-\d{4}$")
# A season is over when every fixture is final or called off.
TERMINAL_STATES = FINISHED_STATES | CALLED_OFF_STATES
STATE_IDS = {"1": "NS", "5": "FT", "7": "AET", "8": "FT_PEN", "10": "POSTPONED",
             "11": "SUSPENDED", "12": "CANCELLED", "13": "TBA", "14": "WO",
             "15": "ABANDONED", "17": "AWARDED", "18": "INTERRUPTED", "20": "DELETED"}
# Fixtures inspected individually against the raw provider capture and excluded
# on purpose. The contradiction is in Sportmonks' own data, not in this export,
# so it cannot be corrected by re-downloading. Naming them here keeps the
# backtest gate strict for any new, unreviewed structural error.
REVIEWED_BAD_FIXTURES = {
    "19172292": ("2024-25 Galatasaray vs Bodrumspor: 1ST_HALF+2ND_HALF_ONLY (1+2) "
                 "and 2ND_HALF both give 3-0, while CURRENT gives 2-0. "
                 "Verified identical in data/raw/sportmonks/2024-2025."),
}

ANOMALOUS_RESULT = re.compile(
    r"award|abandon|walk[ -]?over|\bwo\b|forfeit|cancel|suspend|interrupt|"
    r"extra[ -]?time|penalt(?:y|ies) shoot|after penalt|not played|did not (?:play|take place)|"
    r"administrative|hükmen|hukmen", re.IGNORECASE)


@dataclass(frozen=True)
class Match:
    fixture_id: str
    season: str
    season_id: str
    league_id: str
    kickoff: datetime
    home_team_id: str
    away_team_id: str
    home_team_name: str
    away_team_name: str
    home_goals: int | None
    away_goals: int | None
    state: str
    available_at: datetime | None
    venue_id: str = ""
    neutral: bool = False
    round_name: str = ""
    # {team_id: {provider metric name: value}} from team_metrics.csv, for the
    # match itself. Excluded from equality and hashing: it is bulk detail
    # hanging off the fixture, not part of the fixture's identity.
    team_stats: dict = field(default_factory=dict, compare=False, repr=False)

    @property
    def outcome(self) -> str:
        if self.home_goals is None or self.away_goals is None:
            return ""
        if self.home_goals == self.away_goals:
            return "draw"
        return "home" if self.home_goals > self.away_goals else "away"


@dataclass
class Dataset:
    matches: list[Match] = field(default_factory=list)
    coverage: list[dict] = field(default_factory=list)
    exclusions: list[dict] = field(default_factory=list)
    sources: list[dict] = field(default_factory=list)


class SnapshotError(ValueError):
    def __init__(self, reason: str, *, export_status: str = "unknown",
                 export_complete: bool = False, stable: bool = False):
        super().__init__(reason)
        self.export_status = export_status
        self.export_complete = export_complete
        self.stable = stable


def _id(value: str) -> bool:
    return bool(re.fullmatch(r"[1-9]\d*", value))


def _integer(value: str) -> int | None:
    return int(value) if re.fullmatch(r"\d+", value) else None


def _bool(value: str) -> bool | None:
    return {"true": True, "1": True, "false": False, "0": False}.get(value.lower())


def _csv_rows(data: bytes, filename: str, required: set[str]) -> list[dict[str, str]]:
    reader = csv.DictReader(io.StringIO(data.decode("utf-8-sig"), newline=""), strict=True)
    names = reader.fieldnames or []
    if not names or any(not name for name in names) or len(names) != len(set(names)):
        raise ValueError(f"{filename}: missing, empty or duplicate column names")
    missing = sorted(required - set(names))
    if missing:
        raise ValueError(f"{filename}: missing columns: {', '.join(missing)}")
    rows = []
    for number, row in enumerate(reader, 2):
        if None in row or any(value is None for value in row.values()):
            raise ValueError(f"{filename}: malformed CSV record {number}")
        rows.append({key: value.strip() for key, value in row.items()})
    return rows


def _signature(path: Path) -> tuple:
    stat = path.stat()
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns


def _snapshot(folder: Path) -> tuple[dict[str, bytes], list[dict], datetime]:
    """Read twice and compare bytes, file identity and timestamps plus the marker.

    This detects concurrent downloader writes during the read; it cannot promise
    that a provider response was historically available at a past cutoff.
    """
    status_path = folder / "download_status.csv"
    try:
        status_signature = _signature(status_path)
        status_bytes = status_path.read_bytes()
        statuses = _csv_rows(status_bytes, status_path.name, {"status", "season"})
    except (OSError, UnicodeError, ValueError, csv.Error) as exc:
        raise SnapshotError(f"download_status_unreadable: {exc}") from exc
    if len(statuses) != 1:
        raise SnapshotError("download_status must contain exactly one row")
    status = statuses[0]
    export_status = status["status"].lower()
    if export_status != "complete":
        raise SnapshotError("export_not_complete", export_status=export_status)
    if status["season"].replace("/", "-") != folder.name:
        raise SnapshotError("download_status_season_mismatch", export_status=export_status,
                            export_complete=True)
    try:
        completed = parse_utc(status.get("finished_at_utc", ""))
    except ValueError as exc:
        raise SnapshotError("missing_or_invalid_capture_completion_time", export_status=export_status,
                            export_complete=True) from exc
    if completed > datetime.now(UTC) + timedelta(minutes=5):
        raise SnapshotError("capture_completion_time_in_future", export_status=export_status,
                            export_complete=True)
    optional = {name for name in OPTIONAL_FILES if (folder / name).exists()}
    names = ["download_status.csv", *REQUIRED_FILES, *sorted(optional)]
    try:
        before = {name: _signature(folder / name) for name in names}
        if before["download_status.csv"] != status_signature:
            raise ValueError("download_status_changed_during_read")
        contents = {name: (folder / name).read_bytes() for name in names}
        if contents["download_status.csv"] != status_bytes:
            raise ValueError("download_status_changed_during_read")
        for name in names:
            if _signature(folder / name) != before[name] or (folder / name).read_bytes() != contents[name]:
                raise ValueError(f"source_changed_during_read: {name}")
        if {name for name in OPTIONAL_FILES if (folder / name).exists()} != optional:
            raise ValueError("optional_sources_changed_during_read")
        if any(_signature(folder / name) != before[name] for name in names):
            raise ValueError("source_changed_during_read")
        if status_path.read_bytes() != status_bytes:
            raise ValueError("download_status_changed_during_read")
    except (OSError, ValueError) as exc:
        raise SnapshotError(str(exc), export_status=export_status, export_complete=True) from exc
    sources = [{"season": folder.name, "path": str((folder / name).resolve()),
                "sha256": hashlib.sha256(contents[name]).hexdigest(), "bytes": len(contents[name]),
                "last_write_utc": utc_stamp(datetime.fromtimestamp(before[name][3] / 1_000_000_000, UTC)),
                "capture_completed_at_utc": utc_stamp(completed), "snapshot_accepted": True}
               for name in names]
    return contents, sources, completed


def _coverage(season: str) -> dict:
    return {"season": season, "export_status": "missing", "export_complete": False,
            "snapshot_stable": False, "capture_completed_at_utc": "", "fixture_rows": 0,
            "target_fixture_rows": 0, "unique_fixture_ids": 0, "valid_completed_matches": 0,
            "valid_scheduled_matches": 0, "excluded_fixture_count": 0, "team_count": 0,
            "fixture_team_count": 0, "expected_fixtures_double_round_robin": "",
            "missing_home_away_pairs": "", "duplicate_home_away_pairs": "",
            "schedule_complete": False, "season_finished": False, "provider_stage_finished": "",
            "first_kickoff_utc": "", "last_kickoff_utc": "", "notes": ""}


def _exclude(dataset: Dataset, season: str, fixture_id: str, table: str,
             reason: str, details: str = "") -> None:
    dataset.exclusions.append({"season": season, "fixture_id": fixture_id,
                               "table": table, "reason": reason, "details": details})


def _state(row: dict[str, str]) -> tuple[str, bool]:
    # short_name is a presentation label (for example AWAR for AWARDED),
    # not a canonical identifier. Its abbreviation can vary by state. Compare
    # canonical names and IDs; only use a short label when neither is present.
    values = [row.get(key, "").upper() for key in
              ("state", "state.developer_name", "state.state") if row.get(key)]
    values = [STATE_IDS.get(value, value) for value in values]
    for key in ("state_id", "state.id"):
        if row.get(key):
            values.append(STATE_IDS.get(row[key], f"UNSUPPORTED_ID_{row[key]}"))
    if not values and row.get("state.short_name"):
        short = row["state.short_name"].upper()
        values.append({"AWAR": "AWARDED"}.get(short, short))
    return (values[0] if values else ""), len(set(values)) <= 1


def _kickoff(row: dict[str, str]) -> datetime:
    values = [parse_utc(row[key]) for key in ("kickoff", "starting_at") if row.get(key)]
    if row.get("starting_at_timestamp"):
        timestamp = _integer(row["starting_at_timestamp"])
        if timestamp is None:
            raise ValueError("invalid_unix_kickoff")
        values.append(datetime.fromtimestamp(timestamp, UTC))
    if not values or len(set(values)) != 1:
        raise ValueError("missing_or_inconsistent_kickoff")
    return values[0]


def _scores(rows: list[dict[str, str]], home: str, away: str,
            duplicated_score_ids: set[str], scheduled: bool) -> tuple[int | None, int | None, list[str]]:
    reasons: set[str] = set()
    periods: dict[str, dict[str, list[int]]] = defaultdict(lambda: defaultdict(list))
    for row in rows:
        period, side = row.get("description", "").upper(), row.get("score.participant", "").lower()
        if row.get("id") in duplicated_score_ids:
            reasons.add("duplicate_score_id")
        if side not in {"home", "away"} or row.get("participant_id") != {"home": home, "away": away}.get(side):
            reasons.add("score_participant_orientation_mismatch")
            continue
        goals = _integer(row.get("score.goals", ""))
        if goals is None:
            reasons.add("invalid_or_missing_score")
            continue
        if period == "CURRENT" and row.get("type_id") and row["type_id"] != "1525":
            reasons.add("current_score_type_mismatch")
        if period == "2ND_HALF" and row.get("type_id") and row["type_id"] != "2":
            reasons.add("second_half_score_type_mismatch")
        if not period:
            reasons.add("missing_score_description")
        if period in {"EXTRA_TIME", "EXTRA_TIME_ONLY", "ET", "PENALTY_SHOOTOUT", "PENALTIES", "PENALTY"}:
            reasons.add("non_regulation_score_period")
        periods[period][side].append(goals)
    for period, sides in periods.items():
        if any(len(values) != 1 for values in sides.values()):
            reasons.add("duplicate_score_period_side")
    if scheduled:
        if any(value != 0 for sides in periods.values() for values in sides.values() for value in values):
            reasons.add("scheduled_fixture_has_nonzero_score")
        return None, None, sorted(reasons)
    current = periods.get("CURRENT", {})
    if set(current) != {"home", "away"} or any(len(values) != 1 for values in current.values()):
        reasons.add("missing_or_ambiguous_current_score")
        return None, None, sorted(reasons)
    for side in ("home", "away"):
        total = current[side][0]
        second = periods.get("2ND_HALF", {}).get(side, [])
        first = periods.get("1ST_HALF", {}).get(side, [])
        second_only = periods.get("2ND_HALF_ONLY", {}).get(side, [])
        # 2ND_HALF is documented as the cumulative full-time score, but some
        # provider rows carry a running in-play snapshot instead. Treat a
        # mismatch as decisive only when nothing else confirms the total; when
        # 1ST_HALF + 2ND_HALF_ONLY agrees with CURRENT the result is already
        # corroborated by two independent fields.
        corroborated = (len(first) == 1 and len(second_only) == 1
                        and first[0] + second_only[0] == total)
        if len(second) == 1 and second[0] != total and not corroborated:
            reasons.add("current_second_half_score_conflict")
        if len(first) == 1 and first[0] > total:
            reasons.add("first_half_exceeds_final_score")
        if len(first) == 1 and len(second_only) == 1 and first[0] + second_only[0] != total:
            reasons.add("half_period_sum_conflict")
    return current["home"][0], current["away"][0], sorted(reasons)


def _load_one(dataset: Dataset, season: str, contents: dict[str, bytes],
              completed: datetime, coverage: dict, league_id: str,
              fixture_occurrences: dict[str, set[str]]) -> None:
    fixtures = _csv_rows(contents["fixtures.csv"], "fixtures.csv",
                         {"fixture_id", "season_id", "league_id", "home_team_id", "away_team_id", "state"})
    score_rows = _csv_rows(contents["fixture_scores.csv"], "fixture_scores.csv",
                          {"fixture_id", "description", "participant_id", "score.participant", "score.goals"})
    team_rows = _csv_rows(contents["teams.csv"], "teams.csv", {"id", "name"})
    participants = (_csv_rows(contents["fixture_participants.csv"], "fixture_participants.csv",
                              {"fixture_id", "id", "meta.location"})
                    if "fixture_participants.csv" in contents else None)
    period_rows = (_csv_rows(contents["fixture_periods.csv"], "fixture_periods.csv", {"fixture_id", "type_id", "ended"})
                   if "fixture_periods.csv" in contents else None)
    metadata_rows = (_csv_rows(contents["fixture_metadata.csv"], "fixture_metadata.csv", {"fixture_id"})
                     if "fixture_metadata.csv" in contents else None)
    metric_rows = (_csv_rows(contents["team_metrics.csv"], "team_metrics.csv",
                             {"fixture_id", "team_id", "name", "value"})
                   if "team_metrics.csv" in contents else None)
    loaded_tables = {"fixtures.csv": fixtures, "fixture_scores.csv": score_rows, "teams.csv": team_rows,
                     "fixture_participants.csv": participants, "fixture_periods.csv": period_rows,
                     "fixture_metadata.csv": metadata_rows, "team_metrics.csv": metric_rows}
    if "file_inventory.csv" in contents:
        inventory = _csv_rows(contents["file_inventory.csv"], "file_inventory.csv", {"file", "rows"})
        entries = defaultdict(list)
        for record in inventory:
            entries[record["file"]].append(record["rows"])
        for filename, rows in loaded_tables.items():
            if rows is not None:
                values = entries.get(filename, [])
                if len(values) != 1 or _integer(values[0]) != len(rows):
                    raise ValueError(f"file_inventory.csv: row count missing or inconsistent for {filename}")
    for row in fixtures:
        fixture_occurrences[row["fixture_id"]].add(season)
    fixture_counts = Counter(row["fixture_id"] for row in fixtures)
    score_ids = Counter(row["id"] for row in score_rows if row.get("id"))
    duplicated_score_ids = {value for value, count in score_ids.items() if count > 1}
    team_ids = Counter(row["id"] for row in team_rows)
    bad_teams = {value for value, count in team_ids.items() if not _id(value) or count != 1}
    teams = {row["id"]: row["name"] or row["id"] for row in team_rows if row["id"] not in bad_teams}
    scores_by_fixture: dict[str, list] = defaultdict(list)
    participants_by_fixture: dict[str, list] = defaultdict(list)
    periods_by_fixture: dict[str, list] = defaultdict(list)
    metadata_by_fixture: dict[str, list] = defaultdict(list)
    for row in score_rows:
        scores_by_fixture[row["fixture_id"]].append(row)
        if row["fixture_id"] not in fixture_counts:
            _exclude(dataset, season, row["fixture_id"], "fixture_scores.csv", "orphan_score_record")
    for row in participants or []:
        participants_by_fixture[row["fixture_id"]].append(row)
        if row["fixture_id"] not in fixture_counts:
            _exclude(dataset, season, row["fixture_id"], "fixture_participants.csv", "orphan_participant_record")
    for filename, rows, destination in (("fixture_periods.csv", period_rows, periods_by_fixture),
                                        ("fixture_metadata.csv", metadata_rows, metadata_by_fixture)):
        for row in rows or []:
            destination[row["fixture_id"]].append(row)
            if row["fixture_id"] not in fixture_counts:
                _exclude(dataset, season, row["fixture_id"], filename, "orphan_related_record")
    # Match statistics. One row per fixture, team and metric. A metric repeated
    # for the same team with different values is contradictory, so it is dropped
    # for that team rather than resolved by read order.
    stats_by_fixture: dict[str, dict[str, dict[str, float | None]]] = defaultdict(dict)
    orphan_metric_fixtures: set[str] = set()
    for row in metric_rows or []:
        fid = row["fixture_id"]
        if fid not in fixture_counts:
            if fid not in orphan_metric_fixtures:
                orphan_metric_fixtures.add(fid)
                _exclude(dataset, season, fid, "team_metrics.csv", "orphan_related_record")
            continue
        value = number(row["value"])
        if value is None:
            continue
        bucket = stats_by_fixture[fid].setdefault(row["team_id"], {})
        name = row["name"]
        if name not in bucket:
            bucket[name] = value
        elif bucket[name] != value:
            bucket[name] = None
    for team in sorted(bad_teams):
        _exclude(dataset, season, "", "teams.csv", "duplicate_or_invalid_team_id", team)
    target_rows = [row for row in fixtures if row["league_id"] == league_id]
    seasons = {row["season_id"] for row in target_rows}
    mixed_seasons = len(seasons) != 1 or any(not _id(value) for value in seasons)
    pairs = Counter((row["home_team_id"], row["away_team_id"]) for row in target_rows
                    if _id(row["home_team_id"]) and _id(row["away_team_id"])
                    and row["home_team_id"] != row["away_team_id"])
    fixture_teams = {team for pair in pairs for team in pair}
    expected_pairs = {(home, away) for home in teams for away in teams if home != away}
    stage_ids = {row.get("stage_id") or row.get("stage.id") for row in target_rows
                 if row.get("stage_id") or row.get("stage.id")}
    # A multi-stage or grouped competition needs a reviewed structure, rather
    # than silently imposing double round robin on its complete fixture list.
    simple_structure = len(stage_ids) <= 1 and not any(row.get("group_id") for row in target_rows)
    schedule_complete = (bool(expected_pairs) and set(pairs) == expected_pairs
                         and all(count == 1 for count in pairs.values())
                         and all(count == 1 for count in fixture_counts.values())
                         and len(target_rows) == len(fixtures) == len(expected_pairs)
                         and not bad_teams and not mixed_seasons and simple_structure)
    provider_flags = {_bool(row["stage.finished"]) for row in target_rows if row.get("stage.finished")}
    provider_finished = (next(iter(provider_flags)) if len(provider_flags) == 1 and None not in provider_flags else "")
    states = [_state(row) for row in target_rows]
    finished_states = TERMINAL_STATES | ({"ABANDONED"} if provider_finished is True else set())
    season_finished = (schedule_complete and bool(states) and all(state in finished_states and consistent
                       for state, consistent in states) and provider_finished is not False)
    notes = []
    if not simple_structure:
        notes.append("Competition structure needs review: multiple stages or groups")
    if fixture_teams != set(teams):
        notes.append("teams.csv membership differs from fixture participants")
    if bad_teams:
        notes.append("Duplicate or invalid team IDs excluded")
    if mixed_seasons:
        notes.append("Target fixture season IDs are missing, invalid or inconsistent")
    if participants is None:
        notes.append("fixture_participants.csv absent; using exported home/away IDs and score participant checks")
    if period_rows is None:
        notes.append("fixture_periods.csv absent; result availability uses kickoff plus 3 hours")
    if metadata_rows is None:
        notes.append("fixture_metadata.csv absent; unknown neutral venues default to home advantage")
    if metric_rows is None:
        notes.append("team_metrics.csv absent; match statistics features are unavailable")
    if "file_inventory.csv" not in contents:
        notes.append("file_inventory.csv absent; independent export row-count check unavailable")
    if provider_finished is True and not schedule_complete:
        notes.append("Provider stage finished flag does not establish a complete schedule")
    coverage.update(fixture_rows=len(fixtures), target_fixture_rows=len(target_rows),
                    unique_fixture_ids=len(fixture_counts), team_count=len(teams), fixture_team_count=len(fixture_teams),
                    expected_fixtures_double_round_robin=len(expected_pairs),
                    missing_home_away_pairs=len(expected_pairs - set(pairs)),
                    duplicate_home_away_pairs=sum(count - 1 for count in pairs.values() if count > 1),
                    schedule_complete=schedule_complete, season_finished=season_finished,
                    provider_stage_finished=provider_finished)
    now = datetime.now(UTC)
    kickoff_values = []
    for row in fixtures:
        fid, home, away = row["fixture_id"], row["home_team_id"], row["away_team_id"]
        reasons: set[str] = set()
        if not _id(fid):
            reasons.add("missing_or_invalid_fixture_id")
        if fixture_counts[fid] != 1:
            reasons.add("duplicate_fixture_id")
        if row.get("id") and row["id"] != fid:
            reasons.add("fixture_id_column_conflict")
        if row["league_id"] != league_id:
            reasons.add("foreign_or_missing_league")
        elif mixed_seasons:
            reasons.add("missing_or_mixed_season_id")
        if row.get("stage.league_id") and row["stage.league_id"] != league_id:
            reasons.add("stage_league_mismatch")
        if row.get("stage.season_id") and row["stage.season_id"] != row["season_id"]:
            reasons.add("stage_season_mismatch")
        if not simple_structure:
            reasons.add("unsupported_competition_structure")
        if row.get("sport_id") and row["sport_id"] != "1":
            reasons.add("non_football_fixture")
        if not _id(home) or not _id(away) or home == away:
            reasons.add("missing_or_invalid_teams")
        if home not in teams or away not in teams:
            reasons.add("unknown_or_ambiguous_team_id")
        if row.get("length") != "90":
            reasons.add("unsupported_or_missing_match_length")
        if row.get("placeholder") and _bool(row["placeholder"]) is not False:
            reasons.add("placeholder_fixture")
        state, state_consistent = _state(row)
        if not state_consistent:
            reasons.add("conflicting_state_fields")
        if state not in {"FT", "NS"}:
            reasons.add("unsupported_state")
        text = " ".join(row.get(key, "") for key in ("details", "result_info", "state.name"))
        anomaly = ANOMALOUS_RESULT.search(text)
        if anomaly:
            token = anomaly.group().lower()
            if any(word in token for word in ("award", "walk", "forfeit", "hükmen", "hukmen", "administrative")) or token == "wo":
                reasons.add("awarded_result")
            elif "abandon" in token:
                reasons.add("abandoned_result")
            elif "cancel" in token or "not played" in token or "did not" in token:
                reasons.add("cancelled_result")
            else:
                reasons.add("interrupted_or_nonregulation_result")
        for key in ("awarded", "is_awarded", "abandoned", "is_abandoned", "walkover", "is_walkover"):
            if row.get(key) and _bool(row[key]) is not False:
                reasons.add("abandoned_result" if "abandoned" in key else "awarded_result")
        kickoff = None
        try:
            kickoff = _kickoff(row)
            if row["league_id"] == league_id:
                kickoff_values.append(kickoff)
            if state == "FT" and kickoff > min(completed, now):
                reasons.add("completed_fixture_has_future_kickoff")
            if state == "NS" and kickoff <= max(completed, now):
                reasons.add("stale_not_started_fixture")
        except (ValueError, OSError, OverflowError):
            reasons.add("missing_or_invalid_kickoff")
        neutral_values = [_bool(row[key]) for key in ("neutral", "neutral_venue", "is_neutral") if row.get(key)]
        neutral_metadata = [record["values.neutral"] for record in metadata_by_fixture.get(fid, []) if record.get("values.neutral")]
        if len(neutral_metadata) > 1:
            reasons.add("duplicate_neutral_metadata")
        neutral_values.extend(_bool(value) for value in neutral_metadata)
        if neutral_values and (None in neutral_values or len(set(neutral_values)) > 1):
            reasons.add("ambiguous_neutral_venue_flag")
        neutral = bool(neutral_values and neutral_values[0] is True)
        available_at = kickoff + RESULT_AVAILABILITY_BUFFER if kickoff is not None and state == "FT" else None
        second_halves = [record for record in periods_by_fixture.get(fid, []) if record.get("type_id") == "2"]
        if len(second_halves) > 1:
            reasons.add("duplicate_second_half_period")
        excluded_administratively = bool(reasons & {"awarded_result", "abandoned_result", "cancelled_result"})
        if state == "FT" and not excluded_administratively and kickoff is not None and len(second_halves) == 1 and second_halves[0].get("ended"):
            end_timestamp = _integer(second_halves[0]["ended"])
            try:
                ended = datetime.fromtimestamp(end_timestamp, UTC) if end_timestamp is not None else None
                if ended is None or ended <= kickoff or ended > min(completed, now):
                    reasons.add("invalid_second_half_end")
                else:
                    available_at = max(available_at, ended)
            except (ValueError, OSError, OverflowError):
                reasons.add("invalid_second_half_end")
        if participants is not None:
            participant_rows = participants_by_fixture.get(fid, [])
            actual = [(p.get("meta.location", "").lower(), p["id"]) for p in participant_rows]
            if len(actual) != 2 or set(actual) != {("home", home), ("away", away)}:
                reasons.add("fixture_participant_orientation_mismatch")
            if any(_bool(p.get("placeholder", "false")) is not False for p in participant_rows):
                reasons.add("placeholder_participant")
        home_goals, away_goals, score_reasons = _scores(scores_by_fixture.get(fid, []), home, away,
                                                       duplicated_score_ids, state == "NS")
        if state in {"FT", "NS"} and not excluded_administratively:
            reasons.update(score_reasons)
        if state == "FT" and home_goals is not None and away_goals is not None:
            result_info = row.get("result_info", "").lower()
            if ("draw" in result_info and home_goals != away_goals) or (" won " in f" {result_info} " and home_goals == away_goals):
                reasons.add("result_info_score_conflict")
        if reasons and fid in REVIEWED_BAD_FIXTURES:
            _exclude(dataset, season, fid, "fixtures.csv", "reviewed_provider_error", REVIEWED_BAD_FIXTURES[fid])
            continue
        if reasons:
            for reason in sorted(reasons):
                _exclude(dataset, season, fid, "fixtures.csv", reason, state if reason == "unsupported_state" else "")
            continue
        assert kickoff is not None
        dataset.matches.append(Match(fid, season, row["season_id"], league_id, kickoff, home, away,
                                     teams[home], teams[away], home_goals, away_goals, state,
                                     available_at,
                                     row.get("venue_id") or row.get("venue.id", ""), neutral,
                                     (row.get("round.name") or row.get("round_id") or "").strip(),
                                     {team_id: {name: value for name, value in values.items()
                                                if value is not None}
                                      for team_id, values in stats_by_fixture.get(fid, {}).items()}))
    if kickoff_values:
        coverage["first_kickoff_utc"] = utc_stamp(min(kickoff_values))
        coverage["last_kickoff_utc"] = utc_stamp(max(kickoff_values))
    coverage["notes"] = "; ".join(notes)


def load_seasons(input_root: Path, seasons: list[str] | None = None, league_id: str = "600") -> Dataset:
    """Load valid FT results and future NS fixtures from stable completed exports.

    Explicit missing seasons and incomplete downloads produce coverage rows and
    exclusions, not an exception. Bad CSV schemas reject the whole season.
    Duplicate fixture IDs across seasons reject every occurrence, rather than
    selecting whichever row happened to be read first. Team identity uses only
    Sportmonks IDs. Outputs contain ordinary scalar fields ready for CSV writing.
    """
    root = Path(input_root).resolve()
    league_id = str(league_id)
    if not _id(league_id):
        raise ValueError("league_id must be a positive Sportmonks ID")
    if seasons is None:
        selected = sorted(path.name for path in root.iterdir() if path.is_dir() and SEASON_PATTERN.fullmatch(path.name)) if root.is_dir() else []
    else:
        selected = list(dict.fromkeys(season.replace("/", "-") for season in seasons))
        if any(not SEASON_PATTERN.fullmatch(season) or int(season[5:]) != int(season[:4]) + 1 for season in selected):
            raise ValueError("Season labels must use consecutive years, for example 2021-2022")
    dataset = Dataset()
    fixture_occurrences: dict[str, set[str]] = defaultdict(set)
    if not selected:
        coverage = _coverage("")
        coverage["notes"] = "No season directories found in input root"
        dataset.coverage.append(coverage)
        return dataset
    for season in selected:
        coverage = _coverage(season)
        dataset.coverage.append(coverage)
        folder = root / season
        if not folder.is_dir():
            coverage["notes"] = "Requested season directory is missing"
            _exclude(dataset, season, "", "", "missing_season_directory")
            continue
        try:
            contents, sources, completed = _snapshot(folder)
        except SnapshotError as exc:
            coverage.update(export_status=exc.export_status, export_complete=exc.export_complete,
                            snapshot_stable=exc.stable, notes=str(exc))
            _exclude(dataset, season, "", "download_status.csv", "season_snapshot_rejected", str(exc))
            continue
        coverage.update(export_status="complete", export_complete=True, snapshot_stable=True,
                        capture_completed_at_utc=utc_stamp(completed))
        dataset.sources.extend(sources)
        try:
            _load_one(dataset, season, contents, completed, coverage, league_id, fixture_occurrences)
        except (ValueError, UnicodeError, csv.Error) as exc:
            dataset.matches = [match for match in dataset.matches if match.season != season]
            coverage.update(schedule_complete=False, season_finished=False, notes=f"invalid_csv_schema: {exc}")
            for source in sources:
                source["snapshot_accepted"] = False
            _exclude(dataset, season, "", "", "invalid_csv_schema", str(exc))
    duplicate_ids = {fid for fid, season_names in fixture_occurrences.items() if len(season_names) > 1}
    if duplicate_ids:
        for match in dataset.matches:
            if match.fixture_id in duplicate_ids:
                _exclude(dataset, match.season, match.fixture_id, "fixtures.csv", "fixture_id_repeated_across_seasons")
                for coverage in dataset.coverage:
                    if coverage["season"] == match.season:
                        coverage["schedule_complete"] = False
                        coverage["season_finished"] = False
        dataset.matches = [match for match in dataset.matches if match.fixture_id not in duplicate_ids]
    dataset.matches.sort(key=lambda match: (match.kickoff, match.fixture_id))
    # Recount after global exclusions so audit counts agree with actual inputs.
    for coverage in dataset.coverage:
        season = coverage["season"]
        matches = [match for match in dataset.matches if match.season == season]
        coverage["valid_completed_matches"] = sum(match.state == "FT" for match in matches)
        coverage["valid_scheduled_matches"] = sum(match.state == "NS" for match in matches)
        coverage["excluded_fixture_count"] = len({row["fixture_id"] for row in dataset.exclusions
                                                   if row["season"] == season and row["fixture_id"]})
    return dataset
