"use strict";

// Optional sign-in for visitors, through Supabase Auth (settings in
// core/auth-config.js). Every page works the same signed out; signing in gives a
// visitor an account that later features can build on. There are no passwords:
// visitors continue with Google or open a one-time link sent to their email, and
// the first sign-in creates the account. The Supabase library loads only when
// someone opens the sign-in dialog, already has a session, or comes back from a
// sign-in, so visitors who never sign in download none of it.

const AUTH_LIBRARY = {
  src: "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js",
  // The browser refuses the file if the CDN ever serves anything else.
  integrity: "sha384-Rj26LVGvoeRVR6+mwQmFfcR3QOBEwT+ZmuCWpuiqeTzJpCs0ER4ITAWGb4Hiy3Ok",
};
// Where the session is kept in this browser. Named here rather than left to the
// library, so a page can recognise a returning visitor without loading it.
const AUTH_STORAGE_KEY = "fantezi-analiz-auth";
// What Supabase adds to the address when it sends a visitor back after sign-in.
const AUTH_RETURN_PARAMS = ["code", "error", "error_code", "error_description"];

// user is the signed-in Supabase user, or null. Features should listen for
// "site-auth-change" on document instead of reading it once. justSignedIn is
// true while a sign-in has just completed on this page: it arrived from a
// sign-in link or Google, or another tab completed the sign-in while this one
// was showing the sign-in dialog. The profile opens first on such a page.
const siteAuth = { user: null, known: false, client: null, loading: null, startError: null, justSignedIn: false };

function authEnabled() {
  return siteMode !== "none" && typeof SITE_AUTH !== "undefined" && Boolean(SITE_AUTH.url && SITE_AUTH.key);
}

function authReturning() {
  const params = new URLSearchParams(location.search);
  return AUTH_RETURN_PARAMS.some((name) => params.has(name)) || /(?:access_token|error_description)=/.test(location.hash);
}

function authStored() {
  try { return Boolean(localStorage.getItem(AUTH_STORAGE_KEY)); } catch { return false; }
}

// This page's address without what Supabase added, so a sign-in brings the
// visitor back to the page they started from.
function authReturnUrl() {
  const url = new URL(location.href);
  for (const name of AUTH_RETURN_PARAMS) url.searchParams.delete(name);
  if (/(?:access_token|error_description)=/.test(url.hash)) url.hash = "";
  return url.href;
}

function authReturnProblem() {
  const search = new URLSearchParams(location.search), hash = new URLSearchParams(location.hash.slice(1));
  const code = search.get("error_code") || hash.get("error_code");
  const description = search.get("error_description") || hash.get("error_description");
  if (code === "otp_expired") return t("Giriş bağlantısının süresi dolmuş ya da bağlantı zaten kullanılmış. Yeni bir bağlantı iste.");
  return code || description ? t("Giriş tamamlanamadı: {reason}", { reason: description || code }) : "";
}

function loadAuth() {
  siteAuth.loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = AUTH_LIBRARY.src;
    script.integrity = AUTH_LIBRARY.integrity;
    script.crossOrigin = "anonymous";
    script.addEventListener("load", () => resolve(window.supabase));
    script.addEventListener("error", () => reject(new Error(t("Giriş hizmeti yüklenemedi. Bağlantını kontrol edip tekrar dene."))));
    document.head.append(script);
  }).then(async (library) => {
    // The project's address alone: a URL copied with a path such as /rest/v1/
    // would send sign-in requests to the wrong place.
    const client = library.createClient(new URL(SITE_AUTH.url).origin, SITE_AUTH.key, {
      auth: { flowType: "pkce", storageKey: AUTH_STORAGE_KEY, persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    siteAuth.client = client;
    client.auth.onAuthStateChange((event, session) => setAuthUser(session?.user ?? null));
    // Start-up exchanges a returning sign-in's code for a session; its error is
    // the only place a failed exchange is reported.
    const { error } = await client.auth.initialize();
    siteAuth.startError = error;
    const { data } = await client.auth.getSession();
    setAuthUser(data.session?.user ?? null);
    return client;
  });
  siteAuth.loading.catch(() => { siteAuth.loading = null; });
  return siteAuth.loading;
}

function setAuthUser(user) {
  const changed = !siteAuth.known || (siteAuth.user?.id ?? null) !== (user?.id ?? null);
  // The email link opens in a new tab; Supabase tells this tab too. The "link
  // sent" dialog has done its job, and this tab moves on to the profile as well.
  const dialog = document.getElementById("auth-dialog");
  if (user && !siteAuth.user && dialog?.open) {
    dialog.close();
    siteAuth.justSignedIn = true;
  }
  siteAuth.user = user;
  siteAuth.known = true;
  renderAuthAccount();
  if (changed) document.dispatchEvent(new CustomEvent("site-auth-change", { detail: { user } }));
}

function authButton(symbol, label, onClick) {
  const button = document.createElement("button"), icon = document.createElement("span");
  button.type = "button";
  button.className = "nav-button";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = symbol;
  button.append(icon, ` ${label}`);
  button.addEventListener("click", onClick);
  return button;
}

// The account area at the foot of the sidebar. It stays empty until the
// session is known, so a signed-in visitor never sees "Giriş yap" flash past.
function renderAuthAccount() {
  const area = document.getElementById("rail-account");
  if (!area) return;
  area.hidden = !siteAuth.known;
  if (!siteAuth.known) return;
  if (siteAuth.user) {
    // core/profile.js, when loaded, supplies the nickname, photo and Profil button.
    const profile = typeof siteProfile !== "undefined" && siteProfile.userId === siteAuth.user.id ? siteProfile.data : null;
    const who = document.createElement("p");
    who.className = "rail-account-email";
    if (typeof profileAvatar === "function") {
      who.append(profileAvatar({ nickname: profile?.nickname || siteAuth.user.email, avatar_path: profile?.avatar_path }, 24));
    }
    who.append(profile?.nickname || siteAuth.user.email || t("Giriş yapıldı"));
    const buttons = typeof openProfileDialog === "function" ? [authButton("☺", t("Profil"), () => openProfileDialog())] : [];
    area.replaceChildren(who, ...buttons, authButton("←", t("Çıkış yap"), signOutAuth));
  } else {
    area.replaceChildren(authButton("→", t("Giriş yap"), () => openAuthDialog()));
  }
}

async function signOutAuth() {
  try {
    const client = await loadAuth();
    // Only this browser: other devices stay signed in until they sign out.
    await client.auth.signOut({ scope: "local" });
  } catch {
    // The session is cleared below either way.
  }
  try { localStorage.removeItem(AUTH_STORAGE_KEY); } catch { /* storage unavailable */ }
  setAuthUser(null);
}

function setAuthMessage(text, error = false) {
  const message = document.querySelector("#auth-dialog .auth-message");
  message.textContent = text;
  message.classList.toggle("error", error);
}

function authErrorText(error) {
  if (error?.status === 429) return t("Çok fazla deneme yapıldı. Birkaç dakika sonra tekrar dene.");
  if (/not authorized/i.test(error?.message || "")) return t("Bu adrese şu anda giriş bağlantısı gönderilemiyor.");
  return error?.message ? t("Bir sorun çıktı: {reason}", { reason: error.message }) : t("Bir sorun çıktı. Tekrar dene.");
}

async function signInWithGoogle(button) {
  button.disabled = true;
  setAuthMessage(t("Google'a yönlendiriliyorsun…"));
  try {
    const client = await loadAuth();
    const { error } = await client.auth.signInWithOAuth({ provider: "google", options: { redirectTo: authReturnUrl() } });
    if (error) throw error;
  } catch (error) {
    setAuthMessage(authErrorText(error), true);
    button.disabled = false;
  }
}

async function sendAuthLink(form) {
  const input = form.querySelector("input"), fieldError = form.querySelector(".auth-field-error");
  const button = form.querySelector("button"), email = input.value.trim();
  if (!email || !input.checkValidity()) {
    fieldError.textContent = email ? t("Geçerli bir e-posta adresi yaz.") : t("E-posta adresini yaz.");
    fieldError.hidden = false;
    input.focus();
    return;
  }
  button.disabled = true;
  setAuthMessage(t("Bağlantı gönderiliyor…"));
  try {
    const client = await loadAuth();
    const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: authReturnUrl(), shouldCreateUser: true } });
    if (error) throw error;
    setAuthMessage(t("Giriş bağlantısını {email} adresine gönderdik. E-postadaki bağlantıyı bu tarayıcıda aç; birkaç dakika içinde gelmezse istenmeyen e-postalara bak.", { email }));
  } catch (error) {
    setAuthMessage(authErrorText(error), true);
  } finally {
    button.disabled = false;
  }
}

function authDialog() {
  let dialog = document.getElementById("auth-dialog");
  if (dialog) return dialog;
  dialog = document.createElement("dialog");
  dialog.id = "auth-dialog";
  dialog.className = "auth-dialog";
  dialog.setAttribute("aria-labelledby", "auth-title");
  dialog.innerHTML = `
    <div class="auth-heading"><div><p class="eyebrow">HESAP</p><h2 id="auth-title">Giriş yap</h2></div><button type="button" class="secondary" data-auth-close>Kapat ×</button></div>
    <p class="auth-help">Site herkese açık; giriş yapmak sana bir hesap açar. Şifre yok: ilk girişinde hesabın kendiliğinden oluşur.</p>
    <div class="auth-options"></div>
    <p class="auth-message" role="status" aria-live="polite"></p>
    <p class="auth-privacy">E-posta adresin yalnızca giriş için kullanılır.</p>`;
  translateElement(dialog);
  const options = dialog.querySelector(".auth-options");
  SITE_AUTH.providers.forEach((provider, index) => {
    if (index) {
      const divider = document.createElement("p");
      divider.className = "auth-divider";
      divider.textContent = t("ya da");
      options.append(divider);
    }
    if (provider === "google") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary";
      button.textContent = t("Google ile devam et");
      button.addEventListener("click", () => signInWithGoogle(button));
      options.append(button);
    } else if (provider === "email") {
      const form = document.createElement("form");
      form.className = "auth-email";
      form.noValidate = true;
      form.innerHTML = `
        <label for="auth-email">E-posta</label>
        <input id="auth-email" type="email" autocomplete="email" required placeholder="ad@ornek.com" aria-describedby="auth-email-error">
        <p id="auth-email-error" class="auth-field-error" hidden></p>
        <button type="submit" class="primary">Giriş bağlantısı gönder</button>`;
      translateElement(form);
      form.querySelector("input").addEventListener("input", () => { form.querySelector(".auth-field-error").hidden = true; });
      form.addEventListener("submit", (event) => { event.preventDefault(); sendAuthLink(form); });
      options.append(form);
    }
  });
  dialog.querySelector("[data-auth-close]").addEventListener("click", () => dialog.close());
  document.body.append(dialog);
  return dialog;
}

function openAuthDialog(problem = "") {
  const dialog = authDialog();
  setAuthMessage(problem, Boolean(problem));
  if (!dialog.open) dialog.showModal();
  // Fetched while the visitor chooses, so the first click does not wait for it.
  loadAuth().catch((error) => setAuthMessage(error.message, true));
}

function setupAuth() {
  if (!authEnabled()) return;
  if (!authStored() && !authReturning()) {
    setAuthUser(null);
    return;
  }
  const returning = authReturning(), problem = authReturnProblem();
  siteAuth.justSignedIn = returning && !problem;
  loadAuth().then(() => {
    if (!returning) return;
    history.replaceState(history.state, "", authReturnUrl());
    if (problem) openAuthDialog(problem);
    else if (siteAuth.startError && !siteAuth.user) {
      // PKCE keeps half of the exchange in the browser that asked for the link.
      openAuthDialog(/verifier/i.test(siteAuth.startError.message || "")
        ? t("Bu bağlantı başka bir tarayıcıda istenmiş. Bağlantıyı, giriş istediğin tarayıcıda aç ya da buradan yeni bir bağlantı iste.")
        : authErrorText(siteAuth.startError));
    }
  }).catch((error) => {
    setAuthUser(null);
    if (returning) openAuthDialog(error.message);
  });
}

setupAuth();
