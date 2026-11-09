"""The website chat's server side: one conversation per browser tab, answered by Claude or ChatGPT.

Step 5 of the chatbot guide (docs/chatbot/05-website-chat.md). src/web/serve.py
calls WebChat.answer() for every question sent to /local-chat.

The conversation history stays in this computer's memory, never in a file;
restarting the server forgets it. API keys come from .env, as in the terminal
chat, and never reach the browser.

Guests (visitors who are not signed in) get GUEST_QUESTIONS answers; after
that the chat asks them to sign in. A signed-in visitor's page sends their
Supabase access token, which is checked with Supabase itself before it counts.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import importlib
import json
from pathlib import Path
import re
import sys
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.chat.assistant import Reply  # noqa: E402

PROVIDERS = {"claude": "src.chat.claude_agent", "openai": "src.chat.openai_agent"}
MAX_QUESTION_CHARS = 500
MAX_QUESTIONS = 30            # per conversation: each answer re-sends the whole history, so cost grows
MAX_CONVERSATIONS = 200       # kept in memory at once; the longest-idle one is dropped first
IDLE_SECONDS = 2 * 60 * 60    # a conversation untouched this long is forgotten
CONVERSATION_ID = re.compile(r"[A-Za-z0-9-]{8,64}")
GUEST_QUESTIONS = 3           # answers a visitor gets before they must sign in
TOKEN_SECONDS = 5 * 60        # how long a checked sign-in is trusted before Supabase is asked again
MAX_TOKENS_KEPT = 1000
LOGIN_NEEDED = "Misafir olarak 3 soru hakkını kullandın. Devam etmek için giriş yap."
LOGIN_EXPIRED = "Oturumun sona ermiş. Devam etmek için yeniden giriş yap."
# The site's Supabase project (public values; the website reads the same file).
AUTH_CONFIG = ROOT / "src" / "web" / "core" / "auth-config.js"


class ChatError(Exception):
    """A question that cannot be answered. The message is shown to the visitor, in Turkish.

    code is "error", or "login" when the visitor must sign in to go on.
    """

    def __init__(self, message: str, status: int = 400, code: str = "error"):
        super().__init__(message)
        self.status = status
        self.code = code


def supabase_settings(path: Path = AUTH_CONFIG) -> tuple[str, str]:
    """The Supabase project URL and publishable key, read from the website's auth-config.js."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return "", ""
    url = re.search(r'\burl:\s*"([^"]*)"', text)
    key = re.search(r'\bkey:\s*"([^"]*)"', text)
    return (url[1].rstrip("/") if url else ""), (key[1] if key else "")


def supabase_user(token: str, settings=supabase_settings) -> str | None:
    """The signed-in user's id for an access token, asked of Supabase; None for a token it refuses."""
    url, key = settings()
    if not url or not key:
        raise ChatError("Giriş bu sitede kapalı.", 503)
    request = Request(f"{url}/auth/v1/user", headers={"apikey": key, "Authorization": f"Bearer {token}"})
    try:
        with urlopen(request, timeout=10) as response:
            user = json.loads(response.read(256 * 1024).decode("utf-8"))
    except HTTPError as error:
        if error.code in (401, 403):
            return None
        raise ChatError("Giriş doğrulanamadı. Biraz sonra tekrar deneyin.", 503) from None
    except (URLError, TimeoutError, ValueError, OSError):
        raise ChatError("Giriş doğrulanamadı. Bağlantıyı kontrol edip tekrar deneyin.", 503) from None
    user_id = user.get("id") if isinstance(user, dict) else None
    return str(user_id) if user_id else None


@dataclass
class Conversation:
    provider: str
    messages: list = field(default_factory=list)
    questions: int = 0
    used: float = field(default_factory=time.monotonic)
    lock: threading.Lock = field(default_factory=threading.Lock)


class WebChat:
    """Every open conversation, and one API client per provider."""

    def __init__(self, database: Path | None = None, open_database=None, load_agent=None, check_token=None):
        from src.chat import tools
        self.database = database or tools.DATABASE
        self.open_database = open_database or tools.open_database
        self.load_agent = load_agent or (lambda provider: importlib.import_module(PROVIDERS[provider]))
        self.check_token = check_token or supabase_user
        self.conversations: dict[str, Conversation] = {}
        self.clients: dict[str, object] = {}
        self.guests: dict[str, int] = {}               # guest id -> answers given
        self.tokens: dict[str, tuple[str, float]] = {}  # token's hash -> (user id, checked at)
        self.lock = threading.Lock()

    def user(self, token: str) -> str:
        """The signed-in user's id. A token Supabase refuses means the sign-in has run out."""
        digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
        now = time.monotonic()
        with self.lock:
            known = self.tokens.get(digest)
            if known and now - known[1] < TOKEN_SECONDS:
                return known[0]
        user_id = self.check_token(token)
        if not user_id:
            raise ChatError(LOGIN_EXPIRED, 401, "login")
        with self.lock:
            if len(self.tokens) >= MAX_TOKENS_KEPT:
                self.tokens.clear()
            self.tokens[digest] = (user_id, now)
        return user_id

    def guest_left(self, guest_id: str) -> int:
        with self.lock:
            return max(0, GUEST_QUESTIONS - self.guests.get(guest_id, 0))

    def take_guest_question(self, guest_id: str) -> None:
        """Count a guest's question before it is asked (so parallel tabs cannot go past the limit)."""
        if not CONVERSATION_ID.fullmatch(guest_id or ""):
            raise ChatError("Misafir kimliği geçersiz. Sayfayı yenileyin.")
        with self.lock:
            used = self.guests.get(guest_id, 0)
            if used >= GUEST_QUESTIONS:
                raise ChatError(LOGIN_NEEDED, 401, "login")
            self.guests[guest_id] = used + 1

    def give_back_guest_question(self, guest_id: str) -> None:
        """A question that got no answer does not count."""
        with self.lock:
            if self.guests.get(guest_id):
                self.guests[guest_id] -= 1

    def agent(self, provider: str):
        """The provider's agent module and its client, made once and reused."""
        try:
            agent = self.load_agent(provider)
        except ModuleNotFoundError:
            raise ChatError("Bu yapay zekâ için gereken Python kütüphanesi kurulu değil.", 503) from None
        with self.lock:
            if provider not in self.clients:
                try:
                    self.clients[provider] = agent.make_client()
                except SystemExit:
                    # make_client stops when the key is missing from .env.
                    raise ChatError(f"API anahtarı eksik: .env dosyasına {agent.KEY_NAME} ekleyin.", 503) from None
            return agent, self.clients[provider]

    def conversation(self, conversation_id: str, provider: str) -> Conversation:
        """This tab's conversation. Switching provider starts a new one: the two keep history differently."""
        now = time.monotonic()
        with self.lock:
            for key in [key for key, item in self.conversations.items() if now - item.used > IDLE_SECONDS]:
                del self.conversations[key]
            found = self.conversations.get(conversation_id)
            if found is None or found.provider != provider:
                while len(self.conversations) >= MAX_CONVERSATIONS:
                    del self.conversations[min(self.conversations, key=lambda key: self.conversations[key].used)]
                found = self.conversations[conversation_id] = Conversation(provider)
            found.used = now
            return found

    def answer(self, conversation_id: str, provider: str, question: str, guest_id: str = "", token: str = "") -> Reply:
        """Answer one question: as a signed-in user when token is given, otherwise as guest guest_id."""
        question = (question or "").strip()
        if not CONVERSATION_ID.fullmatch(conversation_id or ""):
            raise ChatError("Sohbet kimliği geçersiz. Sayfayı yenileyin.")
        if provider not in PROVIDERS:
            raise ChatError("Bilinmeyen yapay zekâ seçimi.")
        if not question:
            raise ChatError("Boş soru gönderilemez.")
        if len(question) > MAX_QUESTION_CHARS:
            raise ChatError(f"Soru en fazla {MAX_QUESTION_CHARS} karakter olabilir.")
        if token:
            self.user(token)
            return self.ask(conversation_id, provider, question)
        self.take_guest_question(guest_id)
        try:
            return self.ask(conversation_id, provider, question)
        except BaseException:
            self.give_back_guest_question(guest_id)
            raise

    def ask(self, conversation_id: str, provider: str, question: str) -> Reply:
        agent, client = self.agent(provider)
        conversation = self.conversation(conversation_id, provider)
        if not conversation.lock.acquire(blocking=False):
            raise ChatError("Önceki soru hâlâ yanıtlanıyor; biraz bekleyin.", 409)
        try:
            if conversation.questions >= MAX_QUESTIONS:
                raise ChatError("Bu sohbet çok uzadı. Yeni bir sohbet başlatın.", 429)
            if not Path(self.database).is_file():
                raise ChatError("Sohbet veritabanı yok: önce python src/chat/build_chat_db.py çalıştırın.", 503)
            db = self.open_database(self.database)
            before = len(conversation.messages)
            try:
                reply = agent.ask(client, db, conversation.messages, question)
            except agent.ApiError as error:
                # Forget the half-asked question, so the next one starts clean.
                del conversation.messages[before:]
                status = getattr(error, "status_code", None)
                if status in (401, 403):
                    raise ChatError(f"API anahtarı reddedildi: .env dosyasındaki {agent.KEY_NAME} değerini kontrol edin.", 503) from None
                if status == 429:
                    raise ChatError("Yapay zekâ servisi şu an yoğun ya da kredi limiti doldu. Biraz sonra tekrar deneyin.", 503) from None
                raise ChatError("Yapay zekâ servisine ulaşılamadı. Biraz sonra tekrar deneyin.", 502) from None
            finally:
                db.close()
            conversation.questions += 1
            conversation.used = time.monotonic()
            return reply
        finally:
            conversation.lock.release()
