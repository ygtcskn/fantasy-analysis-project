"""Try one chatbot tool from the terminal, the way the AI will call it.

    python src/chat/try_tool.py                                   # list the tools
    python src/chat/try_tool.py find_player name=icardi
    python src/chat/try_tool.py leaderboard stat=goals season=2023/2024
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.chat.tools import TOOLS, open_database, run_tool  # noqa: E402


def main():
    # Windows terminals may not print Turkish letters without this.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) < 2:
        for tool in TOOLS:
            inputs = ", ".join(tool.parameters["properties"]) or "no inputs"
            print(f"{tool.name}  ({inputs})\n    {tool.description}\n")
        return
    name, arguments = sys.argv[1], {}
    for item in sys.argv[2:]:
        key, separator, value = item.partition("=")
        if not separator:
            raise SystemExit(f"Write inputs as name=value, for example season=2023/2024 (got '{item}').")
        arguments[key] = value
    db = open_database()
    try:
        print(run_tool(db, name, arguments))
    finally:
        db.close()


if __name__ == "__main__":
    main()