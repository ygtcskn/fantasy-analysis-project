"""Rules and file handling every pipeline stage shares, defined once.

Before this module each stage carried its own copy, and the copies had drifted:
seven lists of which match states count as played, blanks read as zero in one
stage and as unknown in the next, two timestamp formats, ten season checks and
CSV writers of which only some were safe to interrupt.

* Match states. Which Sportmonks states mean a result is final, a match was
  played out, or a fixture has not been played. The website applies the same
  lists in src/web/core/match-rules.js; change the two together.
* Numbers from CSV cells. A blank is not a zero: ``number`` returns None for
  it. A stage that needs a number regardless says so with ``number_or``, which
  names the fallback where it is used. ``counted`` is the site's rule for match
  statistics: a blank is a zero only on a match the feed covered.
* Season names: 2026/2027 for people and Sportmonks, 2026-2027 for folders.
* Timestamps: written as 2026-10-25T18:30:00Z, read in any ISO form.
* CSV files: read as UTF-8 with or without a byte-order mark, and written
  through a temporary file, so a reader never sees half a file.
* Pipeline generation: the stamp run_pipeline.py puts on every published file,
  read back by the points and projection stages before they overwrite one.
"""
from __future__ import annotations

import argparse
import csv
import math
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

UTC = timezone.utc

# ------------------------------------------------------------- match states

# The result is final. Standings, form and every published total count it.
FINISHED_STATES = frozenset({"FT", "AET", "FT_PEN", "AWARDED", "WO"})
# The match was played out on the pitch. Anything built from what happened in
# it - fantasy points, the projection and odds models, their backtests - uses
# this narrower list: an awarded result has a score but no match behind it.
PLAYED_STATES = frozenset({"FT", "AET", "FT_PEN"})
# Not kicked off, or never will be. Sportmonks uses short and long spellings.
UNPLAYED_STATES = frozenset({"NS", "TBA", "PENDING", "DELAYED", "POSTP", "POSTPONED",
                             "CANC", "CANCELLED", "DELETED"})
# On the calendar and not yet kicked off: a fixture a forecast may target.
SCHEDULED_STATES = frozenset({"NS", "TBA"})
# Will never be played, so nothing is still owed: a later round need not wait.
CALLED_OFF_STATES = frozenset({"CANC", "CANCELLED", "DELETED"})


def fixture_state(fixture: dict) -> str:
    """The fixture's Sportmonks state code, upper case; "" when the row has none."""
    return str(fixture.get("state.developer_name") or fixture.get("state") or "").strip().upper()


def is_finished(fixture: dict) -> bool:
    return fixture_state(fixture) in FINISHED_STATES


def is_played(fixture: dict) -> bool:
    return fixture_state(fixture) in PLAYED_STATES


def is_unplayed(fixture: dict) -> bool:
    return fixture_state(fixture) in UNPLAYED_STATES


def is_scheduled(fixture: dict) -> bool:
    return fixture_state(fixture) in SCHEDULED_STATES


def in_progress(fixture: dict) -> bool:
    """Neither final nor unplayed: live, interrupted, or in a state not listed here.

    A state this module does not know counts as in progress, so a fixture in an
    unexpected state is treated as unfinished rather than quietly as done.
    """
    return not is_finished(fixture) and not is_unplayed(fixture)


# ------------------------------------------------------------------ numbers

def blank(value) -> bool:
    return value is None or str(value).strip() == ""


def number(value) -> float | None:
    """A finite number, or None. A blank is not a zero."""
    if blank(value) or isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def number_or(value, default=0.0):
    """A finite number, else ``default``: for a stage that must have a figure."""
    result = number(value)
    return default if result is None else result


def integer_or(value, default=0):
    """The whole part of a finite number, else ``default``."""
    result = number(value)
    return default if result is None else int(result)


def nonnegative(value) -> float | None:
    result = number(value)
    return result if result is not None and result >= 0 else None


def whole(value) -> int | None:
    """A non-negative integer, or None: goals and cards are counted, not measured."""
    result = number(value)
    if result is None or result < 0 or result != int(result):
        return None
    return int(result)


# A match the statistics feed described at all. One of these present means a
# blank elsewhere in the row is none, not "not supplied".
COVERAGE_COLUMNS = ("touches", "passes", "total_duels", "shots_total", "fouls", "possession_lost")


def covered(row: dict, columns=COVERAGE_COLUMNS) -> bool:
    return any(not blank(row.get(column)) for column in columns)


def counted(row: dict, column: str, coverage=COVERAGE_COLUMNS) -> float | None:
    """One match's count of something: a blank is none only where the feed covered it."""
    value = nonnegative(row.get(column))
    if value is not None:
        return value
    if column in row and blank(row.get(column)) and covered(row, coverage):
        return 0.0
    return None


# ------------------------------------------------------------------ seasons

class SeasonError(ValueError, argparse.ArgumentTypeError):
    """A malformed season. argparse shows its message as the error."""


def season_folder(value) -> str:
    """2026/2027 or 2026-2027 as the folder name, 2026-2027."""
    text = str(value or "").strip().replace("/", "-")
    match = re.fullmatch(r"(\d{4})-(\d{4})", text)
    if not match:
        raise SeasonError("Use a season such as 2026/2027.")
    if int(match[2]) != int(match[1]) + 1:
        raise SeasonError("Season years must be consecutive, such as 2026/2027.")
    return text


def season_label(value) -> str:
    """2026/2027 or 2026-2027 as Sportmonks names it, 2026/2027."""
    return season_folder(value).replace("-", "/")


# --------------------------------------------------------------- timestamps

def utc_now() -> datetime:
    return datetime.now(UTC)


def utc_stamp(moment: datetime | None) -> str:
    """A time as written to every CSV, 2026-10-25T18:30:00Z; "" for no time.

    A time without a zone is taken as UTC, as every saved time in this project is.
    """
    if moment is None:
        return ""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_utc(value, *, required: bool = True) -> datetime | None:
    """Any ISO date or time as a UTC datetime. A time without a zone is UTC.

    Reads both forms this project has written (…Z and …+00:00) and Sportmonks'
    "2026-09-04 17:00:00". Raises ValueError for anything else, unless
    ``required`` is False, when it returns None.
    """
    text = str(value or "").strip()
    try:
        if not text:
            raise ValueError("No time given.")
        moment = datetime.fromisoformat(text[:-1] + "+00:00" if text[-1] in "Zz" else text)
    except ValueError:
        if required:
            raise
        return None
    return moment.replace(tzinfo=UTC) if moment.tzinfo is None else moment.astimezone(UTC)


# ---------------------------------------------------------------------- CSV

def read_csv(path, *, required: bool = False) -> list[dict[str, str]]:
    """Every row of a UTF-8 CSV, a byte-order mark or not.

    A missing file reads as no rows, unless ``required``, when it raises
    FileNotFoundError - for an input whose absence must stop the run.
    """
    path = Path(path)
    if not required and not path.is_file():
        return []
    with path.open(encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


def write_csv(path, rows, columns=None) -> None:
    """Write rows through a temporary file and swap it in whole.

    ``columns`` fixes the column order. Without it, every key in the order it
    first appears, or a lone "message" column for an empty file. A row with a
    key outside ``columns`` is an error rather than a silently dropped value.
    """
    path = Path(path)
    rows = list(rows)
    if columns is None:
        columns = list(dict.fromkeys(key for row in rows for key in row)) or ["message"]
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8-sig", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=list(columns), extrasaction="raise")
            writer.writeheader()
            writer.writerows(rows)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


# ------------------------------------------------------- pipeline generation

def published_generation(path) -> str:
    """The pipeline generation stamped on a file this run is about to replace.

    ``run_pipeline.py`` tags every published file with one ``pipeline_run_id``,
    and the website refuses to display a set whose stamps disagree. A standalone
    rebuild writes the same path without that column, which silently invalidates
    the whole published set: the browser reports that the analysis is being
    updated and every projection vanishes, with nothing pointing at the cause.
    Reading the stamp before overwriting it turns that into one line of output.
    """
    path = Path(path)
    if not path.is_file():
        return ""
    try:
        with path.open(encoding="utf-8-sig", newline="") as stream:
            reader = csv.DictReader(stream)
            if "pipeline_run_id" not in (reader.fieldnames or []):
                return ""
            for row in reader:
                return row.get("pipeline_run_id", "") or ""
    except (OSError, UnicodeError, csv.Error):
        return ""
    return ""


def warn_if_unpublishing(generations, season: str = "<season>") -> None:
    """Say so when a standalone points or projections run replaced tagged files."""
    live = sorted({value for value in generations if value})
    if not live:
        return
    print(f"\nWARNING: this replaced published files carrying pipeline generation "
          f"{', '.join(live)} with untagged output.")
    print("         The website will now reject the whole fantasy dataset and show "
          "'Fantasy analysis is being updated'.")
    print(f"         Run: python src/run_pipeline.py --season {season}")
    print("         to republish points, projections and the marker together.")
