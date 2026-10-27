"""Bring fantezianaliz.com up to date: download, forecast, rebuild and upload.

GitHub Actions runs this every hour (.github/workflows/update-site.yml). Most
runs find nothing new and stop without contacting anyone. A run does work when a
match reaches one of its checkpoints after kickoff - once for the result, once
more for Sportmonks' later statistics corrections - or once a day for injuries,
squads and kickoff times. Each step is a command that can also be run by hand,
and the upload happens only when every step before it succeeded.
The website code it publishes is GitHub's main as last pushed, not this folder
(see src/web/build_static.py); the data is this folder's.

Two steps are optional and never hold the site back. The odds forecast runs
when the next matchweek has none. The TFF export runs about once a day when the
TFF_FANTASY_EMAIL and TFF_FANTASY_PASSWORD settings exist; if TFF refuses the
login or asks for verification, the site keeps the last TFF prices and the
next attempt waits a day.
"""

import argparse
import csv
from datetime import datetime, timedelta
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.fetch.sportmonks import FINAL_DATA, local_setting  # noqa: E402
from src.shared import (  # noqa: E402
    UNPLAYED_STATES, UTC, fixture_state, parse_utc, read_csv, season_folder, utc_now, utc_stamp,
)
from src.web.build_static import PAGES_PROJECT, SITE_ROOT  # noqa: E402


STATE = ROOT / "data" / "temp" / "site_update"
RUNS = STATE / "update_runs.csv"
LOGS = STATE / "logs"
LOCK = STATE / "update.lock"
RUN_COLUMNS = ["started_at_utc", "finished_at_utc", "season", "status", "reason",
               "steps", "failed_step", "message", "log_file"]
PREDICTIONS = ROOT / "data" / "final" / "odds" / "predictions.csv"
TFF_PLAYERS = ROOT / "data" / "final" / "tff_fantasy" / "tff_players.csv"
# Prices and selection rates move daily at most; one export a day is enough,
# and one failed attempt a day is all a refused login should cost.
TFF_EVERY = timedelta(hours=20)
# The odds model's environment (XGBoost, Optuna): the project's .venv on this
# computer. Where there is none, as on GitHub's servers, the packages are
# installed in the Python running this script.
ODDS_PYTHONS = (ROOT / ".venv" / "Scripts" / "python.exe", ROOT / ".venv" / "bin" / "python")

# Each match is fetched again when these have passed since kickoff. The first
# allows for 90 minutes, half time, stoppage time and Sportmonks filing the
# result; the second picks up statistics Sportmonks corrects after the match
# and any match that kicked off late.
CHECKPOINTS = (timedelta(hours=2, minutes=30), timedelta(hours=6))
DAILY = timedelta(hours=24)
# After a failed run, wait this long before trying again, so a lasting problem
# does not repeat the whole download every half hour.
RETRY_AFTER = timedelta(hours=2)
STEP_MINUTES = {"download": 60, "tff": 15, "odds": 30, "pipeline": 60, "build": 15, "upload": 30}
# A lock or an in-progress download older than the longest possible run was abandoned.
STALE = timedelta(minutes=sum(STEP_MINUTES.values()) + 15)


class StepFailed(RuntimeError):
    def __init__(self, step, message):
        super().__init__(message)
        self.step = step


def kickoff(fixture):
    try:
        return datetime.fromtimestamp(int(float(fixture["starting_at_timestamp"])), UTC)
    except (KeyError, TypeError, ValueError, OverflowError, OSError):
        return None


def due(season, runs, now):
    """(reason, None) when the site needs an update now, else (None, why not)."""
    last = runs[-1] if runs else None
    if last and last["status"] == "failed":
        failed_at = parse_utc(last["finished_at_utc"], required=False)
        if failed_at and now - failed_at < RETRY_AFTER:
            retry = (failed_at + RETRY_AFTER).astimezone().strftime("%H:%M")
            return None, f"the last update failed ({last['message'] or 'interrupted'}); retrying after {retry}."
    complete = [row for row in runs if row["status"] == "complete"]
    if not complete:
        return "first update", None
    since = parse_utc(complete[-1]["started_at_utc"], required=False)
    if not since:
        return "first update", None
    reached = set()
    for fixture in read_csv(FINAL_DATA / season / "fixtures.csv"):
        start = kickoff(fixture)
        if start and any(since < start + after <= now for after in CHECKPOINTS):
            reached.add(fixture.get("name") or fixture.get("fixture_id"))
    if reached:
        return f"match update: {', '.join(sorted(reached))}", None
    if now - since >= DAILY:
        return "daily refresh", None
    return None, f"no match has reached a checkpoint since {since.astimezone():%d %b %H:%M}."


def download_running(season, now):
    rows = read_csv(FINAL_DATA / season / "download_status.csv")
    if len(rows) != 1 or rows[0].get("status") != "in_progress":
        return False
    started = parse_utc(rows[0].get("started_at_utc"), required=False)
    return bool(started and now - started < STALE)


def odds_due(season, now):
    """Whether the next matchweek has not started and has no forecast yet.

    The next matchweek is the one odds/run.py predict chooses: the round of the
    earliest unplayed fixture. Forecasting a round already under way is of no
    use; projections only read the forecast of a round that has not started.
    """
    fixtures = read_csv(FINAL_DATA / season / "fixtures.csv")
    upcoming = [row for row in fixtures if fixture_state(row) == "NS" and kickoff(row) and kickoff(row) >= now]
    if not upcoming:
        return False
    round_id = min(upcoming, key=kickoff).get("round_id")
    games = [row for row in fixtures if round_id and row.get("round_id") == round_id]
    if any(kickoff(row) and kickoff(row) <= now and fixture_state(row) not in UNPLAYED_STATES for row in games):
        return False
    forecast = {row.get("fixture_id") for row in read_csv(PREDICTIONS) if row.get("season") == season}
    return any(row.get("fixture_id") not in forecast for row in games if fixture_state(row) == "NS")


def tff_due(runs, now):
    """Whether to export TFF now: configured, stale, and not tried in the last day."""
    if not (local_setting("TFF_FANTASY_EMAIL") and local_setting("TFF_FANTASY_PASSWORD")):
        return False
    updated = [parse_utc(row.get("updated_at_utc"), required=False) for row in read_csv(TFF_PLAYERS)]
    latest = max((moment for moment in updated if moment), default=None)
    if latest and now - latest < TFF_EVERY:
        return False
    tried = [parse_utc(row.get("started_at_utc"), required=False) for row in runs
             if "tff" in row.get("steps", "").split() or "tff failed" in row.get("message", "")]
    return not any(moment and now - moment < TFF_EVERY for moment in tried)


def take_lock(now):
    STATE.mkdir(parents=True, exist_ok=True)
    if LOCK.exists() and now - datetime.fromtimestamp(LOCK.stat().st_mtime, UTC) > STALE:
        LOCK.unlink(missing_ok=True)
    try:
        LOCK.touch(exist_ok=False)
    except FileExistsError:
        return False
    return True


def console_python():
    """Children need a console interpreter: pythonw.exe gives them no output to log."""
    executable = Path(sys.executable)
    if executable.name.lower() == "pythonw.exe" and executable.with_name("python.exe").is_file():
        return str(executable.with_name("python.exe"))
    return str(executable)


def run_step(step, command, log, env):
    started = time.monotonic()
    print(f"{datetime.now():%H:%M:%S} {step}...", flush=True)
    log.write(f"\n=== {step}: {' '.join(command)}\n")
    log.flush()
    try:
        result = subprocess.run(command, cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=log,
                                stderr=subprocess.STDOUT, timeout=STEP_MINUTES[step] * 60,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except subprocess.TimeoutExpired:
        raise StepFailed(step, f"stopped after {STEP_MINUTES[step]} minutes") from None
    except OSError as error:
        raise StepFailed(step, f"could not start: {error}") from None
    if result.returncode:
        raise StepFailed(step, f"exit code {result.returncode}")
    print(f"{datetime.now():%H:%M:%S} {step} done in {time.monotonic() - started:.0f} s", flush=True)


def run_optional(step, command, log, env, warnings):
    """A step the site can do without: on failure, note it and carry on.

    A forecast that fails must not hold back the results of matches already
    played; the projections fall back to their own team model without it.
    """
    try:
        run_step(step, command, log, env)
    except StepFailed as failure:
        warnings.append(f"{step} failed: {failure}")
        print(f"{step} failed ({failure}); the update carries on without it.", flush=True)
        if os.environ.get("GITHUB_ACTIONS") == "true":
            print(f"::warning title={step} failed::{failure}. The site was updated without it; "
                  "see the log in data/temp/site_update/logs.", flush=True)
        return False
    return True


def record(row):
    STATE.mkdir(parents=True, exist_ok=True)
    new = not RUNS.is_file()
    with RUNS.open("a", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=RUN_COLUMNS)
        if new:
            writer.writeheader()
        writer.writerow(row)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--season", default="2026/2027")
    parser.add_argument("--now", action="store_true", help="Update now, whatever the schedule says.")
    parser.add_argument("--check", action="store_true", help="Only say whether an update is due; run nothing.")
    parser.add_argument("--skip-database", action="store_true",
                        help="Leave SQLite out of the pipeline, as the cloud update does; the site never reads it.")
    args = parser.parse_args()
    # Club names are Turkish; a redirected Windows console may not encode them.
    # sys.stdout is None under pythonw.exe, as when Task Scheduler runs this.
    if sys.stdout:
        sys.stdout.reconfigure(errors="replace")
    try:
        season = season_folder(args.season)
    except ValueError as error:
        parser.error(str(error))

    now = utc_now()
    runs = [row for row in read_csv(RUNS) if row.get("season") == season]
    reason, why_not = ("requested with --now", None) if args.now else due(season, runs, now)
    if args.check:
        print(f"Update due: {reason}." if reason else f"Nothing to do: {why_not}")
        print(f"Odds forecast (from the saved fixtures): {'would run' if odds_due(season, now) else 'not needed'}.")
        tff = bool(reason) and tff_due(runs, now)
        print(f"TFF export: {'would run' if tff else 'not needed or not configured'}.")
        # GitHub Actions reads the answers to decide what to install and run.
        if output := os.environ.get("GITHUB_OUTPUT"):
            with open(output, "a", encoding="utf-8") as stream:
                print(f"due={'true' if reason else 'false'}", file=stream)
                print(f"tff={'true' if tff else 'false'}", file=stream)
        return 0
    if not reason:
        print(f"Nothing to do: {why_not}")
        return 0
    if download_running(season, now):
        print("A Sportmonks download is already running; trying again next time.")
        return 0
    if not take_lock(now):
        print("Another update is already running.")
        return 0

    LOGS.mkdir(parents=True, exist_ok=True)
    log_path = LOGS / f"{now:%Y%m%dT%H%M%SZ}.log"
    python = console_python()
    # Children write UTF-8, so Turkish names survive in the log.
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    # Optional: a Cloudflare API token in .env. Without one, the upload uses the
    # login wrangler saved when you first deployed by hand.
    upload_env = dict(env)
    for key in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"):
        if value := local_setting(key):
            upload_env[key] = value
    row = {"started_at_utc": utc_stamp(now), "season": season, "reason": reason, "status": "failed",
           "log_file": log_path.relative_to(ROOT).as_posix()}
    steps, warnings = [], []
    print(f"Updating {season}: {reason}. Log: {log_path}")
    try:
        with log_path.open("a", encoding="utf-8") as log:
            run_step("download", [python, "src/fetch/download_season.py", "--season", args.season, "--refresh"], log, env)
            steps.append("download")
            # After the download, so new players match against today's squads;
            # before the pipeline, so projections use today's prices.
            if tff_due(runs, utc_now()):
                if run_optional("tff", [python, "src/fetch/export_tff_browser.py", "--season", args.season,
                                        "--headless", "--login-timeout", "120"], log, env, warnings):
                    steps.append("tff")
            if odds_due(season, utc_now()):
                odds_python = next((str(path) for path in ODDS_PYTHONS if path.is_file()), python)
                if run_optional("odds", [odds_python, "src/odds/run.py", "predict"], log, env, warnings):
                    steps.append("odds")
            run_step("pipeline", [python, "src/run_pipeline.py", "--season", args.season,
                                  *(["--skip-database"] if args.skip_database else [])], log, env)
            steps.append("pipeline")
            run_step("build", [python, "src/web/build_static.py", "--season", args.season], log, env)
            steps.append("build")
            npx = shutil.which("npx")
            if not npx:
                raise StepFailed("upload", "npx not found; install Node.js")
            run_step("upload", [npx, "--yes", "wrangler", "pages", "deploy", SITE_ROOT.relative_to(ROOT).as_posix(),
                                "--project-name", PAGES_PROJECT, "--branch", "main", "--commit-dirty=true"],
                     log, upload_env)
            steps.append("upload")
        row.update(status="complete", message="; ".join(warnings))
        print("The site is up to date." + (f" Warnings: {'; '.join(warnings)}" if warnings else ""))
        return 0
    except StepFailed as failure:
        row.update(failed_step=failure.step, message=f"{failure.step}: {failure}")
        print(f"Stopped at {failure.step}: {failure}. Nothing after it ran; see {log_path}.")
        return 1
    except BaseException as error:
        row.update(message=f"interrupted: {type(error).__name__}")
        raise
    finally:
        row.update(finished_at_utc=utc_stamp(utc_now()), steps=" ".join(steps))
        record(row)
        LOCK.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
