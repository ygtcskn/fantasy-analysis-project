"""Write the public website: the pages plus one season's data files, ready to
upload to Cloudflare Pages. Reads data/final only; no provider requests.

The output mirrors what src/web/serve.py serves, at the same paths, so the pages
need no separate code for the public site. What it cannot do without a server -
live scores and Kadro Kur recommendations - is switched off by core/site.js.
"""

import argparse
import csv
from pathlib import Path
import re
import shutil
import sys


WEB_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = WEB_ROOT.parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.web.serve import (  # noqa: E402
    ASSET_PATH, CSV_NAMES, DATA_ROOT, FINAL_ROOT, HISTORY_NAMES, OPTIONAL_CSV_NAMES,
    analysis_files, history_seasons, season_name,
)


SITE_ROOT = PROJECT_ROOT / "data" / "temp" / "site"
STAGING_ROOT = SITE_ROOT.with_name("site-partial")
# Cloudflare Pages refuses any single file above 25 MiB.
MAX_FILE_BYTES = 25 * 1024 * 1024
# No page uses them, and they are third-party artwork that is not ours to publish.
EXCLUDED_ASSETS = ("assets/face-portraits/",)
TABLE_NAME = re.compile(r"[a-z0-9_]+\.csv")
SITE_FLAG = ("const SITE_PUBLISHED = false;", "const SITE_PUBLISHED = true;")
# The first line of _headers marks a folder as this script's output, so a
# rebuild never deletes a folder it did not write.
BUILD_MARK = "# Written by src/web/build_static.py; rebuilt on every run."


def is_build(folder):
    headers = folder / "_headers"
    return headers.is_file() and headers.read_text(encoding="utf-8").startswith(BUILD_MARK)


def remove_build(folder):
    if not folder.exists():
        return
    if not folder.is_dir() or (any(folder.iterdir()) and not is_build(folder)):
        raise SystemExit(f"{folder} exists but was not written by this script. Move it away and run again.")
    shutil.rmtree(folder)


def web_files():
    """Site files by published path, under the same rules serve.py applies."""
    files = {}
    for source in sorted(WEB_ROOT.rglob("*")):
        relative = source.relative_to(WEB_ROOT).as_posix()
        if source.is_file() and ASSET_PATH.fullmatch(f"/{relative}") and not relative.startswith(EXCLUDED_ASSETS):
            files[relative] = source
    return files


def data_files(season):
    """Data files by their /local-data/ path, and the files the site can do without
    that are missing. Only seasons before the served one are published as
    history: the radar never reads a later or the same season from there."""
    csv_root = DATA_ROOT / season
    missing_required = sorted(name for name in CSV_NAMES if not (csv_root / name).is_file())
    if missing_required:
        raise SystemExit(f"Missing season CSVs in {csv_root}: {', '.join(missing_required)}")
    wanted = {name: csv_root / name for name in sorted(CSV_NAMES | OPTIONAL_CSV_NAMES)}
    wanted.update(analysis_files(season))
    wanted["spider/spider_stats.csv"] = FINAL_ROOT / "spider" / season / "spider_stats.csv"
    tables_root = FINAL_ROOT / "tables" / season
    if tables_root.is_dir():
        wanted.update({f"tables/{source.name}": source for source in sorted(tables_root.iterdir())
                       if source.is_file() and TABLE_NAME.fullmatch(source.name)})
    earlier = [name for name in history_seasons() if name < season]
    for name in earlier:
        for file in sorted(HISTORY_NAMES):
            root = FINAL_ROOT / "spider" / name if file == "spider_stats.csv" else DATA_ROOT / name
            wanted[f"history/{name}/{file}"] = root / file
    files = {path: source for path, source in wanted.items() if source.is_file()}
    absent = sorted(path for path in wanted if path not in files)
    return files, absent, earlier


def headers_file(season):
    # The pages check these two headers before trusting a data file; serve.py
    # sends the same pair.
    return (f"{BUILD_MARK}\n"
            "/*\n"
            "  X-Content-Type-Options: nosniff\n"
            "  Referrer-Policy: strict-origin-when-cross-origin\n"
            "/local-data/*\n"
            "  X-Superlig-Local: 1\n"
            f"  X-Superlig-Season: {season}\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--season", type=season_name, default="2026/2027")
    args = parser.parse_args()
    season = args.season

    site = web_files()
    data, absent, earlier = data_files(season)
    site.update({f"local-data/{path}": source for path, source in data.items()})
    too_large = sorted(path for path, source in site.items() if source.stat().st_size > MAX_FILE_BYTES)
    if too_large:
        raise SystemExit(f"Cloudflare Pages accepts files up to 25 MiB; too large: {', '.join(too_large)}")
    if "core/site.js" not in site or "404.html" not in site:
        raise SystemExit("src/web/core/site.js and src/web/404.html are required.")

    remove_build(STAGING_ROOT)
    STAGING_ROOT.mkdir(parents=True)
    # Written first, so an interrupted run still leaves a folder a rerun may delete.
    (STAGING_ROOT / "_headers").write_text(headers_file(season), encoding="utf-8", newline="\n")
    for path, source in site.items():
        target = STAGING_ROOT / path
        target.parent.mkdir(parents=True, exist_ok=True)
        if path == "core/site.js":
            text = source.read_text(encoding="utf-8")
            if text.count(SITE_FLAG[0]) != 1:
                raise SystemExit(f"Expected one '{SITE_FLAG[0]}' line in {source}.")
            target.write_text(text.replace(*SITE_FLAG), encoding="utf-8", newline="")
        else:
            shutil.copyfile(source, target)
    with (STAGING_ROOT / "local-data" / "history" / "seasons.csv").open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["season"])
        writer.writerows([name] for name in earlier)

    remove_build(SITE_ROOT)
    STAGING_ROOT.rename(SITE_ROOT)

    total = sum(path.stat().st_size for path in SITE_ROOT.rglob("*") if path.is_file())
    count = sum(1 for path in SITE_ROOT.rglob("*") if path.is_file())
    print(f"Wrote {count} files ({total / 1024 / 1024:.1f} MB) to {SITE_ROOT}")
    print(f"Season {season}; radar history: {', '.join(earlier) or 'none'}")
    if absent:
        print("Not published because they do not exist yet; the pages that use them will say so:")
        for path in absent:
            print(f"  {path}")
    print("Upload with:")
    print(f"  npx wrangler pages deploy {SITE_ROOT.relative_to(PROJECT_ROOT).as_posix()} --project-name fantezianaliz --branch main")


if __name__ == "__main__":
    main()
