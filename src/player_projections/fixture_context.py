"""Explain existing goal-rate adjustments; difficulty bands are heuristic, not probabilities."""
import math

CONTEXT_COLUMNS = [
    "team_attack_strength", "team_defense_strength", "opponent_attack_strength",
    "opponent_defense_strength", "attacking_fixture_factor", "defensive_fixture_factor",
    "attacking_fixture_difficulty", "defensive_fixture_difficulty", "strength_context_status",
]


def difficulty(risk):
    """Higher risk means harder: 1 easy through 5 hard, 3 near league-average."""
    return 1 if risk < .65 else 2 if risk < .85 else 3 if risk <= 1.15 else 4 if risk <= 1.45 else 5


def fixture_context(team, opponent, venue, home_base, away_base, attack, conceded):
    if venue not in {"H", "A"}:
        raise ValueError("Venue must be H or A.")
    values = [home_base, away_base, attack.get(team, 1), attack.get(opponent, 1),
              conceded.get(team, 1), conceded.get(opponent, 1)]
    if any(not math.isfinite(value) or value <= 0 for value in values):
        raise ValueError("Team goal-rate factors must be finite and positive.")
    average = (home_base + away_base) / 2
    own_base, opposition_base = (home_base, away_base) if venue == "H" else (away_base, home_base)
    # Isolate opponent + venue, so difficulty is comparable across teams.
    attack_factor = own_base / average * conceded.get(opponent, 1)
    defense_factor = opposition_base / average * attack.get(opponent, 1)
    return {
        "team_attack_strength": attack.get(team, 1),
        "team_defense_strength": 1 / conceded.get(team, 1),
        "opponent_attack_strength": attack.get(opponent, 1),
        "opponent_defense_strength": 1 / conceded.get(opponent, 1),
        "attacking_fixture_factor": attack_factor,
        "defensive_fixture_factor": defense_factor,
        "attacking_fixture_difficulty": difficulty(1 / attack_factor),
        "defensive_fixture_difficulty": difficulty(defense_factor),
        "strength_context_status": "history_based" if all(key in source for key in (team, opponent)
                                                            for source in (attack, conceded)) else "league_average_fallback",
    }
