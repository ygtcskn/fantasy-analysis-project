"""player_season.csv - one row per player: identity, season totals, rating, tier.

The single aggregation behind the İstatistikler list, the leader cards, the
player profile facts and the tier list, so those four can never disagree with
each other.

Every total carries how many of the player's match records supplied it. A
missing value is never read as a zero: a striker with goals on four of five
recorded matches has a four-match total, and the ``*_supplied`` column is what
the site marks with an asterisk.

Fantasy points are joined from the published ledger (``src/points``), not
recomputed here.
"""
from __future__ import annotations

import re

from . import common

# Totals the site shows. "xg" prefers the dedicated feed and falls back to the
# other one per match; the two are never summed together.
METRICS = ["minutes_played", "goals", "assists", "xg", "shots_total", "key_passes", "saves"]

# Display bands for the tier list. A rating below the minimum rated matches is
# provisional (P); no valid rating at all is unrated (U).
TIER_BANDS = [("S", 8.0), ("A", 7.5), ("B", 7.0), ("C", 6.5), ("D", 1.0)]
MINIMUM_RATED_MATCHES = 3

# Broad roles, in the order a position is tested against them. Long names match
# anywhere in the position text; the short codes must stand as whole words, so
# "cb" does not claim "cbm" and "for" does not claim "forvet" twice.
ROLE_WORDS = [
    ("goalkeeper", ("goalkeeper", "keeper", "kaleci"), ("gk", "kl")),
    ("defender", ("defender", "defence", "defense", "defans", "centre back", "center back",
                  "full back", "left back", "right back", "wing back"), ("cb", "lb", "rb", "def")),
    ("midfielder", ("midfielder", "midfield", "orta saha"), ("dm", "cm", "am", "lm", "rm", "os")),
    ("attacker", ("attacker", "forward", "striker", "forvet", "centre forward", "center forward",
                  "winger"), ("st", "cf", "lw", "rw", "for")),
]

COLUMNS = (["player_id", "player_name", "team_id", "team_ids", "team_names", "position",
            "positions", "role", "roles", "jersey", "matches", "rated_matches", "rating_average", "tier",
            "fantasy_points", "fantasy_points_per_match", "fantasy_best_match"]
           + [name for metric in METRICS for name in (metric, f"{metric}_supplied")])


def role_for(position) -> str:
    """The broad role a position name belongs to, or "" when it is not one of them."""
    value = re.sub(r"[^a-z0-9]+", " ", str(position or "").lower()).strip()
    if not value:
        return ""
    words = value.split(" ")
    for role, names, codes in ROLE_WORDS:
        if any(name in value for name in names) or any(code in words for code in codes):
            return role
    return ""


def match_rating(row: dict):
    """A usable Sportmonks match rating: 1-10, and not an explicit zero-minute record."""
    value = common.number(row.get("rating"))
    if value is None or not 1 <= value <= 10:
        return None
    return None if common.number(row.get("minutes_played")) == 0 else value


def metric_value(row: dict, metric: str):
    if metric == "xg":
        supplied = common.number(row.get("xg_expected_goals"))
        return supplied if supplied is not None else common.number(row.get("expected_goals"))
    return common.number(row.get(metric))


def tier_for(average, rated: int) -> str:
    if average is None:
        return "U"
    if rated < MINIMUM_RATED_MATCHES:
        return "P"
    for tier, minimum in TIER_BANDS:
        if average >= minimum:
            return tier
    return "D"


def collect(season: common.Season) -> dict[str, dict]:
    """Every player the season knows about, with their match rows attached."""
    players: dict[str, dict] = {}

    def ensure(player_id, name=None) -> dict | None:
        key = str(player_id or "")
        if not key:
            return None
        if key not in players:
            players[key] = {"id": key, "name": "", "teams": [], "positions": [],
                            "squad_team": "", "jersey": "", "matches": []}
        entry = players[key]
        if name and not entry["name"]:
            entry["name"] = str(name)
        return entry

    for profile in season.table("players.csv"):
        entry = ensure(profile.get("id"), profile.get("display_name") or profile.get("name"))
        if entry and not entry["name"]:
            entry["name"] = str(profile.get("name") or "")
    for row in season.table("squads.csv"):
        entry = ensure(row.get("player_id"))
        if not entry:
            continue
        team = str(row.get("team_id") or "")
        if team:
            entry["squad_team"] = team
            if team not in entry["teams"]:
                entry["teams"].append(team)
        if row.get("jersey_number"):
            entry["jersey"] = str(row.get("jersey_number"))
        position = str(row.get("position.name") or "")
        if position and position not in entry["positions"]:
            entry["positions"].append(position)
    for row in season.table("player_match_stats.csv"):
        entry = ensure(row.get("player_id"), row.get("name"))
        if not entry:
            continue
        team = str(row.get("team_id") or "")
        if team and team not in entry["teams"]:
            entry["teams"].append(team)
        position = str(row.get("position") or "")
        if position and position not in entry["positions"]:
            entry["positions"].append(position)
        entry["matches"].append(row)
    for entry in players.values():
        if not entry["name"]:
            entry["name"] = f"Oyuncu {entry['id']}"
    return players


def rows(season: common.Season) -> list[dict]:
    """The table itself, cached so the leader card module shares this work."""
    return season.derive("player_season", lambda: _rows(season))


def _rows(season: common.Season) -> list[dict]:
    players = collect(season)
    summaries = {str(row.get("player_id") or ""): row
                 for row in season.published("points/player_season_summary.csv")}
    best: dict[str, float] = {}
    for row in season.published("points/player_match_points.csv"):
        points = common.number(row.get("points_total"))
        key = str(row.get("player_id") or "")
        if key and points is not None:
            best[key] = max(best.get(key, points), points)

    rows = []
    for entry in sorted(players.values(), key=lambda item: item["name"].casefold()):
        ratings = [value for value in (match_rating(row) for row in entry["matches"]) if value is not None]
        average = sum(ratings) / len(ratings) if ratings else None
        summary = summaries.get(entry["id"], {})
        # The first position the player is recorded in is the primary one, but
        # the tier list filters on every role his recorded positions resolve to.
        roles = []
        for position in entry["positions"]:
            found = role_for(position)
            if found and found not in roles:
                roles.append(found)
        row = {
            "player_id": entry["id"],
            "player_name": entry["name"],
            "team_id": entry["squad_team"] or (entry["teams"][0] if entry["teams"] else ""),
            "team_ids": " ".join(entry["teams"]),
            "team_names": " · ".join(season.team_name(team) for team in entry["teams"]),
            "position": entry["positions"][0] if entry["positions"] else "",
            "positions": " · ".join(entry["positions"]),
            "role": roles[0] if roles else "",
            "roles": " ".join(roles),
            "jersey": entry["jersey"],
            "matches": common.text(len(entry["matches"])),
            "rated_matches": common.text(len(ratings)),
            "rating_average": "" if average is None else f"{average:.4f}",
            "tier": tier_for(average, len(ratings)),
            "fantasy_points": common.text(common.number(summary.get("points_total"))),
            "fantasy_points_per_match": common.text(common.number(summary.get("points_per_match"))),
            "fantasy_best_match": common.text(best.get(entry["id"])),
        }
        for metric in METRICS:
            values = [value for value in (metric_value(match, metric) for match in entry["matches"])
                      if value is not None]
            row[metric] = common.text(sum(values)) if values else ""
            row[f"{metric}_supplied"] = common.text(len(values))
        rows.append(row)
    return rows


def build(season: common.Season) -> list[common.Table]:
    return [common.Table("player_season.csv", rows(season), COLUMNS)]
