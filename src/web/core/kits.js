"use strict";

// Club kit colourways and the back-view shirt renderer used by the XI builder.
//
// Sportmonks carries no kit data, so this table is authored by hand.
//
// A modern shirt is not one flat pattern. Galatasaray's 26-27 home shirt, for
// example, is an "8-panel" build: dark cherry body, one orange sleeve, an
// orange shoulder yoke and a two-tone blocked hem. So a kit is described as a
// set of panels drawn in order, not a single pattern name.
//
//   base      body colour
//   pattern   "plain" | "stripes" | "halves" | "hoops"  (applies to the body)
//   alt       second colour used by the pattern
//   sleeveL   left sleeve colour  (viewer's left; omit to inherit the body)
//   sleeveR   right sleeve colour (omit to inherit the body)
//   yoke      shoulder band colour (omit for none)
//   hemL/hemR blocked hem colours (omit for none)
//   hemStripe vertical stripes drawn inside the hem band
//   sleeveBar stripe running down the outer sleeve
//   cuff      sleeve cuff band colour
//   centre    vertical band up the middle (Samsunspor's white spine)
//   collar    back collar colour
//   print     squad number colour, must contrast with the body
//   source    "image" = encoded from an actual kit photo
//             "described" = from a written kit description
//             "approximate" = club colours only, design unverified
//
// Keys are Sportmonks team ids (teams.csv id / squads.csv team_id).

const SUPERLIG_KITS = {
  // Every entry below is encoded from a 26-27 kit photo in jersey-back/.
  // Colours were sampled from those photos at the 82nd brightness percentile of
  // each hue cluster, which estimates lit fabric rather than shadowed folds.
  // Published crest colours were used only as a sanity check - a club's brand
  // red is not necessarily the red of this season's shirt.

  // Red body, orange right sleeve only, orange shoulder yoke, blocked hem.
  "34": {
    name: "Galatasaray", base: "#D0021F", pattern: "plain", alt: "#F7A024",
    sleeveR: "#F7A024", yoke: "#F7A024", hemL: "#F7A024", hemR: "#A50E28",
    collar: "#A50E28", print: "#FFFFFF", source: "image",
  },
  // Yellow shirt. Navy appears only as a striped hem band, collar and cuffs.
  "88": {
    name: "Fenerbahçe", base: "#E7E852", pattern: "plain", alt: "#1C2C63",
    hemL: "#E7E852", hemR: "#E7E852", hemStripe: "#1C2C63",
    collar: "#1C2C63", cuff: "#1C2C63", print: "#1C2C63", source: "image",
  },
  // Plain white with black collar and cuffs - not the classic stripes this season.
  "554": {
    name: "Beşiktaş", base: "#FFFFFF", pattern: "plain", alt: "#111111",
    collar: "#111111", cuff: "#111111", print: "#111111", source: "image",
  },
  // Wide claret and light blue stripes with gold trim.
  "688": {
    name: "Trabzonspor", base: "#6E2038", pattern: "stripes", alt: "#9DBCE4",
    collar: "#6E2038", cuff: "#C9A24A", print: "#FFFFFF", source: "image",
  },
  // White with red shoulder and hem blocks split by a white spine.
  "2811": {
    name: "Samsunspor", base: "#FFFFFF", pattern: "plain", alt: "#CC1620",
    yoke: "#CC1620", hemL: "#CC1620", hemR: "#CC1620", centre: "#FFFFFF",
    collar: "#CC1620", cuff: "#CC1620", print: "#CC1620", source: "image",
  },
  // White body, green striped hem, green shoulder bars.
  "2632": {
    name: "Konyaspor", base: "#FFFFFF", pattern: "plain", alt: "#0B7A44",
    hemL: "#FFFFFF", hemR: "#FFFFFF", hemStripe: "#0B7A44", sleeveBar: "#0B7A44",
    collar: "#0B7A44", cuff: "#0B7A44", print: "#0B7A44", source: "image",
  },
  // Plain red body, black bars down the sleeves.
  "286": {
    name: "Gençlerbirliği", base: "#BC1620", pattern: "plain", alt: "#111111",
    sleeveBar: "#111111", cuff: "#111111", collar: "#111111",
    print: "#FFFFFF", source: "image",
  },
  // Green body, black striped hem band, black shoulder bars.
  "13860": {
    name: "Kocaelispor", base: "#235C3E", pattern: "plain", alt: "#111111",
    hemL: "#235C3E", hemR: "#235C3E", hemStripe: "#111111", sleeveBar: "#111111",
    collar: "#111111", print: "#FFFFFF", source: "image",
  },
  // Light blue and white stripes, black collar and cuffs.
  "13818": {
    name: "Erzurumspor FK", base: "#FFFFFF", pattern: "stripes", alt: "#9AC0D6",
    collar: "#111111", cuff: "#111111", print: "#123B5E", source: "image",
  },
  // Plain green, red cuff banding.
  "3570": {
    name: "Amed SK", base: "#175A2C", pattern: "plain", alt: "#C8102E",
    cuff: "#C8102E", collar: "#175A2C", print: "#FFFFFF", source: "image",
  },
  // Black body with a red-and-black striped hem band.
  "4192": {
    name: "Gaziantep F.K.", base: "#1A1A1A", pattern: "plain", alt: "#C8102E",
    hemL: "#1A1A1A", hemR: "#1A1A1A", hemStripe: "#C8102E",
    collar: "#1A1A1A", print: "#FFFFFF", source: "image",
  },
  // Red and black stripes.
  "13871": {
    name: "Çorum FK", base: "#D2202F", pattern: "stripes", alt: "#1A1A1A",
    collar: "#1A1A1A", print: "#FFFFFF", source: "image",
  },
  // Orange body, green number and green sleeve trim.
  "347": {
    name: "Alanyaspor", base: "#F65A26", pattern: "plain", alt: "#0B7A44",
    sleeveBar: "#0B7A44", cuff: "#0B7A44", collar: "#0B7A44",
    print: "#0B7A44", source: "image",
  },
  // Orange body, navy number, navy collar and cuffs.
  "3702": {
    name: "İstanbul Başakşehir", base: "#F96108", pattern: "plain", alt: "#1B3050",
    collar: "#1B3050", cuff: "#1B3050", print: "#1B3050", source: "image",
  },
  // Plain purple, yellow number and trim.
  "3224": {
    name: "Eyüpspor", base: "#6340B8", pattern: "plain", alt: "#F5D400",
    collar: "#F5D400", cuff: "#F5D400", print: "#F5D400", source: "image",
  },
  // Plain white, navy number and trim.
  "1071": {
    name: "Kasımpaşa", base: "#FFFFFF", pattern: "plain", alt: "#23335E",
    collar: "#23335E", cuff: "#23335E", print: "#23335E", source: "image",
  },
  // Deep blue body with green trim.
  "1041": {
    name: "Çaykur Rizespor", base: "#223A86", pattern: "plain", alt: "#0E8A45",
    cuff: "#0E8A45", collar: "#0E8A45", print: "#FFFFFF", source: "image",
  },
  // Red body with a yellow right sleeve and yellow hem block. Least certain of
  // the set - the source is a match photo at an angle, not a product shot.
  "3897": {
    name: "Göztepe", base: "#C41F26", pattern: "plain", alt: "#DFA30A",
    sleeveR: "#DFA30A", hemR: "#DFA30A", collar: "#B41F22",
    print: "#DFA30A", source: "image",
  },
};

// Used when a player has no squad row, or plays for a club not in the table.
// Goalkeeper kits, drawn on the same shirt as the outfield kits.
//
// Clubs publish far less about goalkeeper shirts than outfield ones. When this
// table was written (September 2026) the only 26-27 goalkeeper colours found in
// Turkish press were Galatasaray's (green, yellow and purple sets; green is used
// here). Every other club is "approximate": a conventional goalkeeper colour
// chosen to stand apart from that club's own outfield kit, so a keeper is never
// mistaken for a team-mate. Replace an entry, and its source, once a club's
// actual goalkeeper shirt is known.
const SUPERLIG_GOALKEEPER_KITS = {
  "34": { name: "Galatasaray kaleci", base: "#1FA35C", pattern: "plain", alt: "#0E6B3A", collar: "#0E6B3A", cuff: "#0E6B3A", print: "#FFFFFF", source: "described" },
  "88": { name: "Fenerbahçe kaleci", base: "#161616", pattern: "plain", alt: "#E7E852", collar: "#E7E852", cuff: "#E7E852", print: "#E7E852", source: "approximate" },
  "554": { name: "Beşiktaş kaleci", base: "#B5E61D", pattern: "plain", alt: "#111111", collar: "#111111", cuff: "#111111", print: "#111111", source: "approximate" },
  "688": { name: "Trabzonspor kaleci", base: "#1A1A1A", pattern: "plain", alt: "#9DBCE4", collar: "#9DBCE4", cuff: "#9DBCE4", print: "#9DBCE4", source: "approximate" },
  "2811": { name: "Samsunspor kaleci", base: "#3A3F45", pattern: "plain", alt: "#CC1620", collar: "#CC1620", cuff: "#CC1620", print: "#FFFFFF", source: "approximate" },
  "2632": { name: "Konyaspor kaleci", base: "#5B2A86", pattern: "plain", alt: "#FFFFFF", collar: "#FFFFFF", cuff: "#FFFFFF", print: "#FFFFFF", source: "approximate" },
  "286": { name: "Gençlerbirliği kaleci", base: "#19A7CE", pattern: "plain", alt: "#111111", collar: "#111111", cuff: "#111111", print: "#111111", source: "approximate" },
  "13860": { name: "Kocaelispor kaleci", base: "#F2C500", pattern: "plain", alt: "#111111", collar: "#111111", cuff: "#111111", print: "#111111", source: "approximate" },
  "13818": { name: "Erzurumspor FK kaleci", base: "#1A1A1A", pattern: "plain", alt: "#9AC0D6", collar: "#9AC0D6", cuff: "#9AC0D6", print: "#FFFFFF", source: "approximate" },
  "3570": { name: "Amed SK kaleci", base: "#F4C20D", pattern: "plain", alt: "#175A2C", collar: "#175A2C", cuff: "#175A2C", print: "#111111", source: "approximate" },
  "4192": { name: "Gaziantep F.K. kaleci", base: "#9ED923", pattern: "plain", alt: "#1A1A1A", collar: "#1A1A1A", cuff: "#1A1A1A", print: "#111111", source: "approximate" },
  "13871": { name: "Çorum FK kaleci", base: "#0FA3A3", pattern: "plain", alt: "#1A1A1A", collar: "#1A1A1A", cuff: "#1A1A1A", print: "#FFFFFF", source: "approximate" },
  "347": { name: "Alanyaspor kaleci", base: "#1F4FBF", pattern: "plain", alt: "#F65A26", collar: "#F65A26", cuff: "#F65A26", print: "#FFFFFF", source: "approximate" },
  "3702": { name: "İstanbul Başakşehir kaleci", base: "#8CD43A", pattern: "plain", alt: "#1B3050", collar: "#1B3050", cuff: "#1B3050", print: "#1B3050", source: "approximate" },
  "3224": { name: "Eyüpspor kaleci", base: "#F07A1A", pattern: "plain", alt: "#1A1A1A", collar: "#1A1A1A", cuff: "#1A1A1A", print: "#111111", source: "approximate" },
  "1071": { name: "Kasımpaşa kaleci", base: "#E0457B", pattern: "plain", alt: "#23335E", collar: "#23335E", cuff: "#23335E", print: "#FFFFFF", source: "approximate" },
  "1041": { name: "Çaykur Rizespor kaleci", base: "#F28A1C", pattern: "plain", alt: "#223A86", collar: "#223A86", cuff: "#223A86", print: "#111111", source: "approximate" },
  "3897": { name: "Göztepe kaleci", base: "#2B2B2B", pattern: "plain", alt: "#DFA30A", collar: "#DFA30A", cuff: "#DFA30A", print: "#DFA30A", source: "approximate" },
};

const NEUTRAL_GOALKEEPER_KIT = { name: t("Kaleci"), base: "#2B2B2B", pattern: "plain", alt: "#9ED923", collar: "#9ED923", cuff: "#9ED923", print: "#FFFFFF", source: "approximate" };

const NEUTRAL_KIT = { name: t("Bilinmeyen takım"), base: "#8C9A8F", pattern: "plain", alt: "#B8C4BA", print: "#20302A", source: "approximate" };

// Back-view silhouette. Every panel below clips to this.
const SHIRT_PATH = "M31,7 C37,3 44,9 50,9 C56,9 63,3 69,7 L95,23 L86,45 L75,36 L75,101 C63,105 37,105 25,101 L25,36 L14,45 L5,23 Z";
const SLEEVE_L_PATH = "M31,7 L5,23 L14,45 L25,36 Z";
const SLEEVE_R_PATH = "M69,7 L95,23 L86,45 L75,36 Z";
const YOKE_PATH = "M31,7 C37,3 44,9 50,9 C56,9 63,3 69,7 L95,23 L88,31 L69,19 C60,16 40,16 31,19 L12,31 L5,23 Z";
const COLLAR_PATH = "M39,8.2 C43.5,13 56.5,13 61,8.2 C56.5,5.4 43.5,5.4 39,8.2 Z";
const CUFF_L_PATH = "M5,23 L14,45 L21,42 L12,20 Z";
const CUFF_R_PATH = "M95,23 L86,45 L79,42 L88,20 Z";
const BAR_L_PATH = "M31,7 L5,23 L11,32 L35,16 Z";
const BAR_R_PATH = "M69,7 L95,23 L89,32 L65,16 Z";
const HEM_TOP = 79;

// Below this rendered width the surname arc and motto are unreadable, so only
// the squad number is printed.
const KIT_NAME_MIN_SIZE = 84;

let kitInstanceId = 0;

function kitFor(teamId, goalkeeper = false) {
  if (goalkeeper) return SUPERLIG_GOALKEEPER_KITS[String(teamId)] || NEUTRAL_GOALKEEPER_KIT;
  return SUPERLIG_KITS[String(teamId)] || NEUTRAL_KIT;
}

function kitEscape(value) {
  return String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[character]));
}

// "Victor Osimhen" -> "OSIMHEN". Keeps the last word, which is what goes on a shirt.
function kitSurname(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return (parts.length ? parts[parts.length - 1] : "").toUpperCase();
}

// Real jerseys outline the number so it survives crossing a stripe. Pick the
// outline from the print colour's luminance rather than per-club guesswork.
function kitContrast(hex) {
  const value = String(hex || "#000").replace("#", "");
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
  const r = parseInt(full.slice(0, 2), 16), g = parseInt(full.slice(2, 4), 16), b = parseInt(full.slice(4, 6), 16);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 140 ? "#14181A" : "#FFFFFF";
}

function kitBodyPanels(kit) {
  const panels = [`<rect x="0" y="0" width="100" height="112" fill="${kit.base}"/>`];
  if (kit.pattern === "stripes") {
    for (let index = 0; index < 8; index++) {
      if (index % 2) panels.push(`<rect x="${index * 12.5}" y="0" width="12.5" height="112" fill="${kit.alt}"/>`);
    }
  } else if (kit.pattern === "halves") {
    panels.push(`<rect x="50" y="0" width="50" height="112" fill="${kit.alt}"/>`);
  } else if (kit.pattern === "hoops") {
    for (let index = 0; index < 7; index++) {
      if (index % 2) panels.push(`<rect x="0" y="${index * 16}" width="100" height="16" fill="${kit.alt}"/>`);
    }
  }
  if (kit.sleeveL) panels.push(`<path d="${SLEEVE_L_PATH}" fill="${kit.sleeveL}"/>`);
  if (kit.sleeveR) panels.push(`<path d="${SLEEVE_R_PATH}" fill="${kit.sleeveR}"/>`);
  if (kit.sleeveBar) {
    panels.push(`<path d="${BAR_L_PATH}" fill="${kit.sleeveBar}"/>`, `<path d="${BAR_R_PATH}" fill="${kit.sleeveBar}"/>`);
  }
  if (kit.yoke) panels.push(`<path d="${YOKE_PATH}" fill="${kit.yoke}"/>`);
  if (kit.hemL) panels.push(`<rect x="0" y="${HEM_TOP}" width="50" height="${112 - HEM_TOP}" fill="${kit.hemL}"/>`);
  if (kit.hemR) panels.push(`<rect x="50" y="${HEM_TOP}" width="50" height="${112 - HEM_TOP}" fill="${kit.hemR}"/>`);
  if (kit.hemStripe) {
    for (let index = 0; index < 10; index++) {
      if (index % 2) panels.push(`<rect x="${index * 10}" y="${HEM_TOP}" width="10" height="${112 - HEM_TOP}" fill="${kit.hemStripe}"/>`);
    }
  }
  if (kit.centre) panels.push(`<rect x="41" y="0" width="18" height="112" fill="${kit.centre}"/>`);
  if (kit.cuff) {
    panels.push(`<path d="${CUFF_L_PATH}" fill="${kit.cuff}"/>`, `<path d="${CUFF_R_PATH}" fill="${kit.cuff}"/>`);
  }
  return panels.join("");
}

// Returns an <svg> string for one back-view shirt.
// options: { size, number, surname, showName, title }
function shirtSVG(teamId, options = {}) {
  const kit = kitFor(teamId, Boolean(options.goalkeeper));
  const id = `k${++kitInstanceId}`;
  const size = options.size || 64;
  const large = options.showName !== undefined ? options.showName : size >= KIT_NAME_MIN_SIZE;
  const surname = large ? kitSurname(options.surname) : "";
  const number = options.number === null || options.number === undefined || options.number === "" ? "" : String(options.number);

  const edge = kit.printEdge || kitContrast(kit.print);

  const print = [];
  if (surname) {
    print.push(
      `<path id="arc${id}" d="M29,40 Q50,30 71,40" fill="none"/>`,
      `<text font-family="Oswald,Archivo,Impact,sans-serif" font-weight="600" font-size="9" fill="${kit.print}" stroke="${edge}" stroke-width="0.7" paint-order="stroke" letter-spacing="0.6" text-anchor="middle"><textPath href="#arc${id}" startOffset="50%">${kitEscape(surname)}</textPath></text>`
    );
  }
  if (number) {
    print.push(`<text x="50" y="${surname ? 74 : 68}" font-family="Oswald,Archivo,Impact,sans-serif" font-weight="700" font-size="34" fill="${kit.print}" stroke="${edge}" stroke-width="1.6" paint-order="stroke" text-anchor="middle" style="font-variant-numeric:tabular-nums">${kitEscape(number)}</text>`);
  }

  // What a screen reader hears, in the page's language. A goalkeeper kit is
  // named "<club> kaleci" in the table above; only that word is translated.
  const kitName = kit.name.replace(/ kaleci$/, ` ${t("kaleci")}`);
  const label = options.title || (number ? t("{kit} forması, {number} numara", { kit: kitName, number }) : t("{kit} forması", { kit: kitName }));

  return [
    `<svg width="${size}" height="${Math.round(size * 1.12)}" viewBox="0 0 100 112" role="img" aria-label="${kitEscape(label)}">`,
    "<defs>",
    `<clipPath id="c${id}"><path d="${SHIRT_PATH}"/></clipPath>`,
    // horizontal gradient = the torso reading as a cylinder
    `<linearGradient id="g${id}" x1="0" x2="1">`,
    '<stop offset="0" stop-color="#000" stop-opacity=".40"/>',
    '<stop offset=".17" stop-color="#000" stop-opacity=".07"/>',
    '<stop offset=".40" stop-color="#fff" stop-opacity=".13"/>',
    '<stop offset=".62" stop-color="#000" stop-opacity="0"/>',
    '<stop offset=".85" stop-color="#000" stop-opacity=".15"/>',
    '<stop offset="1" stop-color="#000" stop-opacity=".44"/>',
    "</linearGradient>",
    // vertical gradient = light across the shoulders, darker into the hem
    `<linearGradient id="v${id}" x1="0" y1="0" x2="0" y2="1">`,
    '<stop offset="0" stop-color="#fff" stop-opacity=".10"/>',
    '<stop offset=".55" stop-color="#000" stop-opacity="0"/>',
    '<stop offset="1" stop-color="#000" stop-opacity=".26"/>',
    "</linearGradient>",
    `<filter id="d${id}" x="-25%" y="-25%" width="150%" height="150%">`,
    '<feDropShadow dx="0" dy="1.6" stdDeviation="2" flood-color="#04170f" flood-opacity=".55"/>',
    "</filter>",
    "</defs>",
    `<g filter="url(#d${id})">`,
    `<g clip-path="url(#c${id})">`,
    kitBodyPanels(kit),
    print.join(""),
    // shading sits above the print so the number reads as printed into the fabric
    `<rect x="0" y="0" width="100" height="112" fill="url(#g${id})"/>`,
    `<rect x="0" y="0" width="100" height="112" fill="url(#v${id})"/>`,
    "</g>",
    `<path d="${SHIRT_PATH}" fill="none" stroke="#00000055" stroke-width="1.1"/>`,
    `<path d="${COLLAR_PATH}" fill="${kit.collar || kit.print}" opacity=".85"/>`,
    "</g>",
    "</svg>",
  ].join("");
}
