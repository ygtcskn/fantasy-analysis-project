"""Answer a question with Claude (Anthropic), running the tools it asks for.

Step 4 of the chatbot guide (docs/chatbot/04-connect-the-ai.md).
"""
from __future__ import annotations

from pathlib import Path
import sys

import anthropic

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.chat.assistant import (CANNOT_ANSWER, EFFORT, MAX_ROUNDS, MAX_TOKENS, NO_ANSWER,  # noqa: E402
                                SYSTEM_PROMPT, TOO_MANY_STEPS, Reply, describe)
from src.chat.tools import definitions, run_tool  # noqa: E402
from src.fetch.sportmonks import local_setting  # noqa: E402

MODEL = "claude-haiku-5-5"
KEY_NAME = "ANTHROPIC_API_KEY"
ApiError = anthropic.APIError

# Claude Haiku 5.5 prices in US dollars per million tokens (for prompts up to 100K tokens).
PRICE_INPUT = 0.10
PRICE_OUTPUT = 0.50
PRICE_CACHE_WRITE = PRICE_INPUT * 1.25
PRICE_CACHE_READ = PRICE_INPUT * 0.10

def make_client() -> anthropic.Anthropic:
    key = local_setting(KEY_NAME)
    if not key:
        raise SystemExit(f"Add {KEY_NAME}=... to your .env file (see docs/chatbot/04-connect-the-ai.md).")
    return anthropic.Anthropic(api_key=key)


def add_usage(reply: Reply, usage) -> None:
    """Add one response's tokens and cost to the reply."""
    cache_write = usage.cache_creation_input_tokens or 0
    cache_read = usage.cache_read_input_tokens or 0
    reply.input_tokens += usage.input_tokens + cache_write + cache_read
    reply.output_tokens += usage.output_tokens
    reply.cost_usd += (usage.input_tokens * PRICE_INPUT + cache_write * PRICE_CACHE_WRITE
                       + cache_read * PRICE_CACHE_READ + usage.output_tokens * PRICE_OUTPUT) / 1_000_000


def answer_text(response) -> str:
    """Claude's final words, or a polite message when there are none."""
    if response.stop_reason == "refusal":
        return CANNOT_ANSWER
    text = "".join(block.text for block in response.content if block.type == "text").strip()
    return text or NO_ANSWER

def ask(client, db, messages: list, question: str) -> Reply:
    """Answer one question. `messages` is the conversation so far; this adds to it."""
    messages.append({"role": "user", "content": question})
    reply = Reply(model=MODEL)
    for _ in range(MAX_ROUNDS):
        response = client.messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            system=SYSTEM_PROMPT,
            tools=definitions(),
            messages=messages,
            output_config={"effort": EFFORT},
            cache_control={"type": "ephemeral"},
        )
        reply.rounds += 1
        add_usage(reply, response.usage)
        # Keep every block (thinking, text, tool calls) exactly as it came back.
        messages.append({"role": "assistant", "content": response.content})
        if response.stop_reason != "tool_use":
            reply.stopped = response.stop_reason
            reply.text = answer_text(response)
            return reply
        results = []
        for block in response.content:
            if block.type == "tool_use":
                reply.tool_calls.append(describe(block.name, block.input))
                result = run_tool(db, block.name, block.input)
                results.append({"type": "tool_result", "tool_use_id": block.id,
                                "content": result, "is_error": result.startswith("Error:")})
        messages.append({"role": "user", "content": results})
    reply.stopped = "max_rounds"
    reply.text = TOO_MANY_STEPS
    return reply