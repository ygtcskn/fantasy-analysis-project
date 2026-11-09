# Step 5 — The chat on Ana Sayfa

## What you get

The **Asistan** panel on Ana Sayfa (bottom right, beside İlk 11'ler) is now a
real chat. Ask in Turkish, and Claude Haiku 5.5 or GPT-6 Luna answers using
the same tools as your terminal chat. A switch in the panel's header picks
which one.

Under each answer, a small grey line shows **which model answered, in how
many rounds, and what it cost**, for example `Claude Haiku 5.5 · 2 tur · $0.0005`.
Hover over it to see which tools ran, for example
`Araçlar: leaderboard(stat=goals, season=2023/2024, limit=5)`.

> This step's code was written for you (you asked for it this time). This
> guide explains how it works, so you can read along, change it, and explain
> it in an interview.

## How a question travels

```
 Ana Sayfa (browser)                    your computer: src/web/serve.py
 ───────────────────                    ──────────────────────────────
 home-chat.js                           do_POST("/local-chat")
   POST /local-chat         ─────────►    checks: right site? right header?
   conversation, provider,                 ↓
   question  (a small form)              web_chat.py  WebChat.answer()
                                           finds this tab's conversation
                                           ↓
                                         claude_agent.ask()  or  openai_agent.ask()
                                           (step 4: the agent loop + step 3 tools)
                                           ↓
   shows the answer        ◄─────────    one CSV row: status, text, model,
   + model · rounds · cost                 tool_calls, rounds, tokens, cost
```

Three design choices worth knowing:

1. **The API keys never reach the browser.** The browser only talks to
   `serve.py` on your computer, and `serve.py` reads the keys from `.env`.
   If the keys were in the page, anyone could copy them and spend your credit.
2. **The server remembers each conversation.** Each browser tab gets a random
   conversation id. The server keeps that conversation's messages in memory
   (not in a file), so follow-up questions like *"Peki asistlerde?"* ("And in
   assists?") work. Restarting the server forgets them.
3. **Only your own page can ask.** Every answer costs money, so the server
   refuses requests from other websites (details in Part 2).

Because it needs `serve.py`, the chat works **only on the local site** for
now. On the public site the panel says *"Asistan şimdilik yalnızca yerel sitede
(serve.py) çalışıyor."* ("The assistant only works on the local site for now.")
Putting it online is step 6.

---

## Part 1 — `src/chat/web_chat.py`: conversations

This file sits between the website and your agents.

### The limits

```python
PROVIDERS = {"claude": "src.chat.claude_agent", "openai": "src.chat.openai_agent"}
MAX_QUESTION_CHARS = 500
MAX_QUESTIONS = 30            # per conversation: each answer re-sends the whole history, so cost grows
MAX_CONVERSATIONS = 200       # kept in memory at once; the longest-idle one is dropped first
IDLE_SECONDS = 2 * 60 * 60    # a conversation untouched this long is forgotten
CONVERSATION_ID = re.compile(r"[A-Za-z0-9-]{8,64}")
```

Every limit protects something:

- `MAX_QUESTION_CHARS` stops someone from pasting a novel (more tokens = more cost).
- `MAX_QUESTIONS` caps a single conversation. Remember from step 4: every
  question re-sends the **whole** conversation, so question 30 costs more than question 1.
- `MAX_CONVERSATIONS` and `IDLE_SECONDS` keep memory from growing forever.
- `CONVERSATION_ID` only accepts safe-looking ids.

### Errors the visitor can read

```python
class ChatError(Exception):
    """A question that cannot be answered. The message is shown to the visitor, in Turkish."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status
```

Instead of crashing, every problem becomes a `ChatError` with a Turkish
message and an HTTP **status code**. A status code is a three-digit number
that tells the browser what kind of problem it was: 400 = bad question,
409 = busy, 429 = too many, 502/503 = the AI service or a setting is missing.

### One conversation

```python
@dataclass
class Conversation:
    provider: str
    messages: list = field(default_factory=list)
    questions: int = 0
    used: float = field(default_factory=time.monotonic)
    lock: threading.Lock = field(default_factory=threading.Lock)
```

`messages` is exactly the list your step 4 `ask()` adds to. `lock` makes sure
one conversation answers **one question at a time**: the local server
handles requests in parallel (one *thread* each), and two answers writing
into the same list at once would scramble it.

### `WebChat`: all conversations

The key methods, in plain words:

- **`agent(provider)`** loads `claude_agent` or `openai_agent` only when first
  needed (so you don't need both libraries installed to use one), and makes
  **one client per provider**, reused for every question. If the key is missing
  from `.env`, your step 4 `make_client()` stops the program; here that is turned
  into a friendly *"API anahtarı eksik"* ("API key missing") message instead.
- **`conversation(id, provider)`** finds this tab's conversation, or starts
  one. It also forgets idle conversations and, when there are too many, the
  one unused the longest. **Switching provider starts a new conversation**,
  because Claude and OpenAI store history in different formats (step 4's table).
- **`answer(id, provider, question)`** checks the inputs, takes the
  conversation's lock (or says *"Önceki soru hâlâ yanıtlanıyor"*, "the previous
  question is still being answered"), opens the database read-only, and calls
  your agent's `ask()`:

```python
            before = len(conversation.messages)
            try:
                reply = agent.ask(client, db, conversation.messages, question)
            except agent.ApiError as error:
                # Forget the half-asked question, so the next one starts clean.
                del conversation.messages[before:]
                ...
            finally:
                db.close()
```

This is the same trick as the terminal chat (`del messages[before:]`): if the
AI service fails halfway, the broken question is removed from the history.

---

## Part 2 — `src/web/serve.py`: the `/local-chat` door

Until now `serve.py` only *served files* (GET requests). A question has to be
*sent* to it, so it gained a **POST** handler, `do_POST`. Its checks, in order:

| Check | Refused with | Why |
|---|---|---|
| `Host` is `localhost`/`127.0.0.1` | 403 | Same rule as the rest of the server. |
| Path is `/local-chat` | 404 | Nothing else accepts POST. |
| Header `X-Superlig-Chat: 1`, `Sec-Fetch-Site` same-origin, `Origin` is this site | 403 | **Only this website may ask.** |
| Content type is a form | 415 | We send a simple form, not JSON (your project rule: no JSON except decoding providers' replies). |
| Size is 1–4096 bytes | 413 | No empty or huge requests. |

**Why the custom header protects you:** a page on another website *can* tell
your browser to send a request to `localhost:8123`. Without protection, a
malicious site could ask your chat questions and spend your API credit. But
browsers refuse to add a **custom header** like `X-Superlig-Chat` to a request
for another site, unless that site first answers a permission check
(called **CORS preflight**), and `serve.py` never does. Only your own page can
add the header. This attack is called **CSRF** (cross-site request forgery),
and this defence is a standard one worth naming in an interview.

The answer goes back as **one CSV row**, the format the rest of your site
already uses:

```
status,text,model,tool_calls,rounds,input_tokens,output_tokens,cost_usd
ok,2023/2024 sezonunun gol kralı Mauro Icardi oldu. ...,claude-haiku-5-5,"leaderboard(stat=goals, season=2023/2024, limit=5)",2,5210,180,0.000521
```

On a problem, `status` is `error` and `text` is the Turkish message. An
unexpected bug prints its details in the **server window** only. The visitor
just sees *"Beklenmeyen bir hata oldu"* ("An unexpected error occurred"),
because error details can reveal how your system works.

---

## Part 3 — `src/web/features/home/home-chat.js`: the page

The parts that talk to the server:

```js
const response = await fetch("/local-chat", {
  method: "POST",
  headers: { "X-Superlig-Chat": "1" },
  body: new URLSearchParams({ conversation: homeChat.conversation, provider: homeChat.provider, question }),
  cache: "no-store",
  signal: controller.signal,
});
```

- `fetch` sends the request; `URLSearchParams` makes the small form.
- `signal` lets us **give up after 90 seconds** (`AbortController`), so a
  stuck answer can't freeze the chat.
- The reply is read with `parseCSV`, the site's existing CSV reader.

Other behaviour:

- **The provider switch** (Claude / ChatGPT) starts a new conversation with a
  new random id (`crypto.randomUUID()`). Your choice is remembered in the
  browser (`localStorage`), so it survives a page refresh.
- **While waiting**, the jumping dots show, and the send button and the switch
  are disabled, so a question can't be sent twice.
- **Errors** appear as a bubble with a red outline: the server's Turkish
  message, or *"Yerel sunucuya ulaşılamadı. serve.py çalışıyor mu?"* ("Couldn't
  reach the local server. Is serve.py running?") when the server isn't
  reachable.
- **Answers are written as text, never as HTML**, so nothing the AI or a
  visitor writes can inject code into the page.

---

## Part 3b — Guests get 3 questions, then sign in

A visitor who isn't signed in (a **guest**) gets **3 answered questions**.
After that the chat shows *"Misafir olarak 3 soru hakkını kullandın. Devam
etmek için giriş yap."* ("You've used your 3 guest questions. Sign in to
continue.") with a **Giriş yap** (Sign in) button that opens the site's
existing Supabase sign-in dialog. Once signed in, the chat continues where it was.

**The server keeps the count, not the page.** A counter only in the browser
could be reset by anyone in a second. So:

- Each browser gets a random **guest id**, kept in `localStorage` and sent
  with every question. `WebChat` counts answers per guest id
  (`take_guest_question()`). Number 4 is refused **before** the AI is called,
  so it costs nothing. A question that fails (AI service down…) is given back
  (`give_back_guest_question()`), so guests aren't charged for errors.
- A signed-in visitor's page sends their **Supabase access token** in the
  `Authorization: Bearer …` header instead. The server does **not** just believe
  it: `supabase_user()` asks Supabase (`/auth/v1/user`) whether the token is
  real, and remembers the answer for 5 minutes (only a fingerprint of the
  token, its SHA-256 hash, is kept). An expired token gets *"Oturumun sona
  ermiş"* ("Your session has expired") and the sign-in button again.
- The server reads the Supabase address and public key from the website's own
  `src/web/core/auth-config.js`, so they live in one place.

The answer's CSV row has a new column, `guest_left`, which the page shows
under the example questions: *"Misafir olarak 2 soru hakkın kaldı."* ("As a
guest you have 2 questions left.") A refused question comes back with
`status` = `login` (HTTP 401), which the page turns into the sign-in prompt.

**Honest limits (good to mention in an interview):** on your computer the
count lives in the server's memory and the guest id in the browser, so
restarting the server or clearing the browser's storage starts a guest over.
That's fine locally; when the chat goes online (step 6) the count will also
be tied to the visitor's IP address and kept in a database, so it survives
both.

---

## Part 4 — Run it

### 1. Use the Python that has the AI libraries

The libraries you installed in step 4 (`anthropic`, `openai`) are in the
project's **`.venv`** (PyCharm's environment), not in the system Python. Start
the server with that Python:

```bash
.venv/Scripts/python.exe src/web/serve.py --season 2026/2027 --no-live --port 8123
```

In PyCharm you can also right-click `serve.py` → Run; it uses `.venv` already.
If the chat says *"Bu yapay zekâ için gereken Python kütüphanesi kurulu değil"*
("the Python library this AI needs isn't installed"), the server was started
with the wrong Python.

After **any change to a `.py` file**, stop the server (Ctrl+C) and start it
again. The browser picks up HTML/CSS/JS changes on refresh, but Python code
is only read when the server starts.

### 2. Run the tests (free, no AI calls)

```bash
.venv/Scripts/python.exe -m unittest tests.test_web_chat -v
```

They use a fake AI, a fake Supabase and fake requests. They check that
conversations are remembered, switching provider starts over, wrong inputs
are refused, a failed AI call is cleaned up, a guest gets exactly 3 answers,
a signed-in visitor's token is checked (and trusted for 5 minutes), and the
endpoint refuses other websites.

All chatbot tests together:

```bash
.venv/Scripts/python.exe -m unittest tests.test_chat_db tests.test_chat_tools tests.test_claude_agent tests.test_openai_agent tests.test_web_chat
```

### 3. Try it

Open http://localhost:8123, pick a match, and use the Asistan panel:

| Try | What to look for |
|---|---|
| `2023-24 gol kralı kim?` (2023-24 top scorer?) | Mauro Icardi, 25 goals; the grey line shows `leaderboard` on hover. |
| `Peki asistlerde?` (And in assists?) | Remembers 2023-24 and switches to assists. |
| Switch to **ChatGPT**, ask the same | A fresh chat; compare the answer and the cost. |
| `Mert kaç gol attı?` (How many goals did Mert score?) | Asks back which Mert. |
| `Bana bir şiir yaz` (Write me a poem) | Politely declines. |

### Common problems

| You see | Fix |
|---|---|
| "Yerel sunucuya ulaşılamadı…" (couldn't reach the local server) | `serve.py` isn't running, or it's an old copy: restart it. |
| "…Python kütüphanesi kurulu değil" (library not installed) | Start the server with `.venv/Scripts/python.exe`. |
| "API anahtarı eksik / reddedildi" (API key missing / refused) | Check `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in `.env`, then restart the server. |
| "Sohbet veritabanı yok…" (no chat database) | Run `python src/chat/build_chat_db.py` (step 2). |
| "…yoğun ya da kredi limiti doldu" (service busy or credit limit reached) | Add credit or wait a minute. |
| The panel isn't visible | It only shows on wide screens (about 1100px+) with a match selected. |

## ✅ You're done when

- the tests say `OK`,
- both Claude and ChatGPT answer in the Asistan panel,
- you can explain why the keys stay on the server and how the custom header
  stops other websites.

Next: **step 6: put it online**, so visitors to fantezianaliz.com can use it.
