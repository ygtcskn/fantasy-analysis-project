"""Serve saved CSVs, XI recommendations and on-demand live Sportmonks CSVs. No data writes."""

import argparse
import csv
import io
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import sys
import time
from urllib.parse import urlsplit, parse_qs


WEB_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = WEB_ROOT.parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
from src.shared import season_folder  # noqa: E402

FINAL_ROOT = PROJECT_ROOT / "data" / "final"
DATA_ROOT = FINAL_ROOT / "sportmonks"
CSV_NAMES = {
    "fixtures.csv", "teams.csv", "players.csv", "squads.csv",
    "player_match_stats.csv", "standings.csv", "fixture_scores.csv",
}
# team_metrics.csv, events.csv, fixture_pressure.csv and fixture_periods.csv feed
# the team pages; current_squads.csv tells Kadro Kur who is still in the league;
# fixture_referees.csv gives Ana Sayfa each match's referee. Older exports may
# lack them, so they are optional.
OPTIONAL_CSV_NAMES = {"fixture_formations.csv", "download_status.csv", "team_metrics.csv",
                      "events.csv", "fixture_pressure.csv", "fixture_periods.csv",
                      "current_squads.csv", "fixture_referees.csv"}
# Earlier seasons are read only to widen the radar's reference population; the
# player's own plotted values always come from the served season.
HISTORY_NAMES = {"fixtures.csv", "player_match_stats.csv", "squads.csv", "team_metrics.csv", "spider_stats.csv"}

# The website is one folder - core/, data/, lib/, features/, styles/, assets/ -
# so it is served as one folder rather than as a list of files that has to be
# edited whenever a page gains a script. Only these suffixes are ever served,
# which is why serve.py itself, the READMEs beside the code and anything else
# in here stay unreachable; the resolved path is still checked against the root
# below, so no request can climb out of it.
ASSET_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
}
# Lower case, no leading dot on any segment, so ".." and hidden files cannot match.
ASSET_PATH = re.compile(r"/(?:[a-z0-9][a-z0-9._-]*/)*[a-z0-9][a-z0-9._-]*"
                        r"\.(?:html|js|css|svg|png|jpg)")

MAX_BYTES = 40 * 1024 * 1024


def read_file(path):
    """Retry brief Windows file locks, such as antivirus/logo scan contention."""
    for attempt in range(3):
        try:
            with path.open("rb") as source:
                return source.read(MAX_BYTES + 1)
        except FileNotFoundError:
            raise
        except OSError:
            if attempt == 2:
                raise
            time.sleep(0.04 * (attempt + 1))


def history_seasons():
    """Season folders the radar can pool: complete enough to scope and aggregate."""
    return sorted(path.name for path in DATA_ROOT.iterdir()
                  if path.is_dir() and re.fullmatch(r"\d{4}-\d{4}", path.name)
                  and (path / "fixtures.csv").is_file()
                  and (FINAL_ROOT / "spider" / path.name / "spider_stats.csv").is_file())


def analysis_files(season):
    """Published analysis outputs by /local-data/ path; temp runs stay private.

    src/web/build_static.py publishes the same map, so the local and public
    sites read the same files.
    """
    return {
        "odds/predictions.csv": FINAL_ROOT / "odds" / "predictions.csv",
        "points/player_season_summary.csv": FINAL_ROOT / "points" / "player_season_summary.csv",
        "points/player_match_points.csv": FINAL_ROOT / "points" / "player_match_points.csv",
        "player_projections/player_projections.csv": FINAL_ROOT / "player_projections" / season / "player_projections.csv",
        "fantasy_pipeline/pipeline_status.csv": FINAL_ROOT / "fantasy_pipeline" / season / "pipeline_status.csv",
    }


def make_handler(csv_root, live_enabled=True):
    from src.web.live import LiveFeed
    live_feed = LiveFeed(csv_root, enabled=live_enabled)
    fantasy_files = analysis_files(csv_root.name)

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.serve_file()

        def do_HEAD(self):
            self.serve_file(head_only=True)

        def serve_file(self, head_only=False):
            # Reject alternate hostnames; this server is for this computer only.
            port = self.server.server_port
            if self.headers.get("Host") not in {f"127.0.0.1:{port}", f"localhost:{port}"}:
                self.send_error(403, "Open the printed localhost URL.")
                return
            path = urlsplit(self.path).path
            if path == "/local-live.csv":
                if self.headers.get("Sec-Fetch-Site") not in {None, "same-origin", "none"}:
                    self.send_error(403, "Use the local website.")
                    return
                self.send_bytes(live_feed.snapshot(head_only), "text/csv; charset=utf-8", head_only)
                return
            if path == "/local-recommendations.csv":
                if self.headers.get("Sec-Fetch-Site") not in {None, "same-origin", "none"}:
                    self.send_error(403, "Use the local website.")
                    return
                from src.xi_optimizer.xi_recommendations import recommendations, FIELDS
                try:
                    query = parse_qs(urlsplit(self.path).query, max_num_fields=10)
                except ValueError:
                    self.send_error(400, "Invalid optimizer request.")
                    return
                rows = [] if head_only else recommendations(csv_root.name, query)
                stream = io.StringIO(newline="")
                writer = csv.DictWriter(stream, fieldnames=FIELDS)
                writer.writeheader(); writer.writerows(rows)
                content = stream.getvalue().encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/csv; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                if not head_only:
                    try:
                        self.wfile.write(content)
                    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                        pass
                return
            if path == "/local-data/history/seasons.csv":
                stream = io.StringIO(newline="")
                writer = csv.writer(stream)
                writer.writerow(["season"])
                writer.writerows([season] for season in ([] if head_only else history_seasons()))
                self.send_bytes(stream.getvalue().encode("utf-8"), "text/csv; charset=utf-8", head_only)
                return
            history = re.fullmatch(r"/local-data/history/(\d{4}-\d{4})/([a-z_]+\.csv)", path)
            csv_name = path.removeprefix("/local-data/")
            if history and history[2] in HISTORY_NAMES:
                root = FINAL_ROOT / "spider" / history[1] if history[2] == "spider_stats.csv" else DATA_ROOT / history[1]
                relative, content_type = history[2], "text/csv; charset=utf-8"
            elif path == "/local-data/spider/spider_stats.csv":
                root, relative, content_type = FINAL_ROOT / "spider" / csv_root.name, "spider_stats.csv", "text/csv; charset=utf-8"
            elif path.startswith("/local-data/") and csv_name in CSV_NAMES | OPTIONAL_CSV_NAMES:
                root, relative, content_type = csv_root, csv_name, "text/csv; charset=utf-8"
            elif path.startswith("/local-data/") and csv_name in fantasy_files:
                file = fantasy_files[csv_name]
                root, relative, content_type = file.parent, file.name, "text/csv; charset=utf-8"
            elif ASSET_PATH.fullmatch(path if path != "/" else "/index.html"):
                relative = (path if path != "/" else "/index.html").lstrip("/")
                root, content_type = WEB_ROOT, ASSET_TYPES[Path(relative).suffix]
            else:
                self.send_error(404, "File not available.")
                return
            file_path = (root / relative).resolve()
            if not file_path.is_relative_to(root.resolve()):
                self.send_error(403, "File outside the allowed folder.")
                return
            try:
                content = read_file(file_path)
            except FileNotFoundError:
                self.send_error(404, "Saved file not found.")
                return
            except OSError:
                self.send_error(503, "Saved file unavailable; try again after the download finishes.")
                return
            if len(content) > MAX_BYTES:
                self.send_error(413, "File exceeds the 40 MB limit.")
                return
            self.send_bytes(content, content_type, head_only)

        def send_bytes(self, content, content_type, head_only):
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Superlig-Local", "1")
            self.send_header("X-Superlig-Season", csv_root.name)
            self.end_headers()
            if not head_only:
                try:
                    self.wfile.write(content)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass  # The browser navigated away during a response.

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--season", type=season_folder, default="2026/2027")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-live", action="store_true", help="Disable on-demand Sportmonks live requests.")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("Port must be between 1 and 65535.")
    csv_root = DATA_ROOT / args.season
    if not csv_root.is_dir():
        parser.error(f"Season CSV folder not found: {csv_root}")
    missing = sorted(name for name in CSV_NAMES if not (csv_root / name).is_file())
    if missing:
        parser.error(f"Missing season CSVs: {', '.join(missing)}")
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(csv_root, live_enabled=not args.no_live))
    except OSError as error:
        parser.exit(1, f"Cannot start the local server: {error}\nTry --port 8001 if the port is busy.\n")
    print(f"Open http://127.0.0.1:{args.port}")
    print(f"Reading saved CSVs from: {csv_root}")
    print("After a download finishes, refresh the page or click Refresh saved data.")
    print("Live Sportmonks requests disabled." if args.no_live else
          "Live Sportmonks data is requested only while the Matchweek page is visible.")
    print("Keep this terminal open. Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nLocal server stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
