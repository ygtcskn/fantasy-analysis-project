"""User-run, transactional CSV-to-SQLite build. No provider API calls."""
import argparse
from contextlib import closing
import csv
from datetime import datetime, timezone
import math
import os
from pathlib import Path
import re
import sqlite3
import uuid

if __package__:
    from .sportmonks import DATA, ROOT
else:
    from sportmonks import DATA, ROOT

SKIP = {"download_status", "included_feeds", "unavailable", "file_inventory", "validation"}
PRIMARY_KEYS = {
    "fixtures": ("fixture_id",), "teams": ("id",), "players": ("id",),
    "squads": ("season_id", "team_id", "player_id"),
    "player_match_stats": ("fixture_id", "player_id"),
    "events": ("fixture_id", "event_id"),
}
INTEGER = re.compile(r"-?(?:0|[1-9][0-9]*)\Z")
NUMBER = re.compile(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?\Z")


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def value_type(value):
    if value == "": return None
    if INTEGER.fullmatch(value):
        number = int(value)
        return "INTEGER" if -(2**63) <= number < 2**63 else "TEXT"
    if NUMBER.fullmatch(value) and math.isfinite(float(value)): return "REAL"
    return "TEXT"


def inspect_csv(path):
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        fields = reader.fieldnames
        if not fields or len(fields) != len(set(fields)) or any(not f for f in fields):
            raise ValueError(f"Invalid CSV headers: {path.name}")
        kinds = {field: set() for field in fields}
        count = 0
        for row in reader:
            if None in row or any(v is None for v in row.values()):
                raise ValueError(f"Ragged CSV row: {path.name}:{reader.line_num}")
            count += 1
            for field, value in row.items():
                kind = value_type(value)
                if kind: kinds[field].add(kind)
    types = {}
    for field, values in kinds.items():
        types[field] = "TEXT" if not values or "TEXT" in values else "REAL" if "REAL" in values else "INTEGER"
    return fields, types, count


def convert(value, kind):
    if value == "": return None
    if kind == "INTEGER": return int(value)
    if kind == "REAL": return float(value)
    return value


def fantasy_inputs(root, season):
    """Accept only the outputs covered by a complete pipeline generation."""
    root = Path(root).resolve()
    season = str(season).replace("/", "-")
    if not re.fullmatch(r"[0-9]{4}-[0-9]{4}", season):
        raise ValueError("Fantasy season must look like 2026/2027 or 2026-2027.")
    marker = root / "fantasy_pipeline" / season / "pipeline_status.csv"
    if not marker.is_file():
        raise ValueError(f"Fantasy pipeline status is missing: {marker}")
    captured_marker = marker.read_bytes()
    inspect_csv(marker)
    with marker.open(encoding="utf-8-sig", newline="") as handle:
        statuses = list(csv.DictReader(handle))
    if len(statuses) != 1 or statuses[0].get("status") != "complete":
        raise ValueError("The fantasy pipeline is not marked complete.")
    run_id = statuses[0].get("pipeline_run_id", "")
    if not run_id.strip():
        raise ValueError("Fantasy pipeline status has no pipeline_run_id.")
    if statuses[0].get("season") not in (None, "", season):
        raise ValueError("Fantasy pipeline status belongs to another season.")
    inputs = (
        ("points_player_match_points", root / "points" / "player_match_points.csv",
         ("season", "fixture_id", "player_id")),
        ("points_player_season_summary", root / "points" / "player_season_summary.csv",
         ("season", "player_id")),
        ("player_projections", root / "player_projections" / season / "player_projections.csv",
         ("season", "fixture_id", "player_id")),
    )
    for _, path, _ in inputs:
        if not path.is_file():
            raise ValueError(f"Fantasy output is missing: {path}")
    return root, season, run_id, inputs, marker, captured_marker


def import_fantasy(db, root, season, run_id, inputs):
    counts = {}
    for table, path, keys in inputs:
        fields, types, count = inspect_csv(path)
        required = {*keys, "pipeline_run_id"}
        if not required.issubset(fields):
            raise ValueError(f"{path.name} is missing fantasy identity or generation columns.")
        types["pipeline_run_id"] = "TEXT"
        definitions = [f"{quote(field)} {types[field]}{' NOT NULL' if field in required else ''}"
                       for field in fields]
        definitions.append("PRIMARY KEY (" + ",".join(map(quote, keys)) + ")")
        db.execute(f"CREATE TABLE {quote(table)} ({','.join(definitions)})")
        query = (f"INSERT INTO {quote(table)} ({','.join(map(quote, fields))}) "
                 f"VALUES ({','.join('?' for _ in fields)})")
        seen = set()

        def checked_rows():
            with path.open(encoding="utf-8-sig", newline="") as handle:
                reader = csv.DictReader(handle)
                if reader.fieldnames != fields:
                    raise ValueError(f"Fantasy CSV changed while reading: {path.name}")
                for row in reader:
                    if None in row or any(value is None for value in row.values()):
                        raise ValueError(f"Ragged CSV row: {path.name}:{reader.line_num}")
                    key = tuple(row[field] for field in keys)
                    if any(not value.strip() or value != value.strip() for value in key):
                        raise ValueError(f"Blank or malformed fantasy key in {path.name}:{reader.line_num}")
                    if key in seen:
                        raise ValueError(f"Duplicate fantasy key in {path.name}:{reader.line_num}: {key}")
                    seen.add(key)
                    if row["pipeline_run_id"] != run_id:
                        raise ValueError(f"Mixed fantasy pipeline generations in {path.name}:{reader.line_num}")
                    if table == "player_projections" and row["season"] != season:
                        raise ValueError(f"Projection season mismatch in {path.name}:{reader.line_num}")
                    yield [convert(row[field], types[field]) for field in fields]

        db.executemany(query, checked_rows())
        actual = db.execute(f"SELECT COUNT(*) FROM {quote(table)}").fetchone()[0]
        if actual != count:
            raise ValueError(f"Row count mismatch: {path.name}")
        for field in ("fixture_id", "player_id", "team_id", "season", "pipeline_run_id"):
            if field in fields:
                db.execute(f"CREATE INDEX {quote('idx_' + table + '_' + field)} "
                           f"ON {quote(table)} ({quote(field)})")
        db.execute("INSERT INTO import_log VALUES (?,?,?)", (
            path.relative_to(root).as_posix(), count, datetime.now(timezone.utc).isoformat()))
        counts[table] = count
    return counts


def build_database(csv_dir, output, tff_csv=None, sportmonks_prefix="",
                   fantasy_root=None, fantasy_season=None):
    if (fantasy_root is None) != (fantasy_season is None):
        raise ValueError("fantasy_root and fantasy_season must be supplied together.")
    fantasy = fantasy_inputs(fantasy_root, fantasy_season) if fantasy_root is not None else None
    csv_dir, output = Path(csv_dir).resolve(), Path(output).resolve()
    status_file = csv_dir / "download_status.csv"
    if not status_file.exists(): raise ValueError("download_status.csv is missing. Finish the download first.")
    with status_file.open(encoding="utf-8-sig", newline="") as handle:
        statuses = list(csv.DictReader(handle))
    if len(statuses) != 1 or statuses[0].get("status") != "complete":
        raise ValueError("The CSV download is not marked complete; existing database was not changed.")
    paths = sorted(path for path in csv_dir.glob("*.csv") if path.stem not in SKIP)
    if not any(path.stem == "fixtures" for path in paths): raise ValueError("fixtures.csv is missing.")
    for suffix in ("-wal", "-shm", "-journal"):
        if Path(str(output) + suffix).exists():
            raise ValueError("Close database connections and checkpoint the existing database before rebuilding.")
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_name(f".{output.stem}-{uuid.uuid4().hex}.building.sqlite")
    counts = {}
    try:
        with closing(sqlite3.connect(temp)) as db:
            with db:
                db.execute("CREATE TABLE import_log (file TEXT PRIMARY KEY, rows INTEGER, imported_at_utc TEXT)")
                for path in paths:
                    table = sportmonks_prefix + path.stem
                    fields, types, count = inspect_csv(path)
                    keys = PRIMARY_KEYS.get(path.stem, ())
                    if any(key not in fields for key in keys): raise ValueError(f"Missing primary key in {path.name}")
                    definitions = [f"{quote(f)} {types[f]}{' NOT NULL' if f in keys else ''}" for f in fields]
                    if keys: definitions.append("PRIMARY KEY (" + ",".join(map(quote, keys)) + ")")
                    db.execute(f"CREATE TABLE {quote(table)} ({','.join(definitions)})")
                    query = f"INSERT INTO {quote(table)} ({','.join(map(quote,fields))}) VALUES ({','.join('?' for _ in fields)})"
                    with path.open(encoding="utf-8-sig", newline="") as handle:
                        rows = csv.DictReader(handle)
                        db.executemany(query, ([convert(row[field], types[field]) for field in fields] for row in rows))
                    actual = db.execute(f"SELECT COUNT(*) FROM {quote(table)}").fetchone()[0]
                    if actual != count: raise ValueError(f"Row count mismatch: {path.name}")
                    for field in ("fixture_id", "player_id", "team_id", "season_id"):
                        if field in fields and keys != (field,):
                            db.execute(f"CREATE INDEX {quote('idx_' + table + '_' + field)} ON {quote(table)} ({quote(field)})")
                    db.execute("INSERT INTO import_log VALUES (?,?,?)", (path.name, count, datetime.now(timezone.utc).isoformat()))
                    counts[table] = count
                if tff_csv is not None:
                    tff_csv = Path(tff_csv).resolve()
                    if not tff_csv.is_file():
                        raise ValueError(f"TFF final table is missing: {tff_csv}")
                    table = "tff_players"
                    fields, types, count = inspect_csv(tff_csv)
                    if "sportmonks_player_id" not in fields or "match_status" not in fields:
                        raise ValueError("tff_players.csv is missing identity columns.")
                    definitions = [f"{quote(field)} {types[field]}" for field in fields]
                    db.execute(f"CREATE TABLE {quote(table)} ({','.join(definitions)})")
                    query = (f"INSERT INTO {quote(table)} ({','.join(map(quote, fields))}) "
                             f"VALUES ({','.join('?' for _ in fields)})")
                    with tff_csv.open(encoding="utf-8-sig", newline="") as handle:
                        rows = csv.DictReader(handle)
                        db.executemany(query, ([convert(row[field], types[field])
                                                for field in fields] for row in rows))
                    actual = db.execute(f"SELECT COUNT(*) FROM {quote(table)}").fetchone()[0]
                    if actual != count:
                        raise ValueError("Row count mismatch: tff_players.csv")
                    duplicate_ids = db.execute(
                        "SELECT COUNT(*) FROM (SELECT sportmonks_player_id FROM tff_players "
                        "WHERE sportmonks_player_id IS NOT NULL GROUP BY sportmonks_player_id "
                        "HAVING COUNT(*) > 1)").fetchone()[0]
                    if duplicate_ids:
                        raise ValueError("tff_players contains duplicate assigned Sportmonks IDs.")
                    db.execute("CREATE INDEX idx_tff_players_sportmonks_player_id "
                               "ON tff_players (sportmonks_player_id)")
                    db.execute("INSERT INTO import_log VALUES (?,?,?)", (
                        tff_csv.name, count, datetime.now(timezone.utc).isoformat()))
                    counts[table] = count
                if fantasy is not None:
                    counts.update(import_fantasy(db, *fantasy[:4]))
                player_stats = sportmonks_prefix + "player_match_stats"
                fixtures = sportmonks_prefix + "fixtures"
                if player_stats in counts:
                    orphans = db.execute(
                        f"SELECT COUNT(*) FROM {quote(player_stats)} p "
                        f"LEFT JOIN {quote(fixtures)} f USING(fixture_id) "
                        "WHERE f.fixture_id IS NULL").fetchone()[0]
                    if orphans: raise ValueError(f"Found {orphans} player rows without a fixture.")
            if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok": raise ValueError("SQLite integrity check failed.")
        try:
            if fantasy is not None and fantasy[4].read_bytes() != fantasy[5]:
                raise ValueError("Fantasy pipeline status changed during the build; existing database was not changed.")
            os.replace(temp, output)
        except PermissionError:
            raise ValueError(
                f"Cannot replace {output}: the database is open in another program. "
                "Disconnect the superlig data source (closing only the SQL tab may not be enough), "
                "then run the build again.") from None
    finally:
        # Only the uniquely named temporary file created by this build is removed.
        if temp.exists(): temp.unlink()
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--season", default="2026/2027")
    parser.add_argument("--csv-dir", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--tff-csv", type=Path)
    parser.add_argument("--include-fantasy", action="store_true",
                        help="Include points and player projections from a completed fantasy pipeline run.")
    parser.add_argument("--fantasy-root", type=Path,
                        help="Fantasy CSV root (default: data/final); requires --include-fantasy.")
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9]{4}/[0-9]{4}", args.season): parser.error("Use a season such as 2026/2027.")
    if args.fantasy_root is not None and not args.include_fantasy:
        parser.error("--fantasy-root requires --include-fantasy.")
    folder = DATA / args.season.replace("/", "-")
    try:
        output = args.output or ROOT / "data" / "superlig.sqlite"
        tff_csv = args.tff_csv or ROOT / "data" / "final" / "tff_fantasy" / "tff_players.csv"
        fantasy_root = (args.fantasy_root or ROOT / "data" / "final") if args.include_fantasy else None
        counts = build_database(args.csv_dir or folder, output, tff_csv, "sportmonks_",
                                fantasy_root=fantasy_root,
                                fantasy_season=args.season if args.include_fantasy else None)
        print(f"Built {output}: {len(counts)} tables")
    except (ValueError, OSError, sqlite3.Error) as exc:
        parser.exit(1, f"Error: {exc}\n")


if __name__ == "__main__": main()
