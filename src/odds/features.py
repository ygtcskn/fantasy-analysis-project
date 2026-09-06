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

Features are intentionally few. At any cutoff the eligible pool is at most a
three-season window, roughly a thousand matches, so a wide feature set would
fit noise faster than signal.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
import math

FEATURE_NAMES = (
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

ELO_START = 1500.0
ELO_K = 20.0
ELO_HOME_ADVANTAGE = 60.0
# Rest is capped so a summer break does not become an extreme numeric outlier.
MAX_REST_DAYS = 45.0
LEAGUE_GOALS_PER_MATCH = 1.35
LEAGUE_POINTS_PER_MATCH = 1.0


@dataclass
class _TeamRecord:
    rating: float = ELO_START
    last_kickoff: datetime | None = None
    results: list = field(default_factory=list)  # (kickoff, points, scored, conceded)


class LeagueState:
    """Team form and Elo ratings, advanced one completed match at a time."""

    def __init__(self, half_life_days: float = 365.0) -> None:
        if not math.isfinite(half_life_days) or half_life_days <= 0:
            raise ValueError("half_life_days must be finite and positive")
        self.half_life_days = float(half_life_days)
        self.teams: dict[str, _TeamRecord] = defaultdict(_TeamRecord)
        self.folded = 0
        self.latest_available_at: datetime | None = None

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
        home_record.results.append((match.kickoff, home_points, match.home_goals, match.away_goals))
        away_record.results.append((match.kickoff, away_points, match.away_goals, match.home_goals))
        home_record.last_kickoff = match.kickoff
        away_record.last_kickoff = match.kickoff
        self.folded += 1
        if self.latest_available_at is None or match.available_at > self.latest_available_at:
            self.latest_available_at = match.available_at

    def _form(self, team_id: str, kickoff: datetime) -> tuple[float, float, float, float, int]:
        """Time-decayed points, goals for and goals against per match."""
        record = self.teams.get(team_id)
        if record is None or not record.results:
            return (LEAGUE_POINTS_PER_MATCH, LEAGUE_GOALS_PER_MATCH,
                    LEAGUE_GOALS_PER_MATCH, MAX_REST_DAYS, 0)
        weight_total = points = scored = conceded = 0.0
        for played, team_points, team_scored, team_conceded in record.results:
            age = (kickoff - played).total_seconds() / 86400.0
            if age < 0:
                continue
            weight = 2.0 ** (-age / self.half_life_days)
            weight_total += weight
            points += weight * team_points
            scored += weight * team_scored
            conceded += weight * team_conceded
        if weight_total <= 0:
            return (LEAGUE_POINTS_PER_MATCH, LEAGUE_GOALS_PER_MATCH,
                    LEAGUE_GOALS_PER_MATCH, MAX_REST_DAYS, 0)
        rest = MAX_REST_DAYS
        if record.last_kickoff is not None:
            rest = min(MAX_REST_DAYS, max(0.0, (kickoff - record.last_kickoff).total_seconds() / 86400.0))
        return (points / weight_total, scored / weight_total,
                conceded / weight_total, rest, len(record.results))

    def rating(self, team_id: str) -> float:
        record = self.teams.get(team_id)
        return record.rating if record is not None else ELO_START

    def history_count(self, team_id: str) -> int:
        record = self.teams.get(team_id)
        return len(record.results) if record is not None else 0

    def features(self, home_id: str, away_id: str, kickoff: datetime,
                 neutral: bool = False) -> list[float]:
        """Feature vector for one fixture, from folded matches only."""
        home_id, away_id = str(home_id), str(away_id)
        home_elo, away_elo = self.rating(home_id), self.rating(away_id)
        home_points, home_for, home_against, home_rest, _ = self._form(home_id, kickoff)
        away_points, away_for, away_against, away_rest, _ = self._form(away_id, kickoff)
        difference = home_elo - away_elo + (0.0 if neutral else ELO_HOME_ADVANTAGE)
        values = [difference, home_elo, away_elo, home_points, away_points,
                  home_for, home_against, away_for, away_against,
                  home_rest, away_rest, 1.0 if neutral else 0.0]
        if any(not math.isfinite(value) for value in values):
            raise ValueError("Non-finite feature value")
        return values

    def team_summary(self) -> dict[str, dict[str, float | int]]:
        """Recorded alongside every prediction for auditing."""
        return {team_id: {"attack": 0.0, "defense": 0.0, "elo": record.rating,
                          "training_matches": len(record.results),
                          "effective_matches": float(len(record.results))}
                for team_id, record in self.teams.items()}


def replay(matches, *, cutoff_hours: float, half_life_days: float,
           min_history: int = 5):
    """Chronological replay -> (records, state).

    Each record is ``(kickoff, features, label)`` built only from matches whose
    ``available_at`` preceded that record's own cutoff. The returned state has
    every usable match folded in. Features do not depend on any model
    hyperparameter, so a search can replay once and reuse the result.
    """
    usable = [m for m in matches if m.home_goals is not None and m.away_goals is not None]
    sources = sorted(usable, key=lambda m: (m.available_at, m.fixture_id))
    targets = sorted(usable, key=lambda m: (m.kickoff, m.fixture_id))
    state = LeagueState(half_life_days)
    records = []
    index = 0
    for target in targets:
        cutoff = target.kickoff - timedelta(hours=cutoff_hours)
        while index < len(sources) and sources[index].available_at < cutoff:
            state.update(sources[index])
            index += 1
        if (min(state.history_count(str(target.home_team_id)),
                state.history_count(str(target.away_team_id))) >= min_history):
            records.append((
                target.kickoff,
                state.features(target.home_team_id, target.away_team_id,
                               target.kickoff, getattr(target, "neutral", False)),
                0 if target.home_goals > target.away_goals
                else 1 if target.home_goals == target.away_goals else 2,
            ))
    while index < len(sources):
        state.update(sources[index])
        index += 1
    return records, state


def training_table(matches, as_of: datetime, *, cutoff_hours: float,
                   half_life_days: float, min_history: int = 5):
    """``replay`` plus decay weights measured from ``as_of``."""
    records, state = replay(matches, cutoff_hours=cutoff_hours,
                            half_life_days=half_life_days, min_history=min_history)
    rows = [record[1] for record in records]
    labels = [record[2] for record in records]
    weights = [2.0 ** (-max(0.0, (as_of - record[0]).total_seconds() / 86400.0) / half_life_days)
               for record in records]
    return rows, labels, weights, state
