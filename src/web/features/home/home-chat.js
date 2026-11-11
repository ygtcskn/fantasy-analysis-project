"use strict";

// Ana Sayfa's chat panel (Asistan). A question goes to the server, which has
// the chosen AI answer it with the chatbot's tools and API keys the page never
// sees: on this computer src/web/serve.py's /local-chat (src/chat/web_chat.py),
// on fantezianaliz.com the Cloudflare function /api/chat (functions/api/chat.js).
// The page sends the last few questions and answers with each question, so
// follow-ups work there too (the local server also keeps its own history).
// Messages are written as text, never as HTML.
//
// Guests get a few answers, then the chat asks them to sign in. The server
// keeps that count and checks a signed-in visitor's Supabase token itself;
// what this page shows about it is only a convenience.
//
// The AI answers in the language of the question, so the examples are in the
// page's language. What the server says itself (a limit reached, an error) is
// always Turkish; knownText shows the English kept for it in core/english.js.

const HOME_CHAT_EXAMPLES = [t("2023-24 gol kralı kim?"), t("Fenerbahçe bu sezon evinde nasıl?"), t("Son derbiyi kim kazandı?")];
const HOME_CHAT_PROVIDERS = ["claude", "openai"];
const HOME_CHAT_MODELS = { "claude-haiku-5-5": "Claude Haiku 5.5", "gpt-6-luna": "GPT-6 Luna" };
const HOME_CHAT_GREETING = t("Merhaba! Süper Lig maçları, oyuncular ve sezon istatistikleri hakkında soru sorabilirsin.");
const HOME_CHAT_GUEST_QUESTIONS = 3;
const HOME_CHAT_TIMEOUT = 90000;
const HOME_CHAT_PLACEHOLDER = t("Buraya yaz");
const HOME_CHAT_HISTORY = 6;   // question-and-answer pairs sent along with a question
const homeChat = { busy: false, provider: "claude", conversation: "", guest: "", guestLeft: null, needsLogin: false, history: [] };

// Where questions go: the local server, or the site's Cloudflare function. A
// page opened from disk has neither.
function homeChatEndpoint() {
  return siteMode === "local" ? "/local-chat" : siteMode === "published" ? "/api/chat" : "";
}

function homeChatStorage(name, value) {
  try {
    if (value === undefined) return localStorage.getItem(name);
    localStorage.setItem(name, String(value));
  } catch { /* Storage may be blocked; the server's count still holds. */ }
  return null;
}

function homeChatSignedIn() {
  return typeof siteAuth !== "undefined" && Boolean(siteAuth.user);
}

function homeChatScrollToEnd() {
  const list = $("home-chat-messages");
  list.scrollTop = list.scrollHeight;
}

// role: user, assistant, error or login. meta: a small line under an answer.
function homeChatMessage(role, text, meta, detail) {
  const item = element("li", `home-chat-message is-${role}`);
  item.append(element("p", "", text));
  if (meta) {
    const line = element("small", "home-chat-meta", meta);
    if (detail) line.title = detail;
    item.append(line);
  }
  $("home-chat-messages").append(item);
  homeChatScrollToEnd();
  return item;
}

// The sign-in request, with a button that opens the site's sign-in dialog.
function homeChatLoginMessage(text) {
  const item = homeChatMessage("login", text);
  if (typeof authEnabled === "function" && authEnabled()) {
    const button = element("button", "home-chat-login", t("Giriş yap"));
    button.type = "button";
    button.addEventListener("click", () => openAuthDialog());
    item.append(button);
  }
  homeChatScrollToEnd();
}

// Three jumping dots while the answer is on its way.
function homeChatTyping() {
  const item = element("li", "home-chat-message is-assistant is-typing");
  item.setAttribute("aria-label", t("Asistan yazıyor"));
  const dots = element("span", "home-chat-dots");
  dots.setAttribute("aria-hidden", "true");
  dots.append(element("i"), element("i"), element("i"));
  item.append(dots);
  $("home-chat-messages").append(item);
  homeChatScrollToEnd();
  return item;
}

function homeChatNewId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function homeChatResize() {
  const input = $("home-chat-input");
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 96)}px`;
}

// The line under the examples: how many questions a guest has left.
function homeChatNote() {
  const note = $("home-chat-note");
  const left = homeChat.guestLeft ?? HOME_CHAT_GUEST_QUESTIONS;
  note.hidden = !homeChatEndpoint() || homeChatSignedIn() || homeChat.needsLogin;
  note.textContent = left === HOME_CHAT_GUEST_QUESTIONS
    ? t("Misafir olarak {count} soru sorabilirsin; sonrası için giriş yapman gerekir.", { count: left }, left)
    : t("Misafir olarak {count} soru hakkın kaldı.", { count: left }, left);
}

function homeChatSync() {
  const offline = !homeChatEndpoint(), locked = offline || homeChat.needsLogin;
  const input = $("home-chat-input");
  input.disabled = locked;
  input.placeholder = homeChat.needsLogin ? t("Devam etmek için giriş yap") : HOME_CHAT_PLACEHOLDER;
  $("home-chat-send").disabled = locked || homeChat.busy || !input.value.trim();
  for (const button of document.querySelectorAll(".home-chat-provider button")) {
    button.setAttribute("aria-pressed", String(button.dataset.provider === homeChat.provider));
    button.disabled = offline || homeChat.busy;
  }
  homeChatNote();
}

// A fresh conversation with the chosen AI. The server keeps each provider's
// history in its own form, so a switch always starts over.
function startHomeChat() {
  homeChat.conversation = homeChatNewId();
  homeChat.history = [];
  $("home-chat-messages").replaceChildren();
  homeChatMessage("assistant", HOME_CHAT_GREETING);
  if (!homeChatEndpoint()) {
    homeChatMessage("error", t("Asistan bu sayfada çalışmıyor: siteyi fantezianaliz.com'dan ya da yerel sunucudan (serve.py) aç."));
    $("home-chat-suggestions").hidden = true;
  } else if (homeChat.needsLogin) {
    homeChatLoginMessage(t("Misafir olarak 3 soru hakkını kullandın. Devam etmek için giriş yap."));
    $("home-chat-suggestions").hidden = true;
  } else {
    $("home-chat-suggestions").hidden = false;
  }
  homeChatSync();
}

// The signed-in visitor's current access token, or "" for a guest.
async function homeChatToken() {
  if (!homeChatSignedIn() || !siteAuth.client) return "";
  try {
    const { data } = await siteAuth.client.auth.getSession();
    return data.session?.access_token || "";
  } catch {
    return "";
  }
}

// The answer as one CSV row: status, text, model, tool_calls, rounds, tokens, cost, guest_left.
async function askHomeChat(question) {
  const token = await homeChatToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HOME_CHAT_TIMEOUT);
  const body = new URLSearchParams({ conversation: homeChat.conversation, provider: homeChat.provider, question,
    guest: token ? "" : homeChat.guest });
  for (const { q, a } of homeChat.history.slice(-HOME_CHAT_HISTORY)) {
    body.append("q", q);
    body.append("a", a);
  }
  try {
    const response = await fetch(homeChatEndpoint(), {
      method: "POST",
      headers: { "X-Superlig-Chat": "1", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body,
      cache: "no-store",
      signal: controller.signal,
    });
    const row = (response.headers.get("Content-Type") || "").startsWith("text/csv")
      ? parseCSV(await response.text()).records[0] : null;
    if (!row) throw new Error(`HTTP ${response.status}`);
    return row;
  } finally {
    clearTimeout(timer);
  }
}

function homeChatMeta(row) {
  const model = HOME_CHAT_MODELS[row.model] || row.model;
  const cost = Number(row.cost_usd);
  return [model, row.rounds ? t("{count} tur", { count: row.rounds }, Number(row.rounds)) : "", Number.isFinite(cost) ? `$${cost.toFixed(4)}` : ""].filter(Boolean).join(" · ");
}

function homeChatGuestLeft(row) {
  const left = row.guest_left === "" || row.guest_left === undefined ? null : Number(row.guest_left);
  if (left === null || !Number.isFinite(left)) return;
  homeChat.guestLeft = left;
  homeChatStorage("homeChatGuestLeft", left);
}

async function sendHomeChat(text) {
  const question = String(text || "").trim();
  if (!question || homeChat.busy || homeChat.needsLogin || !homeChatEndpoint()) return;
  homeChat.busy = true;
  const conversation = homeChat.conversation;
  $("home-chat-suggestions").hidden = true;
  homeChatMessage("user", question);
  $("home-chat-input").value = "";
  homeChatResize();
  homeChatSync();
  const typing = homeChatTyping();
  try {
    const row = await askHomeChat(question);
    if (conversation !== homeChat.conversation) return;
    homeChatGuestLeft(row);
    if (row.status === "ok") {
      // The AI's answer as it came; knownText changes only the few lines the
      // server writes itself when the AI gave none.
      homeChatMessage("assistant", knownText(row.text), homeChatMeta(row), row.tool_calls ? t("Araçlar: {tools}", { tools: row.tool_calls }) : t("Araç kullanılmadı"));
      homeChat.history = [...homeChat.history, { q: question, a: row.text }].slice(-HOME_CHAT_HISTORY);
      // That was a guest's last question: ask them to sign in now, not after they type another.
      if (homeChat.guestLeft === 0 && !homeChatSignedIn()) {
        homeChat.needsLogin = true;
        homeChatLoginMessage(t("Misafir olarak 3 soru hakkını kullandın. Devam etmek için giriş yap."));
      }
    } else if (row.status === "login") {
      homeChat.needsLogin = true;
      homeChatLoginMessage(knownText(row.text));
    } else {
      homeChatMessage("error", knownText(row.text) || t("Yanıt alınamadı."));
    }
  } catch (error) {
    if (conversation === homeChat.conversation) {
      homeChatMessage("error", error.name === "AbortError" ? t("Yanıt çok gecikti; tekrar deneyin.")
        : siteMode === "local" ? t("Yerel sunucuya ulaşılamadı. serve.py çalışıyor mu? Kod değiştiyse yeniden başlatın.")
          : t("Asistana şu an ulaşılamadı. Biraz sonra tekrar dene."));
    }
  } finally {
    typing.remove();
    homeChat.busy = false;
    homeChatSync();
  }
}

// Signing in (here or in another tab) opens the chat again.
function homeChatAuthChanged() {
  if (homeChatSignedIn() && homeChat.needsLogin) {
    homeChat.needsLogin = false;
    homeChatMessage("assistant", t("Giriş yaptın; sorularına devam edebilirsin."));
  }
  homeChatSync();
}

function setupHomeChat() {
  const saved = homeChatStorage("homeChatProvider");
  if (HOME_CHAT_PROVIDERS.includes(saved)) homeChat.provider = saved;
  homeChat.guest = homeChatStorage("homeChatGuest") || homeChatNewId();
  homeChatStorage("homeChatGuest", homeChat.guest);
  const left = Number(homeChatStorage("homeChatGuestLeft"));
  if (homeChatStorage("homeChatGuestLeft") !== null && Number.isFinite(left)) homeChat.guestLeft = left;
  homeChat.needsLogin = homeChat.guestLeft === 0 && !homeChatSignedIn();
  for (const example of HOME_CHAT_EXAMPLES) {
    const button = element("button", "home-chat-suggestion", example);
    button.type = "button";
    button.addEventListener("click", () => sendHomeChat(example));
    $("home-chat-suggestions").append(button);
  }
  for (const button of document.querySelectorAll(".home-chat-provider button")) {
    button.addEventListener("click", () => {
      if (homeChat.busy || button.dataset.provider === homeChat.provider) return;
      homeChat.provider = button.dataset.provider;
      homeChatStorage("homeChatProvider", homeChat.provider);
      startHomeChat();
    });
  }
  const input = $("home-chat-input");
  input.addEventListener("input", () => { homeChatResize(); homeChatSync(); });
  // Enter sends; Shift+Enter starts a new line.
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendHomeChat(input.value);
    }
  });
  $("home-chat-form").addEventListener("submit", (event) => { event.preventDefault(); sendHomeChat(input.value); });
  document.addEventListener("site-auth-change", homeChatAuthChanged);
  startHomeChat();
}
