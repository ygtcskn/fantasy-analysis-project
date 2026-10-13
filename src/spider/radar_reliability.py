"""Measure how far an early-season radar rate can be trusted.

For every completed saved season, each player's per-90 (or percentage) over the
first N rounds is compared with the same figure over the rest of that season.
The rest of the season never overlaps the early window, so the comparison is
out of sample: a high rank correlation means an N-round figure already says
where a player will end up, a low one means it is mostly luck.

Both the observed early figure and the small-sample adjusted one the website
ranks (src/web/lib/radar.js, RadarScoring.adjusted) are scored, so the report
also shows whether the adjustment helps. The rules mirror the browser's: only
finished fixtures, unused-substitute rows dropped, a blank counting cell is a
zero only on a match the statistics feed covered, a column an earlier season
clearly did not supply is unknown there, broad position by most minutes, the
seeded minute bar and the scaled attempt requirement.

Writes one CSV report; reads only saved CSVs. Run it yourself:

    python -m src.spider.radar_reliability
"""
from __future__ import annotations

import argparse
import math
from collections import defaultdict
from pathlib import Path

from src.tables.common import (ROOT, blank, covered, is_finished, nonnegative,
                               number, read_csv, text, write_csv)

SPIDER_ROOT = ROOT / "data/final/spider"
SOURCE_ROOT = ROOT / "data/final/sportmonks"
OUTPUT = ROOT / "data/temp/radar_reliability.csv"
WINDOWS = (4, 7, 10, 15)
# The rest of the season is the answer key, so it needs a stable sample.
TARGET_MINUTES = 900
# Mirrors RadarScoring.shrinkage in radar.js.
PRIOR_PEERS = 10
PRIOR_MAX_MINUTES = 2700
PRIOR_ATTEMPT_MULTIPLE = 10

GROUPS = {"goalkeeper": "GK", "defender": "DEF", "midfielder": "MID", "attacker": "FW"}
OUTFIELD = ("DEF", "MID", "FW")
EVERY = ("GK",) + OUTFIELD

# id: (kind, columns, positions, minimum attempts for a percentage). The same
# catalogue as RadarScoring.metrics for the per-90 and percentage axes.
METRICS = {
    "goal_contribution": ("sum", ("goals", "assists"), OUTFIELD, None),
    "goals": ("rate", ("goals",), OUTFIELD, None),
    "assists": ("rate", ("assists",), OUTFIELD, None),
    "xg": ("xg", ("xg_expected_goals", "expected_goals"), OUTFIELD, None),
    "shots": ("rate", ("shots_total",), OUTFIELD, None),
    "shots_on_target": ("rate", ("shots_on_target",), OUTFIELD, None),
    "big_chances": ("rate", ("big_chances_created",), OUTFIELD, None),
    "key_passes": ("rate", ("key_passes",), OUTFIELD, None),
    "chances": ("rate", ("chances_created",), OUTFIELD, None),
    "accurate_crosses": ("rate", ("accurate_crosses",), OUTFIELD, None),
    "final_third": ("rate", ("passes_in_final_third",), OUTFIELD, None),
    "dribbles": ("rate", ("successful_dribbles",), OUTFIELD, None),
    "fouls_drawn": ("rate", ("fouls_drawn",), OUTFIELD, None),
    "touches": ("rate", ("touches",), OUTFIELD, None),
    "passes": ("rate", ("passes",), EVERY, None),
    "long_balls": ("rate", ("long_balls",), EVERY, None),
    "possession_lost": ("rate", ("possession_lost",), OUTFIELD, None),
    "dispossessed": ("rate", ("dispossessed",), OUTFIELD, None),
    "tackles": ("rate", ("tackles",), OUTFIELD, None),
    "interceptions": ("rate", ("interceptions",), OUTFIELD, None),
    "ball_recovery": ("rate", ("ball_recovery",), OUTFIELD, None),
    "blocks": ("rate", ("blocked_shots",), OUTFIELD, None),
    "clearances": ("rate", ("clearances",), OUTFIELD, None),
    "aerials_won": ("rate", ("aerials_won",), OUTFIELD, None),
    "duels_won": ("rate", ("duels_won",), OUTFIELD, None),
    "duels": ("rate", ("total_duels",), OUTFIELD, None),
    "fouls": ("rate", ("fouls",), EVERY, None),
    "yellowcards": ("rate", ("yellowcards",), EVERY, None),
    "redcards": ("rate", ("redcards",), EVERY, None),
    "errors_goal": ("rate", ("error_lead_to_goal",), EVERY, None),
    "errors_shot": ("rate", ("error_lead_to_shot",), EVERY, None),
    "saves": ("rate", ("saves",), ("GK",), None),
    "saves_inside_box": ("rate", ("saves_inside_box",), ("GK",), None),
    "claims": ("rate", ("good_high_claim",), ("GK",), None),
    "punches": ("rate", ("punches",), ("GK",), None),
    "conceded": ("rate", ("goalkeeper_goals_conceded",), ("GK",), None),
    "pass_accuracy": ("ratio", ("accurate_passes", "passes"), EVERY, 100),
    "long_accuracy": ("ratio", ("long_balls_won", "long_balls"), EVERY, 30),
    "duel_pct": ("ratio", ("duels_won", "total_duels"), OUTFIELD, 30),
}

COLUMNS = ("window_rounds", "position", "metric", "seasons", "players", "early_minutes_median",
           "prior_mean", "prior_weight", "prior_unit", "own_share_median",
           "spearman_observed", "spearman_adjusted", "percentile_error_observed",
           "percentile_error_adjusted", "reading")


def counted(row: dict, column: str):
    """Shared omitted-zero rule: a blank is none only on a covered match."""
    value = nonnegative(row.get(column))
    if value is not None:
        return value
    return 0.0 if column in row and blank(row.get(column)) and covered(row) else None


def match_value(row: dict, kind: str, columns: tuple) -> float | None:
    if kind == "sum":
        parts = [counted(row, column) for column in columns]
        return None if None in parts else sum(parts)
    if kind == "xg":
        direct = nonnegative(row.get(columns[0]))
        if direct is not None:
            return direct
        if columns[0] in row and blank(row.get(columns[0])):
            fallback = counted(row, columns[1])
            if fallback is not None:
                return fallback
        return counted(row, columns[0])
    return counted(row, columns[0])


def unplayed(row: dict) -> bool:
    minutes = number(row.get("minutes_played"))
    if minutes == 0:
        return True
    if minutes is not None or not blank(row.get("minutes_played")):
        return False
    return not covered(row) and blank(row.get("rating")) and not ((number(row.get("started")) or 0) > 0)


def round_number(fixture: dict) -> int | None:
    value = number(fixture.get("round.name"))
    return int(value) if value is not None and value == int(value) and value > 0 else None


def tally(rows: list[dict], metric: str) -> dict | None:
    """Season events and exposure for one player, with match-level sums for noise."""
    kind, columns, _, _ = METRICS[metric]
    pairs = []
    for row in rows:
        if kind == "ratio":
            made = counted(row, columns[0])
            attempts = nonnegative(row.get(columns[1]))
            if attempts is None and made == 0:
                attempts = counted(row, columns[1])
            if made is None or attempts is None or made > attempts:
                return None
            pairs.append((made, attempts))
        else:
            value = match_value(row, kind, columns)
            minutes = nonnegative(row.get("minutes_played"))
            if value is None or minutes is None:
                return None
            pairs.append((value, minutes))
    used = [(value, weight) for value, weight in pairs if weight > 0]
    exposure = sum(weight for _, weight in used)
    if not used or exposure <= 0:
        return None
    events = sum(value for value, _ in used)
    rate = events / exposure
    variance = None
    if len(used) >= 2:
        residual = sum((value - rate * weight) ** 2 for value, weight in used)
        variance = residual / exposure ** 2 * len(used) / (len(used) - 1)
    return {"events": events, "exposure": exposure, "variance": variance}


def scale(metric: str) -> float:
    return 100.0 if METRICS[metric][0] == "ratio" else 90.0


def prior(metric: str, tallies: list[dict]) -> dict | None:
    """RadarScoring.estimatePrior: the true spread left after measured noise."""
    if len(tallies) < PRIOR_PEERS:
        return None
    ratio = METRICS[metric][0] == "ratio"
    mean = sum(item["events"] for item in tallies) / sum(item["exposure"] for item in tallies)
    if not mean > 0 or (ratio and not mean < 1):
        return None
    unit = mean * (1 - mean) if ratio else mean
    spread = sum((item["events"] / item["exposure"] - mean) ** 2 for item in tallies) / len(tallies)

    def variance(item):
        return item["variance"] if item["variance"] is not None else unit / item["exposure"]

    noise = sum(variance(item) for item in tallies) / len(tallies)
    # Noise of one minute (or attempt): a rate over m minutes varies by about dispersion / m.
    dispersion = sum(variance(item) * item["exposure"] for item in tallies) / len(tallies)
    signal = spread - noise
    cap = METRICS[metric][3] * PRIOR_ATTEMPT_MULTIPLE if ratio else PRIOR_MAX_MINUTES
    weight = min(cap, dispersion / signal) if signal > 0 else cap
    return {"mean": mean, "weight": weight}


def required_attempts(metric: str, bar: float) -> int:
    minimum = METRICS[metric][3] or 0
    return max(min(minimum, 20), round(minimum * min(1.0, bar / 900)))


def ranks(values: list[float]) -> list[float]:
    order = sorted(range(len(values)), key=lambda index: values[index])
    result = [0.0] * len(values)
    start = 0
    while start < len(order):
        end = start
        while end + 1 < len(order) and values[order[end + 1]] == values[order[start]]:
            end += 1
        for position in range(start, end + 1):
            result[order[position]] = (start + end) / 2 + 1
        start = end + 1
    return result


def spearman(first: list[float], second: list[float]) -> float | None:
    if len(first) < 3:
        return None
    a, b = ranks(first), ranks(second)
    mean_a, mean_b = sum(a) / len(a), sum(b) / len(b)
    covariance = sum((x - mean_a) * (y - mean_b) for x, y in zip(a, b))
    spread = math.sqrt(sum((x - mean_a) ** 2 for x in a) * sum((y - mean_b) ** 2 for y in b))
    return covariance / spread if spread > 0 else None


def percentile_error(first: list[float], second: list[float]) -> float | None:
    """Mean absolute gap, in percentile points, between early and later standing."""
    if len(first) < 3:
        return None
    count = len(first)
    a = [(rank - 0.5) / count * 100 for rank in ranks(first)]
    b = [(rank - 0.5) / count * 100 for rank in ranks(second)]
    return sum(abs(x - y) for x, y in zip(a, b)) / count


def reading(correlation: float | None) -> str:
    if correlation is None:
        return "unknown"
    return ("strong" if correlation >= 0.7 else "moderate" if correlation >= 0.5
            else "weak" if correlation >= 0.3 else "noise")


def season_players(season: str, rounds: int, unsupplied: set[str]) -> list[dict]:
    """Every player of one completed season: early-window rows, later rows, role."""
    fixtures = {row["fixture_id"]: row for row in read_csv(SOURCE_ROOT / season / "fixtures.csv")
                if is_finished(row) and round_number(row) is not None}
    rows = defaultdict(lambda: {"early": [], "late": []})
    for record in read_csv(SPIDER_ROOT / season / "spider_stats.csv"):
        if record.get("entity_type") != "player" or not record.get("player_id"):
            continue
        fixture = fixtures.get(record.get("fixture_id"))
        if fixture is None:
            continue
        row = {key[2:] if key.startswith("p_") else key: value for key, value in record.items()}
        for column in unsupplied:
            row.pop(column, None)
        if unplayed(row):
            continue
        rows[record["player_id"]]["early" if round_number(fixture) <= rounds else "late"].append(row)
    players = []
    for player_id, parts in rows.items():
        early = parts["early"]
        minutes = [nonnegative(row.get("minutes_played")) for row in early]
        if not early or None in minutes:
            continue
        weights = defaultdict(float)
        for row, value in zip(early, minutes):
            group = GROUPS.get(str(row.get("position") or "").strip().lower())
            if group and value > 0:
                weights[group] += value
        ordered = sorted(weights.items(), key=lambda item: -item[1])
        if not ordered or (len(ordered) > 1 and ordered[0][1] == ordered[1][1]):
            continue
        late_minutes = [nonnegative(row.get("minutes_played")) for row in parts["late"]]
        players.append({"season": season, "id": player_id, "position": ordered[0][0],
                        "minutes": sum(minutes), "early": early, "late": parts["late"],
                        "late_minutes": None if None in late_minutes else sum(late_minutes)})
    return players


def fill_rates(season: str) -> dict[str, float]:
    played = [row for row in read_csv(SPIDER_ROOT / season / "spider_stats.csv")
              if row.get("entity_type") == "player" and (number(row.get("minutes_played")) or 0) > 0
              and covered({key[2:]: value for key, value in row.items() if key.startswith("p_")})]
    columns = {column for _, columns, _, _ in METRICS.values() for column in columns}
    return {column: (sum(not blank(row.get(f"p_{column}")) for row in played) / len(played) if played else 0.0)
            for column in columns} | {"_n": float(len(played))}


def unsupplied_columns(own: dict[str, float], reference: dict[str, float]) -> set[str]:
    """The browser's feed-availability rule, against the latest completed season."""
    result = set()
    count = own["_n"]
    for column, expected in reference.items():
        if column == "_n" or not expected > 0 or not count:
            continue
        observed = own.get(column, 0.0)
        spread = math.sqrt(count * expected * (1 - expected)) or 1
        if observed < 0.8 * expected and (observed - expected) * count / spread < -4:
            result.add(column)
    return result


def completed_seasons() -> list[str]:
    seasons = []
    for folder in sorted(SPIDER_ROOT.iterdir() if SPIDER_ROOT.is_dir() else []):
        fixtures = read_csv(SOURCE_ROOT / folder.name / "fixtures.csv")
        if (folder / "spider_stats.csv").is_file() and fixtures and all(is_finished(row) for row in fixtures):
            seasons.append(folder.name)
    return seasons


def build(windows=WINDOWS) -> list[dict]:
    seasons = completed_seasons()
    if not seasons:
        raise SystemExit("No completed season with spider_stats.csv; build the spider CSVs first.")
    rates = {season: fill_rates(season) for season in seasons}
    missing = {season: unsupplied_columns(rates[season], rates[seasons[-1]]) for season in seasons}
    report = []
    for rounds in windows:
        players = [player for season in seasons for player in season_players(season, rounds, missing[season])]
        # The browser's minute bar, per season: half the busiest player's
        # minutes in the window, rounded to a third of a match, 90 to 900.
        bars = {}
        for season in seasons:
            most = max((player["minutes"] for player in players if player["season"] == season), default=0)
            bars[season] = min(900, max(90, round(most / 60) * 30)) if most else 900
        for position in EVERY:
            group = [player for player in players if player["position"] == position
                     and player["minutes"] >= bars[player["season"]]]
            for metric, (kind, _, positions, _) in METRICS.items():
                if position not in positions:
                    continue
                # As on the site: the prior is fitted on peers meeting the full
                # attempt minimum, then applied to everyone with an attempt.
                early, strict = {}, []
                for player in group:
                    item = tally(player["early"], metric)
                    if item is None:
                        continue
                    early[(player["season"], player["id"])] = item
                    if kind != "ratio" or item["exposure"] >= required_attempts(metric, bars[player["season"]]):
                        strict.append(item)
                fitted = prior(metric, strict)
                if kind == "ratio":
                    kept = {id(item) for item in strict}
                    early = {key: item for key, item in early.items()
                             if id(item) in kept or (fitted and item["exposure"] > 0)}
                observed, adjusted, later, shares, minutes, used = [], [], [], [], [], set()
                for player in group:
                    item = early.get((player["season"], player["id"]))
                    if item is None or not player["late_minutes"] or player["late_minutes"] < TARGET_MINUTES:
                        continue
                    target = tally(player["late"], metric)
                    if target is None or (kind == "ratio" and target["exposure"] < (METRICS[metric][3] or 0)):
                        continue
                    weight = fitted["weight"] if fitted else 0.0
                    centre = fitted["mean"] if fitted else 0.0
                    observed.append(item["events"] / item["exposure"])
                    adjusted.append((item["events"] + centre * weight) / (item["exposure"] + weight))
                    later.append(target["events"] / target["exposure"])
                    shares.append(item["exposure"] / (item["exposure"] + weight))
                    minutes.append(player["minutes"])
                    used.add(player["season"])
                plain, shrunk = spearman(observed, later), spearman(adjusted, later)
                report.append({
                    "window_rounds": rounds, "position": position, "metric": metric,
                    "seasons": " ".join(sorted(used)), "players": len(observed),
                    "early_minutes_median": text(sorted(minutes)[len(minutes) // 2] if minutes else None, 0),
                    "prior_mean": text(fitted["mean"] * scale(metric) if fitted else None, 4),
                    "prior_weight": text(fitted["weight"] if fitted else None, 0),
                    "prior_unit": ("attempts" if kind == "ratio" else "minutes") if fitted else "",
                    "own_share_median": text(sorted(shares)[len(shares) // 2] if shares else None, 3),
                    "spearman_observed": text(plain, 3), "spearman_adjusted": text(shrunk, 3),
                    "percentile_error_observed": text(percentile_error(observed, later), 1),
                    "percentile_error_adjusted": text(percentile_error(adjusted, later), 1),
                    "reading": reading(shrunk),
                })
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--windows", type=int, nargs="+", default=list(WINDOWS),
                        help="Early-window sizes in rounds (default: 4 7 10 15)")
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args(argv)
    if any(value < 1 for value in args.windows):
        parser.error("Windows must be positive round counts")
    write_csv(args.output, build(sorted(set(args.windows))), COLUMNS)
    print(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
