# AI assistant for football statistics

I built an assistant to answer questions about Süper Lig matches, players, and statistics by season or matchweek. It can resolve a player or club name, look up the relevant records, and answer using the statistics returned by its tools.

**Skills demonstrated** · LLM tool calling · Tool argument validation · Parameterized SQL · Testing with a mocked API client

## My approach

For a question such as “Who led the league in goals in 2023/24?”, the model can request `leaderboard` with the statistic and season. I validate that request against the tool’s schema, run a parameterized query through a read-only SQLite connection, and send the result back to the model as a table. The assistant can use additional tools when a question requires more than one lookup, with a six-round limit per question.

I built the SQLite database from season CSVs. The queries can report when coverage is incomplete, and player lookup flags ambiguous names so the assistant can ask the user which player they meant.

### Matchweek questions

For “Who scored this week?”, the assistant sends `week="current"` to `leaderboard`. The tool resolves that to the round Sportmonks marked as current. When the marker is absent, it uses the fixture schedule. It also accepts the previous round or a numbered round such as `"8"`. The response names the resolved season and round so a follow-up like “What about assists?” can use the same scope.

The leaderboard counts appearances in finished matches and reports how many scheduled fixtures are complete. It flags partial coverage and output limits, and a player-specific lookup can return a recorded zero. This lets the assistant distinguish a confirmed zero from a missing statistic or an unplayed matchweek.

The chat window uses plain text. The prompt asks for a short opening, blank lines between groups, and one result per bullet. Weekly scorer lists group players by goal total and place any recorded club next to its player.

### Try a tool without an API key

With saved season CSVs in `data/final/sportmonks/`, run `python -m src.chat.build_chat_db` from the repository root to build the SQLite cache. Then use the read-only tool directly in Python.

```python
from contextlib import closing

from src.chat.tools import open_database, run_tool

with closing(open_database()) as db:
    print(run_tool(db, "leaderboard", {
        "stat": "goals",
        "season": "2025/2026",
        "week": "8",
        "limit": 100,
    }))
```

## How I checked it

I tested round selection with a saved marker and with a legacy cache that only has fixtures. The SQL tests also cover partial coverage and recorded zeros. A mocked API test verifies that a follow-up receives the earlier matchweek tool result in its conversation history. [Assistant tests](../../tests/test_openai_agent.py) · [SQL tool tests](../../tests/test_chat_tools.py) · [Database tests](../../tests/test_chat_db.py)

## Read the code

- `ask()` passes the tool schemas to the model, runs requested tools, and appends the results to the conversation. [Assistant loop](../../src/chat/openai_agent.py#L35)
- `matchweek()` resolves a round and `leaderboard()` queries the matching appearances and checks coverage. [Round resolution](../../src/chat/tools.py#L370) · [Leaderboard query](../../src/chat/tools.py#L406)
- `run_tool()` dispatches to a defined tool after checking its arguments. [Tool dispatch](../../src/chat/tools.py#L635)
- `build()` creates the SQLite database and saves provider round markers from the prepared season tables. [Database builder](../../src/chat/build_chat_db.py#L279)
