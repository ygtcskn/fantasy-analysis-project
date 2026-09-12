"""team_leaders.csv - the Takım İstatistikleri leader cards, already ranked.

Long format, the same shape as player_leaders.csv: one row per card and place.

Clean sheets earn a card of their own because they carry fantasy points for
goalkeepers and defenders. Fewest goals conceded is ranked upward; a card whose
value can be legitimately zero still lists a team on zero, unlike the player
cards, where nobody leads the scoring chart on no goals.
"""
from __future__ import annotations

from . import common, team_season

# Card id, the team_season.csv column it ranks, and whether a smaller value leads.
CATEGORIES = [("scored", "scored", False), ("conceded", "conceded", True),
              ("clean_sheets", "clean_sheets", False)]
LIMIT = 10

COLUMNS = ["category", "rank", "team_id", "team_name", "value"]


def rank_rows(rows: list[dict], column: str, ascending: bool, limit: int = LIMIT) -> list[dict]:
    entries = [(value, row) for row in rows
               if (value := common.number(row.get(column))) is not None]
    entries.sort(key=lambda entry: (entry[0] if ascending else -entry[0],
                                    common.turkish_key(entry[1].get("team_name"))))
    leaders, rank = [], 0
    for index, (value, row) in enumerate(entries[:limit]):
        if index == 0 or value != entries[index - 1][0]:
            rank = index + 1
        leaders.append({"rank": rank, "value": value, "row": row})
    return leaders


def build(season: common.Season) -> list[common.Table]:
    teams = team_season.rows(season)
    rows = []
    for category, column, ascending in CATEGORIES:
        for leader in rank_rows(teams, column, ascending):
            rows.append({
                "category": category,
                "rank": common.text(leader["rank"]),
                "team_id": leader["row"]["team_id"],
                "team_name": leader["row"]["team_name"],
                "value": common.text(leader["value"]),
            })
    return [common.Table("team_leaders.csv", rows, COLUMNS)]
