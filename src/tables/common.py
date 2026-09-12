"""Shared reading, writing and match rules for the published tables.

Every module in this package turns saved Sportmonks CSVs into one finished
table under ``data/final/tables/<season>/``. The website then only renders what
it is given: no season totals, percentiles or averages are computed in the
browser any more.

The rules here are the ones the pages used to apply in JavaScript, kept
deliberately identical so a published table matches what the site showed
before:

* Only fixtures the provider marks finished count, and only with a saved
  CURRENT score for both sides. A fixture caught in play by the last download
  is left out until it is downloaded again.
* A conflicting duplicate score is unknown, not an average and not the first
  one seen.
* A blank counting column is a zero only on a match whose statistics the feed
  actually covered; on an uncovered match it stays unknown, so a rate is never
  understated by matches the provider never described.
"""
from __future__ import annotations

import csv
import io
import math
import re
import uuid
from collections import namedtuple
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FINAL_ROOT = ROOT / "data" / "final"
SOURCE_ROOT = FINAL_ROOT / "sportmonks"
OUTPUT_ROOT = FINAL_ROOT / "tables"

# What a table module returns: the file it publishes, its rows, and the column
# order it wants. A module may return several.
Table = namedtuple("Table", "name rows columns")

# The states in which a result is final. Identical to the list the pages used.
FINISHED_STATES = {"FT", "AET", "FT_PEN", "AWARDED", "WO"}
# A match the statistics feed described at all. One of these present means a
# blank elsewhere is "none", not "not supplied".
COVERAGE_COLUMNS = ("touches", "passes", "total_duels", "shots_total", "fouls", "possession_lost")
TEAM_COVERAGE_COLUMNS = ("passes", "shots_total", "fouls", "ball_possession", "duels_won")


def season_folder(name: str) -> str:
    """Accept 2026/2027 or 2026-2027 and return the folder spelling."""
    name = str(name).replace("/", "-")
    if not re.fullmatch(r"\d{4}-\d{4}", name):
        raise ValueError("Season must look like 2026/2027")
    first, last = map(int, name.split("-"))
    if last != first + 1:
        raise ValueError("Season years must be consecutive")
    return name


def read_csv(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    return list(csv.DictReader(io.StringIO(path.read_text(encoding="utf-8-sig"))))


def write_csv(path: Path, rows: list[dict], columns=None) -> None:
    """Write through a temporary file so a reader never sees a half-written table."""
    path.parent.mkdir(parents=True, exist_ok=True)
    names = list(columns) if columns else list(rows[0]) if rows else ["message"]
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=names, extrasaction="raise")
            writer.writeheader()
            writer.writerows(rows)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def blank(value) -> bool:
    return value is None or str(value).strip() == ""


def number(value):
    """A finite number, or None. A blank is not a zero."""
    if blank(value) or isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def nonnegative(value):
    result = number(value)
    return result if result is not None and result >= 0 else None


def whole(value):
    """A non-negative integer, or None: goals and cards are counted, not measured."""
    result = number(value)
    if result is None or result < 0 or result != int(result):
        return None
    return int(result)


def text(value, digits: int = 2) -> str:
    """Numbers as the CSV holds them: plain, no thousands separators, no trailing zeros."""
    if value is None:
        return ""
    if isinstance(value, (int,)) and not isinstance(value, bool):
        return str(value)
    result = number(value)
    if result is None:
        return str(value)
    if result == int(result) and abs(result) < 1e15:
        return str(int(result))
    return f"{round(result, digits):g}"


# Turkish alphabetical order, for the name a tie falls back to. Python's
# default sort puts I before i and ignores ç, ğ, ı, ö, ş and ü entirely, which
# is not the order the list shows.
TURKISH_ALPHABET = "abcçdefgğhıijklmnoöprsştuüvyz"
TURKISH_ORDER = {letter: index for index, letter in enumerate(TURKISH_ALPHABET)}


def turkish_key(value) -> list[tuple[int, str]]:
    """Sort key ordering names the way a Turkish reader expects."""
    lowered = str(value or "").casefold().replace("i̇", "i")
    return [(TURKISH_ORDER.get(letter, len(TURKISH_ALPHABET)), letter) for letter in lowered]


def state_of(fixture: dict) -> str:
    return str(fixture.get("state.developer_name") or fixture.get("state") or "").upper()


def is_finished(fixture: dict) -> bool:
    return state_of(fixture) in FINISHED_STATES


def kickoff_key(fixture: dict) -> tuple[str, str]:
    """Sort key putting undated fixtures last but keeping the order stable."""
    return (str(fixture.get("kickoff") or "9999"), str(fixture.get("fixture_id") or ""))


def covered(row: dict, columns=COVERAGE_COLUMNS) -> bool:
    return any(not blank(row.get(column)) for column in columns)


def counted(row: dict, column: str, coverage=COVERAGE_COLUMNS):
    """A statistic from one match row: a blank is none only where the feed covered it."""
    value = nonnegative(row.get(column))
    if value is not None:
        return value
    if column in row and blank(row.get(column)) and covered(row, coverage):
        return 0.0
    return None


class Season:
    """Saved CSVs for one season, read once and shared by every table module."""

    def __init__(self, slug: str, source_root: Path = SOURCE_ROOT, output_root: Path = OUTPUT_ROOT,
                 published_root: Path = FINAL_ROOT):
        self.slug = season_folder(slug)
        self.source = Path(source_root) / self.slug
        self.output = Path(output_root) / self.slug
        # Where the earlier stages' output is read from. The pipeline points
        # this at its staging folder so the tables join the points it has just
        # built rather than the ones still published from the previous run.
        self.published_root = Path(published_root)
        self._tables: dict[str, list[dict]] = {}
        self._cache: dict[str, object] = {}
        if not self.source.is_dir():
            raise ValueError(f"Season CSV folder not found: {self.source}")

    def table(self, name: str) -> list[dict]:
        """One saved CSV. A file the export does not contain reads as no rows."""
        if name not in self._tables:
            self._tables[name] = read_csv(self.source / name)
        return self._tables[name]

    def published(self, relative: str) -> list[dict]:
        """A file an earlier pipeline stage published under data/final.

        Fantasy points and projections are computed by src/points and
        src/player_projections; the tables join them rather than recompute them.
        """
        return self.derive(f"published:{relative}", lambda: read_csv(self.published_root / relative))

    def derive(self, key: str, build):
        """Cache a derived value so modules can share work without recomputing it."""
        if key not in self._cache:
            self._cache[key] = build()
        return self._cache[key]

    # ------------------------------------------------------------ shared views

    @property
    def fixtures(self) -> list[dict]:
        return self.table("fixtures.csv")

    @property
    def teams(self) -> dict[str, dict]:
        """Team id to its saved row, with standings filling in teams teams.csv omits."""
        def build():
            names = {str(row.get("id")): row for row in self.table("teams.csv") if row.get("id")}
            for row in self.table("standings.csv"):
                key = str(row.get("participant_id") or "")
                if key and key not in names:
                    names[key] = {"id": key, "name": row.get("participant.name") or f"Team {key}",
                                  "short_code": row.get("participant.short_code") or ""}
            return names
        return self.derive("teams", build)

    def team_name(self, team_id) -> str:
        key = str(team_id or "")
        row = self.teams.get(key)
        return str(row.get("name") or f"Team {key}") if row else (f"Team {key}" if key else "")

    def short_code(self, team_id) -> str:
        row = self.teams.get(str(team_id or ""))
        return str(row.get("short_code") or "") if row else ""

    @property
    def scores(self) -> dict[tuple[str, str], int | None]:
        """CURRENT goals per fixture and team; a conflicting duplicate is unknown."""
        def build():
            result: dict[tuple[str, str], int | None] = {}
            for row in self.table("fixture_scores.csv"):
                if str(row.get("description") or "") != "CURRENT":
                    continue
                key = (str(row.get("fixture_id") or ""), str(row.get("participant_id") or ""))
                value = whole(row.get("score.goals"))
                if key in result and result[key] != value:
                    result[key] = None
                else:
                    result[key] = value
            return result
        return self.derive("scores", build)

    @property
    def finished(self) -> list[dict]:
        """Finished fixtures in kickoff order."""
        return self.derive("finished", lambda: sorted(
            (fixture for fixture in self.fixtures if is_finished(fixture)), key=kickoff_key))

    def score_pair(self, fixture: dict):
        """(home goals, away goals), or None when either side's score is missing."""
        fixture_id = str(fixture.get("fixture_id") or "")
        home = self.scores.get((fixture_id, str(fixture.get("home_team_id") or "")))
        away = self.scores.get((fixture_id, str(fixture.get("away_team_id") or "")))
        if home is None or away is None:
            return None
        return home, away

    @property
    def played(self) -> list[dict]:
        """One row per team and finished fixture with a saved score, both sides.

        The unit every team table is built on: who played whom, where, the
        result, and the round it belongs to.
        """
        def build():
            rows = []
            for fixture in self.finished:
                pair = self.score_pair(fixture)
                if pair is None:
                    continue
                home_goals, away_goals = pair
                fixture_id = str(fixture.get("fixture_id") or "")
                round_name = number(fixture.get("round.name"))
                for team_id, opponent_id, home, own, other in (
                    (str(fixture.get("home_team_id") or ""), str(fixture.get("away_team_id") or ""), True, home_goals, away_goals),
                    (str(fixture.get("away_team_id") or ""), str(fixture.get("home_team_id") or ""), False, away_goals, home_goals),
                ):
                    if not team_id or not opponent_id:
                        continue
                    rows.append({
                        "fixture_id": fixture_id, "team_id": team_id, "opponent_id": opponent_id,
                        "kickoff": str(fixture.get("kickoff") or ""), "home": home,
                        "round": None if round_name is None else int(round_name),
                        "goals_for": own, "goals_against": other,
                        "result": "W" if own > other else "L" if own < other else "D",
                        "season_id": str(fixture.get("season_id") or ""),
                        "league_id": str(fixture.get("league_id") or ""),
                    })
            return rows
        return self.derive("played", build)

    def played_for(self, team_id) -> list[dict]:
        key = str(team_id or "")
        return [row for row in self.played if row["team_id"] == key]
