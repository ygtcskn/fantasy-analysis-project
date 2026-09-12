"""team_season.csv - one row per team: standings totals, clean sheets, match statistics.

What the Takım İstatistikleri list, its leader cards and the profile's season
facts read.

Two different sources meet here and are kept apart on purpose. Goals, points
and position come from the standings the way the league table reads them.
Clean sheets come only from saved CURRENT scores, so a match whose score is
missing is not counted as one - ``unknown_results`` says how many those are.
The match statistics (xG, possession, shots) come from team_metrics.csv and are
published only when every counted match supplies them, because a total over
some of the matches reads as a season total and is not one.
"""
from __future__ import annotations

from . import common, standings

# Published name to the team_metrics.csv statistic, and whether it is averaged
# over matches rather than summed. Possession is already a share of a match.
METRICS = [("xg", "expected_goals", False), ("xg_against", "expected_goals_against", False),
           ("possession_average", "ball_possession", True), ("shots", "shots_total", False),
           ("corners", "corners", False), ("tackles", "tackles", False)]

COLUMNS = ["team_id", "team_name", "short_code", "position", "points", "played", "wins", "draws",
           "losses", "scored", "conceded", "difference", "clean_sheets", "unknown_results",
           "matches_with_statistics"] + [name for name, _, _ in METRICS]


def metric_rows(season: common.Season) -> dict[str, list[dict]]:
    """team_metrics.csv reshaped to one wide row per team and fixture, by team."""
    def build():
        wide: dict[tuple[str, str], dict] = {}
        for record in season.table("team_metrics.csv"):
            fixture_id = str(record.get("fixture_id") or "")
            team_id = str(record.get("team_id") or "")
            name = str(record.get("name") or "").lower()
            if not fixture_id or not team_id or not name:
                continue
            wide.setdefault((fixture_id, team_id), {"fixture_id": fixture_id, "team_id": team_id})
            wide[(fixture_id, team_id)][name] = record.get("value")
        # The opponent's row supplies what a team conceded in that fixture.
        by_fixture: dict[str, list[dict]] = {}
        for row in wide.values():
            by_fixture.setdefault(row["fixture_id"], []).append(row)
        for pair in by_fixture.values():
            if len(pair) != 2:
                continue
            for own, other in ((pair[0], pair[1]), (pair[1], pair[0])):
                if common.blank(own.get("expected_goals_against")) and not common.blank(other.get("expected_goals")):
                    own["expected_goals_against"] = other.get("expected_goals")
        by_team: dict[str, list[dict]] = {}
        for row in wide.values():
            by_team.setdefault(row["team_id"], []).append(row)
        return by_team
    return season.derive("team_metric_rows", build)


def rows(season: common.Season) -> list[dict]:
    """The table itself, cached so the leader card module shares this work."""
    return season.derive("team_season", lambda: _rows(season))


def _rows(season: common.Season) -> list[dict]:
    metrics = metric_rows(season)
    finished = {str(fixture.get("fixture_id") or "") for fixture in season.finished}
    rows = []
    for standing in season.table("standings.csv"):
        team_id = str(standing.get("participant_id") or "")
        if not team_id:
            continue
        games, unscored = standings.scoped_results(season, standing)
        totals = standings.counted_results(season, standing)
        row = {
            "team_id": team_id,
            "team_name": season.team_name(team_id),
            "short_code": season.short_code(team_id),
            "position": common.text(common.whole(standing.get("position"))),
            "points": common.text(common.number(standing.get("points"))),
            "clean_sheets": common.text(len([game for game in games if game["goals_against"] == 0])
                                        if games else None),
            "unknown_results": common.text(unscored),
        }
        for column, name in standings.METRICS:
            official = common.number(standing.get(f"details.{column}"))
            if name == "difference" and official is None:
                scored = common.number(standing.get("details.overall_scored"))
                conceded = common.number(standing.get("details.overall_conceded"))
                official = None if scored is None or conceded is None else scored - conceded
            row[name] = common.text(official if official is not None else totals[name])
        # Only matches the provider has finished: one caught in play would
        # otherwise contribute half a match of statistics to a season total.
        own = [entry for entry in metrics.get(team_id, []) if entry["fixture_id"] in finished]
        row["matches_with_statistics"] = common.text(len(own))
        for name, column, averaged in METRICS:
            values = [common.number(entry.get(column)) for entry in own]
            complete = bool(values) and all(value is not None for value in values)
            total = sum(values) if complete else None
            row[name] = common.text(None if total is None else total / len(values) if averaged else total)
        rows.append(row)
    rows.sort(key=lambda row: (common.number(row["position"]) or 1e9, row["team_name"]))
    return rows


def build(season: common.Season) -> list[common.Table]:
    return [common.Table("team_season.csv", rows(season), COLUMNS)]
