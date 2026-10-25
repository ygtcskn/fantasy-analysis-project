"""Opportunity cost for every eligible player, precomputed once per round.

The builder can only afford to rank a shortlist while you wait. This answers the
same question for the whole pool: force each player into the team, re-optimize
the other ten, and record how strong the resulting XI is. A player's
``points_below_optimal_xi`` is then the real price of insisting on him - not the
gap between his projection and someone else's, but the gap between the best team
containing him and the best team available at all.

That is a different ranking from projected points, and the difference is the
point. A slightly weaker player who leaves the budget intact can complete a
better eleven than a stronger one who does not.

Cost, measured on a 334-player pool: about 2.5 seconds for one formation and 18
seconds across all seven, at roughly 7 milliseconds per solve. That is far too
slow to run while somebody waits and completely irrelevant once a week, which is
why this is a separate command rather than part of the builder. It is sequential
on purpose: the solves are independent and would parallelise, but process
plumbing is not worth adding to a job that runs once per matchweek.

Two things worth knowing before trusting the output. The ranking is computed
with nothing locked, so it answers "if I built the optimal team around this
player", not "given the ten I have already picked". On the current pool those
agree almost exactly - locking three players left the top fifteen defenders in
the same order - but they agree because the budget is not binding, and that will
stop being true if prices tighten. And it inherits every limitation of the
projections it reads: this measures the model's opinion, not what will happen.
"""
from __future__ import annotations

import argparse
import sys
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:  # Run as a file, the project root is not on the path.
    sys.path.insert(0, str(ROOT))
from src.shared import season_folder, utc_now, utc_stamp, write_csv  # noqa: E402

if __package__:
    from .optimizer import FORMATIONS, POSITIONS, RISK_PRESETS, optimize, recommend, resolve_risk
    from .run import load_pool
else:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from optimizer import FORMATIONS, POSITIONS, RISK_PRESETS, optimize, recommend, resolve_risk
    from run import load_pool

PUBLISHED = ROOT / "data" / "final" / "xi_optimizer"
RUNS = ROOT / "data" / "temp" / "xi_optimizer" / "sweeps"

COLUMNS = [
    "season", "matchweek", "pipeline_run_id", "rank", "player_id", "player_name",
    "team_id", "team_name", "position", "price_million_try", "expected_points",
    "completed_xi_expected_points", "points_below_optimal_xi",
    "completed_xi_cost_million_try", "completed_xi_formation", "in_optimal_xi",
    "optimal_xi_expected_points", "risk", "formation_setting", "generated_at_utc",
]


def sweep(pool, *, formation, risk, budget, time_limit, progress=print):
    """Every player's completed-XI value, computed one position at a time.

    Splitting by position is exactly equivalent to one call over the whole pool,
    because each candidate's completion is solved independently and the baseline
    does not depend on which candidate is being scored. It buys progress
    reporting on a job long enough to look hung.
    """
    baseline = optimize(pool, budget=budget, formation=formation,
                        time_limit=time_limit, risk=risk)
    if baseline is None:
        raise ValueError("No legal XI exists for this pool, budget and formation.")
    selected = {player.id for player in baseline.players}
    rows = []
    for position in POSITIONS:
        candidates = [player for player in pool if player.position == position]
        if not candidates:
            continue
        started = time.perf_counter()
        ranked = recommend(pool, position=position, budget=budget, formation=formation,
                           time_limit=time_limit, risk=risk)
        for row in ranked:
            rows.append({**row, "in_optimal_xi": row["player_id"] in selected})
        progress(f"  {position}: {len(ranked):3d} players in {time.perf_counter() - started:5.1f}s")
    rows.sort(key=lambda row: (-row["completed_xi_expected_points"],
                               -row["expected_points"], row["player_id"]))
    return baseline, rows


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--season", default="2026/2027")
    parser.add_argument("--budget", type=float, default=100.0,
                        help="Budget in million TL (default 100).")
    parser.add_argument("--formation", choices=["auto", *FORMATIONS], default="auto",
                        help="auto compares all seven and takes about 18 seconds; "
                             "a single formation takes about 2.5.")
    parser.add_argument("--risk", default="balanced",
                        help=f"{', '.join(RISK_PRESETS)}, or a number: expected points "
                             "charged per same-club goalkeeper/defender pair.")
    parser.add_argument("--time-limit", type=float, default=30,
                        help="Seconds per formation solve, not for the whole sweep.")
    parser.add_argument("--published-root", type=Path, default=PUBLISHED)
    parser.add_argument("--runs-root", type=Path, default=RUNS)
    parser.add_argument("--no-publish", action="store_true",
                        help="Write only the run record, leaving data/final untouched.")
    args = parser.parse_args(argv)

    try:
        season = season_folder(args.season)
    except ValueError as error:
        parser.error(str(error))
    try:
        resolve_risk(args.risk)
    except ValueError as error:
        parser.error(str(error))
    if args.budget <= 0:
        parser.error("Budget must be positive.")

    now = utc_now()
    folder = args.runs_root / f"{now:%Y%m%dT%H%M%SZ}_sweep_{uuid.uuid4().hex[:8]}"
    status, message, rows = "failed", "", []
    try:
        pool, excluded, run_id, week = load_pool(season, now)
        print(f"Matchweek {week}, generation {run_id}: {len(pool)} eligible players, "
              f"{len(excluded)} excluded.")
        print(f"Sweeping {args.formation} formation(s) at risk={args.risk}; "
              f"every player is forced in and the other ten re-optimized.")
        started = time.perf_counter()
        baseline, ranked = sweep(pool, formation=args.formation, risk=args.risk,
                                 budget=int(round(args.budget * 1_000_000)),
                                 time_limit=args.time_limit)
        elapsed = time.perf_counter() - started
        stamp = utc_stamp(now)
        rows = [{
            "season": season, "matchweek": week, "pipeline_run_id": run_id,
            "rank": index, "player_id": row["player_id"], "player_name": row["player_name"],
            "team_id": next(p.team for p in pool if p.id == row["player_id"]),
            "team_name": row["team_name"], "position": row["position"],
            "price_million_try": row["price_million_try"],
            "expected_points": row["expected_points"],
            "completed_xi_expected_points": row["completed_xi_expected_points"],
            "points_below_optimal_xi": row["points_below_optimal_xi"],
            "completed_xi_cost_million_try": row["completed_xi_cost_million_try"],
            "completed_xi_formation": row["formation"],
            "in_optimal_xi": row["in_optimal_xi"],
            "optimal_xi_expected_points": baseline.points,
            "risk": args.risk, "formation_setting": args.formation,
            "generated_at_utc": stamp,
        } for index, row in enumerate(ranked, 1)]
        write_csv(folder / "player_opportunity_cost.csv", rows, COLUMNS)
        write_csv(folder / "excluded_players.csv", excluded,
                  ["player_id", "player_name", "reason"])
        if not args.no_publish:
            write_csv(args.published_root / season / "player_opportunity_cost.csv", rows, COLUMNS)
        status = "complete"
        message = (f"Scored {len(rows)} players in {elapsed:.1f}s. Optimal XI "
                   f"{baseline.points:.2f} points, {baseline.formation}, "
                   f"{baseline.cost / 1_000_000:.1f}M.")
    except (ValueError, KeyError, OSError, RuntimeError) as error:
        message = str(error)

    write_csv(folder / "run_status.csv", [{
        "status": status, "message": message, "players": len(rows),
        "season": season, "risk": args.risk, "formation_setting": args.formation,
        "published": status == "complete" and not args.no_publish,
        "generated_at_utc": utc_stamp(now),
    }], ["status", "message", "players", "season", "risk", "formation_setting",
         "published", "generated_at_utc"])
    print(f"{status}: {message}")
    if rows:
        print("\nCheapest players to build around:")
        for row in rows[:5]:
            print(f"  {row['player_name'][:24]:<25}{row['position']:<4}"
                  f"{row['expected_points']:5.2f} own  XI {row['completed_xi_expected_points']:6.2f}"
                  f"  costs {row['points_below_optimal_xi']:.2f}")
    print(f"Reports: {folder}")
    return 0 if status == "complete" else 1


if __name__ == "__main__":
    raise SystemExit(main())
