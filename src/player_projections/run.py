"""Experimental next-matchweek player projections from saved CSV data only."""
from __future__ import annotations

import argparse
import csv
from collections import defaultdict
from datetime import datetime, timedelta
import hashlib
import math
from pathlib import Path
import re
import sys
import uuid


ROOT = Path(__file__).resolve().parents[2]
SPORTMONKS = ROOT / "data" / "final" / "sportmonks"
TFF_PLAYERS = ROOT / "data" / "final" / "tff_fantasy" / "tff_players.csv"
POINTS = ROOT / "data" / "final" / "points" / "player_match_points.csv"
ODDS = ROOT / "data" / "final" / "odds" / "predictions.csv"
RUNS = ROOT / "data" / "temp" / "player_projections" / "runs"
OUTPUT = ROOT / "data" / "final" / "player_projections"
RULES = ROOT / "config" / "tff_scoring_rules.csv"
sys.path.insert(0, str(ROOT))
from src.points.rules import ScoringRules
from src.player_projections.fixture_context import CONTEXT_COLUMNS, fixture_context
from src.player_projections.availability import (
    AVAILABILITY_COLUMNS, apply_availability, resolve_availability,
)
from src.player_projections.team_goals import SOURCE_INTERNAL, SOURCE_ODDS, load_odds_goals
from src.shared import (
    CALLED_OFF_STATES, UTC, fixture_state, integer_or, is_finished, is_played, is_scheduled,
    number_or, parse_utc, read_csv, season_folder, utc_now, utc_stamp, write_csv,
)
POSITIONS = ("KL", "DEF", "OS", "FOR")
OUTPUT_COLUMNS = [
    "season", "player_id", "player_name", "team_id", "team_name", "position",
    "price_million_try", "fixture_id", "matchweek", "kickoff_utc",
    "opponent_id", "opponent_name", "opponent_short_code", "venue",
    "opponent_display", "expected_points", "chance_starting",
    "chance_starting_percent", "chance_playing", "chance_playing_percent",
    "chance_60_minutes", "chance_60_minutes_percent", "chance_scoring",
    "chance_scoring_percent", "expected_minutes", "team_expected_goals",
    "opponent_expected_goals", "team_goals_source", "team_clean_sheet_probability",
    "expected_player_goals", "expected_player_assists", "expected_yellow_cards",
    "expected_red_cards", "points_appearance",
    "points_goals", "points_assists", "points_clean_sheet", "points_saves",
    "points_penalty_saved", "points_penalty_missed", "points_goals_conceded",
    "points_cards", "points_own_goal", "points_bonus", "current_starts",
    "current_appearances", "current_team_matches", "history_matches",
    "history_minutes", "effective_history_minutes", "recent_rating", "rating_appearances", "confidence",
    "projection_status", "generated_at_utc", "information_cutoff_utc", "availability_updated_at_utc",
]
OUTPUT_COLUMNS += CONTEXT_COLUMNS
FORECAST_FIELDS = [name for name in OUTPUT_COLUMNS
                   if name.startswith("chance_") or name.startswith("points_")
                   or name in {"expected_points", "expected_minutes", "expected_player_goals",
                               "expected_player_assists", "expected_yellow_cards",
                               "expected_red_cards"}]
OUTPUT_COLUMNS += AVAILABILITY_COLUMNS + [f"baseline_{name}" for name in FORECAST_FIELDS]
TEAM_COLUMNS = ["season", "fixture_id", "matchweek", "kickoff_utc", "home_team_id",
                "home_team_name", "away_team_id", "away_team_name", "home_expected_goals",
                "away_expected_goals", "team_goals_source", "generated_at_utc",
                "information_cutoff_utc", "projection_status"]


# Reading, writing, numbers, seasons and timestamps come from src/shared.py.
# Every input here is required: a missing file must stop the run rather than
# project an empty pool, so reads pass required=True.


def weighted_rate(rows: list[dict], field: str, forecast: datetime,
                  prior_rate: float, prior_minutes: float,
                  half_life_days: float = 240.0) -> tuple[float, float]:
    events = minutes = 0.0
    for row in rows:
        age = max(0.0, (forecast - row["kickoff"]).total_seconds() / 86400.0)
        weight = 2 ** (-age / half_life_days)
        events += weight * row[field]
        minutes += weight * row["minutes"]
    rate = (events + prior_rate * prior_minutes / 90.0) / (minutes + prior_minutes) * 90.0
    return rate, minutes


def weighted_per_appearance(rows: list[dict], field: str, forecast: datetime,
                            prior_rate: float, prior_appearances: float,
                            half_life_days: float = 240.0) -> float:
    value = appearances = 0.0
    for row in rows:
        age = max(0.0, (forecast - row["kickoff"]).total_seconds() / 86400.0)
        weight = 2 ** (-age / half_life_days)
        value += weight * row[field]
        appearances += weight
    return (value + prior_rate * prior_appearances) / (appearances + prior_appearances)


def expected_floor_poisson(rate: float, divisor: int) -> float:
    if rate <= 0:
        return 0.0
    probability = math.exp(-rate)
    total = probability * 0
    cumulative = probability
    goal = 0
    while goal < max(40, int(rate + 12 * math.sqrt(rate + 1))):
        goal += 1
        probability *= rate / goal
        cumulative += probability
        total += (goal // divisor) * probability
        if 1 - cumulative < 1e-12 and goal > rate:
            break
    return total


def published_generation(path) -> str:
    """The pipeline generation stamped on a file this run is about to replace.

    ``run_pipeline.py`` tags every published file with one ``pipeline_run_id``,
    and the website refuses to display a set whose stamps disagree. A standalone
    rebuild writes the same path without that column, which silently invalidates
    the whole published set: the browser reports that the analysis is being
    updated and every projection vanishes, with nothing pointing at the cause.
    Reading the stamp before overwriting it turns that into one line of output.
    """
    path = Path(path)
    if not path.is_file():
        return ""
    try:
        with path.open(encoding="utf-8-sig", newline="") as stream:
            reader = csv.DictReader(stream)
            if "pipeline_run_id" not in (reader.fieldnames or []):
                return ""
            for row in reader:
                return row.get("pipeline_run_id", "") or ""
    except (OSError, UnicodeError, csv.Error):
        return ""
    return ""


def warn_if_unpublishing(generations, season: str = "<season>") -> None:
    live = sorted({value for value in generations if value})
    if not live:
        return
    print(f"\nWARNING: this replaced published files carrying pipeline generation "
          f"{', '.join(live)} with untagged output.")
    print("         The website will now reject the whole fantasy dataset and show "
          "'Fantasy analysis is being updated'.")
    print(f"         Run: python src/run_pipeline.py --season {season}")
    print("         to republish points, projections and the marker together.")


def load_fixture_results(seasons: list[str], forecast: datetime, input_root: Path = SPORTMONKS):
    results = []
    input_paths = []
    for season in seasons:
        folder = input_root / season
        status_path = folder / "download_status.csv"
        fixtures_path = folder / "fixtures.csv"
        scores_path = folder / "fixture_scores.csv"
        if not all(path.exists() for path in (status_path, fixtures_path, scores_path)):
            continue
        status = read_csv(status_path, required=True)
        if len(status) != 1 or status[0].get("status", "").lower() != "complete":
            continue
        fixtures = read_csv(fixtures_path, required=True)
        scores = read_csv(scores_path, required=True)
        current = defaultdict(dict)
        for row in scores:
            if row.get("description") == "CURRENT" and row.get("score.participant") in {"home", "away"}:
                current[row["fixture_id"]][row["score.participant"]] = integer_or(row.get("score.goals"), -1)
        for row in fixtures:
            if (row.get("league_id") != "600" or not is_played(row)
                    or row.get("length") != "90" or re.search(r"award|abandon|walkover|cancel", " ".join(
                        row.get(key, "") for key in ("state", "details", "result_info")), re.I)):
                continue
            kickoff = parse_utc(row["kickoff"])
            score = current.get(row["fixture_id"], {})
            if kickoff >= forecast or set(score) != {"home", "away"} or min(score.values()) < 0:
                continue
            results.append({
                "fixture_id": row["fixture_id"], "kickoff": kickoff,
                "home": row["home_team_id"], "away": row["away_team_id"],
                "home_goals": score["home"], "away_goals": score["away"],
            })
        input_paths.extend((status_path, fixtures_path, scores_path))
    return results, input_paths


def team_goal_rates(results: list[dict], forecast: datetime):
    weighted_home = weighted_away = weight_total = 0.0
    observations = []
    for row in results:
        age = (forecast - row["kickoff"]).total_seconds() / 86400.0
        if age < 0 or age > 1095:
            continue
        weight = 2 ** (-age / 365.0)
        weighted_home += weight * row["home_goals"]
        weighted_away += weight * row["away_goals"]
        weight_total += weight
        observations.append((row, weight))
    if weight_total <= 0:
        raise ValueError("No completed matches are available for team goal estimates")
    home_base = weighted_home / weight_total
    away_base = weighted_away / weight_total
    attack_sum, defense_sum = defaultdict(float), defaultdict(float)
    team_weight = defaultdict(float)
    for row, weight in observations:
        for team, goals_for, goals_against, base_for, base_against in (
            (row["home"], row["home_goals"], row["away_goals"], home_base, away_base),
            (row["away"], row["away_goals"], row["home_goals"], away_base, home_base),
        ):
            attack_sum[team] += weight * goals_for / max(base_for, .1)
            defense_sum[team] += weight * goals_against / max(base_against, .1)
            team_weight[team] += weight
    prior = 8.0
    attack = {team: (prior + attack_sum[team]) / (prior + team_weight[team]) for team in team_weight}
    defense = {team: (prior + defense_sum[team]) / (prior + team_weight[team]) for team in team_weight}
    return home_base, away_base, attack, defense


def load_target_fixtures(season: str, matchweek: int | None, forecast: datetime,
                         input_root: Path = SPORTMONKS, historical: bool = False):
    """Fixtures of the target round, as visible at ``forecast``.

    ``historical`` replays a round that has since been played: the saved
    state is then FT rather than NS, so completeness is judged on kickoff
    times alone. Only the backtest sets it; a forecast must never accept a
    round whose result is already known.
    """
    folder = input_root / season
    rows = read_csv(folder / "fixtures.csv", required=True)
    teams = {row["id"]: row for row in read_csv(folder / "teams.csv", required=True)}
    status = read_csv(folder / "download_status.csv", required=True)
    if len(status) != 1 or status[0].get("status", "").lower() != "complete":
        raise ValueError("Target season download must be complete before projecting players")
    rounds = defaultdict(list)
    for row in rows:
        if row.get("league_id") == "600":
            round_number = integer_or(row.get("round.name") or row.get("round"), -1)
            if round_number >= 1:
                rounds[round_number].append(row)
    # Teams.csv is the saved season membership, including a possible bye in
    # odd-sized leagues. Never infer completeness from a hardcoded team count.
    expected_fixtures = len(teams) // 2

    def complete_future_round(group):
        if not group or len(group) != expected_fixtures:
            return False
        members = [row.get(key) for row in group for key in ("home_team_id", "away_team_id")]
        if len(set(members)) != len(members) or any(team not in teams for team in members):
            return False
        try:
            return all((historical or is_scheduled(row))
                       and parse_utc(row["kickoff"]) - timedelta(hours=1) > forecast for row in group)
        except (KeyError, ValueError):
            return False

    if matchweek is None:
        candidates = [number for number, group in rounds.items() if complete_future_round(group)]
        matchweek = min(candidates, key=lambda number: min(parse_utc(row["kickoff"]) for row in rounds[number])) if candidates else None
    elif not complete_future_round(rounds.get(matchweek, [])):
        raise ValueError(f"Matchweek {matchweek} must be complete, unstarted, and before its fantasy deadline")
    fixtures = []
    by_team = {}
    for row in rounds.get(matchweek, []):
        fixture = {"fixture_id": row["fixture_id"], "kickoff": parse_utc(row["kickoff"]),
                   "home": row["home_team_id"], "away": row["away_team_id"]}
        fixtures.append(fixture)
        if fixture["home"] in by_team or fixture["away"] in by_team:
            raise ValueError("A team occurs more than once in the target matchweek")
        by_team[fixture["home"]] = (fixture, "H", fixture["away"])
        by_team[fixture["away"]] = (fixture, "A", fixture["home"])
    return fixtures, by_team, teams, matchweek, [folder / name for name in ("fixtures.csv", "teams.csv", "download_status.csv")]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--season", required=True)
    parser.add_argument("--matchweek", type=int, help="Defaults to the next complete unstarted round")
    parser.add_argument("--input-root", type=Path, default=SPORTMONKS)
    parser.add_argument("--tff-players", type=Path, default=TFF_PLAYERS)
    parser.add_argument("--points-path", type=Path, default=POINTS)
    parser.add_argument("--odds-path", type=Path, default=ODDS,
                        help="Published odds forecast. Its Poisson expected goals replace "
                             "the internal team model when it covers the whole round.")
    parser.add_argument("--no-odds", action="store_true",
                        help="Always use the internal team model, ignoring the odds forecast.")
    parser.add_argument("--rules", type=Path, default=RULES)
    parser.add_argument("--output-root", type=Path, default=OUTPUT)
    parser.add_argument("--runs-root", type=Path, default=RUNS)
    parser.add_argument("--as-of", help="Backtest only: replay the projection as it would have "
                                        "stood at this UTC time instead of now.")
    parser.add_argument("--historical", action="store_true",
                        help="Backtest only: allow a target round that has since been played. "
                             "Requires --as-of before that round's deadline.")
    args = parser.parse_args(argv)
    season = season_folder(args.season)
    if args.historical and not args.as_of:
        parser.error("--historical requires --as-of")
    generated = parse_utc(args.as_of) if args.as_of else utc_now()
    if generated > utc_now():
        parser.error("--as-of cannot be in the future")
    fixtures, target_by_team, teams, matchweek, target_paths = load_target_fixtures(
        season, args.matchweek, generated, args.input_root, historical=args.historical)
    run = args.runs_root / f"{generated:%Y%m%dT%H%M%SZ}_mw{matchweek or 'none'}_{uuid.uuid4().hex[:8]}"
    output = args.output_root / season
    if not fixtures:
        # Empty output intentionally invalidates any previous upcoming forecast.
        for destination in (run, output):
            write_csv(destination / "player_projections.csv", [], OUTPUT_COLUMNS)
            write_csv(destination / "team_fixture_projections.csv", [], TEAM_COLUMNS)
            write_csv(destination / "run_status.csv", [{"status": "complete", "season": season,
                      "players": 0, "fixtures": 0, "generated_at_utc": utc_stamp(generated),
                      "projection_status": "no_upcoming_complete_round",
                      "message": "No complete unstarted matchweek before its deadline is available."}])
        print(f"No upcoming complete round for {season}; cleared current projections at {output}.")
        return 0
    first_kickoff = min(row["kickoff"] for row in fixtures)
    information_cutoff = min(generated, first_kickoff - timedelta(hours=1))
    rules = ScoringRules.load(args.rules)
    if rules.minutes_threshold != 60 or rules.clean_sheet_minutes != 60:
        raise ValueError("Projection minutes model currently requires the reviewed 60-minute rules")

    tff_rows = read_csv(args.tff_players, required=True)
    ledger_rows = read_csv(args.points_path, required=True)
    if not ledger_rows:
        raise ValueError("Points ledger is empty; rebuild points before projections")
    availability_paths = [args.input_root / season / name for name in ("team_sidelined.csv", "fixture_sidelined.csv")]
    team_absences, fixture_absences = [read_csv(path, required=True) if path.exists() else [] for path in availability_paths]
    current_pool = {}
    excluded = []
    for row in tff_rows:
        pid = row.get("sportmonks_player_id", "")
        tid = row.get("sportmonks_team_id", "")
        position = row.get("position", "")
        reasons = []
        if row.get("match_status") == "left_league": reasons.append("left_league")
        elif row.get("match_status") != "matched" or not pid.isdigit(): reasons.append("unreviewed_or_missing_player_id")
        if not tid.isdigit(): reasons.append("missing_team_id")
        if position not in POSITIONS: reasons.append("invalid_fantasy_position")
        if tid not in target_by_team: reasons.append("no_target_fixture")
        if reasons:
            excluded.append({"player_name": row.get("player_name", ""), "team_name": row.get("team_name", ""),
                             "player_id": pid, "team_id": tid, "reason": " ".join(reasons)})
        else:
            if pid in current_pool:
                raise ValueError(f"Duplicate matched player id in TFF pool: {pid}")
            current_pool[pid] = row

    result_seasons = sorted(path.name for path in args.input_root.iterdir()
                            if path.is_dir() and re.fullmatch(r"\d{4}-\d{4}", path.name))
    ledger_dependencies = [args.rules, args.tff_players, *(args.input_root / item / "player_match_stats.csv"
                                                         for item in result_seasons)]
    if any(path.exists() and path.stat().st_mtime > args.points_path.stat().st_mtime
           for path in ledger_dependencies):
        raise ValueError("Points inputs are newer than the saved ledger; rebuild points before projections")
    results, result_paths = load_fixture_results(result_seasons, information_cutoff, args.input_root)
    current_fixture_ids = {row["fixture_id"] for row in read_csv(args.input_root / season / "fixtures.csv", required=True)}
    eligible_current_ids = {row["fixture_id"] for row in results if row["fixture_id"] in current_fixture_ids}
    ledger_fixture_ids = {row.get("fixture_id") for row in ledger_rows if row.get("season") == season}
    if eligible_current_ids - ledger_fixture_ids:
        raise ValueError("Points ledger is missing completed target-season fixtures; rebuild points before projections")

    history = defaultdict(list)
    position_history = defaultdict(list)
    current_by_player = defaultdict(list)
    for row in ledger_rows:
        try:
            kickoff = parse_utc(row["kickoff_utc"])
        except (ValueError, KeyError):
            continue
        if kickoff >= information_cutoff or number_or(row.get("minutes_played")) <= 0:
            continue
        record = {
            "kickoff": kickoff, "minutes": number_or(row.get("minutes_played")),
            # A blank or zero rating means the provider published none; 0 is not
            # a real value on a 1-10 scale, so it must not enter an average.
            "rating": number_or(row.get("rating"), 0.0) or None,
            "started": integer_or(row.get("started")), "goals": number_or(row.get("goals")),
            "assists": number_or(row.get("assists")), "saves": number_or(row.get("saves")),
            "penalties_saved": number_or(row.get("penalties_saved")),
            "penalties_missed": number_or(row.get("penalties_missed")),
            "yellow_cards": number_or(row.get("yellow_cards")), "dismissals": number_or(row.get("dismissals")),
            "own_goals": number_or(row.get("own_goals")), "bonus": number_or(row.get("bonus")),
            "team_id": row.get("team_id", ""), "season": row.get("season", ""),
        }
        history[row["player_id"]].append(record)
        position_history[row.get("fantasy_position", "")].append(record)
        pool = current_pool.get(row["player_id"])
        if pool and record["season"] == season and record["team_id"] == pool["sportmonks_team_id"]:
            current_by_player[row["player_id"]].append(record)

    completed_team_matches = defaultdict(int)
    fixtures_current = read_csv(args.input_root / season / "fixtures.csv", required=True)
    for row in fixtures_current:
        if row.get("fixture_id") in eligible_current_ids:
            completed_team_matches[row["home_team_id"]] += 1
            completed_team_matches[row["away_team_id"]] += 1

    # Current-pool opportunity priors prevent a 3-4 match start record from
    # turning into an unjustified 0% or 100% probability.
    prior_totals = {position: defaultdict(float) for position in POSITIONS}
    for pid, player in current_pool.items():
        position, tid = player["position"], player["sportmonks_team_id"]
        games = completed_team_matches[tid]
        rows = current_by_player[pid]
        prior_totals[position]["opportunities"] += games
        prior_totals[position]["starts"] += sum(r["started"] == 1 for r in rows)
        prior_totals[position]["plays"] += len(rows)
        prior_totals[position]["sixty"] += sum(r["minutes"] >= 60 for r in rows)
        prior_totals[position]["starter_minutes"] += sum(r["minutes"] for r in rows if r["started"] == 1)
        prior_totals[position]["starter_rows"] += sum(r["started"] == 1 for r in rows)
        prior_totals[position]["bench_minutes"] += sum(r["minutes"] for r in rows if r["started"] == 0)
        prior_totals[position]["bench_rows"] += sum(r["started"] == 0 for r in rows)

    position_rates = {}
    recent_limit = information_cutoff - timedelta(days=730)
    for position in POSITIONS:
        rows = [r for r in position_history[position] if r["kickoff"] >= recent_limit]
        minutes = sum(r["minutes"] for r in rows)
        appearances = len(rows)
        position_rates[position] = {
            field: sum(r[field] for r in rows) / max(minutes, 1) * 90
            for field in ("goals", "assists", "saves", "penalties_saved", "penalties_missed",
                          "yellow_cards", "dismissals", "own_goals")
        }
        position_rates[position]["bonus"] = sum(r["bonus"] for r in rows) / max(appearances, 1)
        rated = [r for r in rows if r["rating"]]
        position_rates[position]["rating"] = (sum(r["rating"] for r in rated) / len(rated)
                                              if rated else 0.0)

    home_base, away_base, attack, defense = team_goal_rates(results, information_cutoff)
    average_team_goals = (home_base + away_base) / 2
    # The odds model estimates the same expected goals from a Poisson fit that is
    # tuned and checked every week. Prefer it, but only when it covers the entire
    # round and could not have seen more than this projection.
    if args.no_odds:
        odds_goals, odds_note = {}, "Odds forecast disabled with --no-odds; used the internal team model."
    else:
        odds_goals, odds_note = load_odds_goals(args.odds_path, fixtures, season, information_cutoff)
    team_goals_source = SOURCE_ODDS if odds_goals else SOURCE_INTERNAL
    print(odds_note)
    prior_strength = 1.5
    projection_rows = []
    pending_prior_round = any(integer_or(row.get("round.name") or row.get("round"), -1) < matchweek
                              and not is_finished(row) and fixture_state(row) not in CALLED_OFF_STATES
                              for row in fixtures_current if row.get("league_id") == "600")
    projection_status = "experimental_provisional_previous_round_incomplete" if pending_prior_round else "experimental"
    download_status = read_csv(args.input_root / season / "download_status.csv", required=True)[0]
    for pid, player in current_pool.items():
        tid, position = player["sportmonks_team_id"], player["position"]
        fixture, venue, opponent = target_by_team[tid]
        opponent_row = teams.get(opponent, {})
        current = current_by_player[pid]
        games = completed_team_matches[tid]
        totals = prior_totals[position]
        opportunities = max(totals["opportunities"], 1)
        prior_start = totals["starts"] / opportunities if totals["opportunities"] else .5
        prior_play = totals["plays"] / opportunities if totals["opportunities"] else .65
        prior_sixty = totals["sixty"] / opportunities if totals["opportunities"] else .4
        starts = sum(r["started"] == 1 for r in current)
        appearances = len(current)
        sixties = sum(r["minutes"] >= 60 for r in current)
        chance_start = min(1.0, max(0.0, (starts + prior_strength * prior_start) / (games + prior_strength)))
        chance_play = (appearances + prior_strength * prior_play) / (games + prior_strength)
        chance_sixty = (sixties + prior_strength * prior_sixty) / (games + prior_strength)
        chance_play = min(1.0, max(chance_start, chance_play))
        chance_sixty = min(chance_play, max(0.0, chance_sixty))
        starter_minutes = totals["starter_minutes"] / totals["starter_rows"] if totals["starter_rows"] else 75.0
        bench_minutes = totals["bench_minutes"] / totals["bench_rows"] if totals["bench_rows"] else 20.0
        player_starter = [r["minutes"] for r in current if r["started"] == 1]
        player_bench = [r["minutes"] for r in current if r["started"] == 0]
        if player_starter: starter_minutes = (sum(player_starter) + 2 * starter_minutes) / (len(player_starter) + 2)
        if player_bench: bench_minutes = (sum(player_bench) + 2 * bench_minutes) / (len(player_bench) + 2)
        expected_minutes = chance_start * starter_minutes + max(0.0, chance_play - chance_start) * bench_minutes
        expected_minutes = min(90.0, max(0.0, expected_minutes))

        published = odds_goals.get(fixture["fixture_id"])
        if published:
            home_goals, away_goals = published
            team_xg, opponent_xg = (home_goals, away_goals) if venue == "H" else (away_goals, home_goals)
        else:
            if venue == "H":
                team_xg = home_base * attack.get(tid, 1.0) * defense.get(opponent, 1.0)
                opponent_xg = away_base * attack.get(opponent, 1.0) * defense.get(tid, 1.0)
            else:
                team_xg = away_base * attack.get(tid, 1.0) * defense.get(opponent, 1.0)
                opponent_xg = home_base * attack.get(opponent, 1.0) * defense.get(tid, 1.0)
            team_xg, opponent_xg = (min(3.5, max(.25, value)) for value in (team_xg, opponent_xg))
        context = fixture_context(tid, opponent, venue, home_base, away_base, attack, defense)
        attack_scale = team_xg / average_team_goals
        defense_scale = opponent_xg / average_team_goals
        recent = [row for row in history[pid] if row["kickoff"] >= recent_limit]
        rates = {}
        effective_minutes = 0.0
        for field in ("goals", "assists", "saves", "penalties_saved", "penalties_missed",
                      "yellow_cards", "dismissals", "own_goals"):
            rates[field], effective = weighted_rate(recent, field, information_cutoff,
                                                     position_rates[position][field], 720.0)
            effective_minutes = max(effective_minutes, effective)
        bonus_per_play = weighted_per_appearance(recent, "bonus", information_cutoff,
                                                 position_rates[position]["bonus"], 8.0)
        # Decayed average provider rating, shrunk toward the position mean. Carried
        # for display and tie-breaking; it is deliberately not part of expected
        # points, which are built from the scoring rules alone.
        rated_recent = [row for row in recent if row["rating"]]
        recent_rating = weighted_per_appearance(rated_recent, "rating", information_cutoff,
                                                position_rates[position]["rating"], 4.0)
        player_goal_lambda = rates["goals"] * expected_minutes / 90 * attack_scale
        player_assist_lambda = rates["assists"] * expected_minutes / 90 * attack_scale
        # Card counts carry no fixture scaling, unlike goals and assists.
        yellow_lambda = rates["yellow_cards"] * expected_minutes / 90
        red_lambda = rates["dismissals"] * expected_minutes / 90
        # Mixture: no appearance means no goal. Conditional Poisson scoring
        # ensures scoring probability never exceeds playing probability.
        chance_score = chance_play * (1 - math.exp(-max(0.0, player_goal_lambda) / chance_play)) if chance_play else 0.0
        clean_probability = math.exp(-opponent_xg)
        component = {
            "points_appearance": chance_play * rules.appearance_short + chance_sixty * (rules.appearance_long - rules.appearance_short),
            "points_goals": player_goal_lambda * rules.goal[position],
            "points_assists": player_assist_lambda * rules.assist,
            "points_clean_sheet": chance_sixty * clean_probability * rules.clean_sheet[position],
            "points_saves": 0.0,
            "points_penalty_saved": rates["penalties_saved"] * expected_minutes / 90 * rules.penalty_saved,
            "points_penalty_missed": rates["penalties_missed"] * expected_minutes / 90 * rules.penalty_missed,
            "points_goals_conceded": 0.0,
            "points_cards": yellow_lambda * rules.yellow_card + red_lambda * rules.red_card,
            "points_own_goal": expected_minutes / 90 * rates["own_goals"] * rules.own_goal,
            "points_bonus": chance_play * bonus_per_play,
        }
        if position == "KL":
            save_lambda = rates["saves"] * expected_minutes / 90 * defense_scale
            component["points_saves"] = rules.save_points * chance_play * expected_floor_poisson(
                save_lambda / max(chance_play, .05), rules.saves_per_point)
        if position in rules.conceded_positions:
            conceded_lambda_if_playing = opponent_xg * expected_minutes / 90 / max(chance_play, .05)
            component["points_goals_conceded"] = rules.conceded_points * chance_play * expected_floor_poisson(conceded_lambda_if_playing, rules.conceded_per_penalty)
        expected_points = sum(component.values())
        history_minutes = sum(r["minutes"] for r in recent)
        confidence = "high" if effective_minutes >= 900 and games >= 3 else "medium" if effective_minutes >= 270 else "low"
        opponent_code = opponent_row.get("short_code") or opponent_row.get("name") or opponent
        projection = {
            "season": season, "player_id": pid,
            "player_name": player.get("sportmonks_display_name") or player["player_name"],
            "team_id": tid,
            "team_name": player["sportmonks_team_name"] or player["team_name"], "position": position,
            "price_million_try": number_or(player.get("price_million_try"), "") if number_or(player.get("price_million_try"), -1) > 0 else "", "fixture_id": fixture["fixture_id"],
            "matchweek": matchweek, "kickoff_utc": utc_stamp(fixture["kickoff"]),
            "opponent_id": opponent, "opponent_name": opponent_row.get("name", opponent),
            "opponent_short_code": opponent_code, "venue": venue,
            "opponent_display": f"{opponent_code} ({venue})", "expected_points": expected_points,
            "chance_starting": chance_start, "chance_starting_percent": round(chance_start * 100),
            "chance_playing": chance_play, "chance_playing_percent": round(chance_play * 100),
            "chance_60_minutes": chance_sixty, "chance_60_minutes_percent": round(chance_sixty * 100),
            "chance_scoring": chance_score, "chance_scoring_percent": round(chance_score * 100),
            "expected_minutes": expected_minutes, "team_expected_goals": team_xg,
            "opponent_expected_goals": opponent_xg, "team_goals_source": team_goals_source,
            "team_clean_sheet_probability": clean_probability,
            "expected_player_goals": player_goal_lambda, "expected_player_assists": player_assist_lambda,
            "expected_yellow_cards": yellow_lambda, "expected_red_cards": red_lambda,
            **component, **context, "current_starts": starts, "current_appearances": appearances,
            "current_team_matches": games, "history_matches": len(recent), "history_minutes": history_minutes,
            "effective_history_minutes": effective_minutes,
            "recent_rating": recent_rating if rated_recent or position_rates[position]["rating"] else "",
            "rating_appearances": len(rated_recent), "confidence": confidence,
            "projection_status": projection_status,
            "generated_at_utc": utc_stamp(generated), "information_cutoff_utc": utc_stamp(information_cutoff),
            "availability_updated_at_utc": download_status.get("finished_at_utc", ""),
        }
        availability = resolve_availability(player_id=pid, team_id=tid,
            fixture_id=fixture["fixture_id"], kickoff=fixture["kickoff"], cutoff=information_cutoff,
            team_rows=team_absences, fixture_rows=fixture_absences,
            team_feed_present=availability_paths[0].exists(), fixture_feed_present=availability_paths[1].exists())
        if not projection["price_million_try"]:
            availability["eligible_for_selection"] = False
            availability["availability_reason"] += " Price is missing; excluded from budget selection."
        projection_rows.append(apply_availability(projection, availability, FORECAST_FIELDS))
    projection_rows.sort(key=lambda row: (not row["eligible_for_selection"], -number_or(row["expected_points"], -1e9), row["player_name"]))

    write_csv(run / "player_projections.csv", projection_rows, OUTPUT_COLUMNS)
    write_csv(run / "excluded_players.csv", excluded,
              ["player_name", "team_name", "player_id", "team_id", "reason"])
    team_projection_rows = [{
        "season": season, "fixture_id": fixture["fixture_id"], "matchweek": matchweek,
        "kickoff_utc": utc_stamp(fixture["kickoff"]), "home_team_id": fixture["home"],
        "home_team_name": teams.get(fixture["home"], {}).get("name", fixture["home"]),
        "away_team_id": fixture["away"], "away_team_name": teams.get(fixture["away"], {}).get("name", fixture["away"]),
        "home_expected_goals": odds_goals.get(fixture["fixture_id"], (
            min(3.5, max(.25, home_base * attack.get(fixture["home"], 1) * defense.get(fixture["away"], 1))),
            None))[0],
        "away_expected_goals": odds_goals.get(fixture["fixture_id"], (
            None,
            min(3.5, max(.25, away_base * attack.get(fixture["away"], 1) * defense.get(fixture["home"], 1))),
        ))[1],
        "team_goals_source": team_goals_source,
        "generated_at_utc": utc_stamp(generated), "information_cutoff_utc": utc_stamp(information_cutoff),
        "projection_status": projection_status,
    } for fixture in fixtures]
    write_csv(run / "team_fixture_projections.csv", team_projection_rows, TEAM_COLUMNS)
    source_paths = sorted(set([args.tff_players, args.points_path, args.rules, *target_paths,
                               *result_paths, *(path for path in availability_paths if path.exists())]))
    write_csv(run / "input_manifest.csv", [{
        "path": str(path.resolve()), "bytes": path.stat().st_size,
        "last_write_utc": utc_stamp(datetime.fromtimestamp(path.stat().st_mtime, UTC)),
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    } for path in source_paths], ["path", "bytes", "last_write_utc", "sha256"])
    write_csv(run / "run_settings.csv", [
        {"setting": "season", "value": season}, {"setting": "matchweek", "value": matchweek},
        {"setting": "generated_at_utc", "value": utc_stamp(generated)},
        {"setting": "information_cutoff_utc", "value": utc_stamp(information_cutoff)},
        {"setting": "model", "value": "component_projection_experimental_0.2"},
        {"setting": "replayed_as_of", "value": utc_stamp(generated) if args.as_of else ""},
        {"setting": "historical_replay", "value": bool(args.historical)},
        {"setting": "scoring_rules_unconfirmed", "value": "|".join(rules.unconfirmed)},
        {"setting": "team_availability_present", "value": availability_paths[0].exists()},
        {"setting": "fixture_availability_present", "value": availability_paths[1].exists()},
        {"setting": "player_rate_half_life_days", "value": 240},
        {"setting": "player_rate_history_days", "value": 730},
        {"setting": "player_rate_prior_minutes", "value": 720},
        {"setting": "lineup_prior_strength_matches", "value": prior_strength},
        {"setting": "team_rate_half_life_days", "value": 365},
        {"setting": "team_rate_history_days", "value": 1095},
        {"setting": "team_rate_prior_matches", "value": 8},
        {"setting": "team_goals_source", "value": team_goals_source},
        {"setting": "team_goals_note", "value": odds_note},
        {"setting": "status", "value": projection_status},
    ], ["setting", "value"])
    run_status = [{"status": "complete", "season": season, "matchweek": matchweek,
        "players": len(projection_rows), "excluded_players": len(excluded),
        "fixtures": len(fixtures), "generated_at_utc": utc_stamp(generated),
        "projection_status": projection_status, "message": "Experimental component player projections completed."}]
    write_csv(run / "run_status.csv", run_status)
    # Read the stamps before they are overwritten, not after.
    replaced = [published_generation(output / name) for name in
                ("player_projections.csv", "team_fixture_projections.csv")]
    write_csv(output / "player_projections.csv", projection_rows, OUTPUT_COLUMNS)
    write_csv(output / "team_fixture_projections.csv", team_projection_rows, TEAM_COLUMNS)
    write_csv(output / "run_status.csv", run_status)
    print(f"Projected {len(projection_rows)} players for matchweek {matchweek}; excluded {len(excluded)}.")
    warn_if_unpublishing(replaced, args.season)
    print(f"Output: {output}; audit: {run}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
