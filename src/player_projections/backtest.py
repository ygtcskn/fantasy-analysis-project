"""Score the projection model against what actually happened.

The projections were built without any measurement of whether they beat a naive
rule. This replays each completed matchweek at its own deadline, projects every
player from data available only before it, and compares the forecast with the
points they went on to score.

Two questions, and they are not the same one:

  Accuracy. Mean absolute error and rank correlation against the actual points.
  Useful, but a model can win on error by predicting the average for everybody.

  Selection. Feed each method's numbers to the same optimizer, take the eleven
  it picks, and add up what those eleven really scored. This is the question the
  project exists to answer, and a model that improves error while picking worse
  teams has not helped.

Both are measured against baselines a person could apply without any model:
season points per match so far, the last three matches, the position average and
the price the game itself charges. Beating none of them means the model is
decoration.

Three limitations, none of them fixable here. Availability is a snapshot of
today's injuries, so the replay uses the pre-availability ``baseline_*``
forecast rather than retroactively ruling players out for injuries they had not
yet suffered. The player pool and prices come from the current fantasy export,
so a replay of an earlier season would assign transferred players to the wrong
club - which is why the default is the current season only. And the sample is
however many rounds have been played: early in a season that is few, and a
result from three rounds is an indication, not a finding.
"""
from __future__ import annotations

import argparse
import csv
import io
import math
import statistics
import sys
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from src.player_projections import run as projections

UTC = timezone.utc
SPORTMONKS = ROOT / "data" / "final" / "sportmonks"
POINTS = ROOT / "data" / "final" / "points" / "player_match_points.csv"
OUTPUT = ROOT / "data" / "temp" / "player_projections" / "backtests"
# The forecast is what the model claimed before availability was applied. Today's
# injury feed cannot be replayed backwards without inventing history.
FORECAST = "baseline_expected_points"
METHODS = ("model", "season_points_per_match", "last_three_matches", "position_average", "price")
FINISHED = {"FT", "AET", "FT_PEN"}


def read_csv(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return list(csv.DictReader(io.StringIO(path.read_text(encoding="utf-8-sig"))))


def number(value, default=0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if math.isfinite(result) else default


def spearman(pairs) -> float:
    """Rank correlation. Ties share the average rank, as usual."""
    if len(pairs) < 3:
        return float("nan")

    def ranks(values):
        order = sorted(range(len(values)), key=lambda i: values[i])
        result = [0.0] * len(values)
        index = 0
        while index < len(order):
            stop = index
            while stop + 1 < len(order) and values[order[stop + 1]] == values[order[index]]:
                stop += 1
            shared = (index + stop) / 2 + 1
            for position in range(index, stop + 1):
                result[order[position]] = shared
            index = stop + 1
        return result

    left, right = ranks([p[0] for p in pairs]), ranks([p[1] for p in pairs])
    mean_left, mean_right = statistics.fmean(left), statistics.fmean(right)
    covariance = sum((a - mean_left) * (b - mean_right) for a, b in zip(left, right))
    spread = (math.sqrt(sum((a - mean_left) ** 2 for a in left))
              * math.sqrt(sum((b - mean_right) ** 2 for b in right)))
    return covariance / spread if spread else float("nan")


# --------------------------------------------------------------------- rounds

def completed_rounds(season: str, input_root: Path) -> list[dict]:
    """Fully finished league rounds, oldest first, with their fantasy deadline."""
    grouped = defaultdict(list)
    for row in read_csv(input_root / season / "fixtures.csv"):
        if row.get("league_id") != "600":
            continue
        number_text = (row.get("round.name") or "").strip()
        if number_text.isdigit():
            grouped[int(number_text)].append(row)
    rounds = []
    for matchweek, fixtures in sorted(grouped.items()):
        if not all(row.get("state") in FINISHED for row in fixtures):
            continue
        try:
            kickoffs = [projections.utc(row["kickoff"]) for row in fixtures]
        except (KeyError, ValueError):
            continue
        rounds.append({
            "matchweek": matchweek,
            "fixture_ids": {row["fixture_id"] for row in fixtures},
            # A whole second before the deadline, so the round's own first
            # fixture still counts as unstarted when the replay selects it.
            "as_of": min(kickoffs) - timedelta(hours=1, seconds=1),
        })
    return rounds


def replay(season: str, matchweek: int, as_of: datetime, folder: Path, args) -> list[dict]:
    destination = folder / f"mw{matchweek:02d}"
    code = projections.main([
        "--season", season, "--matchweek", str(matchweek),
        "--as-of", as_of.isoformat().replace("+00:00", "Z"), "--historical",
        "--input-root", str(args.input_root), "--points-path", str(args.points_path),
        "--output-root", str(destination / "output"), "--runs-root", str(destination / "runs"),
    ])
    if code != 0:
        raise RuntimeError(f"Matchweek {matchweek}: projection replay failed")
    return read_csv(destination / "output" / season / "player_projections.csv")


# -------------------------------------------------------------------- scoring

def actual_points(ledger: list[dict], season: str) -> tuple[dict, dict]:
    """Points per (fixture, player), and each player's chronological history."""
    scored, history = {}, defaultdict(list)
    for row in ledger:
        if row.get("season") != season:
            continue
        try:
            kickoff = projections.utc(row["kickoff_utc"])
        except (KeyError, ValueError):
            continue
        points = number(row.get("points_total"))
        scored[(row["fixture_id"], row["player_id"])] = points
        history[row["player_id"]].append((kickoff, points))
    for entries in history.values():
        entries.sort()
    return scored, history


def baselines(projected: list[dict], history: dict, as_of: datetime) -> dict:
    """Naive per-player forecasts a person could produce without a model."""
    prior = {pid: [points for kickoff, points in entries if kickoff < as_of]
             for pid, entries in history.items()}
    position_totals = defaultdict(list)
    for row in projected:
        position_totals[row["position"]].extend(prior.get(row["player_id"], []))
    position_mean = {position: statistics.fmean(values) if values else 0.0
                     for position, values in position_totals.items()}
    values = {}
    for row in projected:
        played = prior.get(row["player_id"], [])
        values[row["player_id"]] = {
            "season_points_per_match": statistics.fmean(played) if played else 0.0,
            "last_three_matches": statistics.fmean(played[-3:]) if played else 0.0,
            "position_average": position_mean.get(row["position"], 0.0),
            "price": number(row.get("price_million_try")),
        }
    return values


def selection(rows, method, optimizer):
    """Best legal XI under this method's numbers, scored on what really happened."""
    pool = []
    for row in rows:
        if row["price"] <= 0 or not row["player_id"].isdigit() or not row["team_id"].isdigit():
            continue
        pool.append(optimizer.Player(row["player_id"], row["player_name"], row["team_id"],
                                     row["team_name"], row["position"],
                                     int(round(row["price"] * 1_000_000)), row[method]))
    if len(pool) < 11:
        return None
    chosen = optimizer.optimize(pool, formation="auto", time_limit=30)
    if chosen is None:
        return None
    actual = {row["player_id"]: row["actual"] for row in rows}
    return {"formation": chosen.formation, "cost_million_try": chosen.cost / 1_000_000,
            "forecast_points": chosen.points,
            "actual_points": sum(actual.get(p.id, 0.0) for p in chosen.players),
            "player_ids": " ".join(p.id for p in chosen.players)}


# ------------------------------------------------------------------------ main

def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--season", default="2026/2027")
    parser.add_argument("--from-round", type=int, default=1,
                        help="First matchweek to score. Round 1 has no current-season "
                             "history and tests the priors alone.")
    parser.add_argument("--input-root", type=Path, default=SPORTMONKS)
    parser.add_argument("--points-path", type=Path, default=POINTS)
    parser.add_argument("--output-root", type=Path, default=OUTPUT)
    parser.add_argument("--no-selection", action="store_true",
                        help="Skip the optimizer comparison and report accuracy only.")
    args = parser.parse_args(argv)
    season = projections.season_folder(args.season)

    optimizer = None
    if not args.no_selection:
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "xi_optimizer_model", ROOT / "src" / "xi_optimizer" / "optimizer.py")
        optimizer = importlib.util.module_from_spec(spec)
        sys.modules["xi_optimizer_model"] = optimizer
        spec.loader.exec_module(optimizer)

    ledger = read_csv(args.points_path)
    if not ledger:
        print("Points ledger is empty; build it before backtesting.", file=sys.stderr)
        return 1
    scored, history = actual_points(ledger, season)
    rounds = [item for item in completed_rounds(season, args.input_root)
              if item["matchweek"] >= args.from_round]
    if not rounds:
        print(f"No completed matchweeks in {season} at or after round {args.from_round}.",
              file=sys.stderr)
        return 1
    folder = args.output_root / (datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
                                 + "_backtest_" + uuid.uuid4().hex[:8])
    print(f"Backtesting {len(rounds)} completed matchweeks of {season}: "
          f"{', '.join(str(item['matchweek']) for item in rounds)}")

    player_rows, round_rows, team_rows = [], [], []
    for item in rounds:
        matchweek, as_of = item["matchweek"], item["as_of"]
        projected = replay(season, matchweek, as_of, folder, args)
        naive = baselines(projected, history, as_of)
        rows = []
        for row in projected:
            pid = row["player_id"]
            played = [fid for fid in item["fixture_ids"] if (fid, pid) in scored]
            # A player who did not appear scored nothing; that is a real result,
            # not a missing observation, so it stays in the comparison.
            actual = scored[(played[0], pid)] if played else 0.0
            entry = {"season": season, "matchweek": matchweek, "player_id": pid,
                     "player_name": row["player_name"], "team_id": row["team_id"],
                     "team_name": row["team_name"], "position": row["position"],
                     "price": number(row.get("price_million_try")),
                     "appeared": bool(played), "actual": actual,
                     "model": number(row.get(FORECAST)), **naive[pid]}
            rows.append(entry)
            player_rows.append(entry)
        summary = {"season": season, "matchweek": matchweek, "players": len(rows),
                   "appeared": sum(1 for row in rows if row["appeared"]),
                   "information_cutoff_utc": as_of.isoformat(),
                   "actual_points_mean": statistics.fmean(row["actual"] for row in rows)}
        for method in METHODS:
            pairs = [(row[method], row["actual"]) for row in rows]
            summary[f"{method}_mae"] = statistics.fmean(abs(a - b) for a, b in pairs)
            summary[f"{method}_rmse"] = math.sqrt(statistics.fmean((a - b) ** 2 for a, b in pairs))
            summary[f"{method}_spearman"] = spearman(pairs)
            if optimizer:
                picked = selection(rows, method, optimizer)
                summary[f"{method}_xi_actual_points"] = picked["actual_points"] if picked else ""
                if picked:
                    team_rows.append({"season": season, "matchweek": matchweek,
                                      "method": method, **picked})
        if optimizer:
            # The ceiling: the best legal XI once the results are known. Nobody
            # can reach it in advance; it says how much of the gap is headroom.
            for row in rows:
                row["hindsight"] = row["actual"]
            perfect = selection(rows, "hindsight", optimizer)
            summary["hindsight_xi_actual_points"] = perfect["actual_points"] if perfect else ""
            if perfect:
                team_rows.append({"season": season, "matchweek": matchweek,
                                  "method": "hindsight", **perfect})
        round_rows.append(summary)
        best = min(METHODS, key=lambda name: summary[f"{name}_mae"])
        print(f"  matchweek {matchweek}: {len(rows)} players, model MAE "
              f"{summary['model_mae']:.3f} (best {best}), model rho "
              f"{summary['model_spearman']:.3f}"
              + (f", model XI scored {summary['model_xi_actual_points']:.0f}" if optimizer else ""))

    overall = []
    for method in METHODS:
        pairs = [(row[method], row["actual"]) for row in player_rows]
        entry = {"method": method, "player_rounds": len(pairs),
                 "mae": statistics.fmean(abs(a - b) for a, b in pairs),
                 "rmse": math.sqrt(statistics.fmean((a - b) ** 2 for a, b in pairs)),
                 "spearman": spearman(pairs)}
        picks = [row[f"{method}_xi_actual_points"] for row in round_rows
                 if row.get(f"{method}_xi_actual_points") != ""]
        entry["xi_rounds"] = len(picks)
        entry["xi_actual_points_mean"] = statistics.fmean(picks) if picks else ""
        entry["xi_actual_points_total"] = sum(picks) if picks else ""
        overall.append(entry)
    if optimizer:
        picks = [row["hindsight_xi_actual_points"] for row in round_rows
                 if row.get("hindsight_xi_actual_points") != ""]
        overall.append({"method": "hindsight", "player_rounds": len(player_rows), "mae": 0.0,
                        "rmse": 0.0, "spearman": 1.0, "xi_rounds": len(picks),
                        "xi_actual_points_mean": statistics.fmean(picks) if picks else "",
                        "xi_actual_points_total": sum(picks) if picks else ""})
    overall.sort(key=lambda row: row["mae"])

    projections.write_csv(folder / "player_rounds.csv", player_rows)
    projections.write_csv(folder / "round_scores.csv", round_rows)
    projections.write_csv(folder / "method_summary.csv", overall)
    if team_rows:
        projections.write_csv(folder / "selected_teams.csv", team_rows)
    projections.write_csv(folder / "run_settings.csv", [
        {"setting": "season", "value": season},
        {"setting": "matchweeks", "value": " ".join(str(item["matchweek"]) for item in rounds)},
        {"setting": "forecast_field", "value": FORECAST},
        {"setting": "selection_compared", "value": bool(optimizer)},
        {"setting": "generated_at_utc", "value": datetime.now(UTC).isoformat()},
        {"setting": "limitation", "value": "Current fantasy pool, prices and positions are "
                                           "applied to every replayed round."},
    ], ["setting", "value"])

    print("\nmethod                    MAE    RMSE  Spearman   XI actual/round")
    for row in overall:
        mean = row["xi_actual_points_mean"]
        print(f"  {row['method']:<22}{row['mae']:6.3f}{row['rmse']:8.3f}"
              f"{row['spearman']:10.3f}   {mean:.1f}" if mean != ""
              else f"  {row['method']:<22}{row['mae']:6.3f}{row['rmse']:8.3f}"
                   f"{row['spearman']:10.3f}        -")
    print("\n  Price is a selection baseline, not a points forecast: its error columns "
          "are\n  in millions of lira and are not comparable with the others. Only its "
          "rank\n  correlation and selected-XI column mean anything.")
    print(f"\nReports: {folder}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
