"""Resolve saved Sportmonks absences for one future fixture.

Team end dates are estimates. A fixture-specific sidelined record supplies the
stronger evidence needed to publish zero playing probability. An unresolved
injury is never cleared simply because its estimated end date has elapsed.
"""
from __future__ import annotations

from datetime import date, datetime


AVAILABILITY_COLUMNS = [
    "availability_status", "availability_reason", "estimated_return_date",
    "eligible_for_selection",
]


def _date(value: str) -> date | None:
    try:
        return date.fromisoformat(str(value)[:10])
    except (ValueError, TypeError):
        return None


def resolve_availability(*, player_id: str, team_id: str, fixture_id: str,
                         kickoff: datetime, cutoff: datetime,
                         team_rows: list[dict], fixture_rows: list[dict],
                         team_feed_present: bool = True,
                         fixture_feed_present: bool = True) -> dict:
    relevant = [row for row in team_rows
                if row.get("player_id") == player_id
                and row.get("team_id") in {"", team_id, None}
                and (not _date(row.get("start_date"))
                     or _date(row.get("start_date")) <= cutoff.date())]
    active = [row for row in relevant
              if str(row.get("completed", "")).lower() != "true"]
    injuries = [row for row in active if row.get("category", "").lower() == "injury"]
    fixture_absences = [row for row in fixture_rows
                       if row.get("player_id") == player_id
                       and row.get("fixture_id") == fixture_id
                       and row.get("participant_id") in {"", team_id, None}]
    # Duplicate captures sometimes omit the date on one row. Preserve every
    # nonblank estimate and use the latest date conservatively when they differ.
    dated = sorted({_date(row.get("end_date")) for row in injuries
                    if _date(row.get("end_date"))})
    return_date = dated[-1].isoformat() if dated else ""
    result = {"availability_status": "no_reported_absence",
              "availability_reason": "No active absence in the saved Sportmonks feeds.",
              "estimated_return_date": return_date, "eligible_for_selection": True}
    if fixture_absences:
        result.update(availability_status="out", eligible_for_selection=False,
                      availability_reason="Sportmonks lists this player as sidelined for the target fixture.")
    elif injuries:
        expected_out = bool(dated and dated[-1] >= kickoff.date())
        result.update(availability_status="expected_out" if expected_out else "doubtful",
                      eligible_for_selection=False,
                      availability_reason=("Active injury; estimated return is on or after the fixture date."
                                           if expected_out else
                                           "Active injury; return is unknown or the estimated date has passed without confirmation."))
    elif active:
        result.update(availability_status="unknown", eligible_for_selection=False,
                      availability_reason="Active absence has no confirmed target-fixture coverage; suspension competition may differ.")
    elif not team_feed_present or not fixture_feed_present:
        result.update(availability_status="unknown", eligible_for_selection=False,
                      availability_reason="One or both saved Sportmonks availability feeds are missing.")
    return result


def apply_availability(row: dict, availability: dict, forecast_fields: list[str]) -> dict:
    """Keep an inspectable baseline; suppress uncertain forecasts, zero confirmed outs."""
    result = dict(row)
    result.update({f"baseline_{name}": row[name] for name in forecast_fields})
    result.update(availability)
    if availability["availability_status"] != "no_reported_absence":
        value = 0.0 if availability["availability_status"] == "out" else ""
        result.update({name: value for name in forecast_fields})
    return result
