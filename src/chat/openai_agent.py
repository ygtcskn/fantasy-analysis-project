"""Answer a football question through the Responses API and SQLite-backed tools."""
from __future__ import annotations

import json

from .assistant import (CANNOT_ANSWER, EFFORT, MAX_ROUNDS, MAX_TOKENS, NO_ANSWER,
                        SYSTEM_PROMPT, TOO_MANY_STEPS, Reply, describe, question_with_fixture)
from .tools import definitions, run_tool


def openai_tools() -> list[dict]:
    """Expose the available tools in the Responses API format."""
    return [{"type": "function", "name": tool["name"], "description": tool["description"],
             "parameters": tool["input_schema"], "strict": False}
            for tool in definitions()]


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

def ask(client, db, messages: list, question: str, *, model: str, fixture_id: int | None = None) -> Reply:
    """Answer one question, optionally giving the model context for "this match"."""
    content = question_with_fixture(question, str(fixture_id))
    messages.append({"role": "user", "content": content})
    reply = Reply(model=model)
    for _ in range(MAX_ROUNDS):
        response = client.responses.create(
            model=model,
            instructions=SYSTEM_PROMPT,
            tools=openai_tools(),
            input=messages,
            reasoning={"effort": EFFORT},
            max_output_tokens=MAX_TOKENS,
            store=False,
            include=["reasoning.encrypted_content"],
        )
        reply.rounds += 1
        if response.usage is not None:
            reply.input_tokens += response.usage.input_tokens
            reply.output_tokens += response.usage.output_tokens
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
