"""Optional user-run structural checks of CSV files; no API requests."""
import argparse
from pathlib import Path
if __package__:
    from .csv_store import read_table, write_table
    from .sportmonks import DATA
else:
    from csv_store import read_table, write_table
    from sportmonks import DATA


def validate_csv(folder):
    fixtures=read_table(folder/"fixtures.csv")
    players=read_table(folder/"player_match_stats.csv")
    ids=[f["fixture_id"] for f in fixtures]
    pairs=[(p["fixture_id"],p["player_id"]) for p in players]
    results=[
        {"check":"duplicate_fixture_ids","count":len(ids)-len(set(ids))},
        {"check":"duplicate_player_match_rows","count":len(pairs)-len(set(pairs))},
        {"check":"player_rows_without_fixture","count":sum(p["fixture_id"] not in set(ids) for p in players)},
    ]
    write_table(folder/"validation.csv",results,["check","count"])
    return results


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--folder", type=Path, default=DATA / '2026-2027')
    args=parser.parse_args()
    for row in validate_csv(args.folder): print(f"{row['check']}: {row['count']}")


if __name__=='__main__': main()
