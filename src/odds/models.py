"""Time-aware result-frequency, Poisson, and Dixon-Coles models.

No provider access or file writes occur here. Inputs are completed Match-like
objects; goals are regulation-time goals. A result is usable only when both its
kickoff and its ``available_at`` precede the requested prediction timestamp.

The goal models use log(rate) = baseline + attack - opponent defense, with an
additional home advantage for non-neutral matches. Attack and defense effects
are centered, with ridge shrinkage toward zero. Unknown teams receive zero
effects, i.e. the learned league-average prior.

Dixon-Coles source: Dixon and Coles (1997),
https://doi.org/10.1111/1467-9876.00065 . The four low-score corrections and
exponential recency weights follow that model. Ridge shrinkage and the safe rho
parameterization below are implementation choices, not claims from the paper.
The rho parameter is constrained using conservative worst-case rates over all
fitted teams plus the unknown-team prior, at either home or neutral venues.
This retains the ordinary log link and ensures valid future pairings without
clipping negative score probabilities. Numerical parameter bounds are deliberately
broad; ``at_parameter_bounds`` identifies a fit that reaches one.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import math
from numbers import Real
from typing import Any, Iterable

import numpy as np
from scipy.optimize import minimize
from scipy.special import expit, gammaln
from scipy.stats import poisson

from .features import DEFAULT_CONFIG, training_table


MODEL_VERSION = "odds-0.2.0"
# The only boosted candidate. LightGBM and scikit-learn's HistGradientBoosting
# were compared and dropped: both landed within 0.003 log loss of this one on
# validation, which is far inside the resolution of a 340-match season.
GBDT_MODELS = ("xgboost",)
GBDT_SEED = 600
TAIL_TOLERANCE = 1e-10
_RHO_MARGIN = 1.0 - 1e-7
_MAX_GRID_GOALS = 100_000


class ModelFitError(RuntimeError):
    """A model could not produce a finite, converged fit."""


@dataclass(frozen=True)
class Prediction:
    home_probability: float
    draw_probability: float
    away_probability: float
    home_expected_goals: float | None
    away_expected_goals: float | None
    rho: float | None
    tail_mass: float | None


def _utc(value: datetime, label: str) -> datetime:
    if not isinstance(value, datetime) or value.utcoffset() is None:
        raise ValueError(f"{label} must be a timezone-aware datetime")
    return value.astimezone(timezone.utc)


def _goals(value: Any, label: str) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, Real)
        or not math.isfinite(float(value))
        or value < 0
        or int(value) != value
    ):
        raise ValueError(f"{label} must be a finite, nonnegative integer")
    return int(value)


def _team_id(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Team IDs must be nonempty strings")
    return value


def _score_marginal(rate: float) -> tuple[np.ndarray, float]:
    # Both grids include 0 and 1, so all four DC changes are represented and
    # cancel exactly in the theoretical total included mass.
    upper = max(1, int(poisson.ppf(1.0 - TAIL_TOLERANCE / 4.0, rate)))
    if upper > _MAX_GRID_GOALS:
        raise ValueError("Goal rate requires an impractically large score grid")
    tail = float(poisson.sf(upper, rate))
    while tail > TAIL_TOLERANCE / 2.0:
        upper += 1
        if upper > _MAX_GRID_GOALS:
            raise ValueError("Goal rate requires an impractically large score grid")
        tail = float(poisson.sf(upper, rate))
    return poisson.pmf(np.arange(upper + 1), rate), tail


def score_probabilities(
    home_rate: float, away_rate: float, rho: float = 0.0
) -> Prediction:
    """Sum a dynamic score grid, checking DC validity and recording its tail.

    No probabilities are clipped. Nonfinite rates or a rho that makes any of
    the four corrected score probabilities negative raise an error. The tiny
    omitted rectangular-grid mass is recorded before normalization.
    """
    home_rate, away_rate, rho = float(home_rate), float(away_rate), float(rho)
    if not all(math.isfinite(v) for v in (home_rate, away_rate, rho)):
        raise ValueError("Goal rates and rho must be finite")
    if home_rate < 0 or away_rate < 0:
        raise ValueError("Goal rates must be nonnegative")
    if max(home_rate, away_rate) > _MAX_GRID_GOALS:
        raise ValueError("Goal rate requires an impractically large score grid")
    corrections = (
        1.0 - home_rate * away_rate * rho,
        1.0 + home_rate * rho,
        1.0 + away_rate * rho,
        1.0 - rho,
    )
    if not all(math.isfinite(t) and t >= 0.0 for t in corrections):
        raise ValueError("rho creates an invalid Dixon-Coles score distribution")

    hp, ht = _score_marginal(home_rate)
    ap, at = _score_marginal(away_rate)
    # Cumulative sums give the same rectangular-grid sums as an outer product,
    # using linear memory rather than allocating every score combination.
    hc, ac = np.cumsum(hp), np.cumsum(ap)
    home = float(np.dot(hp[1:], ac[np.minimum(np.arange(len(hp) - 1), len(ap) - 1)]))
    away = float(np.dot(ap[1:], hc[np.minimum(np.arange(len(ap) - 1), len(hp) - 1)]))
    common = min(len(hp), len(ap))
    draw = float(np.dot(hp[:common], ap[:common]))
    adjustment = home_rate * away_rate * rho * math.exp(-home_rate - away_rate)
    home += adjustment
    away += adjustment
    draw -= 2.0 * adjustment
    probabilities = np.array([home, draw, away], dtype=float)
    if not np.all(np.isfinite(probabilities)) or np.any(probabilities < 0.0):
        raise ArithmeticError("Invalid outcome probabilities after score-grid summation")
    tail = ht + at - ht * at
    total = float(probabilities.sum())
    if total <= 0 or abs(total - (1.0 - tail)) > 1e-9:
        raise ArithmeticError("Score-grid mass does not match its calculated tail")
    probabilities /= total
    return Prediction(
        *map(float, probabilities), home_rate, away_rate, rho, tail
    )


@dataclass
class FittedModel:
    model: str
    training_count: int
    effective_matches: float
    training_latest_available_at: datetime
    team_strengths: dict[str, dict[str, float | int]]
    converged: bool = True
    baseline: float | None = None
    home_advantage: float | None = None
    rho: float | None = None
    frequency_probabilities: tuple[float, float, float] | None = None
    at_parameter_bounds: bool = False
    optimizer_message: str = ""
    model_version: str = MODEL_VERSION
    classifier: Any = None
    feature_state: Any = None
    feature_kickoff: datetime | None = None
    feature_names: tuple[str, ...] = ()
    feature_season: str = ""

    def predict(self, home_id: str, away_id: str, neutral: bool = False,
                season: str | None = None) -> Prediction:
        home_id, away_id = _team_id(home_id), _team_id(away_id)
        if home_id == away_id:
            raise ValueError("A team cannot play itself")
        if self.model in GBDT_MODELS:
            if self.classifier is None or self.feature_state is None or self.feature_kickoff is None:
                raise ModelFitError("Gradient-boosted fit is missing its classifier or feature state")
            vector = self.feature_state.features(
                home_id, away_id, self.feature_kickoff, neutral,
                self.feature_season if season is None else str(season))
            raw = self.classifier.predict_proba([vector])[0]
            ordered = [0.0, 0.0, 0.0]
            for position, label in enumerate(self.classifier.classes_):
                ordered[int(label)] = float(raw[position])
            total = sum(ordered)
            if not math.isfinite(total) or total <= 0:
                raise ModelFitError("Gradient-boosted model produced invalid probabilities")
            # Renormalise so the caller's sum-to-one check cannot fail on float error.
            hp, dp, ap = (value / total for value in ordered)
            return Prediction(hp, dp, ap, None, None, None, None)
        if self.model == "frequency":
            if self.frequency_probabilities is None:
                raise ModelFitError("Frequency fit is missing its probabilities")
            hp, dp, ap = self.frequency_probabilities
            if neutral:
                hp = ap = (hp + ap) / 2.0
            return Prediction(hp, dp, ap, None, None, None, None)
        if self.baseline is None or self.home_advantage is None or self.rho is None:
            raise ModelFitError("Goal-model fit is missing fitted parameters")
        home = self.team_strengths.get(home_id, {"attack": 0.0, "defense": 0.0})
        away = self.team_strengths.get(away_id, {"attack": 0.0, "defense": 0.0})
        home_rate = math.exp(
            self.baseline + (0.0 if neutral else self.home_advantage)
            + float(home["attack"]) - float(away["defense"])
        )
        away_rate = math.exp(
            self.baseline + float(away["attack"]) - float(home["defense"])
        )
        return score_probabilities(home_rate, away_rate, self.rho)


def _maximum_with_prior(values: np.ndarray) -> tuple[float, np.ndarray]:
    """Maximum including the zero-effect prior, with a symmetric subgradient."""
    maximum = max(0.0, float(values.max()))
    active = values == maximum
    denominator = int(active.sum()) + int(maximum == 0.0)
    return maximum, active.astype(float) / denominator


def _safe_rho(theta: np.ndarray, n: int) -> tuple[float, np.ndarray]:
    """A smooth interval map, except at ties in conservative rate extrema.

    For every supported pairing, lambda and mu are <= exp(max_rate_log), and
    lambda*mu <= exp(max_product_log). Therefore rho in
    (-1/max_rate, min(1, 1/max_product)) keeps every tau strictly positive.
    The extrema also include the zero-effect unknown-team prior and neutral
    venues. A tiny interior margin protects log(tau) from roundoff.
    """
    b, h = theta[:2]
    a = theta[2:2 + n] - theta[2:2 + n].mean()
    d = theta[2 + n:2 + 2 * n] - theta[2 + n:2 + 2 * n].mean()
    ma, da = _maximum_with_prior(a)
    md, dd = _maximum_with_prior(-d)
    mad, dad = _maximum_with_prior(a - d)
    hplus = max(0.0, float(h))
    dh = 1.0 if h > 0 else (0.0 if h < 0 else 0.5)
    rate_gradient = np.zeros_like(theta)
    rate_gradient[0:2] = (1.0, dh)
    rate_gradient[2:2 + n] = da - da.mean()
    rate_gradient[2 + n:2 + 2 * n] = -dd + dd.mean()
    product_gradient = np.zeros_like(theta)
    product_gradient[0:2] = (2.0, dh)
    product_gradient[2:2 + n] = 2.0 * (dad - dad.mean())
    product_gradient[2 + n:2 + 2 * n] = -2.0 * (dad - dad.mean())
    max_rate_log = b + hplus + ma + md
    max_product_log = 2.0 * b + hplus + 2.0 * mad
    low = -_RHO_MARGIN * math.exp(-max_rate_log)
    high = _RHO_MARGIN * math.exp(-max(0.0, max_product_log))
    low_gradient = -low * rate_gradient
    high_gradient = -high * product_gradient * (
        1.0 if max_product_log > 0 else (0.0 if max_product_log < 0 else 0.5)
    )
    fraction = float(expit(theta[-1]))
    rho = (1.0 - fraction) * low + fraction * high
    gradient = (1.0 - fraction) * low_gradient + fraction * high_gradient
    gradient[-1] = (high - low) * fraction * (1.0 - fraction)
    return rho, gradient


def _make_classifier(params: dict | None = None):
    """Build the classifier with conservative defaults for a small training set.

    The eligible pool is around a thousand matches, so shallow trees, few leaves
    and a large minimum leaf size matter more than capacity.
    """
    try:
        from xgboost import XGBClassifier
    except ImportError:
        raise ModelFitError(
            "Install the model dependencies with python -m pip install -r requirements.txt") from None
    settings = dict(objective="multi:softprob", n_estimators=200, learning_rate=0.05,
                    max_depth=3, min_child_weight=10, reg_lambda=5.0, subsample=0.9,
                    colsample_bytree=0.8, random_state=GBDT_SEED, n_jobs=1,
                    tree_method="hist", verbosity=0)
    settings.update(params or {})
    return XGBClassifier(**settings)


def _fit_gbdt(eligible, as_of: datetime, *, model: str, half_life_days: float,
              cutoff_hours: float, gbdt_params: dict | None = None,
              feature_config=None) -> FittedModel:
    """Replay features chronologically, then fit a three-class classifier.

    Training rows and the prediction state are both built by ``training_table``,
    which folds a source match in only once its result was available.
    """
    config = feature_config or DEFAULT_CONFIG
    rows, labels, weights, state = training_table(
        eligible, as_of, cutoff_hours=cutoff_hours, half_life_days=half_life_days,
        config=config)
    if len(rows) < 100:
        raise ModelFitError(
            f"Only {len(rows)} usable feature rows before the cutoff; a boosted model needs at least 100")
    if len(set(labels)) != 3:
        raise ModelFitError("Training window does not contain all three outcomes")
    if state.latest_available_at is None:
        raise ModelFitError("No source match was folded into the feature state")
    classifier = _make_classifier(gbdt_params)
    classifier.fit(np.asarray(rows, dtype=float), np.asarray(labels, dtype=int),
                   sample_weight=np.asarray(weights, dtype=float))
    return FittedModel(
        model=model, training_count=len(rows), effective_matches=float(sum(weights)),
        training_latest_available_at=state.latest_available_at,
        team_strengths=state.team_summary(), classifier=classifier,
        feature_state=state, feature_kickoff=as_of + timedelta(hours=cutoff_hours),
        feature_names=config.names, feature_season=state.latest_season)


def fit_model(
    matches: Iterable[Any],
    as_of: datetime,
    *,
    model: str = "poisson",
    half_life_days: float = 365.0,
    ridge: float = 5.0,
    window_days: float = 1095.0,
    cutoff_hours: float = 24.0,
    gbdt_params: dict | None = None,
    feature_config=None,
) -> FittedModel:
    """Fit exclusively from eligible completed results before ``as_of``.

    Each match supplies timezone-aware ``kickoff`` and ``available_at``, string
    ``home_team_id`` and ``away_team_id``, and regulation-time ``home_goals`` and
    ``away_goals``. ``neutral`` defaults to False. XGBoost also needs a unique
    ``fixture_id`` for chronological replay and can use ``season`` and
    ``team_stats`` keyed by team ID.

    Weights are 2**(-age_days/half_life_days), with age measured from kickoff.
    ``effective_matches`` is the sum of weights (not Kish effective sample size).
    ``ridge`` multiplies half the squared raw attack and defense coefficients;
    effects are centered in every rate calculation. The frequency model has
    one pseudo-observation in each of the three outcomes.
    """
    as_of = _utc(as_of, "as_of")
    if model not in {"frequency", "poisson", "dixon_coles", *GBDT_MODELS}:
        raise ValueError(f"Unknown model: {model}")
    if not math.isfinite(half_life_days) or half_life_days <= 0:
        raise ValueError("half_life_days must be finite and positive")
    if not math.isfinite(window_days) or window_days <= 0:
        raise ValueError("window_days must be finite and positive")
    if not math.isfinite(ridge) or ridge < 0:
        raise ValueError("ridge must be finite and nonnegative")

    rows: list[tuple[str, str, int, int, float, bool, datetime]] = []
    eligible: list[Any] = []
    for match in matches:
        kickoff = _utc(match.kickoff, "match kickoff")
        available_at = _utc(match.available_at, "match available_at")
        age_days = (as_of - kickoff).total_seconds() / 86400.0
        if available_at >= as_of or age_days <= 0.0 or age_days > window_days:
            continue
        if available_at < kickoff:
            raise ValueError("A completed result cannot be available before kickoff")
        home_id, away_id = _team_id(match.home_team_id), _team_id(match.away_team_id)
        if home_id == away_id:
            raise ValueError("A training fixture cannot have identical team IDs")
        eligible.append(match)
        rows.append((
            home_id, away_id, _goals(match.home_goals, "home_goals"),
            _goals(match.away_goals, "away_goals"),
            math.exp(-math.log(2.0) * age_days / half_life_days),
            bool(getattr(match, "neutral", False)), available_at,
        ))
    if not rows:
        raise ModelFitError("No eligible completed matches before the prediction cutoff")
    if model in GBDT_MODELS:
        return _fit_gbdt(eligible, as_of, model=model, half_life_days=half_life_days,
                         cutoff_hours=cutoff_hours, gbdt_params=gbdt_params,
                         feature_config=feature_config)
    weights = np.array([r[4] for r in rows])
    if float(weights.sum()) <= 0.0:
        raise ModelFitError("All training weights underflowed; increase half_life_days")
    team_ids = sorted({r[i] for r in rows for i in (0, 1)})
    index = {team_id: i for i, team_id in enumerate(team_ids)}
    n = len(team_ids)
    home = np.array([index[r[0]] for r in rows], dtype=int)
    away = np.array([index[r[1]] for r in rows], dtype=int)
    x = np.array([r[2] for r in rows], dtype=float)
    y = np.array([r[3] for r in rows], dtype=float)
    venue = np.array([not r[5] for r in rows], dtype=float)
    appearance_counts = np.bincount(home, minlength=n) + np.bincount(away, minlength=n)
    appearance_weights = (
        np.bincount(home, weights=weights, minlength=n)
        + np.bincount(away, weights=weights, minlength=n)
    )
    strengths = {
        team_id: {"attack": 0.0, "defense": 0.0,
                  "training_matches": int(appearance_counts[i]),
                  "effective_matches": float(appearance_weights[i])}
        for i, team_id in enumerate(team_ids)
    }
    common = dict(
        model=model, training_count=len(rows), effective_matches=float(weights.sum()),
        training_latest_available_at=max(r[6] for r in rows), team_strengths=strengths,
    )
    if model == "frequency":
        counts = np.array([
            weights[x > y].sum(), weights[x == y].sum(), weights[x < y].sum()
        ]) + 1.0
        return FittedModel(
            **common, frequency_probabilities=tuple(map(float, counts / counts.sum()))
        )

    dc = model == "dixon_coles"
    size = 2 + 2 * n + int(dc)
    initial = np.zeros(size)
    mean_away = max(0.05, float(np.average(y, weights=weights)))
    mean_home = max(0.05, float(np.average(x, weights=weights)))
    initial[0] = math.log(mean_away)
    initial[1] = math.log(mean_home / mean_away)
    if dc:
        # Start at rho=0, which is the independent Poisson model.
        low = -_RHO_MARGIN / max(mean_home, mean_away)
        high = _RHO_MARGIN / max(1.0, max(mean_home, mean_away) * mean_away)
        fraction = -low / (high - low)
        initial[-1] = math.log(fraction / (1.0 - fraction))
    constants = gammaln(x + 1.0) + gammaln(y + 1.0)
    m00, m01, m10, m11 = ((x == a) & (y == b) for a, b in ((0, 0), (0, 1), (1, 0), (1, 1)))

    def objective(theta: np.ndarray) -> tuple[float, np.ndarray]:
        raw_attack, raw_defense = theta[2:2 + n], theta[2 + n:2 + 2 * n]
        attack, defense = raw_attack - raw_attack.mean(), raw_defense - raw_defense.mean()
        log_h = theta[0] + theta[1] * venue + attack[home] - defense[away]
        log_a = theta[0] + attack[away] - defense[home]
        lam, mu = np.exp(log_h), np.exp(log_a)
        losses = lam - x * log_h + mu - y * log_a + constants
        gh, ga = weights * (lam - x), weights * (mu - y)
        rho_gradient = np.zeros_like(theta)
        rho_loss_gradient = 0.0
        if dc:
            rho, rho_gradient = _safe_rho(theta, n)
            tau = np.ones(len(rows))
            dl, dm, dr = np.zeros(len(rows)), np.zeros(len(rows)), np.zeros(len(rows))
            tau[m00] = 1.0 - lam[m00] * mu[m00] * rho
            dl[m00], dm[m00], dr[m00] = -mu[m00] * rho, -lam[m00] * rho, -lam[m00] * mu[m00]
            tau[m01], dl[m01], dr[m01] = 1.0 + lam[m01] * rho, rho, lam[m01]
            tau[m10], dm[m10], dr[m10] = 1.0 + mu[m10] * rho, rho, mu[m10]
            tau[m11], dr[m11] = 1.0 - rho, -1.0
            if not np.all(np.isfinite(tau)) or np.any(tau <= 0):
                raise ModelFitError("Invalid Dixon-Coles correction during optimization")
            losses -= np.log(tau)
            gh -= weights * dl * lam / tau
            ga -= weights * dm * mu / tau
            rho_loss_gradient = float(-np.sum(weights * dr / tau))
        gradient = np.zeros_like(theta)
        gradient[0], gradient[1] = gh.sum() + ga.sum(), np.dot(gh, venue)
        ag = np.bincount(home, weights=gh, minlength=n) + np.bincount(away, weights=ga, minlength=n)
        dg = -np.bincount(away, weights=gh, minlength=n) - np.bincount(home, weights=ga, minlength=n)
        gradient[2:2 + n] = ag - ag.mean() + ridge * raw_attack
        gradient[2 + n:2 + 2 * n] = dg - dg.mean() + ridge * raw_defense
        gradient += rho_loss_gradient * rho_gradient
        penalty = ridge / 2.0 * (np.dot(raw_attack, raw_attack) + np.dot(raw_defense, raw_defense))
        loss = float(np.dot(weights, losses) + penalty)
        if not math.isfinite(loss) or not np.all(np.isfinite(gradient)):
            raise ModelFitError("Nonfinite likelihood or gradient during optimization")
        return loss, gradient

    bounds = [(-6.0, 3.0), (-2.0, 2.0)] + [(-3.0, 3.0)] * (2 * n)
    if dc:
        bounds.append((-12.0, 12.0))
    initial = np.array([min(hi, max(lo, v)) for v, (lo, hi) in zip(initial, bounds)])
    result = minimize(
        objective, initial, method="L-BFGS-B", jac=True, bounds=bounds,
        options={"maxiter": 1500, "maxls": 50, "ftol": 1e-11, "gtol": 1e-6},
    )
    if not result.success or not np.isfinite(result.fun) or not np.all(np.isfinite(result.x)):
        raise ModelFitError(f"{model} optimization failed: {result.message}")
    theta = result.x
    attack = theta[2:2 + n] - theta[2:2 + n].mean()
    defense = theta[2 + n:2 + 2 * n] - theta[2 + n:2 + 2 * n].mean()
    for i, team_id in enumerate(team_ids):
        strengths[team_id]["attack"] = float(attack[i])
        strengths[team_id]["defense"] = float(defense[i])
    return FittedModel(
        **common, baseline=float(theta[0]), home_advantage=float(theta[1]),
        rho=float(_safe_rho(theta, n)[0]) if dc else 0.0,
        at_parameter_bounds=any(abs(v - lo) < 1e-5 or abs(v - hi) < 1e-5 for v, (lo, hi) in zip(theta, bounds)),
        optimizer_message=str(result.message),
    )
