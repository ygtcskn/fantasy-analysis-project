"""player_leaders.csv - the İstatistikler leader cards, already ranked.

Long format: one row per card and place, so a new card is a new ``category``
rather than a new file and a new column layout.

Equal values share a rank - two players on nine goals both read 1 - and a tie
is broken by minutes played and then by name in Turkish order, which is how the
cards were ordered when the page ranked them itself. Only a value above zero
can lead a card: a player with no goals is not the tenth-best scorer.
"""
from __future__ import annotations

from . import common, player_season

# Card id to the player_season.csv column it ranks. Fantasy points earn a card
# because they are the currency this project is built around and appear nowhere
# else on the page.
CATEGORIES = [("goals", "goals"), ("assists", "assists"), ("fantasy", "fantasy_points")]
LIMIT = 10

COLUMNS = ["category", "rank", "player_id", "player_name", "team_id", "team_name", "value"]


def rank_rows(rows: list[dict], column: str, limit: int = LIMIT) -> list[dict]:
    entries = []
    for row in rows:
        value = common.number(row.get(column))
        if value is None or value <= 0:
            continue
        minutes = common.number(row.get("minutes_played")) or 0
        entries.append((value, minutes, row))
    entries.sort(key=lambda entry: (-entry[0], -entry[1], common.turkish_key(entry[2].get("player_name"))))
    leaders, rank = [], 0
    for index, (value, _, row) in enumerate(entries[:limit]):
        if index == 0 or value != entries[index - 1][0]:
            rank = index + 1
        leaders.append({"rank": rank, "value": value, "row": row})
    return leaders


def build(season: common.Season) -> list[common.Table]:
    # The same aggregation the player table publishes, so a card can never
    # disagree with the list below it.
    players = player_season.rows(season)
    rows = []
    for category, column in CATEGORIES:
        for leader in rank_rows(players, column):
            row = leader["row"]
            rows.append({
                "category": category,
                "rank": common.text(leader["rank"]),
                "player_id": row["player_id"],
                "player_name": row["player_name"],
                "team_id": row["team_id"],
                "team_name": season.team_name(row["team_id"]),
                "value": common.text(leader["value"]),
            })
    return [common.Table("player_leaders.csv", rows, COLUMNS)]
