"""User-run Sportmonks season downloader. All saved data is CSV."""
import argparse
from pathlib import Path

if __package__:
    from .sportmonks import Client, AccessError, RequestError, FINAL_DATA, RAW_DATA, league, token
    from .csv_store import read_tree, write_tree, write_table
    from .export_csv import export_tables
else:
    from sportmonks import Client, AccessError, RequestError, FINAL_DATA, RAW_DATA, league, token
    from csv_store import read_tree, write_tree, write_table
    from export_csv import export_tables
# Importing csv_store above puts the project folder on the path.
from src.shared import season_folder, season_label, utc_now, utc_stamp  # noqa: E402


def schedule_fixtures(value):
    found = {}
    def visit(node):
        if isinstance(node, dict):
            if "starting_at_timestamp" in node and "season_id" in node and "state_id" in node:
                found[node["id"]] = node
            else:
                for child in node.values(): visit(child)
        elif isinstance(node, list):
            for child in node: visit(child)
    visit(value)
    return found


def merge_fixture(old, new):
    for key, value in new.items():
        if key == "lineups" and isinstance(value, list):
            existing = {p["id"]: p for p in old.get("lineups", [])}
            for row in value: existing.setdefault(row["id"], {}).update(row)
            old[key] = list(existing.values())
        else:
            old[key] = value


class Download:
    def __init__(self, client, season, raw_folder, final_folder):
        self.client, self.season = client, season
        self.raw_folder, self.final_folder = Path(raw_folder), Path(final_folder)
        self.fixtures, self.resources, self.gaps = {}, {}, []
        self.includes = set()

    def resource(self, name, endpoint, paginated=False, required=False, **params):
        try:
            data = self.client.all(endpoint, **params) if paginated else self.client.get(endpoint, **params)["data"]
        except (AccessError, RequestError) as exc:
            if required or (isinstance(exc, RequestError) and exc.status not in (400,404,422)): raise
            self.gaps.append({"resource": name, "reason": str(exc)})
            print(f"Unavailable {name}: {exc}")
            return None
        self.resources[name] = data
        write_tree(self.raw_folder / "raw_resources" / f"{name}.csv", data)
        return data

    def fixture_group(self, ids, includes):
        try:
            rows = self.client.get("fixtures/multi/" + ",".join(map(str,ids)), include=";".join(includes))["data"]
            if not isinstance(rows,list) or len(rows) != len(ids) or {r["id"] for r in rows} != set(ids):
                raise RuntimeError("Fixture batch returned incomplete or unexpected IDs.")
        except (AccessError, RequestError) as exc:
            if isinstance(exc, RequestError) and (exc.status not in (400,404,422) or 'Invalid request parameters' in str(exc)): raise
            if len(includes) > 1:
                middle = len(includes)//2
                return self.fixture_group(ids, includes[:middle]) + self.fixture_group(ids, includes[middle:])
            self.gaps.append({"include": includes[0], "reason": str(exc)})
            print(f"Unavailable include {includes[0]}: {exc}")
            return []
        for row in rows:
            if row.get("season_id") != self.season["id"]: raise RuntimeError("Unexpected fixture season.")
            merge_fixture(self.fixtures[row["id"]], row)
        self.includes.update(includes)
        return includes

    def run(self):
        sid = self.season["id"]
        self.raw_folder.mkdir(parents=True, exist_ok=True)
        self.final_folder.mkdir(parents=True, exist_ok=True)
        write_table(self.final_folder / "download_status.csv", [{"status": "in_progress", "season": self.season["name"], "started_at_utc": utc_stamp(utc_now())}])
        try:
            self.collect(sid)
            counts = export_tables(self.final_folder, self.fixtures, self.resources)
            write_table(self.final_folder / "unavailable.csv", self.gaps, ["resource", "include", "reason"])
            write_table(self.final_folder / "included_feeds.csv", [{"include": name} for name in sorted(self.includes)], ["include"])
            write_table(self.final_folder / "download_status.csv", [{"status": "complete", "season": self.season["name"], "finished_at_utc": utc_stamp(utc_now()), "network_requests": self.client.calls}])
            print(f"Raw provider captures saved to {self.raw_folder}")
            print(f"Final CSV tables saved to {self.final_folder}")
            for name in ("fixtures", "players", "player_match_stats", "events"):
                print(f"{name}.csv: {counts[name]} rows")
            return counts
        except Exception as exc:
            write_table(self.final_folder / "download_status.csv", [{"status": "incomplete", "season": self.season["name"], "error": str(exc).replace(self.client.key, "[REDACTED]")}])
            raise

    def collect(self, sid):
        self.fixtures = schedule_fixtures(self.resource("schedule", f"schedules/seasons/{sid}", required=True))
        if not self.fixtures or any(f["season_id"] != sid for f in self.fixtures.values()):
            raise RuntimeError("Missing fixtures or unexpected season in schedule.")
        print(f"Season schedule: {len(self.fixtures)} fixtures")
        self.resource("season", f"seasons/{sid}", required=True, include="statistics;stages;rounds")
        teams = self.resource("teams", f"teams/seasons/{sid}", paginated=True, required=True, include="venue;coaches")
        self.resource("standings", f"standings/seasons/{sid}", include="participant;details.type;form;rule")
        self.resource("topscorers", f"topscorers/seasons/{sid}", paginated=True, include="player;participant;type")
        ids = sorted(self.fixtures)
        # "referees" gives each match's officials as ids; "referees.referee" adds
        # who they are, so fixture_referees.csv carries their names. Both are
        # asked for, so the ids still arrive if a plan refuses the names.
        groups = [
            ["participants","scores","state","round","stage","venue","referees","referees.referee","coaches","formations","periods"],
            ["events.type","statistics.type","lineups.details.type","lineups.position","lineups.player"],
            ["lineups.xGLineup.type","xGFixture.type","pressure","ballCoordinates","trends"],
            ["sidelined","metadata","weatherReport","tvStations","comments","timeline"],
            ["expectedLineups","predictions","prematchNews","postmatchNews"],
            ["odds","premiumOdds","inplayOdds"],
        ]
        for group in groups:
            supported = group
            for start in range(0,len(ids),25):
                if not supported: break
                batch = ids[start:start+25]
                supported = self.fixture_group(batch, supported)
                for fid in batch:
                    write_tree(self.raw_folder / "raw_fixtures" / f"{fid}.csv", self.fixtures[fid])
            print(f"Finished include group: {','.join(group)}")
        for team in teams:
            tid = team["id"]
            self.resource(f"squad-{tid}", f"squads/seasons/{sid}/teams/{tid}", include="player;position;details.type")
            # The season squad keeps everyone registered at any point this season,
            # including players who have since left. The current domestic squad is
            # what tells the fantasy pages who is still in the league.
            self.resource(f"current-squad-{tid}", f"squads/teams/{tid}")
            self.resource(f"team-statistics-{tid}", f"teams/{tid}", include="statistics.details.type", filters=f"teamstatisticSeasons:{sid}")
            self.resource(f"team-availability-{tid}", f"teams/{tid}", include="sidelined;coaches")
        played_rounds = {f.get("round_id") for f in self.fixtures.values() if f.get("events")}
        for rid in sorted(r for r in played_rounds if r):
            self.resource(f"standings-round-{rid}", f"standings/rounds/{rid}", include="participant;details.type;form")


def rebuild_csv(raw_folder, final_folder):
    """Rebuild flat tables from existing raw CSV files, without network calls."""
    fixtures = {int(path.stem): read_tree(path) for path in (raw_folder / "raw_fixtures").glob("*.csv")}
    resources = {path.stem: read_tree(path) for path in (raw_folder / "raw_resources").glob("*.csv")}
    if not fixtures or "schedule" not in resources:
        raise RuntimeError("Raw CSV files are missing. Run the downloader first.")
    if set(fixtures) != set(schedule_fixtures(resources["schedule"])):
        raise RuntimeError("Raw CSV fixture files do not match the season schedule.")
    return export_tables(final_folder, fixtures, resources)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--season", default="2026/2027")
    parser.add_argument("--refresh", action="store_true", help="Ignore CSV response cache")
    parser.add_argument("--rebuild-csv", action="store_true", help="Rebuild tables from raw CSV files without API calls")
    args = parser.parse_args()
    try:
        args.season, folder = season_label(args.season), season_folder(args.season)
    except ValueError as error:
        parser.error(str(error))
    raw_folder = RAW_DATA / folder
    final_folder = FINAL_DATA / folder
    client = None
    try:
        if args.rebuild_csv:
            rebuild_csv(raw_folder, final_folder)
            print(f"CSV tables rebuilt in {final_folder}")
            return
        client = Client(token(), args.refresh, max_requests=1200)
        matches = [s for s in league(client)["seasons"] if s["name"] == args.season]
        if len(matches)!=1: raise RuntimeError("Season is not uniquely available in your subscription.")
        Download(client, matches[0], raw_folder, final_folder).run()
    except Exception as exc:
        message = str(exc).replace(client.key, "[REDACTED]") if client else str(exc)
        parser.exit(1, f"Error: {message}\n")


if __name__ == "__main__":
    main()
