// The two agent loops for the online chat: the same steps as
// src/chat/claude_agent.py and src/chat/openai_agent.py, calling the providers'
// HTTP APIs directly (a Cloudflare function has no Python libraries). The keys
// come from the Pages project's secrets, never from the page.
//
// Memory: a function keeps nothing between requests, so the page sends the
// last few questions and answers (history) and they open each conversation.

import { CANNOT_ANSWER, ChatError, EFFORT, MAX_ROUNDS, MAX_TOKENS, NO_ANSWER, SYSTEM_PROMPT, TOO_MANY_STEPS, describe, newReply } from "./assistant.js";
import { definitions, runTool } from "./tools.js";

const REQUEST_TIMEOUT_MS = 60000;

export const PROVIDERS = {
  claude: { model: "claude-haiku-5-5", key: "ANTHROPIC_API_KEY", ask: askClaude },
  openai: { model: "gpt-6-luna", key: "OPENAI_API_KEY", ask: askOpenAI },
};

// An error the provider's API returned; status is its HTTP status.
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function postJson(url, headers, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new ApiError(response.status, text.slice(0, 300));
  return JSON.parse(text);
}

function apiKey(env, provider) {
  const key = env[PROVIDERS[provider].key];
  if (!key) throw new ChatError(`API anahtarı eksik: Cloudflare'de ${PROVIDERS[provider].key} ekleyin.`, 503);
  return key;
}

// ------------------------------------------------------------------- Claude

// Claude Haiku 5.5 prices in US dollars per million tokens (prompts up to 100K tokens).
const CLAUDE_PRICE = { input: 0.10, output: 0.50, cacheWrite: 0.10 * 1.25, cacheRead: 0.10 * 0.10 };

function addClaudeUsage(reply, usage = {}) {
  const input = usage.input_tokens || 0, output = usage.output_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0, cacheRead = usage.cache_read_input_tokens || 0;
  reply.inputTokens += input + cacheWrite + cacheRead;
  reply.outputTokens += output;
  reply.costUsd += (input * CLAUDE_PRICE.input + cacheWrite * CLAUDE_PRICE.cacheWrite
    + cacheRead * CLAUDE_PRICE.cacheRead + output * CLAUDE_PRICE.output) / 1_000_000;
}

function claudeText(response) {
  if (response.stop_reason === "refusal") return CANNOT_ANSWER;
  const text = (response.content || []).filter((block) => block.type === "text").map((block) => block.text).join("").trim();
  return text || NO_ANSWER;
}

async function askClaude(env, db, history, question) {
  const key = apiKey(env, "claude");
  const messages = [];
  for (const { q, a } of history) messages.push({ role: "user", content: q }, { role: "assistant", content: a });
  messages.push({ role: "user", content: question });
  const reply = newReply(PROVIDERS.claude.model);
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const response = await postJson("https://api.anthropic.com/v1/messages",
      { "x-api-key": key, "anthropic-version": "2026-10-21" },
      { model: reply.model, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT, tools: definitions(), messages,
        output_config: { effort: EFFORT }, cache_control: { type: "ephemeral" } });
    reply.rounds += 1;
    addClaudeUsage(reply, response.usage);
    // Keep every block (thinking, text, tool calls) exactly as it came back.
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      reply.stopped = response.stop_reason;
      reply.text = claudeText(response);
      return reply;
    }
    const results = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      reply.toolCalls.push(describe(block.name, block.input));
      const result = await runTool(db, block.name, block.input);
      results.push({ type: "tool_result", tool_use_id: block.id, content: result, is_error: result.startsWith("Error:") });
    }
    messages.push({ role: "user", content: results });
  }
  reply.stopped = "max_rounds";
  reply.text = TOO_MANY_STEPS;
  return reply;
}

// ---------------------------------------------------------- OpenAI (ChatGPT)

// GPT-6 Luna prices in US dollars per million tokens (prompts up to 272K tokens).
const OPENAI_PRICE = { input: 0.10, cachedInput: 0.01, output: 0.50 };

function openaiTools() {
  return definitions().map((tool) => ({ type: "function", name: tool.name, description: tool.description,
    parameters: tool.input_schema, strict: false }));
}

function addOpenAIUsage(reply, usage = {}) {
  const input = usage.input_tokens || 0, output = usage.output_tokens || 0;
  const cached = usage.input_tokens_details?.cached_tokens || 0;
  reply.inputTokens += input;
  reply.outputTokens += output;
  reply.costUsd += ((input - cached) * OPENAI_PRICE.input + cached * OPENAI_PRICE.cachedInput + output * OPENAI_PRICE.output) / 1_000_000;
}

function openaiText(response) {
  const parts = (response.output || []).filter((item) => item.type === "message").flatMap((item) => item.content || []);
  if (parts.some((part) => part.type === "refusal")) return CANNOT_ANSWER;
  const text = parts.filter((part) => part.type === "output_text").map((part) => part.text).join("").trim();
  return text || NO_ANSWER;
}

function readArguments(text) {
  try {
    const parsed = JSON.parse(text || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function askOpenAI(env, db, history, question) {
  const key = apiKey(env, "openai");
  const input = [];
  for (const { q, a } of history) input.push({ role: "user", content: q }, { role: "assistant", content: a });
  input.push({ role: "user", content: question });
  const reply = newReply(PROVIDERS.openai.model);
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const response = await postJson("https://api.openai.com/v1/responses", { authorization: `Bearer ${key}` },
      { model: reply.model, instructions: SYSTEM_PROMPT, tools: openaiTools(), input, reasoning: { effort: EFFORT },
        max_output_tokens: MAX_TOKENS, store: false, include: ["reasoning.encrypted_content"] });
    reply.rounds += 1;
    addOpenAIUsage(reply, response.usage);
    // Keep every item (reasoning, messages, tool calls) exactly as it came back.
    input.push(...(response.output || []));
    const calls = (response.output || []).filter((item) => item.type === "function_call");
    if (!calls.length) {
      reply.stopped = response.status === "incomplete" && response.incomplete_details ? response.incomplete_details.reason : response.status;
      reply.text = openaiText(response);
      return reply;
    }
    for (const call of calls) {
      const args = readArguments(call.arguments);
      let result;
      if (args === null) {
        reply.toolCalls.push(`${call.name}(?)`);
        result = "Error: the tool input was not valid JSON.";
      } else {
        reply.toolCalls.push(describe(call.name, args));
        result = await runTool(db, call.name, args);
      }
      input.push({ type: "function_call_output", call_id: call.call_id, output: result });
    }
  }
  reply.stopped = "max_rounds";
  reply.text = TOO_MANY_STEPS;
  return reply;
}

// ---------------------------------------------------------------- one door

// Answer one question with the chosen provider, turning the provider's errors
// into messages the visitor can read (as src/chat/web_chat.py does).
export async function answer(env, db, provider, history, question) {
  try {
    return await PROVIDERS[provider].ask(env, db, history, question);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.status === 401 || error.status === 403) {
      throw new ChatError(`API anahtarı reddedildi: Cloudflare'deki ${PROVIDERS[provider].key} değerini kontrol edin.`, 503);
    }
    if (error.status === 429) throw new ChatError("Yapay zekâ servisi şu an yoğun ya da kredi limiti doldu. Biraz sonra tekrar deneyin.", 503);
    throw new ChatError("Yapay zekâ servisine ulaşılamadı. Biraz sonra tekrar deneyin.", 502);
  }
}
