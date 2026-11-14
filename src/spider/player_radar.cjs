"use strict";

// Player Detailed Metrics scorer and SVG wheel from the original website’s
// src/web/lib/radar.js, with English labels and an offline export below.

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
  const positionLabels = { GK: "Goalkeeper", CB: "Centre-back", FB: "Full-back / wing-back",
    DM: "Defensive midfielder", CM: "Central midfielder", AM: "Attacking midfielder",
    W: "Winger", FW: "Forward", DEF: "Defender (general)", MID: "Midfielder (general)", TEAM: "Team",
    ALL: "All outfield players" };
  const categories = { attacking: "Attack", creation: "Creation", progression: "Progression",
    possession: "Ball use", defending: "Defence", duels: "Duels",
    goalkeeping: "Goalkeeping", discipline: "Errors and discipline", attribute: "Overall attribute" };
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
  combined("goal_contribution", "Goal contributions", ["goals", "assists"], "attacking");
  rate("xg", "xG", "xg_expected_goals", "attacking", "higher_better", false);
  metrics.xg.fallbackColumn = "expected_goals";
  rate("shots", "Shots", "shots_total", "attacking");
  rate("shots_on_target", "Shots on target", "shots_on_target", "attacking");
  rate("big_chances", "Big chances", "big_chances_created", "creation");
  rate("key_passes", "Key passes", "key_passes", "creation");
  rate("final_third", "Final-third passes", "passes_in_final_third", "progression", "context");
  rate("dribbles", "Successful dribbles", "successful_dribbles", "progression");
  rate("touches", "Touches", "touches", "possession", "context", false);
  rate("passes", "Passes", "passes", "possession", "context", false, allPositions);
  rate("long_balls", "Long balls", "long_balls", "possession", "context", "auto", allPositions);
  percentage("pass_accuracy", "Pass accuracy %", "accurate_passes", "passes", 100, "possession", allPositions);
  percentage("long_accuracy", "Long-pass accuracy %", "long_balls_won", "long_balls", 30, "possession", allPositions);
  rate("tackles", "Tackles", "tackles", "defending", "context");
  rate("interceptions", "Interceptions", "interceptions", "defending", "context");
  rate("ball_recovery", "Ball recoveries", "ball_recovery", "defending", "context");
  rate("aerials_won", "Aerials won", "aerials_won", "duels");
  percentage("duel_pct", "Duels won %", "duels_won", "total_duels", 30, "duels");
  rate("saves", "Saves", "saves", "goalkeeping", "context", false, ["GK"]);
  rate("saves_inside_box", "Saves inside the box", "saves_inside_box", "goalkeeping", "context", false, ["GK"]);
  rate("claims", "High claims", "good_high_claim", "goalkeeping", "context", "auto", ["GK"]);
  rate("punches", "Punches", "punches", "goalkeeping", "context", "auto", ["GK"]);
  rate("conceded", "Few goals conceded", "goalkeeper_goals_conceded", "goalkeeping", "lower_better", false, ["GK"]);
  rate("errors_goal", "Fewer goal errors", "error_lead_to_goal", "discipline", "lower_better", "auto", allPositions);

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
  function svg(axes, series, tooltip, title = "Player radar", reason = () => "") {
    if (axes.length < 5 || axes.length > 18) return "";
    const at = (index, distance) => {
      const angle = 2 * Math.PI * index / axes.length - Math.PI / 2;
      return [centre + Math.cos(angle) * distance, centre + Math.sin(angle) * distance];
    };
    const point = (index, fraction) => at(index, radius * fraction).map((value) => value.toFixed(2)).join(",");
    const parts = [`<title>${escape(title)}</title><desc>${escape("Detailed metric scores on a 0–100 scale. Unavailable axes are left open.")}</desc>`];
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

function detailedPlayerScores({ players, fixtures, playerId }) {
  const scopes = RadarScoring.scopes(fixtures);
  if (scopes.length !== 1) throw new Error("Expected one season and competition in the fixtures.");
  const prepared = RadarScoring.preparePlayers(players, fixtures, scopes[0]);
  const player = prepared.find((entry) => entry.id === playerId);
  if (!player?.position || !(player.minutes > 0)) {
    throw new Error(`Player ${playerId} has no usable minutes and position in this season.`);
  }
  const mostMinutes = Math.max(...prepared.map((entry) => entry.minutes ?? 0));
  const minimumMinutes = Math.min(RadarScoring.defaults.minimumMinutes,
    Math.max(90, Math.round(mostMinutes / 60) * 30));
  const axes = RadarScoring.axes(player.position);
  const reference = RadarScoring.createReference(prepared, player, axes, { minimumMinutes });
  const results = axes.map((axis) => RadarScoring.evaluate(player, axis, reference));
  if (!results.some((result) => Number.isFinite(result.score))) {
    throw new Error(`Player ${playerId} has no rankable detailed metrics.`);
  }
  return { player, axes, reference, results };
}

function renderDetailedPlayerRadar(payload) {
  const { player, axes, reference, results } = detailedPlayerScores(payload);
  const title = `${player.name} · Detailed metrics`;
  const series = [{ name: player.name, results, line: "#9c8bf0", fill: "#9c8bf03d" }];
  const unit = (metric) => metric.transform === "percentage" ? "%" : " per 90";
  const rate = (value, metric) => `${value.toFixed(2)}${unit(metric)}`;
  const format = (entry, result) => {
    const label = `${entry.name} · ${result.metric.label}`;
    if (!Number.isFinite(result.score)) return `${label}\nUnavailable (${result.status.replaceAll("_", " ")})`;
    return `${label}\nScore ${RadarChart.display(result.score)} / 100 · ${result.sampleSize} valid observations`
      + `\nObserved ${rate(result.observedValue, result.metric)} · Ranked ${rate(result.value, result.metric)}`;
  };
  // The numbers next to the labels are scores. The underlying units are in the tooltips.
  const displayAxes = axes.map((axis) => ({ ...axis, unit: "" }));
  const wheel = RadarChart.svg(displayAxes, series, format, title, () => "Unavailable");
  const [, top, width, height] = wheel.match(/viewBox="0 (-?\d+) (\d+) (\d+)"/).map(Number);
  const chart = wheel.slice(wheel.indexOf(">") + 1, -"</svg>".length)
    .replaceAll("var(--ink)", "#f5f1f8").replaceAll("var(--muted)", "#a99cb3")
    .replaceAll("var(--line)", "#3a2c49");
  const totalWidth = width + 48, totalHeight = height + 136;
  const role = RadarScoring.positionLabels[player.position];
  const minutes = (value) => value.toLocaleString("en-US");
  const note = `${minutes(player.minutes)} min played · ${reference.peerCount} in peer group · ${minutes(reference.config.minimumMinutes)} min to qualify`;
  const escape = RadarChart.escape;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${totalHeight}"`,
    `  viewBox="0 0 ${totalWidth} ${totalHeight}" role="img" aria-label="${escape(title)}">`,
    `<g font-family="Inter, Segoe UI, Arial, sans-serif">`,
    `<rect width="${totalWidth}" height="${totalHeight}" rx="16" fill="#171020"/>`,
    `<text x="26" y="37" font-size="26" font-weight="700" fill="#f5f1f8">${escape(player.name)}</text>`,
    `<text x="26" y="60" font-size="15" fill="#b785f5">${escape(`Süper Lig ${payload.season} · ${role}`)}</text>`,
    `<text x="26" y="81" font-size="13" fill="#a99cb3">${escape(note)}</text>`,
    `<path d="M26 94H${totalWidth - 26}" stroke="#3a2c49"/>`,
    `<g transform="translate(24 ${102 - top})">${chart}</g>`,
    `<text x="26" y="${height + 121}" font-size="13" fill="#a99cb3">0–100 radar scores · Italic labels show activity volume</text>`,
    `</g></svg>`,
  ].join("\n") + "\n";
}

module.exports = { RadarScoring, RadarChart, detailedPlayerScores, renderDetailedPlayerRadar };

if (require.main === module) {
  try {
    const fs = require("node:fs");
    process.stdout.write(renderDetailedPlayerRadar(JSON.parse(fs.readFileSync(0, "utf8"))));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
