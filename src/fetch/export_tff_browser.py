"""Export the visible TFF player table through an interactive browser.

Run this yourself. Optional TFF_FANTASY_EMAIL and TFF_FANTASY_PASSWORD settings
in the project .env enable normal form login. Otherwise sign in interactively.
No passwords or login sessions are exported.
"""
import argparse
from datetime import datetime, timezone
from pathlib import Path
import os
import re
from urllib.parse import urlsplit

if __package__:
    from .csv_store import write_table
    from .parse_tff_table import ROOT, parse_table
    from .update_tff_players import update_from_snapshot
else:
    from csv_store import write_table
    from parse_tff_table import ROOT, parse_table
    from update_tff_players import update_from_snapshot

URL = "https://tfffantezilig.com/istatistikler"
EXTRA_COLUMNS = (
    "Maç Haftası Puanı", "Oynanan Dakika", "Atılan Goller",
    "Asistler", "Gol Yememe", "Yenilen Goller",
)
REQUIRED_COLUMNS = {"mhp", "od", "ag", "asist", "gy", "yg"}
RANGE_PATTERN = re.compile(r"(?<!\d)(\d+)\s*[-–]\s*(\d+)\s*/\s*(\d+)(?!\d)")
AUTH_READY_JS = """() =>
    location.origin === 'https://tfffantezilig.com' &&
    location.pathname.replace(/\\/$/, '') !== '/giris' && (
        [...document.querySelectorAll('a[href]')].some(a =>
            a.getAttribute('href').split('?')[0] === '/istatistikler') ||
        [...document.querySelectorAll('th')].some(th => th.textContent.trim() === 'Oyuncu'))
"""


def login_credentials():
    """Read just the two login settings; never log them or modify .env.

    Environment variables take precedence. Matching outer quotes in .env are
    removed without interpreting escapes, interpolation, or inline comments,
    so passwords may contain #, =, backslashes, and dollar signs literally.
    """
    keys = ("TFF_FANTASY_EMAIL", "TFF_FANTASY_PASSWORD")
    values = {key: os.environ.get(key) for key in keys}
    path = ROOT / ".env"
    if any(value is None for value in values.values()) and path.exists():
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            name, sep, value = line.partition("=")
            name = name.strip()
            if sep and name in keys and os.environ.get(name) is None:
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                    value = value[1:-1]
                values[name] = value
    email = (values[keys[0]] or "").strip()
    password = values[keys[1]] or ""
    if bool(email) != bool(password):
        raise ValueError("Set both TFF_FANTASY_EMAIL and TFF_FANTASY_PASSWORD in .env, "
                         "or leave both empty for manual login.")
    return email, password


def sign_in_if_needed(page, login_timeout):
    # Wait for either the login form or signed-in navigation, including a
    # possible client-side redirect after the initial document load.
    page.wait_for_function("""() => {
        const ready = (""" + AUTH_READY_JS + """)();
        const password = document.querySelector('input[type="password"]');
        return ready || (location.origin === 'https://tfffantezilig.com' &&
            location.pathname.replace(/\\/$/, '') === '/giris' &&
            password && password.getBoundingClientRect().height > 0);
    }""")
    if page.evaluate(AUTH_READY_JS):
        return
    location = urlsplit(page.url)
    if (location.scheme, location.netloc, location.path.rstrip("/")) != (
            "https", "tfffantezilig.com", "/giris"):
        raise ValueError("Automatic login requires the TFF Fantasy HTTPS login page.")
    email, password = login_credentials()
    if email and password:
        print("Logging in using the credentials in your local environment/.env.")
        email_field = page.get_by_placeholder(re.compile(r"^E-posta adresi$", re.IGNORECASE))
        password_field = page.locator('input[type="password"]')
        email_field.fill(email)
        password_field.fill(password)
        # Click once; do not retry rejected credentials or handle challenges
        # automatically. Browser exceptions are sanitized by main().
        page.get_by_role("button", name="Giriş Yapın", exact=True).click()
        email = password = ""
        print("Waiting for login. Complete any verification in the browser; "
              "if login is rejected, correct it there or update .env and rerun.")
    else:
        print("No TFF login credentials configured. Sign in in the opened browser.")
    page.wait_for_function(AUTH_READY_JS, timeout=login_timeout * 1000)

# Read rendered DOM only, including the visible pagination count. This does
# not inspect application stores, request private endpoints, or run site code.
SNAPSHOT_JS = """() => {
    const tables = [...document.querySelectorAll('table')].filter(table =>
        table.getBoundingClientRect().height > 0 &&
        table.querySelector('th')?.textContent.trim() === 'Oyuncu');
    if (tables.length !== 1) return null;
    return {html: tables[0].outerHTML, text: document.body.innerText};
}"""


def read_page(page):
    snapshot = page.evaluate(SNAPSHOT_JS)
    if snapshot is None:
        raise ValueError("Expected one visible player table. Check the Turkish statistics page.")
    ranges = RANGE_PATTERN.findall(snapshot["text"])
    if len(ranges) != 1:
        raise ValueError("Cannot identify the displayed pagination range (for example 1-100 / 509).")
    start, end, total = map(int, ranges[0])
    columns, records = parse_table(snapshot["html"])
    if not 1 <= start <= end <= total or len(records) != end - start + 1:
        raise ValueError("The table rows and pagination range disagree; retry after the page settles.")
    return columns, records, start, end, total


def column_checkbox(page, label):
    control = page.get_by_role("checkbox", name=label, exact=True)
    if control.count() == 1:
        return control
    control = page.get_by_label(label, exact=True)
    if control.count() == 1:
        return control
    # Some custom menus put their label beside, rather than around, the
    # checkbox. Look only within the nearest small containers for this label.
    text = page.get_by_text(label, exact=True)
    if text.count() == 1:
        container = text
        for _ in range(2):
            container = container.locator("..")
            controls = container.locator('input[type="checkbox"], [role="checkbox"]')
            if controls.count() == 1:
                return controls
    raise ValueError(f"Cannot locate the checkbox for '{label}'. The menu markup may have changed.")


def select_columns(page):
    button = page.get_by_role("button", name="Kolonlar", exact=True)
    for label in EXTRA_COLUMNS:
        if not page.get_by_text(label, exact=True).is_visible():
            button.click()
        column_checkbox(page, label).set_checked(True)
    if page.get_by_text(EXTRA_COLUMNS[-1], exact=True).is_visible():
        button.click()
    table = page.locator("table").filter(has=page.get_by_role("columnheader", name="Oyuncu", exact=True))
    table.get_by_role("columnheader", name="YG", exact=True).wait_for()


def wait_for_next_page(page, start):
    # Wait for pagination and player content to render before parsing HTML.
    page.wait_for_function("""expected => {
        const matches = [...document.body.innerText.matchAll(/(\\d+)\\s*[-–]\\s*(\\d+)\\s*\\/\\s*(\\d+)/g)];
        if (matches.length !== 1 || Number(matches[0][1]) !== expected) return false;
        const table = [...document.querySelectorAll('table')].find(t =>
            t.getBoundingClientRect().height > 0 && t.querySelector('th')?.textContent.trim() === 'Oyuncu');
        const rows = table ? [...table.querySelectorAll('tbody tr')].filter(r => r.querySelector('td p')) : [];
        return rows.length === Number(matches[0][2]) - expected + 1;
    }""", arg=start)
    page.wait_for_timeout(1100)


def collect_pages(page, max_pages, expected_rows=None):
    all_rows, columns, total, previous_end = [], None, None, 0
    seen_pages = set()
    for number in range(1, max_pages + 1):
        page_columns, records, start, end, page_total = read_page(page)
        if start != previous_end + 1:
            raise ValueError("Pagination skipped rows or did not start at page 1. No CSV written.")
        if columns is None:
            columns, total = page_columns, page_total
            if not REQUIRED_COLUMNS <= set(columns):
                raise ValueError("Some requested statistic columns are missing. No CSV written.")
            if expected_rows is not None and total != expected_rows:
                raise ValueError(f"The site displays {total} players, but --expected-rows is {expected_rows}.")
        elif set(columns) != set(page_columns) or total != page_total:
            raise ValueError("The selected columns or player total changed while exporting. No CSV written.")
        signature = tuple(sorted(tuple(row[key] for key in columns) for row in records))
        if signature in seen_pages:
            raise ValueError("A page repeated while navigating. No CSV written.")
        seen_pages.add(signature)
        all_rows.extend(records)
        print(f"Page {number}: rows {start}-{end} of {total}")
        previous_end = end
        if end == total:
            if len(all_rows) != total:
                raise ValueError("Final row count does not match the displayed total.")
            return columns, all_rows
        next_button = page.get_by_role("button", name="Sonraki", exact=True)
        if next_button.count() != 1 or not next_button.is_enabled():
            raise ValueError("Next page is unavailable before reaching the total. No CSV written.")
        next_button.click()
        wait_for_next_page(page, end + 1)
    raise ValueError(f"Reached the {max_pages}-page limit before completion. No CSV written.")


def export(args, sync_playwright):
    with sync_playwright() as playwright:
        # Fresh, nonpersistent context. Use normal form login each run;
        # do not save storage_state, browser profiles, HARs or traces.
        browser = playwright.chromium.launch(headless=False)
        try:
            context = browser.new_context(locale="tr-TR", viewport={"width": 1440, "height": 1000})
            page = context.new_page()
            page.set_default_timeout(30000)
            print("Opening TFF Statistics. Automatic login uses the project .env when configured.")
            print("Use the Turkish interface; keep the browser open for any login verification.")
            page.goto(URL, wait_until="domcontentloaded")
            sign_in_if_needed(page, args.login_timeout)
            if page.url.split("?")[0].rstrip("/") != URL:
                page.goto(URL, wait_until="domcontentloaded")
            page.get_by_role("columnheader", name="Oyuncu", exact=True).wait_for()
            print("Selecting all six extra columns. Leave the browser untouched during export.")
            select_columns(page)
            # A new browser context starts without stored filters. Clear any
            # restored text search; the optional expected count catches a
            # filtered catalogue. Do not guess dropdown option meanings.
            search = page.get_by_placeholder("Oyuncu veya takım ara...", exact=True)
            if search.count() == 1:
                search.fill("")
            page.wait_for_timeout(1100)
            # Return to the first page if the site restored pagination.
            for _ in range(args.max_pages):
                _, _, start, _, _ = read_page(page)
                if start == 1:
                    break
                previous = page.get_by_role("button", name="Önceki", exact=True)
                if previous.count() != 1 or not previous.is_enabled():
                    raise ValueError("Cannot return to the first player page.")
                previous.click()
                page.wait_for_timeout(1100)
            else:
                raise ValueError("Could not reach the first page within the page limit.")
            columns, records = collect_pages(page, args.max_pages, args.expected_rows)
            write_table(args.output, records, columns)
            print(f"Saved snapshot with {len(records)} players to {args.output.resolve()}")
            temp_tff_dir = ROOT / "data" / "temp" / "tff_fantasy"
            sportmonks_dir = (ROOT / "data" / "final" / "sportmonks" /
                              args.season.replace("/", "-"))
            canonical = ROOT / "data" / "final" / "tff_fantasy" / "tff_players.csv"
            total, matched, unresolved = update_from_snapshot(
                args.output, sportmonks_dir, canonical,
                ROOT / "config" / "tff_player_overrides.csv",
                temp_tff_dir / "tff_player_match_report.csv",
                temp_tff_dir / "tff_player_match_candidates.csv")
            print(f"Updated canonical table: {total} rows, {matched} matched, "
                  f"{unresolved} awaiting review: {canonical.resolve()}")
        finally:
            browser.close()


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--season", default="2026/2027", help="Sportmonks season used for ID matching")
    cli.add_argument("--output", type=Path, help="CSV destination; default is a new timestamped file")
    cli.add_argument("--expected-rows", type=int, help="Optional expected catalogue size, e.g. 509")
    cli.add_argument("--max-pages", type=int, default=100)
    cli.add_argument("--login-timeout", type=int, default=300, help="Seconds allowed for interactive login")
    cli.add_argument("--overwrite", action="store_true")
    args = cli.parse_args()
    if not re.fullmatch(r"\d{4}/\d{4}", args.season):
        cli.error("Season must look like 2026/2027.")
    if args.output is None:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        args.output = (ROOT / "data" / "raw" / "tff_fantasy" /
                       f"players_{stamp}.csv")
    if args.max_pages < 1 or args.login_timeout < 1 or (args.expected_rows is not None and args.expected_rows < 1):
        cli.error("Page limit, login timeout and expected rows must be positive.")
    if args.output.suffix.lower() != ".csv":
        cli.error("Output must have a .csv extension.")
    if args.output.exists() and not args.overwrite:
        cli.error("Output exists; use another destination or --overwrite.")
    try:
        from playwright.sync_api import Error as BrowserError, sync_playwright
    except ImportError:
        cli.exit(1, "Install first: python -m pip install playwright\n"
                    "Then: python -m playwright install chromium\n")
    try:
        export(args, sync_playwright)
    except BrowserError:
        # Avoid dumping browser logs, URLs or account content from failures.
        cli.exit(1, "Browser action failed or timed out. Check your local TFF login settings, "
                    "verification, Turkish labels and overlays. "
                    "If Chromium is missing, run: python -m playwright install chromium\n")
    except (ValueError, OSError) as exc:
        cli.exit(1, f"Error: {exc}\n")
    except KeyboardInterrupt:
        cli.exit(130, "Export cancelled.\n")


if __name__ == "__main__":
    main()
