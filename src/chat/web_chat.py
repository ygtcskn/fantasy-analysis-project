"""The website chat's server side: one conversation per browser tab, answered by Claude or ChatGPT.

Step 5 of the chatbot guide (docs/chatbot/05-website-chat.md). src/web/serve.py
calls WebChat.answer() for every question sent to /local-chat.

The conversation history stays in this computer's memory, never in a file;
restarting the server forgets it. API keys come from .env, as in the terminal
chat, and never reach the browser.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import importlib
from pathlib import Path
import re
import sys
import threading
import time

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


class ChatError(Exception):
    """A question that cannot be answered. The message is shown to the visitor, in Turkish."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


@dataclass
class Conversation:
    provider: str
    messages: list = field(default_factory=list)
    questions: int = 0
    used: float = field(default_factory=time.monotonic)
    lock: threading.Lock = field(default_factory=threading.Lock)


class WebChat:
    """Every open conversation, and one API client per provider."""

    def __init__(self, database: Path | None = None, open_database=None, load_agent=None):
        from src.chat import tools
        self.database = database or tools.DATABASE
        self.open_database = open_database or tools.open_database
        self.load_agent = load_agent or (lambda provider: importlib.import_module(PROVIDERS[provider]))
        self.conversations: dict[str, Conversation] = {}
        self.clients: dict[str, object] = {}
        self.lock = threading.Lock()

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

    def answer(self, conversation_id: str, provider: str, question: str) -> Reply:
        question = (question or "").strip()
        if not CONVERSATION_ID.fullmatch(conversation_id or ""):
            raise ChatError("Sohbet kimliği geçersiz. Sayfayı yenileyin.")
        if provider not in PROVIDERS:
            raise ChatError("Bilinmeyen yapay zekâ seçimi.")
        if not question:
            raise ChatError("Boş soru gönderilemez.")
        if len(question) > MAX_QUESTION_CHARS:
            raise ChatError(f"Soru en fazla {MAX_QUESTION_CHARS} karakter olabilir.")
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
