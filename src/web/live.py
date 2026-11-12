"""On-demand Sportmonks live feed. Provider JSON stays in memory; serve only CSV.

This is separate from the downloader: no historical cache, captures or data files
are read as live scores, and no files are written. Only the configured season's
competition is requested. A shared CSV cache bounds requests from multiple tabs.
"""

from concurrent.futures import ThreadPoolExecutor
import csv
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
from src.shared import COVERAGE_COLUMNS, number, utc_now, utc_stamp


LIVE_SECONDS = 30
IDLE_SECONDS = 60
ERROR_SECONDS = 120
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
OPTIONAL_TIMEOUT = 4
OPTIONAL_ACCESS_RETRY = 15 * 60
OPTIONAL_ACCESS_ERRORS = {400, 401, 402, 403, 404, 422}
STATES = {
    2: "INPLAY_1ST_HALF", 3: "HT", 4: "BREAK", 6: "INPLAY_ET",
    9: "INPLAY_PENALTIES", 11: "SUSPENDED", 18: "INTERRUPTED",
    19: "AWAITING_UPDATES", 21: "EXTRA_TIME_BREAK", 22: "INPLAY_2ND_HALF",
    25: "PEN_BREAK",
}
FINISHED_STATES = {5: "FT", 7: "AET", 8: "FT_PEN"}
LIVE_INCLUDES = "participants;scores;state;periods;statistics.type;events.type"
OPTIONAL_INCLUDES = {
    "pressure": "pressure",
    "xgfixture": "xGFixture.type",
    "formations": "formations",
    "lineups": "lineups.position;lineups.details.type",
}
LINEUP_METRICS = ("minutes_played", "rating", "goals", "assists", "aerials_won", "fouls_drawn", "dispossessed",
                  *COVERAGE_COLUMNS)
FIELDS = (
    "record_type", "status", "message", "fetched_at", "poll_seconds", "season",
    "fixture_id", "league_id", "season_id", "state", "minute", "extra_minute",
    "home_team_id", "home_name", "away_team_id", "away_name", "home_score", "away_score",
    "home_half_score", "away_half_score", "pressure_available", "periods_available",
    "xg_available", "formations_available", "ticking", "formation", "source",
    "statistics_available", "events_available", "team_id", "type_id", "code", "label",
    "value", "event_id", "player_id", "player_name", "related_player_id",
    "related_player_name", "result", "info", "addition", "rescinded", "sort_order",
    "started", "position", "formation_field", "jersey_number", "lineups_available",
    *LINEUP_METRICS,
)


class LiveUnavailable(Exception):
    def __init__(self, message, retry=ERROR_SECONDS, status=None):
        super().__init__(message)
        self.retry = retry
        self.status = status


def positive_id(value):
    text = str(value or "")
    return text if text.isascii() and text.isdigit() and int(text) > 0 else ""


def numeric(value):
    result = number(value)
    return result if result is not None and result >= 0 else None


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


def fetch_fixtures(endpoint, params, timeout=10):
    try:
        key = token()
    except RuntimeError:
        raise LiveUnavailable("Canlı maç bağlantısı yapılandırılmamış.") from None
    query = urlencode(params)
    request = Request(f"{BASE}/{endpoint}?{query}",
                      headers={"Authorization": key, "Accept": "application/json"})
    try:
        with urlopen(request, timeout=timeout) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
        if len(body) > MAX_RESPONSE_BYTES:
            raise LiveUnavailable("Canlı maç yanıtı boyut sınırını aştı.")
        payload = json.loads(body)
    except HTTPError as error:
        # Do not expose provider error bodies, request URLs or credentials.
        if error.code == 429:
            raise LiveUnavailable("Canlı veri istek sınırına ulaşıldı; yeniden denenecek.",
                                  retry_seconds(error.headers.get("Retry-After")), status=429) from None
        if error.code in (401, 402, 403):
            raise LiveUnavailable("Sportmonks canlı veri erişimi kullanılamıyor.", status=error.code) from None
        raise LiveUnavailable("Sportmonks canlı verisi şu anda alınamıyor.", status=error.code) from None
    except (URLError, OSError, HTTPException, ValueError):
        raise LiveUnavailable("Canlı maç bağlantısı kurulamadı; yeniden denenecek.") from None
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        raise LiveUnavailable("Canlı maç yanıtı doğrulanamadı.")
    if mapping(payload.get("pagination")).get("has_more"):
        raise LiveUnavailable("Canlı maç yanıtı eksik; yeniden denenecek.")
    return records(payload["data"])


def fetch_inplay(league_id):
    return fetch_fixtures("livescores/inplay", {
        "filters": f"fixtureLeagues:{league_id}", "include": LIVE_INCLUDES})


def fetch_fixture_details(ids):
    return fetch_fixtures(fixture_details_endpoint(ids), {"include": LIVE_INCLUDES})


def fixture_details_endpoint(ids):
    if not ids or len(ids) > 50 or any(not positive_id(value) for value in ids):
        raise LiveUnavailable("Maç kimlikleri doğrulanamadı.")
    return f"fixtures/multi/{','.join(ids)}"


def mapping(value):
    return value if isinstance(value, dict) else {}


def optional_records(value):
    return value if isinstance(value, list) and all(isinstance(row, dict) for row in value) else None


def optional_relation(fixture, name):
    for key in (("xgfixture", "xGFixture", "expected") if name == "xgfixture" else (name,)):
        rows = optional_records(fixture.get(key))
        if rows is not None:
            return rows
    return None


def fetch_optional_fixtures(endpoint, params, relation, lineup_details=True):
    include = OPTIONAL_INCLUDES[relation]
    if relation == "lineups" and not lineup_details:
        include = "lineups"
    try:
        return fetch_fixtures(endpoint, {**params, "include": include}, timeout=OPTIONAL_TIMEOUT), False
    except LiveUnavailable as error:
        if relation != "lineups" or not lineup_details or error.status not in OPTIONAL_ACCESS_ERRORS:
            raise
        # A plan or endpoint can support the team sheet while denying its metrics.
        return fetch_fixtures(endpoint, {**params, "include": "lineups"}, timeout=OPTIONAL_TIMEOUT), True


def score_for_period(fixture, team_id, description):
    values = [numeric((row.get("score") or {}).get("goals"))
              for row in records(fixture.get("scores"))
              if row.get("description") == description and positive_id(row.get("participant_id")) == team_id]
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


def period_code(period):
    code = str(period.get("description") or "").upper().replace("-", "_").replace(" ", "_")
    if code in {"1ST_HALF", "FIRST_HALF"}:
        return "1ST_HALF"
    if code in {"2ND_HALF", "SECOND_HALF"}:
        return "2ND_HALF"
    if numeric(period.get("period_length")) == 45:
        return {0: "1ST_HALF", 45: "2ND_HALF"}.get(numeric(period.get("counts_from")), code)
    return code


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
        pressure = optional_relation(fixture, "pressure")
        xg = optional_relation(fixture, "xgfixture")
        formations = optional_relation(fixture, "formations")
        lineups = optional_relation(fixture, "lineups")
        periods = records(fixture.get("periods"))
        rows.append(dict(record_type="fixture", fixture_id=fixture_id, league_id=league_id,
                         season_id=season_id, state=allowed_states[int(state_id)], minute=minute, extra_minute=extra,
                         home_team_id=home, home_name=sides["home"].get("name"),
                         away_team_id=away, away_name=sides["away"].get("name"),
                         home_score=score_for_period(fixture, home, "CURRENT"),
                         away_score=score_for_period(fixture, away, "CURRENT"),
                         home_half_score=score_for_period(fixture, home, "1ST_HALF"),
                         away_half_score=score_for_period(fixture, away, "1ST_HALF"),
                         statistics_available=int(isinstance(fixture.get("statistics"), list)),
                         events_available=int(isinstance(fixture.get("events"), list)),
                         periods_available=int(isinstance(fixture.get("periods"), list)),
                         pressure_available=int(pressure is not None), xg_available=int(xg is not None),
                         formations_available=int(formations is not None), lineups_available=int(lineups is not None)))
        for source, stats in (("statistics", records(fixture.get("statistics"))), ("xgfixture", xg or [])):
            for stat in stats:
                team_id = positive_id(stat.get("participant_id"))
                if team_id not in {home, away}:
                    continue
                kind = mapping(stat.get("type"))
                rows.append(dict(record_type="statistic", fixture_id=fixture_id, team_id=team_id, source=source,
                                 type_id=stat.get("type_id"), code=kind.get("developer_name") or kind.get("code"),
                                 label=kind.get("name"), value=numeric(mapping(stat.get("data")).get("value"))))
        for period in periods:
            rows.append(dict(record_type="period", fixture_id=fixture_id, code=period_code(period),
                             minute=numeric(period.get("minutes")), ticking=int(period.get("ticking") is True)))
        for sample in pressure or []:
            team_id = positive_id(sample.get("participant_id"))
            sample_minute = numeric(sample.get("minute"))
            value = numeric(sample.get("pressure"))
            if team_id in {home, away} and sample_minute and sample_minute.is_integer() and value is not None:
                rows.append(dict(record_type="pressure", fixture_id=fixture_id, team_id=team_id,
                                 minute=sample_minute, value=value))
        for entry in formations or []:
            team_id = positive_id(entry.get("participant_id"))
            if team_id in {home, away} and isinstance(entry.get("formation"), str):
                rows.append(dict(record_type="formation", fixture_id=fixture_id, team_id=team_id,
                                 formation=entry["formation"]))
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
        for player in lineups or []:
            team_id = positive_id(player.get("team_id"))
            if team_id not in {home, away} or not positive_id(player.get("player_id")):
                continue
            details = {}
            for detail in optional_records(player.get("details")) or []:
                kind = mapping(detail.get("type"))
                code = str(kind.get("developer_name") or kind.get("code") or "").lower().replace("-", "_")
                if code in LINEUP_METRICS:
                    # Conflicting/duplicate player metrics remain unavailable.
                    data = detail.get("data")
                    value = data.get("value") if isinstance(data, dict) else detail.get("value")
                    details[code] = None if code in details else numeric(value)
            rows.append(dict(record_type="lineup", fixture_id=fixture_id, team_id=team_id,
                             player_id=player["player_id"], player_name=player.get("player_name"),
                             started={"11": 1, "12": 0}.get(positive_id(player.get("type_id"))),
                             position=mapping(player.get("position")).get("name"),
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
        self.next_score_retry = {}
        self.next_optional = {}
        self.next_lineup_details = {}
        self.next_optional_request = 0

    def enrich(self, fixtures, league_id, season_id, *, finished=False):
        """Fetch each optional relation independently so it cannot mask a base result."""
        now = time.monotonic()
        if now < self.next_optional_request:
            return
        states = {str(key) for key in (FINISHED_STATES if finished else STATES)}
        scoped = {positive_id(row.get("id")): row for row in fixtures
                  if (positive_id(row.get("league_id")), positive_id(row.get("season_id"))) == (league_id, season_id)
                  and positive_id(row.get("state_id")) in states}
        scoped.pop("", None)
        if not scoped:
            return
        relations = [relation for relation in OPTIONAL_INCLUDES
                     if now >= self.next_optional.get((finished, relation), 0)
                     and any(optional_relation(row, relation) is None for row in scoped.values())]
        if not relations:
            return
        if finished:
            endpoint, params = fixture_details_endpoint(list(scoped)), {}
        else:
            endpoint, params = "livescores/inplay", {"filters": f"fixtureLeagues:{league_id}"}
        lineup_details = now >= self.next_lineup_details.get(finished, 0)
        with ThreadPoolExecutor(max_workers=len(relations)) as executor:
            requests = {relation: executor.submit(fetch_optional_fixtures, endpoint, params, relation, lineup_details)
                        for relation in relations}
            for relation, request in requests.items():
                try:
                    returned, lineup_fallback = request.result()
                except LiveUnavailable as error:
                    retry = OPTIONAL_ACCESS_RETRY if error.status in OPTIONAL_ACCESS_ERRORS else error.retry
                    self.next_optional[finished, relation] = time.monotonic() + retry
                    if error.status == 429:
                        self.next_optional_request = max(self.next_optional_request, time.monotonic() + retry)
                    continue
                if lineup_fallback:
                    self.next_lineup_details[finished] = time.monotonic() + OPTIONAL_ACCESS_RETRY
                for row in returned:
                    fixture = scoped.get(positive_id(row.get("id")))
                    if fixture is None or any(positive_id(row.get(key)) != positive_id(fixture.get(key))
                                              for key in ("league_id", "season_id", "state_id")):
                        continue
                    values = optional_relation(row, relation)
                    if values is not None:
                        fixture[relation] = values

    def confirm_finished(self, fixtures, league_id, season_id):
        now = time.monotonic()
        current = {positive_id(row.get("id")) for row in fixtures
                   if (positive_id(row.get("league_id")), positive_id(row.get("season_id"))) == (league_id, season_id)
                   and positive_id(row.get("state_id")) in {str(key) for key in STATES}}
        self.observed = {key: seen for key, seen in self.observed.items() if now - seen < 6 * 3600}
        self.observed.update({key: now for key in current if key})
        self.completed = {key: value for key, value in self.completed.items() if now - value[0] < 7 * 86400}
        self.next_score_retry = {key: retry for key, retry in self.next_score_retry.items() if key in self.observed}
        missing = sorted(key for key in set(self.observed) - current if now >= self.next_score_retry.get(key, 0))[:50]
        if missing and now >= self.next_confirmation:
            # Disappearing from in-play is not proof of full time. Confirm by ID.
            try:
                returned = fetch_fixture_details(missing)
                matching = [fixture for fixture in returned if positive_id(fixture.get("id")) in missing
                            and (positive_id(fixture.get("league_id")), positive_id(fixture.get("season_id")))
                            == (league_id, season_id)]
                self.enrich(matching, league_id, season_id, finished=True)
                for fixture in matching:
                    key = positive_id(fixture.get("id"))
                    state_id = positive_id(fixture.get("state_id"))
                    if state_id in {str(value) for value in FINISHED_STATES}:
                        rows = normalize([fixture], league_id, season_id, include_finished=True)
                        self.completed[key] = (now, csv_bytes(rows))
                        if all(rows[0][field] is not None for field in ("home_score", "away_score")):
                            self.observed.pop(key, None)
                            self.next_score_retry.pop(key, None)
                        else:
                            # Show the confirmed state while waiting for the provider's CURRENT score.
                            self.next_score_retry[key] = now + ERROR_SECONDS
                    elif state_id in {"10", "12", "14", "15", "17", "20"}:
                        self.observed.pop(key, None)
                        self.completed.pop(key, None)
                        self.next_score_retry.pop(key, None)
                self.next_confirmation = now + LIVE_SECONDS
            except LiveUnavailable as error:
                self.next_confirmation = now + error.retry
        return [row for key, (_, content) in self.completed.items() if key not in current
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
                    self.next_score_retry.clear()
                    self.next_optional.clear()
                    self.next_lineup_details.clear()
                    self.scope = (league_id, season_id)
                fixtures = fetch_inplay(league_id)
                self.enrich(fixtures, league_id, season_id)
                rows = normalize(fixtures, league_id, season_id)
                delay = LIVE_SECONDS if rows else IDLE_SECONDS
                rows.extend(self.confirm_finished(fixtures, league_id, season_id))
                meta.update(status="ok", fetched_at=utc_stamp(utc_now()))
            except LiveUnavailable as error:
                delay = error.retry
                meta.update(status="unavailable", message=str(error))
            except (OSError, UnicodeError, csv.Error, TypeError, ValueError, AttributeError, KeyError):
                meta.update(status="unavailable", message="Canlı maç verisi doğrulanamadı; yeniden denenecek.")
            meta["poll_seconds"] = delay
            self.cached = csv_bytes([meta, *rows])
            self.next_fetch = time.monotonic() + delay
            return self.cached
