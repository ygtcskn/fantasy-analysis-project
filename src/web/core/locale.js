"use strict";

// Turkish wording and formats shared by every page. The data keeps the
// provider's codes (FT, NS, W/D/L); only what the reader sees is translated.
const LOCALE = "tr-TR";

const FIXTURE_STATES = {
  NS: "Başlamadı", TBA: "Saati belli değil", PENDING: "Bekleniyor", DELAYED: "Gecikmeli",
  INPLAY_1ST_HALF: "İlk yarı", HT: "Devre arası", INPLAY_2ND_HALF: "İkinci yarı", BREAK: "Ara",
  INPLAY_ET: "Uzatma", EXTRA_TIME_BREAK: "Uzatma arası", INPLAY_PENALTIES: "Penaltılar",
  FT: "Maç sonu", AET: "Uzatmalar sonunda", FT_PEN: "Penaltılar sonunda",
  POSTP: "Ertelendi", POSTPONED: "Ertelendi", SUSP: "Askıya alındı", SUSPENDED: "Askıya alındı",
  INT: "Yarıda kaldı", INTERRUPTED: "Yarıda kaldı", ABAN: "Tatil edildi", ABANDONED: "Tatil edildi",
  CANC: "İptal", CANCELLED: "İptal", AWARDED: "Hükmen", WO: "Hükmen", DELETED: "Silindi",
};

function fixtureStateLabel(fixture) {
  const code = String(fixture?.["state.developer_name"] || fixture?.state || "").toUpperCase();
  return FIXTURE_STATES[code] || code || "Durum yok";
}

// "2026-09-12" as "12 Eylül Cumartesi". Built from the calendar date itself, so
// the weekday never shifts with the reader's time zone.
function longDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return "Tarih belli değil";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "long", weekday: "long", timeZone: "UTC" }).format(date);
}

// Event details as Sportmonks writes them (events.csv and the live feed), in
// Turkish. The keys are every distinct value found across the downloaded
// 2021-2027 seasons, normalised: lower case, camelCase split, repeated spaces
// collapsed, so "goalkeeperSave", "GoalkeeperSave" and "Goalkeeper save" are
// one entry. A numbered value ("2nd Yellowcard") becomes "2. sarı kart". Text
// that is not a known phrase - a club name in the info field, say - is shown
// exactly as sent rather than guessed at.
const EVENT_TEXT = {
  // Why a card was shown or how a goal was scored (info)
  "foul": "faul", "argument": "itiraz", "right foot shot": "sağ ayak şutu", "left foot shot": "sol ayak şutu",
  "time wasting": "zaman geçirme", "header": "kafa vuruşu", "field goal": "akan oyundan gol", "offside": "ofsayt",
  "unsportsmanlike conduct": "sportmenliğe aykırı hareket", "roughing": "sert müdahale", "handball": "elle oynama",
  "tripping": "çelme takma", "misses next match": "sonraki maçta cezalı", "penalty": "penaltı", "holding": "formadan tutma",
  "shot": "şut", "simulation": "rol yapma", "persistent fouling": "sürekli faul",
  "professional foul last man": "son adama kasıtlı faul", "goalkeeper save": "kaleci kurtardı",
  "off the ball foul": "top dışında faul", "violent conduct": "sert davranış", "own goal": "kendi kalesine gol",
  "free kick": "serbest vuruş", "delay of game": "oyunu geciktirme", "woodwork": "direk", "goal disallowed": "gol iptal",
  "elbowing": "dirsek atma", "unallowed field entering": "izinsiz sahaya girme", "professional handball": "kasıtlı elle oynama",
  "off target": "isabetsiz", "second yellow card": "ikinci sarı kart", "handling": "elle oynama", "diving": "kendini atma",
  "serious foul": "ciddi faul", "fighting": "kavga", "goal under review": "gol inceleniyor", "dangerous play": "tehlikeli oyun",
  "butting": "kafa atma", "other reason": "diğer sebep", "video review": "video incelemesi",
  // What the event was, often numbered (addition)
  "substitution": "oyuncu değişikliği", "goal": "gol", "yellowcard": "sarı kart", "yellow card": "sarı kart",
  "corner": "korner", "penalty confirmed": "penaltı onaylandı", "missed penalty": "kaçan penaltı", "redcard": "kırmızı kart",
  "red card": "kırmızı kart", "goal confirmed": "gol onaylandı", "penalty awarded": "penaltı verildi",
  "yellow/red card": "ikinci sarıdan kırmızı kart", "penalty cancelled": "penaltı iptal", "card adjusted": "kart değiştirildi",
  "var": "VAR", "goal cancelled": "gol iptal", "card upgrade": "kart yükseltildi", "goal awarded": "gol verildi",
  "penalty disallowed": "penaltı iptal", "red card cancelled": "kırmızı kart iptal", "card reviewed": "kart incelendi",
  "redcard unconfirmed": "kırmızı kart onaylanmadı",
  // Event type names, used when an event arrives without a known code
  "var card": "VAR · kart", "penalty shootout goal": "seri penaltı golü", "penalty shootout miss": "seri penaltı kaçtı",
};

function translateEventText(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const key = text.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_\s]+/g, " ").trim().toLocaleLowerCase("en");
  const numbered = key.match(/^(\d+)(?:st|nd|rd|th) (.+)$/);
  if (numbered) return EVENT_TEXT[numbered[2]] ? `${numbered[1]}. ${EVENT_TEXT[numbered[2]]}` : text;
  const found = EVENT_TEXT[key];
  return found ? found.charAt(0).toLocaleUpperCase(LOCALE) + found.slice(1) : text;
}
