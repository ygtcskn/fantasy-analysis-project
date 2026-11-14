# AI assistant for football statistics

I built an assistant to answer questions about Süper Lig matches, players, and season statistics. It can resolve a player or club name, look up the relevant records, and answer using the statistics returned by its tools.

**Skills demonstrated** · LLM tool calling · Tool argument validation · Parameterized SQL · Testing with a mocked API client

## My approach

For a question such as “Who led the league in goals in 2023/24?”, the model can request `leaderboard` with the statistic and season. I validate that request against the tool’s schema, run a parameterized query through a read-only SQLite connection, and send the result back to the model as a table. The assistant can use additional tools when a question requires more than one lookup, with a six-round limit per question.

I built the SQLite database from season CSVs. The queries can report when coverage is incomplete, and player lookup flags ambiguous names so the assistant can ask the user which player they meant.

## How I checked it

I used a fake API client and an in-memory SQLite database to test the full tool-call loop. The tests check that the matching call ID and query result are returned to the model, that invalid arguments produce readable errors, and that the round limit stops repeated calls. [Assistant tests](../../tests/test_openai_agent.py) · [SQL tool tests](../../tests/test_chat_tools.py)

## Read the code

- `ask()` passes the tool schemas to the model, runs requested tools, and appends the results to the conversation. [Assistant loop](../../src/chat/openai_agent.py#L35)
- `run_tool()` dispatches to a defined tool after checking its arguments. [Tool dispatch](../../src/chat/tools.py#L557)
- `build()` creates the SQLite database from the prepared season tables. [Database builder](../../src/chat/build_chat_db.py#L266)
