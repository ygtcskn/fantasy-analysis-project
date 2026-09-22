"use strict";

// Session-only discussion preview. No invented users, provider calls or disk writes.
const socialTopics = new Map();
let socialRound = null;

function socialNode(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function socialButton(label, handler) {
  const button = socialNode("button", "social-button", label);
  button.type = "button";
  button.addEventListener("click", handler);
  return button;
}

function socialField(form, label, name, multiline, maxLength) {
  const wrapper = socialNode("label", "", label);
  const input = document.createElement(multiline ? "textarea" : "input");
  input.name = name;
  input.required = true;
  input.maxLength = maxLength;
  if (multiline) input.rows = 4;
  wrapper.append(input);
  form.append(wrapper);
  return input;
}

function socialForm(isTopic, onSave, onCancel) {
  const form = socialNode("form", "social-form");
  const author = socialField(form, "Görünen ad", "author", false, 40);
  const title = isTopic ? socialField(form, "Konu başlığı", "title", false, 120) : null;
  const body = socialField(form, isTopic ? "Ne düşünüyorsun?" : "Yanıtın", "body", true, 3000);
  const actions = socialNode("div", "social-actions");
  const submit = socialNode("button", "social-button", isTopic ? "Konuyu ekle" : "Yanıtı ekle");
  submit.type = "submit";
  actions.append(submit, socialButton("Vazgeç", onCancel));
  form.append(actions);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const fields = [author, title, body].filter(Boolean);
    for (const field of fields) field.setCustomValidity(field.value.trim() ? "" : "Lütfen bu alanı doldurun.");
    if (!form.reportValidity()) return;
    onSave({ author: author.value.trim(), title: title?.value.trim(), body: body.value.trim(), created: new Date(), replies: [] });
  });
  form.addEventListener("input", (event) => event.target.setCustomValidity?.(""));
  return form;
}

function socialPost(post) {
  const article = socialNode("article", "social-post");
  const meta = socialNode("p", "social-post-meta");
  meta.append(socialNode("strong", "", post.author), document.createTextNode(" · "));
  const time = socialNode("time", "", new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium", timeStyle: "short" }).format(post.created));
  time.dateTime = post.created.toISOString();
  meta.append(time);
  article.append(meta, socialNode("p", "social-post-body", post.body));
  return article;
}

function socialTopicRow(topic) {
  const details = socialNode("details", "social-topic");
  const summary = socialNode("summary", "social-topic-row");
  const identity = socialNode("span", "social-topic-identity");
  identity.append(socialNode("strong", "", topic.title), socialNode("small", "", `${topic.author} · ${new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short" }).format(topic.created)}`));
  const count = socialNode("span", "social-reply-count", `${topic.replies.length} yanıt`);
  summary.append(socialNode("span", "social-topic-icon", "↳"), identity, count);
  const content = socialNode("div", "social-discussion");
  const replies = socialNode("div", "social-replies");
  replies.append(...topic.replies.map(socialPost));
  const replyArea = socialNode("div", "");
  const replyButton = socialButton("Yanıt yaz", () => {
    replyButton.hidden = true;
    const form = socialForm(false, (reply) => {
      topic.replies.push(reply);
      replies.append(socialPost(reply));
      count.textContent = `${topic.replies.length} yanıt`;
      close();
      document.getElementById("social-status").textContent = "Yanıt bu oturuma eklendi.";
    }, () => close());
    const close = () => { form.remove(); replyButton.hidden = false; replyButton.focus(); };
    replyArea.append(form);
    form.querySelector("input").focus();
  });
  replyArea.append(replyButton);
  content.append(socialPost(topic), replies, replyArea);
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
    if (!rounds.has(key)) rounds.set(key, { name: fixture["round.name"] ? `${fixture["round.name"]}. Hafta` : "Haftası belirtilmemiş maçlar", fixtures: [] });
    rounds.get(key).fixtures.push(fixture);
  }
  if (!rounds.has(socialRound)) {
    const entries = [...rounds];
    socialRound = (entries.find(([, round]) => round.fixtures.some((fixture) => String(fixture["round.is_current"]).toLowerCase() === "true"))
      || entries.find(([, round]) => round.fixtures.some((fixture) => Number(fixture.starting_at_timestamp) >= Date.now() / 1000))
      || entries[entries.length - 1])?.[0] ?? null;
  }
  select.replaceChildren(...[...rounds].map(([key, round]) => new Option(round.name, key)));
  select.disabled = !rounds.size;
  if (!rounds.size) select.add(new Option("Yüklü hafta yok", ""));
  select.value = socialRound || "";
  container.replaceChildren();
  if (!fixtures.length) {
    container.append(socialNode("p", "social-empty", "Henüz fikstür yüklenmedi. Sezon verileri yüklendiğinde haftanın maçları ve her maçın konu alanı burada görünecek."));
    return;
  }
  for (const fixture of rounds.get(socialRound)?.fixtures || []) {
    const key = `${fixture.season_id || state.seasonSlug}:${fixture.fixture_id}`;
    const topics = socialTopics.get(key) || [];
    const match = socialNode("article", "social-match");
    const header = socialNode("header", "social-match-header");
    const heading = socialNode("div", "social-match-heading");
    const home = teams.get(fixture.home_team_id) || `Takım ${fixture.home_team_id || "—"}`;
    const away = teams.get(fixture.away_team_id) || `Takım ${fixture.away_team_id || "—"}`;
    heading.append(socialNode("p", "social-match-date", `${longDate(fixture.kickoff)} · ${fixture.kickoff?.slice(11, 16) || "Saat belli değil"} (UTC)`), socialNode("h3", "", `${home} — ${away}`));
    const topicCount = socialNode("span", "social-topic-count", `${topics.length} konu`);
    const topicList = socialNode("div", "social-topic-list");
    const empty = socialNode("p", "social-empty", "Tribün henüz sessiz. Bu maçın ilk konusunu sen aç.");
    if (!topics.length) topicList.append(empty);
    topicList.append(...topics.map(socialTopicRow));
    const composer = socialNode("div", "social-composer");
    const create = socialButton("+ Konu aç", () => {
      create.hidden = true;
      const form = socialForm(true, (topic) => {
        topics.unshift(topic);
        socialTopics.set(key, topics);
        empty.remove();
        const row = socialTopicRow(topic);
        row.open = true;
        topicList.prepend(row);
        topicCount.textContent = `${topics.length} konu`;
        close();
        document.getElementById("social-status").textContent = "Konu bu oturuma eklendi.";
      }, () => close());
      const close = () => { form.remove(); create.hidden = false; create.focus(); };
      composer.append(form);
      form.querySelector("input").focus();
    });
    header.append(heading, topicCount, create);
    match.append(header, composer, topicList);
    container.append(match);
  }
}

document.getElementById("social-round").addEventListener("change", (event) => {
  socialRound = event.target.value;
  renderSocial();
  document.getElementById("social-status").textContent = "Seçilen haftanın maçları gösteriliyor.";
});
