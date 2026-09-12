"""standings.csv - the league table, one row per team and standings group.

Points and position are the provider's and are never recalculated. Everything
else prefers the provider's own total and falls back to counting the saved
results, exactly as the page did: the fallback is reported per metric in
``derived`` so the site can still mark those cells with an asterisk.

The fallback only fires when the results are complete for that team - every
finished fixture has a saved score for both sides, and the count agrees with
the provider's matches played. A partial count would read as a real total and
quietly understate a team that had one unscored match.
"""
from __future__ import annotations

from . import common

# Provider column suffix to the name the table publishes.
METRICS = [("overall_matches", "played"), ("overall_wins", "wins"), ("overall_draws", "draws"),
           ("overall_lost", "losses"), ("overall_scored", "scored"),
           ("overall_conceded", "conceded"), ("overall_goal_difference", "difference")]

# European places by finishing position. Presentation reads the label from the
# competition code, so only the code is published.
QUALIFICATION = {1: "ucl", 2: "ucl", 3: "uel", 4: "uecl"}

COLUMNS = ["group_key", "league_id", "stage_id", "group_id", "position", "qualification",
           "team_id", "team_name", "short_code", "points", "played", "wins", "draws",
           "losses", "scored", "conceded", "difference", "derived"]


def group_key(row: dict) -> str:
    return ":".join(str(row.get(name) or "") for name in ("league_id", "stage_id", "group_id"))


def scoped_fixtures(season: common.Season, standing: dict) -> list[dict]:
    """This team's fixtures in this standing's own competition, stage and group."""
    team_id = str(standing.get("participant_id") or "")
    return [fixture for fixture in season.fixtures
            if team_id in (str(fixture.get("home_team_id") or ""), str(fixture.get("away_team_id") or ""))
            and all(not standing.get(name) or str(fixture.get(name) or "") == str(standing.get(name))
                    for name in ("season_id", "league_id", "stage_id", "group_id"))]


def scoped_results(season: common.Season, standing: dict) -> tuple[list[dict], int]:
    """The team's played rows in scope, and how many finished fixtures lack a score."""
    team_id = str(standing.get("participant_id") or "")
    finished = [fixture for fixture in scoped_fixtures(season, standing) if common.is_finished(fixture)]
    ids = {str(fixture.get("fixture_id") or "") for fixture in finished}
    games = [match for match in season.played
             if match["team_id"] == team_id and match["fixture_id"] in ids]
    return games, len(finished) - len(games)


def counted_results(season: common.Season, standing: dict) -> dict:
    """Wins, goals and the rest from saved scores, or None where they are unknown."""
    scoped = scoped_fixtures(season, standing)
    games, unscored = scoped_results(season, standing)
    official_played = common.number(standing.get("details.overall_matches"))
    complete = (bool(scoped) and unscored == 0
                and (official_played is None or official_played == len(games)))
    if not scoped:
        return {name: None for _, name in METRICS}
    total = lambda pick: sum(pick(game) for game in games) if complete else None  # noqa: E731
    return {
        "played": len(games),
        "wins": total(lambda game: game["result"] == "W"),
        "draws": total(lambda game: game["result"] == "D"),
        "losses": total(lambda game: game["result"] == "L"),
        "scored": total(lambda game: game["goals_for"]),
        "conceded": total(lambda game: game["goals_against"]),
        "difference": total(lambda game: game["goals_for"] - game["goals_against"]),
    }


def build(season: common.Season) -> list[common.Table]:
    rows = []
    for standing in season.table("standings.csv"):
        team_id = str(standing.get("participant_id") or "")
        if not team_id:
            continue
        results = counted_results(season, standing)
        position = common.whole(standing.get("position"))
        row = {
            "group_key": group_key(standing),
            "league_id": str(standing.get("league_id") or ""),
            "stage_id": str(standing.get("stage_id") or ""),
            "group_id": str(standing.get("group_id") or ""),
            "position": common.text(position),
            "qualification": QUALIFICATION.get(position, ""),
            "team_id": team_id,
            "team_name": season.team_name(team_id),
            "short_code": season.short_code(team_id),
            "points": common.text(common.number(standing.get("points"))),
        }
        derived = []
        for column, name in METRICS:
            official = common.number(standing.get(f"details.{column}"))
            # Goal difference can also come from the provider's two goal totals.
            if name == "difference" and official is None:
                scored = common.number(standing.get("details.overall_scored"))
                conceded = common.number(standing.get("details.overall_conceded"))
                if scored is not None and conceded is not None:
                    official = scored - conceded
            value = official if official is not None else results[name]
            if official is None and value is not None:
                derived.append(name)
            row[name] = common.text(value)
        row["derived"] = " ".join(derived)
        rows.append(row)
    rows.sort(key=lambda row: (row["group_key"], common.number(row["position"]) or 1e9, row["team_name"]))
    return [common.Table("standings.csv", rows, COLUMNS)]
