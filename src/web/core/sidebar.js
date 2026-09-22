"use strict";

function setupSidebar() {
  document.body.insertAdjacentHTML("afterbegin", `
    <button id="sidebar-toggle" class="sidebar-toggle" aria-controls="sidebar" aria-expanded="false" aria-label="Menüyü aç">☰</button>
    <aside id="sidebar" class="rail" inert>
      <a class="brand" href="index.html?view=home" aria-label="Süper Lig Lab ana sayfa"><span class="brand-mark">SL<span>↗</span></span><span>SÜPER LİG<br><strong>LAB</strong></span></a>
      <div class="rail-section">
        <p class="rail-label">SÜPER LİG</p>
        <nav data-nav-group="league" aria-label="Süper Lig sayfaları"></nav>
      </div>
      <div class="rail-section">
        <p class="rail-label">FANTEZİ</p>
        <nav data-nav-group="fantasy" aria-label="Fantezi araçları"></nav>
      </div>
      <div class="rail-section">
        <p class="rail-label">SOSYAL</p>
        <nav data-nav-group="social" aria-label="Sosyal sayfalar"></nav>
      </div>
    </aside>`);
  const menus = {
    league: document.querySelector('[data-nav-group="league"]'),
    fantasy: document.querySelector('[data-nav-group="fantasy"]'),
    social: document.querySelector('[data-nav-group="social"]'),
  };
  for (const [group, view, icon, label] of [["league", "home", "⌂", "Ana Sayfa"], ["league", "standings", "≡", "Puan Durumu"], ["league", "fixtures", "▦", "Fikstür"], ["league", "tiers", "▤", "Oyuncu Listesi"], ["fantasy", "matchweek", "▦", "Maç Haftası"], ["fantasy", "builder", "+", "Kadro Kur"], ["fantasy", "statistics", "▩", "Oyuncu İstatistikleri"], ["fantasy", "team-statistics", "▧", "Takım İstatistikleri"]]) {
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
      live.textContent = "CANLI";
      live.setAttribute("aria-label", "Şu anda canlı maç var");
      link.append(live);
    }
    menus[group].append(link);
  }
  const socialLink = document.createElement("a");
  socialLink.className = "nav-button";
  socialLink.dataset.view = "social";
  socialLink.href = "index.html?view=social";
  socialLink.innerHTML = '<span aria-hidden="true">☷</span> Maç Tribünü';
  menus.social.append(socialLink);
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
    toggle.setAttribute("aria-label", open ? "Menüyü kapat" : "Menüyü aç");
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
