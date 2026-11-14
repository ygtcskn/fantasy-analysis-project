"""Export the Detailed Metrics spider plot for one Süper Lig player as SVG."""

import argparse
import json
from pathlib import Path
import subprocess

from src.shared import read_csv, season_folder, season_label


ROOT = Path(__file__).resolve().parents[2]
LEAGUE_ID = "600"
MATCH_FIELDS = ("fixture_id", "position", "started", "minutes_played", "rating")
FIXTURE_FIELDS = ("fixture_id", "season_id", "league_id", "state", "state.developer_name")


def season_inputs(data_root: Path, season: str) -> tuple[list[dict], list[dict]]:
    """Load the scoped fixtures and group the prepared player rows by provider ID."""
    fixtures = [
        {key: row[key] for key in FIXTURE_FIELDS if key in row}
        for row in read_csv(data_root / "sportmonks" / season / "fixtures.csv", required=True)
        if row.get("league_id") == LEAGUE_ID
    ]
    fixture_ids = {row["fixture_id"] for row in fixtures}
    players = {}
    for row in read_csv(data_root / "spider" / season / "spider_stats.csv", required=True):
        player_id = row.get("player_id")
        if row.get("entity_type") != "player" or not player_id or row.get("fixture_id") not in fixture_ids:
            continue
        player = players.setdefault(player_id, {"id": player_id, "name": player_id, "matches": []})
        if row.get("name"):
            player["name"] = row["name"]
        player["matches"].append({
            **{key: row[key] for key in MATCH_FIELDS if key in row},
            **{key[2:]: value for key, value in row.items() if key.startswith("p_")},
        })
    return list(players.values()), fixtures


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--season", required=True, type=season_folder)
    parser.add_argument("--player-id", required=True, help="Sportmonks player ID")
    parser.add_argument("--data-root", type=Path, default=ROOT / "data" / "final",
                        help="Directory containing the sportmonks and spider CSVs")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    try:
        players, fixtures = season_inputs(args.data_root, args.season)
        payload = {"players": players, "fixtures": fixtures,
                   "playerId": args.player_id, "season": season_label(args.season)}
        result = subprocess.run(
            ["node", str(Path(__file__).with_name("player_radar.cjs"))],
            input=json.dumps(payload, ensure_ascii=False), encoding="utf-8",
            capture_output=True, check=True,
        )
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(result.stdout, encoding="utf-8", newline="\n")
    except subprocess.CalledProcessError as error:
        parser.exit(1, f"Could not score the radar: {error.stderr.strip()}\n")
    except (OSError, ValueError) as error:
        parser.exit(1, f"Could not export the radar: {error}\n")


if __name__ == "__main__":
    main()
