"""Rebuild fantasy points, projections, website tables and SQLite from saved CSVs.

Run this after refreshing Sportmonks and the reviewed TFF player table.
No downloads, browser exports or provider requests are triggered here.
"""
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import hashlib
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.points import run as points
from src.player_projections import run as projections
from src.tables import common as tables_common
from src.tables import run as tables
from src.spider.build_spider_stats import build_season as build_spider_stats
from src.fetch.build_database import build_database


def input_manifest(data_root: Path, rules_path: Path) -> list[dict]:
    """Fingerprint the inputs shared by both stages; never include credentials."""
    paths = [rules_path, data_root / "final/tff_fantasy/tff_players.csv"]
    sportmonks = data_root / "final/sportmonks"
    for folder in sorted(sportmonks.iterdir()):
        if not folder.is_dir() or not re.fullmatch(r"\d{4}-\d{4}", folder.name):
            continue
        paths.extend(folder / name for name in (
            "download_status.csv", "fixtures.csv", "fixture_scores.csv", "teams.csv",
            "player_match_stats.csv", "team_metrics.csv", "team_sidelined.csv", "fixture_sidelined.csv",
        ))
    return [{"path": str(path.resolve()), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()
             if path.is_file() else "missing"} for path in paths]


def tag_generation(path: Path, run_id: str) -> None:
    with path.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        if not reader.fieldnames:
            raise ValueError(f"Output has no CSV header: {path}")
        columns = [key for key in reader.fieldnames if key != "pipeline_run_id"] + ["pipeline_run_id"]
        rows = [dict(row, pipeline_run_id=run_id) for row in reader]
    points.write_csv(path, rows, columns)


def publish_file(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.publishing")
    try:
        shutil.copyfile(source, temporary)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--season", default="2026/2027", help="Current TFF snapshot season.")
    parser.add_argument("--matchweek", type=int, help="Optional target round; default is next complete unstarted round.")
    parser.add_argument("--reconcile-before", help="Explicit TFF reconciliation fixture cutoff (YYYY-MM-DD).")
    parser.add_argument("--skip-database", action="store_true", help="Publish CSVs only; leave SQLite unchanged.")
    parser.add_argument("--data-root", type=Path, default=ROOT / "data")
    parser.add_argument("--rules", type=Path, default=ROOT / "config/tff_scoring_rules.csv")
    args = parser.parse_args(argv)
    run = None
    try:
        season = points.season_folder(args.season)
        data_root = args.data_root.resolve()
        inputs = data_root / "final/sportmonks"
        tff_csv = data_root / "final/tff_fantasy/tff_players.csv"
        status = points.read_csv(inputs / season / "download_status.csv")
        if len(status) != 1 or status[0].get("status") != "complete":
            raise ValueError("Finish the target Sportmonks season download first.")
        if not tff_csv.is_file():
            raise ValueError("Refresh the reviewed TFF player CSV first.")
        before = input_manifest(data_root, args.rules)
        generated = datetime.now(timezone.utc)
        run_id = f"{generated:%Y%m%dT%H%M%SZ}_{uuid.uuid4().hex[:8]}"
        run = data_root / "temp/fantasy_pipeline/runs" / run_id
        stage = run / "publish"
        points.write_csv(run / "input_manifest.csv", before)
        points_args = ["--input-root", str(inputs), "--tff-players", str(tff_csv),
                       "--rules", str(args.rules), "--tff-season", season,
                       "--reconcile-season", season,
                       "--output-root", str(stage / "points"),
                       "--runs-root", str(data_root / "temp/points/runs")]
        if args.reconcile_before:
            points_args.extend(["--reconcile-before", args.reconcile_before])
        print("1/4 Rebuilding reconstructed fantasy points from completed matches...")
        if points.main(points_args):
            raise ValueError("Points stage failed; final files were not published.")
        projection_args = ["--season", season, "--input-root", str(inputs),
                           "--tff-players", str(tff_csv), "--rules", str(args.rules),
                           "--points-path", str(stage / "points/player_match_points.csv"),
                           "--output-root", str(stage / "player_projections"),
                           "--runs-root", str(data_root / "temp/player_projections/runs")]
        if args.matchweek is not None:
            projection_args.extend(["--matchweek", str(args.matchweek)])
        print("2/4 Generating player projections and availability...")
        if projections.main(projection_args):
            raise ValueError("Projection stage failed; final files were not published.")
        if input_manifest(data_root, args.rules) != before:
            raise ValueError("Saved source files changed during the build. Rerun after downloads finish.")
        relative_files = [Path("points/player_match_points.csv"), Path("points/player_season_summary.csv"),
                          Path("player_projections") / season / "player_projections.csv",
                          Path("player_projections") / season / "team_fixture_projections.csv"]
        for relative in relative_files:
            tag_generation(stage / relative, run_id)
        # Every season total, ranking and percentile the website shows. Built
        # from the same staged points, so a table never mixes this run's
        # statistics with the previous run's fantasy points.
        print("3/4 Building the website tables...")
        built = tables_common.Season(season, inputs, stage / "tables", stage)
        _, failed = tables.build_season(built)
        if failed:
            raise ValueError(f"{failed} table(s) failed; final files were not published.")
        relative_files.extend(Path("tables") / season / path.name
                              for path in sorted((stage / "tables" / season).glob("*.csv")))
        # Radar scoring needs the current season and every saved earlier season
        # prepared before the browser forms a common reference population.
        spider_seasons = sorted(folder.name for folder in inputs.iterdir() if folder.is_dir()
                                and (folder / "player_match_stats.csv").is_file()
                                and (folder / "team_metrics.csv").is_file()
                                and folder.name <= season)
        for spider_season in spider_seasons:
            build_spider_stats(spider_season, inputs, stage / "spider")
            relative_files.append(Path("spider") / spider_season / "spider_stats.csv")
        marker = Path("fantasy_pipeline") / season / "pipeline_status.csv"
        tff_rows = points.read_csv(tff_csv)
        points.write_csv(stage / marker, [{
            "status": "complete", "season": season, "pipeline_run_id": run_id,
            "generated_at_utc": points.stamp(datetime.now(timezone.utc)),
            "sportmonks_finished_at_utc": status[0].get("finished_at_utc", ""),
            "tff_updated_at_utc": max((row.get("updated_at_utc", "") for row in tff_rows), default=""),
            "tff_snapshot_file": " ".join(sorted({row.get("snapshot_file", "") for row in tff_rows})),
            "points_kind": "reconstructed", "projection_kind": "experimental_component_model",
        }])
        database_target = data_root / "superlig.sqlite"
        if not args.skip_database:
            print("4/4 Building SQLite with points and projections...")
            if any(Path(str(database_target) + suffix).exists() for suffix in ("-wal", "-shm", "-journal")):
                raise ValueError("Close SQLite connections before rebuilding, or use --skip-database.")
            build_database(inputs / season, run / "superlig.sqlite", tff_csv=tff_csv,
                           sportmonks_prefix="sportmonks_", fantasy_root=stage, fantasy_season=season)
        if input_manifest(data_root, args.rules) != before:
            raise ValueError("Saved source files changed during the build. Rerun after downloads finish.")
        # Publish the marker last. The website rejects any rows with a different
        # generation, including a partial publication interrupted by a file lock.
        if not args.skip_database:
            publish_file(run / "superlig.sqlite", database_target)
        for relative in relative_files:
            publish_file(stage / relative, data_root / "final" / relative)
        publish_file(stage / marker, data_root / "final" / marker)
        points.write_csv(run / "run_status.csv", [{"status": "complete", "pipeline_run_id": run_id,
                         "season": season, "database_built": not args.skip_database}])
        print(f"Fantasy pipeline complete. Run record: {run}")
        print("Reload the website to read the published tables, points and projections.")
        return 0
    except (OSError, ValueError, RuntimeError, sqlite3.Error) as error:
        if run:
            points.write_csv(run / "run_status.csv", [{"status": "failed", "message": str(error)}])
        print(f"Fantasy pipeline failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
