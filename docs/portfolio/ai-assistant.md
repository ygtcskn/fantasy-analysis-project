# AI assistant for football statistics

I built an assistant to answer questions about Süper Lig matches, players, and statistics by season or matchweek. It can resolve a player or club name, look up the relevant records, and answer using the statistics returned by its tools.

**Skills demonstrated** · LLM tool calling · Tool argument validation · Parameterized SQL · Testing with a mocked API client

## My approach

For a question such as “Who led the league in goals in 2023/24?”, the model can request `leaderboard` with the statistic and season. I validate that request against the tool’s schema, run a parameterized query through a read-only SQLite connection, and send the result back to the model as a table. The assistant can use additional tools when a question requires more than one lookup, with a six-round limit per question.

I built the SQLite database from season CSVs. The queries can report when coverage is incomplete, and player lookup flags ambiguous names so the assistant can ask the user which player they meant.

### Matchweek questions

For “Who scored this week?”, the assistant sends `week="current"` to `leaderboard`. The tool resolves that to the round Sportmonks marked as current. When the marker is absent, it uses the fixture schedule. It also accepts the previous round or a numbered round such as `"8"`. The response names the resolved season and round so a follow-up like “What about assists?” can use the same scope.

The leaderboard counts appearances in finished matches and reports how many scheduled fixtures are complete. It flags partial coverage and output limits, and a player-specific lookup can return a recorded zero. This lets the assistant distinguish a confirmed zero from a missing statistic or an unplayed matchweek.

### Club rankings and saved match dashboards

For “Which club took the most shots this week?”, `team_leaderboard` aggregates Sportmonks team metrics from finished fixtures. It sums counts and expected goals (xG), averages match percentages, and measures coverage before applying the ranking limit. When xG is missing for some teams, the assistant can report the highest recorded value and say how much data is missing.

`matchweek_fixtures` lists fixtures for a round, including upcoming matches. `match_dashboard` uses the fixture ID to retrieve the saved score, lineups, events, team metrics, minute-by-minute pressure, and comparisons with each club's season. The Python agent accepts an optional `fixture_id` so the caller can provide context for “this match.” These tools query the saved Sportmonks data.

### Formatting answers for a narrow chat window

Short answers use plain text. Rankings, stat lists, and comparisons use a Markdown table with two or three columns and one row per player or club. The website renders that table in the chat window, with the season, round, and any coverage note outside the table.

Example using the test database for “Who scored in matchweek 2?”

**2023/2024, matchweek 2**

| Player | Club | Goals |
| --- | --- | ---: |
| Edin Džeko | Fenerbahçe | 2 |
| Mert Hakan Yandaş | Fenerbahçe | 1 |

### Try a tool without an API key

With saved season CSVs in `data/final/sportmonks/`, run `python -m src.chat.build_chat_db` from the repository root to build the SQLite cache. Then use the read-only tool directly in Python.

```python
from contextlib import closing

from src.chat.tools import open_database, run_tool

with closing(open_database()) as db:
    scope = {"season": "2025/2026", "week": "8"}
    print(run_tool(db, "leaderboard", {**scope, "stat": "goals", "limit": 100}))
    print(run_tool(db, "team_leaderboard", {**scope, "stat": "shots_total"}))
    print(run_tool(db, "matchweek_fixtures", scope))
```

## How I checked it

I tested round selection with a saved marker and with a legacy cache that only has fixtures. The SQL tests cover missing xG, recorded zeros, and saved pressure in stoppage time. Mocked API tests verify that the agent passes the selected fixture to the model and carries earlier matchweek results into follow-ups. [Assistant tests](../../tests/test_openai_agent.py) · [SQL tool tests](../../tests/test_chat_tools.py) · [Database tests](../../tests/test_chat_db.py)

## Read the code

- The system prompt defines which tools to call, how to format replies, and how to report gaps in coverage. [System prompt](../../src/chat/assistant.py#L15)
- `ask()` passes the tool schemas to the model, runs requested tools, and appends the results to the conversation. [Assistant loop](../../src/chat/openai_agent.py#L35)
- `matchweek()` resolves a round and `leaderboard()` queries the matching player appearances and checks coverage. [Round resolution](../../src/chat/tools.py#L371) · [Player leaderboard](../../src/chat/tools.py#L407)
- `team_leaderboard()` ranks clubs by the selected metric, while `match_dashboard()` returns a requested section for one fixture. [Club leaderboard](../../src/chat/tools.py#L545) · [Match dashboard](../../src/chat/tools.py#L631)
- `run_tool()` dispatches to a defined tool after checking its arguments. [Tool dispatch](../../src/chat/tools.py#L842)
- `build()` creates the SQLite cache from season CSVs. `save_dashboard()` adds the match details, team statistics, and pressure samples. [Database builder](../../src/chat/build_chat_db.py#L288) · [Dashboard loader](../../src/chat/dashboard_data.py#L229)
