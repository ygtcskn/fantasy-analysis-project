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

// Reading needs nothing; anything that shows a visitor's name to others needs a
// session and a nickname. Each missing step opens the dialog that supplies it,
// saying why. A stored session still being restored is waited for first.
async function profileReady(signInText, nicknameText) {
  await siteAuth.loading?.catch(() => {});
  if (!siteAuth.user) {
    openAuthDialog();
    setAuthMessage(signInText);
    return false;
  }
  await siteProfile.request?.catch(() => {});
  if (!siteProfile.data?.nickname) {
    openProfileDialog();
    setProfileMessage(nicknameText);
    return false;
  }
  return true;
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

// Profile photos live in the public "avatars" bucket (supabase/avatars.sql),
// one folder per visitor. Each upload gets a new name, so browsers may keep a
// photo for good and a change still shows at once.
const AVATAR_BUCKET = "avatars";
const AVATAR_SIZE = 256;
const AVATAR_MAX_INPUT = 15 * 1024 * 1024;

function avatarUrl(path) {
  return `${new URL(SITE_AUTH.url).origin}/storage/v1/object/public/${AVATAR_BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

// How a person appears wherever the site shows one - the sidebar, the profile,
// Maç Tribünü, shared squads: their photo in a circle, else the first letter of
// their nickname in the same circle. Never a club's crest; a crest stands for
// a club. A photo that no longer loads, say one removed by moderation, leaves
// the letter. person is { nickname, avatar_path }.
function profileAvatar(person, size) {
  const avatar = document.createElement("span");
  avatar.className = "profile-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.style.setProperty("--avatar-size", `${size}px`);
  avatar.textContent = String(person?.nickname || "?").charAt(0).toLocaleUpperCase(LOCALE);
  if (person?.avatar_path) {
    const img = document.createElement("img");
    img.width = size;
    img.height = size;
    img.alt = "";
    img.decoding = "async";
    img.addEventListener("error", () => img.remove(), { once: true });
    img.src = avatarUrl(person.avatar_path);
    avatar.append(img);
  }
  return avatar;
}

// A square, centre-cropped, 256-pixel copy of the chosen picture. Drawing it
// afresh keeps only the pixels, so anything the camera stored, such as the
// place it was taken, never leaves the visitor's device.
async function avatarImage(file) {
  if (!file.type.startsWith("image/")) throw new Error(t("Bir resim dosyası seç: JPG, PNG ya da WebP."));
  if (file.size > AVATAR_MAX_INPUT) throw new Error(t("Bu dosya çok büyük; 15 MB'tan küçük bir resim seç."));
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(t("Bu resim açılamadı. JPG ya da PNG dene."));
  }
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const context = canvas.getContext("2d");
  // Transparent parts take the page's own surface colour rather than black.
  context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim() || "#171020";
  context.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  bitmap.close();
  const encode = (type) => new Promise((resolve) => canvas.toBlob(resolve, type, 0.85));
  // A browser that cannot write WebP hands back a PNG; JPEG is far smaller then.
  let blob = await encode("image/webp");
  if (!blob || blob.type !== "image/webp") blob = await encode("image/jpeg");
  if (!blob) throw new Error(t("Resim hazırlanamadı. Başka bir resim dene."));
  return blob;
}

function avatarErrorText(error) {
  const message = error?.message || "";
  if (/bucket not found/i.test(message)) {
    return siteMode === "local"
      ? t("avatars deposu yok: supabase/avatars.sql dosyasını Supabase → SQL Editor'da çalıştır.")
      : t("Fotoğraf şu anda yüklenemiyor. Daha sonra tekrar dene.");
  }
  if (/maximum allowed size|payload too large/i.test(message)) return t("Fotoğraf çok büyük. Başka bir resim dene.");
  if (/row-level security|unauthorized/i.test(message)) return t("Fotoğraf yüklenemedi. Biraz sonra tekrar dene.");
  // The avatar_path column is missing until profiles.sql is run again.
  if (error?.code === "PGRST204" || error?.code === "42703") {
    return siteMode === "local"
      ? t("Fotoğraf sütunu yok: supabase/profiles.sql, match_discussions.sql ve avatars.sql'i yeniden çalıştır.")
      : t("Fotoğraf şu anda kaydedilemiyor. Daha sonra tekrar dene.");
  }
  return error?.code ? profileErrorText(error) : message || t("Bir sorun çıktı. Tekrar dene.");
}

// Every file in the visitor's folder except keep. The bucket allows three per
// person, so leftovers from an interrupted change are cleared before uploading.
async function removeAvatarFiles(storage, userId, keep = null) {
  const { data } = await storage.list(userId, { limit: 50 });
  const stale = (data || []).map((file) => `${userId}/${file.name}`).filter((path) => path !== keep);
  if (stale.length) await storage.remove(stale);
}

function showProfileAvatar() {
  const dialog = document.getElementById("profile-dialog"), profile = siteProfile.data;
  const person = { nickname: profile?.nickname || siteAuth.user?.email, avatar_path: profile?.avatar_path };
  dialog.querySelector(".profile-avatar-preview").replaceChildren(profileAvatar(person, 72));
  dialog.querySelector("[data-avatar-remove]").hidden = !profile?.avatar_path;
}

function setAvatarBusy(busy) {
  for (const button of document.querySelectorAll("#profile-dialog .profile-avatar-buttons button")) button.disabled = busy;
}

async function uploadAvatar(file) {
  const user = siteAuth.user;
  if (!user || !file) return;
  setAvatarBusy(true);
  setProfileMessage(t("Fotoğraf hazırlanıyor…"));
  try {
    const blob = await avatarImage(file);
    const client = await loadAuth(), storage = client.storage.from(AVATAR_BUCKET);
    const previous = siteProfile.data?.avatar_path || null;
    await removeAvatarFiles(storage, user.id, previous);
    const path = `${user.id}/${Date.now().toString(36)}.${blob.type === "image/webp" ? "webp" : "jpg"}`;
    setProfileMessage(t("Fotoğraf yükleniyor…"));
    const upload = await storage.upload(path, blob, { contentType: blob.type, cacheControl: "31536000", upsert: false });
    if (upload.error) throw upload.error;
    const saved = await client.from("profiles").upsert({ id: user.id, avatar_path: path }).select("*").single();
    if (saved.error) {
      await storage.remove([path]);
      throw saved.error;
    }
    siteProfile.data = saved.data;
    if (previous) await storage.remove([previous]);
    renderAuthAccount();
    showProfileAvatar();
    setProfileMessage(t("Fotoğrafın güncellendi."));
  } catch (error) {
    setProfileMessage(avatarErrorText(error), true);
  } finally {
    setAvatarBusy(false);
  }
}

async function removeAvatar() {
  const user = siteAuth.user;
  if (!user || !siteProfile.data?.avatar_path || !confirm(t("Profil fotoğrafın kaldırılsın mı?"))) return;
  setAvatarBusy(true);
  setProfileMessage(t("Fotoğraf kaldırılıyor…"));
  try {
    const client = await loadAuth();
    const saved = await client.from("profiles").update({ avatar_path: null }).eq("id", user.id).select("*").single();
    if (saved.error) throw saved.error;
    siteProfile.data = saved.data;
    await removeAvatarFiles(client.storage.from(AVATAR_BUCKET), user.id);
    renderAuthAccount();
    showProfileAvatar();
    setProfileMessage(t("Fotoğrafın kaldırıldı."));
  } catch (error) {
    setProfileMessage(avatarErrorText(error), true);
  } finally {
    setAvatarBusy(false);
  }
}

async function loadProfile(user) {
  siteProfile.userId = user?.id ?? null;
  siteProfile.data = null;
  const request = siteProfile.request = user ? (async () => {
    const client = await loadAuth();
    // Every column, so a column added later (avatar_path) is used once it exists
    // and its absence never breaks the profile.
    const { data, error } = await client.from("profiles").select("*").eq("id", user.id).maybeSingle();
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
      ? t("profiles tablosu yok: supabase/profiles.sql dosyasını Supabase → SQL Editor'da çalıştır.")
      : t("Profil şu anda kaydedilemiyor. Daha sonra tekrar dene.");
  }
  return error?.message ? t("Bir sorun çıktı: {reason}", { reason: error.message }) : t("Bir sorun çıktı. Tekrar dene.");
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
      .sort((a, b) => a.name.localeCompare(b.name, LOCALE)));
    const teams = await siteProfile.teams;
    const chosen = select.value || String(siteProfile.data?.favorite_team_id ?? "");
    select.replaceChildren(new Option(t("Seçilmedi"), ""), ...teams.map((team) => new Option(team.name, team.id)));
    // A club that has left the league stays chosen until the visitor changes it.
    if (chosen && !teams.some((team) => team.id === chosen)) select.add(new Option(t("Takım {id}", { id: chosen }), chosen));
    select.value = chosen;
    select.disabled = false;
  } catch {
    siteProfile.teams = null;
    select.replaceChildren(new Option(t("Takımlar yüklenemedi"), ""));
    select.disabled = true;
  }
}

async function saveProfile(form) {
  const input = form.querySelector("#profile-nickname"), select = form.querySelector("#profile-team");
  const button = form.querySelector("button[type=submit]"), nickname = input.value.trim();
  if (nickname && !PROFILE_NICKNAME.test(nickname)) {
    setNicknameError(t("Takma ad 3–24 karakter olmalı; harf, rakam, _ . - kullanabilirsin."));
    input.focus();
    return;
  }
  button.disabled = true;
  setProfileMessage(t("Kaydediliyor…"));
  try {
    const client = await loadAuth();
    const row = { id: siteAuth.user.id, nickname: nickname || null, favorite_team_id: select.value ? Number(select.value) : null };
    const { data, error } = await client.from("profiles").upsert(row).select("*").single();
    if (error) throw error;
    siteProfile.data = data;
    renderAuthAccount();
    setProfileMessage(t("Kaydedildi."));
  } catch (error) {
    if (error?.code === "23505") {
      setNicknameError(t("Bu takma ad alınmış; başka bir tane dene."));
      setProfileMessage("");
      input.focus();
    } else if (error?.code === "23514") {
      setNicknameError(t("Takma ad 3–24 karakter olmalı; harf, rakam, _ . - kullanabilirsin."));
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
    <div class="profile-avatar-row">
      <span class="profile-avatar-preview" aria-hidden="true"></span>
      <div>
        <p class="profile-avatar-label">Profil fotoğrafı</p>
        <div class="profile-avatar-buttons"><button type="button" class="secondary" data-avatar-choose>Fotoğraf yükle</button><button type="button" class="text-button" data-avatar-remove hidden>Kaldır</button></div>
        <p class="profile-hint">Kare olarak kırpılır ve küçültülür; herkes görebilir.</p>
        <input type="file" accept="image/*" hidden data-avatar-file>
      </div>
    </div>
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
  translateElement(dialog);
  const form = dialog.querySelector("form"), select = dialog.querySelector("#profile-team");
  dialog.querySelector("#profile-nickname").addEventListener("input", () => setNicknameError(""));
  select.addEventListener("change", () => showProfileCrest(select.value));
  form.addEventListener("submit", (event) => { event.preventDefault(); saveProfile(form); });
  const file = dialog.querySelector("[data-avatar-file]");
  dialog.querySelector("[data-avatar-choose]").addEventListener("click", () => file.click());
  file.addEventListener("change", () => {
    uploadAvatar(file.files[0]);
    // Cleared, so choosing the same file again still counts as a change.
    file.value = "";
  });
  dialog.querySelector("[data-avatar-remove]").addEventListener("click", removeAvatar);
  dialog.querySelector("[data-profile-close]").addEventListener("click", () => dialog.close());
  document.body.append(dialog);
  return dialog;
}

function openProfileDialog(welcome = false) {
  if (!siteAuth.user) return;
  // Offered once per sign-in, never again on the same page.
  siteAuth.justSignedIn = false;
  const dialog = profileDialog(), profile = siteProfile.data;
  dialog.querySelector("#profile-title").textContent = welcome ? t("Hoş geldin") : t("Profil");
  dialog.querySelector("#profile-help").textContent = welcome
    ? t("Bir takma ad, tuttuğun takım ve istersen bir fotoğraf seç. İstediğin zaman sol menüdeki Profil'den değiştirebilirsin.")
    : t("Maç Tribünü'nde ve paylaştığın kadrolarda takma adın ve profil fotoğrafın görünür; e-postan görünmez.");
  dialog.querySelector("#profile-nickname").value = profile?.nickname || "";
  dialog.querySelector("#profile-email").textContent = t("Giriş e-postası: {email}", { email: siteAuth.user.email || "—" });
  const select = dialog.querySelector("#profile-team");
  select.value = String(profile?.favorite_team_id ?? "");
  showProfileCrest(profile?.favorite_team_id);
  showProfileAvatar();
  setAvatarBusy(false);
  setNicknameError("");
  setProfileMessage("");
  if (!dialog.open) dialog.showModal();
  fillProfileTeams(select).then(() => showProfileCrest(select.value));
}

document.addEventListener("site-auth-change", (event) => loadProfile(event.detail.user));
// A session found before this script ran has already announced itself.
if (siteAuth.known && siteAuth.user) loadProfile(siteAuth.user);
