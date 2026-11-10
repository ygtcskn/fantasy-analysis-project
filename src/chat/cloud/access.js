// Who may ask the online chat, and how much. The rules of src/chat/web_chat.py,
// kept in Cloudflare D1 (table chat_limits) because a function forgets
// everything between requests:
//
// - a guest (not signed in) gets GUEST_QUESTIONS answers per browser, and a
//   network (IP address) gets GUEST_NETWORK_DAILY guest answers a day, so
//   clearing the browser does not give endless questions;
// - a signed-in visitor gets USER_DAILY answers a day; their Supabase access
//   token is checked with Supabase itself.
//
// IP addresses are never stored, only a fingerprint (SHA-256) of them.

import { ChatError } from "./assistant.js";

export const GUEST_QUESTIONS = 3;
export const GUEST_NETWORK_DAILY = 10;
export const USER_DAILY = 50;
export const LOGIN_NEEDED = "Misafir olarak 3 soru hakkını kullandın. Devam etmek için giriş yap.";
export const LOGIN_EXPIRED = "Oturumun sona ermiş. Devam etmek için yeniden giriş yap.";
const NETWORK_FULL = "Bu ağdan bugün misafir olarak çok soru soruldu. Devam etmek için giriş yap.";
const USER_FULL = "Bugünlük soru hakkın doldu. Yarın tekrar sorabilirsin.";

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The site's Supabase project, read from the website's own auth-config.js (one
// place for both). Public values: every visitor's browser has them.
let supabase = null;
async function supabaseSettings(env, requestUrl) {
  if (supabase) return supabase;
  const response = await env.ASSETS.fetch(new URL("/core/auth-config.js", requestUrl));
  const text = response.ok ? await response.text() : "";
  const url = /\burl:\s*"([^"]*)"/.exec(text), key = /\bkey:\s*"([^"]*)"/.exec(text);
  supabase = { url: url ? url[1].replace(/\/+$/, "") : "", key: key ? key[1] : "" };
  return supabase;
}

// The signed-in user's id for an access token, asked of Supabase; null for a token it refuses.
export async function signedInUser(env, requestUrl, token) {
  const { url, key } = await supabaseSettings(env, requestUrl);
  if (!url || !key) throw new ChatError("Giriş bu sitede kapalı.", 503);
  let response;
  try {
    response = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000) });
  } catch {
    throw new ChatError("Giriş doğrulanamadı. Bağlantıyı kontrol edip tekrar deneyin.", 503);
  }
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new ChatError("Giriş doğrulanamadı. Biraz sonra tekrar deneyin.", 503);
  const user = await response.json().catch(() => null);
  return user && user.id ? String(user.id) : null;
}

// Count one question against a key for a day ("all" for a count that never
// resets) and return the new total; the count is kept even when it goes over,
// and give() takes it back.
async function take(db, key, day) {
  const row = await db.prepare(`INSERT INTO chat_limits (key, day, used) VALUES (?, ?, 1)
      ON CONFLICT(key) DO UPDATE SET used = CASE WHEN chat_limits.day = excluded.day THEN chat_limits.used + 1 ELSE 1 END,
      day = excluded.day RETURNING used`).bind(key, day).first();
  return row ? row.used : 1;
}

async function give(db, key) {
  await db.prepare("UPDATE chat_limits SET used = MAX(used - 1, 0) WHERE key = ?").bind(key).run();
}

// Count a question before it is asked. Returns { left, release }: the guest's
// answers left (null for a signed-in visitor) and a function that gives the
// question back when it got no answer.
export async function takeQuestion(env, request, db, { token, guest }) {
  if (token) {
    const user = await signedInUser(env, request.url, token);
    if (!user) throw new ChatError(LOGIN_EXPIRED, 401, "login");
    const key = `u:${await sha256(user)}`;
    if (await take(db, key, today()) > USER_DAILY) {
      await give(db, key);
      throw new ChatError(USER_FULL, 429);
    }
    return { left: null, release: () => give(db, key) };
  }
  const guestKey = `g:${guest}`;
  const used = await take(db, guestKey, "all");
  if (used > GUEST_QUESTIONS) {
    await give(db, guestKey);
    throw new ChatError(LOGIN_NEEDED, 401, "login");
  }
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const networkKey = `n:${await sha256(`${ip}|${env.CHAT_IP_SALT || "fantezianaliz"}`)}`;
  if (await take(db, networkKey, today()) > GUEST_NETWORK_DAILY) {
    await give(db, networkKey);
    await give(db, guestKey);
    throw new ChatError(NETWORK_FULL, 401, "login");
  }
  return { left: GUEST_QUESTIONS - used, release: async () => { await give(db, guestKey); await give(db, networkKey); } };
}
