"""Read-only, on-demand adapter for the XI optimizer.

Without a chosen position this answers "what is the best remaining XI" and lists
its members. That view is useful once, and then it stops moving: adding a player
who is already in the optimal XI cannot change the optimal XI, so the list just
shrinks by one each time and never introduces anybody new.

With a position it answers the more useful question instead - "who could fill
this slot, and what would each cost me". Every candidate for that position is
forced into the team in turn and the remaining places re-optimized, so the
ranking is by the strength of the completed XI rather than by the player's own
projection, and ``points_below_optimal_xi`` is the real price of preferring one
over the best available. Only the strongest candidates are evaluated, because a
player projected near zero cannot complete a competitive team and each candidate
costs a solve.
"""
import importlib.util
from collections import Counter
from decimal import InvalidOperation
from pathlib import Path
import sys
from datetime import datetime, timezone
from threading import Lock

SOLVER_LOCK = Lock()
MODULES = None
FIELDS = ["status", "message", "pipeline_run_id", "player_id", "player_name", "team_id",
          "position", "price_million_try", "expected_points", "xi_expected_points",
          "remaining_budget", "risk", "same_club_defensive_pairs",
          "xi_standard_deviation", "completed_xi_expected_points",
          "points_below_optimal_xi", "rating", "so_percent"]
# Each candidate costs one solve per formation, so the tail is cut. Ranking by
# own projection first is only a shortlist: the final order is still decided by
# the completed XI, which can promote a cheaper player over a stronger one.
CANDIDATE_LIMIT = 40


def modules():
    global MODULES
    if MODULES is None:
        root = Path(__file__).resolve().parent
        loaded = []
        for name, filename in [("optimizer", "optimizer.py"), ("xi_optimizer_input", "run.py")]:
            spec = importlib.util.spec_from_file_location(name, root / filename)
            module = importlib.util.module_from_spec(spec)
            sys.modules[name] = module
            spec.loader.exec_module(module)
            loaded.append(module)
        MODULES = loaded
    return MODULES


def recommendations(season, query):
    if not SOLVER_LOCK.acquire(blocking=False):
        return [{"status": "busy", "message": "Optimizer is busy. Try again shortly."}]
    try:
        model, source = modules()
        locked = [value for value in query.get("locked", [""])[0].split(",") if value]
        bench = [value for value in query.get("bench", [""])[0].split(",") if value]
        formation = query.get("formation", [""])[0]
        risk = query.get("risk", ["balanced"])[0] or "balanced"
        position = query.get("position", [""])[0]
        if len(locked) > 11 or len(set(locked)) != len(locked) or any(not p.isdigit() for p in locked):
            raise ValueError("Invalid selected player IDs.")
        if (len(bench) > 4 or len(set(bench)) != len(bench)
                or any(not p.isdigit() for p in bench) or set(bench) & set(locked)):
            raise ValueError("Invalid substitute player IDs.")
        if formation not in model.FORMATIONS:
            raise ValueError("Choose a supported formation.")
        # Only the named presets, never an arbitrary weight from a query string.
        if risk not in model.RISK_PRESETS:
            raise ValueError("Choose a supported risk setting.")
        if position and position not in model.POSITIONS:
            raise ValueError("Choose a supported position.")
        pool, excluded, generation, week = source.load_pool(season, datetime.now(timezone.utc))
        if query.get("generation", [""])[0] != generation:
            raise ValueError("Analysis changed. Click Refresh saved data.")
        missing = set(locked) - {p.id for p in pool}
        if missing:
            names = [r["player_name"] for r in excluded if r["player_id"] in missing]
            raise ValueError("Selected players have no eligible projection: " + ", ".join(names or sorted(missing)))
        bench_cost, reserved_clubs = 0, Counter()
        records = source.read_csv(source.FINAL / "tff_fantasy" / "tff_players.csv", required=True)
        # TFF's own selection rate (SO%), joined by reviewed Sportmonks ID only.
        # It is shown to the reader and never enters the objective.
        ownership = {row["sportmonks_player_id"]: row.get("so_percent", "")
                     for row in records if row.get("match_status") == "matched"}
        if bench:
            # Price and club come from reviewed TFF data, never browser amounts.
            # A substitute need not have an eligible starting-XI projection.
            for pid in bench:
                matches = [row for row in records if row.get("match_status") == "matched"
                           and row.get("sportmonks_player_id") == pid]
                if len(matches) != 1 or not matches[0].get("sportmonks_team_id", "").isdigit():
                    raise ValueError("Substitute has no unique reviewed TFF identity: " + pid)
                row = matches[0]
                bench_cost += source.money(row["price_million_try"])
                reserved_clubs[row["sportmonks_team_id"]] += 1
            if max(reserved_clubs.values()) > 3:
                raise ValueError("Substitutes exceed the three-per-club limit.")
            if bench_cost >= 100_000_000:
                raise ValueError("Substitutes leave no budget for the starting XI.")
            pool = [player for player in pool if player.id not in bench]
        settings = dict(budget=100_000_000 - bench_cost, time_limit=5, formation=formation, risk=risk)
        if bench:
            settings["reserved_clubs"] = reserved_clubs
        result = model.optimize(pool, locked=locked, **settings)
        if result is None:
            raise ValueError("No legal XI fits these selections. Check positions, the ₺100M budget and three-per-club limit.")
        remaining = (100_000_000 - bench_cost - sum(p.price for p in pool if p.id in locked)) / 1_000_000
        message = "Players from the optimal remaining XI"
        candidates = []
        if position:
            shortlist = [p.id for p in sorted(
                (p for p in pool if p.position == position and p.id not in locked),
                key=lambda p: (-p.points, p.id))[:CANDIDATE_LIMIT]]
            candidates = model.recommend(pool, locked=locked, position=position,
                                         candidates=shortlist, **settings)
            message = (f"Best {position} options, ranked by the XI each one completes"
                       if candidates else
                       f"No {position} candidate completes a legal XI with these selections")
        base = {"status": "complete", "message": message,
                "pipeline_run_id": generation, "xi_expected_points": result.points,
                "remaining_budget": remaining, "risk": risk,
                "same_club_defensive_pairs": result.defensive_pairs,
                "xi_standard_deviation": result.standard_deviation}
        if position:
            return [dict(base, player_id=row["player_id"], player_name=row["player_name"],
                         team_id=next(p.team for p in pool if p.id == row["player_id"]),
                         position=row["position"], price_million_try=row["price_million_try"],
                         expected_points=row["expected_points"], rating=row["rating"],
                         completed_xi_expected_points=row["completed_xi_expected_points"],
                         points_below_optimal_xi=row["points_below_optimal_xi"],
                         so_percent=ownership.get(row["player_id"], ""))
                    for row in candidates] or [base]
        return [dict(base, player_id=p.id, player_name=p.name, team_id=p.team, position=p.position,
                     price_million_try=p.price / 1_000_000, expected_points=p.points,
                     rating=p.rating, so_percent=ownership.get(p.id, ""))
                for p in sorted(result.players, key=lambda p: (-p.points, p.id)) if p.id not in locked] or [base]
    except ImportError:
        return [{"status": "unavailable", "message": "Optimizer dependencies missing. Install src/xi_optimizer/requirements.txt in the website server environment."}]
    except (ValueError, OSError, KeyError, RuntimeError, InvalidOperation) as error:
        return [{"status": "unavailable", "message": str(error)}]
    finally:
        SOLVER_LOCK.release()
