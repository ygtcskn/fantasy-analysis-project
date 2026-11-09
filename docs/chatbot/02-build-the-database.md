# Step 2 — Build the chatbot's database

## Why this step?

Your data is spread over about 30 CSV files per season, with up to 200
columns each, many of them provider details the bot doesn't need. Reading all
of that for every question would be slow and messy.

So we build **one small, clean database** with only what the chatbot needs,
covering every season you have. Later (step 6) the same tables go online to
Cloudflare D1.

```
data/final/sportmonks/2021-2022/*.csv ┐
data/final/sportmonks/2022-2023/*.csv ├─► src/chat/build_chat_db.py ─► data/temp/chat/chat.sqlite
...                                   │
data/final/sportmonks/2026-2027/*.csv ┘
```

It goes in `data/temp/` because it's **rebuildable**: you can delete it at
any time and run the script again.

## The tables

| Table | One row per | Main columns |
|---|---|---|
| `seasons` | season | `season` (2023/2024) |
| `teams` | club | `team_id`, `name`, `search_name` |
| `players` | player | `player_id`, `name`, `search_name` |
| `matches` | fixture | `season`, `round`, `kickoff_utc`, `home_team_id`, `away_team_id`, `home_goals`, `away_goals`, `finished` |
| `events` | goal / card / substitution | `fixture_id`, `type`, `minute`, `player_id`, `related_player_id` (the assist) |
| `player_matches` | player in a match | `minutes`, `goals`, `assists`, `shots_total`, `rating`, `expected_goals`, ... |
| `standings` | club in a league table | `position`, `points`, `won`, `drawn`, `lost`, `goals_for`, `goals_against` |

Two ideas to understand:

- **`search_name`** is the name in lower case without Turkish letters
  (`Beşiktaş` → `besiktas`). Visitors type names all sorts of ways; this makes
  them match.
- **NULL is not 0.** Older seasons didn't record some stats (xG is almost
  empty before 2024-25). Those are stored as NULL ("not recorded"), so the bot
  can say "not recorded that season" instead of "0".

## 1. Run the tests

The tests build a tiny made-up season (Beşiktaş 2–1 Fenerbahçe) and check
every table comes out right. Run them before using the real data:

```bash
python -m unittest tests.test_chat_db -v
```

✅ You should see each test name followed by `ok`, and finally `OK`.
❌ If you see `FAILED` or `ERROR`, copy the whole output and send it to me.

## 2. Build the database

```bash
python src/chat/build_chat_db.py
```

✅ You should see a small table like this, with numbers for each season
(yours will differ):

```
season       matches   events  player rows  table rows
2021/2022        380     5800        15860          20
...
Built ...\data\temp\chat\chat.sqlite
```

A full season has about **380 matches** (fewer for a season with fewer clubs,
and the current season only has the matches played so far).

## 3. Ask it questions

`src/chat/query.py` runs one SQL question on the database. It opens the file
read-only, so you can't break anything. Try these:

**How many matches per season?**

```bash
python src/chat/query.py "SELECT season, COUNT(*) AS matches, SUM(finished) AS finished FROM matches GROUP BY season"
```

**Top 10 scorers in 2023-24:**

```bash
python src/chat/query.py "SELECT p.name, SUM(pm.goals) AS goals, SUM(pm.minutes > 0) AS games FROM player_matches pm JOIN players p ON p.player_id = pm.player_id WHERE pm.season = '2023/2024' GROUP BY pm.player_id ORDER BY goals DESC LIMIT 10"
```

**Every Beşiktaş home game against Fenerbahçe:**

```bash
python src/chat/query.py "SELECT m.season, m.kickoff_utc, h.name AS home, m.home_goals, m.away_goals, a.name AS away FROM matches m JOIN teams h ON h.team_id = m.home_team_id JOIN teams a ON a.team_id = m.away_team_id WHERE h.search_name LIKE '%besiktas%' AND a.search_name LIKE '%fenerbahce%' ORDER BY m.kickoff_utc"
```

**The 2023-24 league table:**

```bash
python src/chat/query.py "SELECT s.position, t.name, s.played, s.won, s.drawn, s.lost, s.goals_for, s.goals_against, s.points FROM standings s JOIN teams t ON t.team_id = s.team_id WHERE s.season = '2023/2024' ORDER BY s.position"
```

👀 **Sanity check:** do the top scorers and the table match what you remember
from that season? If something looks wrong, tell me which query and what you
expected. Checking results against reality is a core data-science habit.

## How the code works (read along)

Open [`src/chat/build_chat_db.py`](../../src/chat/build_chat_db.py). From top to bottom:

1. **`SCHEMA`** describes the tables in SQL (`CREATE TABLE ...`). This is the
   "shape" of the database.
2. **`search_name()`** turns `Beşiktaş` into `besiktas`.
3. **`final_scores()`** picks each match's final score from the rows marked
   `CURRENT`, the same rule your website's home page uses. If the provider
   gives two different numbers, the score is stored as unknown instead of
   guessed.
4. **`load_season()`** reads one season folder and inserts its rows. It uses
   the project's shared helpers in `src/shared.py`, so "finished match" and
   "blank number" mean exactly what they mean everywhere else in your project.
5. **`build()`** writes everything to a temporary file first and only
   replaces `chat.sqlite` at the end. If anything fails halfway, your previous
   database is untouched.

And [`tests/test_chat_db.py`](../../tests/test_chat_db.py) shows, in small
examples, exactly what each part should produce.

## ✅ You're done when

- the tests say `OK`,
- the build prints a row for every season,
- the four example questions give answers that look right.

Tell me how it went (or paste any error), and we'll move on to **step 3:
the tools**, where these SQL questions become safe functions the AI can call.
