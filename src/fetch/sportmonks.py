"""Sportmonks v3 client with CSV-only response caching."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import time
import unicodedata
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
if __package__:
    from .csv_store import read_tree, write_tree, redact
else:
    from csv_store import read_tree, write_tree, redact

ROOT = Path(__file__).resolve().parents[2]
RAW_DATA = ROOT / "data" / "raw" / "sportmonks"
FINAL_DATA = ROOT / "data" / "final" / "sportmonks"
# Kept as the public analysis-table root used by audit/build utilities.
DATA = FINAL_DATA
CACHE = ROOT / "data" / "temp" / "cache_csv"
BASE = "https://api.sportmonks.com/v3/football"


def token():
    value = os.environ.get("SPORTMONKS_API_TOKEN", "").strip()
    if not value and (ROOT / ".env").exists():
        for line in (ROOT / ".env").read_text(encoding="utf-8-sig").splitlines():
            name, sep, item = line.partition("=")
            if sep and name.strip() == "SPORTMONKS_API_TOKEN":
                value = item.strip().strip("\"'")
    if not value:
        raise RuntimeError("Add SPORTMONKS_API_TOKEN to the project .env file.")
    return value


class AccessError(RuntimeError):
    pass


class RequestError(RuntimeError):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


class Client:
    def __init__(self, key, refresh=False, max_requests=60):
        self.key, self.refresh = key, refresh
        self.calls, self.last = 0, 0
        self.max_requests = max_requests
        self.rate_limits = {}

    def get(self, endpoint, **params):
        query = urlencode(sorted(params.items()))
        cache = CACHE / (hashlib.sha256(f"{endpoint}?{query}".encode()).hexdigest() + ".csv")
        if cache.exists() and not self.refresh:
            saved = read_tree(cache)
            if time.time() - saved["fetched_at"] < 86400:
                return saved["payload"]
        if self.calls >= self.max_requests:
            raise RuntimeError(f"{self.max_requests}-request local budget reached; cached progress preserved.")
        time.sleep(max(0, 1.1 - (time.monotonic() - self.last)))
        self.last = time.monotonic()
        self.calls += 1
        req = Request(f"{BASE}/{endpoint}?{query}", headers={"Authorization": self.key})
        try:
            with urlopen(req, timeout=30) as response:
                payload = json.load(response)
        except HTTPError as exc:
            try:
                message = str(json.load(exc).get("message", ""))[:500].replace(self.key, "[REDACTED]")
            except (ValueError, AttributeError):
                message = ""
            if exc.code in (402, 403):
                raise AccessError(f"Sportmonks HTTP {exc.code}: {message or 'Resource requires different subscription access.'}") from None
            raise RequestError(exc.code, f"Sportmonks HTTP {exc.code}: {message}") from None
        except URLError:
            raise RuntimeError("Could not reach Sportmonks. Check network access.") from None
        if not isinstance(payload, dict) or "data" not in payload:
            raise RuntimeError("Sportmonks returned no data envelope: " + str(payload.get("message", "Unexpected response") if isinstance(payload, dict) else "Unexpected response").replace(self.key, "[REDACTED]"))
        if not isinstance(payload["data"], (list, dict)):
            raise RuntimeError("Unexpected Sportmonks data shape.")
        limit = payload.get("rate_limit") or {}
        if limit.get("requested_entity"):
            self.rate_limits[limit["requested_entity"]] = limit
        cache.parent.mkdir(parents=True, exist_ok=True)
        # Sanitize even provider-generated pagination URLs before caching.
        write_tree(cache, redact({"endpoint": endpoint, "params": params, "fetched_at": time.time(), "payload": payload}, self.key))
        label = "fixtures batch" if endpoint.startswith("fixtures/multi/") else endpoint
        print(f"Fetched {label}")
        return payload

    def all(self, endpoint, **params):
        rows = []
        for page in range(1, 61):
            payload = self.get(endpoint, **params, per_page=50, page=page)
            if not isinstance(payload["data"], list):
                raise RuntimeError("Expected a paginated result list.")
            rows.extend(payload["data"])
            pagination = payload.get("pagination") or {}
            if not pagination.get("has_more", False):
                return rows
        raise RuntimeError("Pagination exceeds sample budget; refusing partial results.")


def normalized(name):
    name = unicodedata.normalize("NFKD", name.casefold().replace("ı", "i"))
    return "".join(c for c in name if c.isalnum() and not unicodedata.combining(c))


def league(client):
    leagues = client.all("leagues", include="country;seasons;currentSeason")
    matches = [r for r in leagues if normalized(r["name"]) == "superlig"
               and normalized((r.get("country") or {}).get("name", "")) in {"turkey", "turkiye"}]
    if len(matches) != 1:
        names = ", ".join(r["name"] for r in leagues)
        raise RuntimeError(f"Turkey's Super Lig was not uniquely available. Check selected leagues in MySportmonks. Accessible: {names}")
    return matches[0]


def metrics(lineup):
    result = []
    for source, records in (("details", lineup.get("details") or []), ("xg", lineup.get("xglineup") or lineup.get("xGLineup") or [])):
        for item in records:
            detail_type = item.get("type") or {}
            name = detail_type.get("developer_name") or detail_type.get("code") or detail_type.get("name") or f"type_{item.get('type_id')}"
            value = item["data"].get("value") if isinstance(item.get("data"), dict) else item.get("value")
            result.append({"source": source, "type_id": item.get("type_id"), "name": name, "value": value})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["discover"])
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()
    client = None
    try:
        client = Client(token(), args.refresh)
        competition = league(client)
        print(f"League: {competition['name']} (ID {competition['id']})")
        for season in competition.get("seasons", []):
            print(f"Season: {season['name']} (ID {season['id']})")
    except (RuntimeError, ValueError, OSError) as exc:
        message = str(exc)
        if client:
            message = message.replace(client.key, "[REDACTED]")
        parser.exit(1, f"Error: {message}\n")


if __name__ == "__main__":
    main()
