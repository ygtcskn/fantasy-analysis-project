"""Pre-match features for the gradient-boosted candidates.

The goal models need only team identity and goals. A gradient-boosted tree
needs engineered inputs, and that is where leakage normally enters, so the
construction rule here is deliberate and narrow:

  A source match may inform a target fixture only when its ``available_at`` is
  strictly earlier than the target's information cutoff.

Sources are therefore folded in ordered by ``available_at``, never by kickoff.
A match that kicked off earlier but finished after the target's cutoff is not
used. Building the training table replays the same rule chronologically, so a
training row sees exactly what a live prediction would have seen at its own
cutoff, and never its own result.

Match statistics enter the same way. A shot count belongs to a completed match,
so it is folded in with that match's result and never read for the fixture being
predicted. Every statistic becomes a time-decayed per-match rate, both for the
team and against it, on exactly the footing already used for goals.

Recency has two controls. ``half_life_days`` decays every past match smoothly.
``season_boost`` multiplies matches played in the target's own season, because a
league year is a discrete break - squads turn over in the summer - which a
smooth half-life cannot express on its own.

The eligible pool at any cutoff is at most a three-season window, roughly a
thousand matches, so a wide statistic set will fit noise readily. Which
statistics earn their place is a question for the diagnostics report, not an
assumption made here.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
import math

NAN = float("nan")
INFINITE = (float("inf"), float("-inf"))

BASE_FEATURE_NAMES = (
    "elo_difference",
    "home_elo",
    "away_elo",
    "home_points_per_match",
    "away_points_per_match",
    "home_goals_for_per_match",
    "home_goals_against_per_match",
    "away_goals_for_per_match",
    "away_goals_against_per_match",
    "home_rest_days",
    "away_rest_days",
    "neutral_venue",
)
# Retained for callers that only want the goal-and-schedule block.
FEATURE_NAMES = BASE_FEATURE_NAMES

ELO_START = 1500.0
ELO_K = 20.0
ELO_HOME_ADVANTAGE = 60.0
# Rest is capped so a summer break does not become an extreme numeric outlier.
MAX_REST_DAYS = 45.0
LEAGUE_GOALS_PER_MATCH = 1.35
LEAGUE_POINTS_PER_MATCH = 1.0

# (provider metric, feature slug, zero_sum). A zero_sum metric is a share of one
# match total, so the opponent's value carries no information the team's own
# value does not, and only the "for" rate is emitted.
CORE_METRICS = (
    ("SHOTS_TOTAL", "shots", False),
    ("SHOTS_ON_TARGET", "shots_on_target", False),
    ("DANGEROUS_ATTACKS", "dangerous_attacks", False),
    ("BALL_POSSESSION", "possession", True),
)
# Every statistic Sportmonks reports for essentially all Super Lig matches from
# 2021/22 onward. Metrics the provider stopped supplying (CHALLENGES, HEADERS,
# COUNTER_ATTACKS) or reports only sporadically (REDCARDS, PENALTIES, INJURIES,
# ASSISTS) are left out: a column present for one era and absent for the next
# teaches the model the calendar rather than the football.
ALL_METRICS = (
    ("SHOTS_TOTAL", "shots", False),
    ("SHOTS_ON_TARGET", "shots_on_target", False),
    ("SHOTS_INSIDEBOX", "shots_inside_box", False),
    ("SHOTS_OUTSIDEBOX", "shots_outside_box", False),
    ("SHOTS_BLOCKED", "shots_blocked", False),
    ("GOAL_ATTEMPTS", "goal_attempts", False),
    ("BALL_POSSESSION", "possession", True),
    ("ATTACKS", "attacks", False),
    ("DANGEROUS_ATTACKS", "dangerous_attacks", False),
    ("BALL_SAFE", "ball_safe", False),
    ("CORNERS", "corners", False),
    ("PASSES", "passes", False),
    ("SUCCESSFUL_PASSES", "successful_passes", False),
    ("SUCCESSFUL_PASSES_PERCENTAGE", "pass_accuracy", False),
    ("KEY_PASSES", "key_passes", False),
    ("TOTAL_CROSSES", "crosses", False),
    ("ACCURATE_CROSSES", "accurate_crosses", False),
    ("SUCCESSFUL_DRIBBLES", "dribbles", False),
    ("DRIBBLED_ATTEMPTS", "dribble_attempts", False),
    ("TACKLES", "tackles", False),
    ("INTERCEPTIONS", "interceptions", False),
    ("DUELS_WON", "duels_won", False),
    ("SUCCESSFUL_HEADERS", "headers_won", False),
    ("SAVES", "saves", False),
    ("FOULS", "fouls", False),
    ("OFFSIDES", "offsides", False),
    ("YELLOWCARDS", "yellow_cards", False),
    ("THROWINS", "throw_ins", False),
)
# Sportmonks began publishing expected goals part way through 2023/24, so this
# column is missing for the oldest rows in a three-season window. XGBoost routes
# missing values natively. EXPECTED_GOALS_AGAINST is not listed because the
# against side is already built from the opponent's own EXPECTED_GOALS.
XG_METRICS = (
    ("EXPECTED_GOALS", "xg", False),
)
STAT_SETS = {"none": (), "core": CORE_METRICS, "all": ALL_METRICS}


@dataclass(frozen=True)
class FeatureConfig:
    """Which statistics to build, and how hard to favour the current season."""

    metrics: tuple = ()
    season_boost: float = 1.0
    stats: str = "none"
    include_xg: bool = False

    @classmethod
    def build(cls, stats: str = "all", include_xg: bool = True,
              season_boost: float = 1.0) -> "FeatureConfig":
        if stats not in STAT_SETS:
            raise ValueError(f"Unknown statistic set: {stats}")
        if not math.isfinite(season_boost) or season_boost <= 0:
            raise ValueError("season_boost must be finite and positive")
        metrics = tuple(STAT_SETS[stats])
        use_xg = bool(include_xg) and stats != "none"
        if use_xg:
            metrics += XG_METRICS
        return cls(metrics, float(season_boost), stats, use_xg)

    @property
    def names(self) -> tuple[str, ...]:
        names = list(BASE_FEATURE_NAMES)
        for _name, slug, zero_sum in self.metrics:
            for side in ("home", "away"):
                names.append(f"{side}_{slug}_for_per_match")
                if not zero_sum:
                    names.append(f"{side}_{slug}_against_per_match")
        return tuple(names)

    def describe(self) -> str:
        return (f"stats={self.stats} xg={'on' if self.include_xg else 'off'} "
                f"season_boost={self.season_boost:g} features={len(self.names)}")


DEFAULT_CONFIG = FeatureConfig()


class _Accumulator:
    """Decayed running totals for one team in one season.

    Exponential decay compounds, so totals can be carried forward instead of
    re-summing a match list: scaling every stored total by
    ``2**(-elapsed/half_life)`` before adding an observation is identical to
    weighting each observation by its age at read time. Each statistic keeps its
    own weight total, so a match missing one metric does not distort that
    metric's mean, and a metric never seen at all stays undefined.
    """

    __slots__ = ("last", "weight", "points", "scored", "conceded",
                 "stat_sum", "stat_weight")

    def __init__(self, size: int) -> None:
        self.last: datetime | None = None
        self.weight = 0.0
        self.points = 0.0
        self.scored = 0.0
        self.conceded = 0.0
        self.stat_sum = [0.0] * size
        self.stat_weight = [0.0] * size

    def add(self, when: datetime, half_life: float, points: float,
            scored: float, conceded: float, values: list) -> None:
        entry = 1.0
        if self.last is None:
            self.last = when
        else:
            age = (when - self.last).total_seconds() / 86400.0
            if age > 0.0:
                factor = 2.0 ** (-age / half_life)
                self.weight *= factor
                self.points *= factor
                self.scored *= factor
                self.conceded *= factor
                for index in range(len(self.stat_sum)):
                    self.stat_sum[index] *= factor
                    self.stat_weight[index] *= factor
                self.last = when
            elif age < 0.0:
                # Folded out of kickoff order; age the observation instead.
                entry = 2.0 ** (age / half_life)
        self.weight += entry
        self.points += entry * points
        self.scored += entry * scored
        self.conceded += entry * conceded
        for index, value in enumerate(values):
            if value is None:
                continue
            self.stat_sum[index] += entry * value
            self.stat_weight[index] += entry

    def scale(self, when: datetime, half_life: float) -> float:
        if self.last is None:
            return 0.0
        age = (when - self.last).total_seconds() / 86400.0
        if age <= 0.0:
            return 1.0
        return 2.0 ** (-age / half_life)


@dataclass
class _TeamRecord:
    rating: float = ELO_START
    last_kickoff: datetime | None = None
    matches: int = 0
    seasons: dict = field(default_factory=dict)  # season -> _Accumulator


class LeagueState:
    """Team form and Elo ratings, advanced one completed match at a time."""

    def __init__(self, half_life_days: float = 365.0,
                 config: FeatureConfig | None = None) -> None:
        if not math.isfinite(half_life_days) or half_life_days <= 0:
            raise ValueError("half_life_days must be finite and positive")
        self.half_life_days = float(half_life_days)
        self.config = config or DEFAULT_CONFIG
        self.metrics = self.config.metrics
        self.slots = 2 * len(self.metrics)
        self.teams: dict[str, _TeamRecord] = defaultdict(_TeamRecord)
        self.folded = 0
        self.latest_available_at: datetime | None = None
        # Newest season folded in, used when a caller does not name the season
        # of the fixture being predicted.
        self.latest_season = ""

    # ---------------------------------------------------------------- folding

    def _observed(self, match, team_id: str, opponent_id: str) -> list:
        """This match's statistics for one team, ordered as ``self.metrics``.

        Interleaved for and against, so index ``2*i`` is the team's own value
        for metric ``i`` and ``2*i + 1`` is what its opponent recorded.
        """
        if not self.metrics:
            return []
        stats = getattr(match, "team_stats", None) or {}
        own = stats.get(str(team_id)) or {}
        other = stats.get(str(opponent_id)) or {}
        values: list = []
        for name, _slug, _zero_sum in self.metrics:
            values.append(own.get(name))
            values.append(other.get(name))
        return values

    def update(self, match) -> None:
        """Fold one completed match in. Call only after its features are read."""
        if match.home_goals is None or match.away_goals is None:
            return
        home, away = str(match.home_team_id), str(match.away_team_id)
        home_record, away_record = self.teams[home], self.teams[away]
        expected_home = 1.0 / (1.0 + 10.0 ** (
            (away_record.rating - home_record.rating
             - (0.0 if getattr(match, "neutral", False) else ELO_HOME_ADVANTAGE)) / 400.0))
        if match.home_goals > match.away_goals:
            score, home_points, away_points = 1.0, 3, 0
        elif match.home_goals < match.away_goals:
            score, home_points, away_points = 0.0, 0, 3
        else:
            score, home_points, away_points = 0.5, 1, 1
        margin = math.sqrt(max(1.0, abs(match.home_goals - match.away_goals)))
        change = ELO_K * margin * (score - expected_home)
        home_record.rating += change
        away_record.rating -= change
        season = str(getattr(match, "season", "") or "")
        for record, points, scored, conceded, team_id, opponent_id in (
                (home_record, home_points, match.home_goals, match.away_goals, home, away),
                (away_record, away_points, match.away_goals, match.home_goals, away, home)):
            accumulator = record.seasons.get(season)
            if accumulator is None:
                accumulator = record.seasons[season] = _Accumulator(self.slots)
            accumulator.add(match.kickoff, self.half_life_days, points, scored, conceded,
                            self._observed(match, team_id, opponent_id))
            record.last_kickoff = match.kickoff
            record.matches += 1
        self.folded += 1
        if season > self.latest_season:
            self.latest_season = season
        if self.latest_available_at is None or match.available_at > self.latest_available_at:
            self.latest_available_at = match.available_at

    # ---------------------------------------------------------------- reading

    def _form(self, team_id: str, kickoff: datetime, season: str):
        """Decayed points, goals and statistic rates, per match.

        Seasons are held apart so the target's own season can be given extra
        weight. Every accumulator is decayed to ``kickoff`` before being summed,
        which makes the result independent of when each was last written.
        """
        record = self.teams.get(team_id)
        if record is None or not record.seasons:
            return (LEAGUE_POINTS_PER_MATCH, LEAGUE_GOALS_PER_MATCH,
                    LEAGUE_GOALS_PER_MATCH, MAX_REST_DAYS, 0, [NAN] * self.slots)
        boost = self.config.season_boost
        weight = points = scored = conceded = 0.0
        stat_sum = [0.0] * self.slots
        stat_weight = [0.0] * self.slots
        for name, accumulator in record.seasons.items():
            factor = accumulator.scale(kickoff, self.half_life_days)
            if factor <= 0.0:
                continue
            if boost != 1.0 and name == season:
                factor *= boost
            weight += factor * accumulator.weight
            points += factor * accumulator.points
            scored += factor * accumulator.scored
            conceded += factor * accumulator.conceded
            for index in range(self.slots):
                total = accumulator.stat_weight[index]
                if total > 0.0:
                    stat_sum[index] += factor * accumulator.stat_sum[index]
                    stat_weight[index] += factor * total
        if weight <= 0.0:
            return (LEAGUE_POINTS_PER_MATCH, LEAGUE_GOALS_PER_MATCH,
                    LEAGUE_GOALS_PER_MATCH, MAX_REST_DAYS, 0, [NAN] * self.slots)
        rates = [stat_sum[i] / stat_weight[i] if stat_weight[i] > 0.0 else NAN
                 for i in range(self.slots)]
        rest = MAX_REST_DAYS
        if record.last_kickoff is not None:
            rest = min(MAX_REST_DAYS,
                       max(0.0, (kickoff - record.last_kickoff).total_seconds() / 86400.0))
        return (points / weight, scored / weight, conceded / weight, rest,
                record.matches, rates)

    def rating(self, team_id: str) -> float:
        record = self.teams.get(team_id)
        return record.rating if record is not None else ELO_START

    def history_count(self, team_id: str) -> int:
        record = self.teams.get(team_id)
        return record.matches if record is not None else 0

    def features(self, home_id: str, away_id: str, kickoff: datetime,
                 neutral: bool = False, season: str = "") -> list[float]:
        """Feature vector for one fixture, from folded matches only.

        Statistic rates may be NaN while a team has no record of that metric;
        the boosted trees route missing values themselves. The goal and schedule
        block must always be finite, and no rate may be infinite.
        """
        home_id, away_id = str(home_id), str(away_id)
        season = str(season or "")
        home_elo, away_elo = self.rating(home_id), self.rating(away_id)
        home_points, home_for, home_against, home_rest, _, home_rates = self._form(
            home_id, kickoff, season)
        away_points, away_for, away_against, away_rest, _, away_rates = self._form(
            away_id, kickoff, season)
        difference = home_elo - away_elo + (0.0 if neutral else ELO_HOME_ADVANTAGE)
        values = [difference, home_elo, away_elo, home_points, away_points,
                  home_for, home_against, away_for, away_against,
                  home_rest, away_rest, 1.0 if neutral else 0.0]
        if any(not math.isfinite(value) for value in values):
            raise ValueError("Non-finite feature value")
        for index, (_name, _slug, zero_sum) in enumerate(self.metrics):
            for rates in (home_rates, away_rates):
                own, opponent = rates[2 * index], rates[2 * index + 1]
                if own in INFINITE or (not zero_sum and opponent in INFINITE):
                    raise ValueError("Non-finite statistic rate")
                values.append(own)
                if not zero_sum:
                    values.append(opponent)
        return values

    def team_summary(self) -> dict[str, dict[str, float | int]]:
        """Recorded alongside every prediction for auditing."""
        return {team_id: {"attack": 0.0, "defense": 0.0, "elo": record.rating,
                          "training_matches": record.matches,
                          "effective_matches": float(record.matches)}
                for team_id, record in self.teams.items()}


def replay(matches, *, cutoff_hours: float, half_life_days: float,
           config: FeatureConfig | None = None, min_history: int = 5):
    """Chronological replay -> (records, state).

    Each record is ``(kickoff, features, label, season)`` built only from
    matches whose ``available_at`` preceded that record's own cutoff. The
    returned state has every usable match folded in. Features do not depend on
    any model hyperparameter, so a search can replay once and reuse the result.
    """
    usable = [m for m in matches if m.home_goals is not None and m.away_goals is not None]
    sources = sorted(usable, key=lambda m: (m.available_at, m.fixture_id))
    targets = sorted(usable, key=lambda m: (m.kickoff, m.fixture_id))
    state = LeagueState(half_life_days, config)
    records = []
    index = 0
    for target in targets:
        cutoff = target.kickoff - timedelta(hours=cutoff_hours)
        while index < len(sources) and sources[index].available_at < cutoff:
            state.update(sources[index])
            index += 1
        if (min(state.history_count(str(target.home_team_id)),
                state.history_count(str(target.away_team_id))) >= min_history):
            season = str(getattr(target, "season", "") or "")
            records.append((
                target.kickoff,
                state.features(target.home_team_id, target.away_team_id,
                               target.kickoff, getattr(target, "neutral", False), season),
                0 if target.home_goals > target.away_goals
                else 1 if target.home_goals == target.away_goals else 2,
                season,
            ))
    while index < len(sources):
        state.update(sources[index])
        index += 1
    return records, state


def training_table(matches, as_of: datetime, *, cutoff_hours: float,
                   half_life_days: float, config: FeatureConfig | None = None,
                   min_history: int = 5):
    """``replay`` plus decay weights measured from ``as_of``.

    Rows from the newest season present are multiplied by ``season_boost``, the
    same discrete preference the features themselves apply.
    """
    config = config or DEFAULT_CONFIG
    records, state = replay(matches, cutoff_hours=cutoff_hours,
                            half_life_days=half_life_days, config=config,
                            min_history=min_history)
    rows = [record[1] for record in records]
    labels = [record[2] for record in records]
    current = max((record[3] for record in records), default="")
    weights = [2.0 ** (-max(0.0, (as_of - record[0]).total_seconds() / 86400.0) / half_life_days)
               * (config.season_boost if record[3] == current else 1.0)
               for record in records]
    return rows, labels, weights, state


def coverage(rows, names) -> list[dict]:
    """Share of training rows where each feature is present, for the report."""
    total = len(rows) or 1
    present = [0] * len(names)
    for row in rows:
        for index, value in enumerate(row):
            if value == value:  # not NaN
                present[index] += 1
    return [{"feature": name, "rows": len(rows), "present": present[index],
             "present_share": present[index] / total}
            for index, name in enumerate(names)]
