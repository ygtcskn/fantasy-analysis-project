"""The Claude agent loop (src/chat/claude_agent.py), with a fake Claude so no money is spent."""
from types import SimpleNamespace
import unittest

from src.chat import assistant, claude_agent
from src.chat.tools import definitions
from tests.test_chat_tools import sample_database


def usage(input_tokens=100, output_tokens=20, cache_read=0):
    return SimpleNamespace(input_tokens=input_tokens, output_tokens=output_tokens,
                           cache_creation_input_tokens=0, cache_read_input_tokens=cache_read)


def text(words):
    return SimpleNamespace(type="text", text=words)


def tool_use(block_id, name, arguments):
    return SimpleNamespace(type="tool_use", id=block_id, name=name, input=arguments)


def response(stop_reason, *blocks, tokens=None):
    return SimpleNamespace(stop_reason=stop_reason, content=list(blocks), usage=tokens or usage())


class FakeClaude:
    """Plays Claude: hands back prepared responses in order and remembers every request."""

    def __init__(self, *responses):
        self.prepared = list(responses)
        self.requests = []
        self.messages = self   # so client.messages.create(...) works

    def create(self, **request):
        # Copy the list: the agent keeps adding to the same one.
        self.requests.append({**request, "messages": list(request["messages"])})
        return self.prepared.pop(0)


class ClaudeAgentTests(unittest.TestCase):
    def setUp(self):
        self.db = sample_database()
        self.history = []

    def tearDown(self):
        self.db.close()

    def ask(self, client, question="Soru"):
        return claude_agent.ask(client, self.db, self.history, question)

    def test_a_plain_answer_needs_one_round(self):
        reply = self.ask(FakeClaude(response("end_turn", text("Merhaba!"))))
        self.assertEqual((reply.model, reply.text, reply.rounds, reply.tool_calls, reply.stopped),
                         ("claude-haiku-5-5", "Merhaba!", 1, [], "end_turn"))
        self.assertEqual([message["role"] for message in self.history], ["user", "assistant"])

    def test_the_tool_result_goes_back_to_the_model(self):
        client = FakeClaude(
            response("tool_use", tool_use("t1", "leaderboard", {"stat": "goals", "season": "2023/2024"})),
            response("end_turn", text("Gol kralı Edin Džeko (3 gol).")))
        reply = self.ask(client, "2023-24 gol kralı kim?")
        self.assertEqual(reply.text, "Gol kralı Edin Džeko (3 gol).")
        self.assertEqual(reply.tool_calls, ["leaderboard(stat=goals, season=2023/2024)"])
        sent = client.requests[1]["messages"][-1]
        self.assertEqual(sent["role"], "user")
        self.assertEqual(sent["content"][0]["tool_use_id"], "t1")
        self.assertIn("Edin Džeko,Fenerbahçe,3", sent["content"][0]["content"])
        self.assertFalse(sent["content"][0]["is_error"])

    def test_tool_mistakes_are_marked_as_errors(self):
        client = FakeClaude(response("tool_use", tool_use("t1", "leaderboard", {"stat": "height"})),
                            response("end_turn", text("Bu istatistik yok.")))
        self.ask(client)
        result = client.requests[1]["messages"][-1]["content"][0]
        self.assertTrue(result["is_error"])
        self.assertTrue(result["content"].startswith("Error:"))

    def test_several_tool_calls_are_answered_in_one_message(self):
        client = FakeClaude(
            response("tool_use", text("Bakıyorum."), tool_use("a", "find_team", {"name": "fener"}),
                     tool_use("b", "find_team", {"name": "bjk"})),
            response("end_turn", text("Tamam.")))
        self.ask(client)
        results = client.requests[1]["messages"][-1]["content"]
        self.assertEqual([result["tool_use_id"] for result in results], ["a", "b"])
        self.assertIn("Fenerbahçe", results[0]["content"])
        self.assertIn("Beşiktaş", results[1]["content"])

    def test_it_stops_after_too_many_rounds(self):
        client = FakeClaude(*[response("tool_use", tool_use(f"t{number}", "list_seasons", {}))
                              for number in range(assistant.MAX_ROUNDS)])
        reply = self.ask(client)
        self.assertEqual((reply.stopped, reply.text, len(client.requests)),
                         ("max_rounds", assistant.TOO_MANY_STEPS, assistant.MAX_ROUNDS))

    def test_a_refusal_gets_a_polite_answer(self):
        reply = self.ask(FakeClaude(response("refusal")))
        self.assertEqual((reply.stopped, reply.text), ("refusal", assistant.CANNOT_ANSWER))

    def test_an_empty_answer_gets_a_polite_answer(self):
        reply = self.ask(FakeClaude(response("max_tokens", SimpleNamespace(type="thinking", thinking=""))))
        self.assertEqual((reply.stopped, reply.text), ("max_tokens", assistant.NO_ANSWER))

    def test_cost_adds_up_over_every_round(self):
        client = FakeClaude(response("tool_use", tool_use("t1", "list_seasons", {})),
                            response("end_turn", text("İki sezon var.")))
        reply = self.ask(client)
        self.assertEqual((reply.input_tokens, reply.output_tokens), (200, 40))
        self.assertAlmostEqual(reply.cost_usd, 2 * (100 * 0.10 + 20 * 0.50) / 1_000_000, places=12)

    def test_cached_tokens_cost_a_tenth(self):
        client = FakeClaude(response("end_turn", text("ok"), tokens=usage(10, 0, cache_read=1000)))
        reply = self.ask(client)
        self.assertEqual(reply.input_tokens, 1010)
        self.assertAlmostEqual(reply.cost_usd, (10 * 0.10 + 1000 * 0.01) / 1_000_000, places=12)

    def test_every_request_sends_the_model_rules_and_tools(self):
        client = FakeClaude(response("end_turn", text("ok")))
        self.ask(client)
        request = client.requests[0]
        self.assertEqual(request["model"], "claude-haiku-5-5")
        self.assertEqual(request["system"], assistant.SYSTEM_PROMPT)
        self.assertEqual(request["tools"], definitions())
        self.assertEqual(request["output_config"], {"effort": assistant.EFFORT})

    def test_the_conversation_is_remembered(self):
        self.ask(FakeClaude(response("end_turn", text("Džeko."))), "Gol kralı kim?")
        client = FakeClaude(response("end_turn", text("3 gol.")))
        self.ask(client, "Kaç gol attı?")
        questions = [m["content"] for m in client.requests[0]["messages"] if m["role"] == "user"]
        self.assertEqual(questions, ["Gol kralı kim?", "Kaç gol attı?"])


if __name__ == "__main__":
    unittest.main()