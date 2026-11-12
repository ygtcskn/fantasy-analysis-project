"use strict";

// The site in two languages. Every text is written once, in Turkish, where it
// is used - in a page's HTML, or in a script as t("…") - and core/english.js
// holds the English for each. Turkish is the text as written: showing it
// translates nothing.
//
// A first visit is in English. The TR / EN switch in the sidebar
// (core/sidebar.js) changes that and the choice is kept in this browser. An
// address with ?lang=tr or ?lang=en chooses too, for a link that should open in
// one language. A page keeps one language for as long as it is open - the
// switch reloads it - so scripts read siteLanguage and LOCALE once and no page
// has to draw itself again.
//
// Standalone, and the first script on every page (after core/english.js).

// The first is what a new visitor sees.
const SITE_LANGUAGES = ["en", "tr"];
const LANGUAGE_STORAGE_KEY = "fantezi-analiz-language";

function chosenLanguage() {
  // The tests load single scripts in Node, with no page around them: there the
  // text stays as written and numbers keep the Turkish format.
  if (typeof document === "undefined") return "tr";
  let asked = "", saved = "";
  try { asked = new URLSearchParams(location.search).get("lang") || ""; } catch { /* no address to read */ }
  try { saved = localStorage.getItem(LANGUAGE_STORAGE_KEY) || ""; } catch { /* storage is blocked */ }
  if (SITE_LANGUAGES.includes(asked)) {
    if (asked !== saved) try { localStorage.setItem(LANGUAGE_STORAGE_KEY, asked); } catch { /* storage is blocked */ }
    return asked;
  }
  return SITE_LANGUAGES.includes(saved) ? saved : SITE_LANGUAGES[0];
}

const siteLanguage = chosenLanguage();
// How numbers and dates are written, and how names are sorted: 7,45 and
// 12 Eylül in Turkish, 7.45 and 12 September in English.
const LOCALE = siteLanguage === "tr" ? "tr-TR" : "en-GB";

const siteEnglish = siteLanguage === "en" && typeof ENGLISH === "object" ? new Map(Object.entries(ENGLISH)) : null;
// Turkish text an English page had no English for, and so showed as written.
// Type untranslated in the browser console to see what core/english.js lacks.
const untranslated = new Set();

// The text in the page's language. {name} is replaced by values.name, so a
// sentence can put its numbers and names where each language wants them:
//   t("{count} oyuncu", { count: 12 }, 12)
// An English entry written as ["{count} player", "{count} players"] is chosen
// by count: the first for exactly one, the second for anything else.
//
// A Turkish word that needs different English in different places ("Ara" is
// both "Search" and a match's "Break") cannot be one dictionary entry. There
// both are given where the word is used: t({ tr: "Ara", en: "Break" }) in a
// script, data-en="Break" on the element in HTML.
function t(text, values, count) {
  let found = text;
  if (text && typeof text === "object") found = text[siteLanguage] ?? text.tr;
  else if (siteEnglish) {
    const english = siteEnglish.get(text);
    if (english === undefined) untranslated.add(text);
    else found = Array.isArray(english) ? english[count === 1 ? 0 : 1] : english;
  }
  if (!values || typeof found !== "string") return found;
  return found.replace(/\{(\w+)\}/g, (whole, name) => (name in values ? values[name] : whole));
}

// Text that arrives already written - a server's own message, always in Turkish
// - in the page's language when core/english.js has it, and as sent otherwise.
function knownText(text) {
  const english = siteEnglish ? siteEnglish.get(text) : undefined;
  return typeof english === "string" ? english : text;
}

const LANGUAGE_ATTRIBUTES = ["title", "aria-label", "placeholder", "alt"];

// HTML written in Turkish - the page itself, or a block a script writes out
// whole, such as the sign-in dialog - turned into the page's language in place.
// Text is matched by what it says, with runs of spaces read as one. An element
// can carry its own English instead: data-en for its text, data-en-title and
// the like for an attribute.
function translateElement(root) {
  if (!siteEnglish || !root) return;
  const spaced = (text) => text.replace(/\s+/g, " ").trim();
  const english = (text) => {
    const found = siteEnglish.get(spaced(text));
    return typeof found === "string" ? found : null;
  };
  const visit = (element) => {
    // A command or a file name is written the same in both languages.
    if (element.tagName === "CODE") return;
    for (const name of LANGUAGE_ATTRIBUTES) {
      const value = element.getAttribute(name);
      const found = value && (element.getAttribute(`data-en-${name}`) ?? english(value));
      if (found) element.setAttribute(name, found);
    }
    if (element.hasAttribute("data-en")) { element.textContent = element.getAttribute("data-en"); return; }
    const texts = [...element.childNodes].filter((node) => node.nodeType === 3 && node.nodeValue.trim());
    // A sentence with markup inside it (<strong>, <code>) is one entry, kept
    // under its HTML, so the words can change order around the markup.
    if (texts.length && element.children.length) {
      const whole = english(element.innerHTML);
      if (whole) { element.innerHTML = whole; return; }
    }
    for (const node of texts) {
      const found = english(node.nodeValue);
      const [, before, after] = node.nodeValue.match(/^(\s*)[\s\S]*?(\s*)$/);
      if (found) node.nodeValue = before + found + after;
      else if (/\p{L}{2}/u.test(node.nodeValue)) untranslated.add(spaced(node.nodeValue));
    }
    for (const child of element.children) visit(child);
  };
  visit(root);
}

// The switch. The choice is saved and the page loads again in that language.
function setSiteLanguage(language) {
  if (!SITE_LANGUAGES.includes(language) || language === siteLanguage) return;
  let saved = true;
  try { localStorage.setItem(LANGUAGE_STORAGE_KEY, language); } catch { saved = false; }
  // Heard by pages holding something a reload would lose (Kadro Kur's squad).
  document.dispatchEvent(new CustomEvent("site-language-change", { detail: { language } }));
  const url = new URL(location.href);
  // With storage blocked the address carries the choice instead.
  if (saved) url.searchParams.delete("lang"); else url.searchParams.set("lang", language);
  if (url.href === location.href) location.reload(); else location.replace(url.href);
}

if (typeof document !== "undefined") {
  document.documentElement.lang = siteLanguage;
  // The head is written in English, which is what a link's preview shows, and
  // carries its Turkish in data-tr.
  if (siteLanguage === "tr") {
    for (const element of document.head.querySelectorAll("[data-tr]")) {
      if (element.tagName === "TITLE") document.title = element.dataset.tr;
      else element.setAttribute("content", element.dataset.tr);
    }
  }
  translateElement(document.body);
  // styles/styles.css keeps <main> out of sight until this is set, so a page
  // never shows for a moment in the other language.
  document.documentElement.dataset.language = siteLanguage;
}

if (typeof module !== "undefined" && module.exports) module.exports = { SITE_LANGUAGES, siteLanguage, LOCALE, t, knownText };
