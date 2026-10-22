"use strict";

// "Kadroyu kaydet": the squad on the pitch goes to Supabase's shared_squads
// (supabase/shared_squads.sql) for the matchweek still open for changes, and
// shows on Sosyal → Kadrolar. Saving needs a signed-in visitor with a nickname
// (core/profile.js); anyone else is sent to sign in first. The squad is kept
// for this tab when they are, because signing in with Google leaves the page
// and would otherwise come back to an empty pitch.

const BUILDER_DRAFT_KEY = "fantezi-analiz-builder-draft";
const builderSaveState = { busy: false, restored: false };
const builderDeadlineText = (time) => `${longDate(matchDayFormat.format(time))} ${matchClockFormat.format(time)}`;

function builderSaveStatus(text, error = false) {
  const status = $("builder-save-status");
  status.textContent = text;
  status.classList.toggle("error", error);
}

// The matchweek a squad is saved for: the first whose fantasy deadline is still
// ahead, keyed by Sportmonks round ID as on Kadrolar.
function builderOpenRound(now = Date.now()) {
  const rounds = new Map();
  for (const fixture of state.tables["fixtures.csv"] || []) {
    const id = String(fixture.round_id || fixture["round.id"] || "");
    if (!id) continue;
    if (!rounds.has(id)) rounds.set(id, { id, name: fixture["round.name"] ? `Maç Haftası ${fixture["round.name"]}` : `Tur ${id}`, fixtures: [] });
    rounds.get(id).fixtures.push(fixture);
  }
  return [...rounds.values()].map((round) => ({ ...round, deadline: fantasyDeadline(round.fixtures) }))
    .filter((round) => round.deadline > now).sort((a, b) => a.deadline - b.deadline)[0] || null;
}

// The eleven from the goalkeeper forward, then the bench, as the table keeps
// them, with the eleven's expected points as Kadro Kur's summary adds them up.
function builderSavedSquad() {
  const starterSlots = builderFormationRows().reverse().flatMap((row) => row.slots);
  const starters = starterSlots.map((slot) => builderState.selected.get(slot.key)).filter(Boolean);
  const bench = builderBenchSlots().map((slot) => builderState.selected.get(slot.key)).filter(Boolean);
  const projections = starters.map((id) => builderFantasyData(builderPlayer(id) || { id }).projection);
  const { total, count } = builderSummaryTotal(projections, "expected_points");
  return {
    missing: starterSlots.length - starters.length,
    row: {
      formation: $("builder-formation").value,
      starters: starters.map(Number), bench: bench.map(Number),
      expected_points: total === null ? null : Math.round(total * 100) / 100,
      projected_starters: count,
    },
  };
}

// Kept for this tab only, as "season=…&formation=…&slots=GK-0:123,DEF-0:456",
// and read back once.
function stashBuilderDraft() {
  const slots = [...builderState.selected].map(([slot, id]) => `${slot}:${id}`).join(",");
  try {
    sessionStorage.setItem(BUILDER_DRAFT_KEY, new URLSearchParams({ season: state.seasonSlug, formation: $("builder-formation").value, slots }).toString());
  } catch { /* storage unavailable: the squad simply is not kept */ }
}

// Called before the builder draws, once the season's players are known.
function restoreBuilderDraft(playersById) {
  if (builderSaveState.restored || !playersById.size) return;
  builderSaveState.restored = true;
  let draft = null;
  try {
    draft = sessionStorage.getItem(BUILDER_DRAFT_KEY);
    sessionStorage.removeItem(BUILDER_DRAFT_KEY);
  } catch { return; }
  if (!draft || builderState.selected.size) return;
  const params = new URLSearchParams(draft);
  if (params.get("season") !== state.seasonSlug) return;
  const formation = params.get("formation");
  if ([...$("builder-formation").options].some((option) => option.value === formation)) $("builder-formation").value = formation;
  const slots = new Set(builderSlots().map((slot) => slot.key));
  builderState.selected = new Map(String(params.get("slots") || "").split(",").map((pair) => pair.split(":"))
    .filter(([slot, id]) => slots.has(slot) && playersById.has(id)));
  if (builderState.selected.size) {
    builderSaveStatus(siteAuth.user ? "Kadron geri geldi. Kaydetmek için Kadroyu kaydet'e bas." : "Kadron geri geldi.");
  }
}

function saveErrorText(error) {
  const message = error?.message || "";
  if (message.includes("nickname_required")) return "Kaydetmeden önce profilinden bir takma ad seç.";
  if (message.includes("sign_in_required")) return "Kaydetmek için giriş yap.";
  if (error?.code === "23514") return "Kadro kaydedilemedi: ilk 11 tam olmalı, en fazla 4 yedek olabilir.";
  if (["PGRST205", "42P01", "PGRST204", "42703"].includes(error?.code)) {
    return siteMode === "local"
      ? "Kadro tablosu eksik: supabase/shared_squads.sql dosyasını Supabase → SQL Editor'da çalıştır."
      : "Kadrolar şu anda kaydedilemiyor. Daha sonra tekrar dene.";
  }
  return message ? `Bir sorun çıktı: ${message}` : "Bir sorun çıktı. Tekrar dene.";
}

async function saveBuilderSquad() {
  if (builderSaveState.busy) return;
  if (!siteAuth.user) stashBuilderDraft();
  if (!await profileReady("Kadronu kaydetmek için giriş yap. Sahadaki kadron bu sekmede seni bekler.",
    "Kaydetmeden önce bir takma ad seç; Kadrolar sayfasında kadronun yanında o görünür.")) return;
  const { missing, row } = builderSavedSquad();
  if (missing) {
    builderSaveStatus(`Kaydetmek için ilk 11'i tamamla: ${missing} mevki boş.`, true);
    return;
  }
  const round = builderOpenRound();
  if (!round) {
    builderSaveStatus("Kaydedilecek açık maç haftası yok: sezonun son haftasının son tarihi geçti.", true);
    return;
  }
  builderSaveState.busy = true;
  $("builder-save").disabled = true;
  builderSaveStatus("Kaydediliyor…");
  try {
    const client = await loadAuth();
    let updated = false;
    const inserted = await client.from("shared_squads").insert({ season: state.seasonSlug, round_id: Number(round.id), ...row }).select("id");
    if (inserted.error?.code === "23505") {
      // Already saved for this week: the table keeps one per visitor, so change it.
      const changed = await client.from("shared_squads").update(row)
        .eq("season", state.seasonSlug).eq("round_id", Number(round.id)).eq("user_id", siteAuth.user.id).select("id");
      if (changed.error) throw changed.error;
      if (!changed.data.length) throw new Error("Kaydedilen kadron bulunamadı.");
      updated = true;
    } else if (inserted.error) throw inserted.error;
    try { sessionStorage.removeItem(BUILDER_DRAFT_KEY); } catch { /* storage unavailable */ }
    builderSaveStatus(`Kadron ${round.name} için ${updated ? "güncellendi" : "kaydedildi"}. Kadrolar sayfasında herkes görebilir.`);
    document.dispatchEvent(new CustomEvent("shared-squad-saved"));
  } catch (error) {
    builderSaveStatus(saveErrorText(error), true);
    if ((error?.message || "").includes("nickname_required")) openProfileDialog();
  } finally {
    builderSaveState.busy = false;
    $("builder-save").disabled = false;
  }
}

// The line under the button: which week a save goes to, and until when.
function renderBuilderSave() {
  $("builder-save-area").hidden = !authEnabled();
  const round = builderOpenRound();
  $("builder-save-hint").textContent = !round
    ? "Sezonun açık maç haftası kalmadı."
    : `${round.name} için kaydedilir · son tarih ${builderDeadlineText(round.deadline)}.${siteAuth.user ? "" : " Kaydetmek için giriş yapman gerekir."}`;
}

function setupBuilderSave() {
  $("builder-save").addEventListener("click", saveBuilderSquad);
  // Signing in or out changes the hint.
  document.addEventListener("site-auth-change", () => { if (state.view === "builder") renderBuilderSave(); });
}
