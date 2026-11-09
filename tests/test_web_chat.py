"""The website chat: src/chat/web_chat.py and serve.py's /local-chat, with a fake AI so no money is spent."""
import csv
import io
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError

from src.chat import web_chat
from src.chat.assistant import Reply
from src.chat.web_chat import ChatError, WebChat
from src.web import live
from src.web.serve import make_handler
from tests.test_chat_tools import sample_database

CONVERSATION = "conversation-1"
GUEST = "guest-0001"
TOKEN = "signed-in-token"


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


def make_chat(agents=None, check_token=None):
    agents = agents or {"claude": fake_agent("claude-model"), "openai": fake_agent("openai-model")}
    return WebChat(database=Path(__file__), open_database=lambda path: sample_database(),
                   load_agent=lambda provider: agents[provider],
                   check_token=check_token or (lambda token: "user-1" if token == TOKEN else None))


def signed_in(chat, conversation, provider, question):
    return chat.answer(conversation, provider, question, token=TOKEN)


class WebChatTests(unittest.TestCase):
    def test_answers_and_remembers_the_conversation(self):
        chat = make_chat()
        self.assertEqual(signed_in(chat, CONVERSATION, "claude", "Gol kralı kim?").text, "answer 1")
        self.assertEqual(signed_in(chat, CONVERSATION, "claude", "Peki asist?").text, "answer 2")
        history = chat.conversations[CONVERSATION].messages
        self.assertEqual([m["content"] for m in history if m["role"] == "user"], ["Gol kralı kim?", "Peki asist?"])

    def test_each_tab_has_its_own_conversation(self):
        chat = make_chat()
        signed_in(chat, CONVERSATION, "claude", "Bir")
        self.assertEqual(signed_in(chat, "conversation-2", "claude", "İki").text, "answer 1")

    def test_switching_provider_starts_over(self):
        chat = make_chat()
        signed_in(chat, CONVERSATION, "claude", "Bir")
        reply = signed_in(chat, CONVERSATION, "openai", "İki")
        self.assertEqual((reply.model, reply.text), ("openai-model", "answer 1"))

    def test_one_client_per_provider(self):
        agents = {"claude": fake_agent()}
        chat = make_chat(agents)
        signed_in(chat, CONVERSATION, "claude", "Bir")
        signed_in(chat, "conversation-2", "claude", "İki")
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
                signed_in(chat, conversation, provider, question)
            self.assertIn(expected, str(caught.exception))
            self.assertEqual(caught.exception.status, 400)

    def test_a_missing_key_names_the_setting(self):
        agent = fake_agent()
        agent.make_client = Mock(side_effect=SystemExit("no key"))
        with self.assertRaises(ChatError) as caught:
            signed_in(make_chat({"claude": agent}), CONVERSATION, "claude", "Soru")
        self.assertEqual(caught.exception.status, 503)
        self.assertIn("FAKE_API_KEY", str(caught.exception))

    def test_a_missing_library_is_explained(self):
        def load(provider):
            raise ModuleNotFoundError("anthropic")
        chat = WebChat(database=Path(__file__), open_database=lambda path: sample_database(), load_agent=load,
                       check_token=lambda token: "user-1")
        with self.assertRaises(ChatError) as caught:
            signed_in(chat, CONVERSATION, "claude", "Soru")
        self.assertIn("kütüphanesi", str(caught.exception))

    def test_an_api_failure_forgets_the_half_asked_question(self):
        for status, expected in ((401, "reddedildi"), (429, "yoğun"), (500, "ulaşılamadı")):
            chat = make_chat({"claude": fake_agent(fail=status)})
            with self.subTest(status=status), self.assertRaises(ChatError) as caught:
                signed_in(chat, CONVERSATION, "claude", "Soru")
            self.assertIn(expected, str(caught.exception))
            self.assertEqual(chat.conversations[CONVERSATION].messages, [])
            self.assertEqual(chat.conversations[CONVERSATION].questions, 0)

    def test_a_second_question_waits_for_the_first(self):
        chat = make_chat()
        signed_in(chat, CONVERSATION, "claude", "Bir")
        chat.conversations[CONVERSATION].lock.acquire()
        with self.assertRaises(ChatError) as caught:
            signed_in(chat, CONVERSATION, "claude", "İki")
        self.assertEqual(caught.exception.status, 409)

    def test_a_long_conversation_must_start_over(self):
        chat = make_chat()
        signed_in(chat, CONVERSATION, "claude", "Bir")
        chat.conversations[CONVERSATION].questions = web_chat.MAX_QUESTIONS
        with self.assertRaises(ChatError) as caught:
            signed_in(chat, CONVERSATION, "claude", "Bir daha")
        self.assertEqual(caught.exception.status, 429)

    def test_a_missing_database_is_explained(self):
        chat = WebChat(database=Path("no/such/chat.sqlite"), open_database=Mock(),
                       load_agent=lambda provider: fake_agent(), check_token=lambda token: "user-1")
        with self.assertRaises(ChatError) as caught:
            signed_in(chat, CONVERSATION, "claude", "Soru")
        self.assertIn("build_chat_db.py", str(caught.exception))

    def test_idle_and_surplus_conversations_are_forgotten(self):
        chat, now = make_chat(), [1000.0]
        with patch.object(web_chat.time, "monotonic", side_effect=lambda: now[0]):
            signed_in(chat, "old-conversation", "claude", "Bir")
            now[0] += web_chat.IDLE_SECONDS + 1
            signed_in(chat, CONVERSATION, "claude", "İki")
            self.assertEqual(list(chat.conversations), [CONVERSATION])
            with patch.object(web_chat, "MAX_CONVERSATIONS", 2):
                now[0] += 1
                signed_in(chat, "conversation-2", "claude", "Üç")
                now[0] += 1
                signed_in(chat, "conversation-3", "claude", "Dört")
        self.assertEqual(sorted(chat.conversations), ["conversation-2", "conversation-3"])


class GuestTests(unittest.TestCase):
    def test_a_guest_gets_three_answers_then_must_sign_in(self):
        chat = make_chat()
        for number in range(1, 4):
            self.assertEqual(chat.answer(CONVERSATION, "claude", f"Soru {number}", guest_id=GUEST).text, f"answer {number}")
            self.assertEqual(chat.guest_left(GUEST), 3 - number)
        with self.assertRaises(ChatError) as caught:
            chat.answer(CONVERSATION, "claude", "Soru 4", guest_id=GUEST)
        self.assertEqual((caught.exception.status, caught.exception.code), (401, "login"))
        self.assertIn("giriş yap", str(caught.exception))
        # The fourth question never reached the AI.
        self.assertEqual(chat.conversations[CONVERSATION].questions, 3)

    def test_a_new_conversation_does_not_reset_the_count(self):
        chat = make_chat()
        for number in range(3):
            chat.answer(f"conversation-{number}", "claude", "Soru", guest_id=GUEST)
        with self.assertRaises(ChatError):
            chat.answer("conversation-new", "openai", "Soru", guest_id=GUEST)

    def test_each_guest_is_counted_alone(self):
        chat = make_chat()
        for _ in range(3):
            chat.answer(CONVERSATION, "claude", "Soru", guest_id=GUEST)
        self.assertEqual(chat.answer("conversation-2", "claude", "Soru", guest_id="guest-0002").text, "answer 1")

    def test_a_question_without_an_answer_does_not_count(self):
        chat = make_chat({"claude": fake_agent(fail=500)})
        with self.assertRaises(ChatError):
            chat.answer(CONVERSATION, "claude", "Soru", guest_id=GUEST)
        self.assertEqual(chat.guest_left(GUEST), 3)

    def test_a_guest_needs_a_valid_id(self):
        with self.assertRaises(ChatError) as caught:
            make_chat().answer(CONVERSATION, "claude", "Soru", guest_id="")
        self.assertEqual((caught.exception.status, caught.exception.code), (400, "error"))

    def test_a_signed_in_visitor_has_no_guest_limit(self):
        chat = make_chat()
        for number in range(5):
            signed_in(chat, CONVERSATION, "claude", f"Soru {number}")
        self.assertEqual(chat.guests, {})

    def test_a_refused_token_asks_to_sign_in_again(self):
        with self.assertRaises(ChatError) as caught:
            make_chat().answer(CONVERSATION, "claude", "Soru", token="expired-token")
        self.assertEqual((caught.exception.status, caught.exception.code), (401, "login"))
        self.assertIn("yeniden giriş", str(caught.exception))

    def test_a_checked_token_is_trusted_for_a_while(self):
        check = Mock(return_value="user-1")
        chat, now = make_chat(check_token=check), [1000.0]
        with patch.object(web_chat.time, "monotonic", side_effect=lambda: now[0]):
            signed_in(chat, CONVERSATION, "claude", "Bir")
            signed_in(chat, CONVERSATION, "claude", "İki")
            self.assertEqual(check.call_count, 1)
            now[0] += web_chat.TOKEN_SECONDS + 1
            signed_in(chat, CONVERSATION, "claude", "Üç")
        self.assertEqual(check.call_count, 2)
        # Only a fingerprint of the token is kept in memory.
        self.assertNotIn(TOKEN, chat.tokens)


class SupabaseTests(unittest.TestCase):
    def test_settings_are_read_from_the_website_config(self):
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / "auth-config.js"
            config.write_text('const SITE_AUTH = {\n  url: "https://abc.supabase.co/",  // note\n  key: "sb_publishable_x",\n};\n',
                              encoding="utf-8")
            self.assertEqual(web_chat.supabase_settings(config), ("https://abc.supabase.co", "sb_publishable_x"))
            self.assertEqual(web_chat.supabase_settings(Path(folder) / "missing.js"), ("", ""))

    def test_the_token_is_checked_with_supabase(self):
        response = Mock()
        response.read.return_value = b'{"id": "user-42", "email": "someone@example.com"}'
        opened = Mock()
        opened.return_value.__enter__ = Mock(return_value=response)
        opened.return_value.__exit__ = Mock(return_value=False)
        with patch.object(web_chat, "urlopen", opened):
            user = web_chat.supabase_user("abc", settings=lambda: ("https://abc.supabase.co", "sb_publishable_x"))
        self.assertEqual(user, "user-42")
        request = opened.call_args.args[0]
        self.assertEqual(request.full_url, "https://abc.supabase.co/auth/v1/user")
        self.assertEqual(request.get_header("Authorization"), "Bearer abc")
        self.assertEqual(request.get_header("Apikey"), "sb_publishable_x")

    def test_a_refused_token_and_an_outage_are_told_apart(self):
        settings = lambda: ("https://abc.supabase.co", "key")  # noqa: E731
        with patch.object(web_chat, "urlopen", side_effect=HTTPError("u", 401, "no", {}, None)):
            self.assertIsNone(web_chat.supabase_user("abc", settings=settings))
        for failure in (HTTPError("u", 500, "down", {}, None), URLError("offline")):
            with self.subTest(failure=failure), patch.object(web_chat, "urlopen", side_effect=failure), \
                    self.assertRaises(ChatError) as caught:
                web_chat.supabase_user("abc", settings=settings)
            self.assertEqual(caught.exception.status, 503)

    def test_no_supabase_project_means_no_sign_in(self):
        with self.assertRaises(ChatError):
            web_chat.supabase_user("abc", settings=lambda: ("", ""))


@patch.object(live, "LiveFeed")
class ChatEndpointTests(unittest.TestCase):
    HEADERS = {"Host": "localhost:8000", "Origin": "http://localhost:8000", "Sec-Fetch-Site": "same-origin",
               "X-Superlig-Chat": "1", "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"}
    BODY = "conversation=conversation-1&provider=claude&question=Gol+krali&guest=guest-0001"

    def post(self, chat, body=BODY, **headers):
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

    def test_a_guest_answer_comes_back_as_one_csv_row(self, feed_class):
        chat = Mock()
        chat.answer.return_value = Reply(model="claude-haiku-5-5", text="İcardi, 25 gol.", rounds=2,
                                         tool_calls=["find_player(name=icardi)", "player_season_stats(player_id=1)"],
                                         input_tokens=5000, output_tokens=120, cost_usd=0.00056)
        chat.guest_left.return_value = 2
        status, row = self.answer_row(self.post(chat))
        chat.answer.assert_called_once_with("conversation-1", "claude", "Gol krali", guest_id="guest-0001", token="")
        self.assertEqual(status, 200)
        self.assertEqual((row["status"], row["text"], row["model"], row["rounds"], row["cost_usd"], row["guest_left"]),
                         ("ok", "İcardi, 25 gol.", "claude-haiku-5-5", "2", "0.000560", "2"))
        self.assertEqual(row["tool_calls"], "find_player(name=icardi) | player_season_stats(player_id=1)")

    def test_a_signed_in_visitor_sends_their_token(self, feed_class):
        chat = Mock()
        chat.answer.return_value = Reply(model="m", text="ok")
        status, row = self.answer_row(self.post(chat, Authorization="Bearer abc.def"))
        chat.answer.assert_called_once_with("conversation-1", "claude", "Gol krali", guest_id="", token="abc.def")
        self.assertEqual(row["guest_left"], "")
        chat.guest_left.assert_not_called()

    def test_a_guest_out_of_questions_is_asked_to_sign_in(self, feed_class):
        chat = Mock()
        chat.answer.side_effect = ChatError(web_chat.LOGIN_NEEDED, 401, "login")
        status, row = self.answer_row(self.post(chat))
        self.assertEqual((status, row["status"], row["text"], row["guest_left"]), (401, "login", web_chat.LOGIN_NEEDED, "0"))

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
