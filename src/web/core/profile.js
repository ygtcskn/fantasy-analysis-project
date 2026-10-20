"use strict";

// The signed-in visitor's profile: a nickname and a favourite club, kept in the
// Supabase profiles table (supabase/profiles.sql). Each visitor can read and
// change only their own row, and nicknames are unique; the database enforces
// both. The sidebar's account area (core/auth.js) shows the nickname and the
// club's crest once set. Until a nickname is saved, this dialog opens first
// (see profileAskDue).

// The same rule as the profiles_nickname_format check in supabase/profiles.sql.
const PROFILE_NICKNAME = /^[A-Za-z0-9ÇĞİÖŞÜçğıöşü_.-]{3,24}$/;
// Remembers, for this browser session, whom the profile was already offered to.
const PROFILE_ASKED_KEY = "fantezi-analiz-profile-asked";
const siteProfile = { userId: null, data: null, request: null, teams: null };

// A signed-in visitor without a nickname is asked for one first: right after
// signing in, and otherwise once per browser session, so a session that began
// before profiles existed is asked too and closing the dialog is respected.
function profileAskDue(user) {
  if (siteAuth.justSignedIn) return true;
  try { return sessionStorage.getItem(PROFILE_ASKED_KEY) !== user.id; } catch { return false; }
}

function askForProfile(user) {
  try { sessionStorage.setItem(PROFILE_ASKED_KEY, user.id); } catch { /* storage unavailable */ }
  openProfileDialog(true);
}

function profileCrest(teamId, size) {
  const img = document.createElement("img");
  img.className = "profile-crest";
  img.width = size;
  img.height = size;
  img.alt = "";
  img.decoding = "async";
  let png = false;
  img.addEventListener("error", () => {
    if (!png) { png = true; img.src = `assets/team-logos/${encodeURIComponent(teamId)}.png`; } else img.remove();
  });
  img.src = `assets/team-logos/${encodeURIComponent(teamId)}.svg`;
  return img;
}

async function loadProfile(user) {
  siteProfile.userId = user?.id ?? null;
  siteProfile.data = null;
  const request = siteProfile.request = user ? (async () => {
    const client = await loadAuth();
    const { data, error } = await client.from("profiles").select("nickname, favorite_team_id").eq("id", user.id).maybeSingle();
    if (error) throw error;
    return data;
  })() : null;
  renderAuthAccount();
  if (!request) return;
  try {
    const data = await request;
    if (siteProfile.request !== request) return;
    siteProfile.data = data;
    renderAuthAccount();
    if (siteAuth.user && !data?.nickname && profileAskDue(user)) askForProfile(user);
  } catch (error) {
    // The account area keeps showing the email. The profile still opens when
    // due, saying why it could not be read.
    if (siteProfile.request === request && siteAuth.user && profileAskDue(user)) {
      askForProfile(user);
      setProfileMessage(profileErrorText(error), true);
    }
  }
}

function profileErrorText(error) {
  // PostgREST reports a table it cannot find as PGRST205; Postgres as 42P01.
  if (["PGRST205", "42P01"].includes(error?.code)) {
    return siteMode === "local"
      ? "profiles tablosu yok: supabase/profiles.sql dosyasını Supabase → SQL Editor'da çalıştır."
      : "Profil şu anda kaydedilemiyor. Daha sonra tekrar dene.";
  }
  return error?.message ? `Bir sorun çıktı: ${error.message}` : "Bir sorun çıktı. Tekrar dene.";
}

function setProfileMessage(text, error = false) {
  const message = document.querySelector("#profile-dialog .auth-message");
  message.textContent = text;
  message.classList.toggle("error", error);
}

function setNicknameError(text) {
  const field = document.getElementById("profile-nickname-error");
  field.textContent = text;
  field.hidden = !text;
}

function showProfileCrest(teamId) {
  const slot = document.querySelector("#profile-dialog .profile-team-crest");
  slot.replaceChildren(...(teamId ? [profileCrest(teamId, 28)] : []));
}

async function fillProfileTeams(select) {
  try {
    siteProfile.teams ??= readSeasonTeams().then((rows) => rows
      .filter((row) => row.id && row.name)
      .sort((a, b) => a.name.localeCompare(b.name, "tr")));
    const teams = await siteProfile.teams;
    const chosen = select.value || String(siteProfile.data?.favorite_team_id ?? "");
    select.replaceChildren(new Option("Seçilmedi", ""), ...teams.map((team) => new Option(team.name, team.id)));
    // A club that has left the league stays chosen until the visitor changes it.
    if (chosen && !teams.some((team) => team.id === chosen)) select.add(new Option(`Takım ${chosen}`, chosen));
    select.value = chosen;
    select.disabled = false;
  } catch {
    siteProfile.teams = null;
    select.replaceChildren(new Option("Takımlar yüklenemedi", ""));
    select.disabled = true;
  }
}

async function saveProfile(form) {
  const input = form.querySelector("#profile-nickname"), select = form.querySelector("#profile-team");
  const button = form.querySelector("button[type=submit]"), nickname = input.value.trim();
  if (nickname && !PROFILE_NICKNAME.test(nickname)) {
    setNicknameError("Takma ad 3–24 karakter olmalı; harf, rakam, _ . - kullanabilirsin.");
    input.focus();
    return;
  }
  button.disabled = true;
  setProfileMessage("Kaydediliyor…");
  try {
    const client = await loadAuth();
    const row = { id: siteAuth.user.id, nickname: nickname || null, favorite_team_id: select.value ? Number(select.value) : null };
    const { data, error } = await client.from("profiles").upsert(row).select("nickname, favorite_team_id").single();
    if (error) throw error;
    siteProfile.data = data;
    renderAuthAccount();
    setProfileMessage("Kaydedildi.");
  } catch (error) {
    if (error?.code === "23505") {
      setNicknameError("Bu takma ad alınmış; başka bir tane dene.");
      setProfileMessage("");
      input.focus();
    } else if (error?.code === "23514") {
      setNicknameError("Takma ad 3–24 karakter olmalı; harf, rakam, _ . - kullanabilirsin.");
      setProfileMessage("");
    } else {
      setProfileMessage(profileErrorText(error), true);
    }
  } finally {
    button.disabled = false;
  }
}

function profileDialog() {
  let dialog = document.getElementById("profile-dialog");
  if (dialog) return dialog;
  dialog = document.createElement("dialog");
  dialog.id = "profile-dialog";
  dialog.className = "auth-dialog";
  dialog.setAttribute("aria-labelledby", "profile-title");
  dialog.innerHTML = `
    <div class="auth-heading"><div><p class="eyebrow">HESAP</p><h2 id="profile-title">Profil</h2></div><button type="button" class="secondary" data-profile-close>Kapat ×</button></div>
    <p id="profile-help" class="auth-help"></p>
    <form class="auth-email profile-form" novalidate>
      <label for="profile-nickname">Takma ad</label>
      <input id="profile-nickname" autocomplete="nickname" maxlength="24" spellcheck="false" aria-describedby="profile-nickname-hint profile-nickname-error">
      <p id="profile-nickname-hint" class="profile-hint">3–24 karakter: harf, rakam, _ . -</p>
      <p id="profile-nickname-error" class="auth-field-error" hidden></p>
      <label for="profile-team">Favori takım</label>
      <div class="profile-team-row"><span class="profile-team-crest" aria-hidden="true"></span><select id="profile-team" disabled><option value="">Yükleniyor…</option></select></div>
      <p id="profile-email" class="profile-hint"></p>
      <button type="submit" class="primary">Kaydet</button>
    </form>
    <p class="auth-message" role="status" aria-live="polite"></p>`;
  const form = dialog.querySelector("form"), select = dialog.querySelector("#profile-team");
  dialog.querySelector("#profile-nickname").addEventListener("input", () => setNicknameError(""));
  select.addEventListener("change", () => showProfileCrest(select.value));
  form.addEventListener("submit", (event) => { event.preventDefault(); saveProfile(form); });
  dialog.querySelector("[data-profile-close]").addEventListener("click", () => dialog.close());
  document.body.append(dialog);
  return dialog;
}

function openProfileDialog(welcome = false) {
  if (!siteAuth.user) return;
  // Offered once per sign-in, never again on the same page.
  siteAuth.justSignedIn = false;
  const dialog = profileDialog(), profile = siteProfile.data;
  dialog.querySelector("#profile-title").textContent = welcome ? "Hoş geldin" : "Profil";
  dialog.querySelector("#profile-help").textContent = welcome
    ? "Bir takma ad ve tuttuğun takımı seç. İstediğin zaman sol menüdeki Profil'den değiştirebilirsin."
    : "Maç Tribünü'ne yazdıklarında takma adın ve tuttuğun takımın arması görünür; e-postan görünmez.";
  dialog.querySelector("#profile-nickname").value = profile?.nickname || "";
  dialog.querySelector("#profile-email").textContent = `Giriş e-postası: ${siteAuth.user.email || "—"}`;
  const select = dialog.querySelector("#profile-team");
  select.value = String(profile?.favorite_team_id ?? "");
  showProfileCrest(profile?.favorite_team_id);
  setNicknameError("");
  setProfileMessage("");
  if (!dialog.open) dialog.showModal();
  fillProfileTeams(select).then(() => showProfileCrest(select.value));
}

document.addEventListener("site-auth-change", (event) => loadProfile(event.detail.user));
// A session found before this script ran has already announced itself.
if (siteAuth.known && siteAuth.user) loadProfile(siteAuth.user);
