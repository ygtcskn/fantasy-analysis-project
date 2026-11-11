"use strict";

// The text is written in Turkish and shown in the page's language
// (core/language.js). The TR / EN switch sits under the wordmark; each language
// is named in itself, whatever the page's language.
function setupSidebar() {
  document.body.insertAdjacentHTML("afterbegin", `
    <button id="sidebar-toggle" class="sidebar-toggle" aria-controls="sidebar" aria-expanded="false" aria-label="${t("Menüyü aç")}">☰</button>
    <aside id="sidebar" class="rail" inert>
      <a class="brand" href="index.html?view=home" aria-label="${t("Fantezi Analiz ana sayfa")}"><img class="brand-mark" src="assets/brand/logo.svg" alt="" width="48" height="48"><span>FANTEZİ<br><strong>ANALİZ</strong></span></a>
      <div class="rail-language" role="group" aria-label="${t("Dil")}">
        <button type="button" data-language="tr" lang="tr" aria-label="Türkçe" title="Türkçe">TR</button>
        <button type="button" data-language="en" lang="en" aria-label="English" title="English">EN</button>
      </div>
      <div class="rail-section">
        <p class="rail-label">${t("SÜPER LİG")}</p>
        <nav data-nav-group="league" aria-label="${t("Süper Lig sayfaları")}"></nav>
      </div>
      <div class="rail-section">
        <p class="rail-label">${t("FANTEZİ")}</p>
        <nav data-nav-group="fantasy" aria-label="${t("Fantezi araçları")}"></nav>
      </div>
      <div class="rail-section">
        <p class="rail-label">${t("SOSYAL")}</p>
        <nav data-nav-group="social" aria-label="${t("Sosyal sayfalar")}"></nav>
      </div>
      <div id="rail-account" class="rail-account" hidden></div>
    </aside>`);
  for (const button of document.querySelectorAll(".rail-language button")) {
    button.setAttribute("aria-pressed", String(button.dataset.language === siteLanguage));
    button.addEventListener("click", () => setSiteLanguage(button.dataset.language));
  }
  const menus = {
    league: document.querySelector('[data-nav-group="league"]'),
    fantasy: document.querySelector('[data-nav-group="fantasy"]'),
    social: document.querySelector('[data-nav-group="social"]'),
  };
  for (const [group, view, icon, label] of [["league", "home", "⌂", t("Ana Sayfa")], ["league", "standings", "≡", t("Puan Durumu")], ["league", "fixtures", "▦", t("Fikstür")], ["league", "tiers", "▤", t("Oyuncu Listesi")], ["fantasy", "matchweek", "▦", t("Maç Haftası")], ["fantasy", "builder", "+", t("Kadro Kur")], ["fantasy", "statistics", "▩", t("Oyuncu İstatistikleri")], ["fantasy", "team-statistics", "▧", t("Takım İstatistikleri")]]) {
    const link = document.createElement("a");
    link.className = "nav-button";
    link.dataset.view = view;
    link.href = `index.html?view=${view}`;
    const symbol = document.createElement("span");
    symbol.textContent = icon;
    link.append(symbol, ` ${label}`);
    if (view === "matchweek") {
      const live = document.createElement("span");
      live.className = "nav-live live-badge";
      live.hidden = true;
      live.textContent = t("CANLI");
      live.setAttribute("aria-label", t("Şu anda canlı maç var"));
      link.append(live);
    }
    menus[group].append(link);
  }
  for (const [view, icon, label] of [["social", "☷", t("Maç Tribünü")], ["squads", "▣", t("Kadrolar")]]) {
    const link = document.createElement("a");
    link.className = "nav-button";
    link.dataset.view = view;
    link.href = `index.html?view=${view}`;
    const symbol = document.createElement("span");
    symbol.setAttribute("aria-hidden", "true");
    symbol.textContent = icon;
    link.append(symbol, ` ${label}`);
    menus.social.append(link);
  }
  const rail = document.getElementById("sidebar"), toggle = document.getElementById("sidebar-toggle");
  // The sidebar is open by default and the ☰ button is the only thing that
  // hides or shows it. On phone-width screens it would cover the page, so there
  // it starts closed and closes again after a choice or a click outside.
  const wide = () => window.matchMedia("(min-width: 761px)").matches;
  let pinned = false;
  const setOpen = (open, restoreFocus = false) => {
    if (!open && rail.contains(document.activeElement)) {
      if (restoreFocus) toggle.focus({ preventScroll: true });
      else document.activeElement.blur();
    }
    rail.classList.toggle("is-open", open);
    rail.classList.toggle("is-pinned", open && pinned);
    rail.inert = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? t("Menüyü kapat") : t("Menüyü aç"));
    toggle.textContent = open ? "×" : "☰";
  };
  if (wide()) {
    // No slide-in animation on every page load: start in place.
    rail.style.transition = "none";
    pinned = true;
    setOpen(true);
    requestAnimationFrame(() => requestAnimationFrame(() => { rail.style.transition = ""; }));
  }
  toggle.addEventListener("click", () => {
    const open = rail.classList.contains("is-open");
    pinned = !open && wide();
    setOpen(!open, true);
  });
  document.addEventListener("pointerdown", (event) => {
    if (!pinned && rail.classList.contains("is-open") && !rail.contains(event.target) && !toggle.contains(event.target)) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !pinned && !document.querySelector("dialog[open]") && rail.classList.contains("is-open")) {
      setOpen(false, true);
      event.preventDefault();
    }
  });
  rail.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
    if (!pinned) setOpen(false, true);
  }));
}

setupSidebar();
