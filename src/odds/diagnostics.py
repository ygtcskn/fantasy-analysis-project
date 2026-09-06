"""Overfitting diagnostics written beside every forecast.

A forecast cannot be scored: the matches have not been played. So these
diagnostics answer the question that *can* be answered before kickoff - is the
model learning the league, or learning its own training set?

Six views, each attacking that from a different angle:

  1. Search history. If the best trial sits far below the rest of the cloud,
     the search found a lucky fold split rather than a better model.
  2. Train against out-of-fold loss, per fold. The gap between them is the
     overfitting measure. A model that fits its training rows far better than
     the rows that follow them is memorising.
  3. Learning curve over tree count. Out-of-fold loss that falls, flattens and
     then rises names the point where extra trees started hurting.
  4. Gain importance. How much each input actually reduced loss when the trees
     split on it. Inputs near zero are carrying no weight and are candidates for
     removal, which matters most when the feature set is wide.
  5. SHAP. Gain says which inputs the trees used; SHAP says which way each input
     pushed each prediction, and by how much. The beeswarm shows whether a high
     value of an input raises or lowers the home-win probability, and whether
     the relationship holds across matches or is driven by a few rows.
  6. Reliability on a recent holdout. Both models are refitted with the most
     recent completed matches withheld, then scored on them. This is the only
     view here backed by real outcomes, and it refreshes every week.

Charts are hand-written SVG and SHAP values come from XGBoost's own exact
TreeSHAP, so the pipeline keeps its four dependencies.
"""
from __future__ import annotations

import html
import math
from datetime import timedelta

PALETTE = {
    "train": "#c0562f",
    "validate": "#2f6f8f",
    "poisson": "#2f6f8f",
    "xgboost": "#c0562f",
    "ideal": "#9aa39c",
    "grid": "#dfe3dd",
    "axis": "#6c766f",
    "ink": "#1d2621",
    "low": "#3b6ea5",
    "high": "#c0562f",
    "missing": "#b9bfb6",
}
OUTCOMES = ("home", "draw", "away")
TOP_FEATURES = 20
BEESWARM_FEATURES = 14


# ----------------------------------------------------------------- svg helpers

def _scale(value, low, high, start, end):
    if high == low:
        return (start + end) / 2
    return start + (value - low) / (high - low) * (end - start)


def _axes(width, height, pad, x_range, y_range, x_label, y_label, ticks=5, x_ticks=True):
    x0, x1 = x_range
    y0, y1 = y_range
    parts = [f'<rect x="0" y="0" width="{width}" height="{height}" fill="#ffffff"/>']
    for index in range(ticks + 1):
        value = y0 + (y1 - y0) * index / ticks
        y = _scale(value, y0, y1, height - pad, pad)
        parts.append(f'<line x1="{pad}" y1="{y:.1f}" x2="{width - pad / 2}" y2="{y:.1f}" '
                     f'stroke="{PALETTE["grid"]}" stroke-width="1"/>')
        parts.append(f'<text x="{pad - 6}" y="{y + 4:.1f}" text-anchor="end" font-size="11" '
                     f'fill="{PALETTE["axis"]}">{value:.3f}</text>')
    if x_ticks:
        for index in range(ticks + 1):
            value = x0 + (x1 - x0) * index / ticks
            x = _scale(value, x0, x1, pad, width - pad / 2)
            parts.append(f'<text x="{x:.1f}" y="{height - pad + 18}" text-anchor="middle" '
                         f'font-size="11" fill="{PALETTE["axis"]}">{value:g}</text>')
    parts.append(f'<line x1="{pad}" y1="{height - pad}" x2="{width - pad / 2}" y2="{height - pad}" '
                 f'stroke="{PALETTE["axis"]}" stroke-width="1"/>')
    parts.append(f'<text x="{width / 2}" y="{height - 6}" text-anchor="middle" font-size="12" '
                 f'fill="{PALETTE["axis"]}">{html.escape(x_label)}</text>')
    parts.append(f'<text x="14" y="{height / 2}" text-anchor="middle" font-size="12" '
                 f'fill="{PALETTE["axis"]}" transform="rotate(-90 14 {height / 2})">'
                 f'{html.escape(y_label)}</text>')
    return parts


def _legend(entries, x, y):
    parts = []
    for index, (label, colour) in enumerate(entries):
        top = y + index * 18
        parts.append(f'<rect x="{x}" y="{top}" width="11" height="11" rx="2" fill="{colour}"/>')
        parts.append(f'<text x="{x + 17}" y="{top + 10}" font-size="12" fill="{PALETTE["ink"]}">'
                     f'{html.escape(label)}</text>')
    return parts


def _svg(width, height, body):
    return (f'<svg viewBox="0 0 {width} {height}" width="100%" height="auto" '
            f'xmlns="http://www.w3.org/2000/svg" role="img">' + "".join(body) + "</svg>")


def scatter_history(values, best_so_far, width=620, height=280):
    """Optuna trial values with the running best."""
    if not values:
        return "<p>No completed trials.</p>"
    pad = 52
    finite = [v for v in values if math.isfinite(v)]
    low, high = min(finite), max(finite)
    span = (high - low) or 0.01
    low, high = low - span * 0.08, high + span * 0.08
    parts = _axes(width, height, pad, (0, len(values)), (low, high), "trial", "mean fold log loss")
    for index, value in enumerate(values):
        x = _scale(index, 0, len(values), pad, width - pad / 2)
        y = _scale(value, low, high, height - pad, pad)
        parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="2.6" fill="{PALETTE["validate"]}" '
                     f'fill-opacity="0.45"/>')
    points = " ".join(
        f'{_scale(i, 0, len(values), pad, width - pad / 2):.1f},'
        f'{_scale(v, low, high, height - pad, pad):.1f}'
        for i, v in enumerate(best_so_far))
    parts.append(f'<polyline points="{points}" fill="none" stroke="{PALETTE["train"]}" '
                 f'stroke-width="2"/>')
    parts += _legend([("trial", PALETTE["validate"]), ("best so far", PALETTE["train"])],
                     width - 150, pad)
    return _svg(width, height, parts)


def grouped_bars(labels, train, validate, width=620, height=280):
    """Train against out-of-fold loss for each fold."""
    pad = 52
    high = max(max(train), max(validate)) * 1.15
    parts = _axes(width, height, pad, (0, len(labels)), (0, high), "fold", "log loss",
                  x_ticks=False)
    slot = (width - pad * 1.5) / max(1, len(labels))
    for index, label in enumerate(labels):
        left = pad + index * slot
        for offset, (value, colour) in enumerate(((train[index], PALETTE["train"]),
                                                  (validate[index], PALETTE["validate"]))):
            bar = slot * 0.3
            x = left + slot * 0.1 + offset * bar
            y = _scale(value, 0, high, height - pad, pad)
            parts.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{bar - 3:.1f}" '
                         f'height="{height - pad - y:.1f}" fill="{colour}" rx="2"/>')
        parts.append(f'<text x="{left + slot / 2:.1f}" y="{height - pad + 18}" '
                     f'text-anchor="middle" font-size="11" fill="{PALETTE["axis"]}">{label}</text>')
    parts += _legend([("train", PALETTE["train"]), ("out of fold", PALETTE["validate"])],
                     width - 150, pad)
    return _svg(width, height, parts)


def learning_curve(trees, train, validate, width=620, height=280):
    pad = 52
    low = min(min(train), min(validate)) * 0.97
    high = max(max(train), max(validate)) * 1.03
    parts = _axes(width, height, pad, (min(trees), max(trees)), (low, high),
                  "trees", "log loss")
    for series, colour in ((train, PALETTE["train"]), (validate, PALETTE["validate"])):
        points = " ".join(
            f'{_scale(t, min(trees), max(trees), pad, width - pad / 2):.1f},'
            f'{_scale(v, low, high, height - pad, pad):.1f}'
            for t, v in zip(trees, series))
        parts.append(f'<polyline points="{points}" fill="none" stroke="{colour}" stroke-width="2"/>')
    best = min(range(len(validate)), key=validate.__getitem__)
    x = _scale(trees[best], min(trees), max(trees), pad, width - pad / 2)
    parts.append(f'<line x1="{x:.1f}" y1="{pad}" x2="{x:.1f}" y2="{height - pad}" '
                 f'stroke="{PALETTE["ink"]}" stroke-width="1" stroke-dasharray="4 3"/>')
    parts.append(f'<text x="{x + 5:.1f}" y="{pad + 12}" font-size="11" fill="{PALETTE["ink"]}">'
                 f'best {trees[best]}</text>')
    parts += _legend([("train", PALETTE["train"]), ("out of fold", PALETTE["validate"])],
                     width - 150, pad)
    return _svg(width, height, parts)


def reliability(series, width=620, height=300):
    """Predicted against observed frequency, one line per model."""
    pad = 52
    parts = _axes(width, height, pad, (0, 1), (0, 1), "predicted probability",
                  "observed frequency")
    parts.append(f'<line x1="{_scale(0, 0, 1, pad, width - pad / 2):.1f}" '
                 f'y1="{_scale(0, 0, 1, height - pad, pad):.1f}" '
                 f'x2="{_scale(1, 0, 1, pad, width - pad / 2):.1f}" '
                 f'y2="{_scale(1, 0, 1, height - pad, pad):.1f}" '
                 f'stroke="{PALETTE["ideal"]}" stroke-width="1" stroke-dasharray="5 4"/>')
    for name, points in series.items():
        if not points:
            continue
        colour = PALETTE.get(name, PALETTE["validate"])
        path = " ".join(f'{_scale(p, 0, 1, pad, width - pad / 2):.1f},'
                        f'{_scale(o, 0, 1, height - pad, pad):.1f}' for p, o, _ in points)
        parts.append(f'<polyline points="{path}" fill="none" stroke="{colour}" stroke-width="2"/>')
        for p, o, count in points:
            x = _scale(p, 0, 1, pad, width - pad / 2)
            y = _scale(o, 0, 1, height - pad, pad)
            radius = 2.5 + min(6.0, math.sqrt(count))
            parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{radius:.1f}" fill="{colour}" '
                         f'fill-opacity="0.55"><title>{count} matches</title></circle>')
    parts += _legend([(name, PALETTE.get(name, PALETTE["validate"])) for name in series],
                     width - 150, pad)
    return _svg(width, height, parts)


def horizontal_bars(labels, values, colour, x_label, width=620, row_height=19):
    """Ranked bars, longest first. Used for gain and for mean absolute SHAP."""
    if not labels:
        return "<p>No importance available.</p>"
    left, right, top, bottom = 236, 26, 10, 32
    height = top + bottom + row_height * len(labels)
    high = max(values) or 1.0
    parts = [f'<rect x="0" y="0" width="{width}" height="{height}" fill="#ffffff"/>']
    for index in range(5):
        x = left + (width - left - right) * index / 4
        parts.append(f'<line x1="{x:.1f}" y1="{top}" x2="{x:.1f}" y2="{height - bottom}" '
                     f'stroke="{PALETTE["grid"]}" stroke-width="1"/>')
        parts.append(f'<text x="{x:.1f}" y="{height - bottom + 15}" text-anchor="middle" '
                     f'font-size="10.5" fill="{PALETTE["axis"]}">{high * index / 4:.3g}</text>')
    for index, (label, value) in enumerate(zip(labels, values)):
        y = top + index * row_height
        length = (width - left - right) * (value / high)
        parts.append(f'<rect x="{left}" y="{y + 3:.1f}" width="{max(0.6, length):.1f}" '
                     f'height="{row_height - 7}" fill="{colour}" rx="2"/>')
        parts.append(f'<text x="{left - 8}" y="{y + row_height - 6:.1f}" text-anchor="end" '
                     f'font-size="11" fill="{PALETTE["ink"]}">{html.escape(label)}</text>')
    parts.append(f'<text x="{(left + width) / 2:.1f}" y="{height - 4}" text-anchor="middle" '
                 f'font-size="11.5" fill="{PALETTE["axis"]}">{html.escape(x_label)}</text>')
    return _svg(width, height, parts)


def _blend(fraction):
    """Low-to-high colour ramp for a feature value, as used by SHAP plots."""
    low = (0x3b, 0x6e, 0xa5)
    high = (0xc0, 0x56, 0x2f)
    channels = tuple(round(a + (b - a) * fraction) for a, b in zip(low, high))
    return "#%02x%02x%02x" % channels


def beeswarm(labels, shap_columns, value_columns, width=620, row_height=26):
    """One row per input: dots are matches, placed by SHAP, coloured by value.

    Colour is the feature's rank among the matches shown, so it reads the same
    whether an input is a count, a percentage or a rating. Grey dots are matches
    where the input was missing.
    """
    if not labels:
        return "<p>No SHAP values available.</p>"
    left, right, top, bottom = 236, 26, 14, 40
    height = top + bottom + row_height * len(labels)
    span = max((abs(v) for column in shap_columns for v in column), default=0.0) or 0.01
    span *= 1.08
    zero = _scale(0.0, -span, span, left, width - right)
    parts = [f'<rect x="0" y="0" width="{width}" height="{height}" fill="#ffffff"/>']
    for index in range(5):
        value = -span + 2 * span * index / 4
        x = _scale(value, -span, span, left, width - right)
        parts.append(f'<line x1="{x:.1f}" y1="{top}" x2="{x:.1f}" y2="{height - bottom}" '
                     f'stroke="{PALETTE["grid"]}" stroke-width="1"/>')
        parts.append(f'<text x="{x:.1f}" y="{height - bottom + 15}" text-anchor="middle" '
                     f'font-size="10.5" fill="{PALETTE["axis"]}">{value:+.2f}</text>')
    parts.append(f'<line x1="{zero:.1f}" y1="{top}" x2="{zero:.1f}" y2="{height - bottom}" '
                 f'stroke="{PALETTE["axis"]}" stroke-width="1"/>')
    for index, label in enumerate(labels):
        centre = top + index * row_height + row_height / 2
        shap_column = shap_columns[index]
        values = value_columns[index]
        present = sorted(v for v in values if v == v)
        for position, (contribution, value) in enumerate(zip(shap_column, values)):
            x = _scale(contribution, -span, span, left, width - right)
            # Deterministic vertical spread; a hash would reorder between runs.
            offset = ((position * 7919) % 101 / 100.0 - 0.5) * (row_height - 11)
            if value != value or len(present) < 2:
                colour, opacity = PALETTE["missing"], 0.5
            else:
                rank = sum(1 for v in present if v < value) / (len(present) - 1)
                colour, opacity = _blend(min(1.0, max(0.0, rank))), 0.62
            parts.append(f'<circle cx="{x:.1f}" cy="{centre + offset:.1f}" r="2.1" '
                         f'fill="{colour}" fill-opacity="{opacity}"/>')
        parts.append(f'<text x="{left - 8}" y="{centre + 4:.1f}" text-anchor="end" '
                     f'font-size="11" fill="{PALETTE["ink"]}">{html.escape(label)}</text>')
    parts.append(f'<text x="{(left + width) / 2:.1f}" y="{height - 6}" text-anchor="middle" '
                 f'font-size="11.5" fill="{PALETTE["axis"]}">'
                 f'SHAP value for the home-win class (log odds)</text>')
    parts.append(f'<text x="{width - right}" y="{top + 9}" text-anchor="end" font-size="10.5" '
                 f'fill="{PALETTE["axis"]}">'
                 f'<tspan fill="{PALETTE["low"]}">low</tspan> to '
                 f'<tspan fill="{PALETTE["high"]}">high</tspan> input value</text>')
    return _svg(width, height, parts)


# ------------------------------------------------------------------ measurement

def log_loss(probabilities, labels):
    return sum(-math.log(max(float(row[label]), 1e-15))
               for row, label in zip(probabilities, labels)) / len(labels)


def _ordered(classifier, matrix, numpy):
    raw = classifier.predict_proba(matrix)
    ordered = numpy.zeros_like(raw)
    for position, label in enumerate(classifier.classes_):
        ordered[:, int(label)] = raw[:, position]
    return ordered


def fold_report(x, y, params, splits, make_classifier, numpy):
    """Train and out-of-fold loss per fold, plus a learning curve on the last fold."""
    labels, train_scores, validate_scores = [], [], []
    for index, (train_end, validate_end) in enumerate(splits, 1):
        classifier = make_classifier("xgboost", params)
        classifier.fit(x[:train_end], y[:train_end])
        train_scores.append(log_loss(_ordered(classifier, x[:train_end], numpy), y[:train_end]))
        validate_scores.append(log_loss(
            _ordered(classifier, x[train_end:validate_end], numpy), y[train_end:validate_end]))
        labels.append(f"{index}")
    train_end, validate_end = splits[-1]
    classifier = make_classifier("xgboost", params)
    classifier.fit(x[:train_end], y[:train_end])
    total = int(params.get("n_estimators", 200))
    # Tenths of the fitted tree count. iteration_range cannot exceed the rounds
    # actually boosted, so the last step is the full model.
    steps = sorted({max(10, int(total * fraction / 10)) for fraction in range(1, 11)})
    curve_train, curve_validate = [], []
    for trees in steps:
        raw_train = classifier.predict_proba(x[:train_end], iteration_range=(0, trees))
        raw_validate = classifier.predict_proba(x[train_end:validate_end], iteration_range=(0, trees))
        for raw, target, sink in ((raw_train, y[:train_end], curve_train),
                                  (raw_validate, y[train_end:validate_end], curve_validate)):
            ordered = numpy.zeros_like(raw)
            for position, label in enumerate(classifier.classes_):
                ordered[:, int(label)] = raw[:, position]
            sink.append(log_loss(ordered, target))
    return {"labels": labels, "train": train_scores, "validate": validate_scores,
            "trees": steps, "curve_train": curve_train, "curve_validate": curve_validate}


def importance_report(x, y, params, feature_names, make_classifier, numpy,
                      beeswarm_rows=250):
    """Gain importance and exact TreeSHAP for the model as finally fitted.

    Both are descriptions of one fitted model, not evidence that an input
    generalises: a feature can earn gain by fitting noise. Read them next to the
    fold gaps above, and treat a wide feature set with many near-zero rows as a
    reason to narrow it.

    SHAP comes from XGBoost's own ``pred_contribs``, which is exact for trees,
    so no extra dependency is needed. Contributions are in log odds and the last
    column returned is the bias, which is dropped here.
    """
    try:
        import xgboost
    except ImportError:
        return None
    classifier = make_classifier("xgboost", params)
    classifier.fit(x, y)
    booster = classifier.get_booster()
    count = x.shape[1]
    names = list(feature_names) if len(feature_names) == count else [f"f{i}" for i in range(count)]

    scores = booster.get_score(importance_type="gain")
    gain = [0.0] * count
    for key, value in scores.items():
        index = int(key[1:]) if key.startswith("f") and key[1:].isdigit() else None
        if index is None and key in names:
            index = names.index(key)
        if index is not None and 0 <= index < count:
            gain[index] = float(value)
    total_gain = sum(gain) or 1.0

    contributions = booster.predict(xgboost.DMatrix(x, missing=numpy.nan), pred_contribs=True)
    contributions = numpy.asarray(contributions)
    if contributions.ndim == 2:  # binary or single output
        contributions = contributions.reshape(contributions.shape[0], 1, -1)
    contributions = contributions[:, :, :count]
    per_class = numpy.abs(contributions).mean(axis=0)          # (classes, features)
    overall = per_class.mean(axis=0)                            # (features,)

    rows = []
    for index, name in enumerate(names):
        row = {"feature": name, "gain": gain[index], "gain_share": gain[index] / total_gain,
               "mean_abs_shap": float(overall[index]), "used_by_trees": gain[index] > 0.0}
        for position, outcome in enumerate(OUTCOMES[:per_class.shape[0]]):
            row[f"mean_abs_shap_{outcome}"] = float(per_class[position][index])
        rows.append(row)
    rows.sort(key=lambda item: (-item["mean_abs_shap"], item["feature"]))

    by_gain = sorted(rows, key=lambda item: (-item["gain"], item["feature"]))[:TOP_FEATURES]
    by_shap = rows[:TOP_FEATURES]
    swarm = rows[:BEESWARM_FEATURES]
    # Most recent rows: the ordering is chronological, and a full training set
    # would render tens of thousands of circles.
    start = max(0, x.shape[0] - int(beeswarm_rows))
    swarm_indexes = [names.index(item["feature"]) for item in swarm]
    swarm_shap = [[float(v) for v in contributions[start:, 0, index]] for index in swarm_indexes]
    swarm_values = [[float(v) for v in x[start:, index]] for index in swarm_indexes]
    unused = sum(1 for row in rows if not row["used_by_trees"])
    return {"rows": rows, "features": count, "unused": unused,
            "gain_labels": [item["feature"] for item in by_gain],
            "gain_values": [item["gain_share"] for item in by_gain],
            "shap_labels": [item["feature"] for item in by_shap],
            "shap_values": [item["mean_abs_shap"] for item in by_shap],
            "swarm_labels": [item["feature"] for item in swarm],
            "swarm_shap": swarm_shap, "swarm_values": swarm_values,
            "swarm_matches": x.shape[0] - start}


def holdout_report(completed, args, fit_model, tuned, config=None, holdout=60):
    """Refit both models with the most recent results withheld, then score them.

    A fixed-origin holdout: every withheld match is predicted from data
    available before the earliest of their cutoffs, so nothing leaks backwards.
    """
    ordered_matches = sorted(completed, key=lambda m: m.kickoff)
    if len(ordered_matches) < holdout + args.min_train_matches:
        return None
    target = ordered_matches[-holdout:]
    cutoff = min(m.kickoff for m in target) - timedelta(hours=args.cutoff_hours)
    training = [m for m in ordered_matches if m.available_at < cutoff
                and (cutoff - m.kickoff).total_seconds() <= args.window_days * 86400]
    if len(training) < args.min_train_matches:
        return None
    report = {"cutoff": cutoff, "matches": len(target), "training": len(training), "models": {}}
    for name in args.model:
        fitted = fit_model(training, cutoff, model=name, half_life_days=args.half_life_days,
                           ridge=args.ridge, window_days=args.window_days,
                           cutoff_hours=args.cutoff_hours,
                           gbdt_params=tuned.get(name) if name == "xgboost" else None,
                           feature_config=config)
        rows = []
        for match in target:
            prediction = fitted.predict(match.home_team_id, match.away_team_id,
                                        neutral=match.neutral, season=match.season)
            rows.append(([prediction.home_probability, prediction.draw_probability,
                          prediction.away_probability], OUTCOMES.index(match.outcome)))
        loss = sum(-math.log(max(p[k], 1e-15)) for p, k in rows) / len(rows)
        brier = sum(sum((v - (i == k)) ** 2 for i, v in enumerate(p)) for p, k in rows) / len(rows)
        bins = {}
        for probabilities, actual in rows:
            for index, probability in enumerate(probabilities):
                slot = min(9, int(probability * 10))
                hit, total, mass = bins.get(slot, (0, 0, 0.0))
                bins[slot] = (hit + (index == actual), total + 1, mass + probability)
        points = [(mass / total, hit / total, total)
                  for slot, (hit, total, mass) in sorted(bins.items()) if total >= 5]
        report["models"][name] = {"log_loss": loss, "brier": brier, "points": points,
                                  "rows": len(rows)}
    return report


# --------------------------------------------------------------------- assembly

def _section(title, note, chart):
    return (f'<section><h2>{html.escape(title)}</h2><p>{note}</p>'
            f'<div class="chart">{chart}</div></section>')


def render(folder, *, fold, holdout, trials, best_value, params, generated,
           importance=None, inputs=""):
    """Write diagnostics.html plus the numbers behind each chart."""
    values = [t for t in trials if t is not None and math.isfinite(t)]
    running, best = [], float("inf")
    for value in values:
        best = min(best, value)
        running.append(best)

    gaps = [v - t for t, v in zip(fold["train"], fold["validate"])]
    mean_gap = sum(gaps) / len(gaps)
    curve_best = fold["trees"][min(range(len(fold["curve_validate"])),
                                   key=fold["curve_validate"].__getitem__)]
    verdict = ("The out-of-fold loss is close to the training loss, so the search is not "
               "memorising its training rows."
               if mean_gap < 0.15 else
               "Out-of-fold loss sits well above training loss. The model fits its training "
               "rows far better than the rows that follow them, which is the signature of "
               "overfitting; consider fewer trees or a larger minimum leaf size.")

    sections = [
        _section("Search history",
                 "Each dot is one Optuna trial; the line is the best score so far. A best "
                 "trial far below the cloud is a lucky fold split rather than a better model.",
                 scatter_history(values, running)),
        _section("Train against out-of-fold loss",
                 f"Mean gap {mean_gap:+.4f}. {verdict}",
                 grouped_bars(fold["labels"], fold["train"], fold["validate"])),
        _section("Learning curve",
                 f"Out-of-fold loss is lowest at about {curve_best} trees. Where the line turns "
                 f"upward, extra trees are fitting noise. The chosen setting is "
                 f"{params.get('n_estimators', 'n/a')}.",
                 learning_curve(fold["trees"], fold["curve_train"], fold["curve_validate"])),
    ]
    if importance:
        idle = importance["unused"]
        share = sum(importance["gain_values"][:10])
        sections.append(_section(
            "Which inputs the trees used",
            f"Gain is the loss reduction each input bought when a tree split on it, as a share "
            f"of the total. The top ten inputs account for {share * 100:.0f}% of it, and "
            f"{idle} of {importance['features']} inputs were never split on at all. An input "
            f"with no gain costs nothing but adds a chance for the search to fit noise, so a "
            f"long idle tail is a reason to narrow the feature set.",
            horizontal_bars(importance["gain_labels"], importance["gain_values"],
                            PALETTE["train"], "share of total gain")))
        sections.append(_section(
            "SHAP: how much each input moved a prediction",
            "Mean absolute SHAP value, averaged over the three outcomes and every training "
            "row, in log odds. Gain says how often an input was useful to a split; this says "
            "how far it actually moved predictions. The two disagreeing is normal - a rarely "
            "used input can still swing the matches it applies to.",
            horizontal_bars(importance["shap_labels"], importance["shap_values"],
                            PALETTE["validate"], "mean |SHAP| (log odds)")))
        sections.append(_section(
            "SHAP: which direction, and how consistently",
            f"One dot per match, for the {importance['swarm_matches']} most recent training "
            f"rows. Position is the input's contribution to the home-win log odds for that "
            f"match; colour is the input's own value, low to high. A clean colour split either "
            f"side of zero is a consistent effect. Colours mixed across the line mean the "
            f"effect depends on the rest of the match, and a tight cluster at zero with a few "
            f"far-out dots means the input matters only in rare situations.",
            beeswarm(importance["swarm_labels"], importance["swarm_shap"],
                     importance["swarm_values"])))
    if holdout:
        summary = " &middot; ".join(
            f"<b>{html.escape(name)}</b> log loss {values['log_loss']:.4f}, "
            f"Brier {values['brier']:.4f}"
            for name, values in holdout["models"].items())
        sections.append(_section(
            "Reliability on the most recent results",
            f"Both models refitted with the last {holdout['matches']} completed matches "
            f"withheld, trained on {holdout['training']}. Points on the dashed line are "
            f"perfectly calibrated; above it the model is under-confident, below it "
            f"over-confident. Marker size is the number of matches in the bin. {summary}.",
            reliability({name: values["points"] for name, values in holdout["models"].items()})))

    body = "".join(sections)
    inputs_note = f" &middot; {html.escape(inputs)}" if inputs else ""
    document = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Odds diagnostics</title>
<style>
 body{{margin:0;background:#f6f7f1;color:{PALETTE['ink']};
      font:15px/1.55 Inter,"Segoe UI",Arial,sans-serif}}
 main{{max-width:760px;margin:0 auto;padding:36px 24px 64px}}
 h1{{font-size:26px;margin:0 0 6px}}
 h2{{font-size:17px;margin:0 0 6px}}
 .lede{{color:#5d675f;margin:0 0 30px}}
 section{{background:#fff;border:1px solid #dfe3dd;border-radius:10px;
          padding:18px 20px;margin-bottom:18px}}
 section p{{color:#5d675f;font-size:13.5px;margin:0 0 12px}}
 .chart{{overflow-x:auto}}
 code{{background:#eef2e8;padding:1px 5px;border-radius:4px;font-size:12.5px}}
</style></head><body><main>
<h1>Overfitting diagnostics</h1>
<p class="lede">Generated {html.escape(generated)} &middot; best mean fold log loss
 {best_value:.5f} over {len(values)} trials{inputs_note} &middot;
 <code>{html.escape(", ".join(f"{k}={v}" for k, v in sorted(params.items())))}</code></p>
{body}
</main></body></html>"""
    (folder / "diagnostics.html").write_text(document, encoding="utf-8")

    rows = [{"fold": label, "train_log_loss": t, "out_of_fold_log_loss": v, "gap": v - t}
            for label, t, v in zip(fold["labels"], fold["train"], fold["validate"])]
    curve = [{"trees": t, "train_log_loss": a, "out_of_fold_log_loss": b}
             for t, a, b in zip(fold["trees"], fold["curve_train"], fold["curve_validate"])]
    holdout_rows = []
    if holdout:
        for name, values in holdout["models"].items():
            holdout_rows.append({"model": name, "matches": values["rows"],
                                 "log_loss": values["log_loss"], "brier_score": values["brier"],
                                 "training_matches": holdout["training"]})
    return rows, curve, holdout_rows, (importance["rows"] if importance else [])
