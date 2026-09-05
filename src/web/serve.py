"""Serve the local website and saved season CSVs. No provider requests or writes."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import time
from urllib.parse import urlsplit


WEB_ROOT = Path(__file__).resolve().parent
DATA_ROOT = WEB_ROOT.parents[1] / "data" / "final" / "sportmonks"
CSV_NAMES = {
    "fixtures.csv", "teams.csv", "players.csv", "squads.csv",
    "player_match_stats.csv", "standings.csv", "fixture_scores.csv",
}
OPTIONAL_CSV_NAMES = {"fixture_formations.csv"}
ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/team.html": ("team.html", "text/html; charset=utf-8"),
    "/team-page.js": ("team-page.js", "text/javascript; charset=utf-8"),
    "/csv.js": ("csv.js", "text/javascript; charset=utf-8"),
    "/sidebar.js": ("sidebar.js", "text/javascript; charset=utf-8"),
    "/standings.js": ("standings.js", "text/javascript; charset=utf-8"),
    "/builder.js": ("builder.js", "text/javascript; charset=utf-8"),
    "/kits.js": ("kits.js", "text/javascript; charset=utf-8"),
    "/builder.css": ("builder.css", "text/css; charset=utf-8"),
    "/team-page.css": ("team-page.css", "text/css; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/home.js": ("home.js", "text/javascript; charset=utf-8"),
    "/tier-list.js": ("tier-list.js", "text/javascript; charset=utf-8"),
}
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


def make_handler(csv_root):
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
            csv_name = path.removeprefix("/local-data/")
            if path.startswith("/local-data/") and csv_name in CSV_NAMES | OPTIONAL_CSV_NAMES:
                root, relative, content_type = csv_root, csv_name, "text/csv; charset=utf-8"
            elif path in ASSETS:
                relative, content_type = ASSETS[path]
                root = WEB_ROOT
            elif re.fullmatch(r"/assets/team-logos/[0-9]+\.(svg|png)", path):
                root, relative = WEB_ROOT, path.lstrip("/")
                content_type = "image/svg+xml" if path.endswith(".svg") else "image/png"
            elif re.fullmatch(r"/assets/roles/(all|goalkeeper|defender|midfielder|attacker)\.svg", path):
                root, relative, content_type = WEB_ROOT, path.lstrip("/"), "image/svg+xml"
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
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Superlig-Local", "1")
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
