"""Read published CSVs and write an isolated fantasy-XI experiment. No downloads."""
import argparse
import csv
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
import math
from pathlib import Path
import uuid

from optimizer import FORMATIONS, POSITIONS, Player, optimize, recommend, resolve_risk

ROOT = Path(__file__).resolve().parents[2]
FINAL = ROOT / "data" / "final"


def read(path):
    with path.open(encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


def write(path, rows, fields):
    with path.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader(); writer.writerows(rows)


def time(value):
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)


def money(value):
    amount = Decimal(value) * 1_000_000
    if not amount.is_finite() or amount <= 0 or amount != amount.to_integral_value():
        raise ValueError("Price/budget must be positive and precise to whole TL.")
    return int(amount)


def load_pool(season, now):
    manifest = read(FINAL / "fantasy_pipeline" / season / "pipeline_status.csv")
    if len(manifest) != 1 or manifest[0]["status"] != "complete" or manifest[0]["season"] != season:
        raise ValueError("A completed fantasy pipeline for this season is required.")
    run_id = manifest[0]["pipeline_run_id"]
    rows = read(FINAL / "player_projections" / season / "player_projections.csv")
    if not rows or any(r["pipeline_run_id"] != run_id or r["season"] != season for r in rows):
        raise ValueError("Missing projections or mixed pipeline generations/seasons.")
    rounds = {r["matchweek"] for r in rows}
    if len(rounds) != 1:
        raise ValueError("This experiment requires exactly one projected matchweek.")
    week = next(iter(rounds))
    fixture_rows = read(FINAL / "sportmonks" / season / "fixtures.csv")
    fixtures = {r["fixture_id"]: r for r in fixture_rows}
    if len(fixtures) != len(fixture_rows):
        raise ValueError("Duplicate fixture IDs.")
    round_games = [r for r in fixture_rows if r.get("round.name") == week]
    if not round_games:
        raise ValueError("Projected round absent from saved fixtures.")
    deadline = min(time(r["kickoff"]) for r in round_games) - timedelta(hours=1)
    if now >= deadline:
        raise ValueError("The projected round's selection deadline has passed. Rebuild projections.")
    tff_rows = read(FINAL / "tff_fantasy" / "tff_players.csv")
    download = read(FINAL / "sportmonks" / season / "download_status.csv")
    if len(download) != 1 or download[0].get("finished_at_utc") != manifest[0].get("sportmonks_finished_at_utc"):
        raise ValueError("Saved Sportmonks download changed; rebuild the fantasy pipeline.")
    if any(time(r["updated_at_utc"]) > time(manifest[0]["tff_updated_at_utc"]) for r in tff_rows):
        raise ValueError("TFF data is newer than projections; rebuild the fantasy pipeline.")
    tff = {}
    for row in tff_rows:
        if row.get("match_status") != "matched":
            continue
        pid = row["sportmonks_player_id"]
        if pid in tff:
            raise ValueError("Duplicate matched TFF player ID.")
        tff[pid] = row
    pool, exclusions, seen = [], [], set()
    for row in rows:
        pid = row["player_id"]
        if pid in seen:
            raise ValueError("Duplicate projected player; double gameweeks are not supported yet.")
        seen.add(pid)
        reason = ""
        game, reference = fixtures.get(row["fixture_id"]), tff.get(pid)
        if not game or game["state"].upper() not in {"NS", "TBA"}:
            reason = "fixture_not_upcoming"
        elif (time(game["kickoff"]) != time(row["kickoff_utc"])
              or game.get("round.name") != week
              or (row["team_id"], row["opponent_id"]) not in
              {(game["home_team_id"], game["away_team_id"]), (game["away_team_id"], game["home_team_id"])}):
            reason = "fixture_changed"
        elif time(row["generated_at_utc"]) > now or time(row["generated_at_utc"]) >= deadline:
            reason = "invalid_prediction_timestamp"
        elif not reference or (reference["sportmonks_team_id"], reference["position"]) != (row["team_id"], row["position"]):
            reason = "tff_identity_team_or_position_changed"
        elif row["availability_status"] != "no_reported_absence" or row["eligible_for_selection"].lower() != "true":
            reason = "unavailable_or_ineligible"
        try:
            price, points = money(row["price_million_try"]), float(row["expected_points"])
            if not math.isfinite(points) or row["position"] not in POSITIONS:
                reason = reason or "invalid_points_or_position"
            if reference and money(reference["price_million_try"]) != price:
                reason = reason or "tff_price_changed"
        except (ValueError, InvalidOperation):
            reason = reason or "missing_or_invalid_price_or_points"
        if reason:
            exclusions.append({"player_id": pid, "player_name": row["player_name"], "reason": reason})
        else:
            pool.append(Player(pid, row["player_name"], row["team_id"], row["team_name"],
                               row["position"], price, points,
                               float(row.get("recent_rating") or 0.0)))
    # Detect a pipeline publication that changed during the read.
    if read(FINAL / "fantasy_pipeline" / season / "pipeline_status.csv") != manifest:
        raise ValueError("Pipeline changed during loading. Retry after it finishes.")
    return pool, exclusions, run_id, week


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--season", default="2026/2027")
    parser.add_argument("--budget", default="100", help="Budget in million TL (default 100).")
    parser.add_argument("--formation", choices=["auto", *FORMATIONS], default="auto")
    parser.add_argument("--risk", default="balanced",
                        help="balanced (pure expected points), low (spread the defence), "
                             "high (stack it), or a number: expected points charged per "
                             "same-club goalkeeper/defender pair. Negative rewards stacking.")
    parser.add_argument("--lock", nargs="*", default=[], help="Sportmonks player IDs already selected.")
    parser.add_argument("--exclude", nargs="*", default=[])
    parser.add_argument("--recommend", action="store_true", help="Solve forced-candidate completions (can be slow).")
    parser.add_argument("--position", choices=POSITIONS, help="Filter recommendations by TFF position.")
    parser.add_argument("--time-limit", type=float, default=30, help="Seconds per formation solve.")
    args = parser.parse_args()
    season = args.season.replace("/", "-")
    parts = season.split("-")
    if len(parts) != 2 or not all(len(p) == 4 and p.isdigit() for p in parts) or int(parts[1]) != int(parts[0]) + 1:
        parser.error("Use a season such as 2026/2027.")
    now = datetime.now(timezone.utc)
    folder = ROOT / "data" / "temp" / "xi_optimizer" / f"{now:%Y%m%dT%H%M%SZ}_{uuid.uuid4().hex[:8]}"
    folder.mkdir(parents=True)
    status = "failed"
    message = ""
    try:
        budget = money(args.budget)
        pool, excluded, run_id, week = load_pool(season, now)
        write(folder / "excluded_players.csv", excluded, ["player_id", "player_name", "reason"])
        settings = dict(budget=budget, formation=args.formation,
                        time_limit=args.time_limit, risk=args.risk)
        solution = optimize(pool, locked=args.lock, excluded=args.exclude, **settings)
        if solution is None:
            status, message = "infeasible", "No legal XI satisfies these selections, formation and budget."
        else:
            records = [{"player_id": p.id, "player_name": p.name, "team_id": p.team,
                        "team_name": p.team_name, "position": p.position, "price_million_try": p.price / 1_000_000,
                        "expected_points": p.points, "locked": p.id in args.lock} for p in solution.players]
            write(folder / "selected_xi.csv", records, list(records[0]))
            summary = {"season": season, "matchweek": week, "pipeline_run_id": run_id,
                       "formation": solution.formation, "players": 11, "club_limit": 3,
                       "budget_million_try": budget / 1_000_000, "cost_million_try": solution.cost / 1_000_000,
                       "remaining_million_try": (budget - solution.cost) / 1_000_000,
                       "expected_points": solution.points, "injuries_ignored": False,
                       "risk_setting": args.risk,
                       "risk_weight_per_defensive_pair": resolve_risk(args.risk),
                       "same_club_defensive_pairs": solution.defensive_pairs,
                       "expected_points_standard_deviation": solution.standard_deviation}
            write(folder / "summary.csv", [summary], list(summary))
            if args.recommend:
                recommendations = recommend(pool, locked=args.lock, excluded=args.exclude, position=args.position, **settings)
                fields = ["player_id", "player_name", "team_name", "position", "expected_points", "price_million_try",
                          "completed_xi_expected_points", "points_below_optimal_xi", "completed_xi_cost_million_try", "formation"]
                write(folder / "recommendations.csv", recommendations, fields)
            status, message = "complete", "Optimal XI saved. Experimental expected points, not guaranteed returns."
    except (ValueError, KeyError, OSError, RuntimeError, InvalidOperation) as error:
        message = str(error)
    write(folder / "run_status.csv", [{"status": status, "message": message, "generated_at_utc": now.isoformat()}],
          ["status", "message", "generated_at_utc"])
    print(f"{status}: {message}\nReports: {folder}")
    return 0 if status == "complete" else 1


if __name__ == "__main__":
    raise SystemExit(main())
