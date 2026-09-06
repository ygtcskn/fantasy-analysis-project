"""TFF fantasy scoring rules, loaded from config/tff_scoring_rules.csv.

The CSV is the single source of every constant. This module reads it, checks
that the rule set is complete, and exposes the numbers as named attributes. The
scoring logic itself stays as explicit Python rather than a generic rule
interpreter: nineteen heterogeneous rules with position gates, minute
thresholds, floor division and a rank-based bonus are shorter and far clearer
written out than expressed in a small language nobody else will read.

Two rules are transcribed from a supplied graphic and were resolved against the
data instead of the wording. The minutes threshold is 60 inclusive, not "more
than 60": reconstructing 2026/27 totals for 395 matched players scored 271 exact
under that reading against 165 under the literal one. Bonus tie handling follows
the graphic, and the reconciliation report records what that costs.
"""
from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field
from pathlib import Path

POSITIONS = ("KL", "DEF", "OS", "FOR")
# Sportmonks records a position on every player-match row. The fantasy game's
# own classification is preferred where a player is matched to it; this is the
# fallback, and for seasons before the current one it is the only option.
FROM_SPORTMONKS = {
    "Goalkeeper": "KL",
    "Defender": "DEF",
    "Midfielder": "OS",
    "Attacker": "FOR",
}
REQUIRED_RULES = (
    "minutes_short", "minutes_long", "goal_goalkeeper", "goal_defender",
    "goal_midfielder", "goal_forward", "assist", "clean_sheet_gk_def",
    "clean_sheet_midfield", "saves", "penalty_saved", "penalty_missed",
    "goals_conceded", "yellow_card", "red_card", "own_goal",
    "bonus_first", "bonus_second", "bonus_third",
)
COMPONENTS = (
    "appearance", "goals", "assists", "clean_sheet", "saves",
    "penalty_saved", "penalty_missed", "goals_conceded", "cards", "own_goal",
)


class RulesError(ValueError):
    pass


def _number(value: str, rule_id: str, column: str) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        raise RulesError(f"{rule_id}: {column} is not a number: {value!r}") from None


@dataclass(frozen=True)
class ScoringRules:
    """Every constant the scorer needs, with its provenance."""

    minutes_threshold: int
    appearance_short: int
    appearance_long: int
    goal: dict = field(default_factory=dict)
    assist: int = 0
    clean_sheet: dict = field(default_factory=dict)
    clean_sheet_minutes: int = 60
    saves_per_point: int = 3
    save_points: int = 1
    penalty_saved: int = 0
    penalty_missed: int = 0
    conceded_per_penalty: int = 2
    conceded_points: int = 0
    conceded_positions: tuple = ()
    yellow_card: int = 0
    red_card: int = 0
    own_goal: int = 0
    bonus: tuple = (3, 2, 1)
    source: str = ""
    unconfirmed: tuple = ()

    @classmethod
    def load(cls, path) -> "ScoringRules":
        text = Path(path).read_text(encoding="utf-8-sig")
        rows = {r["rule_id"]: r for r in csv.DictReader(io.StringIO(text))}
        missing = [name for name in REQUIRED_RULES if name not in rows]
        if missing:
            raise RulesError(f"{path}: missing rules {', '.join(missing)}")

        def points(rule_id: str) -> int:
            return int(_number(rows[rule_id]["points"], rule_id, "points"))

        def per_unit(rule_id: str) -> int:
            value = rows[rule_id]["per_unit"]
            return int(_number(value, rule_id, "per_unit")) if value else 1

        long_rule = rows["minutes_long"]
        threshold = int(_number(long_rule["min_minutes"], "minutes_long", "min_minutes"))
        clean = {"KL": points("clean_sheet_gk_def"), "DEF": points("clean_sheet_gk_def"),
                 "OS": points("clean_sheet_midfield"), "FOR": 0}
        conceded_positions = tuple(rows["goals_conceded"]["positions"].split("|"))
        unknown = set(conceded_positions) - set(POSITIONS)
        if unknown:
            raise RulesError(f"goals_conceded: unknown position codes {sorted(unknown)}")
        cs_minutes = rows["clean_sheet_gk_def"]["min_minutes"]
        rules = cls(
            minutes_threshold=threshold,
            appearance_short=points("minutes_short"),
            appearance_long=points("minutes_long"),
            goal={"KL": points("goal_goalkeeper"), "DEF": points("goal_defender"),
                  "OS": points("goal_midfielder"), "FOR": points("goal_forward")},
            assist=points("assist"),
            clean_sheet=clean,
            clean_sheet_minutes=int(_number(cs_minutes, "clean_sheet_gk_def", "min_minutes")),
            saves_per_point=per_unit("saves"),
            save_points=points("saves"),
            penalty_saved=points("penalty_saved"),
            penalty_missed=points("penalty_missed"),
            conceded_per_penalty=per_unit("goals_conceded"),
            conceded_points=points("goals_conceded"),
            conceded_positions=conceded_positions,
            yellow_card=points("yellow_card"),
            red_card=points("red_card"),
            own_goal=points("own_goal"),
            bonus=(points("bonus_first"), points("bonus_second"), points("bonus_third")),
            source=rows["assist"].get("source", ""),
            unconfirmed=tuple(sorted(
                name for name, row in rows.items()
                if row.get("needs_confirmation", "").strip().upper() == "TRUE")),
        )
        if rules.saves_per_point <= 0 or rules.conceded_per_penalty <= 0:
            raise RulesError("Divisor rules must have a positive per_unit")
        if rules.minutes_threshold <= 0:
            raise RulesError("minutes_long must set a positive min_minutes")
        return rules

    # -------------------------------------------------------------- scoring

    def score(self, *, position: str, minutes: float, goals: float, assists: float,
              conceded: float, saves: float, penalties_saved: float,
              penalties_missed: float, yellow_cards: float, dismissals: float,
              own_goals: float) -> dict:
        """Points for one player in one match, before the match bonus.

        Returns the components separately: a total alone cannot answer where a
        player's points actually come from, which is the first thing worth
        knowing about a scoring system.
        """
        if position not in POSITIONS:
            raise RulesError(f"Unknown fantasy position: {position!r}")
        if minutes <= 0:
            return {name: 0 for name in COMPONENTS} | {"points_base": 0, "played": False}
        parts = {name: 0 for name in COMPONENTS}
        parts["appearance"] = (self.appearance_long if minutes >= self.minutes_threshold
                               else self.appearance_short)
        parts["goals"] = self.goal[position] * int(goals)
        parts["assists"] = self.assist * int(assists)
        if minutes >= self.clean_sheet_minutes and conceded == 0:
            parts["clean_sheet"] = self.clean_sheet[position]
        if position == "KL":
            parts["saves"] = self.save_points * (int(saves) // self.saves_per_point)
        parts["penalty_saved"] = self.penalty_saved * int(penalties_saved)
        parts["penalty_missed"] = self.penalty_missed * int(penalties_missed)
        if position in self.conceded_positions:
            parts["goals_conceded"] = self.conceded_points * (
                int(conceded) // self.conceded_per_penalty)
        parts["cards"] = (self.yellow_card * int(yellow_cards)
                          + self.red_card * int(dismissals))
        parts["own_goal"] = self.own_goal * int(own_goals)
        parts["points_base"] = sum(parts[name] for name in COMPONENTS)
        parts["played"] = True
        return parts

    def award_bonus(self, scored: dict) -> dict:
        """Bonus for one fixture, keyed the same way as ``scored``.

        Ranks distinct base scores and pays the top three. Every player on a
        tied score receives that rank's bonus, as the published rules state.
        """
        if not scored:
            return {}
        ranked = sorted({value for value in scored.values()}, reverse=True)[:len(self.bonus)]
        awards = {}
        for points, cutoff in zip(self.bonus, ranked):
            for key, value in scored.items():
                if value == cutoff:
                    awards[key] = awards.get(key, 0) + points
        return awards
