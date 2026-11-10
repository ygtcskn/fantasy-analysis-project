// POST /api/chat: the Ana Sayfa chat (Asistan) on fantezianaliz.com.
//
// A Cloudflare Pages Function: wrangler uploads this folder with the site
// (src/update_site.py) and Cloudflare runs it on its own servers, where the
// API keys are the Pages project's secrets (ANTHROPIC_API_KEY,
// OPENAI_API_KEY) and the chat's data is the D1 database bound as CHAT_DB
// (src/chat/sync_chat_d1.py fills it). The local site's /local-chat
// (src/web/serve.py) does the same with this computer's .env.
//
// The question arrives as a small form - provider, question, guest, and the
// last few questions and answers as repeated q and a fields - with a signed-in
// visitor's Supabase token in Authorization. The answer goes back as one CSV
// row, the columns of serve.py's CHAT_FIELDS.

import { ChatError, csvRow } from "../../src/chat/cloud/assistant.js";
import { PROVIDERS, answer } from "../../src/chat/cloud/agents.js";
import { takeQuestion } from "../../src/chat/cloud/access.js";

const FIELDS = ["status", "text", "model", "tool_calls", "rounds", "input_tokens", "output_tokens", "cost_usd", "guest_left"];
const MAX_BODY_BYTES = 20000;
const MAX_QUESTION_CHARS = 500;
const MAX_HISTORY = 6;           // question-and-answer pairs that come with a question
const MAX_HISTORY_ANSWER = 2000; // characters kept of each earlier answer
const GUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

function csvResponse(status, row) {
  const body = `${csvRow(FIELDS)}\r\n${csvRow(FIELDS.map((field) => row[field] ?? ""))}\r\n`;
  return new Response(body, { status, headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff" } });
}

function refuse(status, message) {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

// Each answer costs money, so only this website may ask: another site's page
// cannot add X-Superlig-Chat without a CORS permission this function never
// gives, and browsers name where a request comes from in Origin and Sec-Fetch-Site.
function checkRequest(request) {
  const url = new URL(request.url), origin = request.headers.get("Origin"), site = request.headers.get("Sec-Fetch-Site");
  if (request.headers.get("X-Superlig-Chat") !== "1" || (site && site !== "same-origin") || (origin && origin !== url.origin)) {
    return refuse(403, "Use the website.");
  }
  if (!(request.headers.get("Content-Type") || "").startsWith("application/x-www-form-urlencoded")) {
    return refuse(415, "Send the question as a form.");
  }
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > MAX_BODY_BYTES) return refuse(413, "Question too long.");
  return null;
}

// The last few questions and answers the page sent, as [{ q, a }].
function readHistory(form) {
  const questions = form.getAll("q"), answers = form.getAll("a"), pairs = [];
  for (let index = 0; index < Math.min(questions.length, answers.length); index += 1) {
    const q = questions[index].trim().slice(0, MAX_QUESTION_CHARS), a = answers[index].trim().slice(0, MAX_HISTORY_ANSWER);
    if (q && a) pairs.push({ q, a });
  }
  return pairs.slice(-MAX_HISTORY);
}

export async function onRequestPost({ request, env }) {
  const refused = checkRequest(request);
  if (refused) return refused;
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return refuse(413, "Question too long.");
  const form = new URLSearchParams(body);
  const provider = form.get("provider") || "", question = (form.get("question") || "").trim();
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const guest = token ? "" : form.get("guest") || "";
  try {
    if (!(provider in PROVIDERS)) throw new ChatError("Bilinmeyen yapay zekâ seçimi.");
    if (!question) throw new ChatError("Boş soru gönderilemez.");
    if (question.length > MAX_QUESTION_CHARS) throw new ChatError(`Soru en fazla ${MAX_QUESTION_CHARS} karakter olabilir.`);
    if (!token && !GUEST_ID.test(guest)) throw new ChatError("Misafir kimliği geçersiz. Sayfayı yenileyin.");
    const db = env.CHAT_DB;
    if (!db) throw new ChatError("Sohbet veritabanı henüz bağlanmadı.", 503);
    const { left, release } = await takeQuestion(env, request, db, { token, guest });
    let reply;
    try {
      reply = await answer(env, db, provider, readHistory(form), question);
    } catch (error) {
      await release();
      throw error;
    }
    return csvResponse(200, { status: "ok", text: reply.text, model: reply.model, tool_calls: reply.toolCalls.join(" | "),
      rounds: reply.rounds, input_tokens: reply.inputTokens, output_tokens: reply.outputTokens,
      cost_usd: reply.costUsd.toFixed(6), guest_left: left ?? "" });
  } catch (error) {
    if (error instanceof ChatError) {
      return csvResponse(error.status, { status: error.code, text: error.message,
        guest_left: error.code === "login" && !token ? 0 : "" });
    }
    // A bug: its details go to Cloudflare's log, not to the visitor.
    console.error(error);
    return csvResponse(500, { status: "error", text: "Beklenmeyen bir hata oldu. Biraz sonra tekrar deneyin." });
  }
}
