"""Serve saved CSVs and on-demand XI recommendations. No provider requests or data writes."""

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
FINAL_ROOT = PROJECT_ROOT / "data" / "final"
DATA_ROOT = FINAL_ROOT / "sportmonks"
CSV_NAMES = {
    "fixtures.csv", "teams.csv", "players.csv", "squads.csv",
    "player_match_stats.csv", "standings.csv", "fixture_scores.csv",
}
# team_metrics.csv, events.csv, fixture_pressure.csv and fixture_periods.csv feed
# the team pages; older exports may lack them, so they are optional.
OPTIONAL_CSV_NAMES = {"fixture_formations.csv", "download_status.csv", "team_metrics.csv",
                      "events.csv", "fixture_pressure.csv", "fixture_periods.csv"}
# Earlier seasons are read only to widen the radar's reference population; the
# player's own plotted values always come from the served season.
HISTORY_NAMES = {"fixtures.csv", "player_match_stats.csv", "squads.csv", "team_metrics.csv"}

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
}
# Lower case, no leading dot on any segment, so ".." and hidden files cannot match.
ASSET_PATH = re.compile(r"/(?:[a-z0-9][a-z0-9._-]*/)*[a-z0-9][a-z0-9._-]*"
                        r"\.(?:html|js|css|svg|png)")

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


def season_name(value):
    if not re.fullmatch(r"\d{4}/\d{4}", value):
        raise argparse.ArgumentTypeError("Use a season like 2026/2027.")
    first, last = map(int, value.split("/"))
    if last != first + 1:
        raise argparse.ArgumentTypeError("Season years must be consecutive.")
    return value.replace("/", "-")


def history_seasons():
    """Season folders the radar can pool: complete enough to scope and aggregate."""
    return sorted(path.name for path in DATA_ROOT.iterdir()
                  if path.is_dir() and re.fullmatch(r"\d{4}-\d{4}", path.name)
                  and all((path / name).is_file() for name in ("fixtures.csv", "player_match_stats.csv")))


def make_handler(csv_root):
    # Every season total, ranking and percentile the site draws is built by
    # src/tables and published here; the browser only renders them. Resolved per
    # request, so a pipeline run that adds a table needs no restart.
    tables_root = FINAL_ROOT / "tables" / csv_root.name

    # Only published analysis outputs are available; temp runs stay private.
    fantasy_files = {
        "odds/predictions.csv": FINAL_ROOT / "odds" / "predictions.csv",
        "points/player_season_summary.csv": FINAL_ROOT / "points" / "player_season_summary.csv",
        "points/player_match_points.csv": FINAL_ROOT / "points" / "player_match_points.csv",
        "player_projections/player_projections.csv": FINAL_ROOT / "player_projections" / csv_root.name / "player_projections.csv",
        "fantasy_pipeline/pipeline_status.csv": FINAL_ROOT / "fantasy_pipeline" / csv_root.name / "pipeline_status.csv",
    }

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
                root, relative, content_type = DATA_ROOT / history[1], history[2], "text/csv; charset=utf-8"
            elif path.startswith("/local-data/") and csv_name in CSV_NAMES | OPTIONAL_CSV_NAMES:
                root, relative, content_type = csv_root, csv_name, "text/csv; charset=utf-8"
            elif path.startswith("/local-data/") and csv_name in fantasy_files:
                file = fantasy_files[csv_name]
                root, relative, content_type = file.parent, file.name, "text/csv; charset=utf-8"
            elif re.fullmatch(r"/local-data/tables/[a-z0-9_]+\.csv", path):
                root, relative = tables_root, csv_name.removeprefix("tables/")
                content_type = "text/csv; charset=utf-8"
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
    parser.add_argument("--season", type=season_name, default="2026/2027")
    parser.add_argument("--port", type=int, default=8000)
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
        server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(csv_root))
    except OSError as error:
        parser.exit(1, f"Cannot start the local server: {error}\nTry --port 8001 if the port is busy.\n")
    print(f"Open http://127.0.0.1:{args.port}")
    print(f"Reading saved CSVs from: {csv_root}")
    print("After a download finishes, refresh the page or click Refresh saved data.")
    print("Keep this terminal open. Press Ctrl+C to stop. No Sportmonks calls are made.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nLocal server stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
