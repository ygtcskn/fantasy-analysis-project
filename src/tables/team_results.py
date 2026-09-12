"""team_results.csv - one row per team and finished match, both sides.

The unit the other team tables are built from, and what the form guide, the
team page and the match-by-match charts read. Results are stored as W, D and L
rather than G, B and M: the table says what happened, the page says it in
Turkish.
"""
from __future__ import annotations

from . import common

COLUMNS = ["fixture_id", "kickoff", "round", "team_id", "team_name", "opponent_id",
           "opponent_name", "venue", "goals_for", "goals_against", "result"]


def build(season: common.Season) -> list[common.Table]:
    rows = []
    for match in season.played:
        rows.append({
            "fixture_id": match["fixture_id"],
            "kickoff": match["kickoff"],
            "round": common.text(match["round"]),
            "team_id": match["team_id"],
            "team_name": season.team_name(match["team_id"]),
            "opponent_id": match["opponent_id"],
            "opponent_name": season.team_name(match["opponent_id"]),
            "venue": "H" if match["home"] else "A",
            "goals_for": match["goals_for"],
            "goals_against": match["goals_against"],
            "result": match["result"],
        })
    return [common.Table("team_results.csv", rows, COLUMNS)]
