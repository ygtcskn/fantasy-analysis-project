"""Prepare player and team match statistics before radar scoring in the browser.

The output is one CSV per season under data/final/spider/<season>/spider_stats.csv.
It contains only saved match facts; percentiles and PCA are calculated after it
loads, against the selected season and its earlier-season reference population.
No provider requests are made.
"""
from __future__ import annotations

import argparse
import csv
from collections import defaultdict
from pathlib import Path

from src.shared import nonnegative, season_folder, write_csv


ROOT = Path(__file__).resolve().parents[2]
SOURCE_ROOT = ROOT / "data/final/sportmonks"
OUTPUT_ROOT = ROOT / "data/final/spider"
META = ("entity_type", "fixture_id", "player_id", "team_id", "name", "position",
        "started", "minutes_played", "rating")


def read_required(path: Path) -> tuple[list[str], list[dict]]:
    if not path.is_file():
        raise FileNotFoundError(path)
    with path.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        if not reader.fieldnames:
            raise ValueError(f"Missing CSV header: {path}")
        return reader.fieldnames, list(reader)


def formatted(value: float) -> str:
    return str(int(value)) if value.is_integer() else format(value, ".12g")


def player_key_passes(rows: list[dict]) -> str:
    """Supplement a missing team value only from a covered, played player set.

    A positive player event is evidence; an all-blank set is not evidence of a
    team zero. At least eleven played rows with other statistics are required.
    Published team values always take precedence because player and team feeds
    can differ by one or two events.
    """
    played = [row for row in rows if (nonnegative(row.get("minutes_played")) or 0) > 0]
    covered = [row for row in played if any(str(row.get(key) or "").strip()
                for key in ("passes", "touches", "shots_total", "fouls"))]
    if len(played) < 11 or len(covered) < 11:
        return ""
    observed = [nonnegative(row.get("key_passes")) for row in played]
    if not any(value is not None and value > 0 for value in observed):
        return ""
    return formatted(sum(value or 0 for value in observed))


def prepare_season(source: Path) -> tuple[list[dict], list[str]]:
    player_columns, players = read_required(source / "player_match_stats.csv")
    _, records = read_required(source / "team_metrics.csv")
    if not {"fixture_id", "player_id", "team_id"}.issubset(player_columns):
        raise ValueError("player_match_stats.csv lacks player/fixture keys")
    if records and not {"fixture_id", "team_id", "name", "value"}.issubset(records[0]):
        raise ValueError("team_metrics.csv lacks team/fixture/metric fields")

    player_fields = [column for column in player_columns if column not in META]
    by_team: dict[tuple[str, str], dict[str, str]] = {}
    team_fields: set[str] = set()
    for record in records:
        fixture, team = record.get("fixture_id", ""), record.get("team_id", "")
        metric = record.get("name", "").strip().lower()
        if not fixture or not team or not metric:
            continue
        value = record.get("value", "")
        row = by_team.setdefault((fixture, team), {})
        if metric in row and row[metric] != value:
            raise ValueError(f"Conflicting team statistic: {fixture}/{team}/{metric}")
        row[metric] = value
        team_fields.add(metric)

    players_by_team: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for player in players:
        players_by_team[(player.get("fixture_id", ""), player.get("team_id", ""))].append(player)

    # The opponent's published match row supplies conceded statistics. A
    # one-sided fixture remains unknown rather than implying a clean sheet.
    opponents: dict[str, list[str]] = defaultdict(list)
    for fixture, team in by_team:
        opponents[fixture].append(team)
    team_fields.update(("goals_conceded", "shots_conceded",
                        "shots_on_target_conceded", "expected_goals_against", "key_passes"))
    team_fields.update(("key_passes_source", "opponent_present"))

    columns = [*META, *(f"p_{name}" for name in player_fields),
               *(f"t_{name}" for name in sorted(team_fields))]
    output: list[dict] = []
    for player in players:
        output.append({**{key: player.get(key, "") for key in META},
                       "entity_type": "player",
                       **{f"p_{key}": player.get(key, "") for key in player_fields}})
    for (fixture, team), values in sorted(by_team.items()):
        own = dict(values)
        pair = opponents[fixture]
        own["opponent_present"] = "1" if len(pair) == 2 else "0"
        if len(pair) == 2:
            other = by_team[(fixture, pair[0] if pair[1] == team else pair[1])]
            for target, source_name in (("goals_conceded", "goals"),
                                        ("shots_conceded", "shots_total"),
                                        ("shots_on_target_conceded", "shots_on_target")):
                own[target] = other.get(source_name, "")
            if not own.get("expected_goals_against", ""):
                own["expected_goals_against"] = other.get("expected_goals", "")
        if own.get("key_passes", ""):
            own["key_passes_source"] = "team_provider"
        else:
            supplemental = player_key_passes(players_by_team.get((fixture, team), []))
            if supplemental:
                own["key_passes"] = supplemental
                own["key_passes_source"] = "player_sum"
            else:
                own["key_passes_source"] = "missing"
        output.append({"entity_type": "team", "fixture_id": fixture, "team_id": team,
                       "position": "TEAM", "minutes_played": "90",
                       **{f"t_{key}": value for key, value in own.items()}})
    return output, columns


def build_season(season: str, source_root: Path = SOURCE_ROOT,
                 output_root: Path = OUTPUT_ROOT) -> Path:
    slug = season_folder(season)
    rows, columns = prepare_season(source_root / slug)
    target = output_root / slug / "spider_stats.csv"
    write_csv(target, rows, columns)
    return target


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--season", help="Season such as 2026/2027")
    parser.add_argument("--all-seasons", action="store_true", help="Build every saved season with both inputs")
    parser.add_argument("--source-root", type=Path, default=SOURCE_ROOT)
    parser.add_argument("--output-root", type=Path, default=OUTPUT_ROOT)
    args = parser.parse_args(argv)
    if args.all_seasons == bool(args.season):
        parser.error("Choose exactly one of --season or --all-seasons")
    seasons = ([args.season] if args.season else sorted(path.name for path in args.source_root.iterdir()
               if path.is_dir() and (path / "player_match_stats.csv").is_file()
               and (path / "team_metrics.csv").is_file()))
    for season in seasons:
        print(build_season(season, args.source_root, args.output_root))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
