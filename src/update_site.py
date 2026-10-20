"""Bring fantezianaliz.com up to date: download, forecast, rebuild and upload.

Windows Task Scheduler runs this every 30 minutes (see fullrun.md). Most runs
find nothing new and stop without contacting anyone. A run does work when a
match reaches one of its checkpoints after kickoff - once for the result, once
more for Sportmonks' later statistics corrections - or once a day for injuries,
squads and kickoff times. Each step is the same command fullrun.md gives for a
manual run, and the upload happens only when every step before it succeeded.
The website code it publishes is GitHub's main as last pushed, not this folder
(see src/web/build_static.py); the data is this folder's.

Not automated: the TFF export, which needs you to log in. Until you run it,
the site keeps the last TFF prices and positions.
"""

import argparse
import csv
from datetime import datetime, timedelta, timezone
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
from src.tables.common import state_of  # noqa: E402
from src.web.build_static import PAGES_PROJECT, SITE_ROOT  # noqa: E402
from src.web.serve import season_name  # noqa: E402


STATE = ROOT / "data" / "temp" / "site_update"
RUNS = STATE / "update_runs.csv"
LOGS = STATE / "logs"
LOCK = STATE / "update.lock"
RUN_COLUMNS = ["started_at_utc", "finished_at_utc", "season", "status", "reason",
               "steps", "failed_step", "message", "log_file"]
PREDICTIONS = ROOT / "data" / "final" / "odds" / "predictions.csv"
ODDS_PYTHON = ROOT / ".venv" / "Scripts" / "python.exe"

# Each match is fetched again when these have passed since kickoff. The first
# allows for 90 minutes, half time, stoppage time and Sportmonks filing the
# result; the second picks up statistics Sportmonks corrects after the match
# and any match that kicked off late.
CHECKPOINTS = (timedelta(hours=2, minutes=30), timedelta(hours=6))
DAILY = timedelta(hours=24)
# After a failed run, wait this long before trying again, so a lasting problem
# does not repeat the whole download every half hour.
RETRY_AFTER = timedelta(hours=2)
STEP_MINUTES = {"download": 60, "odds": 30, "pipeline": 60, "build": 15, "upload": 30}
# A lock or an in-progress download older than the longest possible run was abandoned.
STALE = timedelta(minutes=sum(STEP_MINUTES.values()) + 15)
# Sportmonks states (state.developer_name) of a fixture that has not been
# played, whatever its kickoff time says.
NOT_PLAYED = {"NS", "TBA", "POSTPONED", "CANCELLED", "DELAYED", "PENDING", "DELETED"}


class StepFailed(RuntimeError):
    def __init__(self, step, message):
        super().__init__(message)
        self.step = step


def utc_now():
    return datetime.now(timezone.utc)


def parse_time(value):
    try:
        moment = datetime.fromisoformat(str(value or "").strip())
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def read_rows(path):
    if not path.is_file():
        return []
    with path.open(encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


def kickoff(fixture):
    try:
        return datetime.fromtimestamp(int(float(fixture["starting_at_timestamp"])), timezone.utc)
    except (KeyError, TypeError, ValueError, OverflowError, OSError):
        return None


def due(season, runs, now):
    """(reason, None) when the site needs an update now, else (None, why not)."""
    last = runs[-1] if runs else None
    if last and last["status"] == "failed":
        failed_at = parse_time(last["finished_at_utc"])
        if failed_at and now - failed_at < RETRY_AFTER:
            retry = (failed_at + RETRY_AFTER).astimezone().strftime("%H:%M")
            return None, f"the last update failed ({last['message'] or 'interrupted'}); retrying after {retry}."
    complete = [row for row in runs if row["status"] == "complete"]
    if not complete:
        return "first update", None
    since = parse_time(complete[-1]["started_at_utc"])
    if not since:
        return "first update", None
    reached = set()
    for fixture in read_rows(FINAL_DATA / season / "fixtures.csv"):
        start = kickoff(fixture)
        if start and any(since < start + after <= now for after in CHECKPOINTS):
            reached.add(fixture.get("name") or fixture.get("fixture_id"))
    if reached:
        return f"match update: {', '.join(sorted(reached))}", None
    if now - since >= DAILY:
        return "daily refresh", None
    return None, f"no match has reached a checkpoint since {since.astimezone():%d %b %H:%M}."


def download_running(season, now):
    rows = read_rows(FINAL_DATA / season / "download_status.csv")
    if len(rows) != 1 or rows[0].get("status") != "in_progress":
        return False
    started = parse_time(rows[0].get("started_at_utc"))
    return bool(started and now - started < STALE)


def odds_due(season, now):
    """Whether the next matchweek has not started and has no forecast yet.

    The next matchweek is the one odds/run.py predict chooses: the round of the
    earliest unplayed fixture. Forecasting a round already under way is of no
    use; projections only read the forecast of a round that has not started.
    """
    fixtures = read_rows(FINAL_DATA / season / "fixtures.csv")
    upcoming = [row for row in fixtures if state_of(row) == "NS" and kickoff(row) and kickoff(row) >= now]
    if not upcoming:
        return False
    round_id = min(upcoming, key=kickoff).get("round_id")
    games = [row for row in fixtures if round_id and row.get("round_id") == round_id]
    if any(kickoff(row) and kickoff(row) <= now and state_of(row) not in NOT_PLAYED for row in games):
        return False
    forecast = {row.get("fixture_id") for row in read_rows(PREDICTIONS) if row.get("season") == season}
    return any(row.get("fixture_id") not in forecast for row in games if state_of(row) == "NS")


def take_lock(now):
    STATE.mkdir(parents=True, exist_ok=True)
    if LOCK.exists() and now - datetime.fromtimestamp(LOCK.stat().st_mtime, timezone.utc) > STALE:
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
    args = parser.parse_args()
    # Club names are Turkish; a redirected Windows console may not encode them.
    # sys.stdout is None under pythonw.exe, as when Task Scheduler runs this.
    if sys.stdout:
        sys.stdout.reconfigure(errors="replace")
    try:
        season = season_name(args.season)
    except argparse.ArgumentTypeError as error:
        parser.error(str(error))

    now = utc_now()
    runs = [row for row in read_rows(RUNS) if row.get("season") == season]
    reason, why_not = ("requested with --now", None) if args.now else due(season, runs, now)
    if args.check:
        print(f"Update due: {reason}." if reason else f"Nothing to do: {why_not}")
        print(f"Odds forecast (from the saved fixtures): {'would run' if odds_due(season, now) else 'not needed'}.")
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
    row = {"started_at_utc": now.isoformat(), "season": season, "reason": reason, "status": "failed",
           "log_file": log_path.relative_to(ROOT).as_posix()}
    steps = []
    print(f"Updating {season}: {reason}. Log: {log_path}")
    try:
        with log_path.open("a", encoding="utf-8") as log:
            run_step("download", [python, "src/fetch/download_season.py", "--season", args.season, "--refresh"], log, env)
            steps.append("download")
            if odds_due(season, utc_now()):
                if not ODDS_PYTHON.is_file():
                    raise StepFailed("odds", f"{ODDS_PYTHON.relative_to(ROOT)} not found; create the odds environment first")
                run_step("odds", [str(ODDS_PYTHON), "src/odds/run.py", "predict"], log, env)
                steps.append("odds")
            run_step("pipeline", [python, "src/run_pipeline.py", "--season", args.season], log, env)
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
        row.update(status="complete", message="")
        print("The site is up to date.")
        return 0
    except StepFailed as failure:
        row.update(failed_step=failure.step, message=f"{failure.step}: {failure}")
        print(f"Stopped at {failure.step}: {failure}. Nothing after it ran; see {log_path}.")
        return 1
    except BaseException as error:
        row.update(message=f"interrupted: {type(error).__name__}")
        raise
    finally:
        row.update(finished_at_utc=utc_now().isoformat(), steps=" ".join(steps))
        record(row)
        LOCK.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
