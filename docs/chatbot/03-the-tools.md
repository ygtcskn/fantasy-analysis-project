# Step 3 — The tools

## What you'll build

A **tool** is a normal Python function that the AI is allowed to call. In
step 4 the AI will see each tool's name and description, and when a visitor
asks *"2023-24'te en çok asist yapan kim?"* (who had the most assists in 2023-24?) it will reply with something like:

> call `leaderboard` with `stat=assists`, `season=2023/2024`

Your code runs the tool, and the answer (a small table) goes back to the AI,
which writes the Turkish reply. This step builds and tests the tools
**without any AI**, so you know they are right before the AI uses them.

You will write three files:

| File | What it is |
|---|---|
| `src/chat/tools.py` | The 9 tools, plus the code that checks their inputs |
| `src/chat/try_tool.py` | A command to run one tool by hand |
| `tests/test_chat_tools.py` | Tests on a tiny made-up season |

## The 9 tools

| Tool | Answers questions like |
|---|---|
| `list_seasons` | "Hangi sezonları biliyorsun?" (Which seasons do you know?) |
| `find_team` | turns "fener" into Fenerbahçe's `team_id` |
| `find_player` | turns "icardi" into Mauro Icardi's `player_id` |
| `find_matches` | "Beşiktaş–Fenerbahçe maçları nasıl bitti?" (How did the Beşiktaş–Fenerbahçe games end?) |
| `match_details` | "O maçta golleri kim attı?" (Who scored in that match?) |
| `player_season_stats` | "Džeko bu sezon kaç gol attı?" (How many goals has Džeko scored this season?) |
| `leaderboard` | "2023-24 gol krallığı" (the 2023-24 top scorers) |
| `standings` | "2022-23 puan durumu" (the 2022-23 league table) |
| `team_season_stats` | "Trabzonspor evinde nasıldı?" (How did Trabzonspor do at home?) |

Why `find_team` and `find_player` first? Names are messy: "fener",
"Fenerbahçe", "FB". The AI first turns a name into an **id** (a number that
means exactly one club or player), then uses the id everywhere else. If a
name matches several players, the tool says so, and the AI asks the visitor
which one instead of guessing.

## The safety rules (important for interviews)

1. **The AI never writes SQL.** We write every query. What the AI sends only
   fills in `?` placeholders. A visitor typing
   `'; DROP TABLE matches; --` as a team name is just searched for as text.
   This protects against **SQL injection**, a classic security bug.
2. **Stat names come from a fixed list** (`STATS`). Anything else is refused.
3. **The database is opened read-only.**
4. **A blank cell means "not recorded", never 0.**
5. **Mistakes come back as text** ("Error: season must be ..."), so the AI can
   read the error and try again instead of crashing.

---

## Part 1 — Write `src/chat/tools.py`

Create the file `src/chat/tools.py` and type (or paste) the parts below **in
order**, one after another in the same file. Read each explanation before
typing.

### 1A. The top of the file

```python
"""The chatbot's tools: the only way the AI can read match data.

Step 3 of the chatbot guide (docs/chatbot/03-the-tools.md).
"""
from __future__ import annotations

import csv
from dataclasses import dataclass, field
import io
from pathlib import Path
import re
import sqlite3
import sys
from typing import Callable

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.chat.build_chat_db import OUTPUT as DATABASE, search_name  # noqa: E402
from src.shared import CALLED_OFF_STATES, SeasonError, season_label  # noqa: E402
```

**What it does:**

- The text in `"""` is the **docstring**: a description of the file.
- `import ...` loads Python's built-in modules: `csv` writes tables as text,
  `sqlite3` talks to the database, `re` matches text patterns.
- `ROOT` is the project folder (two folders up from this file). Adding it to
  `sys.path` lets Python find `src.chat...` and `src.shared` when you run a
  file directly.
- We **reuse** two things from step 2: `DATABASE` (where `chat.sqlite` is) and
  `search_name` (turns "Beşiktaş" into "besiktas"). From `src/shared.py` we
  reuse the project's season rules and the list of called-off match states,
  so every part of your project agrees on these.
- `# noqa: E402` tells code checkers "yes, this import is not at the very
  top on purpose".

### 1B. Fixed lists and SQL pieces

```python
POSITIONS = ["Goalkeeper", "Defender", "Midfielder", "Attacker"]
POSITION_ORDER = ("CASE pm.position WHEN 'Goalkeeper' THEN 0 WHEN 'Defender' THEN 1 "
                  "WHEN 'Midfielder' THEN 2 WHEN 'Attacker' THEN 3 ELSE 4 END")

# Every stat a leaderboard can rank by: the SQL that totals it, and the column
# whose blanks show how well the season recorded it (None: always recorded).
STATS = {
    "goals":              ("SUM(pm.goals)", "goals"),
    "assists":            ("SUM(pm.assists)", "assists"),
    "goals_and_assists":  ("SUM(pm.goals) + SUM(pm.assists)", "assists"),
    "expected_goals":     ("ROUND(SUM(pm.expected_goals), 2)", "expected_goals"),
    "shots_total":        ("SUM(pm.shots_total)", "shots_total"),
    "shots_on_target":    ("SUM(pm.shots_on_target)", "shots_on_target"),
    "key_passes":         ("SUM(pm.key_passes)", "key_passes"),
    "big_chances_created": ("SUM(pm.big_chances_created)", "big_chances_created"),
    "passes":             ("SUM(pm.passes)", "passes"),
    "tackles":            ("SUM(pm.tackles)", "tackles"),
    "interceptions":      ("SUM(pm.interceptions)", "interceptions"),
    "clearances":         ("SUM(pm.clearances)", "clearances"),
    "saves":              ("SUM(pm.saves)", "saves"),
    "yellowcards":        ("SUM(pm.yellowcards)", "yellowcards"),
    "redcards":           ("SUM(pm.redcards)", "redcards"),
    "penalties_scored":   ("SUM(pm.penalties_scored)", "penalties_scored"),
    "own_goals":          ("SUM(pm.own_goals)", "own_goals"),
    "minutes":            ("SUM(pm.minutes)", None),
    "appearances":        ("COUNT(*)", None),
    "starts":             ("SUM(pm.started = 1)", None),
    "average_rating":     ("ROUND(AVG(pm.rating), 2)", "rating"),
}
RATING_MIN_MINUTES = 900

MATCH_COLUMNS = """m.fixture_id, m.season, m.round,
    strftime('%Y-%m-%d %H:%M', m.kickoff_utc, '+3 hours') AS kickoff_turkey,
    COALESCE(h.name, 'team ' || m.home_team_id) AS home_team, m.home_goals, m.away_goals,
    COALESCE(a.name, 'team ' || m.away_team_id) AS away_team"""
MATCH_JOINS = """FROM matches m
    LEFT JOIN teams h ON h.team_id = m.home_team_id
    LEFT JOIN teams a ON a.team_id = m.away_team_id"""
# Statistics count only appearances in finished matches.
APPEARANCES = "JOIN matches m ON m.fixture_id = pm.fixture_id AND m.finished = 1 WHERE pm.minutes > 0"


class ToolError(Exception):
    """A problem with what the AI asked for. Its message goes back to the AI."""
```

**What it does:**

- `STATS` is the **allowlist**: the only stats a leaderboard can rank by.
  Each entry is *(SQL that totals it, column to check for missing data)*.
  Because the AI can only *choose* a key from this dictionary, it can never
  put its own text into the SQL.
- `MATCH_COLUMNS` and `MATCH_JOINS` are SQL pieces several tools share: a
  match with both team names. `strftime(..., '+3 hours')` turns UTC time into
  Turkish time. `COALESCE(x, y)` means "x, or y if x is missing".
- `APPEARANCES` keeps only rows where the player actually played
  (`minutes > 0`) in a finished match. Bench players and live matches don't count.
- `ToolError` is our own kind of error, for "the AI asked for something
  wrong". Later we turn it into a friendly message.

### 1C. How answers look

```python
@dataclass
class Table:
    title: str
    rows: list[dict]


@dataclass
class Answer:
    tables: list[Table]
    notes: list[str] = field(default_factory=list)

    def as_text(self) -> str:
        """Each table as CSV under a "## title" line, then the notes."""
        parts = []
        for table in self.tables:
            parts.append(f"## {table.title}")
            if not table.rows:
                parts.append("(no rows)")
                continue
            buffer = io.StringIO()
            writer = csv.DictWriter(buffer, fieldnames=list(table.rows[0]), lineterminator="\n")
            writer.writeheader()
            writer.writerows({key: tidy(value) for key, value in row.items()} for row in table.rows)
            parts.append(buffer.getvalue().rstrip("\n"))
        parts += [f"Note: {note}" for note in self.notes]
        return "\n".join(parts)


def tidy(value):
    """90.0 -> 90, 7.2345 -> 7.23, None -> blank."""
    if isinstance(value, float):
        return int(value) if value.is_integer() else round(value, 2)
    return value
```

**What it does:**

- A `@dataclass` is a simple container: `Table` has a title and rows; `Answer`
  has tables and notes.
- `as_text()` turns an answer into text the AI reads, for example:

  ```
  ## 2023/2024 by goals
  player_id,player,teams,goals,appearances,minutes
  1234,Mauro Icardi,Galatasaray,25,34,2800
  Note: ...
  ```

  We use CSV (comma-separated) because it's short (fewer tokens, so
  cheaper) and it's the format your project already uses.
- `tidy()` makes numbers neat: `90.0` → `90`. `None` (not recorded) becomes
  a blank cell.

### 1D. Helpers the tools share

```python
def open_database(path: Path = DATABASE) -> sqlite3.Connection:
    """The chatbot database, read-only."""
    if not Path(path).is_file():
        raise SystemExit(f"{path} is missing. Build it first: python src/chat/build_chat_db.py")
    db = sqlite3.connect(f"{Path(path).resolve().as_uri()}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    return db


def rows(db, sql, params=()) -> list[dict]:
    return [dict(row) for row in db.execute(sql, params)]


def seasons(db) -> list[str]:
    return [row[0] for row in db.execute("SELECT season FROM seasons ORDER BY season")]


def season_arg(db, value, *, default_latest=True) -> str | None:
    """A season the database has, from 2023/2024, 2023-2024 or 2023-24.

    No season means the latest one, or None when default_latest is False.
    """
    available = seasons(db)
    if value is None or str(value).strip() == "":
        return available[-1] if default_latest and available else None
    text = str(value).strip()
    short = re.fullmatch(r"(\d{4})[-/](\d{2})", text)
    if short:
        text = f"{short[1]}/{short[1][:2]}{short[2]}"
    try:
        season = season_label(text)
    except SeasonError:
        raise ToolError(f"'{value}' is not a season. Use the form 2023/2024.") from None
    if season not in available:
        raise ToolError(f"There is no data for {season}. Seasons available: {', '.join(available)}.")
    return season


def team_name(db, team_id: int) -> str:
    row = db.execute("SELECT name FROM teams WHERE team_id = ?", (team_id,)).fetchone()
    if row is None:
        raise ToolError(f"No team has team_id {team_id}. Use find_team to get the id.")
    return row[0]


def player_name(db, player_id: int) -> str:
    row = db.execute("SELECT name FROM players WHERE player_id = ?", (player_id,)).fetchone()
    if row is None:
        raise ToolError(f"No player has player_id {player_id}. Use find_player to get the id.")
    return row[0]


def name_filter(text: str) -> tuple[str, list[str], str]:
    """SQL that matches every word of a name, its parameters, and the folded name."""
    folded = search_name(text)
    if not folded:
        raise ToolError("Give a name to search for.")
    words = [word.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") for word in folded.split()]
    sql = " AND ".join("search_name LIKE ? ESCAPE '\\'" for _ in words)
    return sql, [f"%{word}%" for word in words], folded


def ambiguity_note(found: list[dict], folded: str, what: str) -> list[str]:
    if not found:
        return [f"No {what} matches '{folded}'. Try another spelling or part of the name."]
    exact = [row for row in found if search_name(row["name"]) == folded]
    if len(found) > 1 and len(exact) != 1:
        return [f"Several {what}s match. If it is not clear which one the user means, ask them."]
    return []


def minute_text(minute, extra) -> str:
    if minute is None:
        return ""
    return f"{minute}+{extra}" if extra else str(minute)


def unfinished_count(db, season: str) -> int:
    """Matches of the season still to be played (called-off matches never will be)."""
    marks = ", ".join("?" for _ in CALLED_OFF_STATES)
    return db.execute(f"SELECT COUNT(*) FROM matches WHERE season = ? AND finished = 0 "
                      f"AND COALESCE(state, '') NOT IN ({marks})", (season, *sorted(CALLED_OFF_STATES))).fetchone()[0]


def record(team_id: int, matches: list[dict]) -> dict:
    """Played, won, drawn, lost, goals and points from one team's point of view."""
    totals = dict(played=0, won=0, drawn=0, lost=0, goals_for=0, goals_against=0, points=0)
    for match in matches:
        home = match["home_team_id"] == team_id
        mine, theirs = ((match["home_goals"], match["away_goals"]) if home
                        else (match["away_goals"], match["home_goals"]))
        if mine is None or theirs is None:
            continue
        totals["played"] += 1
        totals["goals_for"] += mine
        totals["goals_against"] += theirs
        outcome = "won" if mine > theirs else "drawn" if mine == theirs else "lost"
        totals[outcome] += 1
        totals["points"] += {"won": 3, "drawn": 1, "lost": 0}[outcome]
    return totals
```

**What it does:**

- `open_database()` opens `chat.sqlite` with `?mode=ro` (**read-only**).
  `row_factory = sqlite3.Row` lets us read columns by name.
- `rows()` runs a query and returns a list of dictionaries, one per row.
  Notice `params`: the values go in **separately** from the SQL. That's the
  `?` placeholder rule.
- `season_arg()` accepts `2023/2024`, `2023-2024` or `2023-24`, checks the
  database has that season, and otherwise explains which seasons exist.
- `team_name()` / `player_name()` check an id exists, and say "use
  find_team" if not. Error messages are written **for the AI**, telling it
  what to do next.
- `name_filter()` builds a search where **every word** must appear:
  "mert hakan" finds "Mert Hakan Yandaş". The `replace(...)` lines stop `%`
  and `_` from acting as wildcards.
- `ambiguity_note()` adds a note when several players or teams match.
- `minute_text()` writes `90` and `3` as `90+3`.
- `unfinished_count()` counts matches still to play, so tools can warn
  "this season is still being played".
- `record()` turns a list of matches into won/drawn/lost from **one team's**
  side (a 2–1 home win for one team is a 1–2 away loss for the other).

### 1E. The tools themselves

Each tool takes `db` (the database) plus its inputs, and returns an `Answer`.

```python
def list_seasons(db) -> Answer:
    table = rows(db, f"""
        SELECT s.season, COUNT(m.fixture_id) AS matches, COALESCE(SUM(m.finished), 0) AS finished,
               date(MIN(m.kickoff_utc)) AS first_match, date(MAX(m.kickoff_utc)) AS last_match
        FROM seasons s LEFT JOIN matches m ON m.season = s.season
        GROUP BY s.season ORDER BY s.season""")
    coverage = {row["season"]: row["percent"] for row in rows(db, f"""
        SELECT pm.season, ROUND(100.0 * SUM(pm.expected_goals IS NOT NULL) / COUNT(*)) AS percent
        FROM player_matches pm {APPEARANCES} GROUP BY pm.season""")}
    for row in table:
        row["expected_goals_recorded_percent"] = coverage.get(row["season"])
    return Answer([Table("Seasons", table)],
                  ["expected_goals_recorded_percent: share of appearances with expected goals (xG) recorded."])
```

**`list_seasons`:** one row per season with match counts and dates. It also
says how much xG data each season has, so the AI can warn "2021-22 has no xG".

```python
def find_team(db, name: str) -> Answer:
    sql, params, folded = name_filter(name)
    found = rows(db, f"""
        SELECT t.team_id, t.name, t.short_code,
               MIN(m.season) AS first_season, MAX(m.season) AS last_season
        FROM teams t LEFT JOIN matches m ON t.team_id IN (m.home_team_id, m.away_team_id)
        WHERE ({sql}) OR lower(t.short_code) = ?
        GROUP BY t.team_id ORDER BY (t.search_name = ?) DESC, t.name LIMIT 10""",
                 (*params, folded, folded))
    return Answer([Table("Teams", found)], ambiguity_note(found, folded, "team"))


def find_player(db, name: str, season: str | None = None) -> Answer:
    sql, params, folded = name_filter(name)
    season = season_arg(db, season, default_latest=False)
    in_season = ("AND EXISTS (SELECT 1 FROM player_matches x WHERE x.player_id = p.player_id "
                 "AND x.season = ? AND x.minutes > 0)") if season else ""
    found = rows(db, f"""
        SELECT p.player_id, p.name,
               MIN(pm.season) AS first_season, MAX(pm.season) AS last_season,
               COUNT(pm.player_id) AS appearances, SUM(pm.goals) AS goals
        FROM players p
        LEFT JOIN player_matches pm ON pm.player_id = p.player_id AND pm.minutes > 0
        WHERE ({sql}) {in_season}
        GROUP BY p.player_id ORDER BY (p.search_name = ?) DESC, appearances DESC, p.name LIMIT 10""",
                 (*params, *([season] if season else []), folded))
    for row in found:
        latest = db.execute("""
            SELECT t.name FROM player_matches pm JOIN matches m ON m.fixture_id = pm.fixture_id
            LEFT JOIN teams t ON t.team_id = pm.team_id
            WHERE pm.player_id = ? AND pm.minutes > 0 ORDER BY m.kickoff_utc DESC LIMIT 1""",
                            (row["player_id"],)).fetchone()
        row["latest_team"] = latest[0] if latest else None
    return Answer([Table("Players", found)], ambiguity_note(found, folded, "player"))
```

**`find_team` / `find_player`:** search by name (and, for teams, by short
code like `GS`). Results are sorted so an exact name comes first, then the
player with the most appearances. Each player row shows their latest club,
which helps the AI tell two players with similar names apart. The `season`
input narrows the search to players who played that season.

Notice the f-string `f"""..."""` only puts **our own** SQL pieces into the
query (`{sql}`, `{in_season}`); the visitor's words always go through
`params`.

```python
def find_matches(db, team_id: int, opponent_id: int | None = None, season: str | None = None,
                 venue: str = "any", limit: int = 10) -> Answer:
    team = team_name(db, team_id)
    where, params = ["m.finished = 1", "? IN (m.home_team_id, m.away_team_id)"], [team_id]
    if opponent_id is not None:
        team_name(db, opponent_id)
        where.append("? IN (m.home_team_id, m.away_team_id)")
        params.append(opponent_id)
    season = season_arg(db, season, default_latest=False)
    if season:
        where.append("m.season = ?")
        params.append(season)
    if venue == "home":
        where.append("m.home_team_id = ?")
        params.append(team_id)
    elif venue == "away":
        where.append("m.away_team_id = ?")
        params.append(team_id)
    found = rows(db, f"SELECT {MATCH_COLUMNS}, m.home_team_id, m.away_team_id {MATCH_JOINS} "
                     f"WHERE {' AND '.join(where)} ORDER BY m.kickoff_utc DESC", params)
    summary = {"team": team, **record(team_id, found)}
    summary.pop("points")
    for row in found:
        home = row.pop("home_team_id") == team_id
        row.pop("away_team_id")
        mine, theirs = (row["home_goals"], row["away_goals"]) if home else (row["away_goals"], row["home_goals"])
        row["result_for_team"] = ("" if mine is None or theirs is None
                                  else "win" if mine > theirs else "draw" if mine == theirs else "loss")
    notes = ["Only finished matches. kickoff_turkey is Turkish time."]
    if len(found) > limit:
        notes.append(f"Showing the {limit} most recent of {len(found)} matches; the summary counts all of them.")
    return Answer([Table("Summary", [summary]), Table("Matches", found[:limit])], notes)
```

**`find_matches`:** builds the `WHERE` conditions step by step: always
"finished" and "this team played", plus optional opponent, season and
home/away. It counts wins/draws/losses over **all** matching games, but lists
only the newest `limit` of them, to keep the answer short (and cheap).

```python
def match_details(db, fixture_id: int) -> Answer:
    match = rows(db, f"SELECT {MATCH_COLUMNS}, m.state, m.finished, m.home_team_id {MATCH_JOINS} "
                     "WHERE m.fixture_id = ?", (fixture_id,))
    if not match:
        raise ToolError(f"No match has fixture_id {fixture_id}. Use find_matches to get the id.")
    home_team_id = match[0].pop("home_team_id")
    kinds = {"GOAL": "goal", "PENALTY": "penalty goal", "OWNGOAL": "own goal", "MISSED_PENALTY": "missed penalty",
             "YELLOWCARD": "yellow card", "REDCARD": "red card", "YELLOWREDCARD": "second yellow (red card)"}
    events = rows(db, """
        SELECT e.type, e.minute, e.extra_minute, t.name AS team, p.name AS player,
               CASE WHEN e.type = 'GOAL' THEN r.name END AS assist
        FROM events e
        LEFT JOIN teams t ON t.team_id = e.team_id
        LEFT JOIN players p ON p.player_id = e.player_id
        LEFT JOIN players r ON r.player_id = e.related_player_id
        WHERE e.fixture_id = ? AND e.type != 'SUBSTITUTION'
        ORDER BY e.minute, COALESCE(e.extra_minute, 0), e.event_id""", (fixture_id,))
    goals, cards = [], []
    for event in events:
        row = {"minute": minute_text(event.pop("minute"), event.pop("extra_minute")),
               "kind": kinds[event.pop("type")], **event}
        if row["kind"] in {"goal", "penalty goal", "own goal"}:
            goals.append(row)
        else:
            row.pop("assist")
            cards.append(row)
    players = rows(db, f"""
        SELECT t.name AS team, p.name AS player, pm.position, pm.started, pm.minutes,
               pm.goals, pm.assists, pm.rating
        FROM player_matches pm
        LEFT JOIN teams t ON t.team_id = pm.team_id
        LEFT JOIN players p ON p.player_id = pm.player_id
        WHERE pm.fixture_id = ? AND pm.minutes > 0
        ORDER BY pm.team_id != ?, pm.started DESC, {POSITION_ORDER}, p.name""", (fixture_id, home_team_id))
    notes = [] if match[0]["finished"] else ["This match has not finished, so it has no result yet."]
    return Answer([Table("Match", match), Table("Goals", goals), Table("Cards and missed penalties", cards),
                   Table("Players who played", players)], notes)
```

**`match_details`:** four small tables for one match: the score, goals
(minute, scorer, assist), cards, and who played. Events come from the
`events` table. Substitutions are left out to keep the answer short. The
assist is in `related_player_id`, but only for normal goals, hence the `CASE`.
Players are sorted home team first, starters first, then goalkeeper →
defenders → midfielders → attackers.

```python
def player_season_stats(db, player_id: int, season: str | None = None, last_matches: int = 0) -> Answer:
    player = player_name(db, player_id)
    season = season_arg(db, season, default_latest=False)
    where, params = "pm.player_id = ?" + (" AND pm.season = ?" if season else ""), [player_id] + ([season] if season else [])
    totals = rows(db, f"""
        SELECT pm.season, GROUP_CONCAT(DISTINCT t.name) AS teams,
               COUNT(*) AS appearances, SUM(pm.started = 1) AS starts, SUM(pm.minutes) AS minutes,
               SUM(pm.goals) AS goals, SUM(pm.assists) AS assists,
               ROUND(SUM(pm.expected_goals), 2) AS expected_goals,
               SUM(pm.shots_total) AS shots, SUM(pm.shots_on_target) AS shots_on_target,
               SUM(pm.key_passes) AS key_passes, SUM(pm.yellowcards) AS yellow_cards,
               SUM(pm.redcards) + SUM(pm.yellowred_cards) AS red_cards,
               ROUND(AVG(pm.rating), 2) AS average_rating,
               SUM(pm.expected_goals IS NOT NULL) AS xg_recorded
        FROM player_matches pm LEFT JOIN teams t ON t.team_id = pm.team_id
        {APPEARANCES} AND {where}
        GROUP BY pm.season ORDER BY pm.season""", params)
    notes = []
    for row in totals:
        recorded = row.pop("xg_recorded")
        if recorded < row["appearances"]:
            notes.append(f"{row['season']}: expected goals recorded in only {recorded} of "
                         f"{row['appearances']} appearances.")
    if not totals:
        notes.append(f"{player} has no appearances" + (f" in {season}." if season else " in the database."))
    tables = [Table(f"{player}: season totals", totals)]
    if last_matches:
        recent = rows(db, f"""
            SELECT pm.season, strftime('%Y-%m-%d', m.kickoff_utc, '+3 hours') AS date,
                   CASE WHEN pm.team_id = m.home_team_id THEN 'home' ELSE 'away' END AS venue,
                   COALESCE(CASE WHEN pm.team_id = m.home_team_id THEN a.name ELSE h.name END, '') AS opponent,
                   m.home_goals, m.away_goals, pm.minutes, pm.goals, pm.assists, pm.rating, m.fixture_id
            FROM player_matches pm
            JOIN matches m ON m.fixture_id = pm.fixture_id AND m.finished = 1
            LEFT JOIN teams h ON h.team_id = m.home_team_id
            LEFT JOIN teams a ON a.team_id = m.away_team_id
            WHERE pm.minutes > 0 AND {where}
            ORDER BY m.kickoff_utc DESC LIMIT ?""", (*params, last_matches))
        tables.append(Table(f"{player}: last {last_matches} matches", recent))
    return Answer(tables, notes)
```

**`player_season_stats`:** one row per season with the player's totals.
`GROUP BY pm.season` adds up all their matches per season, and
`GROUP_CONCAT(DISTINCT t.name)` lists their club(s), in case they moved
mid-season. It counts how many matches had xG recorded and adds a note when
that's fewer than all of them, so the AI won't present a partial xG total as
complete. With `last_matches=5` it also lists their five most recent games.

```python
def leaderboard(db, stat: str, season: str | None = None, position: str | None = None,
                team_id: int | None = None, min_minutes: int | None = None, limit: int = 10) -> Answer:
    expression, recorded_column = STATS[stat]
    season = season_arg(db, season)
    notes = []
    if min_minutes is None:
        min_minutes = RATING_MIN_MINUTES if stat == "average_rating" else 0
        if min_minutes:
            notes.append(f"Only players with at least {min_minutes} minutes are ranked.")
    where, params = ["pm.season = ?"], [season]
    if position:
        where.append("pm.position = ?")
        params.append(position)
    if team_id is not None:
        where.append("pm.team_id = ?")
        params.append(team_id)
        notes.append(f"Only appearances for {team_name(db, team_id)}.")
    found = rows(db, f"""
        SELECT pm.player_id, p.name AS player, GROUP_CONCAT(DISTINCT t.name) AS teams,
               {expression} AS {stat}, COUNT(*) AS appearances, SUM(pm.minutes) AS minutes
        FROM player_matches pm
        LEFT JOIN players p ON p.player_id = pm.player_id
        LEFT JOIN teams t ON t.team_id = pm.team_id
        {APPEARANCES} AND {' AND '.join(where)}
        GROUP BY pm.player_id
        HAVING ({expression}) IS NOT NULL AND SUM(pm.minutes) >= ?
        ORDER BY {stat} DESC, minutes ASC, player LIMIT ?""", (*params, min_minutes, limit))
    if recorded_column:
        share = db.execute(f"SELECT 100.0 * SUM(pm.{recorded_column} IS NOT NULL) / COUNT(*) "
                           f"FROM player_matches pm {APPEARANCES} AND pm.season = ?", (season,)).fetchone()[0]
        if share is not None and share < 90:
            notes.append(f"{stat} is recorded in only {round(share)}% of appearances in {season}, "
                         "so these totals undercount.")
    if unfinished_count(db, season):
        notes.append(f"{season} is still being played; these are the totals so far.")
    position_text = f" {position.lower()}s" if position else ""
    return Answer([Table(f"{season}{position_text} by {stat}", found)], notes)
```

**`leaderboard`:** the most useful tool. `STATS[stat]` looks up the SQL for
the chosen stat (from the allowlist only). `HAVING` filters *after* adding
up. It repeats the full formula (`{expression}`) rather than the short
name, because a short name like `goals` is also a column name and SQL could
mix the two up. `min_minutes` then removes players who barely played. That matters for
`average_rating`, where a player with one great 10-minute game shouldn't top
the list (so it defaults to 900 minutes, about 10 full games). Ties are broken
by fewer minutes, because the same goals in less time is more impressive. Two
honesty notes: missing data ("xG recorded in only 34%") and a season still in
progress.

```python
def standings(db, season: str | None = None) -> Answer:
    season = season_arg(db, season)
    table = rows(db, """
        SELECT s.stage_id, s.group_id, s.position, COALESCE(t.name, 'team ' || s.team_id) AS team, s.team_id,
               s.played, s.won, s.drawn, s.lost, s.goals_for, s.goals_against,
               s.goals_for - s.goals_against AS goal_difference, s.points
        FROM standings s LEFT JOIN teams t ON t.team_id = s.team_id
        WHERE s.season = ? ORDER BY s.stage_id, s.group_id, s.position""", (season,))
    if len({(row["stage_id"], row["group_id"]) for row in table}) <= 1:
        for row in table:
            del row["stage_id"], row["group_id"]
    notes = []
    if unfinished_count(db, season):
        notes.append(f"{season} is still being played; this is the table as last saved.")
    return Answer([Table(f"{season} league table", table)], notes)


def team_season_stats(db, team_id: int, season: str | None = None) -> Answer:
    team = team_name(db, team_id)
    season = season_arg(db, season)
    matches = rows(db, "SELECT home_team_id, away_team_id, home_goals, away_goals FROM matches "
                       "WHERE season = ? AND finished = 1 AND ? IN (home_team_id, away_team_id)", (season, team_id))
    records = []
    for venue, chosen in (("overall", matches),
                          ("home", [m for m in matches if m["home_team_id"] == team_id]),
                          ("away", [m for m in matches if m["away_team_id"] == team_id])):
        records.append({"venue": venue, **record(team_id, chosen)})
    position = db.execute("SELECT position, points FROM standings WHERE season = ? AND team_id = ? "
                          "ORDER BY stage_id LIMIT 1", (season, team_id)).fetchone()
    scorers = rows(db, f"""
        SELECT pm.player_id, p.name AS player, SUM(pm.goals) AS goals, SUM(pm.assists) AS assists,
               COUNT(*) AS appearances, SUM(pm.minutes) AS minutes
        FROM player_matches pm LEFT JOIN players p ON p.player_id = pm.player_id
        {APPEARANCES} AND pm.team_id = ? AND pm.season = ?
        GROUP BY pm.player_id ORDER BY goals DESC, assists DESC, minutes DESC LIMIT 5""", (team_id, season))
    notes = []
    if position:
        notes.append(f"League position in the saved table: {position['position']} with {position['points']} points.")
    if unfinished_count(db, season):
        notes.append(f"{season} is still being played; these are the numbers so far.")
    return Answer([Table(f"{team} {season} record", records), Table(f"{team} {season} top scorers", scorers)], notes)
```

**`standings`:** the saved league table. The stage/group columns are only
kept when a season has more than one table.
**`team_season_stats`:** a club's season record overall, at home and away
(computed with `record()` from step 1D), its league position, and its top 5 scorers.

### 1F. The list the AI sees

```python
@dataclass
class Tool:
    name: str
    description: str
    parameters: dict
    function: Callable[..., Answer]


def schema(properties: dict, required=()) -> dict:
    return {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False}


SEASON = {"type": "string", "description": "Season such as 2023/2024."}
SEASON_LATEST = {"type": "string", "description": "Season such as 2023/2024. Leave out for the latest season."}

TOOLS = [
    Tool("list_seasons",
         "List the seasons in the database, how many matches each has, and how well expected goals (xG) "
         "were recorded. Use it when the user asks which seasons you know about.",
         schema({}), list_seasons),
    Tool("find_team",
         "Find a club's team_id from its name or short code (for example 'fener', 'Beşiktaş', 'GS'). "
         "Call this before any tool that needs a team_id.",
         schema({"name": {"type": "string", "description": "Club name, part of it, or short code."}}, ["name"]),
         find_team),
    Tool("find_player",
         "Find a player's player_id from their name, with the seasons they played and their latest club. "
         "Call this before any tool that needs a player_id. If several players match, ask the user which one.",
         schema({"name": {"type": "string", "description": "Player name or part of it."},
                 "season": {**SEASON, "description": "Optional: only players who played in this season."}},
                ["name"]),
         find_player),
    Tool("find_matches",
         "Finished matches of one team, newest first, with a win/draw/loss summary. Add opponent_id for "
         "head-to-head results, season to limit to one season, and venue for home or away games only.",
         schema({"team_id": {"type": "integer"},
                 "opponent_id": {"type": "integer", "description": "Optional second team, for head-to-head."},
                 "season": {**SEASON, "description": "Optional. Leave out for every season."},
                 "venue": {"type": "string", "enum": ["any", "home", "away"]},
                 "limit": {"type": "integer", "minimum": 1, "maximum": 50,
                           "description": "How many matches to list (default 10)."}},
                ["team_id"]),
         find_matches),
    Tool("match_details",
         "Everything about one match: score, goals with scorers and assists, cards, and the players "
         "who played with their minutes and ratings.",
         schema({"fixture_id": {"type": "integer"}}, ["fixture_id"]),
         match_details),
    Tool("player_season_stats",
         "A player's totals per season: appearances, minutes, goals, assists, xG, shots, cards and average "
         "rating. Set last_matches to also list their most recent matches.",
         schema({"player_id": {"type": "integer"},
                 "season": {**SEASON, "description": "Optional. Leave out for every season."},
                 "last_matches": {"type": "integer", "minimum": 0, "maximum": 20,
                                  "description": "How many recent matches to list (default 0)."}},
                ["player_id"]),
         player_season_stats),
    Tool("leaderboard",
         "Rank players in one season by a stat, for questions like 'top scorers' or 'most assists by a "
         "defender'. Can be limited to one position or one team.",
         schema({"stat": {"type": "string", "enum": list(STATS)},
                 "season": SEASON_LATEST,
                 "position": {"type": "string", "enum": POSITIONS},
                 "team_id": {"type": "integer", "description": "Optional: only appearances for this team."},
                 "min_minutes": {"type": "integer", "minimum": 0,
                                 "description": f"Optional minimum minutes played (default 0; "
                                                f"{RATING_MIN_MINUTES} for average_rating)."},
                 "limit": {"type": "integer", "minimum": 1, "maximum": 30,
                           "description": "How many players to list (default 10)."}},
                ["stat"]),
         leaderboard),
    Tool("standings",
         "The league table for a season: position, played, won, drawn, lost, goals and points.",
         schema({"season": SEASON_LATEST}),
         standings),
    Tool("team_season_stats",
         "One club's season: overall, home and away record, league position, and its top scorers.",
         schema({"team_id": {"type": "integer"}, "season": SEASON_LATEST}, ["team_id"]),
         team_season_stats),
]
TOOLS_BY_NAME = {tool.name: tool for tool in TOOLS}
```

**What it does:** this is the "menu" the AI reads in step 4. Each `Tool` has:

- a **name** the AI uses to call it,
- a **description**, in English because models follow English instructions
  most reliably (the *answer* will still be Turkish). Good descriptions are
  the most important part of tool design: they tell the AI *when* to use
  each tool,
- **parameters**, written as a **JSON Schema**: the standard way to say "this
  input is a whole number", "this one must be home, away or any",
  "`team_id` is required". All AI providers understand this format.

### 1G. Checking inputs and running a tool

```python
def check_arguments(tool: Tool, arguments: dict) -> dict:
    """The inputs, checked against the tool's list. Whole-number text such as "12" is accepted as 12."""
    properties = tool.parameters["properties"]
    unknown = sorted(set(arguments) - set(properties))
    if unknown:
        raise ToolError(f"{tool.name} has no input called {', '.join(unknown)}. "
                        f"Its inputs are: {', '.join(properties) or 'none'}.")
    missing = [name for name in tool.parameters["required"] if arguments.get(name) in (None, "")]
    if missing:
        raise ToolError(f"{tool.name} needs {', '.join(missing)}.")
    checked = {}
    for name, value in arguments.items():
        spec = properties[name]
        if value is None:
            continue
        if spec["type"] == "integer":
            if isinstance(value, str) and re.fullmatch(r"\s*-?\d+\s*", value):
                value = int(value)
            if isinstance(value, bool) or not isinstance(value, int):
                raise ToolError(f"{name} must be a whole number.")
            if value < spec.get("minimum", value) or value > spec.get("maximum", value):
                raise ToolError(f"{name} must be between {spec.get('minimum', '-')} and {spec.get('maximum', '-')}.")
        elif spec["type"] == "string":
            if not isinstance(value, str):
                raise ToolError(f"{name} must be text.")
            value = value.strip()
            if "enum" in spec and value not in spec["enum"]:
                raise ToolError(f"{name} must be one of: {', '.join(spec['enum'])}.")
        checked[name] = value
    return checked


def run_tool(db, name: str, arguments: dict | None = None) -> str:
    """Run one tool and return its answer as text. Mistakes come back as "Error: ..." text,
    so the AI can read them and try again."""
    tool = TOOLS_BY_NAME.get(name)
    if tool is None:
        return f"Error: there is no tool called {name}. Tools: {', '.join(TOOLS_BY_NAME)}."
    try:
        return tool.function(db, **check_arguments(tool, arguments or {})).as_text()
    except ToolError as error:
        return f"Error: {error}"


def definitions() -> list[dict]:
    """The tools in the form AI providers expect: name, description, input schema."""
    return [{"name": tool.name, "description": tool.description, "input_schema": tool.parameters}
            for tool in TOOLS]
```

**What it does:**

- `check_arguments()` is the **guard**. Before any tool runs it checks: no
  unknown inputs, nothing required missing, numbers are numbers, and choices
  (like `stat`) are from the allowed list. **Never trust input**, even from
  your own AI: models sometimes send wrong types or invent inputs.
- `run_tool()` is the **one door** to all tools: find the tool by name, check
  the inputs, run it, return text. A `ToolError` becomes `"Error: ..."` text
  instead of a crash.
- `definitions()` produces the menu in the format AI APIs expect. We'll use it
  in step 4.

✅ Save the file. `tools.py` is done.

---

## Part 2 — Write `src/chat/try_tool.py`

A small command to run any tool by hand, the same way the AI will.

```python
"""Try one chatbot tool from the terminal, the way the AI will call it.

    python src/chat/try_tool.py                                   # list the tools
    python src/chat/try_tool.py find_player name=icardi
    python src/chat/try_tool.py leaderboard stat=goals season=2023/2024
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.chat.tools import TOOLS, open_database, run_tool  # noqa: E402


def main():
    # Windows terminals may not print Turkish letters without this.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) < 2:
        for tool in TOOLS:
            inputs = ", ".join(tool.parameters["properties"]) or "no inputs"
            print(f"{tool.name}  ({inputs})\n    {tool.description}\n")
        return
    name, arguments = sys.argv[1], {}
    for item in sys.argv[2:]:
        key, separator, value = item.partition("=")
        if not separator:
            raise SystemExit(f"Write inputs as name=value, for example season=2023/2024 (got '{item}').")
        arguments[key] = value
    db = open_database()
    try:
        print(run_tool(db, name, arguments))
    finally:
        db.close()


if __name__ == "__main__":
    main()
```

**What it does:** `sys.argv` is the list of words you typed after
`python src/chat/try_tool.py`. The first word is the tool name; every
`key=value` after it becomes an input. With no words, it prints the menu.
`try ... finally` makes sure the database is closed even if something fails.

---

## Part 3 — Write `tests/test_chat_tools.py`

The tests build a tiny made-up database **in memory** (no file) with two
seasons, two clubs and four players, then check every tool's answer.
Writing tests where you already know the right answer is how you prove the
tools are correct before trusting them with real questions.

```python
"""The chatbot's tools (src/chat/tools.py), on a tiny made-up database."""
import sqlite3
import unittest

from src.chat import build_chat_db, tools
from src.chat.build_chat_db import search_name


def insert(db, table, **values):
    columns = list(values)
    db.execute(f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
               list(values.values()))


def sample_database():
    """2023/24: Beşiktaş 2-1 Fenerbahçe, Fenerbahçe 3-0 Beşiktaş, one unplayed. 2022/23: 1-1."""
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript(build_chat_db.SCHEMA)
    for season in ("2022/2023", "2023/2024"):
        insert(db, "seasons", season=season)
    for team_id, name, code in ((10, "Beşiktaş", "BJK"), (20, "Fenerbahçe", "FB")):
        insert(db, "teams", team_id=team_id, name=name, short_code=code, search_name=search_name(name))
    for player_id, name in ((100, "Ciro Immobile"), (200, "Edin Džeko"),
                            (201, "Mert Hakan Yandaş"), (202, "Mert Müldür")):
        insert(db, "players", player_id=player_id, name=name, search_name=search_name(name))
    for fixture_id, season, kickoff, state, finished, home, away, home_goals, away_goals in (
            (1, "2023/2024", "2023-09-01T17:00:00Z", "FT", 1, 10, 20, 2, 1),
            (2, "2023/2024", "2024-02-01T17:00:00Z", "FT", 1, 20, 10, 3, 0),
            (3, "2023/2024", "2024-05-01T17:00:00Z", "NS", 0, 10, 20, None, None),
            (4, "2022/2023", "2022-10-01T17:00:00Z", "FT", 1, 10, 20, 1, 1)):
        insert(db, "matches", fixture_id=fixture_id, season=season, round="1", kickoff_utc=kickoff, state=state,
               finished=finished, home_team_id=home, away_team_id=away, home_goals=home_goals, away_goals=away_goals)
    seasons = {1: "2023/2024", 2: "2023/2024", 4: "2022/2023"}
    for fixture_id, player_id, team_id, position, started, minutes, rating, xg, goals, assists in (
            (1, 100, 10, "Attacker", 1, 90, 8.1, 1.5, 2, 0),
            (1, 200, 20, "Attacker", 1, 90, 7.0, None, 1, 0),
            (2, 200, 20, "Attacker", 1, 90, 8.5, 0.9, 2, 1),
            (2, 100, 10, "Attacker", 1, 60, 6.2, 0.2, 0, 0),
            (2, 201, 20, "Midfielder", 0, 30, 7.1, None, 1, 0),
            (2, 202, 20, "Defender", 0, None, None, None, None, None),   # on the bench, did not play
            (4, 202, 20, "Defender", 1, 90, 7.4, None, 1, 0)):
        insert(db, "player_matches", fixture_id=fixture_id, player_id=player_id, season=seasons[fixture_id],
               team_id=team_id, position=position, started=started, minutes=minutes, rating=rating,
               expected_goals=xg, goals=goals, assists=assists, yellowcards=0, redcards=0, yellowred_cards=0)
    for event_id, kind, minute, extra, team_id, player_id, related in (
            (1, "GOAL", 12, None, 10, 100, None),
            (2, "GOAL", 40, None, 20, 200, 201),
            (3, "YELLOWCARD", 55, None, 20, 200, None),
            (4, "SUBSTITUTION", 70, None, 20, 201, 200),
            (5, "PENALTY", 90, 3, 10, 100, None)):
        insert(db, "events", fixture_id=1, event_id=event_id, season="2023/2024", type=kind, minute=minute,
               extra_minute=extra, team_id=team_id, player_id=player_id, related_player_id=related)
    for team_id, position, won, lost, scored, conceded in ((20, 1, 1, 1, 4, 2), (10, 2, 1, 1, 2, 4)):
        insert(db, "standings", season="2023/2024", stage_id=5, group_id="", team_id=team_id, position=position,
               points=3, played=2, won=won, drawn=0, lost=lost, goals_for=scored, goals_against=conceded)
    return db


def names(answer, table=0, column="name"):
    return [row[column] for row in answer.tables[table].rows]


class ToolTests(unittest.TestCase):
    def setUp(self):
        self.db = sample_database()

    def tearDown(self):
        self.db.close()

    def test_list_seasons(self):
        rows = tools.list_seasons(self.db).tables[0].rows
        self.assertEqual([(r["season"], r["matches"], r["finished"]) for r in rows],
                         [("2022/2023", 1, 1), ("2023/2024", 3, 2)])
        self.assertEqual(rows[1]["expected_goals_recorded_percent"], 60)

    def test_find_team_by_name_or_short_code(self):
        self.assertEqual(names(tools.find_team(self.db, "fener")), ["Fenerbahçe"])
        self.assertEqual(names(tools.find_team(self.db, "BJK")), ["Beşiktaş"])
        missing = tools.find_team(self.db, "galatasaray")
        self.assertEqual(names(missing), [])
        self.assertIn("No team matches", missing.notes[0])

    def test_find_player_flags_several_matches(self):
        answer = tools.find_player(self.db, "mert")
        self.assertEqual(names(answer), ["Mert Hakan Yandaş", "Mert Müldür"])
        self.assertIn("ask them", answer.notes[0])
        self.assertEqual(names(tools.find_player(self.db, "mert", season="2022/2023")), ["Mert Müldür"])
        exact = tools.find_player(self.db, "Edin Dzeko")
        self.assertEqual((names(exact), exact.notes), (["Edin Džeko"], []))
        self.assertEqual(exact.tables[0].rows[0]["latest_team"], "Fenerbahçe")

    def test_find_matches_head_to_head(self):
        answer = tools.find_matches(self.db, 10, opponent_id=20)
        summary = answer.tables[0].rows[0]
        self.assertEqual((summary["played"], summary["won"], summary["drawn"], summary["lost"],
                          summary["goals_for"], summary["goals_against"]), (3, 1, 1, 1, 3, 5))
        self.assertEqual(names(answer, 1, "fixture_id"), [2, 1, 4])   # newest first, unplayed left out
        self.assertEqual(names(answer, 1, "result_for_team"), ["loss", "win", "draw"])

    def test_find_matches_filters_and_limit(self):
        self.assertEqual(names(tools.find_matches(self.db, 10, season="2023-24"), 1, "fixture_id"), [2, 1])
        self.assertEqual(names(tools.find_matches(self.db, 10, venue="home"), 1, "fixture_id"), [1, 4])
        short = tools.find_matches(self.db, 10, limit=2)
        self.assertEqual(len(short.tables[1].rows), 2)
        self.assertIn("2 most recent of 3", short.notes[-1])

    def test_match_details(self):
        answer = tools.match_details(self.db, 1)
        goals = answer.tables[1].rows
        self.assertEqual([(g["minute"], g["kind"], g["player"]) for g in goals],
                         [("12", "goal", "Ciro Immobile"), ("40", "goal", "Edin Džeko"),
                          ("90+3", "penalty goal", "Ciro Immobile")])
        self.assertEqual(goals[1]["assist"], "Mert Hakan Yandaş")
        self.assertEqual([(c["minute"], c["kind"]) for c in answer.tables[2].rows], [("55", "yellow card")])
        self.assertEqual(names(answer, 3, "player"), ["Ciro Immobile", "Edin Džeko"])   # home team first

    def test_leaderboard_goals(self):
        answer = tools.leaderboard(self.db, "goals", season="2023/2024")
        self.assertEqual([(r["player"], r["goals"]) for r in answer.tables[0].rows],
                         [("Edin Džeko", 3), ("Ciro Immobile", 2), ("Mert Hakan Yandaş", 1)])
        self.assertTrue(any("still being played" in note for note in answer.notes))

    def test_leaderboard_warns_about_missing_data(self):
        answer = tools.leaderboard(self.db, "expected_goals")   # no season: the latest one
        self.assertEqual([(r["player"], r["expected_goals"]) for r in answer.tables[0].rows],
                         [("Ciro Immobile", 1.7), ("Edin Džeko", 0.9)])
        self.assertTrue(any("only 60%" in note for note in answer.notes))

    def test_leaderboard_position_and_minimum_minutes(self):
        answer = tools.leaderboard(self.db, "goals", season="2022/2023", position="Defender")
        self.assertEqual(names(answer, column="player"), ["Mert Müldür"])
        rating = tools.leaderboard(self.db, "average_rating")
        self.assertEqual(rating.tables[0].rows, [])
        self.assertIn("at least 900 minutes", rating.notes[0])

    def test_player_season_stats(self):
        answer = tools.player_season_stats(self.db, 200, last_matches=1)
        totals = answer.tables[0].rows[0]
        self.assertEqual((totals["season"], totals["appearances"], totals["goals"], totals["assists"],
                          totals["expected_goals"]), ("2023/2024", 2, 3, 1, 0.9))
        self.assertIn("recorded in only 1 of 2", answer.notes[0])
        recent = answer.tables[1].rows[0]
        self.assertEqual((recent["venue"], recent["opponent"], recent["fixture_id"]), ("home", "Beşiktaş", 2))

    def test_standings_and_team_season(self):
        self.assertEqual(names(tools.standings(self.db), column="team"), ["Fenerbahçe", "Beşiktaş"])
        answer = tools.team_season_stats(self.db, 10, "2023/2024")
        overall, home, away = answer.tables[0].rows
        self.assertEqual((overall["played"], overall["won"], overall["lost"], overall["points"]), (2, 1, 1, 3))
        self.assertEqual((home["won"], away["lost"]), (1, 1))
        self.assertEqual(names(answer, 1, "player"), ["Ciro Immobile"])
        self.assertIn("League position in the saved table: 2", answer.notes[0])


class RunToolTests(unittest.TestCase):
    def setUp(self):
        self.db = sample_database()

    def tearDown(self):
        self.db.close()

    def test_answers_are_text_tables(self):
        text = tools.run_tool(self.db, "leaderboard", {"stat": "goals", "season": "2023/2024"})
        self.assertIn("## 2023/2024 by goals", text)
        self.assertIn("Edin Džeko,Fenerbahçe,3,2,180", text)   # 180.0 minutes is written as 180

    def test_numbers_typed_as_text_are_accepted(self):
        self.assertIn("## Matches", tools.run_tool(self.db, "find_matches", {"team_id": "10", "limit": "2"}))

    def test_mistakes_come_back_as_errors(self):
        cases = {
            ("nope", ()): "there is no tool called nope",
            ("find_matches", ()): "find_matches needs team_id",
            ("find_matches", (("team", "x"),)): "has no input called team",
            ("find_matches", (("team_id", "ten"),)): "team_id must be a whole number",
            ("find_matches", (("team_id", 10), ("limit", 99))): "limit must be between 1 and 50",
            ("find_matches", (("team_id", 99),)): "No team has team_id 99",
            ("leaderboard", (("stat", "height"),)): "stat must be one of",
            ("standings", (("season", "2019/2020"),)): "Seasons available: 2022/2023, 2023/2024",
            ("standings", (("season", "last year"),)): "is not a season",
        }
        for (name, arguments), expected in cases.items():
            with self.subTest(name=name, arguments=arguments):
                text = tools.run_tool(self.db, name, dict(arguments))
                self.assertTrue(text.startswith("Error:"), text)
                self.assertIn(expected, text)

    def test_text_in_a_name_cannot_change_the_query(self):
        text = tools.run_tool(self.db, "find_team", {"name": "x'; DROP TABLE teams; --"})
        self.assertIn("No team matches", text)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM teams").fetchone()[0], 2)

    def test_every_tool_has_a_definition(self):
        definitions = tools.definitions()
        self.assertEqual([d["name"] for d in definitions], list(tools.TOOLS_BY_NAME))
        for definition in definitions:
            self.assertTrue(definition["description"])
            self.assertEqual(definition["input_schema"]["type"], "object")


if __name__ == "__main__":
    unittest.main()
```

**What it does:**

- `sample_database()` builds a fake mini league using the **same schema** as
  step 2 (`build_chat_db.SCHEMA`), so the tests match the real database.
- Each test calls a tool and checks the answer against numbers we can work
  out by hand. For example, Beşiktaş vs Fenerbahçe: won 1, drawn 1, lost 1,
  goals 3–5.
- `test_mistakes_come_back_as_errors` checks every guard in
  `check_arguments()`. `subTest` runs each case separately, so one failure
  doesn't hide the others.
- `test_text_in_a_name_cannot_change_the_query` is a tiny **security test**:
  the SQL-injection text is treated as a name, and the `teams` table is
  still there afterwards.

---

## Part 4 — Run it

### 1. Run the tests

```bash
python -m unittest tests.test_chat_tools -v
```

✅ Every line ends in `ok`, and the last line is `OK`.
❌ `FAILED` or `ERROR`: usually a typing mistake. The error shows the file and
line number; compare that line with the guide. If you're stuck, paste the
whole output to me.

### 2. See the menu

```bash
python src/chat/try_tool.py
```

### 3. Try real questions

Find a team and a player first (note the ids they print):

```bash
python src/chat/try_tool.py find_team name=fener
```

```bash
python src/chat/try_tool.py find_player name=icardi
```

Then use the ids. Replace `TEAM_ID` / `PLAYER_ID` with the numbers you got:

```bash
python src/chat/try_tool.py leaderboard stat=assists season=2023/2024
```

```bash
python src/chat/try_tool.py player_season_stats player_id=PLAYER_ID last_matches=5
```

```bash
python src/chat/try_tool.py team_season_stats team_id=TEAM_ID season=2022/2023
```

```bash
python src/chat/try_tool.py find_matches team_id=TEAM_ID venue=home limit=5
```

Pick a `fixture_id` from that list:

```bash
python src/chat/try_tool.py match_details fixture_id=FIXTURE_ID
```

And check the guards with a mistake on purpose:

```bash
python src/chat/try_tool.py leaderboard stat=height
```

✅ That last one should print `Error: stat must be one of: goals, assists, ...`

👀 **Think like the AI:** for each answer, ask yourself "could I write a
correct Turkish reply from *only* this text?" If something is missing or
confusing, note it. Improving tool outputs is a big part of AI engineering.

## ✅ You're done when

- the tests say `OK`,
- the example commands print sensible tables for real players and clubs,
- the deliberate mistake prints an `Error:` line.

Next: **step 4: connect the AI.** You'll create an API account, and we'll
write the loop where the AI calls these tools.
