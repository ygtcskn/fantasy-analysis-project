"use strict";

// Team analysis charts for Takım İstatistikleri, current season only. Pure: no
// DOM and no requests. Every chart is computed from the saved season CSVs and
// returned as markup, so a weekly download followed by "Refresh saved data"
// redraws all of them; team-charts-page.js puts them on the page.
//
// Only finished fixtures with a saved score count. A fixture the last download
// caught in play (INPLAY_2ND_HALF) is left out until it is downloaded again,
// rather than counted with half its statistics.
//
// Text is written in Turkish and shown in the page's language (t, from
// core/language.js). Node loads this file on its own, so it fetches that
// script itself there; the text then stays as written.
if (typeof t === "undefined") Object.assign(globalThis, require("../core/language.js"));

const TeamAnalysis = (() => {
  const finishedStates = new Set(["FT", "AET", "FT_PEN", "AWARDED", "WO"]);
  const buckets = ["0-15", "16-30", "31-45+", "46-60", "61-75", "76-90+"];
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const num = (value) => {
    if (value === null || value === undefined || String(value).trim() === "") return null;
    const result = Number(value);
    return Number.isFinite(result) ? result : null;
  };
  const text = (value, digits = 2) => (value === null || !Number.isFinite(value) ? "—"
    : value.toLocaleString(LOCALE, { minimumFractionDigits: 0, maximumFractionDigits: digits }));
  const fixed = (value) => value.toFixed(1);
  const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
  const stateOf = (fixture) => String(fixture["state.developer_name"] || fixture.state || "").toUpperCase();
  function kickoff(fixture) {
    const stamp = num(fixture.starting_at_timestamp);
    if (stamp !== null) return stamp * 1000;
    const value = String(fixture.kickoff || fixture.starting_at || "").trim().replace(" ", "T");
    const parsed = Date.parse(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`);
    return Number.isFinite(parsed) ? parsed : Infinity;
  }
  const label = (names, id) => names.get(id)?.short_code || names.get(id)?.name || `#${id}`;
  const fullName = (names, id) => names.get(id)?.name || t("Takım {id}", { id });

  // ------------------------------------------------------------------ matches
  // One entry per team and finished fixture: result from the saved CURRENT
  // score, match statistics from team_metrics for the team and its opponent
  // (null where not recorded). Big chances are an event count: on a match whose
  // statistics were recorded, a blank is none, as everywhere else on the site.
  function matches({ fixtures, scores, teamRows = [] }) {
    const stats = new Map(teamRows.map((row) => [`${row.fixture_id}|${row.team_id}`, row]));
    const result = [];
    for (const fixture of fixtures) {
      if (!finishedStates.has(stateOf(fixture))) continue;
      const home = String(fixture.home_team_id), away = String(fixture.away_team_id), id = String(fixture.fixture_id);
      const homeGoals = scores.get(`${id}:${home}`), awayGoals = scores.get(`${id}:${away}`);
      if (![homeGoals, awayGoals].every((value) => Number.isInteger(value) && value >= 0)) continue;
      for (const [team, opponent, isHome, own, other] of [[home, away, true, homeGoals, awayGoals], [away, home, false, awayGoals, homeGoals]]) {
        const mine = stats.get(`${id}|${team}`) || {}, theirs = stats.get(`${id}|${opponent}`) || {};
        const recorded = (row) => num(row.passes) !== null || num(row.shots_total) !== null;
        const events = (row, key) => num(row[key]) ?? (key in row && recorded(row) ? 0 : null);
        result.push({ fixtureId: id, teamId: team, opponentId: opponent, home: isHome,
          round: num(fixture["round.name"]), kickoff: kickoff(fixture), goalsFor: own, goalsAgainst: other,
          result: own > other ? "W" : own < other ? "L" : "D", points: own > other ? 3 : own === other ? 1 : 0,
          xg: num(mine.expected_goals), xga: num(mine.expected_goals_against), xpts: num(mine.expected_points),
          shots: num(mine.shots_total), shotsConceded: num(theirs.shots_total) ?? num(mine.shots_conceded),
          possession: num(mine.ball_possession), dangerous: num(mine.dangerous_attacks),
          tackles: num(mine.tackles), interceptions: num(mine.interceptions), fouls: num(mine.fouls), rivalPasses: num(theirs.passes),
          bigChances: events(mine, "big_chances_created"), bigChancesConceded: events(theirs, "big_chances_created") });
      }
    }
    return result.sort((a, b) => a.kickoff - b.kickoff || a.fixtureId.localeCompare(b.fixtureId));
  }

  // The latest round with a finished match, and whether all of it is in.
  function asOf(fixtures, played) {
    const rounds = [...new Set(played.map((match) => match.round).filter((round) => round !== null))];
    if (!rounds.length) return { round: null, finished: 0, scheduled: 0, matches: 0 };
    const round = Math.max(...rounds);
    const scheduled = fixtures.filter((fixture) => num(fixture["round.name"]) === round).length;
    const finished = new Set(played.filter((match) => match.round === round).map((match) => match.fixtureId)).size;
    return { round, finished, scheduled, matches: new Set(played.map((match) => match.fixtureId)).size };
  }

  // A result's letter and word in the page's language: G, B, M or W, D, L.
  const resultLetter = { W: t("G"), D: t("B"), L: t("M") };
  const record = (list) => {
    const count = (outcome) => list.filter((match) => match.result === outcome).length;
    return `${count("W")}${resultLetter.W} ${count("D")}${resultLetter.D} ${count("L")}${resultLetter.L}`;
  };
  const resultWord = { W: t("galibiyet"), D: t("beraberlik"), L: t("mağlubiyet") };
  const matchTitle = (match, names) => `${match.round !== null ? `${t("{round}. hafta", { round: match.round })} · ` : ""}`
    + `${fullName(names, match.opponentId)} (${match.home ? t("İ") : t("D")}) · ${match.goalsFor}-${match.goalsAgainst} ${resultWord[match.result]}`;

  // Small multiples share one panel frame: a team's name and record above an
  // SVG, clickable to open the team's profile. On the profile itself the panel
  // already is the open team, so it is drawn plain rather than as a link.
  function panel(teamId, names, selected, heading, svg, { interactive = true } = {}) {
    const open = interactive ? ` role="button" tabindex="0" aria-label="${escape(t("{name} profilini göster", { name: fullName(names, teamId) }))}"` : "";
    return `<div class="ta-panel${interactive ? "" : " ta-panel-static"}${teamId === selected ? " ta-selected" : ""}"`
      + ` data-team="${escape(teamId)}"${open}><div class="ta-panel-heading"><span>${escape(fullName(names, teamId))}</span>`
      + `<small>${escape(heading)}</small></div>${svg}</div>`;
  }

  // --------------------------------------------------------------- xG v xGA
  // One point per match, chances conceded across and chances created up. Above
  // the diagonal a team out-created its opponent; the shaded half is where it
  // did not. Grey points are every team-match of the season, the cross is the
  // team's own average.
  function xgGrid(played, order, names, selected, options) {
    const known = played.filter((match) => match.xg !== null && match.xga !== null);
    const top = Math.max(3, Math.ceil(Math.max(0, ...known.flatMap((match) => [match.xg, match.xga]))));
    const size = 230, left = 26, bottom = 22, right = 8, head = 8, plot = size - left - right;
    const x = (value) => left + (value / top) * plot, y = (value) => head + plot - (value / top) * plot;
    const frame = [];
    frame.push(`<polygon points="${fixed(x(0))},${fixed(y(0))} ${fixed(x(top))},${fixed(y(top))} ${fixed(x(top))},${fixed(y(0))}" fill="var(--ta-shade)"/>`);
    for (let tick = 0; tick <= top; tick += 1) {
      frame.push(`<line x1="${fixed(x(tick))}" y1="${fixed(y(0))}" x2="${fixed(x(tick))}" y2="${fixed(y(top))}" stroke="var(--line)" stroke-dasharray="2 3"/>`);
      frame.push(`<line x1="${fixed(x(0))}" y1="${fixed(y(tick))}" x2="${fixed(x(top))}" y2="${fixed(y(tick))}" stroke="var(--line)" stroke-dasharray="2 3"/>`);
      frame.push(`<text x="${fixed(x(tick))}" y="${fixed(y(0) + 13)}" text-anchor="middle" font-size="9" fill="var(--muted)">${tick}</text>`);
      frame.push(`<text x="${fixed(x(0) - 5)}" y="${fixed(y(tick) + 3)}" text-anchor="end" font-size="9" fill="var(--muted)">${tick}</text>`);
    }
    frame.push(`<line x1="${fixed(x(0))}" y1="${fixed(y(0))}" x2="${fixed(x(top))}" y2="${fixed(y(top))}" stroke="var(--muted)" stroke-dasharray="4 3"/>`);
    frame.push(`<text x="${fixed(x(top))}" y="${fixed(y(0) - 4)}" text-anchor="end" font-size="9" font-weight="600" fill="var(--muted)">xGA</text>`);
    frame.push(`<text x="${fixed(x(0) + 4)}" y="${fixed(y(top) + 9)}" font-size="9" font-weight="600" fill="var(--muted)">xG</text>`);
    const cloud = known.map((match) => `<circle cx="${fixed(x(match.xga))}" cy="${fixed(y(match.xg))}" r="2.2" fill="var(--muted)" fill-opacity="0.35"/>`).join("");
    const panels = order.map((teamId) => {
      const own = played.filter((match) => match.teamId === teamId);
      const plotted = own.filter((match) => match.xg !== null && match.xga !== null);
      const dots = plotted.map((match) => `<circle data-ta-match="${escape(match.fixtureId)}" cx="${fixed(x(match.xga))}" cy="${fixed(y(match.xg))}" r="5" fill="var(--ta-${match.result})" stroke="var(--surface-raised)" stroke-width="1.2">`
        + `<title>${escape(`${matchTitle(match, names)} · xG ${text(match.xg)} · xGA ${text(match.xga)}`)}</title></circle>`).join("");
      let cross = "";
      if (plotted.length) {
        const cx = x(mean(plotted.map((match) => match.xga))), cy = y(mean(plotted.map((match) => match.xg)));
        cross = `<g stroke="var(--ink)" stroke-width="2"><line x1="${fixed(cx - 6)}" y1="${fixed(cy)}" x2="${fixed(cx + 6)}" y2="${fixed(cy)}"/><line x1="${fixed(cx)}" y1="${fixed(cy - 6)}" x2="${fixed(cx)}" y2="${fixed(cy + 6)}"/>`
          + `<title>${escape(`${t("Ortalama")} · xG ${text(mean(plotted.map((match) => match.xg)))} · xGA ${text(mean(plotted.map((match) => match.xga)))}`)}</title></g>`;
      }
      const svg = `<svg viewBox="0 0 ${size} ${size}" width="100%" role="img" aria-label="${escape(t("{team}: maç maç xG ve xGA", { team: fullName(names, teamId) }))}">${frame.join("")}${cloud}${dots}${cross}</svg>`;
      const missing = own.length - plotted.length;
      return panel(teamId, names, selected, `${record(own)}${missing ? ` · ${t("{count} maçta xG yok", { count: missing }, missing)}` : ""}`, svg, options);
    });
    return { html: panels.join(""), scale: top, matches: known.length };
  }

  // -------------------------------------------------------- fantasy by role
  // Where a team's fantasy points come from: the published ledger summed by
  // the game's positions. Negative totals are drawn left of zero.
  const roles = [["KL", t("Kaleci")], ["DEF", t("Defans")], ["OS", t("Orta saha")], ["FOR", t("Forvet")]];
  function fantasyByRole(ledgerRows, names) {
    const teams = new Map();
    for (const row of ledgerRows) {
      const team = String(row.team_id || ""), role = String(row.fantasy_position || "");
      if (!team || !roles.some(([key]) => key === role)) continue;
      if (!teams.has(team)) teams.set(team, { teamId: team, total: 0, fixtures: new Set(), ...Object.fromEntries(roles.map(([key]) => [key, 0])) });
      const entry = teams.get(team), points = num(row.points_total) ?? 0;
      entry[role] += points;
      entry.total += points;
      if (row.fixture_id) entry.fixtures.add(String(row.fixture_id));
    }
    return [...teams.values()].map((entry) => ({ ...entry, matches: entry.fixtures.size }))
      .sort((a, b) => b.total - a.total || fullName(names, a.teamId).localeCompare(fullName(names, b.teamId), LOCALE));
  }
  function fantasyChart(rows, names, selected) {
    const width = 640, left = 132, right = 44, row = 22, top = 8;
    const height = top + rows.length * row + 8;
    const low = Math.min(0, ...rows.map((entry) => roles.reduce((sum, [key]) => sum + Math.min(0, entry[key]), 0)));
    const high = Math.max(1, ...rows.map((entry) => roles.reduce((sum, [key]) => sum + Math.max(0, entry[key]), 0)));
    const x = (value) => left + ((value - low) / (high - low)) * (width - left - right);
    const parts = [`<line x1="${fixed(x(0))}" y1="${top - 4}" x2="${fixed(x(0))}" y2="${height - 4}" stroke="var(--line)"/>`];
    rows.forEach((entry, index) => {
      const y = top + index * row, bold = entry.teamId === selected ? ' font-weight="700"' : "";
      parts.push(`<text x="${left - 8}" y="${y + 15}" text-anchor="end" font-size="11" fill="var(--ink)"${bold} data-team="${escape(entry.teamId)}" class="ta-link">${escape(fullName(names, entry.teamId))}</text>`);
      let positive = 0, negative = 0;
      for (const [key, name] of roles) {
        const value = entry[key];
        if (!value) continue;
        const start = value > 0 ? positive : negative + value;
        if (value > 0) positive += value; else negative += value;
        parts.push(`<rect x="${fixed(x(start))}" y="${y + 4}" width="${fixed(Math.abs(x(value) - x(0)))}" height="${row - 8}" fill="var(--ta-${key.toLowerCase()})">`
          + `<title>${escape(`${fullName(names, entry.teamId)} · ${name}: ${text(value, 1)} FP`)}</title></rect>`);
      }
      parts.push(`<text x="${fixed(x(positive) + 5)}" y="${y + 15}" font-size="10" fill="var(--muted)">${text(entry.total, 1)}</text>`);
    });
    return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${escape(t("Takımların fantezi puanı, mevkiye göre"))}">${parts.join("")}</svg>`;
  }

  // -------------------------------------------------------------------- luck
  // Results against chances over the season. Both columns point the same way:
  // right means the results were better than the chances - more goals than xG,
  // or fewer conceded than xG against - which tends not to last.
  function luck(played, order) {
    return order.map((teamId) => {
      const own = played.filter((match) => match.teamId === teamId);
      const known = own.filter((match) => match.xg !== null && match.xga !== null);
      const sum = (list, key) => list.reduce((total, match) => total + match[key], 0);
      return { teamId, matches: known.length, missing: own.length - known.length,
        goals: sum(known, "goalsFor"), xg: sum(known, "xg"), conceded: sum(known, "goalsAgainst"), xga: sum(known, "xga"),
        attack: known.length ? sum(known, "goalsFor") - sum(known, "xg") : null,
        defence: known.length ? sum(known, "xga") - sum(known, "goalsAgainst") : null };
    });
  }
  function luckChart(rows, names, selected) {
    const width = 640, left = 132, gap = 26, row = 22, top = 26;
    const column = (width - left - gap) / 2, height = top + rows.length * row + 8;
    const reach = Math.max(1, ...rows.flatMap((entry) => [Math.abs(entry.attack ?? 0), Math.abs(entry.defence ?? 0)]));
    const parts = [];
    [["attack", t("Hücum · gol − xG")], ["defence", t("Savunma · xGA − yenilen")]].forEach(([key, title], block) => {
      const start = left + block * (column + gap), zero = start + column / 2;
      const x = (value) => zero + (value / reach) * (column / 2 - 30);
      parts.push(`<text x="${fixed(zero)}" y="12" text-anchor="middle" font-size="11" font-weight="600" fill="var(--ink)">${escape(title)}</text>`);
      parts.push(`<line x1="${fixed(zero)}" y1="${top - 6}" x2="${fixed(zero)}" y2="${height - 4}" stroke="var(--muted)"/>`);
      rows.forEach((entry, index) => {
        const value = entry[key], y = top + index * row;
        if (value === null) { parts.push(`<text x="${fixed(zero)}" y="${y + 15}" text-anchor="middle" font-size="10" fill="var(--muted)">—</text>`); return; }
        const tone = value >= 0 ? "over" : "under";
        const detail = key === "attack" ? t("{goals} gol, {xg} xG", { goals: entry.goals, xg: text(entry.xg) })
          : t("{conceded} yenilen, {xga} xGA", { conceded: entry.conceded, xga: text(entry.xga) });
        parts.push(`<rect x="${fixed(Math.min(zero, x(value)))}" y="${y + 5}" width="${fixed(Math.abs(x(value) - zero))}" height="${row - 10}" fill="var(--ta-${tone})">`
          + `<title>${escape(`${fullName(names, entry.teamId)} · ${detail} · ${t("fark {value} ({count} maç)", { value: `${value > 0 ? "+" : ""}${text(value)}`, count: entry.matches })}`)}</title></rect>`);
        parts.push(`<text x="${fixed(value >= 0 ? x(value) + 4 : x(value) - 4)}" y="${y + 15}" text-anchor="${value >= 0 ? "start" : "end"}" font-size="10" fill="var(--muted)">${value > 0 ? "+" : ""}${text(value, 1)}</text>`);
      });
    });
    rows.forEach((entry, index) => {
      const bold = entry.teamId === selected ? ' font-weight="700"' : "";
      parts.push(`<text x="${left - 8}" y="${top + index * row + 15}" text-anchor="end" font-size="11" fill="var(--ink)"${bold} data-team="${escape(entry.teamId)}" class="ta-link">${escape(fullName(names, entry.teamId))}</text>`);
    });
    return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${escape(t("Gol ve xG farkı, hücum ve savunma"))}">${parts.join("")}</svg>`;
  }

  // -------------------------------------------------------------------- form
  // Match by match, xG above the line and xG conceded below, oldest first.
  function formGrid(played, order, names, selected, options) {
    const known = played.filter((match) => match.xg !== null && match.xga !== null);
    const top = Math.max(2, Math.ceil(Math.max(0, ...known.flatMap((match) => [match.xg, match.xga]))));
    const width = 230, height = 132, left = 22, right = 6, middle = 62, reach = 48;
    const panels = order.map((teamId) => {
      const own = played.filter((match) => match.teamId === teamId);
      const slot = (width - left - right) / Math.max(own.length, 1), bar = Math.min(slot * 0.6, 26);
      const y = (value) => (value / top) * reach;
      const parts = [`<line x1="${left}" y1="${middle}" x2="${width - right}" y2="${middle}" stroke="var(--muted)"/>`,
        `<text x="${left - 4}" y="${middle - reach + 4}" text-anchor="end" font-size="8" fill="var(--muted)">${top}</text>`,
        `<text x="${left - 4}" y="${middle + reach + 3}" text-anchor="end" font-size="8" fill="var(--muted)">${top}</text>`,
        `<text x="${left - 4}" y="${middle - 8}" text-anchor="end" font-size="8" fill="var(--muted)">xG</text>`,
        `<text x="${left - 4}" y="${middle + 14}" text-anchor="end" font-size="8" fill="var(--muted)">xGA</text>`];
      own.forEach((match, index) => {
        const cx = left + slot * index + slot / 2, detail = escape(`${matchTitle(match, names)} · xG ${text(match.xg)} · xGA ${text(match.xga)}`);
        if (match.xg !== null) parts.push(`<rect x="${fixed(cx - bar / 2)}" y="${fixed(middle - y(match.xg))}" width="${fixed(bar)}" height="${fixed(y(match.xg))}" fill="var(--statistics-plot-line)"><title>${detail}</title></rect>`);
        if (match.xga !== null) parts.push(`<rect x="${fixed(cx - bar / 2)}" y="${middle}" width="${fixed(bar)}" height="${fixed(y(match.xga))}" fill="var(--ta-under)"><title>${detail}</title></rect>`);
        parts.push(`<text x="${fixed(cx)}" y="${height - 4}" text-anchor="middle" font-size="9" font-weight="700" fill="var(--ta-${match.result})">${resultLetter[match.result]}</text>`);
      });
      const svg = `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${escape(t("{team}: maç maç xG formu", { team: fullName(names, teamId) }))}">${parts.join("")}</svg>`;
      return panel(teamId, names, selected, record(own), svg, options);
    });
    return { html: panels.join(""), scale: top };
  }

  // ---------------------------------------------------------- goal minutes
  // Goals by fifteen-minute block, credited to the event's team: Sportmonks
  // gives an own goal to the side that benefits, and so counted, the events
  // reconcile with every saved score. Stoppage time joins the half's last block.
  function bucketOf(minute) {
    if (minute <= 15) return 0;
    if (minute <= 30) return 1;
    if (minute <= 45) return 2;
    if (minute <= 60) return 3;
    if (minute <= 75) return 4;
    return 5;
  }
  function goalTiming(events, played) {
    const fixtures = new Map();
    for (const match of played) {
      if (!fixtures.has(match.fixtureId)) fixtures.set(match.fixtureId, []);
      fixtures.get(match.fixtureId).push(match.teamId);
    }
    const teams = new Map();
    const entry = (team) => {
      if (!teams.has(team)) teams.set(team, { scored: buckets.map(() => 0), conceded: buckets.map(() => 0) });
      return teams.get(team);
    };
    for (const event of events) {
      const kind = String(event["type.developer_name"] || "").toUpperCase();
      if (!["GOAL", "PENALTY", "OWNGOAL"].includes(kind) || ["true", "1"].includes(String(event.rescinded).toLowerCase())) continue;
      const sides = fixtures.get(String(event.fixture_id)), team = String(event.participant_id || "");
      const minute = num(event.minute);
      if (!sides || !sides.includes(team) || minute === null) continue;
      const block = bucketOf(minute);
      entry(team).scored[block] += 1;
      entry(sides.find((side) => side !== team)).conceded[block] += 1;
    }
    return teams;
  }
  function timingGrid(timing, played, order, names, selected, options) {
    const top = Math.max(2, ...[...timing.values()].flatMap((entry) => [...entry.scored, ...entry.conceded]));
    const width = 230, height = 132, left = 18, right = 4, middle = 60, reach = 44;
    const slot = (width - left - right) / buckets.length, bar = slot * 0.62;
    const panels = order.map((teamId) => {
      const entry = timing.get(teamId) || { scored: buckets.map(() => 0), conceded: buckets.map(() => 0) };
      const y = (value) => (value / top) * reach;
      const parts = [`<line x1="${left}" y1="${middle}" x2="${width - right}" y2="${middle}" stroke="var(--muted)"/>`];
      buckets.forEach((name, index) => {
        const cx = left + slot * index + slot / 2;
        const detail = escape(t("{team} · {minutes}. dakikalar · {scored} attı, {conceded} yedi", { team: fullName(names, teamId), minutes: name,
          scored: entry.scored[index], conceded: entry.conceded[index] }));
        if (entry.scored[index]) parts.push(`<rect x="${fixed(cx - bar / 2)}" y="${fixed(middle - y(entry.scored[index]))}" width="${fixed(bar)}" height="${fixed(y(entry.scored[index]))}" fill="var(--ta-W)"><title>${detail}</title></rect>`);
        if (entry.conceded[index]) parts.push(`<rect x="${fixed(cx - bar / 2)}" y="${middle}" width="${fixed(bar)}" height="${fixed(y(entry.conceded[index]))}" fill="var(--ta-L)"><title>${detail}</title></rect>`);
        parts.push(`<text x="${fixed(cx)}" y="${height - 4}" text-anchor="middle" font-size="8" fill="var(--muted)">${name}</text>`);
      });
      const scored = entry.scored.reduce((a, b) => a + b, 0), conceded = entry.conceded.reduce((a, b) => a + b, 0);
      const svg = `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${escape(t("{team}: gol dakikaları", { team: fullName(names, teamId) }))}">${parts.join("")}</svg>`;
      return panel(teamId, names, selected, t("{scored} attı · {conceded} yedi", { scored, conceded }), svg, options);
    });
    return { html: panels.join(""), scale: top };
  }

  // ----------------------------------------------------------- momentum
  // The feed's pressure index runs minute by minute through stoppage time, so a
  // minute is first put back on the match clock using the first half's length
  // from fixture_periods: minutes past it belong to the second half. A team's
  // line is its pressure minus the opponent's, averaged by block over its
  // finished matches; above zero it had the upper hand.
  // A pressure minute on the match clock, stoppage time held at 45 or 90 so
  // that it joins the half's last block. Ana Sayfa uses the same rule.
  function matchClock(minute, firstHalf) {
    return minute <= firstHalf ? Math.min(minute, 45) : Math.min(45 + (minute - firstHalf), 90);
  }
  function momentum(pressureRows, periods, played) {
    const firstHalf = new Map();
    for (const period of periods) {
      const description = String(period.description || "").toLowerCase();
      if (description.includes("1st") && num(period.minutes) !== null) firstHalf.set(String(period.fixture_id), num(period.minutes));
    }
    const sides = new Map();
    for (const match of played) {
      if (!sides.has(match.fixtureId)) sides.set(match.fixtureId, []);
      sides.get(match.fixtureId).push(match.teamId);
    }
    const byMinute = new Map();
    for (const row of pressureRows) {
      const fixture = String(row.fixture_id), minute = num(row.minute), value = num(row.pressure);
      if (!sides.has(fixture) || minute === null || value === null) continue;
      const key = `${fixture}|${minute}`;
      if (!byMinute.has(key)) byMinute.set(key, { fixture, minute, values: new Map() });
      byMinute.get(key).values.set(String(row.participant_id), value);
    }
    const lastMinute = new Map();
    for (const { fixture, minute } of byMinute.values()) lastMinute.set(fixture, Math.max(lastMinute.get(fixture) || 0, minute));
    const sums = new Map();
    for (const { fixture, minute, values } of byMinute.values()) {
      const [a, b] = sides.get(fixture);
      if (!values.has(a) || !values.has(b)) continue;
      const half = firstHalf.get(fixture) ?? 45 + Math.max(0, Math.round(((lastMinute.get(fixture) || 90) - 90) / 2));
      const block = bucketOf(matchClock(minute, half));
      for (const [team, other] of [[a, b], [b, a]]) {
        if (!sums.has(team)) sums.set(team, buckets.map(() => ({ total: 0, count: 0 })));
        const cell = sums.get(team)[block];
        cell.total += values.get(team) - values.get(other);
        cell.count += 1;
      }
    }
    return new Map([...sums].map(([team, cells]) => [team, cells.map((cell) => (cell.count ? cell.total / cell.count : null))]));
  }
  function momentumGrid(balance, order, names, selected, options) {
    const reach = Math.max(5, ...[...balance.values()].flat().filter((value) => value !== null).map(Math.abs));
    const width = 230, height = 132, left = 18, right = 4, middle = 60, span = 44;
    const slot = (width - left - right) / buckets.length, bar = slot * 0.62;
    const panels = order.map((teamId) => {
      const values = balance.get(teamId) || buckets.map(() => null);
      const parts = [`<line x1="${left}" y1="${middle}" x2="${width - right}" y2="${middle}" stroke="var(--muted)"/>`];
      buckets.forEach((name, index) => {
        const value = values[index], cx = left + slot * index + slot / 2;
        if (value !== null) {
          const h = (Math.abs(value) / reach) * span;
          parts.push(`<rect x="${fixed(cx - bar / 2)}" y="${fixed(value >= 0 ? middle - h : middle)}" width="${fixed(bar)}" height="${fixed(h)}" fill="var(--ta-${value >= 0 ? "W" : "L"})">`
            + `<title>${escape(t("{team} · {minutes}. dakikalar · baskı farkı {value}", { team: fullName(names, teamId), minutes: name,
              value: `${value > 0 ? "+" : ""}${text(value, 1)}` }))}</title></rect>`);
        }
        parts.push(`<text x="${fixed(cx)}" y="${height - 4}" text-anchor="middle" font-size="8" fill="var(--muted)">${name}</text>`);
      });
      const known = values.filter((value) => value !== null);
      const svg = `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${escape(t("{team}: dakikalara göre baskı dengesi", { team: fullName(names, teamId) }))}">${parts.join("")}</svg>`;
      return panel(teamId, names, selected, known.length ? t("ortalama {value}", { value: text(mean(known), 1) }) : t("veri yok"), svg, options);
    });
    return { html: panels.join(""), scale: reach };
  }

  // --------------------------------------------------------------- scatter
  // One point per team, two season figures. Like-for-like pairs (goals against
  // xG, points against expected points) share one scale and a diagonal where
  // the two are equal; every other pair gets dashed lines at the league means.
  // Quadrant captions name what each corner means. Labels take the first free
  // spot around their point - right, left, above, below - so teams that play
  // alike do not print over each other. `colorOf` gives each club's point its
  // own colour (teamColor on the page); without it every point is the plot line.
  // Gridlines at round values - 1, 2, 2.5 or 5 times a power of ten - labelled
  // with exactly the precision the step needs, so a line marked 1 is at 1.
  function niceTicks(low, high, target = 6) {
    const raw = (high - low || 1) / target, power = 10 ** Math.floor(Math.log10(raw));
    const multiple = [1, 2, 2.5, 5, 10].find((candidate) => candidate * power >= raw);
    const step = multiple * power, ticks = [];
    for (let value = Math.ceil(low / step - 1e-9) * step; value <= high + step * 1e-9; value += step) ticks.push(Number(value.toFixed(10)));
    return { ticks, digits: Math.max(0, -Math.floor(Math.log10(step) + 1e-9)) + (multiple === 2.5 ? 1 : 0) };
  }
  function scatter(rows, spec, names, selected, colorOf = null) {
    const points = rows.filter((row) => Number.isFinite(row.x) && Number.isFinite(row.y));
    if (!points.length) return "";
    const width = 640, height = 400, left = 50, right = 16, top = 30, bottom = 42;
    const pad = (low, high) => { const extra = (high - low) * 0.12 || Math.max(Math.abs(high) * 0.1, 0.5); return [low - extra, high + extra]; };
    let [x0, x1] = pad(Math.min(...points.map((row) => row.x)), Math.max(...points.map((row) => row.x)));
    let [y0, y1] = pad(Math.min(...points.map((row) => row.y)), Math.max(...points.map((row) => row.y)));
    if (spec.floor !== undefined) { x0 = Math.max(x0, spec.floor); y0 = Math.max(y0, spec.floor); }
    if (spec.diagonal) { x0 = y0 = Math.min(x0, y0); x1 = y1 = Math.max(x1, y1); }
    const x = (value) => left + ((value - x0) / (x1 - x0)) * (width - left - right);
    const plotY = (value) => top + ((value - y0) / (y1 - y0)) * (height - top - bottom);
    const y = (value) => (spec.invertY ? plotY(value) : height - bottom - (plotY(value) - top));
    const parts = [];
    const xTicks = niceTicks(x0, x1), yTicks = niceTicks(y0, y1);
    for (const vx of xTicks.ticks) {
      parts.push(`<line x1="${fixed(x(vx))}" y1="${top}" x2="${fixed(x(vx))}" y2="${height - bottom}" stroke="var(--line)"/>`);
      parts.push(`<text x="${fixed(x(vx))}" y="${height - bottom + 17}" text-anchor="middle" font-size="10" fill="var(--muted)">${text(vx, xTicks.digits)}</text>`);
    }
    for (const vy of yTicks.ticks) {
      parts.push(`<line x1="${left}" y1="${fixed(y(vy))}" x2="${width - right}" y2="${fixed(y(vy))}" stroke="var(--line)"/>`);
      parts.push(`<text x="${left - 6}" y="${fixed(y(vy) + 3)}" text-anchor="end" font-size="10" fill="var(--muted)">${text(vy, yTicks.digits)}</text>`);
    }
    if (spec.diagonal) {
      parts.push(`<line x1="${fixed(x(x0))}" y1="${fixed(y(y0))}" x2="${fixed(x(x1))}" y2="${fixed(y(y1))}" stroke="var(--muted)" stroke-dasharray="4 3"/>`);
    } else {
      const mx = mean(points.map((row) => row.x)), my = mean(points.map((row) => row.y));
      parts.push(`<line x1="${fixed(x(mx))}" y1="${top}" x2="${fixed(x(mx))}" y2="${height - bottom}" stroke="var(--muted)" stroke-dasharray="4 3"/>`);
      parts.push(`<line x1="${left}" y1="${fixed(y(my))}" x2="${width - right}" y2="${fixed(y(my))}" stroke="var(--muted)" stroke-dasharray="4 3"/>`);
    }
    parts.push(`<text x="${width - right}" y="${height - 6}" text-anchor="end" font-size="10" font-weight="600" fill="var(--muted)">${escape(spec.xLabel)} →</text>`);
    parts.push(`<text x="${left}" y="12" font-size="10" font-weight="600" fill="var(--muted)">↑ ${escape(spec.yLabel)}</text>`);
    const [topLeft, topRight, bottomLeft, bottomRight] = spec.quadrants;
    const placed = points.map((row) => ({ x: x(row.x) - 6, y: y(row.y) - 6, width: 12, height: 12 }));
    for (const [qx, qy, anchor, words] of [[left + 6, top + 12, "start", topLeft], [width - right - 4, top + 12, "end", topRight],
      [left + 6, height - bottom - 6, "start", bottomLeft], [width - right - 4, height - bottom - 6, "end", bottomRight]]) {
      if (!words) continue;
      parts.push(`<text x="${qx}" y="${qy}" text-anchor="${anchor}" font-size="10" fill="var(--muted)" fill-opacity="0.8">${escape(words)}</text>`);
      const size = words.length * 5.6;
      placed.push({ x: anchor === "start" ? qx : qx - size, y: qy - 9, width: size, height: 11 });
    }
    // Labels stay inside the plot, clear of the points, the corner captions and
    // each other: three distances in eight directions, the nearest free spot
    // first, and the least crowded one when a cluster leaves nothing free.
    const overlap = (box) => placed.reduce((total, other) => total
      + Math.max(0, Math.min(box.x + box.width, other.x + other.width) - Math.max(box.x, other.x))
      * Math.max(0, Math.min(box.y + box.height, other.y + other.height) - Math.max(box.y, other.y)), 0);
    const inside = (box) => box.x >= left && box.x + box.width <= width - right && box.y >= top && box.y + box.height <= height - bottom;
    for (const row of points) {
      const cx = x(row.x), cy = y(row.y), chosen = row.teamId === selected;
      const code = label(names, row.teamId), size = code.length * 6.4 + 2;
      const spots = [8, 15, 24].flatMap((reach) => [[reach, 4, "start"], [-reach, 4, "end"], [-size / 2, -reach + 1, "middle"], [-size / 2, reach + 9, "middle"],
        [reach, -reach + 4, "start"], [reach, reach + 6, "start"], [-reach, -reach + 4, "end"], [-reach, reach + 6, "end"]]);
      const boxOf = ([dx, dy, anchor]) => ({ x: cx + (anchor === "start" ? dx : anchor === "end" ? dx - size : -size / 2), y: cy + dy - 9, width: size, height: 11 });
      const fitting = spots.filter((candidate) => inside(boxOf(candidate)));
      const spot = fitting.find((candidate) => overlap(boxOf(candidate)) === 0)
        || (fitting.length ? fitting : spots).reduce((best, candidate) => (overlap(boxOf(candidate)) < overlap(boxOf(best)) ? candidate : best));
      placed.push(boxOf(spot));
      const tx = spot[2] === "middle" ? cx : cx + spot[0];
      const fill = colorOf ? colorOf(row.teamId) : "var(--statistics-plot-line)";
      parts.push(`<g data-team="${escape(row.teamId)}" class="ta-link"><circle cx="${fixed(cx)}" cy="${fixed(cy)}" r="${chosen ? 7 : 5}" fill="${escape(fill)}" fill-opacity="${chosen ? 1 : 0.85}" stroke="${chosen ? "var(--ink)" : "var(--surface-raised)"}" stroke-width="${chosen ? 2 : 1.5}"/>`
        + `<text x="${fixed(tx)}" y="${fixed(cy + spot[1])}" text-anchor="${spot[2]}" font-size="10" font-weight="${chosen ? 700 : 400}" fill="var(--ink)">${escape(code)}</text>`
        + `<title>${escape(`${fullName(names, row.teamId)} · ${spec.xLabel}: ${text(row.x, spec.xDigits ?? 2)} · ${spec.yLabel}: ${text(row.y, spec.yDigits ?? 2)} (${t("{count} maç", { count: row.matches }, row.matches)})`)}</title></g>`);
    }
    return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${escape(spec.title)}">${parts.join("")}</svg>`;
  }

  // Season figures per team. Each is taken over the matches that record what it
  // needs, and says how many that was.
  function perTeam(played, teamId, need, value) {
    const own = played.filter((match) => match.teamId === teamId && need.every((key) => match[key] !== null));
    return own.length ? { value: value(own), matches: own.length } : { value: null, matches: 0 };
  }
  const sumOf = (list, key) => list.reduce((total, match) => total + match[key], 0);
  const perMatch = (key) => (list) => sumOf(list, key) / list.length;

  // The fixed comparisons, in reading order. Every pair is oriented so its
  // quadrant captions say which corner is good.
  const comparisons = [
    { id: "strength", title: t("Hücum ve savunma gücü"), xLabel: t("Maç başına yenilen xG"), yLabel: t("Maç başına üretilen xG"),
      x: ["xga", perMatch("xga")], y: ["xg", perMatch("xg")], xDigits: 2, yDigits: 2,
      quadrants: [t("Güçlü hücum, sağlam savunma"), t("Güçlü hücum, zayıf savunma"), t("Zayıf hücum, sağlam savunma"), t("Zayıf hücum, zayıf savunma")],
      note: t("Takımın genel gücü: sol üst hem pozisyon üreten hem az pozisyon veren takımlar. Kesikli çizgiler lig ortalaması.") },
    { id: "points", title: t("Puan ve beklenen puan"), xLabel: t("Beklenen puan (xPts)"), yLabel: t("Puan"), diagonal: true, floor: 0,
      x: ["xpts", (list) => sumOf(list, "xpts")], y: ["points", (list) => sumOf(list, "points")], xDigits: 1, yDigits: 0,
      quadrants: [t("Hak ettiğinden fazla puan"), "", "", t("Hak ettiğinden az puan")],
      note: t("Çizginin üstündeki takımların puanı oyunlarından fazla; sıralamaları gerileyebilir. Beklenen puan her maç için Sportmonks’un xG’ye dayalı değeri.") },
    { id: "finishing", title: t("Gol ve xG"), xLabel: "xG", yLabel: t("Atılan gol"), diagonal: true, floor: 0,
      x: ["xg", (list) => sumOf(list, "xg")], y: ["goalsFor", (list) => sumOf(list, "goalsFor")], xDigits: 1, yDigits: 0,
      quadrants: [t("Pozisyonlarından fazla gol"), "", "", t("Pozisyonlarından az gol")],
      note: t("Çizginin üstü bitiricilikte ya da şansta lehine; bu genelde sürmez. Çizginin altındaki takımların hücumcuları ucuz alım adayıdır.") },
    { id: "keeping", title: t("Yenilen gol ve xGA"), xLabel: t("Rakibe verilen xG"), yLabel: t("Yenilen gol"), diagonal: true, floor: 0,
      x: ["xga", (list) => sumOf(list, "xga")], y: ["goalsAgainst", (list) => sumOf(list, "goalsAgainst")], xDigits: 1, yDigits: 0,
      quadrants: [t("Beklenenden fazla yiyor"), "", "", t("Beklenenden az yiyor")],
      note: t("Çizginin altı kaleci ya da şans sayesinde beklenenden az gol yiyen takımlar; gol yememe puanında bu fark kapanabilir.") },
    { id: "shots", title: t("Şut hacmi ve kalitesi"), xLabel: t("Maç başına şut"), yLabel: t("Şut başına xG"),
      x: ["shots", perMatch("shots")], y: ["xg", (list) => sumOf(list, "xg") / sumOf(list, "shots")], need: ["xg", "shots"], xDigits: 1, yDigits: 3,
      quadrants: [t("Az ama kaliteli şut"), t("Çok ve kaliteli şut"), t("Az ve düşük kaliteli şut"), t("Çok ama düşük kaliteli şut")],
      note: t("Sağ üst hem çok hem iyi şut atan takımlar.") },
    { id: "shots-against", title: t("Verilen şut ve kalitesi"), xLabel: t("Maç başına rakip şutu"), yLabel: t("Rakip şutu başına xG"),
      x: ["shotsConceded", perMatch("shotsConceded")], y: ["xga", (list) => sumOf(list, "xga") / sumOf(list, "shotsConceded")], need: ["xga", "shotsConceded"], xDigits: 1, yDigits: 3,
      quadrants: [t("Az ama tehlikeli şut veriyor"), t("Çok ve tehlikeli şut veriyor"), t("Az ve zararsız şut veriyor"), t("Çok ama zararsız şut veriyor")],
      note: t("Savunmanın aynası: sol alt en az ve en zararsız şutu veren takımlar.") },
    { id: "big-chances", title: t("Büyük fırsatlar"), xLabel: t("Maç başına verilen büyük fırsat"), yLabel: t("Maç başına yaratılan büyük fırsat"),
      x: ["bigChancesConceded", perMatch("bigChancesConceded")], y: ["bigChances", perMatch("bigChances")], xDigits: 1, yDigits: 1,
      quadrants: [t("Çok yaratıyor, az veriyor"), t("Çok yaratıyor, çok veriyor"), t("Az yaratıyor, az veriyor"), t("Az yaratıyor, çok veriyor")],
      note: t("Net gol pozisyonları, iki yönde de. Sol üst en iyisi.") },
    { id: "possession", title: t("Topa sahip olma ve tehlike"), xLabel: t("Ortalama topa sahip olma (%)"), yLabel: t("Maç başına tehlikeli atak"),
      x: ["possession", perMatch("possession")], y: ["dangerous", perMatch("dangerous")], xDigits: 0, yDigits: 0,
      quadrants: [t("Az topla tehlikeli"), t("Topa sahip ve tehlikeli"), t("Az top, az tehlike"), t("Topa sahip ama kısır")],
      note: t("Topu tutan mı, onu tehlikeye çeviren mi: sağ alt pas yapan ama tehlike üretemeyen takımlar.") },
    { id: "pressing", title: t("Pres ve topa sahip olma"), xLabel: t("Ortalama topa sahip olma (%)"), yLabel: t("Pres yoğunluğu (rakip pası / savunma aksiyonu)"),
      x: ["possession", perMatch("possession")], y: ["rivalPasses", (list) => sumOf(list, "rivalPasses") / (sumOf(list, "tackles") + sumOf(list, "interceptions") + sumOf(list, "fouls"))],
      need: ["possession", "rivalPasses", "tackles", "interceptions", "fouls"], invertY: true, xDigits: 0, yDigits: 1,
      quadrants: [t("Az topla yoğun pres"), t("Topa sahip, yoğun pres"), t("Geride bekliyor"), t("Topa sahip, pres yapmıyor")],
      note: t("Pres, rakibin yaptığı pasın müdahale, top kesme ve fauller toplamına oranı (PPDA’ya yakın); düşük değer yoğun pres demek, bu yüzden dikey eksen ters çevrildi: yukarısı daha yoğun pres. Saha bölgesi verisi olmadığı için tüm sahayı kapsar.") },
    { id: "fantasy", title: t("Fantezi puanı ve xG"), xLabel: t("Maç başına üretilen xG"), yLabel: t("Maç başına takım fantezi puanı"),
      x: ["xg", perMatch("xg")], y: ["fantasy", perMatch("fantasy")], xDigits: 2, yDigits: 0,
      quadrants: [t("Az pozisyon, çok FP"), t("Çok pozisyon, çok FP"), t("Az pozisyon, az FP"), t("Çok pozisyon, az FP")],
      note: t("Takımın fantezi puanı pozisyonlarıyla destekleniyor mu: sol üst puanı pozisyonlarından fazla (gerileyebilir), sağ alt tersine (yükselebilir).") },
  ];
  function comparisonRows(spec, played, order) {
    const need = spec.need || [...new Set([spec.x[0], spec.y[0]])];
    return order.map((teamId) => {
      const xs = perTeam(played, teamId, need, spec.x[1]), ys = perTeam(played, teamId, need, spec.y[1]);
      return { teamId, x: xs.value, y: ys.value, matches: xs.matches };
    }).filter((row) => Number.isFinite(row.x) && Number.isFinite(row.y));
  }
  // A team's fantasy points per finished match, from the published ledger,
  // attached to its matches so the fantasy comparison reads like the rest.
  function withFantasy(played, ledgerRows) {
    const points = new Map();
    for (const row of ledgerRows) {
      const key = `${row.fixture_id}|${row.team_id}`;
      points.set(key, (points.get(key) || 0) + (num(row.points_total) ?? 0));
    }
    return played.map((match) => ({ ...match, fantasy: points.has(`${match.fixtureId}|${match.teamId}`) ? points.get(`${match.fixtureId}|${match.teamId}`) : null }));
  }
  return { buckets, matches, asOf, xgGrid, fantasyByRole, fantasyChart, luck, luckChart,
    formGrid, bucketOf, matchClock, goalTiming, timingGrid, momentum, momentumGrid, niceTicks, scatter, comparisons, comparisonRows,
    withFantasy };
})();

if (typeof module !== "undefined" && module.exports) module.exports = { TeamAnalysis };
