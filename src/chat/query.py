"""Ask the chatbot's database a question in SQL and print the answer as a table.

    python src/chat/query.py "SELECT name FROM teams ORDER BY name"

The database is opened read-only, so a query can never change it.
Build it first with: python src/chat/build_chat_db.py
"""
import argparse
from pathlib import Path
import sqlite3
import sys

ROOT = Path(__file__).resolve().parents[2]
DATABASE = ROOT / "data" / "temp" / "chat" / "chat.sqlite"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("sql", help="The SQL query, in quotes.")
    parser.add_argument("--database", type=Path, default=DATABASE)
    parser.add_argument("--limit", type=int, default=50, help="Show at most this many rows (default 50).")
    args = parser.parse_args()
    if not args.database.is_file():
        raise SystemExit(f"{args.database} is missing. Build it first: python src/chat/build_chat_db.py")
    db = sqlite3.connect(f"{args.database.resolve().as_uri()}?mode=ro", uri=True)
    try:
        cursor = db.execute(args.sql)
    except sqlite3.Error as error:
        raise SystemExit(f"SQL error: {error}") from None
    columns = [item[0] for item in cursor.description or []]
    rows = cursor.fetchmany(args.limit + 1)
    db.close()
    shown = [["" if value is None else str(value) for value in row] for row in rows[:args.limit]]
    widths = [max([len(column)] + [len(row[index]) for row in shown]) for index, column in enumerate(columns)]
    print("  ".join(column.ljust(width) for column, width in zip(columns, widths)))
    print("  ".join("-" * width for width in widths))
    for row in shown:
        print("  ".join(value.ljust(width) for value, width in zip(row, widths)))
    print(f"({len(shown)} rows{', more not shown' if len(rows) > args.limit else ''})")


if __name__ == "__main__":
    # Windows terminals may not print Turkish letters without this.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    main()
