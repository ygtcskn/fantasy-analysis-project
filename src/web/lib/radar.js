"use strict";

// Spider plots for the İstatistikler page, as three pure modules - no DOM, no
// requests - so Node can test them directly:
//   RadarScoring    season totals, per-90 rates, peer populations, percentiles
//   RadarAttributes first-principal-component attributes over those rates
//   RadarTeams      the team catalogue and team-match rows for the same code
//   RadarChart      the SVG wheel
// radar-page.js wires them to the page; README.md holds the methodology.

// Pure scoring pipeline. No DOM, provider requests, exports, or hidden fallbacks.
const RadarScoring = (() => {
  const defaults = Object.freeze({ minimumMinutes: 900, minimumPeers: 2, zeroShareThreshold: 0.7, shrinkage: true });
  // Only supplied role names are mapped. Broad roles remain broad; numeric
  // detailed_position_id values need a reviewed provider mapping before use.
  const positionGroups = {
    GK: ["goalkeeper", "keeper", "gk", "kl"],
    CB: ["centre-back", "center-back", "cb"],
    FB: ["full-back", "wing-back", "left-back", "right-back", "lb", "rb", "lwb", "rwb"],
    DM: ["defensive midfielder", "dm"], CM: ["central midfielder", "cm"],
    AM: ["attacking midfielder", "am"], W: ["winger", "left winger", "right winger", "lw", "rw"],
    FW: ["attacker", "forward", "striker", "centre-forward", "center-forward", "st", "cf", "for"],
    DEF: ["defender", "def", "defans"], MID: ["midfielder", "os", "orta saha"],
  };
  const positionLabels = { GK: "Kaleci", CB: "Stoper", FB: "Bek / kanat bek",
    DM: "Defansif orta saha", CM: "Merkez orta saha", AM: "Ofansif orta saha",
    W: "Kanat", FW: "Forvet", DEF: "Defans (genel)", MID: "Orta saha (genel)", TEAM: "Takım",
    ALL: "Tüm saha oyuncuları" };
  const categories = { attacking: "Hücum", creation: "Üretim", progression: "İlerleme",
    possession: "Top kullanımı", defending: "Savunma", duels: "Mücadele",
    goalkeeping: "Kalecilik", discipline: "Hata ve disiplin", attribute: "Genel nitelik" };
  const outfield = ["CB", "FB", "DM", "CM", "AM", "W", "FW", "DEF", "MID"];
  const allPositions = ["GK", ...outfield];
  const metrics = {};
  function rate(id, label, column, category, direction = "higher_better", zeroHeavy = "auto", positions = outfield) {
    metrics[id] = { id, label, sourceColumn: column, transform: "per90", direction,
      zeroHeavy, category, positions };
  }
  // One axis from several columns of the same kind. Every part must be known
  // for the match to count, so a covered blank is a zero but an uncovered match
  // still leaves the whole axis short of full coverage.
  function combined(id, label, columns, category, positions = outfield) {
    metrics[id] = { id, label, sourceColumn: columns[0], sumColumns: columns, transform: "per90",
      direction: "higher_better", zeroHeavy: "auto", category, positions };
  }
  function percentage(id, label, made, attempted, minimumAttempts, category, positions = outfield) {
    metrics[id] = { id, label, sourceColumn: made, attemptsColumn: attempted,
      minimumAttempts, transform: "percentage", direction: "higher_better",
      zeroHeavy: false, category, positions };
  }
  combined("goal_contribution", "Gol katkısı", ["goals", "assists"], "attacking");
  rate("goals", "Gol", "goals", "attacking");
  rate("assists", "Asist", "assists", "creation");
  rate("xg", "xG", "xg_expected_goals", "attacking", "higher_better", false);
  metrics.xg.fallbackColumn = "expected_goals";
  rate("shots", "Şut", "shots_total", "attacking");
  rate("shots_on_target", "İsabetli şut", "shots_on_target", "attacking");
  rate("big_chances", "Büyük fırsat", "big_chances_created", "creation");
  rate("key_passes", "Kilit pas", "key_passes", "creation");
  rate("chances", "Fırsat üretimi", "chances_created", "creation");
  rate("accurate_crosses", "İsabetli orta", "accurate_crosses", "creation");
  rate("final_third", "Son üçte bir pası", "passes_in_final_third", "progression", "context");
  rate("dribbles", "Başarılı dribling", "successful_dribbles", "progression");
  rate("fouls_drawn", "Kazanılan faul", "fouls_drawn", "possession");
  rate("touches", "Dokunuş", "touches", "possession", "context", false);
  rate("passes", "Pas", "passes", "possession", "context", false, allPositions);
  rate("long_balls", "Uzun top", "long_balls", "possession", "context", "auto", allPositions);
  percentage("pass_accuracy", "Pas isabeti %", "accurate_passes", "passes", 100, "possession", allPositions);
  percentage("long_accuracy", "Uzun pas isabeti %", "long_balls_won", "long_balls", 30, "possession", allPositions);
  rate("possession_lost", "Top koruma", "possession_lost", "possession", "lower_better", false);
  rate("dispossessed", "Top kaptırmama", "dispossessed", "possession", "lower_better");
  rate("tackles", "Müdahale", "tackles", "defending", "context");
  rate("interceptions", "Top kesme", "interceptions", "defending", "context");
  rate("ball_recovery", "Top kazanma", "ball_recovery", "defending", "context");
  rate("blocks", "Blok", "blocked_shots", "defending", "context");
  rate("clearances", "Uzaklaştırma", "clearances", "defending", "context");
  rate("aerials_won", "Kazanılan hava topu", "aerials_won", "duels");
  rate("duels_won", "Kazanılan ikili mücadele", "duels_won", "duels");
  rate("duels", "İkili mücadele", "total_duels", "duels", "context");
  percentage("duel_pct", "İkili mücadele %", "duels_won", "total_duels", 30, "duels");
  rate("saves", "Kurtarış", "saves", "goalkeeping", "context", false, ["GK"]);
  rate("saves_inside_box", "Ceza sahası kurtarışı", "saves_inside_box", "goalkeeping", "context", false, ["GK"]);
  rate("claims", "Yüksek top kontrolü", "good_high_claim", "goalkeeping", "context", "auto", ["GK"]);
  rate("punches", "Yumruklama", "punches", "goalkeeping", "context", "auto", ["GK"]);
  rate("conceded", "Az gol yeme", "goalkeeper_goals_conceded", "goalkeeping", "lower_better", false, ["GK"]);
  rate("errors_goal", "Gol hatasından kaçınma", "error_lead_to_goal", "discipline", "lower_better", "auto", allPositions);
  rate("errors_shot", "Şut hatasından kaçınma", "error_lead_to_shot", "discipline", "lower_better", "auto", allPositions);
  rate("fouls", "Faulden kaçınma", "fouls", "discipline", "lower_better", "auto", allPositions);
  rate("yellowcards", "Sarı karttan kaçınma", "yellowcards", "discipline", "lower_better", "auto", allPositions);
  rate("redcards", "Direkt kırmızıdan kaçınma", "redcards", "discipline", "lower_better", "auto", allPositions);
  for (const [id, label] of Object.entries({ possession_lost: "Top kaybı", dispossessed: "Top kaptırma",
    conceded: "Yenilen gol", errors_goal: "Gole yol açan hata", errors_shot: "Şuta yol açan hata",
    fouls: "Yapılan faul", yellowcards: "Sarı kart", redcards: "Direkt kırmızı kart",
    goal_contribution: "Gol + asist", pass_accuracy: "İsabetli pas",
    long_accuracy: "İsabetli uzun pas", duel_pct: "Kazanılan ikili mücadele" })) metrics[id].rawLabel = label;

  // One fixed set of variables per role, in the order they sit on the circle:
  // finishing, then creation and passing, then defending and duels. The chart no
  // longer switches between metric "types"; the whole statistical picture is on
  // the single wheel, the way published player pizza charts present it.
  //
  // Three variables from those charts have no Sportmonks equivalent and are not
  // substituted silently: opposition penalty-area touches, passes received and
  // any positioning composite. Two more exist but are not trustworthy here -
  // `aerials` is blank on 1828 covered rows that do record aerials won, so an
  // aerial win rate would be computed against a denominator the provider
  // omitted; aerial duels appear as won-per-90 instead.
  const profiles = {
    GK: ["saves", "saves_inside_box", "claims", "punches", "conceded",
      "passes", "pass_accuracy", "long_balls", "long_accuracy", "errors_goal"],
    outfield: ["goal_contribution", "xg", "shots", "shots_on_target", "dribbles", "big_chances",
      "key_passes", "final_third", "passes", "pass_accuracy", "touches",
      "tackles", "interceptions", "ball_recovery", "aerials_won", "duel_pct"],
  };
  function axes(position) {
    return (profiles[position] || profiles.outfield)
      .map((id) => metrics[id]).filter((metric) => metric?.positions.includes(position));
  }
  function numeric(value) {
    if (value === null || value === undefined || typeof value === "boolean" || String(value).trim() === "") return null;
    const result = Number(value);
    return Number.isFinite(result) ? result : null;
  }
  function nonnegative(value) { const result = numeric(value); return result !== null && result >= 0 ? result : null; }
  function groupFor(value, groups = positionGroups) {
    const normalized = String(value || "").trim().toLowerCase();
    const found = Object.entries(groups).filter(([key, aliases]) => key.toLowerCase() === normalized || aliases.includes(normalized));
    return found.length === 1 ? found[0][0] : null;
  }
  function positionFor(rows, fallback = [], groups = positionGroups) {
    const weights = new Map();
    for (const row of rows) {
      const group = groupFor(row.position, groups), minutes = nonnegative(row.minutes_played);
      if (group && minutes > 0) weights.set(group, (weights.get(group) || 0) + minutes);
    }
    const ordered = [...weights].sort((a, b) => b[1] - a[1]);
    if (ordered.length) return ordered[0][1] === ordered[1]?.[1] ? null : ordered[0][0];
    const supplied = [...new Set([...fallback].map((value) => groupFor(value, groups)).filter(Boolean))];
    return supplied.length === 1 ? supplied[0] : null;
  }
  function fixtureScope(fixture) {
    if (!fixture?.season_id || !fixture?.league_id) return null;
    return { key: `${fixture.season_id}|${fixture.league_id}`,
      seasonId: String(fixture.season_id), competitionId: String(fixture.league_id) };
  }
  function scopes(fixtures) {
    return [...new Map(fixtures.map(fixtureScope).filter(Boolean).map((scope) => [scope.key, scope])).values()];
  }
  // Earlier seasons are compared at the same point of the season. Seven rounds
  // in, a current per-90 rests on 330-630 minutes while a full earlier season
  // rests on 2000+, so the noisier current rates crowded both ends of the
  // pooled scale. Cutting every earlier season to the rounds the served season
  // has reached compares like with like; once the served season is complete
  // there is no cut.
  function roundNumber(fixture) {
    const value = Number(String(fixture?.["round.name"] ?? "").trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  // The highest round with a finished fixture, or null - no cut - when every
  // fixture is finished, none is, or rounds are not numbered.
  function playedRounds(fixtures) {
    const scoped = fixtures.filter((fixture) => fixtureScope(fixture));
    if (!scoped.length || scoped.every(finished)) return null;
    const rounds = scoped.filter(finished).map(roundNumber);
    return rounds.length && rounds.every((round) => round !== null) ? Math.max(...rounds) : null;
  }
  function throughRound(fixtures, rounds) {
    if (!rounds) return fixtures;
    return fixtures.filter((fixture) => { const round = roundNumber(fixture); return round !== null && round <= rounds; });
  }
  // Sportmonks omits minutes_played for an unused substitute exactly as it
  // omits every other zero: of 19,270 blank-minute rows across 2021-2027, all
  // but 36 were not started and carry no statistic or rating. Those are bench
  // appearances and are dropped like an explicit zero; left in, one unused
  // substitution made a whole season's minutes "unknown" and removed the
  // player from every reference. A blank-minute row that does carry match
  // statistics, a rating or a start is a real appearance with unknown minutes,
  // and still makes the season's minutes uncertain.
  function unplayed(row) {
    const minutes = numeric(row.minutes_played);
    if (minutes === 0) return true;
    if (minutes !== null || !blank(row.minutes_played)) return false;
    return !covered(row) && blank(row.rating) && !(numeric(row.started) > 0);
  }
  // Sportmonks publishes a lineup before kickoff, so an unplayed fixture can
  // carry started=1 rows with blank minutes. Read as appearances, one upcoming
  // round made every starter's minutes unknown and emptied the reference. A
  // fixture without any state is kept, as before.
  const finishedStates = new Set(["FT", "AET", "FT_PEN", "AWARDED", "WO"]);
  function finished(fixture) {
    const state = String(fixture?.["state.developer_name"] || fixture?.state || "").trim().toUpperCase();
    return !state || finishedStates.has(state);
  }
  function preparePlayers(players, fixtures, scope, groups = positionGroups) {
    const byFixture = new Map(fixtures.map((fixture) => [fixture.fixture_id, fixture]));
    return players.map((player) => {
      const rows = player.matches.filter((row) => {
        const fixture = byFixture.get(row.fixture_id);
        return scope && fixtureScope(fixture)?.key === scope.key && finished(fixture)
          && (!row.season_id || String(row.season_id) === scope.seasonId)
          && (!row.league_id || String(row.league_id) === scope.competitionId)
          && !unplayed(row);
      });
      const minutes = rows.map((row) => nonnegative(row.minutes_played));
      return { id: player.id, name: player.name, rows, scope,
        minutes: minutes.some((value) => value === null) ? null : minutes.reduce((a, b) => a + b, 0),
        position: positionFor(rows, player.squadPositions || [], groups) };
    });
  }
  // The provider never writes a literal zero in a counting column. In the
  // current season export not one row of goals, shots, tackles, aerials or red
  // cards contains "0": every zero arrives as an empty cell, and 92% of rows
  // leave `goals` blank. A blank therefore means the player did none of it -
  // but only on a match the statistics feed actually covered. 53 of 9438 played
  // rows in 2025-2026 carry no statistics at all, and reading those as a full
  // match of zeroes would understate every rate the player has.
  const coverageColumns = ["touches", "passes", "total_duels", "shots_total", "fouls", "possession_lost"];
  function blank(value) { return value === undefined || value === null || String(value).trim() === ""; }
  function omitted(row, column) { return column in row && blank(row[column]); }
  function covered(row) { return coverageColumns.some((column) => !blank(row[column])); }
  function columnValue(row, column, allowZero) {
    const value = nonnegative(row[column]);
    if (value !== null) return value;
    // A supplied but invalid value stays invalid; only an omission reads as none.
    return allowZero && omitted(row, column) && covered(row) ? 0 : null;
  }
  function matchValue(row, metric) {
    const allowZero = metric.blankIsZero !== false;
    if (metric.sumColumns) {
      let total = 0;
      for (const column of metric.sumColumns) {
        const part = columnValue(row, column, allowZero);
        if (part === null) return null;
        total += part;
      }
      return total;
    }
    const direct = nonnegative(row[metric.sourceColumn]);
    if (direct !== null) return direct;
    // A second feed for the same quantity outranks the omitted-zero reading, so
    // a match with expected_goals but no xg_expected_goals keeps its value.
    if (metric.fallbackColumn && omitted(row, metric.sourceColumn)) {
      const fallback = columnValue(row, metric.fallbackColumn, allowZero);
      if (fallback !== null) return fallback;
    }
    return columnValue(row, metric.sourceColumn, allowZero);
  }
  // A ratio needs enough attempts to mean anything, but "enough" cannot be a
  // full season's worth in September: a striker reaches 58 passes in four
  // rounds, not 100, and a defender 26 duels rather than 30. The catalogue
  // states each requirement for a ten-match sample; it is scaled down with the
  // reference's own minute bar and never falls below the twenty attempts a
  // percentage needs before it is worth plotting at all.
  const attemptReferenceMinutes = 900;
  const attemptFloor = 20;
  function requiredAttempts(metric, config = defaults) {
    if (metric.transform !== "percentage") return 0;
    const bar = Number.isFinite(config?.minimumMinutes) ? config.minimumMinutes : attemptReferenceMinutes;
    return Math.max(Math.min(metric.minimumAttempts, attemptFloor),
      Math.round(metric.minimumAttempts * Math.min(1, bar / attemptReferenceMinutes)));
  }
  // Everything about a season total that does not depend on the scoring
  // controls: the summed events, attempts and match coverage. Earlier seasons
  // are reduced to these once when they load, so their raw rows can be dropped
  // while the minute bar and attempt threshold still apply live.
  function tally(player, metric) {
    const stored = player.tallies?.get(metric.id);
    if (stored) return stored;
    const result = { rawValue: null, attempts: null, attemptsSupplied: null,
      supplied: 0, records: player.rows.length, status: "missing" };
    if (!player.rows.length) return result;
    const supplied = player.rows.map((row) => matchValue(row, metric));
    const valid = supplied.filter((value) => value !== null);
    result.supplied = valid.length;
    result.rawValue = valid.length ? valid.reduce((a, b) => a + b, 0) : null;
    if (metric.transform === "percentage") {
      const attempts = player.rows.map((row, index) => {
        const value = nonnegative(row[metric.attemptsColumn]);
        if (value !== null) return value;
        // The denominator is sometimes omitted on rows whose numerator is not:
        // 1828 of 9385 covered rows record aerials won with no aerials total.
        // Calling those zero attempts would credit duels the player contested,
        // so only a blank on both sides counts as nothing attempted.
        return supplied[index] === 0
          ? columnValue(row, metric.attemptsColumn, metric.blankIsZero !== false) : null;
      });
      const known = attempts.filter((value) => value !== null);
      result.attemptsSupplied = known.length;
      result.attempts = known.length ? known.reduce((a, b) => a + b, 0) : null;
      if (valid.length !== player.rows.length || known.length !== player.rows.length) {
        result.status = valid.length || known.length ? "partial_coverage" : "missing";
        return result;
      }
      if (supplied.some((value, index) => value > attempts[index])) {
        result.status = "invalid_ratio"; return result;
      }
    } else if (valid.length !== player.rows.length) {
      result.status = valid.length ? "partial_coverage" : "missing"; return result;
    }
    // The match-to-match sums the small-sample adjustment measures noise from:
    // events against minutes, or successes against attempts.
    if (metric.transform === "per90" || metric.transform === "percentage") {
      const exposure = (row, index) => (metric.transform === "percentage"
        ? nonnegative(row[metric.attemptsColumn]) ?? (supplied[index] === 0 ? 0 : null)
        : nonnegative(row.minutes_played));
      const pairs = player.rows.map((row, index) => [supplied[index], exposure(row, index)])
        .filter(([value, weight]) => value !== null && weight > 0);
      if (pairs.length === player.rows.filter((row, index) => exposure(row, index) !== 0).length) {
        result.moments = pairs.reduce((sums, [value, weight]) => ({ n: sums.n + 1, sx: sums.sx + value,
          sm: sums.sm + weight, sx2: sums.sx2 + value * value, sxm: sums.sxm + value * weight,
          sm2: sums.sm2 + weight * weight }), { n: 0, sx: 0, sm: 0, sx2: 0, sxm: 0, sm2: 0 });
      }
    }
    result.status = "counted";
    return result;
  }
  // `required` defaults to the scaled attempt minimum. Where a small-sample
  // prior exists, adjusted() passes 1 instead: the prior already discounts a
  // 1-of-1 ratio to almost the group mean, so a hard minimum would only blank
  // low-volume passers such as strikers.
  function observation(player, metric, config = defaults, required = requiredAttempts(metric, config)) {
    const counted = tally(player, metric);
    const result = { ...counted, value: null, minutes: player.minutes, required };
    if (counted.status !== "counted") return result;
    if (metric.transform === "percentage") {
      if (!(result.attempts > 0)) { result.status = "no_attempts"; return result; }
      if (result.attempts < result.required) {
        result.status = "insufficient_attempts"; return result;
      }
      result.value = result.rawValue / result.attempts * 100;
    } else {
      if (metric.transform === "per90" && !(player.minutes > 0)) {
        result.status = "invalid_minutes"; return result;
      }
      // A "mean" axis averages a per-match figure that is already a share,
      // such as a team's possession; it is never summed.
      result.value = metric.transform === "per90" ? result.rawValue / player.minutes * 90
        : metric.transform === "mean" ? result.rawValue / result.records : result.rawValue;
    }
    if (!Number.isFinite(result.value)) { result.value = null; result.status = "invalid_value"; return result; }
    result.status = "available";
    return result;
  }
  function settings(options = {}) {
    const result = { ...defaults, ...options };
    for (const key of ["minimumMinutes", "minimumPeers", "zeroShareThreshold"]) {
      if (!Number.isFinite(result[key])) throw new Error(`Invalid radar setting: ${key}`);
    }
    if (result.minimumMinutes < 0 || result.minimumPeers < 2 || !Number.isInteger(result.minimumPeers)
      || result.zeroShareThreshold < 0 || result.zeroShareThreshold > 1) throw new Error("Invalid radar settings");
    return result;
  }
  // Mid-rank percentile: (players below + half of those tied) / N. The unique
  // leader of 20 scores 97.5 rather than 100 and the last 2.5 rather than 0:
  // being best of a finite group is evidence of being very good, not of being
  // unbeatable, and a larger group earns a score closer to the edge. A target
  // outside the population, such as a short sample, is placed where it would
  // fall as one more observation, (below + 0.5) / (N + 1), without being added
  // to the population. The two forms stay monotonic with each other.
  function percentile(value, reference) {
    if (!Number.isFinite(value)) return null;
    const values = reference.filter(Number.isFinite);
    if (!values.length) return null;
    const below = values.filter((other) => other < value).length;
    const equal = values.filter((other) => other === value).length;
    return equal ? (below + equal / 2) / values.length * 100 : (below + 0.5) / (values.length + 1) * 100;
  }
  function distribution(reference, metric, options = {}) {
    const config = settings(options), values = reference.filter((value) => Number.isFinite(value) && value >= 0);
    const zeroShare = values.length ? values.filter((value) => value === 0).length / values.length : null;
    const zeroHeavy = metric.zeroHeavy === true || (metric.zeroHeavy !== false && zeroShare >= config.zeroShareThreshold);
    return { values, config, zeroShare, zeroApplied: zeroHeavy,
      positiveN: values.filter((value) => value > 0).length, sampleSize: values.length };
  }
  // One scoring rule. On a zero-heavy axis - at least 70% of peers recorded
  // none of the event - an observed zero sits at the centre and positive values
  // are ranked among the positive peers only; everywhere else it is the plain
  // mid-rank percentile against every peer.
  function score(value, reference, metric, options = {}) {
    const basis = distribution(reference, metric, options), { values, config } = basis;
    const result = { ...basis, score: null, status: "available" };
    if (!Number.isFinite(value) || value < 0) return { ...result, status: "missing" };
    if (values.length < config.minimumPeers) return { ...result, status: "insufficient_peers" };
    let ranked;
    if (basis.zeroApplied) {
      if (value === 0) ranked = 0;
      else {
        ranked = percentile(value, values.filter((other) => other > 0));
        if (ranked === null) return { ...result, status: "no_positive_peers" };
      }
    } else ranked = percentile(value, values);
    if (Number.isNaN(ranked)) return { ...result, status: "invalid_value" };
    if (metric.direction === "lower_better") ranked = 100 - ranked;
    result.score = Math.max(0, Math.min(100, ranked));
    return result;
  }
  // Peers come from the target's own season and competition, plus - when the
  // page supplies them - earlier seasons of the same competition, each reduced
  // to one season tally per player. Every peer passes the same role and minute
  // bar; the target's plotted values never leave its own season.
  function createReference(players, target, selectedAxes, options = {}, pool = []) {
    const config = settings(options);
    // A group is one role, or - with `options.positions` - several pooled
    // under one label, such as every outfield role.
    const positions = config.positions || [target.position];
    const eligible = (player) => target.position && positions.includes(player.position)
      && Number.isFinite(player.minutes) && player.minutes > 0 && player.minutes >= config.minimumMinutes;
    const current = players.filter((player) => eligible(player)
      && player.scope?.key && player.scope.key === target.scope?.key);
    const earlier = pool.filter((player) => eligible(player)
      && player.scope?.competitionId && player.scope.competitionId === target.scope?.competitionId
      && player.scope.seasonId !== target.scope?.seasonId);
    const peers = [...current, ...earlier];
    const reference = { config, position: target.position, positions, scope: target.scope, peers, peerCount: peers.length,
      seasonPeers: current.length, historyPeers: earlier.length,
      historySeasons: [...new Set(earlier.map((player) => player.season))].sort(), priors: new Map() };
    reference.metrics = new Map(selectedAxes.map((metric) => [metric.id,
      peers.map((player) => adjusted(player, metric, reference).value).filter(Number.isFinite)]));
    return reference;
  }
  // Small samples are pulled toward their group (empirical Bayes). The spread
  // of the peers' observed rates is true differences plus sampling noise. The
  // noise is measured, not assumed: each peer's own match-to-match variation
  // around his season rate (a ratio estimator over his matches, kept in the
  // season tally so earlier seasons carry it too). That is what makes xG -
  // not a count, and far steadier than a Poisson count of the same mean - and
  // pass volume - steadier still, but with team-driven swings - come out
  // right. A peer with fewer than two matches falls back to the counting
  // model: Poisson for a per-90, binomial for a percentage. What is left is
  // the true spread, and the prior weight is how much evidence the group
  // average is worth - the noise per minute of evidence over the true spread:
  //   adjusted = (events + mean x weight) / (minutes + weight) x 90,
  // with attempts in place of minutes for a percentage. Weight is small where
  // players really differ and large where most of the spread is luck. A
  // metric whose spread is all noise gets the cap: thirty full matches, or ten
  // times the ten-match attempt requirement. Fewer than ten valid peers, or a
  // group mean of zero, leaves the observed value unchanged.
  const shrinkage = Object.freeze({ minimumPeers: 10, maximumMinutes: 2700, attemptMultiple: 10 });
  function sampleVariance(moments) {
    if (!moments || moments.n < 2 || !(moments.sm > 0)) return null;
    const rate = moments.sx / moments.sm;
    const residual = moments.sx2 - 2 * rate * moments.sxm + rate * rate * moments.sm2;
    return Math.max(0, residual) / (moments.sm * moments.sm) * moments.n / (moments.n - 1);
  }
  function estimatePrior(metric, seen) {
    const percentage = metric.transform === "percentage";
    if (!percentage && metric.transform !== "per90") return null;
    const rows = seen.map((entry) => ({ events: entry.rawValue, exposure: percentage ? entry.attempts : entry.minutes,
      variance: sampleVariance(entry.moments) }))
      .filter((row) => Number.isFinite(row.events) && row.events >= 0 && row.exposure > 0);
    if (rows.length < shrinkage.minimumPeers) return null;
    const mean = rows.reduce((sum, row) => sum + row.events, 0) / rows.reduce((sum, row) => sum + row.exposure, 0);
    if (!(mean > 0) || (percentage && !(mean < 1))) return null;
    const unit = percentage ? mean * (1 - mean) : mean;
    const spread = rows.reduce((sum, row) => sum + (row.events / row.exposure - mean) ** 2, 0) / rows.length;
    const variance = (row) => row.variance ?? unit / row.exposure;
    const noise = rows.reduce((sum, row) => sum + variance(row), 0) / rows.length;
    // Noise of one minute (or attempt): a rate over m minutes varies by about
    // dispersion / m. Poisson would make it the mean; measured, it is not.
    const dispersion = rows.reduce((sum, row) => sum + variance(row) * row.exposure, 0) / rows.length;
    const signal = spread - noise;
    const cap = percentage ? metric.minimumAttempts * shrinkage.attemptMultiple : shrinkage.maximumMinutes;
    const weight = signal > 0 ? Math.min(cap, dispersion / signal) : cap;
    return { mean, weight, signal, peers: rows.length, unit: percentage ? "attempts" : "minutes" };
  }
  function priorFor(reference, metric) {
    if (!reference.priors) reference.priors = new Map();
    if (!reference.priors.has(metric.id)) {
      reference.priors.set(metric.id, estimatePrior(metric, reference.peers
        .map((peer) => observation(peer, metric, reference.config)).filter((entry) => entry.status === "available")));
    }
    return reference.priors.get(metric.id);
  }
  // The observation with the group prior applied. `observedValue` keeps the
  // raw rate for the details; `reliability` is the share of the adjusted value
  // that is the player's own evidence.
  // The prior is fitted on peers that meet the full attempt minimum, so it is
  // stable; it is then applied to every player with at least one attempt.
  function adjusted(player, metric, reference) {
    const prior = reference.config.shrinkage === false ? null : priorFor(reference, metric);
    const observed = observation(player, metric, reference.config,
      prior && metric.transform === "percentage" ? 1 : undefined);
    if (!prior || observed.status !== "available") return { ...observed, observedValue: observed.value, prior: null, reliability: null };
    const percentage = metric.transform === "percentage";
    const exposure = percentage ? observed.attempts : observed.minutes;
    const value = (observed.rawValue + prior.mean * prior.weight) / (exposure + prior.weight) * (percentage ? 100 : 90);
    return { ...observed, observedValue: observed.value, value, prior, reliability: exposure / (exposure + prior.weight) };
  }
  function inReferenceGroup(player, reference) {
    return (reference.positions || [reference.position]).includes(player.position);
  }
  // `options.guest` ranks a player from another role against this reference -
  // the comparison overlay, where both players share the primary's scale. The
  // season and competition must still match.
  function evaluate(player, metric, reference, options = {}) {
    const observed = adjusted(player, metric, reference);
    const ranked = score(observed.value, reference.metrics.get(metric.id) || [], metric, reference.config);
    const inGroup = inReferenceGroup(player, reference);
    const sameGroup = (inGroup || Boolean(options.guest))
      && player.scope?.key === reference.scope?.key;
    return { ...observed, metric, score: sameGroup ? ranked.score : null,
      guest: Boolean(options.guest) && !inGroup,
      status: !sameGroup ? "incompatible_group" : observed.status === "available" ? ranked.status : observed.status,
      sampleSize: ranked.sampleSize, positiveN: ranked.positiveN, zeroShare: ranked.zeroShare,
      zeroApplied: ranked.zeroApplied, minimumMinutes: reference.config.minimumMinutes, peerCount: reference.peerCount,
      position: reference.position, scope: reference.scope,
      smallSample: !(player.minutes > 0) || player.minutes < reference.config.minimumMinutes };
  }
  return { defaults, positionGroups, positionLabels, categories, metrics, profiles, axes,
    numeric, nonnegative, groupFor, positionFor, fixtureScope, scopes, finished, roundNumber, playedRounds,
    throughRound, preparePlayers, covered, unplayed, matchValue, requiredAttempts, tally, observation, settings,
    percentile, distribution, score, createReference, inReferenceGroup, shrinkage, sampleVariance, estimatePrior, priorFor, adjusted, evaluate };
})();


// General attributes, one per quality rather than one per column. Each is the
// first principal component of a group of related per-90 rates, so measures
// that repeat each other count once: shots, shots on target and xG say much the
// same thing about a striker, and averaging their percentiles would treat one
// piece of evidence as three.
//
// The component is fitted on the same peer population the metric radar ranks
// against, so both charts share a season, competition, role and minute bar.
// Members are direction-adjusted first (fewer fouls is more discipline), the
// component is oriented so that higher always means more of the quality, and a
// player's projection is then ranked against the peers' projections with the
// same mid-rank percentile as every other axis.
//
// A member that moves against the rest of its group is measuring something
// else, so it leaves the axis and is named beside the chart: see fit() below.
// "Tactic" and "positioning" have no Sportmonks column and are not invented
// here; what the data supports is the six outfield qualities below, and five
// for a goalkeeper.
const RadarAttributes = (() => {
  const groups = {
    outfield: [
      { id: "attack", label: "Hücum", members: ["goals", "xg", "shots", "shots_on_target"] },
      { id: "creation", label: "Üretim", members: ["assists", "key_passes", "chances", "big_chances", "accurate_crosses"] },
      { id: "ball", label: "Top kullanımı", members: ["passes", "touches", "final_third", "dribbles", "possession_lost", "dispossessed"] },
      { id: "defence", label: "Savunma", members: ["tackles", "interceptions", "blocks", "clearances", "ball_recovery"] },
      { id: "aerial", label: "Hava ve mücadele", members: ["aerials_won", "duels_won", "duels", "fouls_drawn"] },
      { id: "discipline", label: "Disiplin", members: ["fouls", "yellowcards", "redcards", "errors_goal", "errors_shot"] },
    ],
    GK: [
      { id: "shotstopping", label: "Kurtarış", members: ["saves", "saves_inside_box"] },
      { id: "box", label: "Ceza sahası", members: ["claims", "punches"] },
      { id: "conceding", label: "Az gol yeme", members: ["conceded"] },
      { id: "distribution", label: "Ayakla oyun", members: ["passes", "long_balls", "touches"] },
      { id: "discipline", label: "Disiplin", members: ["errors_goal", "errors_shot", "yellowcards"] },
    ],
  };
  // Groups name their members by id in a catalogue - the player metrics here,
  // the team metrics in RadarTeams - and keep only those valid for the group.
  function build(list, catalogue, position) {
    return list.map((group) => {
      const members = group.members.map((id) => catalogue[id])
        .filter((metric) => metric?.positions.includes(position));
      return { ...group, members, transform: "pca", direction: "higher_better", category: "attribute" };
    }).filter((group) => group.members.length);
  }
  function forPosition(position) {
    return build(groups[position] || groups.outfield, RadarScoring.metrics, position);
  }
  const sign = (metric) => (metric.direction === "lower_better" ? -1 : 1);
  // Power iteration on the correlation matrix. Groups are at most five wide, so
  // this settles in a handful of passes and needs no matrix library.
  function principal(matrix, iterations = 500) {
    const width = matrix[0].length, rows = matrix.length;
    const covariance = Array.from({ length: width }, () => new Array(width).fill(0));
    for (const row of matrix) {
      for (let i = 0; i < width; i += 1) {
        for (let j = 0; j < width; j += 1) covariance[i][j] += row[i] * row[j] / rows;
      }
    }
    let vector = new Array(width).fill(1 / Math.sqrt(width));
    for (let step = 0; step < iterations; step += 1) {
      const next = new Array(width).fill(0);
      for (let i = 0; i < width; i += 1) {
        for (let j = 0; j < width; j += 1) next[i] += covariance[i][j] * vector[j];
      }
      const norm = Math.sqrt(next.reduce((sum, value) => sum + value * value, 0));
      if (!(norm > 0)) return null;
      const scaled = next.map((value) => value / norm);
      const settled = scaled.every((value, index) => Math.abs(value - vector[index]) < 1e-12);
      vector = scaled;
      if (settled) break;
    }
    // Members already point the same way, so a component with a negative sum is
    // the same axis read backwards. Without this the sign is arbitrary and the
    // radar would invert between one render and the next.
    const total = vector.reduce((sum, value) => sum + value, 0);
    const dominant = vector.reduce((best, value) => (Math.abs(value) > Math.abs(best) ? value : best), 0);
    const flip = total < 0 || (total === 0 && dominant < 0);
    const oriented = flip ? vector.map((value) => -value) : vector;
    let eigenvalue = 0;
    for (let i = 0; i < width; i += 1) {
      for (let j = 0; j < width; j += 1) eigenvalue += oriented[i] * covariance[i][j] * oriented[j];
    }
    const trace = covariance.reduce((sum, row, index) => sum + row[index], 0);
    return { vector: oriented, eigenvalue, explained: trace > 0 ? eigenvalue / trace : null };
  }
  // Fitted once per reference and reused for every player on the chart, so a
  // comparison overlay is ranked on exactly the same component.
  function fit(attribute, reference) {
    const members = attribute.members;
    const base = { attribute, members, peerCount: reference.peerCount, config: reference.config,
      position: reference.position, scope: reference.scope, sampleSize: 0,
      loadings: null, dropped: [], active: null, explained: null };
    // An unknown value must stay unknown: in JavaScript null * 1 is 0.
    const signed = (value, metric) => (value === null ? NaN : value * sign(metric));
    // Members are the same small-sample-adjusted rates the wheel ranks.
    const values = reference.peers.map((peer) => members.map((metric) =>
      signed(RadarScoring.adjusted(peer, metric, reference).value, metric)));
    // A component needs every member for every peer it is fitted on, but not
    // every season supplies every member: chances created is effectively
    // missing before 2024-25. A member stays unless requiring it would cut the
    // peers who can be fitted to under a third of what the other members allow;
    // then it leaves the axis, with its reason reported, rather than shrinking
    // the population to the current season alone.
    const dropped = [];
    const complete = (indices) => values.filter((row) => indices.every((index) => Number.isFinite(row[index]))).length;
    let included = members.map((_, index) => index);
    while (included.length > 1) {
      const now = complete(included);
      const best = included.map((index) => ({ index, without: complete(included.filter((other) => other !== index)) }))
        .reduce((top, option) => (option.without > top.without ? option : top));
      if (now * 3 >= best.without) break;
      dropped.push({ metric: members[best.index], reason: "coverage" });
      included = included.filter((index) => index !== best.index);
    }
    const rows = values.filter((row) => included.every((index) => Number.isFinite(row[index])));
    if (rows.length < Math.max(reference.config.minimumPeers, included.length + 1)) {
      return { ...base, dropped, status: "insufficient_peers", sampleSize: rows.length };
    }
    const mean = [], deviation = [];
    for (const index of included) {
      mean[index] = rows.reduce((sum, row) => sum + row[index], 0) / rows.length;
      deviation[index] = Math.sqrt(rows.reduce((sum, row) => sum + (row[index] - mean[index]) ** 2, 0) / rows.length);
    }
    // A member the whole group scores identically carries no information and
    // would divide by zero; red cards in a four-round season are one of these.
    let active = included.filter((index) => deviation[index] > 0);
    for (const index of included) if (!(deviation[index] > 0)) dropped.push({ metric: members[index], reason: "constant" });
    if (!active.length) return { ...base, dropped, status: "invalid_value", sampleSize: rows.length };
    const matrix = (indices) => rows.map((row) =>
      indices.map((index) => (row[index] - mean[index]) / deviation[index]));
    // The first component only reads as "more of this quality" when its members
    // agree. Where one moves against the rest - dribbling against shot volume,
    // or possession lost against touches - it is measuring something else, and
    // an axis labelled "Hücum" that falls when a player dribbles more would
    // mislead. Members that load negatively leave the axis, the most negative
    // first, and the component is refitted until the survivors agree. Which
    // ones left is reported beside the chart rather than quietly dropped.
    let component = principal(matrix(active));
    while (component) {
      const worst = component.vector.reduce((low, weight, index) =>
        (weight < component.vector[low] ? index : low), 0);
      if (active.length === 1 || component.vector[worst] >= 0) break;
      dropped.push({ metric: members[active[worst]], reason: "direction" });
      active = active.filter((_, index) => index !== worst);
      component = principal(matrix(active));
    }
    if (!component) return { ...base, dropped, status: "invalid_value", sampleSize: rows.length };
    const project = (row) => active.reduce((sum, index, position) =>
      sum + ((row[index] - mean[index]) / deviation[index]) * component.vector[position], 0);
    return { ...base, status: "available", sampleSize: rows.length, explained: component.explained,
      project, projections: rows.map(project), dropped, active,
      loadings: active.map((index, position) => ({ metric: members[index], weight: component.vector[position] })) };
  }
  function evaluate(player, model, reference, options = {}) {
    const members = model.members;
    const result = { metric: model.attribute, rawValue: null, value: null, attempts: null,
      attemptsSupplied: null, minutes: player.minutes, supplied: 0, records: player.rows.length,
      score: null, sampleSize: model.sampleSize, positiveN: 0, zeroShare: null, zeroApplied: false,
      minimumMinutes: reference.config.minimumMinutes, peerCount: reference.peerCount,
      position: reference.position, scope: reference.scope,
      loadings: model.loadings, dropped: model.dropped, explained: model.explained, status: model.status,
      smallSample: !(player.minutes > 0) || player.minutes < reference.config.minimumMinutes };
    const inGroup = RadarScoring.inReferenceGroup(player, reference);
    if ((!inGroup && !options.guest) || player.scope?.key !== reference.scope?.key) {
      return { ...result, status: "incompatible_group" };
    }
    result.guest = Boolean(options.guest) && !inGroup;
    const own = members.map((metric) => RadarScoring.adjusted(player, metric, reference));
    // Only the members the component kept are needed from the player.
    const needed = model.active || members.map((_, index) => index);
    result.supplied = needed.length ? Math.min(...needed.map((index) => own[index].supplied)) : 0;
    if (!needed.every((index) => Number.isFinite(own[index].value))) return { ...result, status: "partial_coverage" };
    if (model.status !== "available") return result;
    const value = model.project(own.map((entry, index) =>
      (entry.value === null ? NaN : entry.value * sign(members[index]))));
    const ranked = RadarScoring.percentile(value, model.projections);
    if (!Number.isFinite(ranked)) return { ...result, status: "invalid_value" };
    return { ...result, status: "available", rawValue: value, value,
      score: Math.max(0, Math.min(100, ranked)) };
  }
  return { groups, build, forPosition, principal, fit, evaluate };
})();


// SVG only: scoring and reference selection live in RadarScoring above.
// Team spider plots: the same scoring, reference and principal-component code
// as the player plots, over a team catalogue. A team-season is treated like a
// player-season whose every match lasts 90 minutes, so a per-90 rate is a
// per-match rate and every team is one position group, "TEAM".
const RadarTeams = (() => {
  const metrics = {};
  const positions = ["TEAM"];
  // Volume statistics are never genuinely zero for a team - nobody makes no
  // passes - so a blank stays unknown. Event counts where zero is ordinary
  // (goals, cards, big chances, corners) read an omission as none, exactly as
  // the player rows do: from 2024-25 Sportmonks stops writing zero goals and red
  // cards. Key passes and duels won have genuine gaps even in 2026-27 (whole
  // fixtures with 9-19 shots and no key-pass value), which is why they are not
  // on the omitted-zero list.
  function add(id, label, column, category, options = {}) {
    metrics[id] = { id, label, sourceColumn: column, transform: "per90", unit: " /maç",
      direction: "higher_better", zeroHeavy: false, blankIsZero: false, category, positions, ...options };
  }
  add("goals", "Gol", "goals", "attacking", { blankIsZero: true });
  add("xg", "xG", "expected_goals", "attacking");
  add("shots", "Şut", "shots_total", "attacking");
  add("shots_on_target", "İsabetli şut", "shots_on_target", "attacking", { blankIsZero: true });
  add("big_chances", "Büyük fırsat", "big_chances_created", "attacking", { blankIsZero: true });
  add("dangerous_attacks", "Tehlikeli atak", "dangerous_attacks", "attacking", { direction: "context" });
  add("possession", "Topla oynama", "ball_possession", "possession", { transform: "mean", unit: " %", direction: "context" });
  add("passes", "Pas", "passes", "possession", { direction: "context" });
  add("pass_accuracy", "Pas isabeti %", "successful_passes", "possession", { transform: "percentage",
    attemptsColumn: "passes", minimumAttempts: 100, unit: " %", rawLabel: "İsabetli pas" });
  add("key_passes", "Kilit pas", "key_passes", "creation");
  add("accurate_crosses", "İsabetli orta", "accurate_crosses", "creation", { blankIsZero: true });
  add("corners", "Korner", "corners", "creation", { blankIsZero: true });
  add("conceded", "Az gol yeme", "goals_conceded", "defending", { direction: "lower_better", blankIsZero: true, rawLabel: "Yenilen gol" });
  add("xg_against", "Az xG yeme", "expected_goals_against", "defending", { direction: "lower_better", rawLabel: "Rakibe verilen xG" });
  add("shots_conceded", "Az şut yeme", "shots_conceded", "defending", { direction: "lower_better", rawLabel: "Rakip şutu" });
  add("tackles", "Müdahale", "tackles", "defending", { direction: "context" });
  add("interceptions", "Top kesme", "interceptions", "defending", { direction: "context" });
  add("duels_won", "Kazanılan ikili", "duels_won", "duels");
  add("fouls", "Faulden kaçınma", "fouls", "discipline", { direction: "lower_better", rawLabel: "Yapılan faul" });
  add("yellowcards", "Sarı karttan kaçınma", "yellowcards", "discipline", { direction: "lower_better", blankIsZero: true, rawLabel: "Sarı kart" });
  add("redcards", "Kırmızıdan kaçınma", "redcards", "discipline", { direction: "lower_better", blankIsZero: true, zeroHeavy: "auto", rawLabel: "Kırmızı kart" });

  // One fixed wheel, in the same order as the player wheel: attack, then
  // possession and creation, then defending.
  const profile = ["goals", "xg", "shots", "shots_on_target", "big_chances", "dangerous_attacks",
    "possession", "passes", "pass_accuracy", "key_passes", "accurate_crosses",
    "conceded", "xg_against", "shots_conceded", "tackles", "interceptions"];
  const groups = [
    { id: "attack", label: "Hücum", members: ["goals", "xg", "shots", "shots_on_target", "big_chances"] },
    { id: "creation", label: "Üretim", members: ["key_passes", "accurate_crosses", "corners", "dangerous_attacks"] },
    { id: "ball", label: "Top hakimiyeti", members: ["possession", "passes", "pass_accuracy"] },
    { id: "defence", label: "Savunma", members: ["conceded", "xg_against", "shots_conceded"] },
    { id: "duels", label: "Mücadele", members: ["tackles", "interceptions", "duels_won"] },
    { id: "discipline", label: "Disiplin", members: ["fouls", "yellowcards", "redcards"] },
  ];
  const axes = () => profile.map((id) => metrics[id]);
  const attributes = () => RadarAttributes.build(groups, metrics, "TEAM");

  // One wide row per team and fixture from team_metrics.csv's long format.
  // Sportmonks names are lower-cased (SHOTS_TOTAL -> shots_total) so the shared
  // coverage and omitted-zero rules read them exactly as they read player rows.
  // The opponent's row in the same fixture supplies what a team conceded; with
  // only one side saved, nothing conceded is known and those columns stay absent.
  //
  // In this long format an omitted statistic has no record at all, so every
  // row first gets every statistic its file supplies anywhere, left blank.
  // Without that, a match with no goal recorded had no goals column, the shared
  // rules read it as unknown rather than none, and one goalless match removed
  // a whole team-season from every attack axis. A statistic the file never
  // supplies stays absent, and so stays unknown.
  function rows(records) {
    const byKey = new Map(), names = new Set();
    for (const record of records) {
      if (!record.fixture_id || !record.team_id || !record.name) continue;
      const key = `${record.fixture_id}|${record.team_id}`, name = String(record.name).toLowerCase();
      if (!byKey.has(key)) byKey.set(key, { fixture_id: String(record.fixture_id), team_id: String(record.team_id), minutes_played: "90" });
      byKey.get(key)[name] = record.value;
      names.add(name);
    }
    for (const row of byKey.values()) for (const name of names) if (!(name in row)) row[name] = "";
    const byFixture = new Map();
    for (const row of byKey.values()) {
      if (!byFixture.has(row.fixture_id)) byFixture.set(row.fixture_id, []);
      byFixture.get(row.fixture_id).push(row);
    }
    for (const pair of byFixture.values()) {
      if (pair.length !== 2) continue;
      for (const [own, other] of [[pair[0], pair[1]], [pair[1], pair[0]]]) {
        own.opponent_id = other.team_id;
        own.goals_conceded = other.goals ?? "";
        own.shots_conceded = other.shots_total ?? "";
        own.shots_on_target_conceded = other.shots_on_target ?? "";
        const blank = (value) => String(value ?? "").trim() === "";
        if (blank(own.expected_goals_against) && !blank(other.expected_goals)) own.expected_goals_against = other.expected_goals;
      }
    }
    return [...byKey.values()];
  }
  // Team-seasons within one season and competition, ready for createReference.
  // Only finished fixtures count, as for players: a match the last download
  // caught in play would otherwise add half its statistics as ninety minutes.
  function entities(teamRows, fixtures, scope) {
    const byFixture = new Map(fixtures.map((fixture) => [String(fixture.fixture_id), fixture]));
    const teams = new Map();
    for (const row of teamRows) {
      const fixture = byFixture.get(row.fixture_id);
      if (!scope || RadarScoring.fixtureScope(fixture)?.key !== scope.key || !RadarScoring.finished(fixture)) continue;
      if (!teams.has(row.team_id)) teams.set(row.team_id, { id: row.team_id, name: `Takım ${row.team_id}`, rows: [], position: "TEAM", scope });
      teams.get(row.team_id).rows.push(row);
    }
    return [...teams.values()].map((team) => ({ ...team, minutes: team.rows.length * 90 }));
  }
  function columns() {
    return [...new Set(Object.values(metrics).flatMap((metric) => [metric.sourceColumn, metric.attemptsColumn]).filter(Boolean))];
  }
  return { metrics, profile, groups, axes, attributes, rows, entities, columns };
})();

const RadarChart = (() => {
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  // Sized for two charts side by side: each renders at roughly 350-550px, so
  // the circle gives up some radius to type that stays near 10-11px on screen.
  const width = 640, centre = 320, radius = 150, labelGap = 24;
  const labelSize = 18, lineHeight = 20, scoreSize = 16, scoreHeight = 18, ascent = 19, wrapAt = 14;
  const reasonSize = 13, reasonHeight = 16;
  // 0 and 100 appear only where a rule puts them there - an observed zero on a
  // zero-heavy axis, or the ends of a min-max scale. A rank inside a group,
  // however large, reads 1-99, so a 99.8 among 300 peers does not round to 100.
  function display(score) {
    if (!Number.isFinite(score)) return "—";
    return score === 0 || score === 100 ? String(score) : String(Math.min(99, Math.max(1, Math.round(score))));
  }
  function wrap(label) {
    // A trailing unit such as "%" never sits on a line of its own.
    const lines = [""];
    for (const word of label.replace(/ %/g, "\u00a0%").split(" ")) {
      if (lines[lines.length - 1] && `${lines[lines.length - 1]} ${word}`.length > wrapAt) lines.push(word);
      else lines[lines.length - 1] += `${lines[lines.length - 1] ? " " : ""}${word}`;
    }
    return lines;
  }
  // `reason(result)` may return a few words for an axis without a score; they
  // sit under its "—" so a blank axis says why without a hover.
  function svg(axes, series, tooltip, title = "Oyuncu radarı", reason = () => "") {
    if (axes.length < 5 || axes.length > 18) return "";
    const at = (index, distance) => {
      const angle = 2 * Math.PI * index / axes.length - Math.PI / 2;
      return [centre + Math.cos(angle) * distance, centre + Math.sin(angle) * distance];
    };
    const point = (index, fraction) => at(index, radius * fraction).map((value) => value.toFixed(2)).join(",");
    const parts = [`<title>${escape(title)}</title><desc>0–100 ölçeği. Eksik ölçütler çizilmez; değerler ayrıntı tablosunda da bulunur.</desc>`];
    for (const ring of [20, 40, 60, 80, 100]) {
      parts.push(`<polygon points="${axes.map((_, index) => point(index, ring / 100)).join(" ")}" fill="none" stroke="var(--line)" stroke-width="1"/>`);
    }
    axes.forEach((_, index) => {
      const [x, y] = at(index, radius);
      parts.push(`<line x1="${centre}" y1="${centre}" x2="${x}" y2="${y}" stroke="var(--line)"/>`);
    });
    // Later series are drawn first, so the first (primary) series sits on top.
    // A `faded` series - the compared player - recedes: a thinner, partly
    // transparent outline and softer points over its lighter fill, so two
    // overlapping shapes stay distinguishable.
    for (const entry of [...series].reverse()) {
      const stroke = entry.faded ? 'stroke-width="2" stroke-opacity="0.65" data-radar-faded="true"' : 'stroke-width="3"';
      const valid = entry.results.map((result) => Number.isFinite(result.score) && result.score >= 0 && result.score <= 100);
      if (valid.every(Boolean)) {
        const shape = entry.results.map((result, index) => point(index, result.score / 100)).join(" ");
        parts.push(`<polygon data-radar-series="complete" points="${shape}" fill="${escape(entry.fill)}" stroke="${escape(entry.line)}" ${stroke}/>`);
      } else {
        // No filled area or connections across a missing axis. Observed zero
        // stays exactly at the centre and remains different from unavailable.
        entry.results.forEach((result, index) => {
          const next = (index + 1) % axes.length;
          if (valid[index] && valid[next]) parts.push(`<polyline data-radar-series="partial" points="${point(index, result.score / 100)} ${point(next, entry.results[next].score / 100)}" fill="none" stroke="${escape(entry.line)}" ${stroke}/>`);
        });
      }
      entry.results.forEach((result, index) => {
        if (!valid[index]) return;
        const [x, y] = at(index, radius * result.score / 100), detail = escape(tooltip(entry, result));
        parts.push(`<circle data-radar-point="${index}" cx="${x}" cy="${y}" r="${entry.faded ? 4 : 5}" fill="${escape(entry.line)}"${entry.faded ? ' fill-opacity="0.7"' : ""} tabindex="0" role="img" aria-label="${detail}"><title>${detail}</title></circle>`);
      });
    }
    for (const ring of [0, 20, 40, 60, 80, 100]) {
      parts.push(`<text x="${centre + 6}" y="${centre - radius * ring / 100 - 4}" font-size="13" fill="var(--muted)">${ring}</text>`);
    }
    // Lay every label block out first, then settle collisions before drawing.
    const glyph = labelSize * 0.56, scoreGlyph = scoreSize * 0.6;
    const blocks = axes.map((axis, index) => {
      const [x, y] = at(index, radius + labelGap);
      const anchor = Math.abs(x - centre) < 14 ? "middle" : x > centre ? "start" : "end";
      const lines = wrap(axis.label);
      const why = series.length === 1 && !Number.isFinite(series[0].results[index].score)
        ? String(reason(series[0].results[index]) || "") : "";
      const height = lines.length * lineHeight + scoreHeight + (why ? reasonHeight : 0);
      // The whole label and score block stays outside the ring: above the
      // anchor in the top half, below it in the bottom half, centred at the sides.
      const startY = y < centre - 20 ? y - height + ascent - 6 : y > centre + 20 ? y + ascent + 4 : y - height / 2 + ascent;
      const span = Math.max(...lines.map((line) => line.length * glyph), (series.length * 4 + 4) * scoreGlyph,
        why.length * reasonSize * 0.56);
      const left = anchor === "middle" ? x - span / 2 : anchor === "start" ? x : x - span;
      return { axis, index, x, y, anchor, lines, why, height, startY, left, right: left + span };
    });
    // Sixteen labels round a circle crowd each other just off the vertical
    // axis, where neighbours are stacked rather than side by side. Push the
    // block further from the horizontal midline outward until it clears; the
    // viewBox below grows to follow it, so nothing is clipped.
    // Measured extent: capitals with Turkish dots rise a full ascent above the
    // first baseline, and the score line's descenders fall about 4 below it.
    const box = (block) => [block.startY - ascent - 1,
      block.startY + block.lines.length * lineHeight + 8 + (block.why ? reasonHeight : 0)];
    for (let pass = 0; pass < 8; pass += 1) {
      let moved = false;
      blocks.forEach((block, index) => {
        const other = blocks[(index + 1) % blocks.length];
        if (block === other || block.left >= other.right || other.left >= block.right) return;
        const [top1, bottom1] = box(block), [top2, bottom2] = box(other);
        const overlap = Math.min(bottom1, bottom2) - Math.max(top1, top2);
        if (overlap <= 0) return;
        const outer = Math.abs(block.y - centre) >= Math.abs(other.y - centre) ? block : other;
        outer.startY += (outer.y < centre ? -1 : 1) * (overlap + 3);
        moved = true;
      });
      if (!moved) break;
    }
    let top = centre - radius, bottom = centre + radius;
    for (const { axis, index, x, anchor, lines, why, startY } of blocks) {
      const scoreY = startY + lines.length * lineHeight + 2;
      top = Math.min(top, startY - ascent - 4);
      bottom = Math.max(bottom, scoreY + 6 + (why ? reasonHeight : 0));
      const unit = axis.unit ?? (axis.transform === "per90" ? " /90" : axis.transform === "percentage" ? " %" : "");
      // Context axes are italic: more activity, not better quality. The
      // tooltip and details table spell that out in words.
      const style = axis.direction === "context" ? ' font-style="italic"' : "";
      const detail = escape(series.map((entry) => tooltip(entry, entry.results[index])).join("\n\n"));
      const scores = series.map((entry, seriesIndex) => {
        const value = entry.results[index].score;
        return `${seriesIndex ? `<tspan fill="var(--muted)" font-weight="400"> · </tspan>` : ""}<tspan fill="${escape(entry.line)}">${display(value)}</tspan>`;
      }).join("");
      parts.push(`<g tabindex="0" role="img" aria-label="${detail}"><title>${detail}</title>`);
      parts.push(`<text x="${x}" y="${startY}" text-anchor="${anchor}" font-size="${labelSize}" fill="var(--ink)"${style}>${lines.map((line, lineIndex) => `<tspan x="${x}" dy="${lineIndex ? lineHeight : 0}">${escape(line)}</tspan>`).join("")}</text>`);
      parts.push(`<text x="${x}" y="${scoreY}" text-anchor="${anchor}" font-size="${scoreSize}" font-weight="650">${scores}<tspan fill="var(--muted)" font-size="12" font-weight="400">${escape(unit)}</tspan></text>`);
      if (why) parts.push(`<text data-radar-reason="${index}" x="${x}" y="${scoreY + reasonHeight}" text-anchor="${anchor}" font-size="${reasonSize}" font-style="italic" fill="var(--muted)">${escape(why)}</text>`);
      parts.push("</g>");
    }
    // Crop to what was drawn, so a six-axis wheel is not padded to the height
    // a sixteen-axis one needs.
    const viewTop = Math.floor(top - 8), viewHeight = Math.ceil(bottom - top + 16);
    return `<svg viewBox="0 ${viewTop} ${width} ${viewHeight}" width="100%" role="img" aria-label="${escape(title)}">${parts.join("")}</svg>`;
  }
  return { escape, display, svg };
})();

if (typeof module !== "undefined" && module.exports) module.exports = { RadarScoring, RadarAttributes, RadarTeams, RadarChart };
