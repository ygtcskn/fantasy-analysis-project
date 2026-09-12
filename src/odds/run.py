"""Local, CSV-only match probability research. Never calls a provider API."""
from __future__ import annotations

import argparse
import csv
import json
from collections import defaultdict
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.metadata
import math
from pathlib import Path
import re
import sys
import uuid

from data_loader import load_seasons

ROOT = Path(__file__).resolve().parents[2]
INPUT = ROOT / "data" / "final" / "sportmonks"
# The published product: one file, overwritten by each forecast.
OUTPUT = ROOT / "data" / "final" / "odds"
LATEST_PREDICTIONS = OUTPUT / "predictions.csv"
# Per-run records are working files, kept out of the published folder and
# alongside every other module's rebuildable output under data/temp.
SCRATCH = ROOT / "data" / "temp" / "odds"
RUNS = SCRATCH / "runs"
DEFAULT_GBDT_PARAMS = Path(__file__).resolve().parent / "xgboost_params.json"
# Half-lives compared on the validation season. Recent form is more relevant
# but there is less of it, and that trade is a measurement, not a guess.
DEFAULT_DECAY_CANDIDATES = (120.0, 180.0, 270.0, 365.0, 550.0)
OUTCOMES = ("home", "draw", "away")
PREDICTION_COLUMNS = [
    "fixture_id", "season", "kickoff_utc", "information_cutoff_utc",
    "generated_at_utc", "phase", "candidate", "model", "model_version",
    "home_team_id", "away_team_id", "home_team_name", "away_team_name",
    "home_expected_goals", "away_expected_goals", "home_probability",
    "draw_probability", "away_probability", "home_fair_odds", "draw_fair_odds",
    "away_fair_odds", "rho", "tail_mass", "training_matches",
    "effective_matches", "training_latest_available_at_utc", "optimizer_at_parameter_bounds",
    "optimizer_message", "actual_outcome",
    "home_goals", "away_goals", "log_loss", "brier_score", "correct",
]
METRIC_COLUMNS = ["phase", "season", "candidate", "matches", "log_loss", "brier_score", "accuracy"]


def stamp(value):
    return value.astimezone(timezone.utc).isoformat() if value else ""


def write_csv(path, rows, columns=None):
    rows = list(rows)
    columns = columns or sorted({key for row in rows for key in row}) or ["note"]
    with path.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=columns, extrasaction="raise")
        writer.writeheader()
        writer.writerows(rows)


def status(folder, state, message, **extra):
    write_csv(folder / "run_status.csv", [{
        "status": state, "message": message, "updated_at_utc": stamp(datetime.now(timezone.utc)),
        **extra,
    }])


def season_name(value):
    value = value.replace("/", "-")
    if not re.fullmatch(r"\d{4}-\d{4}", value) or int(value[5:]) != int(value[:4]) + 1:
        raise argparse.ArgumentTypeError("Use a season such as 2021/2022.")
    return value


def positive(value):
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError("Must be a finite positive number.")
    return number


def positive_integer(value):
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("Must be a positive integer.")
    return number


def kickoff_bound(value):
    """Accept a plain date (read as UTC midnight) or a full ISO timestamp."""
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("Use YYYY-MM-DD or an ISO timestamp.") from exc
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)


def describe(matches):
    """Descriptive results, never presented as fitted probabilities."""
    groups = defaultdict(list)
    teams = defaultdict(list)
    for match in matches:
        if not match.outcome:
            continue
        groups[match.season].append(match)
        teams[(match.season, match.home_team_id, match.home_team_name)].append((match, True))
        teams[(match.season, match.away_team_id, match.away_team_name)].append((match, False))
    season_rows = []
    for season, games in sorted(groups.items()):
        n = len(games)
        home = sum(game.home_goals for game in games)
        away = sum(game.away_goals for game in games)
        season_rows.append({
            "season": season, "played_matches": n,
            "home_wins": sum(game.outcome == "home" for game in games),
            "draws": sum(game.outcome == "draw" for game in games),
            "away_wins": sum(game.outcome == "away" for game in games),
            "home_win_share": sum(game.outcome == "home" for game in games) / n,
            "draw_share": sum(game.outcome == "draw" for game in games) / n,
            "away_win_share": sum(game.outcome == "away" for game in games) / n,
            "home_goals_per_match": home / n, "away_goals_per_match": away / n,
            "total_goals_per_match": (home + away) / n,
        })
    team_rows = []
    for (season, team_id, name), games in sorted(teams.items()):
        wins = draws = goals_for = goals_against = 0
        for match, home in games:
            gf, ga = (match.home_goals, match.away_goals) if home else (match.away_goals, match.home_goals)
            wins += gf > ga
            draws += gf == ga
            goals_for += gf
            goals_against += ga
        team_rows.append({
            "season": season, "team_id": team_id, "team_name": name, "played_matches": len(games),
            "home_matches": sum(home for _, home in games), "away_matches": sum(not home for _, home in games),
            "wins": wins, "draws": draws, "losses": len(games) - wins - draws,
            "goals_for": goals_for, "goals_against": goals_against,
            "observed_win_share": wins / len(games),
        })
    return season_rows, team_rows


def record_inputs(folder, dataset, args):
    write_csv(folder / "coverage_report.csv", dataset.coverage)
    write_csv(folder / "excluded_fixtures.csv", dataset.exclusions,
              ["season", "fixture_id", "table", "reason", "details"])
    write_csv(folder / "input_manifest.csv", dataset.sources)
    summary, team_summary = describe(dataset.matches)
    write_csv(folder / "season_summary.csv", summary)
    write_csv(folder / "team_summary.csv", team_summary)
    code = []
    for path in sorted(Path(__file__).parent.glob("*.py")):
        code.append({"path": str(path.resolve()), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    write_csv(folder / "code_manifest.csv", code)
    settings = []
    for key, value in vars(args).items():
        if isinstance(value, list):
            settings.extend({"setting": key, "index": i, "value": item} for i, item in enumerate(value))
        else:
            settings.append({"setting": key, "index": "", "value": value if value is not None else ""})
    settings.extend([
        {"setting": "result_availability_assumption", "index": "", "value": "later of kickoff plus 3 hours and valid second-half period end, where available"},
        {"setting": "brier_normalization", "index": "", "value": "sum of three squared outcome errors (range 0 to 2)"},
        {"setting": "history_limitation", "index": "", "value": "Reconstructed from present exports; past publication times and schedule revisions not archived."},
        {"setting": "python", "index": "", "value": sys.version.split()[0]},
    ])
    for package in ("numpy", "scipy"):
        try:
            version = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            version = "not installed"
        settings.append({"setting": package, "index": "", "value": version})
    write_csv(folder / "run_settings.csv", settings, ["setting", "index", "value"])


def ensure_backtest_ready(dataset, seasons):
    if not seasons or len(seasons) < 5:
        raise ValueError("Backtest requires at least five explicitly selected completed seasons via --seasons.")
    ordered = sorted(seasons)
    if len(set(ordered)) != len(ordered) or any(int(b[:4]) != int(a[:4]) + 1 for a, b in zip(ordered, ordered[1:])):
        raise ValueError("Backtest seasons must be unique and consecutive; missing years cannot silently be bridged.")
    coverage = {row["season"]: row for row in dataset.coverage}
    for season in ordered:
        row = coverage.get(season, {})
        if not all(row.get(key) for key in ("export_complete", "snapshot_stable", "schedule_complete", "season_finished")):
            raise ValueError(f"{season} is not ready: needs a stable completed export, complete schedule, and finished season. See coverage_report.csv.")
        if not row.get("valid_completed_matches"):
            raise ValueError(f"{season} has no valid completed matches.")
    # Structural errors must be corrected rather than treated as an outcome-dependent sample filter.
    # "reviewed_provider_error" covers fixtures listed in REVIEWED_BAD_FIXTURES,
    # each inspected against the raw capture. New structural errors still block.
    acceptable = {"unsupported_state", "awarded_result", "abandoned_result", "cancelled_result",
                  "reviewed_provider_error"}
    unexpected = [row for row in dataset.exclusions if row.get("reason") not in acceptable]
    if unexpected:
        raise ValueError("Data quality exclusions require review before backtesting; see excluded_fixtures.csv.")
    return ordered


def ensure_selection_precedes_test(matches, validation_season, test_season, cutoff_hours):
    validation = [m for m in matches if m.season == validation_season and m.outcome]
    test = [m for m in matches if m.season == test_season and m.outcome]
    if not validation or not test:
        raise ValueError("Validation and test seasons must both contain valid results.")
    first_test_cutoff = min(m.kickoff for m in test) - timedelta(hours=cutoff_hours)
    if max(m.available_at for m in validation) >= first_test_cutoff:
        raise ValueError("Validation results overlap the first test cutoff (possibly a postponed fixture). Season labels alone cannot define this split.")


def feature_config(args):
    """One feature configuration for the whole run, from the command line."""
    from features import FeatureConfig
    return FeatureConfig.build(stats=args.stats, include_xg=not args.no_xg,
                               season_boost=args.season_boost)


def candidate_specs(args):
    candidates = [{"candidate": "frequency", "model": "frequency", "half_life_days": args.half_life_days}]
    for half_life in sorted(set(args.decay_candidates or [args.half_life_days])):
        for model in ("poisson", *(args.gbdt or ())):
            candidates.append({"candidate": f"{model}_hl{half_life:g}", "model": model, "half_life_days": half_life})
    tuned = load_gbdt_params(args.gbdt_params)
    return [{**spec, "ridge": args.ridge, "window_days": args.window_days,
             "gbdt_params_json": json.dumps(tuned[spec["model"]]) if spec["model"] in tuned else ""}
            for spec in candidates]


def load_gbdt_params(paths):
    """Tuned settings from a previous search, keyed by the model each file was tuned for.

    Several files may be given so more than one boosted candidate can carry its
    own tuned settings in the same comparison.
    """
    tuned = {}
    if paths is None and DEFAULT_GBDT_PARAMS.exists():
        paths = [DEFAULT_GBDT_PARAMS]
    for path in paths or ():
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
        model = payload.get("model")
        if not model:
            raise ValueError(f"{path} does not record which model it was tuned for.")
        if model in tuned:
            raise ValueError(f"Two parameter files were given for {model}.")
        tuned[model] = dict(payload.get("params") or {})
    return tuned


def evaluate_row(match, cutoff, fitted, prediction, candidate, phase, version, generated_at):
    probabilities = [prediction.home_probability, prediction.draw_probability, prediction.away_probability]
    if any(not math.isfinite(p) or p < 0 or p > 1 for p in probabilities) or abs(sum(probabilities) - 1) > 1e-9:
        raise ValueError(f"Invalid probabilities for {match.fixture_id}.")
    row = {
        "fixture_id": match.fixture_id, "season": match.season, "kickoff_utc": stamp(match.kickoff),
        "information_cutoff_utc": stamp(cutoff), "generated_at_utc": stamp(generated_at),
        "phase": phase, "candidate": candidate, "model": fitted.model, "model_version": version,
        "home_team_id": match.home_team_id, "away_team_id": match.away_team_id,
        "home_team_name": match.home_team_name, "away_team_name": match.away_team_name,
        "home_expected_goals": prediction.home_expected_goals, "away_expected_goals": prediction.away_expected_goals,
        "rho": prediction.rho, "tail_mass": prediction.tail_mass, "training_matches": fitted.training_count,
        "effective_matches": fitted.effective_matches,
        "training_latest_available_at_utc": stamp(fitted.training_latest_available_at),
        "optimizer_at_parameter_bounds": fitted.at_parameter_bounds,
        "optimizer_message": fitted.optimizer_message,
    }
    for outcome, probability in zip(OUTCOMES, probabilities):
        row[f"{outcome}_probability"] = probability
        row[f"{outcome}_fair_odds"] = 1 / probability if probability else ""
    # The prediction has already been produced before its target outcome is attached.
    if match.outcome:
        actual = OUTCOMES.index(match.outcome)
        row.update(actual_outcome=match.outcome, home_goals=match.home_goals, away_goals=match.away_goals,
                   log_loss=-math.log(max(probabilities[actual], 1e-15)),
                   brier_score=sum((p - (i == actual)) ** 2 for i, p in enumerate(probabilities)),
                   correct=int(max(range(3), key=probabilities.__getitem__) == actual))
    return row


def rolling_predictions(history, targets, specs, args, phase, config=None):
    try:
        from models import fit_model, MODEL_VERSION
    except ImportError as exc:
        raise ValueError("Model fitting needs NumPy and SciPy. Install src/odds/requirements.txt with the Python used to run this command.") from exc
    rows = []
    grouped = defaultdict(list)
    for target in targets:
        grouped[target.kickoff - timedelta(hours=args.cutoff_hours)].append(target)
    for index, (cutoff, games) in enumerate(sorted(grouped.items()), 1):
        training = [m for m in history if m.outcome and m.available_at < cutoff
                    and (cutoff - m.kickoff).total_seconds() <= args.window_days * 86400]
        if len(training) < args.min_train_matches:
            raise ValueError(f"Only {len(training)} training matches at {stamp(cutoff)}; requires {args.min_train_matches}. No targets silently skipped.")
        for spec in specs:
            tuned = json.loads(spec["gbdt_params_json"]) if spec.get("gbdt_params_json") else None
            fitted = fit_model(training, cutoff, model=spec["model"], half_life_days=spec["half_life_days"],
                               ridge=spec["ridge"], window_days=spec["window_days"],
                               cutoff_hours=args.cutoff_hours, gbdt_params=tuned,
                               feature_config=config)
            if not fitted.converged or fitted.training_latest_available_at >= cutoff:
                raise ValueError("Model convergence or chronological cutoff check failed.")
            generated_at = datetime.now(timezone.utc)
            for match in games:
                prediction = fitted.predict(match.home_team_id, match.away_team_id,
                                            neutral=match.neutral, season=match.season)
                rows.append(evaluate_row(match, cutoff, fitted, prediction, spec["candidate"], phase, MODEL_VERSION, generated_at))
        if index == 1 or index % 20 == 0 or index == len(grouped):
            print(f"{phase}: {index}/{len(grouped)} prediction cutoffs", flush=True)
    return rows


def metrics(rows):
    grouped = defaultdict(list)
    for row in rows:
        grouped[(row["phase"], row["season"], row["candidate"])].append(row)
    return [{"phase": phase, "season": season, "candidate": candidate, "matches": len(games),
             "log_loss": sum(float(r["log_loss"]) for r in games) / len(games),
             "brier_score": sum(float(r["brier_score"]) for r in games) / len(games),
             "accuracy": sum(int(r["correct"]) for r in games) / len(games)}
            for (phase, season, candidate), games in sorted(grouped.items())]


def calibration(rows):
    grouped = defaultdict(list)
    for row in rows:
        for outcome in OUTCOMES:
            p = row[f"{outcome}_probability"]
            bin_id = min(9, int(p * 10))
            grouped[(row["phase"], row["season"], row["candidate"], outcome, bin_id)].append((p, row["actual_outcome"] == outcome))
    return [{"phase": phase, "season": season, "candidate": candidate, "outcome": outcome,
             "bin_lower": bin_id / 10, "bin_upper": (bin_id + 1) / 10, "matches": len(values),
             "mean_probability": sum(p for p, _ in values) / len(values),
             "observed_share": sum(actual for _, actual in values) / len(values)}
            for (phase, season, candidate, outcome, bin_id), values in sorted(grouped.items())]


def paired_comparison(rows, selected):
    """Paired, non-overlapping weekly block bootstrap; descriptive uncertainty."""
    import random
    by_fixture = defaultdict(dict)
    for row in rows:
        if row["phase"] == "test":
            by_fixture[row["fixture_id"]][row["candidate"]] = row
    if selected == "frequency":
        return []
    blocks = defaultdict(list)
    for pair in by_fixture.values():
        if selected not in pair or "frequency" not in pair:
            raise ValueError("Paired comparison requires identical evaluated fixtures.")
        chosen, baseline = pair[selected], pair["frequency"]
        week = datetime.fromisoformat(chosen["kickoff_utc"]).date().toordinal() // 7
        blocks[week].append((chosen["log_loss"] - baseline["log_loss"], chosen["brier_score"] - baseline["brier_score"]))
    values = list(blocks.values())
    if not values:
        return []
    rng = random.Random(600)
    samples = [[], []]
    for _ in range(1000):
        draw = [value for _ in values for value in rng.choice(values)]
        for metric in range(2):
            samples[metric].append(sum(value[metric] for value in draw) / len(draw))
    all_values = [value for block in values for value in block]
    return [{"candidate": selected, "baseline": "frequency", "metric": name,
             "matches": len(all_values), "week_blocks": len(values), "bootstrap_repetitions": 1000,
             "mean_difference": sum(value[i] for value in all_values) / len(all_values),
             "percentile_2_5": sorted(samples[i])[24], "percentile_97_5": sorted(samples[i])[974],
             "interpretation": "negative favors selected model; approximate weekly block interval"}
            for i, name in enumerate(("log_loss", "brier_score"))]


def _folds(count, total, minimum_train):
    """Expanding-window chronological folds over an ordered record list."""
    if total <= minimum_train + count:
        raise ValueError(f"Only {total} feature rows; not enough for {count} folds "
                         f"after a {minimum_train}-row initial window.")
    step = (total - minimum_train) // count
    if step < 30:
        raise ValueError(f"Fold size would be {step} rows; use fewer folds or more seasons.")
    for index in range(count):
        train_end = minimum_train + index * step
        yield train_end, (train_end + step if index < count - 1 else total)


def _fold_log_loss(probabilities, labels):
    return sum(-math.log(max(float(row[label]), 1e-15))
               for row, label in zip(probabilities, labels)) / len(labels)


def _suggest(trial):
    """Ranges kept conservative: each fold trains on well under a thousand rows."""
    return {
        "max_depth": trial.suggest_int("max_depth", 2, 5),
        "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.2, log=True),
        "n_estimators": trial.suggest_int("n_estimators", 100, 600, step=50),
        "min_child_weight": trial.suggest_float("min_child_weight", 1.0, 30.0, log=True),
        "subsample": trial.suggest_float("subsample", 0.6, 1.0),
        "colsample_bytree": trial.suggest_float("colsample_bytree", 0.5, 1.0),
        "reg_lambda": trial.suggest_float("reg_lambda", 0.1, 30.0, log=True),
        "reg_alpha": trial.suggest_float("reg_alpha", 1e-3, 5.0, log=True),
        "gamma": trial.suggest_float("gamma", 1e-3, 5.0, log=True),
    }


def tune_xgboost(matches, as_of, args, folder, config=None):
    """Search hyperparameters on chronological folds inside ``matches``.

    Called before forecasting, on results already available at the first cutoff,
    so the search cannot see anything the forecast could not. Folds evaluate
    only on rows later than the ones they trained on. Features do not depend on
    hyperparameters, so the replay is computed once and reused by every trial.
    """
    import optuna
    import numpy as np
    from features import coverage, replay
    from models import _make_classifier

    config = config or feature_config(args)
    records, _ = replay(matches, cutoff_hours=args.cutoff_hours,
                        half_life_days=args.half_life_days, config=config)
    records.sort(key=lambda record: record[0])
    x = np.asarray([record[1] for record in records], dtype=float)
    y = np.asarray([record[2] for record in records], dtype=int)
    names = config.names
    write_csv(folder / "feature_coverage.csv", coverage(x.tolist(), names))
    split = list(_folds(args.tune_folds, len(records), args.min_tune_rows))
    print(f"Tuning on {len(records)} feature rows, {len(names)} inputs "
          f"({config.describe()}), {len(split)} folds, {args.trials} trials...", flush=True)

    def objective(trial):
        params = _suggest(trial)
        scores = []
        for train_end, validate_end in split:
            if len(set(y[:train_end].tolist())) != len(OUTCOMES):
                raise optuna.TrialPruned()
            classifier = _make_classifier("xgboost", params)
            classifier.fit(x[:train_end], y[:train_end])
            raw = classifier.predict_proba(x[train_end:validate_end])
            ordered = np.zeros_like(raw)
            for position, label in enumerate(classifier.classes_):
                ordered[:, int(label)] = raw[:, position]
            scores.append(_fold_log_loss(ordered, y[train_end:validate_end]))
        return sum(scores) / len(scores)

    optuna.logging.set_verbosity(optuna.logging.WARNING)
    study = optuna.create_study(direction="minimize",
                                sampler=optuna.samplers.TPESampler(seed=args.seed))
    study.optimize(objective, n_trials=args.trials, timeout=args.tune_timeout)
    write_csv(folder / "tuning_trials.csv",
              [{"number": t.number, "value": t.value, **t.params}
               for t in study.trials if t.value is not None])
    write_csv(folder / "tuned_params.csv", [{
        "model": "xgboost", "feature_rows": len(records), "features": len(names),
        "stats": config.stats, "expected_goals": config.include_xg,
        "season_boost": config.season_boost, "folds": len(split),
        "trials": len(study.trials), "best_fold_log_loss": study.best_value,
        "tuned_as_of_utc": stamp(as_of), **study.best_params}])
    print(f"Best mean fold log loss {study.best_value:.5f}", flush=True)
    return dict(study.best_params), {
        "x": x, "y": y, "splits": split, "make_classifier": _make_classifier,
        "numpy": np, "trials": [t.value for t in study.trials],
        "best_value": study.best_value, "names": names, "config": config,
    }


def write_diagnostics(folder, search, tuned, completed, args):
    """Overfitting report: fold gaps, a learning curve and a recent holdout."""
    import diagnostics
    from models import fit_model
    params = tuned["xgboost"]
    print("Measuring fold gaps, learning curve and recent holdout...", flush=True)
    config = search.get("config")
    fold = diagnostics.fold_report(search["x"], search["y"], params, search["splits"],
                                   search["make_classifier"], search["numpy"])
    importance = diagnostics.importance_report(
        search["x"], search["y"], params, search.get("names", ()),
        search["make_classifier"], search["numpy"])
    holdout = diagnostics.holdout_report(completed, args, fit_model, tuned, config=config)
    rows, curve, holdout_rows, importance_rows = diagnostics.render(
        folder, fold=fold, holdout=holdout, trials=search["trials"],
        best_value=search["best_value"], params=params, importance=importance,
        inputs=config.describe() if config else "",
        generated=stamp(datetime.now(timezone.utc)))
    write_csv(folder / "fold_gaps.csv", rows)
    write_csv(folder / "learning_curve.csv", curve)
    if holdout_rows:
        write_csv(folder / "holdout_scores.csv", holdout_rows)
    if importance_rows:
        write_csv(folder / "feature_importance.csv", importance_rows)
    gap = sum(r["gap"] for r in rows) / len(rows)
    print(f"Mean train/out-of-fold gap {gap:+.4f}; see diagnostics.html", flush=True)
    if importance:
        print(f"{importance['unused']} of {importance['features']} inputs were never "
              f"split on; see feature_importance.csv", flush=True)


def upcoming(dataset, args):
    """Unplayed fixtures selected by matchweek and/or kickoff window.

    ``--round next`` resolves to the matchweek containing the earliest unplayed
    fixture, so the same command works every week without editing.
    """
    targets = [m for m in dataset.matches if not m.outcome and m.state == "NS"]
    if args.round == "next":
        after = args.from_date or datetime.now(timezone.utc)
        future = [m for m in targets if m.kickoff >= after]
        if not future:
            raise ValueError("No unplayed fixtures remain. Download the current season first.")
        chosen = min(future, key=lambda m: m.kickoff).round_name
        if not chosen:
            raise ValueError("The next fixture carries no matchweek label; use --from-date/--to-date.")
        targets = [m for m in targets if str(m.round_name) == str(chosen)]
        print(f"Next unplayed matchweek: {chosen}")
    elif args.round:
        targets = [m for m in targets if str(m.round_name) == str(args.round)]
    if args.from_date:
        targets = [m for m in targets if m.kickoff >= args.from_date]
    if args.to_date:
        targets = [m for m in targets if m.kickoff <= args.to_date]
    return sorted(targets, key=lambda m: (m.kickoff, m.fixture_id))


def forecast(dataset, args, folder):
    """Predict unplayed fixtures. No outcome exists yet, so nothing is scored.

    Each fixture is fitted at its own cutoff from results available by then. A
    cutoff in the future means the fit currently uses every completed result;
    re-running after more matches finish will change the numbers.
    """
    try:
        from models import fit_model, MODEL_VERSION
    except ImportError as exc:
        raise ValueError("Model fitting needs NumPy and SciPy. Install src/odds/requirements.txt.") from exc
    targets = upcoming(dataset, args)
    if not targets:
        raise ValueError("No unplayed fixtures matched. Check --round, --from-date and --to-date "
                         "against the season schedule, and that the season is downloaded.")
    completed = [m for m in dataset.matches if m.outcome]
    now = datetime.now(timezone.utc)
    first_cutoff = min(t.kickoff for t in targets) - timedelta(hours=args.cutoff_hours)
    all_tuned = load_gbdt_params(args.gbdt_params)
    config = feature_config(args)
    search = None
    if "xgboost" in args.model and not args.no_tune:
        # Tune on results already available at the first cutoff, so the search
        # sees nothing the forecast itself could not.
        history = [m for m in completed if m.available_at < first_cutoff]
        all_tuned["xgboost"], search = tune_xgboost(history, first_cutoff, args, folder,
                                                    config=config)
    specs = [{"candidate": f"{model}_hl{args.half_life_days:g}", "model": model,
              "half_life_days": args.half_life_days, "ridge": args.ridge,
              "window_days": args.window_days, "stats": config.stats,
              "expected_goals": config.include_xg, "season_boost": config.season_boost,
              "features": len(config.names) if model in ("xgboost",) else 0,
              "gbdt_params_json": json.dumps(all_tuned[model]) if model in all_tuned else ""}
             for model in args.model]
    write_csv(folder / "candidates.csv", specs)
    grouped = defaultdict(list)
    for target in targets:
        grouped[target.kickoff - timedelta(hours=args.cutoff_hours)].append(target)
    rows = []
    for cutoff, games in sorted(grouped.items()):
        training = [m for m in completed if m.available_at < cutoff
                    and (cutoff - m.kickoff).total_seconds() <= args.window_days * 86400]
        if len(training) < args.min_train_matches:
            raise ValueError(f"Only {len(training)} training matches at {stamp(cutoff)}; requires {args.min_train_matches}.")
        for spec in specs:
            tuned = json.loads(spec["gbdt_params_json"]) if spec["gbdt_params_json"] else None
            fitted = fit_model(training, cutoff, model=spec["model"],
                               half_life_days=spec["half_life_days"], ridge=spec["ridge"],
                               window_days=spec["window_days"], cutoff_hours=args.cutoff_hours,
                               gbdt_params=tuned, feature_config=config)
            if not fitted.converged or fitted.training_latest_available_at >= cutoff:
                raise ValueError("Model convergence or chronological cutoff check failed.")
            generated_at = datetime.now(timezone.utc)
            for match in games:
                prediction = fitted.predict(match.home_team_id, match.away_team_id,
                                            neutral=match.neutral, season=match.season)
                row = evaluate_row(match, cutoff, fitted, prediction, spec["candidate"],
                                   "forecast", MODEL_VERSION, generated_at)
                row["round"] = match.round_name
                row["cutoff_in_future"] = cutoff > now
                rows.append(row)
    columns = PREDICTION_COLUMNS + ["round", "cutoff_in_future"]
    write_csv(folder / "predictions.csv", rows, columns)
    # Stable path for anything downstream; overwritten by each forecast.
    LATEST_PREDICTIONS.parent.mkdir(parents=True, exist_ok=True)
    write_csv(LATEST_PREDICTIONS, rows, columns)
    if search and not args.no_diagnostics:
        write_diagnostics(folder, search, all_tuned, completed, args)
    status(folder, "complete",
           "Forecast written for unplayed fixtures. Research only: these probabilities are not "
           "validated for betting and no market comparison was made.",
           models=" ".join(spec["candidate"] for spec in specs),
           fixtures=len(rows), matchweek=targets[0].round_name,
           training_matches=len(completed))
    print(f"Matchweek {targets[0].round_name}: {len(targets)} fixtures x {len(specs)} models "
          f"= {len(rows)} rows, from {len(completed)} completed matches.")
    print(f"Latest forecast: {LATEST_PREDICTIONS}")


def backtest(dataset, args, folder):
    seasons = ensure_backtest_ready(dataset, args.seasons)
    valid = [m for m in dataset.matches if m.outcome]
    validation_season, test_season = seasons[-2:]
    ensure_selection_precedes_test(valid, validation_season, test_season, args.cutoff_hours)
    config = feature_config(args)
    specs = candidate_specs(args)
    write_csv(folder / "candidates.csv", specs)
    split_rows = [{"season": season, "role": "validation" if season == validation_season else
                  "test" if season == test_season else "initial_training"} for season in seasons]
    write_csv(folder / "season_roles.csv", split_rows)
    validation = rolling_predictions(valid, [m for m in valid if m.season == validation_season],
                                     specs, args, "validation", config=config)
    if not validation:
        raise ValueError("No validation fixtures available.")
    write_csv(folder / "validation_predictions.csv", validation, PREDICTION_COLUMNS)
    validation_metrics = metrics(validation)
    write_csv(folder / "validation_metrics.csv", validation_metrics, METRIC_COLUMNS)
    best = min(validation_metrics, key=lambda row: (row["log_loss"], row["candidate"]))["candidate"]
    chosen = next(spec for spec in specs if spec["candidate"] == best)
    write_csv(folder / "selected_model.csv", [{**chosen, "validation_season": validation_season,
                                               "held_out_season": test_season, "cutoff_hours": args.cutoff_hours,
                                               "selected_using": "validation log loss only"}])
    print(f"Selected on {validation_season}: {best}; now evaluating held-out {test_season}.", flush=True)
    test_specs = [chosen] if best == "frequency" else [specs[0], chosen]
    test = rolling_predictions(valid, [m for m in valid if m.season == test_season],
                               test_specs, args, "test", config=config)
    if not test:
        raise ValueError("No held-out fixtures available.")
    combined = validation + test
    write_csv(folder / "backtest_predictions.csv", combined, PREDICTION_COLUMNS)
    write_csv(folder / "model_metrics.csv", metrics(combined), METRIC_COLUMNS)
    write_csv(folder / "calibration.csv", calibration(combined))
    write_csv(folder / "paired_comparison.csv", paired_comparison(test, best),
              ["candidate", "baseline", "metric", "matches", "week_blocks", "bootstrap_repetitions",
               "mean_difference", "percentile_2_5", "percentile_97_5", "interpretation"])
    status(folder, "complete", "Validation selection and held-out rolling evaluation complete; research only.", selected=best)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("coverage", "backtest", "predict"))
    parser.add_argument("--seasons", nargs="+", type=season_name,
                        help="Season folders; coverage discovers all if omitted. Backtest requires five or more consecutive finished seasons.")
    parser.add_argument("--input-root", type=Path, default=INPUT)
    parser.add_argument("--output-root", type=Path, default=RUNS,
                        help="Run directories. Must stay under data/temp/odds.")
    parser.add_argument("--league-id", default="600")
    parser.add_argument("--cutoff-hours", type=positive, default=24.0)
    parser.add_argument("--window-days", type=positive, default=1095.0)
    parser.add_argument("--half-life-days", type=positive, default=365.0)
    parser.add_argument("--decay-candidates", nargs="+", type=positive,
                        default=list(DEFAULT_DECAY_CANDIDATES),
                        help="backtest only: half-lives to compare on the validation season. "
                             "A shorter half-life favours recent form but shrinks the "
                             "effective sample; this grid lets the data choose.")
    parser.add_argument("--stats", choices=("none", "core", "all"), default="all",
                        help="Match statistics folded into the boosted model as decayed "
                             "per-match rates: none reproduces the goals-only feature set, "
                             "core keeps shots, shots on target, dangerous attacks and "
                             "possession, all uses every reliably reported metric.")
    parser.add_argument("--no-xg", action="store_true",
                        help="Drop expected goals. Sportmonks began publishing it part way "
                             "through 2023/24, so it is absent for the oldest rows in a "
                             "three-season window; use this to check that the gap is not "
                             "being read as a signal.")
    parser.add_argument("--season-boost", type=positive, default=1.0,
                        help="Extra weight on matches from the target fixture's own season, "
                             "on top of the half-life decay. 1.0 leaves the smooth decay "
                             "alone; 2.0 counts a current-season match twice.")
    parser.add_argument("--ridge", type=positive, default=5.0)
    parser.add_argument("--trials", type=positive_integer, default=100,
                        help="predict only: Optuna trials per run. XGBoost is re-tuned "
                             "before every forecast.")
    parser.add_argument("--no-diagnostics", action="store_true",
                        help="predict only: skip the overfitting report.")
    parser.add_argument("--no-tune", action="store_true",
                        help="predict only: skip the search and use xgboost_params.json.")
    parser.add_argument("--tune-folds", type=positive_integer, default=4)
    parser.add_argument("--min-tune-rows", type=positive_integer, default=400)
    parser.add_argument("--tune-timeout", type=positive, help="Optional seconds cap on the search.")
    parser.add_argument("--seed", type=int, default=600)
    parser.add_argument("--gbdt", nargs="+", choices=("xgboost",),
                        help="backtest only: add the boosted candidate. Tuned settings from "
                             "xgboost_params.json are applied automatically.")
    parser.add_argument("--min-train-matches", type=positive_integer, default=200)
    parser.add_argument("--model", nargs="+", default=["poisson", "xgboost"],
                        choices=("poisson", "xgboost"),
                        help="predict only: models to forecast with. Both by default, so the two "
                             "can be compared side by side each week.")
    parser.add_argument("--gbdt-params", dest="gbdt_params", nargs="+",
                        help="One or more saved parameter files. Each is applied "
                             "to the model it was tuned for, so several tuned candidates can "
                             "compete in the same run.")
    parser.add_argument("--round", default="next",
                        help='predict only: matchweek label, or "next" (the default) for the '
                             'matchweek holding the earliest unplayed fixture.')
    parser.add_argument("--from-date", type=kickoff_bound, dest="from_date",
                        help="predict only: earliest kickoff, YYYY-MM-DD.")
    parser.add_argument("--to-date", type=kickoff_bound, dest="to_date",
                        help="predict only: latest kickoff, YYYY-MM-DD.")
    args = parser.parse_args(argv)
    output_root = args.output_root.resolve()
    if not output_root.is_relative_to(SCRATCH.resolve()):
        parser.error("Run output must be within data/temp/odds; provider and published files "
                     "cannot be destinations.")
    if args.seasons and len(args.seasons) != len(set(args.seasons)):
        parser.error("Each season must appear exactly once.")
    folder = output_root / f"{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}_{args.command}_{uuid.uuid4().hex[:8]}"
    folder.mkdir(parents=True, exist_ok=False)
    print(f"Research output: {folder}", flush=True)
    status(folder, "running", "Reading completed season snapshots.")
    try:
        dataset = load_seasons(args.input_root.resolve(), args.seasons, league_id=args.league_id)
        record_inputs(folder, dataset, args)
        if args.command == "backtest":
            backtest(dataset, args, folder)
        elif args.command == "predict":
            forecast(dataset, args, folder)
        else:
            count = sum(bool(m.outcome) for m in dataset.matches)
            status(folder, "complete", "Coverage audit and descriptive summaries complete; no probability model fitted.", valid_completed_matches=count)
            print(f"Audited {len(dataset.coverage)} seasons; {count} valid completed matches.")
            for row in dataset.coverage:
                print(f"  {row['season']}: export={row.get('export_status')}, played={row.get('valid_completed_matches', 0)}, season_finished={row.get('season_finished', False)}")
        print(f"Saved CSV reports: {folder}")
        return 0
    except (ValueError, RuntimeError, OSError, ArithmeticError) as exc:
        status(folder, "blocked", str(exc))
        print(f"Stopped: {exc}\nRead coverage_report.csv and run_status.csv in {folder}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
