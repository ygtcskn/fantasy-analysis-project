# Building the Fantezi Analiz chatbot

A chat box on **Anasayfa** that answers questions about past matches and season
stats, such as *"2023-24'te en çok gol atan kim?"* (Who scored the most goals in 2023-24?)
or *"Beşiktaş–Fenerbahçe derbisi kaç bitti?"* (What was the score of the Beşiktaş–Fenerbahçe derby?).

The AI never makes up numbers. It asks your database through small, safe
"tools", then explains the answer in Turkish.

## The steps

Do them in order. From step 3 on, you write each `.py` file yourself from the
code in the guide; every piece of code comes with an explanation. Each guide
also says what to run and what you should see.

| Step | Guide | What you get |
|---|---|---|
| 1 | [Get the data](01-get-the-data.md) | Your match data on this computer |
| 2 | [Build the database](02-build-the-database.md) | One file the chatbot reads: `data/temp/chat/chat.sqlite` |
| 3 | [The tools](03-the-tools.md) | Safe questions the bot can ask, tested without AI |
| 4 | [Connect the AI](04-connect-the-ai.md) | Claude and ChatGPT agent loops, and a chat in your terminal |
| 5 | [The chat on Ana Sayfa](05-website-chat.md) | The Asistan panel, answered through your local server |
| 6 | Put it online *(coming next)* | Cloudflare Pages Function + D1 database |
| 7 | Test and measure *(later)* | How often it answers correctly, and the cost |

## How it fits together (the finished version)

```
Visitor types a question on Anasayfa
        │
        ▼
Cloudflare Function  ──►  AI model (Claude Haiku 5.5 or GPT-6 Luna)
        │                    │  "call top_scorers(season=2023/2024)"
        ▼                    │
   your tools  ◄─────────────┘
        │  run safe SQL on the chatbot database
        ▼
   numbers go back to the AI → it writes the answer → visitor sees it
```

## Words you will meet

| Word | Meaning |
|---|---|
| **CSV** | A spreadsheet saved as plain text: one row per line, commas between columns. |
| **SQLite** | A whole database inside one file. No server to install. |
| **SQL** | The language for asking a database questions (`SELECT ... FROM ... WHERE ...`). |
| **Table** | Like one sheet in a spreadsheet: named columns, many rows. |
| **NULL** | "Not recorded". Different from 0. |
| **LLM** | Large language model: the AI (Claude, GPT, ...). |
| **API key** | A password that lets your code use an AI provider. Never put it in code or GitHub. |
| **Token** | A small piece of text; AI providers charge per token. |
| **Tool** | A function you write that the AI is allowed to call. |
| **Test** | A small program that checks your code gives the expected answer. |
