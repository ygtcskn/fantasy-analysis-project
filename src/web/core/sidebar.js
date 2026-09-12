"use strict";

const THEME_STORAGE_KEY = "superlig-theme";
const applyTheme = (theme, persist = false) => {
  const value = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = value;
  document.documentElement.style.colorScheme = value;
  if (persist) {
    try { localStorage.setItem(THEME_STORAGE_KEY, value); } catch { /* Storage may be disabled. */ }
  }
  return value;
};

function setupSidebar() {
  document.body.insertAdjacentHTML("afterbegin", `
    <button id="sidebar-toggle" class="sidebar-toggle" aria-controls="sidebar" aria-expanded="false" aria-label="Open navigation">☰</button>
    <div id="sidebar-edge" class="sidebar-edge" aria-hidden="true"></div>
    <aside id="sidebar" class="rail" inert>
      <a class="brand" href="index.html?view=home" aria-label="Süper Lig Lab home"><span class="brand-mark">SL<span>↗</span></span><span>SÜPER LİG<br><strong>LAB</strong></span></a>
      <div class="rail-section">
        <p class="rail-label">SÜPER LİG</p>
        <nav data-nav-group="league" aria-label="Süper Lig sayfaları"></nav>
      </div>
      <div class="rail-section">
        <p class="rail-label">FANTEZİ</p>
        <nav data-nav-group="fantasy" aria-label="Fantezi araçları"></nav>
      </div>
      <div class="theme-control">
        <span class="theme-control-label">APPEARANCE</span>
        <div class="theme-switch" role="group" aria-label="Colour theme">
          <button type="button" data-theme-option="light" aria-pressed="true"><span aria-hidden="true">☀</span> Light</button>
          <button type="button" data-theme-option="dark" aria-pressed="false"><span aria-hidden="true">☾</span> Dark</button>
        </div>
      </div>
      <div class="rail-note"><span class="status-dot"></span> Personal explorer<p>Your files, your questions.<br>Explore the evidence before<br>building a prediction.</p></div>
    </aside>`);
  const menus = {
    league: document.querySelector('[data-nav-group="league"]'),
    fantasy: document.querySelector('[data-nav-group="fantasy"]'),
  };
  for (const [group, view, icon, label] of [["league", "home", "⌂", "Home"], ["league", "standings", "≡", "Puan Durumu"], ["league", "fixtures", "▦", "Fikstür"], ["league", "tiers", "▤", "Oyuncu Listesi"], ["fantasy", "matchweek", "▦", "Maç Haftası"], ["fantasy", "builder", "+", "Fantasy XI Builder"], ["fantasy", "statistics", "▩", "İstatistikler"], ["fantasy", "team-statistics", "▧", "Takım İstatistikleri"]]) {
    const link = document.createElement("a");
    link.className = "nav-button";
    link.dataset.view = view;
    link.href = `index.html?view=${view}`;
    const symbol = document.createElement("span");
    symbol.textContent = icon;
    link.append(symbol, ` ${label}`);
    menus[group].append(link);
  }
  const rail = document.getElementById("sidebar"), toggle = document.getElementById("sidebar-toggle"), edge = document.getElementById("sidebar-edge");
  const themeButtons = [...rail.querySelectorAll("[data-theme-option]")];
  const setThemeButtonState = (theme) => themeButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.themeOption === theme));
  });
  setThemeButtonState(document.documentElement.dataset.theme || "light");
  themeButtons.forEach((button) => button.addEventListener("click", () => {
    const theme = applyTheme(button.dataset.themeOption, true);
    setThemeButtonState(theme);
  }));
  let pinned = false;
  const setOpen = (open, restoreFocus = false) => {
    if (!open && rail.contains(document.activeElement)) {
      if (restoreFocus) toggle.focus({ preventScroll: true });
      else document.activeElement.blur();
    }
    rail.classList.toggle("is-open", open);
    rail.inert = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    toggle.textContent = open ? "×" : "☰";
  };
  edge.addEventListener("pointerenter", (event) => { if (event.pointerType === "mouse" && !pinned) setOpen(true); });
  rail.addEventListener("pointerenter", (event) => { if (event.pointerType === "mouse" && !pinned) setOpen(true); });
  rail.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse" && !pinned && !rail.contains(document.activeElement) && event.relatedTarget !== toggle) setOpen(false);
  });
  toggle.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse" && !pinned && !rail.contains(document.activeElement) && !rail.contains(event.relatedTarget)) setOpen(false);
  });
  toggle.addEventListener("click", () => {
    const open = rail.classList.contains("is-open");
    pinned = !open;
    rail.classList.toggle("is-pinned", pinned);
    setOpen(!open, true);
  });
  rail.addEventListener("focusout", () => {
    requestAnimationFrame(() => {
      if (!pinned && !rail.contains(document.activeElement) && document.activeElement !== toggle && !rail.matches(":hover")) setOpen(false);
    });
  });
  document.addEventListener("pointerdown", (event) => {
    if (!pinned && !rail.contains(event.target) && !toggle.contains(event.target) && event.target !== edge) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !document.querySelector("dialog[open]") && rail.classList.contains("is-open")) {
      pinned = false;
      rail.classList.remove("is-pinned");
      setOpen(false, true);
      event.preventDefault();
    }
  });
  rail.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
    pinned = false;
    rail.classList.remove("is-pinned");
    setOpen(false, true);
  }));
}

setupSidebar();
