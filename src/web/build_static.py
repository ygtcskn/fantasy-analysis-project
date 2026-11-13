"""Write the public website: the pages plus one season's data files, ready to
upload to Cloudflare Pages. No provider requests.

The website code comes from GitHub: main as last pushed, never this folder's
unpushed or uncommitted edits, so work in progress cannot go live with a data
update. Pushing is how code is published. The data comes from data/final.
--local-code publishes this folder's code instead, to preview before pushing.

The output mirrors what src/web/serve.py serves, at the same paths, so the pages
need no separate code for the public site. What it cannot do without a server -
live scores and Kadro Kur recommendations - is switched off by core/site.js.
"""

import argparse
import csv
import io
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile


WEB_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = WEB_ROOT.parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.shared import season_folder  # noqa: E402
from src.web.serve import (  # noqa: E402
    ASSET_PATH, CSV_NAMES, DATA_ROOT, FINAL_ROOT, HISTORY_NAMES, OPTIONAL_CSV_NAMES,
    REPLAY_XG_DIR, analysis_files, history_seasons, replay_xg_file,
)


SITE_ROOT = PROJECT_ROOT / "data" / "temp" / "site"
# The Cloudflare Pages project that serves fantezianaliz.com.
PAGES_PROJECT = "fantezianaliz"
STAGING_ROOT = SITE_ROOT.with_name("site-partial")
# The website code that is published: this remote branch, as last pushed.
CODE_REMOTE, CODE_BRANCH = "origin", "main"
# Cloudflare Pages refuses any single file above 25 MiB.
MAX_FILE_BYTES = 25 * 1024 * 1024
# No page uses them, and they are third-party artwork that is not ours to publish.
EXCLUDED_ASSETS = ("assets/face-portraits/",)
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


def published(relative):
    """Whether a site file is published, under the same rules serve.py applies."""
    return bool(ASSET_PATH.fullmatch(f"/{relative}")) and not relative.startswith(EXCLUDED_ASSETS)


def git(*args, timeout=120):
    # Fail rather than wait for a password prompt nobody will answer.
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0", GCM_INTERACTIVE="never")
    try:
        return subprocess.run(["git", *args], cwd=PROJECT_ROOT, env=env, capture_output=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise SystemExit(f"git {args[0]} failed: {error}") from None


def local_web_files():
    """Site file contents by published path, from this folder."""
    files = {}
    for source in sorted(WEB_ROOT.rglob("*")):
        relative = source.relative_to(WEB_ROOT).as_posix()
        if source.is_file() and published(relative):
            files[relative] = source.read_bytes()
    return files


def github_web_files():
    """Site file contents by published path as pushed to GitHub, and that commit."""
    ref = f"{CODE_REMOTE}/{CODE_BRANCH}"
    fetched = git("fetch", "--quiet", CODE_REMOTE, CODE_BRANCH)
    if fetched.returncode:
        reason = fetched.stderr.decode(errors="replace").strip().splitlines() or ["no reason given"]
        print(f"Could not reach GitHub ({reason[-1]}); publishing {ref} as last fetched.")
    commit = git("log", "-1", "--format=%h %s", ref)
    if commit.returncode:
        raise SystemExit(f"No {ref} to publish from. Push the website code first, or use --local-code.")
    archive = git("archive", "--format=tar", ref, "src/web", timeout=300)
    if archive.returncode:
        raise SystemExit(f"Could not read src/web from {ref}.")
    files = {}
    with tarfile.open(fileobj=io.BytesIO(archive.stdout)) as tar:
        for member in tar.getmembers():
            relative = member.name.removeprefix("src/web/")
            if member.isfile() and published(relative):
                files[relative] = tar.extractfile(member).read()
    unpushed = git("rev-list", "--count", f"{ref}..HEAD").stdout.decode().strip()
    if unpushed not in ("", "0"):
        print(f"Not published: {unpushed} local commit(s) not yet pushed to GitHub.")
    if git("status", "--porcelain", "--", "src/web").stdout.strip():
        print("Not published: uncommitted changes in src/web.")
    return files, commit.stdout.decode(errors="replace").strip()


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
    for source in sorted((csv_root / REPLAY_XG_DIR).glob("*.csv")):
        relative = source.relative_to(csv_root).as_posix()
        recording = replay_xg_file(csv_root, relative)
        if recording is not None:
            wanted[relative] = recording
    wanted["spider/spider_stats.csv"] = FINAL_ROOT / "spider" / season / "spider_stats.csv"
    earlier = [name for name in history_seasons() if name < season]
    for name in earlier:
        for file in sorted(HISTORY_NAMES):
            root = FINAL_ROOT / "spider" / name if file == "spider_stats.csv" else DATA_ROOT / name
            wanted[f"history/{name}/{file}"] = root / file
    files = {path: source for path, source in wanted.items() if source.is_file()}
    absent = sorted(path for path in wanted if path not in files)
    return files, absent, earlier


def copy_season_rows(source, target, season):
    """Copy a CSV keeping only the served season's rows, when it has a season column.

    The points files hold every season since 2021, but the pages read only the
    served one: publishing the rest would cost every visitor ten times the download.
    """
    with source.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.reader(stream)
        header = next(reader, None)
        if not header or "season" not in header:
            shutil.copyfile(source, target)
            return
        column = header.index("season")
        rows = [row for row in reader if len(row) > column and row[column].replace("/", "-") == season]
    with target.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(header)
        writer.writerows(rows)


def supabase_origin(code):
    """The Supabase project's address from the published core/auth-config.js; "" when sign-in is off."""
    text = code.get("core/auth-config.js", b"").decode("utf-8", "replace")
    found = re.search(r'\burl:\s*"(https://[A-Za-z0-9.-]+)', text)
    return found[1] if found else ""


def content_security_policy(supabase):
    """What a page may load and where it may send data: this site, plus the few
    outside addresses the code really uses. Anything else - a script a visitor's
    post tried to smuggle in, a request to an unknown server - the browser refuses.

    - script-src: the site's own files, the sign-in library (core/auth.js loads
      it from jsDelivr) and Cloudflare's visitor counter. No inline scripts.
    - style-src: 'unsafe-inline' because the pages set style="" on elements.
    - img-src and connect-src: Supabase holds profile photos and answers
      sign-in, profiles, Maç Tribünü and shared squads.
    - frame-ancestors 'none': no other site may show these pages inside its own.
    A page that needs a new outside address must add it here, or it will not load.
    """
    sign_in = f" {supabase}" if supabase else ""
    sockets = f" {supabase.replace('https://', 'wss://', 1)}" if supabase else ""
    return "; ".join((
        "default-src 'self'",
        "script-src 'self' https://cdn.jsdelivr.net https://static.cloudflareinsights.com",
        "style-src 'self' 'unsafe-inline'",
        f"img-src 'self'{sign_in}",
        f"connect-src 'self'{sign_in}{sockets} https://cloudflareinsights.com",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
    ))


def headers_file(season, code, supabase=""):
    # The pages check the two X-Superlig headers before trusting a data file;
    # serve.py sends the same pair. Cloudflare compresses text/plain but not
    # text/csv, and the pages read the files as text whatever the type says.
    # X-Site-Code names the published code, so the live site can be checked.
    # The rest are browser protections: the content policy above; always HTTPS
    # for a year once visited (this address only, not other subdomains); no
    # framing by other sites, said twice for older browsers; and no camera,
    # microphone or location, which no page uses.
    return (f"{BUILD_MARK}\n"
            "/*\n"
            f"  X-Site-Code: {code}\n"
            "  X-Content-Type-Options: nosniff\n"
            "  Referrer-Policy: strict-origin-when-cross-origin\n"
            f"  Content-Security-Policy: {content_security_policy(supabase)}\n"
            "  Strict-Transport-Security: max-age=31536000\n"
            "  X-Frame-Options: DENY\n"
            "  Permissions-Policy: camera=(), microphone=(), geolocation=()\n"
            "/local-data/*\n"
            "  Content-Type: text/plain; charset=utf-8\n"
            "  X-Superlig-Local: 1\n"
            f"  X-Superlig-Season: {season}\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--season", type=season_folder, default="2026/2027")
    parser.add_argument("--local-code", action="store_true",
                        help="Publish this folder's website code instead of GitHub's main, to preview before pushing.")
    args = parser.parse_args()
    season = args.season

    if args.local_code:
        code, described, version = local_web_files(), "this folder (--local-code)", "local"
    else:
        code, commit = github_web_files()
        described, version = f"GitHub {CODE_REMOTE}/{CODE_BRANCH} {commit}", commit.split()[0]
    if "core/site.js" not in code or "404.html" not in code:
        raise SystemExit(f"The website code in {described} has no core/site.js or 404.html. Push the current code first.")
    data, absent, earlier = data_files(season)
    season_scoped = set(analysis_files(season))

    remove_build(STAGING_ROOT)
    STAGING_ROOT.mkdir(parents=True)
    # Written first, so an interrupted run still leaves a folder a rerun may delete.
    (STAGING_ROOT / "_headers").write_text(headers_file(season, version, supabase_origin(code)), encoding="utf-8", newline="\n")
    for path, content in code.items():
        target = STAGING_ROOT / path
        target.parent.mkdir(parents=True, exist_ok=True)
        if path == "core/site.js":
            text = content.decode("utf-8")
            if text.count(SITE_FLAG[0]) != 1:
                raise SystemExit(f"Expected one '{SITE_FLAG[0]}' line in core/site.js.")
            content = text.replace(*SITE_FLAG).encode("utf-8")
        target.write_bytes(content)
    for path, source in data.items():
        target = STAGING_ROOT / "local-data" / path
        target.parent.mkdir(parents=True, exist_ok=True)
        if path in season_scoped:
            copy_season_rows(source, target, season)
        else:
            shutil.copyfile(source, target)
    with (STAGING_ROOT / "local-data" / "history" / "seasons.csv").open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["season"])
        writer.writerows([name] for name in earlier)
    # Checked on what was written, after other seasons' rows were dropped.
    too_large = sorted(path.relative_to(STAGING_ROOT).as_posix() for path in STAGING_ROOT.rglob("*")
                       if path.is_file() and path.stat().st_size > MAX_FILE_BYTES)
    if too_large:
        raise SystemExit(f"Cloudflare Pages accepts files up to 25 MiB; too large: {', '.join(too_large)}")

    remove_build(SITE_ROOT)
    STAGING_ROOT.rename(SITE_ROOT)

    total = sum(path.stat().st_size for path in SITE_ROOT.rglob("*") if path.is_file())
    count = sum(1 for path in SITE_ROOT.rglob("*") if path.is_file())
    print(f"Wrote {count} files ({total / 1024 / 1024:.1f} MB) to {SITE_ROOT}")
    print(f"Website code: {described}")
    print(f"Season {season}; radar history: {', '.join(earlier) or 'none'}")
    if absent:
        print("Not published because they do not exist yet; the pages that use them will say so:")
        for path in absent:
            print(f"  {path}")
    print("Upload with:")
    print(f"  npx wrangler pages deploy {SITE_ROOT.relative_to(PROJECT_ROOT).as_posix()} --project-name {PAGES_PROJECT} --branch main")


if __name__ == "__main__":
    main()
