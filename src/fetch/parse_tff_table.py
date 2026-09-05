"""Extract a manually saved TFF statistics HTML table into a local CSV.

No network access or login is involved. Only rows present in the input are
exported; a copied page is not necessarily the complete player catalogue.
"""
import argparse
from html.parser import HTMLParser
from pathlib import Path
import re
import unicodedata

if __package__:
    from .csv_store import write_table
else:
    from csv_store import write_table

ROOT = Path(__file__).resolve().parents[2]
VOID_TAGS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
    "meta", "param", "source", "track", "wbr",
}
# Keep abbreviations whose tooltip descriptions are absent from copied HTML.
COLUMNS = {
    "Fiyat": "price_million_try", "SO%": "so_percent", "Form": "form",
    "TP": "tp", "MHP": "mhp", "OD": "od", "AG": "ag", "Asist": "asist",
    "GY": "gy", "YG": "yg",
}


class Element:
    def __init__(self, tag, attrs=()):
        self.tag = tag
        self.attrs = dict(attrs)
        self.children = []
        self.closed = tag in VOID_TAGS

    def text(self):
        # Preserve text-node boundaries; ignore layout whitespace.
        return " ".join(" ".join(
            child.text() if isinstance(child, Element) else child
            for child in self.children
        ).split())

    def find_all(self, tag):
        for child in self.children:
            if isinstance(child, Element):
                if child.tag == tag:
                    yield child
                yield from child.find_all(tag)


class TableParser(HTMLParser):
    """Build a small element tree using Python's built-in HTML parser."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Element("document")
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        element = Element(tag, attrs)
        self.stack[-1].children.append(element)
        if tag not in VOID_TAGS:
            self.stack.append(element)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID_TAGS:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                self.stack[index].closed = True
                del self.stack[index:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def cells(row):
    return [child for child in row.children
            if isinstance(child, Element) and child.tag in {"th", "td"}]


def numeric_text(value, header):
    """Remove display units, preserving decimal precision, blanks and zero."""
    if value in {"", "—", "–", "-"}:
        return ""
    pattern = r"[-+]?\d+(?:\.\d+)?"
    if header == "Fiyat":
        match = re.fullmatch(r"₺\s*(\d+(?:\.\d+)?)\s*[mM]", value)
    elif header == "SO%":
        match = re.fullmatch(r"(" + pattern + r")\s*%", value)
    else:
        match = re.fullmatch(r"(" + pattern + r")", value)
    if not match:
        raise ValueError(f"Unrecognized {header} value: {value!r}")
    return match.group(1)


def column_name(header):
    if header in COLUMNS:
        return COLUMNS[header]
    text = unicodedata.normalize("NFKD", header.casefold().replace("ı", "i"))
    text = "".join(char for char in text if not unicodedata.combining(char))
    name = re.sub(r"[^a-z0-9]+", "_", text).strip("_")
    if not name:
        raise ValueError(f"Cannot name the CSV column for header {header!r}.")
    return name


def parse_table(html):
    parser = TableParser()
    parser.feed(html)
    parser.close()
    candidates = []
    for table in parser.root.find_all("table"):
        headers = [item.text() for item in table.find_all("th")]
        if headers and headers[0] == "Oyuncu":
            candidates.append((table, headers))
    if len(candidates) != 1:
        raise ValueError("Expected exactly one table with first header 'Oyuncu'.")
    table, headers = candidates[0]
    if not table.closed:
        raise ValueError("The copied table is incomplete: missing </table>.")
    if len(headers) != len(set(headers)):
        raise ValueError("Duplicate column headers in the copied table.")
    columns = ["player_name", "team_name", "position"]
    columns.extend(column_name(header) for header in headers[1:])
    if len(columns) != len(set(columns)):
        raise ValueError("Different headers produce the same CSV column name.")
    records = []
    for row in table.find_all("tr"):
        row_cells = cells(row)
        if not row_cells or all(cell.tag == "th" for cell in row_cells):
            continue
        if not row.closed or len(row_cells) != len(headers):
            raise ValueError(f"Incomplete row or column count mismatch at player row {len(records) + 1}.")
        # In the supplied markup: first <p> = name, span.truncate = club,
        # and span.uppercase = position. No player IDs appear in these cells.
        identity = row_cells[0]
        names = [item.text() for item in identity.find_all("p")]
        teams, positions = [], []
        for span in identity.find_all("span"):
            classes = span.attrs.get("class", "").split()
            if "truncate" in classes:
                teams.append(span.text())
            if "uppercase" in classes:
                positions.append(span.text())
        if any(len(values) != 1 or not values[0] for values in (names, teams, positions)):
            raise ValueError(f"Player row {len(records) + 1}: name, club or position markup changed.")
        record = dict(zip(columns[:3], (names[0], teams[0], positions[0])))
        for header, cell in zip(headers[1:], row_cells[1:]):
            value = cell.text()
            if header in COLUMNS:
                value = numeric_text(value, header)
            elif value in {"—", "–", "-"}:
                value = ""
            # Additional columns retain displayed units until their meaning
            # is known; do not guess how to convert a newly selected metric.
            record[column_name(header)] = value
        records.append(record)
    if not records:
        raise ValueError("No player rows found in the saved table.")
    return columns, records


def input_files(paths):
    files = []
    for path in paths:
        if path.is_dir():
            pages = sorted(item for item in path.iterdir()
                           if item.is_file() and item.suffix.lower() in {".html", ".htm", ".txt"})
            if not pages:
                raise ValueError(f"No saved HTML/text pages found in {path}.")
            files.extend(pages)
        else:
            files.append(path)
    resolved = [path.resolve() for path in files]
    if len(resolved) != len(set(resolved)):
        raise ValueError("The same input file was supplied more than once.")
    return files


def combine_pages(paths):
    columns, records = None, []
    seen_pages = set()
    for path in paths:
        try:
            page_columns, page_rows = parse_table(path.read_text(encoding="utf-8-sig"))
        except ValueError as exc:
            raise ValueError(f"{path.name}: {exc}") from None
        if columns is None:
            columns = page_columns
        elif set(columns) != set(page_columns):
            raise ValueError(f"{path.name}: selected columns differ between pages. "
                             "Select the same columns and copy the affected pages again.")
        signature = tuple(sorted(tuple(row[key] for key in columns) for row in page_rows))
        if signature in seen_pages:
            raise ValueError(f"{path.name}: identical player rows were already supplied in another page.")
        seen_pages.add(signature)
        records.extend(page_rows)
        print(f"Read {len(page_rows)} rows from {path.name}")
    return columns, records


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("input", type=Path, nargs="+",
                     help="Saved HTML/text pages, or a folder containing only those pages")
    cli.add_argument("--expected-rows", type=int,
                     help="Require this many total rows before writing (e.g. 509)")
    cli.add_argument("--output", type=Path,
                     default=ROOT / "data" / "raw" / "tff_fantasy" / "players.csv")
    cli.add_argument("--overwrite", action="store_true", help="Replace an existing output CSV")
    args = cli.parse_args()
    try:
        if args.expected_rows is not None and args.expected_rows < 1:
            raise ValueError("--expected-rows must be positive.")
        paths = input_files(args.input)
        if args.output.resolve() in {path.resolve() for path in paths}:
            raise ValueError("Input and output must be different files.")
        if args.output.suffix.lower() != ".csv":
            raise ValueError("Output must have a .csv extension.")
        if args.output.exists() and not args.overwrite:
            raise ValueError("Output already exists; choose another path or use --overwrite.")
        columns, records = combine_pages(paths)
        if args.expected_rows is not None and len(records) != args.expected_rows:
            raise ValueError(f"Expected {args.expected_rows} rows, found {len(records)}. "
                             "Check all pages, filters, and the current website total. No CSV written.")
        write_table(args.output, records, columns)
        print(f"Exported {len(records)} copied player rows to {args.output.resolve()}")
        print("This includes only rows present in the saved HTML, not necessarily every player.")
    except (ValueError, OSError) as exc:
        cli.exit(1, f"Error: {exc}\n")


if __name__ == "__main__":
    main()
