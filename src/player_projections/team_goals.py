"""Team expected goals for a target round, preferring the odds model.

The projection module grew its own team attack/defence estimate: goals scored
relative to a home/away baseline, a 365-day half-life and an eight-match prior.
It works, but it has never been scored against anything, and `src/odds` already
computes the same quantity from a Poisson model that is refitted every week,
tuned on chronological folds and checked with fold gaps, a learning curve and a
recent holdout. Two models of one quantity, one of them measured.

So this reads the published odds forecast where it covers the round and hands
back its expected goals. The internal estimate stays as the fallback, because
the odds forecast is a separate command the user may not have run, and a
projection must not silently fail when it is missing.

Nothing here is trusted blindly. The odds rows must be for the same season, the
same fixtures, with the same kickoffs and the same teams on the same sides, and
the newest result they were fitted on must be strictly older than this
projection's information cutoff - otherwise the odds model saw a match the
projection is not allowed to use, and that would leak into every player.

The field that carries this is ``training_latest_available_at_utc``, not
``information_cutoff_utc``. The odds forecast nominates a cutoff 24 hours before
kickoff, which is usually still in the future when the forecast is made, and it
flags that with ``cutoff_in_future``. The nominal cutoff therefore says nothing
about what the fit actually consumed; the latest training timestamp does.
Partial coverage is refused outright rather than mixing two different team
models inside one round, which would make players from different fixtures
incomparable.
"""
from __future__ import annotations

import csv
import io
import math
from pathlib import Path

# Only the goal models publish expected goals; the boosted candidate leaves the
# columns empty because it predicts outcome classes directly.
GOAL_MODELS = ("poisson", "dixon_coles")
# The same guard rail the internal estimate uses, applied to any source.
MINIMUM_GOALS, MAXIMUM_GOALS = 0.25, 3.5
SOURCE_ODDS = "odds_model"
SOURCE_INTERNAL = "internal_history"


def _number(value):
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def load_odds_goals(path: Path, fixtures: list[dict], season: str, cutoff, utc) -> tuple[dict, str]:
    """Return ({fixture_id: (team_goals, opponent_goals)}, note).

    An empty mapping means the caller should use its own estimate; the note
    always says why, so a run can be audited without rerunning it.
    """
    path = Path(path)
    if not path.is_file():
        return {}, f"No odds forecast at {path.name}; used the internal team model."
    try:
        rows = list(csv.DictReader(io.StringIO(path.read_text(encoding="utf-8-sig"))))
    except (OSError, UnicodeError, csv.Error) as error:
        return {}, f"Odds forecast unreadable ({error}); used the internal team model."
    if not rows:
        return {}, "Odds forecast is empty; used the internal team model."

    candidates = sorted({row.get("candidate", "") for row in rows
                         if row.get("model") in GOAL_MODELS
                         and _number(row.get("home_expected_goals")) is not None})
    if not candidates:
        return {}, "Odds forecast has no goal-model rows; used the internal team model."
    if len(candidates) > 1:
        # Choosing between two fitted goal models here would be an unrecorded
        # modelling decision made by a loader.
        return {}, (f"Odds forecast contains several goal candidates ({', '.join(candidates)}); "
                    "used the internal team model.")
    chosen = candidates[0]

    wanted = {fixture["fixture_id"]: fixture for fixture in fixtures}
    selected: dict[str, dict] = {}
    for row in rows:
        if row.get("candidate") != chosen or row.get("fixture_id") not in wanted:
            continue
        if row["fixture_id"] in selected:
            return {}, "Odds forecast repeats a target fixture; used the internal team model."
        selected[row["fixture_id"]] = row
    missing = set(wanted) - set(selected)
    if missing:
        return {}, (f"Odds forecast covers {len(selected)} of {len(wanted)} target fixtures; "
                    "used the internal team model for the whole round.")

    goals: dict[str, tuple[float, float]] = {}
    for fixture_id, row in selected.items():
        fixture = wanted[fixture_id]
        if row.get("season") != season:
            return {}, "Odds forecast is for another season; used the internal team model."
        try:
            if utc(row["kickoff_utc"]) != fixture["kickoff"]:
                return {}, ("Odds forecast kickoff differs from the saved fixture; "
                            "used the internal team model.")
            trained_to = utc(row["training_latest_available_at_utc"])
        except (KeyError, ValueError):
            return {}, "Odds forecast has an unreadable timestamp; used the internal team model."
        if trained_to >= cutoff:
            # The odds fit consumed a result this projection may not see.
            return {}, ("Odds forecast was fitted on results newer than this projection's "
                        "information cutoff; used the internal team model.")
        if (row.get("home_team_id"), row.get("away_team_id")) != (fixture["home"], fixture["away"]):
            return {}, ("Odds forecast has different teams for a fixture; "
                        "used the internal team model.")
        home, away = _number(row.get("home_expected_goals")), _number(row.get("away_expected_goals"))
        if home is None or away is None or home <= 0 or away <= 0:
            return {}, "Odds forecast has missing or invalid expected goals; used the internal team model."
        goals[fixture_id] = (min(MAXIMUM_GOALS, max(MINIMUM_GOALS, home)),
                             min(MAXIMUM_GOALS, max(MINIMUM_GOALS, away)))
    return goals, (f"Team expected goals from the odds model ({chosen}), "
                   f"covering all {len(goals)} fixtures.")
