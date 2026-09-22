"""On-demand Sportmonks live feed. Provider JSON stays in memory; serve only CSV.

This is separate from the downloader: no historical cache, captures or data files
are read as live scores, and no files are written. Only the configured season's
competition is requested. A shared CSV cache bounds requests from multiple tabs.
"""

import csv
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from http.client import HTTPException
import io
import json
import math
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from src.fetch.sportmonks import BASE, token


LIVE_SECONDS = 30
IDLE_SECONDS = 60
ERROR_SECONDS = 120
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
STATES = {
    2: "INPLAY_1ST_HALF", 3: "HT", 4: "BREAK", 6: "INPLAY_ET",
    9: "INPLAY_PENALTIES", 11: "SUSPENDED", 18: "INTERRUPTED",
    19: "AWAITING_UPDATES", 21: "EXTRA_TIME_BREAK", 22: "INPLAY_2ND_HALF",
    25: "PEN_BREAK",
}
FINISHED_STATES = {5: "FT", 7: "AET", 8: "FT_PEN"}
LIVE_INCLUDES = "participants;scores;state;periods;statistics.type;events.type"
FIELDS = (
    "record_type", "status", "message", "fetched_at", "poll_seconds", "season",
    "fixture_id", "league_id", "season_id", "state", "minute", "extra_minute",
    "home_team_id", "home_name", "away_team_id", "away_name", "home_score", "away_score",
    "statistics_available", "events_available", "team_id", "type_id", "code", "label",
    "value", "event_id", "player_id", "player_name", "related_player_id",
    "related_player_name", "result", "info", "addition", "rescinded", "sort_order",
    "started", "position", "formation_field", "jersey_number", "lineups_available",
    "minutes_played", "rating", "goals", "assists",
)


class LiveUnavailable(Exception):
    def __init__(self, message, retry=ERROR_SECONDS):
        super().__init__(message)
        self.retry = retry


def positive_id(value):
    text = str(value or "")
    return text if text.isascii() and text.isdigit() and int(text) > 0 else ""


def numeric(value):
    if isinstance(value, bool) or value is None or value == "":
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) and result >= 0 else None


def records(value):
    if value is None:
        return []
    if not isinstance(value, list) or any(not isinstance(row, dict) for row in value):
        raise LiveUnavailable("Canlı maç verisinin biçimi beklenenden farklı.")
    return value


def csv_bytes(rows):
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=FIELDS)
    writer.writeheader()
    # Never serialize a provider object or list inside a CSV cell.
    writer.writerows({key: value if isinstance(value, (str, int, float, bool)) else ""
                     for key, value in row.items()} for row in rows)
    return stream.getvalue().encode("utf-8")


def season_scope(csv_root):
    with (csv_root / "fixtures.csv").open(encoding="utf-8-sig", newline="") as source:
        scopes = {(positive_id(row.get("league_id")), positive_id(row.get("season_id")))
                  for row in csv.DictReader(source)}
    if len(scopes) != 1 or not all(next(iter(scopes))):
        raise LiveUnavailable("Canlı maçlar için sezon ve lig bilgisi doğrulanamadı.")
    return next(iter(scopes))


def retry_seconds(value):
    try:
        delay = float(value)
    except (TypeError, ValueError):
        try:
            delay = parsedate_to_datetime(value).timestamp() - time.time()
        except (TypeError, ValueError, OverflowError):
            delay = ERROR_SECONDS
    return max(ERROR_SECONDS, math.ceil(delay)) if math.isfinite(delay) else ERROR_SECONDS


def fetch_fixtures(endpoint, params):
    try:
        key = token()
    except RuntimeError:
        raise LiveUnavailable("Canlı maç bağlantısı yapılandırılmamış.") from None
    query = urlencode(params)
    request = Request(f"{BASE}/{endpoint}?{query}",
                      headers={"Authorization": key, "Accept": "application/json"})
    try:
        with urlopen(request, timeout=10) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
        if len(body) > MAX_RESPONSE_BYTES:
            raise LiveUnavailable("Canlı maç yanıtı boyut sınırını aştı.")
        payload = json.loads(body)
    except HTTPError as error:
        # Do not expose provider error bodies, request URLs or credentials.
        if error.code == 429:
            raise LiveUnavailable("Canlı veri istek sınırına ulaşıldı; yeniden denenecek.",
                                  retry_seconds(error.headers.get("Retry-After"))) from None
        if error.code in (401, 402, 403):
            raise LiveUnavailable("Sportmonks canlı veri erişimi kullanılamıyor.") from None
        raise LiveUnavailable("Sportmonks canlı verisi şu anda alınamıyor.") from None
    except (URLError, OSError, HTTPException, ValueError):
        raise LiveUnavailable("Canlı maç bağlantısı kurulamadı; yeniden denenecek.") from None
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        raise LiveUnavailable("Canlı maç yanıtı doğrulanamadı.")
    if (payload.get("pagination") or {}).get("has_more"):
        raise LiveUnavailable("Canlı maç yanıtı eksik; yeniden denenecek.")
    return records(payload["data"])


def fetch_inplay(league_id):
    return fetch_fixtures("livescores/inplay", {
        "filters": f"fixtureLeagues:{league_id}", "include": LIVE_INCLUDES})


def fetch_fixture_details(ids):
    if not ids or len(ids) > 50 or any(not positive_id(value) for value in ids):
        raise LiveUnavailable("Maç kimlikleri doğrulanamadı.")
    return fetch_fixtures(f"fixtures/multi/{','.join(ids)}", {
        "include": LIVE_INCLUDES + ";lineups.position;lineups.details.type"})


def current_score(fixture, team_id):
    values = [numeric((row.get("score") or {}).get("goals"))
              for row in records(fixture.get("scores"))
              if row.get("description") == "CURRENT" and positive_id(row.get("participant_id")) == team_id]
    return values[0] if len(values) == 1 and values[0] is not None and values[0].is_integer() else None


def match_minute(fixture):
    # Display only provider timing. Do not extrapolate a clock from kickoff.
    ticking = [row for row in records(fixture.get("periods")) if row.get("ticking") is True]
    if len(ticking) != 1 or int(fixture["state_id"]) not in {2, 6, 9, 22}:
        return "", ""
    period = ticking[0]
    minute = numeric(period.get("minutes"))
    start, length = numeric(period.get("counts_from")), numeric(period.get("period_length"))
    if minute is None:
        return "", ""
    # time_added is announced stoppage time, not elapsed stoppage time.
    if start is not None and length and minute > start + length:
        return start + length, minute - start - length
    return minute, ""


def normalize(fixtures, league_id, season_id, include_finished=False):
    rows, seen = [], set()
    allowed_states = STATES | FINISHED_STATES if include_finished else STATES
    for fixture in fixtures:
        if (positive_id(fixture.get("league_id")), positive_id(fixture.get("season_id"))) != (league_id, season_id):
            continue
        state_id = positive_id(fixture.get("state_id"))
        if not state_id or int(state_id) not in allowed_states:
            continue  # Never label scheduled or completed fixtures as live.
        fixture_id = positive_id(fixture.get("id"))
        if not fixture_id or fixture_id in seen:
            raise LiveUnavailable("Canlı maç kimliği doğrulanamadı.")
        seen.add(fixture_id)
        sides = {}
        for side in ("home", "away"):
            matches = [row for row in records(fixture.get("participants"))
                       if (row.get("meta") or {}).get("location") == side]
            if len(matches) != 1 or not positive_id(matches[0].get("id")):
                raise LiveUnavailable("Canlı maçın takımları doğrulanamadı.")
            sides[side] = matches[0]
        home, away = (positive_id(sides[side]["id"]) for side in ("home", "away"))
        if home == away:
            raise LiveUnavailable("Canlı maçın takımları doğrulanamadı.")
        minute, extra = match_minute(fixture)
        rows.append(dict(record_type="fixture", fixture_id=fixture_id, league_id=league_id,
                         season_id=season_id, state=allowed_states[int(state_id)], minute=minute, extra_minute=extra,
                         home_team_id=home, home_name=sides["home"].get("name"),
                         away_team_id=away, away_name=sides["away"].get("name"),
                         home_score=current_score(fixture, home), away_score=current_score(fixture, away),
                         statistics_available=int(isinstance(fixture.get("statistics"), list)),
                         events_available=int(isinstance(fixture.get("events"), list)),
                         lineups_available=int(isinstance(fixture.get("lineups"), list))))
        for stat in records(fixture.get("statistics")):
            team_id = positive_id(stat.get("participant_id"))
            if team_id not in {home, away}:
                continue
            kind = stat.get("type") or {}
            rows.append(dict(record_type="statistic", fixture_id=fixture_id, team_id=team_id,
                             type_id=stat.get("type_id"), code=kind.get("developer_name") or kind.get("code"),
                             label=kind.get("name"), value=numeric((stat.get("data") or {}).get("value"))))
        for event in records(fixture.get("events")):
            kind = event.get("type") or {}
            team_id = positive_id(event.get("participant_id") or event.get("team_id"))
            row = {field: event.get(field) for field in (
                "player_id", "player_name", "related_player_id", "related_player_name", "minute",
                "extra_minute", "result", "info", "addition", "rescinded", "sort_order")}
            row.update(record_type="event", fixture_id=fixture_id, event_id=event.get("id"),
                       team_id=team_id if team_id in {home, away} else "", type_id=event.get("type_id"),
                       code=kind.get("developer_name") or kind.get("code"), label=kind.get("name"))
            rows.append(row)
        for player in records(fixture.get("lineups")):
            team_id = positive_id(player.get("team_id"))
            if team_id not in {home, away} or not positive_id(player.get("player_id")):
                continue
            details = {}
            for detail in records(player.get("details")):
                kind = detail.get("type") or {}
                code = str(kind.get("developer_name") or kind.get("code") or "").lower().replace("-", "_")
                if code in {"minutes_played", "rating", "goals", "assists"}:
                    # Conflicting/duplicate player metrics remain unavailable.
                    details[code] = None if code in details else numeric((detail.get("data") or {}).get("value"))
            rows.append(dict(record_type="lineup", fixture_id=fixture_id, team_id=team_id,
                             player_id=player["player_id"], player_name=player.get("player_name"),
                             started={11: 1, 12: 0}.get(player.get("type_id")),
                             position=(player.get("position") or {}).get("name"),
                             formation_field=player.get("formation_field"), jersey_number=player.get("jersey_number"),
                             **details))
    return rows


class LiveFeed:
    def __init__(self, csv_root, enabled=True):
        self.csv_root, self.enabled = csv_root, enabled
        self.lock = threading.Lock()
        self.cached = b""
        self.next_fetch = 0
        self.scope = None
        self.observed = {}
        self.completed = {}
        self.next_confirmation = 0

    def confirm_finished(self, fixtures, league_id, season_id):
        now = time.monotonic()
        current = {positive_id(row.get("id")) for row in fixtures
                   if (positive_id(row.get("league_id")), positive_id(row.get("season_id"))) == (league_id, season_id)
                   and positive_id(row.get("state_id")) in {str(key) for key in STATES}}
        self.observed = {key: seen for key, seen in self.observed.items() if now - seen < 6 * 3600}
        self.observed.update({key: now for key in current if key})
        self.completed = {key: value for key, value in self.completed.items() if now - value[0] < 7 * 86400}
        missing = sorted(set(self.observed) - current)[:50]
        if missing and now >= self.next_confirmation:
            # Disappearing from in-play is not proof of full time. Confirm by ID.
            try:
                returned = fetch_fixture_details(missing)
                for fixture in returned:
                    key = positive_id(fixture.get("id"))
                    if key not in missing or (positive_id(fixture.get("league_id")), positive_id(fixture.get("season_id"))) != (league_id, season_id):
                        continue
                    state_id = positive_id(fixture.get("state_id"))
                    if state_id in {str(value) for value in FINISHED_STATES}:
                        rows = normalize([fixture], league_id, season_id, include_finished=True)
                        self.completed[key] = (now, csv_bytes(rows))
                        self.observed.pop(key, None)
                    elif state_id in {"10", "12", "14", "15", "17", "20"}:
                        self.observed.pop(key, None)
                self.next_confirmation = now + LIVE_SECONDS
            except LiveUnavailable as error:
                self.next_confirmation = now + error.retry
        return [row for _, content in self.completed.values()
                for row in csv.DictReader(io.StringIO(content.decode("utf-8")))]

    def snapshot(self, head_only=False):
        meta = dict(record_type="meta", status="disabled", season=self.csv_root.name,
                    poll_seconds=ERROR_SECONDS)
        if head_only or not self.enabled:
            return csv_bytes([meta])
        with self.lock:
            if self.cached and time.monotonic() < self.next_fetch:
                return self.cached
            delay, rows = ERROR_SECONDS, []
            try:
                league_id, season_id = season_scope(self.csv_root)
                if self.scope != (league_id, season_id):
                    self.observed.clear()
                    self.completed.clear()
                    self.next_confirmation = 0
                    self.scope = (league_id, season_id)
                fixtures = fetch_inplay(league_id)
                rows = normalize(fixtures, league_id, season_id)
                delay = LIVE_SECONDS if rows else IDLE_SECONDS
                rows.extend(self.confirm_finished(fixtures, league_id, season_id))
                meta.update(status="ok", fetched_at=datetime.now(timezone.utc).isoformat())
            except LiveUnavailable as error:
                delay = error.retry
                meta.update(status="unavailable", message=str(error))
            except (OSError, UnicodeError, csv.Error, TypeError, ValueError, AttributeError, KeyError):
                meta.update(status="unavailable", message="Canlı maç verisi doğrulanamadı; yeniden denenecek.")
            meta["poll_seconds"] = delay
            self.cached = csv_bytes([meta, *rows])
            self.next_fetch = time.monotonic() + delay
            return self.cached
