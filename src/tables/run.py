"""Build every published table for one season.

    python -m src.tables.run --season 2026/2027

Reads only saved CSVs under ``data/final/sportmonks/<season>/`` and what the
earlier pipeline stages published under ``data/final/``. Makes no provider
requests and writes nothing outside the output folder.

Each module is independent: one that cannot build its table - because the
export lacks a file it needs - is reported in ``tables_status.csv`` and does
not stop the others.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path
import sys

if __package__ in (None, ""):  # Allow "python src/tables/run.py" as well as -m.
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    __package__ = "src.tables"

from . import common  # noqa: E402
from . import player_leaders, player_season, standings, team_leaders, team_results, team_season  # noqa: E402

# Build order. A module may read another's rows through the season cache, so the
# ones others depend on come first.
MODULES = [
    ("team_results", team_results),
    ("standings", standings),
    ("player_season", player_season),
    ("player_leaders", player_leaders),
    ("team_season", team_season),
    ("team_leaders", team_leaders),
]

STATUS_COLUMNS = ["table", "module", "rows", "status", "message", "generated_at_utc"]


def build_season(season: common.Season, only=None) -> tuple[list[dict], int]:
    """Write every table and return the status rows and how many modules failed."""
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    status, failures = [], 0
    for name, module in MODULES:
        if only and name not in only:
            continue
        try:
            tables = module.build(season)
        except (OSError, ValueError, KeyError, ZeroDivisionError) as error:
            failures += 1
            status.append({"table": "", "module": name, "rows": 0, "status": "failed",
                           "message": str(error), "generated_at_utc": stamp})
            print(f"  {name}: failed - {error}", file=sys.stderr)
            continue
        for table in tables:
            common.write_csv(season.output / table.name, table.rows, table.columns)
            status.append({"table": table.name, "module": name, "rows": len(table.rows),
                           "status": "complete", "message": "", "generated_at_utc": stamp})
            print(f"  {table.name}: {len(table.rows)} rows")
    common.write_csv(season.output / "tables_status.csv", status, STATUS_COLUMNS)
    return status, failures


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--season", default="2026/2027", help="Season to build, like 2026/2027.")
    parser.add_argument("--source-root", type=Path, default=common.SOURCE_ROOT,
                        help="Folder holding the saved season folders.")
    parser.add_argument("--output-root", type=Path, default=common.OUTPUT_ROOT,
                        help="Where the published tables are written.")
    parser.add_argument("--published-root", type=Path, default=common.FINAL_ROOT,
                        help="Where the earlier stages' published CSVs are read from.")
    parser.add_argument("--only", nargs="*", metavar="MODULE",
                        help=f"Build only these modules: {', '.join(name for name, _ in MODULES)}.")
    args = parser.parse_args(argv)
    unknown = set(args.only or []) - {name for name, _ in MODULES}
    if unknown:
        parser.error(f"Unknown module(s): {', '.join(sorted(unknown))}")
    try:
        season = common.Season(args.season, args.source_root, args.output_root, args.published_root)
    except ValueError as error:
        print(f"Tables failed: {error}", file=sys.stderr)
        return 1
    print(f"Building tables for {season.slug} into {season.output}")
    _, failures = build_season(season, args.only)
    if failures:
        print(f"Tables finished with {failures} failed module(s); see tables_status.csv.", file=sys.stderr)
        return 1
    print("Tables complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
