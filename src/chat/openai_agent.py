"""Answer a question with ChatGPT's model (OpenAI Responses API), running the tools it asks for.

Step 4 of the chatbot guide (docs/chatbot/04-connect-the-ai.md).
"""
from __future__ import annotations

import json
from pathlib import Path
import sys

import openai

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.chat.assistant import (CANNOT_ANSWER, EFFORT, MAX_ROUNDS, MAX_TOKENS, NO_ANSWER,  # noqa: E402
                                SYSTEM_PROMPT, TOO_MANY_STEPS, Reply, describe)
from src.chat.tools import definitions, run_tool  # noqa: E402
from src.fetch.sportmonks import local_setting  # noqa: E402

MODEL = "gpt-6-luna"
KEY_NAME = "OPENAI_API_KEY"
ApiError = openai.APIError

# GPT-6 Luna prices in US dollars per million tokens (for prompts up to 272K tokens).
PRICE_INPUT = 0.10
PRICE_CACHED_INPUT = 0.01
PRICE_OUTPUT = 0.50

def make_client() -> openai.OpenAI:
    key = local_setting(KEY_NAME)
    if not key:
        raise SystemExit(f"Add {KEY_NAME}=... to your .env file (see docs/chatbot/04-connect-the-ai.md).")
    return openai.OpenAI(api_key=key)


def openai_tools() -> list[dict]:
    """The step 3 tool menu in OpenAI's format. strict is off because some inputs are optional."""
    return [{"type": "function", "name": tool["name"], "description": tool["description"],
             "parameters": tool["input_schema"], "strict": False}
            for tool in definitions()]


def add_usage(reply: Reply, usage) -> None:
    """Add one response's tokens and cost to the reply. OpenAI counts cached tokens inside input_tokens."""
    details = getattr(usage, "input_tokens_details", None)
    cached = getattr(details, "cached_tokens", 0) or 0
    reply.input_tokens += usage.input_tokens
    reply.output_tokens += usage.output_tokens
    reply.cost_usd += ((usage.input_tokens - cached) * PRICE_INPUT + cached * PRICE_CACHED_INPUT
                       + usage.output_tokens * PRICE_OUTPUT) / 1_000_000


def answer_text(response) -> str:
    """The model's final words, or a polite message when there are none."""
    parts = [part for item in response.output if item.type == "message" for part in item.content]
    if any(part.type == "refusal" for part in parts):
        return CANNOT_ANSWER
    text = "".join(part.text for part in parts if part.type == "output_text").strip()
    return text or NO_ANSWER


def read_arguments(text: str) -> dict | None:
    """The tool inputs, decoded from the JSON text OpenAI sends. None if they are not valid."""
    try:
        arguments = json.loads(text or "{}")
    except json.JSONDecodeError:
        return None
    return arguments if isinstance(arguments, dict) else None

def ask(client, db, messages: list, question: str) -> Reply:
    """Answer one question. `messages` is the conversation so far; this adds to it."""
    messages.append({"role": "user", "content": question})
    reply = Reply(model=MODEL)
    for _ in range(MAX_ROUNDS):
        response = client.responses.create(
            model=MODEL,
            instructions=SYSTEM_PROMPT,
            tools=openai_tools(),
            input=messages,
            reasoning={"effort": EFFORT},
            max_output_tokens=MAX_TOKENS,
            store=False,
            include=["reasoning.encrypted_content"],
        )
        reply.rounds += 1
        add_usage(reply, response.usage)
        # Keep every item (reasoning, messages, tool calls) exactly as it came back.
        messages.extend(response.output)
        calls = [item for item in response.output if item.type == "function_call"]
        if not calls:
            reply.stopped = response.status
            if response.status == "incomplete" and response.incomplete_details:
                reply.stopped = response.incomplete_details.reason
            reply.text = answer_text(response)
            return reply
        for call in calls:
            arguments = read_arguments(call.arguments)
            if arguments is None:
                reply.tool_calls.append(f"{call.name}(?)")
                result = "Error: the tool input was not valid JSON."
            else:
                reply.tool_calls.append(describe(call.name, arguments))
                result = run_tool(db, call.name, arguments)
            messages.append({"type": "function_call_output", "call_id": call.call_id, "output": result})
    reply.stopped = "max_rounds"
    reply.text = TOO_MANY_STEPS
    return reply