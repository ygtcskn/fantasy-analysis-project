"""Record Sportmonks live team xG for Ana Sayfa replays. Run from the project root."""

import argparse
from collections import defaultdict
from contextlib import contextmanager
import csv
import sys
import time

from src.fetch.sportmonks import FINAL_DATA, ROOT, token
from src.shared import read_csv, season_folder, utc_now, utc_stamp, whole, write_csv
from src.web.live import ERROR_SECONDS, LiveUnavailable, fetch_fixtures, normalize, positive_id, season_scope


POLL_SECONDS = 60
XG_TYPES = {"5304", "7944", "7945"}  # Overall, set play, open play.
REPLAY_STATES = {"INPLAY_1ST_HALF", "HT", "INPLAY_2ND_HALF", "INPLAY_ET"}
FIXTURE_FIELDS = ("fixture_id", "league_id", "season_id", "home_team_id", "away_team_id", "state")
FIELDS = (*FIXTURE_FIELDS, "minute", "extra_minute", "first_half_minute", "fetched_at", "team_id", "type_id", "value")


@contextmanager
def recording_lock(season):
    """Keep one writer per season. Closing the file releases the OS lock."""
    path = ROOT / "data" / "temp" / "replay_xg" / f"{season}.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as lock:
        try:
            if sys.platform == "win32":
                from msvcrt import LK_NBLCK, locking

                lock.seek(0)
                locking(lock.fileno(), LK_NBLCK, 1)
            else:
                from fcntl import LOCK_EX, LOCK_NB, flock

                flock(lock.fileno(), LOCK_EX | LOCK_NB)
        except OSError as error:
            raise RuntimeError(f"Could not lock the recorder for {season}. Check for another recorder.") from error
        yield


def xg_observations(rows, fetched_at):
    by_fixture = defaultdict(list)
    for row in rows:
        by_fixture[row["fixture_id"]].append(row)

    for fixture_id, records in by_fixture.items():
        fixture = records[0]  # normalize() emits the fixture before its details.
        state = fixture["state"]
        if state not in REPLAY_STATES:
            continue
        minute, extra = whole(fixture["minute"]), whole(fixture["extra_minute"])
        first = next((whole(row["minute"]) for row in records
                      if row["record_type"] == "period" and row["code"] == "1ST_HALF"), None)
        if state == "HT":
            if first is None or first < 45:
                continue
        elif minute is None:
            continue

        values = {}
        for row in records:
            if row["record_type"] != "statistic" or row["source"] != "xgfixture":
                continue
            kind = positive_id(row["type_id"])
            if kind not in XG_TYPES:
                continue
            key = (row["team_id"], kind)
            values[key] = None if key in values else row["value"]
        metadata = {field: fixture[field] for field in FIXTURE_FIELDS}
        observations = [dict(metadata, minute=minute, extra_minute=extra, first_half_minute=first,
                             fetched_at=fetched_at, team_id=team_id, type_id=kind, value=value)
                        for (team_id, kind), value in values.items() if value is not None]
        if observations:
            yield fixture_id, observations


def record_poll(csv_root, league_id, season_id):
    fixtures = fetch_fixtures("livescores/inplay", {
        "filters": f"fixtureLeagues:{league_id}", "include": "participants;periods;xGFixture",
    })
    fetched_at = utc_stamp(utc_now())
    rows = normalize(fixtures, league_id, season_id)
    saved = False
    for fixture_id, observations in xg_observations(rows, fetched_at):
        path = csv_root / "replay_xg" / f"{fixture_id}.csv"
        existing = read_csv(path)
        # Retry of the same observation must leave only one row per team and metric.
        keys = {(row["fetched_at"], row["team_id"], row["type_id"]) for row in observations}
        kept = [row for row in existing if (row["fetched_at"], row["team_id"], row["type_id"]) not in keys]
        write_csv(path, [*kept, *observations], FIELDS)
        print(f"{fetched_at} · Fixture {fixture_id}: saved {len(observations)} xG readings.", flush=True)
        saved = True
    if not saved:
        reason = "No usable xG readings in this poll." if rows else "No in-play fixtures for this season."
        print(f"{fetched_at} · {reason}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--season", type=season_folder, required=True, help="Saved season, e.g. 2026/2027.")
    args = parser.parse_args()
    csv_root = FINAL_DATA / args.season
    try:
        token()  # Fail before starting the polling loop if the local token is missing.
        league_id, season_id = season_scope(csv_root)
        with recording_lock(args.season):
            print(f"Recording live team xG for {args.season} every {POLL_SECONDS} seconds. Ctrl+C stops recording.", flush=True)
            while True:
                started = time.monotonic()
                delay = POLL_SECONDS
                try:
                    record_poll(csv_root, league_id, season_id)
                except LiveUnavailable as error:
                    if error.status in {401, 402, 403}:
                        parser.exit(1, f"Sportmonks denied access (HTTP {error.status}). Check the token and live xG access.\n")
                    delay = error.retry
                    print(f"Sportmonks live xG unavailable. Retrying in {delay} seconds.", file=sys.stderr, flush=True)
                except (OSError, csv.Error, UnicodeError, ValueError, TypeError, KeyError, AttributeError):
                    delay = ERROR_SECONDS
                    print("Could not read live xG data or an existing replay CSV. Retrying.", file=sys.stderr, flush=True)
                elapsed = time.monotonic() - started if delay == POLL_SECONDS else 0
                time.sleep(max(0, delay - elapsed))
    except KeyboardInterrupt:
        print("\nRecording stopped. Saved readings are ready for replay.")
    except (RuntimeError, LiveUnavailable, OSError, csv.Error, UnicodeError) as error:
        parser.exit(1, f"Could not record live xG: {error}\n")


if __name__ == "__main__":
    main()
