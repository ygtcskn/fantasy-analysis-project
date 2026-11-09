"""The website chat: src/chat/web_chat.py and serve.py's /local-chat, with a fake AI so no money is spent."""
import csv
import io
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from src.chat import web_chat
from src.chat.assistant import Reply
from src.chat.web_chat import ChatError, WebChat
from src.web import live
from src.web.serve import make_handler
from tests.test_chat_tools import sample_database

CONVERSATION = "conversation-1"


class FakeApiError(Exception):
    def __init__(self, status):
        super().__init__(f"HTTP {status}")
        self.status_code = status


def fake_agent(model="fake-model", fail=None):
    """An agent module stand-in: answers 'answer N' and remembers each question."""
    def ask(client, db, messages, question):
        messages.append({"role": "user", "content": question})
        if fail:
            raise FakeApiError(fail)
        messages.append({"role": "assistant", "content": "ok"})
        return Reply(model=model, text=f"answer {len(messages) // 2}", tool_calls=["list_seasons()"], rounds=1)
    return SimpleNamespace(MODEL=model, KEY_NAME="FAKE_API_KEY", ApiError=FakeApiError, make_client=Mock(), ask=ask)


def make_chat(agents=None):
    agents = agents or {"claude": fake_agent("claude-model"), "openai": fake_agent("openai-model")}
    return WebChat(database=Path(__file__), open_database=lambda path: sample_database(),
                   load_agent=lambda provider: agents[provider])


class WebChatTests(unittest.TestCase):
    def test_answers_and_remembers_the_conversation(self):
        chat = make_chat()
        self.assertEqual(chat.answer(CONVERSATION, "claude", "Gol kralı kim?").text, "answer 1")
        self.assertEqual(chat.answer(CONVERSATION, "claude", "Peki asist?").text, "answer 2")
        history = chat.conversations[CONVERSATION].messages
        self.assertEqual([m["content"] for m in history if m["role"] == "user"], ["Gol kralı kim?", "Peki asist?"])

    def test_each_tab_has_its_own_conversation(self):
        chat = make_chat()
        chat.answer(CONVERSATION, "claude", "Bir")
        self.assertEqual(chat.answer("conversation-2", "claude", "İki").text, "answer 1")

    def test_switching_provider_starts_over(self):
        chat = make_chat()
        chat.answer(CONVERSATION, "claude", "Bir")
        reply = chat.answer(CONVERSATION, "openai", "İki")
        self.assertEqual((reply.model, reply.text), ("openai-model", "answer 1"))

    def test_one_client_per_provider(self):
        agents = {"claude": fake_agent()}
        chat = make_chat(agents)
        chat.answer(CONVERSATION, "claude", "Bir")
        chat.answer("conversation-2", "claude", "İki")
        agents["claude"].make_client.assert_called_once()

    def test_bad_requests_are_refused(self):
        chat = make_chat()
        for conversation, provider, question, expected in (
                ("x", "claude", "Soru", "kimliği"),
                ("bad id with spaces", "claude", "Soru", "kimliği"),
                (CONVERSATION, "gemini", "Soru", "Bilinmeyen"),
                (CONVERSATION, "claude", "   ", "Boş"),
                (CONVERSATION, "claude", "x" * 501, "500 karakter")):
            with self.subTest(conversation=conversation, provider=provider), self.assertRaises(ChatError) as caught:
                chat.answer(conversation, provider, question)
            self.assertIn(expected, str(caught.exception))
            self.assertEqual(caught.exception.status, 400)

    def test_a_missing_key_names_the_setting(self):
        agent = fake_agent()
        agent.make_client = Mock(side_effect=SystemExit("no key"))
        with self.assertRaises(ChatError) as caught:
            make_chat({"claude": agent}).answer(CONVERSATION, "claude", "Soru")
        self.assertEqual(caught.exception.status, 503)
        self.assertIn("FAKE_API_KEY", str(caught.exception))

    def test_a_missing_library_is_explained(self):
        def load(provider):
            raise ModuleNotFoundError("anthropic")
        chat = WebChat(database=Path(__file__), open_database=lambda path: sample_database(), load_agent=load)
        with self.assertRaises(ChatError) as caught:
            chat.answer(CONVERSATION, "claude", "Soru")
        self.assertIn("kütüphanesi", str(caught.exception))

    def test_an_api_failure_forgets_the_half_asked_question(self):
        for status, expected in ((401, "reddedildi"), (429, "yoğun"), (500, "ulaşılamadı")):
            chat = make_chat({"claude": fake_agent(fail=status)})
            with self.subTest(status=status), self.assertRaises(ChatError) as caught:
                chat.answer(CONVERSATION, "claude", "Soru")
            self.assertIn(expected, str(caught.exception))
            self.assertEqual(chat.conversations[CONVERSATION].messages, [])
            self.assertEqual(chat.conversations[CONVERSATION].questions, 0)

    def test_a_second_question_waits_for_the_first(self):
        chat = make_chat()
        chat.answer(CONVERSATION, "claude", "Bir")
        chat.conversations[CONVERSATION].lock.acquire()
        with self.assertRaises(ChatError) as caught:
            chat.answer(CONVERSATION, "claude", "İki")
        self.assertEqual(caught.exception.status, 409)

    def test_a_long_conversation_must_start_over(self):
        chat = make_chat()
        chat.answer(CONVERSATION, "claude", "Bir")
        chat.conversations[CONVERSATION].questions = web_chat.MAX_QUESTIONS
        with self.assertRaises(ChatError) as caught:
            chat.answer(CONVERSATION, "claude", "Bir daha")
        self.assertEqual(caught.exception.status, 429)

    def test_a_missing_database_is_explained(self):
        chat = WebChat(database=Path("no/such/chat.sqlite"), open_database=Mock(),
                       load_agent=lambda provider: fake_agent())
        with self.assertRaises(ChatError) as caught:
            chat.answer(CONVERSATION, "claude", "Soru")
        self.assertIn("build_chat_db.py", str(caught.exception))

    def test_idle_and_surplus_conversations_are_forgotten(self):
        chat, now = make_chat(), [1000.0]
        with patch.object(web_chat.time, "monotonic", side_effect=lambda: now[0]):
            chat.answer("old-conversation", "claude", "Bir")
            now[0] += web_chat.IDLE_SECONDS + 1
            chat.answer(CONVERSATION, "claude", "İki")
            self.assertEqual(list(chat.conversations), [CONVERSATION])
            with patch.object(web_chat, "MAX_CONVERSATIONS", 2):
                now[0] += 1
                chat.answer("conversation-2", "claude", "Üç")
                now[0] += 1
                chat.answer("conversation-3", "claude", "Dört")
        self.assertEqual(sorted(chat.conversations), ["conversation-2", "conversation-3"])


@patch.object(live, "LiveFeed")
class ChatEndpointTests(unittest.TestCase):
    HEADERS = {"Host": "localhost:8000", "Origin": "http://localhost:8000", "Sec-Fetch-Site": "same-origin",
               "X-Superlig-Chat": "1", "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"}

    def post(self, chat, body="conversation=conversation-1&provider=claude&question=Gol+krali", **headers):
        handler = object.__new__(make_handler(Path("2026-2027"), chat=chat))
        handler.server = SimpleNamespace(server_port=8000)
        content = body.encode("utf-8")
        handler.headers = {**self.HEADERS, "Content-Length": str(len(content)), **headers}
        handler.headers = {key: value for key, value in handler.headers.items() if value is not None}
        handler.path = "/local-chat"
        handler.rfile = io.BytesIO(content)
        handler.send_bytes = Mock()
        handler.send_error = Mock()
        handler.do_POST()
        return handler

    def answer_row(self, handler):
        content, content_type, head_only, status = handler.send_bytes.call_args.args
        self.assertEqual(content_type, "text/csv; charset=utf-8")
        return status, next(csv.DictReader(io.StringIO(content.decode("utf-8"))))

    def test_an_answer_comes_back_as_one_csv_row(self, feed_class):
        chat = Mock()
        chat.answer.return_value = Reply(model="claude-haiku-5-5", text="İcardi, 25 gol.", rounds=2,
                                         tool_calls=["find_player(name=icardi)", "player_season_stats(player_id=1)"],
                                         input_tokens=5000, output_tokens=120, cost_usd=0.00056)
        status, row = self.answer_row(self.post(chat))
        chat.answer.assert_called_once_with("conversation-1", "claude", "Gol krali")
        self.assertEqual(status, 200)
        self.assertEqual((row["status"], row["text"], row["model"], row["rounds"], row["cost_usd"]),
                         ("ok", "İcardi, 25 gol.", "claude-haiku-5-5", "2", "0.000560"))
        self.assertEqual(row["tool_calls"], "find_player(name=icardi) | player_season_stats(player_id=1)")

    def test_a_refused_question_keeps_its_status_and_message(self, feed_class):
        chat = Mock()
        chat.answer.side_effect = ChatError("Önceki soru hâlâ yanıtlanıyor; biraz bekleyin.", 409)
        status, row = self.answer_row(self.post(chat))
        self.assertEqual((status, row["status"], row["text"]), (409, "error", "Önceki soru hâlâ yanıtlanıyor; biraz bekleyin."))

    def test_an_unexpected_failure_is_reported_without_details(self, feed_class):
        chat = Mock()
        chat.answer.side_effect = RuntimeError("secret detail")
        with patch("traceback.print_exc"):
            status, row = self.answer_row(self.post(chat))
        self.assertEqual(status, 500)
        self.assertNotIn("secret", row["text"])

    def test_only_this_website_may_ask(self, feed_class):
        for headers in ({"X-Superlig-Chat": None}, {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"},
                        {"Origin": "https://evil.invalid"}, {"Host": "evil.invalid:8000"}):
            chat = Mock()
            with self.subTest(headers=headers):
                handler = self.post(chat, **headers)
                self.assertEqual(handler.send_error.call_args.args[0], 403)
                chat.answer.assert_not_called()

    def test_malformed_requests_are_refused(self, feed_class):
        for body, headers, status in (("", {}, 413), ("q=" + "x" * 5000, {}, 413),
                                      ("question=hi", {"Content-Type": "text/plain"}, 415)):
            chat = Mock()
            with self.subTest(status=status):
                handler = self.post(chat, body, **headers)
                self.assertEqual(handler.send_error.call_args.args[0], status)
                chat.answer.assert_not_called()

    def test_other_paths_are_not_found(self, feed_class):
        handler = object.__new__(make_handler(Path("2026-2027"), chat=Mock()))
        handler.server = SimpleNamespace(server_port=8000)
        handler.headers = dict(self.HEADERS)
        handler.path = "/somewhere-else"
        handler.send_error = Mock()
        handler.do_POST()
        self.assertEqual(handler.send_error.call_args.args[0], 404)


if __name__ == "__main__":
    unittest.main()
