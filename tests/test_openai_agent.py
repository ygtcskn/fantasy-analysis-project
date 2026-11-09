"""The OpenAI agent loop (src/chat/openai_agent.py), with a fake OpenAI so no money is spent."""
import json
from types import SimpleNamespace
import unittest

from src.chat import assistant, openai_agent
from src.chat.tools import definitions
from tests.test_chat_tools import sample_database


def usage(input_tokens=100, output_tokens=20, cached=0):
    return SimpleNamespace(input_tokens=input_tokens, output_tokens=output_tokens,
                           input_tokens_details=SimpleNamespace(cached_tokens=cached))


def message(words):
    return SimpleNamespace(type="message", content=[SimpleNamespace(type="output_text", text=words)])


def refusal(words):
    return SimpleNamespace(type="message", content=[SimpleNamespace(type="refusal", refusal=words)])


def reasoning():
    return SimpleNamespace(type="reasoning", encrypted_content="locked")


def call(call_id, name, arguments):
    text = arguments if isinstance(arguments, str) else json.dumps(arguments)
    return SimpleNamespace(type="function_call", call_id=call_id, name=name, arguments=text)


def response(*items, status="completed", reason=None, tokens=None):
    return SimpleNamespace(output=list(items), status=status, usage=tokens or usage(),
                           incomplete_details=SimpleNamespace(reason=reason) if reason else None)


class FakeOpenAI:
    """Plays OpenAI: hands back prepared responses in order and remembers every request."""

    def __init__(self, *responses):
        self.prepared = list(responses)
        self.requests = []
        self.responses = self   # so client.responses.create(...) works

    def create(self, **request):
        self.requests.append({**request, "input": list(request["input"])})
        return self.prepared.pop(0)


class OpenAIAgentTests(unittest.TestCase):
    def setUp(self):
        self.db = sample_database()
        self.history = []

    def tearDown(self):
        self.db.close()

    def ask(self, client, question="Soru"):
        return openai_agent.ask(client, self.db, self.history, question)

    def test_a_plain_answer_needs_one_round(self):
        reply = self.ask(FakeOpenAI(response(message("Merhaba!"))))
        self.assertEqual((reply.model, reply.text, reply.rounds, reply.tool_calls, reply.stopped),
                         ("gpt-6-luna", "Merhaba!", 1, [], "completed"))
        self.assertEqual(self.history[0], {"role": "user", "content": "Soru"})
        self.assertEqual(self.history[1].type, "message")

    def test_the_tool_result_and_reasoning_go_back_to_the_model(self):
        client = FakeOpenAI(
            response(reasoning(), call("c1", "leaderboard", {"stat": "goals", "season": "2023/2024"})),
            response(message("Gol kralı Edin Džeko (3 gol).")))
        reply = self.ask(client, "2023-24 gol kralı kim?")
        self.assertEqual(reply.text, "Gol kralı Edin Džeko (3 gol).")
        self.assertEqual(reply.tool_calls, ["leaderboard(stat=goals, season=2023/2024)"])
        sent = client.requests[1]["input"]
        self.assertEqual(sent[-1]["type"], "function_call_output")
        self.assertEqual(sent[-1]["call_id"], "c1")
        self.assertIn("Edin Džeko,Fenerbahçe,3", sent[-1]["output"])
        self.assertIn("reasoning", [getattr(item, "type", None) for item in sent])

    def test_broken_json_inputs_are_reported_to_the_model(self):
        client = FakeOpenAI(response(call("c1", "leaderboard", "{not json")),
                            response(message("Tekrar deniyorum.")))
        reply = self.ask(client)
        self.assertEqual(reply.tool_calls, ["leaderboard(?)"])
        self.assertEqual(client.requests[1]["input"][-1]["output"], "Error: the tool input was not valid JSON.")

    def test_tool_mistakes_come_back_as_error_text(self):
        client = FakeOpenAI(response(call("c1", "leaderboard", {"stat": "height"})),
                            response(message("Bu istatistik yok.")))
        self.ask(client)
        self.assertTrue(client.requests[1]["input"][-1]["output"].startswith("Error:"))

    def test_several_tool_calls_each_get_an_answer(self):
        client = FakeOpenAI(response(call("a", "find_team", {"name": "fener"}), call("b", "find_team", {"name": "bjk"})),
                            response(message("Tamam.")))
        self.ask(client)
        outputs = [item for item in client.requests[1]["input"]
                   if isinstance(item, dict) and item.get("type") == "function_call_output"]
        self.assertEqual([item["call_id"] for item in outputs], ["a", "b"])
        self.assertIn("Fenerbahçe", outputs[0]["output"])
        self.assertIn("Beşiktaş", outputs[1]["output"])

    def test_it_stops_after_too_many_rounds(self):
        client = FakeOpenAI(*[response(call(f"c{number}", "list_seasons", {}))
                              for number in range(assistant.MAX_ROUNDS)])
        reply = self.ask(client)
        self.assertEqual((reply.stopped, reply.text, len(client.requests)),
                         ("max_rounds", assistant.TOO_MANY_STEPS, assistant.MAX_ROUNDS))

    def test_a_refusal_gets_a_polite_answer(self):
        reply = self.ask(FakeOpenAI(response(refusal("No."))))
        self.assertEqual(reply.text, assistant.CANNOT_ANSWER)

    def test_a_cut_off_answer_says_why(self):
        reply = self.ask(FakeOpenAI(response(reasoning(), status="incomplete", reason="max_output_tokens")))
        self.assertEqual((reply.stopped, reply.text), ("max_output_tokens", assistant.NO_ANSWER))

    def test_cached_tokens_are_priced_separately(self):
        reply = self.ask(FakeOpenAI(response(message("ok"), tokens=usage(1000, 10, cached=900))))
        self.assertEqual((reply.input_tokens, reply.output_tokens), (1000, 10))
        self.assertAlmostEqual(reply.cost_usd, (100 * 0.10 + 900 * 0.01 + 10 * 0.50) / 1_000_000, places=12)

    def test_every_request_sends_the_model_rules_and_tools(self):
        client = FakeOpenAI(response(message("ok")))
        self.ask(client)
        request = client.requests[0]
        self.assertEqual(request["model"], "gpt-6-luna")
        self.assertEqual(request["instructions"], assistant.SYSTEM_PROMPT)
        self.assertEqual(request["reasoning"], {"effort": assistant.EFFORT})
        self.assertFalse(request["store"])
        self.assertEqual([tool["name"] for tool in request["tools"]], [tool["name"] for tool in definitions()])
        self.assertEqual(request["tools"][0]["parameters"], definitions()[0]["input_schema"])
        self.assertTrue(all(tool["type"] == "function" and tool["strict"] is False for tool in request["tools"]))

    def test_the_conversation_is_remembered(self):
        self.ask(FakeOpenAI(response(message("Džeko."))), "Gol kralı kim?")
        client = FakeOpenAI(response(message("3 gol.")))
        self.ask(client, "Kaç gol attı?")
        questions = [item["content"] for item in client.requests[0]["input"]
                     if isinstance(item, dict) and item.get("role") == "user"]
        self.assertEqual(questions, ["Gol kralı kim?", "Kaç gol attı?"])


if __name__ == "__main__":
    unittest.main()