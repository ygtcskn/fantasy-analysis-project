"use strict";

// Each club's official colours, for charts, bars and legends on every page.
//
// Which colours a club has comes from published club-colour records (RSSSF's
// Turkish club colours list and each club's Wikipedia article). The hex values
// are the club's own: published brand values where they exist (Galatasaray's
// Pantone 187 / 123, Trabzonspor's and Rizespor's crest palettes), otherwise
// sampled from the official crest in assets/team-logos/. Not from kits.js:
// a shirt's colours change every season.
//
//   primary    the club's main colour
//   secondary  its second colour, used only when two clubs shown together
//              would be hard to tell apart
//
// The page is dark, and some official colours (navy, black, claret) disappear
// on it. Values are stored as published; teamColor() lifts only their OKLCH
// lightness, hue and saturation kept, until they reach 3:1 against #171020.
//
// Keys are Sportmonks team ids (teams.csv id).

const SUPERLIG_TEAM_COLORS = {
  "34": { name: "Galatasaray", primary: "#A90432", secondary: "#FDB912" }, // red / yellow (PMS 187, 123)
  "88": { name: "Fenerbahçe", primary: "#FFEB00", secondary: "#0A4781" }, // yellow / navy
  "554": { name: "Beşiktaş", primary: "#FFFFFF", secondary: "#000000" }, // white / black
  "688": { name: "Trabzonspor", primary: "#A41D34", secondary: "#14C0F1" }, // claret / blue
  "2811": { name: "Samsunspor", primary: "#FF0019", secondary: "#FFFFFF" }, // red / white
  "2632": { name: "Konyaspor", primary: "#00804D", secondary: "#FFFFFF" }, // green / white
  "286": { name: "Gençlerbirliği", primary: "#E00712", secondary: "#1C1C1C" }, // red / black
  "13860": { name: "Kocaelispor", primary: "#1F592B", secondary: "#1B1A18" }, // green / black
  "1071": { name: "Kasımpaşa", primary: "#2F4BA6", secondary: "#FFFFFF" }, // blue / white
  "3702": { name: "İstanbul Başakşehir", primary: "#FF5000", secondary: "#001E3F" }, // orange / navy
  "347": { name: "Alanyaspor", primary: "#F58220", secondary: "#42A13F" }, // orange / green
  "1041": { name: "Rizespor", primary: "#009430", secondary: "#008BD0" }, // green / blue
  "3897": { name: "Göztepe", primary: "#FFDC00", secondary: "#E82029" }, // yellow / red
  "3224": { name: "Eyüpspor", primary: "#603195", secondary: "#FFD800" }, // purple / yellow
  "3570": { name: "Amed SK", primary: "#FF0011", secondary: "#3F9E00" }, // red / green
  "4192": { name: "Gaziantep F.K.", primary: "#E73037", secondary: "#1D1D1B" }, // red / black
  "13871": { name: "Çorum FK", primary: "#E40105", secondary: "#000000" }, // red / black
  "13818": { name: "Erzurumspor FK", primary: "#3A86CA", secondary: "#FFFFFF" }, // blue / white
};

// Clubs not in the table yet (a promoted side) get a neutral pair.
const NEUTRAL_TEAM_COLORS = { name: "Bilinmeyen takım", primary: "#A99CB3", secondary: "#6F8FAF" };

const TEAM_COLOR_SURFACE = "#171020";
const TEAM_COLOR_MIN_CONTRAST = 3;
// Below this OKLab distance (×100) two colours are hard to tell apart even
// with full colour vision.
const TEAM_COLOR_MIN_DISTANCE = 15;

const teamColorChannels = (hex) => [1, 3, 5].map((index) => {
  const value = parseInt(hex.slice(index, index + 2), 16) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
});

function teamColorLab(hex) {
  const [r, g, b] = teamColorChannels(hex);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}

function teamColorHex([lightness, a, b]) {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return `#${[4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s].map((value) => {
    const encoded = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, encoded)) * 255).toString(16).padStart(2, "0");
  }).join("").toUpperCase()}`;
}

function teamColorContrast(hex) {
  const luminance = (value) => {
    const [r, g, b] = teamColorChannels(value);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  return (luminance(hex) + 0.05) / (luminance(TEAM_COLOR_SURFACE) + 0.05);
}

// An official colour as drawn on the dark page: unchanged when it already
// reads, otherwise lightened step by step in OKLCH.
const teamColorReadable = (() => {
  const cache = new Map();
  return (hex) => {
    if (!cache.has(hex)) {
      const [lightness, a, b] = teamColorLab(hex);
      let shown = hex;
      for (let step = lightness; teamColorContrast(shown) < TEAM_COLOR_MIN_CONTRAST && step < 1; step += 0.01) shown = teamColorHex([step, a, b]);
      cache.set(hex, shown);
    }
    return cache.get(hex);
  };
})();

function teamColors(teamId) {
  const club = SUPERLIG_TEAM_COLORS[String(teamId)] || NEUTRAL_TEAM_COLORS;
  return { primary: teamColorReadable(club.primary), secondary: teamColorReadable(club.secondary) };
}

function teamColor(teamId) {
  return teamColors(teamId).primary;
}

function teamColorDistance(first, second) {
  const [x, y] = [teamColorLab(first), teamColorLab(second)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) * 100;
}

// Colours for two clubs shown together. Both keep their main colour unless
// the two would be hard to tell apart; then the second club switches to its
// secondary, and only if that clashes too does the first switch instead.
function teamColorPair(firstId, secondId) {
  const first = teamColors(firstId), second = teamColors(secondId);
  const options = [[first.primary, second.primary], [first.primary, second.secondary], [first.secondary, second.primary], [first.secondary, second.secondary]];
  return options.find(([a, b]) => teamColorDistance(a, b) >= TEAM_COLOR_MIN_DISTANCE)
    || options.reduce((best, pair) => teamColorDistance(...pair) > teamColorDistance(...best) ? pair : best);
}
