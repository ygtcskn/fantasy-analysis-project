"use strict";

// Maç Tribünü: topics under each match and replies under each topic, kept in
// Supabase (supabase/match_discussions.sql). Anyone can read. Posting needs a
// signed-in visitor with a nickname (core/auth.js, core/profile.js); the
// database decides who wrote a post, never this page. Only unsent drafts on
// the open page are kept in the browser.

// Every column: posts carry the author's nickname, club and photo, and a column
// added later (author_avatar_path) is used once it exists without breaking reads.
const SOCIAL_POST_FIELDS = "*";
const socialState = {
  round: null,
  loadedKey: "", request: 0, status: "idle", error: "",
  // Fixture ID -> its topics, newest first, each with its replies oldest first.
  topics: new Map(),
  // Topic IDs whose discussion is open, and drafts by "fixture:<id>" or
  // "topic:<id>", so a redraw never closes what the visitor is reading or typing.
  open: new Set(),
  drafts: new Map(),
};
const socialTimeFormat = new Intl.DateTimeFormat(LOCALE, { timeZone: MATCH_TIME_ZONE, dateStyle: "medium", timeStyle: "short" });
const socialDayFormat = new Intl.DateTimeFormat(LOCALE, { timeZone: MATCH_TIME_ZONE, day: "numeric", month: "short" });

function socialNode(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function socialButton(label, handler, className = "social-button") {
  const button = socialNode("button", className, label);
  button.type = "button";
  button.addEventListener("click", handler);
  return button;
}

function setSocialStatus(text) {
  document.getElementById("social-status").textContent = text;
}

function socialErrorText(error) {
  const message = error?.message || "";
  if (message.includes("nickname_required")) return t("Yazmadan önce profilinden bir takma ad seç.");
  if (message.includes("rate_limited")) return t("Çok hızlı yazıyorsun. Bir dakika sonra tekrar dene.");
  if (message.includes("sign_in_required")) return t("Yazmak için giriş yap.");
  if (error?.code === "23514") return t("Başlık 3–120 karakter, metin en fazla 3000 karakter olmalı.");
  if (["PGRST205", "42P01"].includes(error?.code)) {
    return siteMode === "local"
      ? t("Tribün tabloları yok: supabase/match_discussions.sql dosyasını Supabase → SQL Editor'da çalıştır.")
      : t("Maç Tribünü şu anda kullanılamıyor. Daha sonra tekrar dene.");
  }
  return message ? t("Bir sorun çıktı: {reason}", { reason: message }) : t("Bir sorun çıktı. Tekrar dene.");
}

function socialReadyToPost() {
  return profileReady(t("Konu açmak ve yanıt yazmak için giriş yap. Okumak için gerekmez."),
    t("Yazmadan önce bir takma ad seç; yazılarında o görünür."));
}

async function loadSocialRound(fixtureIds, key) {
  const request = ++socialState.request;
  Object.assign(socialState, { loadedKey: key, status: "loading", error: "" });
  try {
    const client = await loadAuth();
    const topics = await client.from("match_topics").select(SOCIAL_POST_FIELDS)
      .eq("season", state.seasonSlug).in("fixture_id", fixtureIds).order("created_at", { ascending: false });
    if (topics.error) throw topics.error;
    const ids = topics.data.map((topic) => topic.id);
    const replies = ids.length
      ? await client.from("match_replies").select(SOCIAL_POST_FIELDS).in("topic_id", ids).order("created_at")
      : { data: [], error: null };
    if (replies.error) throw replies.error;
    if (request !== socialState.request) return;
    const byTopic = new Map(ids.map((id) => [id, []]));
    for (const reply of replies.data) byTopic.get(reply.topic_id)?.push(reply);
    socialState.topics = new Map();
    for (const topic of topics.data) {
      const fixture = String(topic.fixture_id);
      if (!socialState.topics.has(fixture)) socialState.topics.set(fixture, []);
      socialState.topics.get(fixture).push({ ...topic, replies: byTopic.get(topic.id) });
    }
    socialState.status = "ready";
  } catch (error) {
    if (request !== socialState.request) return;
    Object.assign(socialState, { status: "error", error: socialErrorText(error) });
  }
  if (state.view === "social") renderSocial();
}

function focusSocialDraft(key) {
  document.querySelector(`[data-draft="${key}"] :is(input, textarea)`)?.focus();
}

async function startSocialDraft(key, topicId) {
  if (!await socialReadyToPost()) return;
  if (!socialState.drafts.has(key)) socialState.drafts.set(key, {});
  if (topicId) socialState.open.add(topicId);
  renderSocial();
  focusSocialDraft(key);
}

function socialField(form, label, name, multiline, maxLength, value = "") {
  const wrapper = socialNode("label", "", label);
  const input = document.createElement(multiline ? "textarea" : "input");
  input.name = name;
  input.maxLength = maxLength;
  input.value = value || "";
  if (multiline) input.rows = 4;
  wrapper.append(input);
  form.append(wrapper);
  return input;
}

function socialForm(draftKey, isTopic, onSubmit) {
  const draft = socialState.drafts.get(draftKey) || {};
  const form = socialNode("form", "social-form");
  form.noValidate = true;
  form.dataset.draft = draftKey;
  const author = socialNode("p", "social-form-author", `${t("Yazan:")} `);
  author.append(profileAvatar(siteProfile.data, 20), siteProfile.data?.nickname || "—");
  form.append(author);
  const title = isTopic ? socialField(form, t("Konu başlığı"), "title", false, 120, draft.title) : null;
  const body = socialField(form, isTopic ? t("Ne düşünüyorsun?") : t("Yanıtın"), "body", true, 3000, draft.body);
  const error = socialNode("p", "social-form-error");
  error.hidden = true;
  const actions = socialNode("div", "social-actions");
  const submit = socialNode("button", "social-button social-submit", isTopic ? t("Konuyu aç") : t("Yanıtla"));
  submit.type = "submit";
  actions.append(submit, socialButton(t("Vazgeç"), () => { socialState.drafts.delete(draftKey); renderSocial(); }));
  form.append(error, actions);
  form.addEventListener("input", () => {
    socialState.drafts.set(draftKey, { title: title?.value, body: body.value });
    error.hidden = true;
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = { title: title?.value.trim(), body: body.value.trim() };
    const problem = isTopic && values.title.length < 3 ? t("Başlık en az 3 karakter olmalı.")
      : !values.body ? t("Bir şeyler yaz.") : "";
    if (problem) {
      error.textContent = problem;
      error.hidden = false;
      (isTopic && values.title.length < 3 ? title : body).focus();
      return;
    }
    submit.disabled = true;
    try {
      await onSubmit(values);
      socialState.drafts.delete(draftKey);
      renderSocial();
    } catch (failure) {
      error.textContent = socialErrorText(failure);
      error.hidden = false;
      submit.disabled = false;
      if ((failure?.message || "").includes("nickname_required")) openProfileDialog();
    }
  });
  return form;
}

async function deleteSocialPost(table, post, removeLocally) {
  const question = table === "match_topics" ? t("Bu konu ve altındaki bütün yanıtlar silinsin mi?") : t("Bu yanıt silinsin mi?");
  if (!confirm(question)) return;
  try {
    const client = await loadAuth();
    // Row-level security lets only the author delete; a row it refuses is simply not deleted.
    const { data, error } = await client.from(table).delete().eq("id", post.id).select("id");
    if (error) throw error;
    if (!data.length) throw new Error(t("Bu yazı silinemedi."));
    removeLocally();
    setSocialStatus(table === "match_topics" ? t("Konun silindi.") : t("Yanıtın silindi."));
    renderSocial();
  } catch (error) {
    setSocialStatus(socialErrorText(error));
  }
}

// The author as everywhere a person appears: their photo, else their initial.
function socialAuthorAvatar(post, size) {
  return profileAvatar({ nickname: post.author_nickname, avatar_path: post.author_avatar_path }, size);
}

function socialPost(post, table, removeLocally) {
  const article = socialNode("article", "social-post");
  const meta = socialNode("p", "social-post-meta");
  meta.append(socialAuthorAvatar(post, 22));
  const time = socialNode("time", "", socialTimeFormat.format(new Date(post.created_at)));
  time.dateTime = post.created_at;
  meta.append(socialNode("strong", "", post.author_nickname), document.createTextNode(" · "), time);
  if (siteAuth.user?.id === post.user_id) {
    meta.append(socialButton(t("Sil"), () => deleteSocialPost(table, post, removeLocally), "social-delete"));
  }
  article.append(meta, socialNode("p", "social-post-body", post.body));
  return article;
}

function socialTopicRow(topic, siblings) {
  const details = socialNode("details", "social-topic");
  const draftKey = `topic:${topic.id}`;
  details.open = socialState.open.has(topic.id) || socialState.drafts.has(draftKey);
  details.addEventListener("toggle", () => {
    if (details.open) socialState.open.add(topic.id); else socialState.open.delete(topic.id);
  });
  const summary = socialNode("summary", "social-topic-row");
  const identity = socialNode("span", "social-topic-identity");
  const byline = socialNode("small", "social-topic-byline");
  byline.append(socialAuthorAvatar(topic, 18), `${topic.author_nickname} · ${socialDayFormat.format(new Date(topic.created_at))}`);
  identity.append(socialNode("strong", "", topic.title), byline);
  summary.append(socialNode("span", "social-topic-icon", "↳"), identity, socialNode("span", "social-reply-count", t("{count} yanıt", { count: topic.replies.length }, topic.replies.length)));
  const content = socialNode("div", "social-discussion");
  const replies = socialNode("div", "social-replies");
  for (const reply of topic.replies) {
    replies.append(socialPost(reply, "match_replies", () => topic.replies.splice(topic.replies.indexOf(reply), 1)));
  }
  const replyArea = socialNode("div", "");
  if (socialState.drafts.has(draftKey)) {
    replyArea.append(socialForm(draftKey, false, async ({ body }) => {
      const client = await loadAuth();
      const { data, error } = await client.from("match_replies").insert({ topic_id: topic.id, body })
        .select(SOCIAL_POST_FIELDS).single();
      if (error) throw error;
      topic.replies.push(data);
      setSocialStatus(t("Yanıtın eklendi."));
    }));
  } else {
    replyArea.append(socialButton(t("Yanıt yaz"), () => startSocialDraft(draftKey, topic.id)));
  }
  content.append(socialPost(topic, "match_topics", () => siblings.splice(siblings.indexOf(topic), 1)), replies, replyArea);
  details.append(summary, content);
  return details;
}

function renderSocial() {
  const container = document.getElementById("social-matches");
  const select = document.getElementById("social-round");
  const fixtures = [...(state.tables["fixtures.csv"] || [])].sort((a, b) => String(a.kickoff || "9999").localeCompare(String(b.kickoff || "9999")));
  const teams = new Map((state.tables["teams.csv"] || []).map((team) => [team.id, team.name]));
  const rounds = new Map();
  for (const fixture of fixtures) {
    const key = `${fixture.season_id || state.seasonSlug}:${fixture.round_id || fixture["round.id"] || fixture["round.name"] || "unknown"}`;
    if (!rounds.has(key)) rounds.set(key, { name: fixture["round.name"] ? t("{round}. Hafta", { round: fixture["round.name"] }) : t("Haftası belirtilmemiş maçlar"), fixtures: [] });
    rounds.get(key).fixtures.push(fixture);
  }
  if (!rounds.has(socialState.round)) {
    const keys = [...rounds.keys()];
    socialState.round = keys[currentRoundIndex([...rounds.values()])] ?? null;
  }
  select.replaceChildren(...[...rounds].map(([key, round]) => new Option(round.name, key)));
  select.disabled = !rounds.size;
  if (!rounds.size) select.add(new Option(t("Yüklü hafta yok"), ""));
  select.value = socialState.round || "";
  container.replaceChildren();
  if (!fixtures.length) {
    container.append(socialNode("p", "social-empty", t("Henüz fikstür yüklenmedi. Sezon verileri yüklendiğinde haftanın maçları ve her maçın konu alanı burada görünecek.")));
    return;
  }
  if (!authEnabled()) {
    container.append(socialNode("p", "social-empty", t("Maç Tribünü şu anda kullanılamıyor.")));
    return;
  }
  const roundFixtures = rounds.get(socialState.round)?.fixtures || [];
  const loadKey = `${state.seasonSlug}|${socialState.round}`;
  if (loadKey !== socialState.loadedKey) loadSocialRound(roundFixtures.map((fixture) => fixture.fixture_id), loadKey);
  const loading = socialState.status === "loading";
  if (socialState.status === "error") container.append(socialNode("p", "social-empty social-load-error", socialState.error));
  for (const fixture of roundFixtures) {
    if (!socialState.topics.has(String(fixture.fixture_id))) socialState.topics.set(String(fixture.fixture_id), []);
    const topics = socialState.topics.get(String(fixture.fixture_id));
    const match = socialNode("article", "social-match");
    const header = socialNode("header", "social-match-header");
    const heading = socialNode("div", "social-match-heading");
    const home = teams.get(fixture.home_team_id) || t("Takım {id}", { id: fixture.home_team_id || "—" });
    const away = teams.get(fixture.away_team_id) || t("Takım {id}", { id: fixture.away_team_id || "—" });
    heading.append(socialNode("p", "social-match-date", kickoffText(fixture)), socialNode("h3", "", `${home} — ${away}`));
    const draftKey = `fixture:${fixture.fixture_id}`;
    header.append(heading, socialNode("span", "social-topic-count", loading ? "…" : t("{count} konu", { count: topics.length }, topics.length)),
      socialButton(t("+ Konu aç"), () => startSocialDraft(draftKey)));
    const composer = socialNode("div", "social-composer");
    if (socialState.drafts.has(draftKey)) {
      composer.append(socialForm(draftKey, true, async ({ title, body }) => {
        const client = await loadAuth();
        const { data, error } = await client.from("match_topics")
          .insert({ fixture_id: Number(fixture.fixture_id), season: state.seasonSlug, title, body })
          .select(SOCIAL_POST_FIELDS).single();
        if (error) throw error;
        topics.unshift({ ...data, replies: [] });
        socialState.open.add(data.id);
        setSocialStatus(t("Konun açıldı."));
      }));
    }
    const topicList = socialNode("div", "social-topic-list");
    if (loading) topicList.append(socialNode("p", "social-empty", t("Konular yükleniyor…")));
    else if (socialState.status === "error") topicList.append(socialNode("p", "social-empty", t("Konular yüklenemedi.")));
    else if (!topics.length) topicList.append(socialNode("p", "social-empty", t("Tribün henüz sessiz. Bu maçın ilk konusunu sen aç.")));
    else topicList.append(...topics.map((topic) => socialTopicRow(topic, topics)));
    match.append(header, composer, topicList);
    container.append(match);
  }
}

document.getElementById("social-round").addEventListener("change", (event) => {
  socialState.round = event.target.value;
  renderSocial();
  setSocialStatus(t("Seçilen haftanın maçları gösteriliyor."));
});
document.getElementById("social-refresh").addEventListener("click", () => {
  socialState.loadedKey = "";
  renderSocial();
  setSocialStatus(t("Konular yenilendi."));
});
// Signing in or out changes who may post and whose posts can be deleted.
document.addEventListener("site-auth-change", () => { if (typeof state !== "undefined" && state.view === "social") renderSocial(); });
