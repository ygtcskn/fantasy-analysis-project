"""Fantasy points ledger: one row per player per match, from Sportmonks CSVs.

Everything downstream of this - expected minutes, projections, the optimiser -
predicts fantasy points, and none of it can be fitted or checked without a
historical record of what those points actually were. The TFF export carries a
single season-to-date total per player; this rebuilds the per-match detail from
`player_match_stats.csv` and the rules in `config/tff_scoring_rules.csv`.

The reconstruction is checkable, which is the point. `reconcile` scores the
current season and compares the totals against the game's own `tp` column, so a
rule read wrongly shows up as disagreement rather than as a quietly wrong
projection six steps later.

Two data conventions, both verified against the exports rather than assumed:

  `goals_conceded` is per player, not per team - it counts goals conceded while
  that player was on the pitch. Every one of 605 full-match goalkeepers in
  2025/26 matched the scoreline exactly. A blank means none were conceded, so
  the value is only cross-checked against the scoreline to catch the handful of
  provider gaps where a player finished a match his team lost goals in.

  A second yellow is recorded in `yellowred_cards`, not `redcards`. A player can
  only be dismissed once, so the two are combined rather than added.
"""
from __future__ import annotations

import argparse
import hashlib
import math
import re
import statistics
import sys
import uuid
from collections import defaultdict
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:  # Run as a file, the project root is not on the path.
    sys.path.insert(0, str(ROOT))

from src.shared import (  # noqa: E402
    in_progress, is_played, number, number_or, read_csv, season_folder, utc_now, utc_stamp, write_csv,
)

if __package__:
    from .rules import COMPONENTS, FROM_SPORTMONKS, POSITIONS, RulesError, ScoringRules
else:
    from rules import COMPONENTS, FROM_SPORTMONKS, POSITIONS, RulesError, ScoringRules

INPUT = ROOT / "data" / "final" / "sportmonks"
RULES = ROOT / "config" / "tff_scoring_rules.csv"
TFF_PLAYERS = ROOT / "data" / "final" / "tff_fantasy" / "tff_players.csv"
OUTPUT = ROOT / "data" / "final" / "points"
RUNS = ROOT / "data" / "temp" / "points" / "runs"

LEDGER_COLUMNS = (
    "season", "fixture_id", "kickoff_utc", "round", "player_id", "player_name",
    "team_id", "team_name", "opponent_id", "opponent_name", "venue",
    "fantasy_position", "position_source", "sportmonks_position",
    "started", "minutes_played", "rating", "goals", "assists", "clean_sheet",
    "goals_conceded", "saves", "penalties_saved", "penalties_missed",
    "yellow_cards", "dismissals", "own_goals",
    *(f"points_{name}" for name in COMPONENTS),
    "points_base", "bonus", "points_total",
)
SUMMARY_COLUMNS = (
    "season", "player_id", "player_name", "team_name", "fantasy_position",
    "matches", "starts", "minutes", "points_total", "points_per_match",
    "points_per_90", "best_match", "worst_match", "standard_deviation",
    "matches_over_10", "blanks_under_3",
    *(f"points_{name}" for name in COMPONENTS), "bonus",
)


# Reading, writing, numbers, seasons and timestamps come from src/shared.py. The
# scorer must have a figure for every column, and Sportmonks writes no zeros, so
# a blank counting cell is read as none here: number_or(value), never number_or().

# ------------------------------------------------------------- fantasy positions

def tff_positions(source: Path) -> tuple[dict, list[dict]]:
    """Fantasy position per Sportmonks player id, plus the unmatched pool.

    The game's own classification decides how a player scores, so it wins where
    it exists. It only covers the current player pool, which is why the
    Sportmonks per-match position remains the fallback for earlier seasons.
    """
    rows = read_csv(source, required=True)
    mapped, unmatched = {}, []
    for row in rows:
        position = (row.get("position") or "").strip().upper()
        player_id = str(row.get("sportmonks_player_id") or "").strip()
        if row.get("match_status") == "matched" and player_id.isdigit() and position in POSITIONS:
            if player_id in mapped:
                raise ValueError(f"Duplicate matched Sportmonks player ID: {player_id}")
            mapped[player_id] = position
        else:
            unmatched.append({
                "player_name": row.get("player_name", ""),
                "team_name": row.get("team_name", ""),
                "position": position,
                "price_million_try": row.get("price_million_try", ""),
                "total_points": row.get("tp", ""),
                "match_status": row.get("match_status", ""),
                "reason": "no usable Sportmonks id or fantasy position",
            })
    return mapped, unmatched


# ---------------------------------------------------------------------- ledger

def build_season(season: str, rules: ScoringRules, positions: dict,
                 input_root: Path) -> tuple[list[dict], list[dict]]:
    folder = input_root / season
    stats = read_csv(folder / "player_match_stats.csv")
    if not stats:
        return [], [{"season": season, "issue": "no player_match_stats.csv", "count": 1}]
    fixture_rows = read_csv(folder / "fixtures.csv")
    fixtures = {r["fixture_id"]: r for r in fixture_rows}
    if len(fixtures) != len(fixture_rows) or "" in fixtures:
        raise ValueError(f"{season}: duplicate or blank fixture IDs")
    teams = {r["id"]: r["name"] or r["id"] for r in read_csv(folder / "teams.csv")}

    # Team goals conceded from the scoreline, used only to catch provider gaps.
    goals_for: dict = defaultdict(dict)
    for row in read_csv(folder / "fixture_scores.csv"):
        if row.get("description") == "CURRENT" and row.get("score.goals", "").strip():
            value = float(row["score.goals"])
            if not math.isfinite(value) or value < 0 or not value.is_integer():
                raise ValueError(f"{season}: invalid score for fixture {row['fixture_id']}")
            scores = goals_for[row["fixture_id"]]
            if row["participant_id"] in scores:
                raise ValueError(f"{season}: duplicate CURRENT score for fixture {row['fixture_id']}")
            scores[row["participant_id"]] = int(value)
    team_conceded = {}
    for fixture_id, sides in goals_for.items():
        if len(sides) == 2:
            (left, left_goals), (right, right_goals) = sides.items()
            team_conceded[(fixture_id, left)] = right_goals
            team_conceded[(fixture_id, right)] = left_goals

    issues: dict = defaultdict(int)
    scored: list[dict] = []
    seen = set()
    for row in stats:
        key = (row.get("fixture_id", ""), row.get("player_id", ""))
        if not all(str(value).isdigit() for value in key):
            # Historical exports can include anonymous participant records.
            # Keep them out of the ledger without inventing a player identity.
            missing = ", ".join(name for name, value in zip(("fixture_id", "player_id"), key)
                                if not str(value).isdigit())
            issues[f"excluded row with missing or invalid {missing} (fixture {key[0] or 'unknown'})"] += 1
            continue
        if key in seen:
            raise ValueError(f"{season}: duplicate fixture/player ID {key}")
        seen.add(key)
        fixture = fixtures.get(row["fixture_id"])
        if fixture is None:
            issues["player row with no matching fixture"] += 1
            continue
        if not is_played(fixture) or fixture.get("league_id") != "600":
            issues["excluded unfinished or non-league fixture row"] += 1
            continue
        sportmonks_position = (row.get("position") or "").strip()
        player_id = str(row.get("player_id") or "")
        position = positions.get(player_id)
        source = "tff"
        if position is None:
            position = FROM_SPORTMONKS.get(sportmonks_position)
            source = "sportmonks"
        if position is None:
            issues["player row with no usable position"] += 1
            continue

        team_id = row["team_id"]
        home, away = fixture.get("home_team_id", ""), fixture.get("away_team_id", "")
        if not home or not away or team_id not in {home, away}:
            raise ValueError(f"{season}: player {player_id} team does not match fixture {row['fixture_id']}")
        opponent = away if team_id == home else home
        minutes = number_or(row.get("minutes_played"))
        conceded = number_or(row.get("goals_conceded"))
        if not row.get("goals_conceded") and minutes >= 90 and number_or(row.get("started")) == 1:
            # Blank normally means none conceded while on the pitch. Where the
            # final score can only replace that value for a full-match starter.
            # Substituted players may have left before the goal was conceded.
            from_score = team_conceded.get((row["fixture_id"], team_id))
            if from_score:
                conceded = float(from_score)
                issues["blank goals_conceded corrected from the scoreline"] += 1
        # A player is dismissed at most once; a second yellow lands in its own
        # column and must not be counted twice.
        dismissals = 1 if (number_or(row.get("redcards")) or number_or(row.get("yellowred_cards"))) else 0

        parts = rules.score(
            position=position, minutes=minutes,
            goals=number_or(row.get("goals")), assists=number_or(row.get("assists")),
            conceded=conceded, saves=number_or(row.get("saves")),
            penalties_saved=number_or(row.get("penalties_saved")),
            penalties_missed=number_or(row.get("penalties_misses")),
            yellow_cards=number_or(row.get("yellowcards")),
            dismissals=dismissals, own_goals=number_or(row.get("own_goals")))
        if not parts["played"]:
            continue
        scored.append({
            "season": season, "fixture_id": row["fixture_id"],
            "kickoff_utc": fixture.get("kickoff", ""),
            "round": (fixture.get("round.name") or "").strip(),
            "player_id": player_id, "player_name": row.get("name", ""),
            "team_id": team_id, "team_name": teams.get(team_id, team_id),
            "opponent_id": opponent, "opponent_name": teams.get(opponent, opponent),
            "venue": "home" if team_id == home else "away",
            "fantasy_position": position, "position_source": source,
            "sportmonks_position": sportmonks_position,
            "started": int(number_or(row.get("started"))), "minutes_played": minutes,
            # Provider match rating. Carried for context only: it scores no
            # points and takes no part in any total on this row.
            "rating": number_or(row.get("rating")) or "",
            "goals": int(number_or(row.get("goals"))), "assists": int(number_or(row.get("assists"))),
            "clean_sheet": int(parts["clean_sheet"] != 0),
            "goals_conceded": int(conceded), "saves": int(number_or(row.get("saves"))),
            "penalties_saved": int(number_or(row.get("penalties_saved"))),
            "penalties_missed": int(number_or(row.get("penalties_misses"))),
            "yellow_cards": int(number_or(row.get("yellowcards"))),
            "dismissals": dismissals, "own_goals": int(number_or(row.get("own_goals"))),
            **{f"points_{name}": parts[name] for name in COMPONENTS},
            "points_base": parts["points_base"],
        })

    by_fixture: dict = defaultdict(dict)
    for index, row in enumerate(scored):
        by_fixture[row["fixture_id"]][index] = row["points_base"]
    for entries in by_fixture.values():
        for index, award in rules.award_bonus(entries).items():
            scored[index]["bonus"] = award
    for row in scored:
        row.setdefault("bonus", 0)
        row["points_total"] = row["points_base"] + row["bonus"]

    return scored, [{"season": season, "issue": issue, "count": count}
                    for issue, count in sorted(issues.items())]


def summarise(ledger: list[dict]) -> list[dict]:
    grouped: dict = defaultdict(list)
    for row in ledger:
        grouped[(row["season"], row["player_id"])].append(row)
    summary = []
    for (season, player_id), rows in grouped.items():
        totals = [r["points_total"] for r in rows]
        minutes = sum(r["minutes_played"] for r in rows)
        last = max(rows, key=lambda r: r["kickoff_utc"])
        summary.append({
            "season": season, "player_id": player_id,
            "player_name": last["player_name"], "team_name": last["team_name"],
            "fantasy_position": last["fantasy_position"],
            "matches": len(rows), "starts": sum(r["started"] for r in rows),
            "minutes": minutes, "points_total": sum(totals),
            "points_per_match": sum(totals) / len(rows),
            "points_per_90": sum(totals) / minutes * 90 if minutes else 0.0,
            "best_match": max(totals), "worst_match": min(totals),
            "standard_deviation": statistics.pstdev(totals) if len(totals) > 1 else 0.0,
            "matches_over_10": sum(1 for value in totals if value >= 10),
            "blanks_under_3": sum(1 for value in totals if value < 3),
            "bonus": sum(r["bonus"] for r in rows),
            **{f"points_{name}": sum(r[f"points_{name}"] for r in rows)
               for name in COMPONENTS},
        })
    summary.sort(key=lambda row: (row["season"], -row["points_total"]))
    return summary


def components_report(ledger: list[dict]) -> list[dict]:
    """Where the points in this scoring system actually come from."""
    rows = []
    groups = [("all", None)] + [(position, position) for position in POSITIONS]
    for label, position in groups:
        selected = [r for r in ledger if position is None or r["fantasy_position"] == position]
        if not selected:
            continue
        total = sum(r["points_total"] for r in selected)
        entry = {"scope": label, "player_matches": len(selected), "points_total": total}
        for name in (*COMPONENTS, "bonus"):
            key = f"points_{name}" if name != "bonus" else "bonus"
            value = sum(r[key] for r in selected)
            entry[f"{name}_points"] = value
            entry[f"{name}_share"] = value / total if total else 0.0
        entry["points_per_player_match"] = total / len(selected)
        rows.append(entry)
    return rows


def unfinished_clubs(season: str, input_root: Path = INPUT) -> set[str]:
    """Clubs with a saved fixture that had not finished when the data was captured.

    Their players are missing that match from the ledger while the fantasy
    export already counts it, so they cannot be compared fairly.
    """
    path = input_root / season / "fixtures.csv"
    clubs: set[str] = set()
    for row in read_csv(path):
        if row.get("league_id") != "600":
            continue
        if in_progress(row):
            clubs.update({row.get("home_team_id", ""), row.get("away_team_id", "")})
    return {club for club in clubs if club}


def reconcile(ledger: list[dict], season: str, source: Path,
              before: str = "", *, input_root: Path = INPUT) -> list[dict]:
    """Season totals against the game's own `tp`, for matched players.

    ``before`` excludes fixtures from the comparison that kicked off on or
    after that date. The fantasy export is a snapshot: any matchweek that
    finished after it was taken is in the ledger and not in ``tp``, and
    without the cut those players read as scoring errors.

    The reverse gap matters just as much and is easier to miss. When a fixture
    was still being played as the provider data was captured, its players are
    short a match in the ledger while the fantasy export already counts it.
    Those players are marked ``club_fixture_unfinished`` so a stale download
    cannot be mistaken for a scoring mistake - the difference between the two
    groups is the difference between "rebuild after downloading" and "the rules
    are wrong".
    """
    players = [row for row in read_csv(source, required=True)
               if row.get("match_status") == "matched" and row.get("sportmonks_player_id")]
    unfinished = unfinished_clubs(season, input_root)
    totals: dict = defaultdict(float)
    minutes: dict = defaultdict(float)
    for row in ledger:
        if row["season"] != season:
            continue
        if before and row["kickoff_utc"][:len(before)] >= before:
            continue
        totals[row["player_id"]] += row["points_total"]
        minutes[row["player_id"]] += row["minutes_played"]
    rows = []
    for player in players:
        official = number(player.get("tp"))
        if official is None:
            continue
        key = str(player["sportmonks_player_id"])
        computed = totals.get(key, 0.0)
        official_minutes = number(player.get("od"))
        computed_minutes = minutes.get(key, 0.0)
        rows.append({
            "player_name": player["player_name"], "team_name": player["team_name"],
            "position": player["position"], "player_id": key,
            "official_points": official, "computed_points": computed,
            "difference": computed - official,
            "official_minutes": official_minutes,
            "computed_minutes": computed_minutes,
            "minutes_difference": computed_minutes - official_minutes if official_minutes is not None else None,
            "snapshot_file": player.get("snapshot_file", ""),
            "club_fixture_unfinished": str(player.get("sportmonks_team_id", "")) in unfinished,
            "comparison_status": "explicit_fixture_cutoff" if before else "provisional_snapshot_alignment",
        })
    rows.sort(key=lambda row: -abs(row["difference"]))
    return rows


# ------------------------------------------------------------------------ main

def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--seasons", nargs="+",
                        help="Season folders, e.g. 2025/2026. Defaults to all available.")
    parser.add_argument("--input-root", type=Path, default=INPUT)
    parser.add_argument("--rules", type=Path, default=RULES)
    parser.add_argument("--tff-players", type=Path, default=TFF_PLAYERS,
                        help="Reviewed TFF player CSV.")
    parser.add_argument("--tff-season", help="Season to which current TFF positions apply; defaults to newest built.")
    parser.add_argument("--output-root", type=Path, default=OUTPUT)
    parser.add_argument("--runs-root", type=Path, default=RUNS)
    parser.add_argument("--reconcile-season",
                        help="Season to check against the fantasy export. "
                             "Defaults to the newest season built.")
    parser.add_argument("--reconcile-before",
                        help="Exclude fixtures kicking off on or after this date "
                             "(YYYY-MM-DD) from the reconciliation, so a matchweek "
                             "played after the fantasy snapshot was taken does not "
                             "read as a scoring error.")
    args = parser.parse_args(argv)

    try:
        rules = ScoringRules.load(args.rules)
    except (OSError, RulesError) as exc:
        print(f"Cannot read scoring rules: {exc}", file=sys.stderr)
        return 2
    print(f"Rules from {args.rules.name}: {rules.minutes_threshold}-minute threshold, "
          f"goals {rules.goal}, clean sheet {rules.clean_sheet['DEF']}/"
          f"{rules.clean_sheet['OS']}, bonus {rules.bonus}")
    if rules.unconfirmed:
        print(f"  unconfirmed rules: {', '.join(rules.unconfirmed)}")

    seasons = (sorted({season_folder(name) for name in args.seasons}) if args.seasons
               else sorted(p.name for p in args.input_root.iterdir()
                           if p.is_dir() and re.fullmatch(r"\d{4}-\d{4}", p.name)))
    if not seasons:
        raise ValueError("No downloaded seasons found")
    tff_season = season_folder(args.tff_season) if args.tff_season else seasons[-1]
    source = args.tff_players
    positions, unmatched = tff_positions(source)
    if args.reconcile_before:
        datetime.strptime(args.reconcile_before, "%Y-%m-%d")
    print(f"{len(positions)} players carry a fantasy position; {len(unmatched)} unmatched")

    ledger: list[dict] = []
    issues: list[dict] = []
    input_paths = [source, args.rules]
    for season in seasons:
        folder = args.input_root / season
        statuses = read_csv(folder / "download_status.csv")
        if len(statuses) != 1 or statuses[0].get("status") != "complete":
            raise ValueError(f"{season}: finish the Sportmonks download before building points")
        paths = [folder / name for name in ("download_status.csv", "fixtures.csv", "player_match_stats.csv", "teams.csv", "fixture_scores.csv")]
        if any(not path.is_file() for path in paths):
            raise ValueError(f"{season}: required input CSV is missing")
        input_paths.extend(paths)
        rows, season_issues = build_season(season, rules, positions if season == tff_season else {}, args.input_root)
        ledger.extend(rows)
        issues.extend(season_issues)
        points = sum(r["points_total"] for r in rows)
        print(f"  {season}: {len(rows):5d} player-matches, {points:6.0f} points"
              + (f"  [{len(season_issues)} issue types]" if season_issues else ""))
    if not ledger:
        print("No player-match rows were scored.", file=sys.stderr)
        return 1

    summary = summarise(ledger)
    components = components_report(ledger)
    target = season_folder(args.reconcile_season) if args.reconcile_season else tff_season
    if target != tff_season:
        raise ValueError("Reconciliation season must match the current TFF snapshot season")
    checks = reconcile(ledger, target, source, args.reconcile_before or "", input_root=args.input_root)

    run = args.runs_root / (utc_now().strftime("%Y%m%dT%H%M%SZ")
                            + "_ledger_" + uuid.uuid4().hex[:8])
    write_csv(run / "player_match_points.csv", ledger, LEDGER_COLUMNS)
    write_csv(run / "player_season_summary.csv", summary, SUMMARY_COLUMNS)
    write_csv(run / "component_summary.csv", components)
    write_csv(run / "reconciliation.csv", checks)
    write_csv(run / "unmatched_players.csv", unmatched)
    write_csv(run / "data_issues.csv", issues)
    write_csv(run / "run_settings.csv", [
        {"setting": "generated_at_utc", "value": utc_stamp(utc_now())},
        {"setting": "seasons", "value": " ".join(seasons)},
        {"setting": "rules_file", "value": str(args.rules)},
        {"setting": "rules_source", "value": rules.source},
        {"setting": "unconfirmed_rules", "value": " ".join(rules.unconfirmed)},
        {"setting": "reconcile_season", "value": target},
        {"setting": "reconcile_before", "value": args.reconcile_before or ""},
        {"setting": "tff_source", "value": str(source)},
        {"setting": "tff_season", "value": tff_season},
        {"setting": "points_kind", "value": "reconstructed; bonus allocation remains approximate"},
        {"setting": "python", "value": sys.version.split()[0]},
    ], ["setting", "value"])
    write_csv(run / "input_manifest.csv", [
        {"path": str(path.resolve()), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        for path in input_paths
    ])
    write_csv(args.output_root / "player_match_points.csv", ledger, LEDGER_COLUMNS)
    write_csv(args.output_root / "player_season_summary.csv", summary, SUMMARY_COLUMNS)

    overall = next((row for row in components if row["scope"] == "all"), None)
    if overall:
        ordered = sorted(((name, overall[f"{name}_share"]) for name in (*COMPONENTS, "bonus")),
                         key=lambda pair: -pair[1])[:5]
        print("\nWhere the points come from: "
              + ", ".join(f"{name} {share * 100:.0f}%" for name, share in ordered))
    if checks:
        window = f" before {args.reconcile_before}" if args.reconcile_before else ""
        comparable = [row for row in checks if not row["club_fixture_unfinished"]]
        stale = [row for row in checks if row["club_fixture_unfinished"]]

        def accuracy(rows):
            exact = sum(1 for row in rows if abs(row["difference"]) < 0.5)
            close = sum(1 for row in rows if abs(row["difference"]) <= 2)
            error = sum(abs(row["difference"]) for row in rows) / len(rows)
            bias = sum(row["difference"] for row in rows) / len(rows)
            return (f"{exact}/{len(rows)} exact, {close}/{len(rows)} within 2, "
                    f"mean absolute error {error:.2f}, bias {bias:+.2f}")

        print(f"Reconciliation on {target}{window}: {accuracy(checks)}")
        if stale:
            print(f"  of which {len(stale)} play for a club whose fixture had not finished "
                  f"when this data was captured, so they are short a match:")
            if comparable:
                print(f"    comparable players: {accuracy(comparable)}")
            print(f"    stale-fixture players: {accuracy(stale)}")
            print("  Re-download the season and rebuild before reading the stale group "
                  "as a scoring error.")
    print(f"\nLedger: {args.output_root / 'player_match_points.csv'}")
    print(f"Run record: {run}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
