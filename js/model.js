// GoalScope prediction model.
// A Poisson goal model built from team attack/defence strength (league table),
// recent form, head-to-head history and — for live matches — the time left,
// scoreline, red cards and in-game shot pressure.

export const DEFAULT_LEAGUE_AVG = 1.35; // goals per team per match
const HOME_ADV = 1.1;
const MAX_GOALS = 10;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function poisson(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}

// Share of a full match's goal expectancy still to come at a given minute.
// Roughly 45% of goals fall in the first half, 55% in the second.
export function remainingShare(minute, state) {
  if (state === 'pre') return 1;
  if (state === 'post') return 0;
  const m = clamp(minute || 0, 0, 120);
  let share;
  if (m < 45) share = ((45 - m) / 45) * 0.45 + 0.55;
  else share = (Math.max(0, 90 - m) / 45) * 0.55;
  // Stoppage time is still to be played while the match is live.
  return Math.max(share, 0.025);
}

// Attack / defence multipliers (1.0 = league average) from table + form.
export function teamStrength(team, leagueAvg = DEFAULT_LEAGUE_AVG) {
  const mu = leagueAvg || DEFAULT_LEAGUE_AVG;
  const K = 4; // shrinkage toward average, in matches
  const parts = [];
  const t = team.table;
  if (t && t.gp > 0) {
    parts.push({
      w: 0.7,
      att: ((t.gf / t.gp / mu) * t.gp + K) / (t.gp + K),
      def: ((t.ga / t.gp / mu) * t.gp + K) / (t.gp + K),
    });
  }
  const f = team.form || [];
  if (f.length > 0) {
    const n = f.length;
    const gf = f.reduce((s, g) => s + g.gf, 0);
    const ga = f.reduce((s, g) => s + g.ga, 0);
    parts.push({
      w: 0.3,
      att: ((gf / n / mu) * n + 2) / (n + 2),
      def: ((ga / n / mu) * n + 2) / (n + 2),
    });
  }
  if (!parts.length) return { att: 1, def: 1, source: 'none' };
  const wSum = parts.reduce((s, p) => s + p.w, 0);
  return {
    att: clamp(parts.reduce((s, p) => s + p.att * p.w, 0) / wSum, 0.35, 2.8),
    def: clamp(parts.reduce((s, p) => s + p.def * p.w, 0) / wSum, 0.35, 2.8),
    source: parts.length === 2 ? 'table+form' : t && t.gp ? 'table' : 'form',
  };
}

// 0–100 ratings for the "stats runner" bars.
export function ratings(team, strength) {
  const form = team.form || [];
  const pts = form.reduce((s, g) => s + (g.res === 'W' ? 3 : g.res === 'D' ? 1 : 0), 0);
  return {
    attack: Math.round(clamp(strength.att * 50, 0, 100)),
    defense: Math.round(clamp(50 / strength.def, 0, 100)),
    form: form.length ? Math.round((pts / (form.length * 3)) * 100) : null,
  };
}

export function h2hSummary(h2h, homeId) {
  const games = (h2h || []).filter((g) => Number.isFinite(g.hs) && Number.isFinite(g.as));
  const s = { n: games.length, homeWins: 0, awayWins: 0, draws: 0, avgGoals: 0, btts: 0 };
  for (const g of games) {
    const homeGoals = g.homeId === homeId ? g.hs : g.as;
    const awayGoals = g.homeId === homeId ? g.as : g.hs;
    if (homeGoals > awayGoals) s.homeWins++;
    else if (homeGoals < awayGoals) s.awayWins++;
    else s.draws++;
    s.avgGoals += g.hs + g.as;
    if (g.hs > 0 && g.as > 0) s.btts++;
  }
  if (s.n) s.avgGoals /= s.n;
  return s;
}

// Shots-on-target pace relative to a typical ~4.5 per team per 90.
function pressureFactor(stats, minute) {
  if (!stats || !Number.isFinite(stats.shotsOnTarget) || minute < 15) return 1;
  const rate = stats.shotsOnTarget / minute;
  const raw = clamp(rate / 0.05, 0.6, 1.6);
  const w = clamp(minute / 90, 0, 1) * 0.5;
  return 1 + (raw - 1) * w;
}

export function predict(match, detail = {}) {
  const mu = detail.leagueAvg || DEFAULT_LEAGUE_AVG;
  const home = { ...match.home, form: detail.form?.home, table: detail.table?.home };
  const away = { ...match.away, form: detail.form?.away, table: detail.table?.away };
  const sh = teamStrength(home, mu);
  const sa = teamStrength(away, mu);
  const factors = [];

  // Full-match expected goals.
  let lh = mu * sh.att * sa.def * HOME_ADV;
  let la = (mu * sa.att * sh.def) / HOME_ADV;
  factors.push(`Base: league avg ${mu.toFixed(2)} goals/team, home advantage ×${HOME_ADV}.`);
  factors.push(
    `${home.short || home.name} attack ×${sh.att.toFixed(2)}, defence ×${sh.def.toFixed(2)} (${sh.source}); ` +
      `${away.short || away.name} attack ×${sa.att.toFixed(2)}, defence ×${sa.def.toFixed(2)} (${sa.source}).`
  );

  const h2h = h2hSummary(detail.h2h, match.home.id);
  if (h2h.n >= 2) {
    const w = (Math.min(h2h.n, 6) / 6) * 0.25;
    const adj = clamp(1 + w * (h2h.avgGoals / (lh + la) - 1), 0.8, 1.25);
    lh *= adj;
    la *= adj;
    factors.push(`Head-to-head: ${h2h.avgGoals.toFixed(1)} goals/game over ${h2h.n} meetings → ×${adj.toFixed(2)}.`);
  }
  const fullHome = lh;
  const fullAway = la;

  // Live adjustments.
  const live = match.state === 'in';
  const minute = live ? match.minute || 0 : 0;
  const share = remainingShare(minute, match.state);
  let rh = lh * share;
  let ra = la * share;
  if (live) {
    factors.push(`Minute ${minute}: ${(share * 100).toFixed(0)}% of the match's goal expectancy remains.`);
    const diff = (match.home.score || 0) - (match.away.score || 0);
    if (diff !== 0) {
      const k = Math.min(Math.abs(diff), 2);
      const trail = 1 + 0.12 * k;
      const lead = 1 - 0.06 * k;
      if (diff > 0) { rh *= lead; ra *= trail; } else { rh *= trail; ra *= lead; }
      factors.push(`Scoreline: trailing side pushes (×${trail.toFixed(2)}), leader sits deeper (×${lead.toFixed(2)}).`);
    }
    const redH = match.home.redCards || 0;
    const redA = match.away.redCards || 0;
    if (redH || redA) {
      rh *= Math.pow(0.7, redH) * Math.pow(1.2, redA);
      ra *= Math.pow(0.7, redA) * Math.pow(1.2, redH);
      factors.push(`Red cards (home ${redH}, away ${redA}) applied.`);
    }
    const ph = pressureFactor(detail.liveStats?.home, minute);
    const pa = pressureFactor(detail.liveStats?.away, minute);
    if (ph !== 1 || pa !== 1) {
      rh *= ph;
      ra *= pa;
      factors.push(`Live shot pressure: home ×${ph.toFixed(2)}, away ×${pa.toFixed(2)}.`);
    }
  }

  const hs = match.home.score || 0;
  const as = match.away.score || 0;
  const remaining = rh + ra;
  const pMoreGoal = 1 - Math.exp(-remaining);

  // Distribution of further goals (Poisson sum of independent Poissons).
  const moreDist = [];
  for (let k = 0; k <= 5; k++) moreDist.push(poisson(k, remaining));
  moreDist[5] = Math.max(0, 1 - moreDist.slice(0, 5).reduce((s, p) => s + p, 0));

  // Final score matrix.
  const scores = [];
  for (let i = 0; i <= MAX_GOALS; i++)
    for (let j = 0; j <= MAX_GOALS; j++)
      scores.push({ home: hs + i, away: as + j, p: poisson(i, rh) * poisson(j, ra) });
  scores.sort((a, b) => b.p - a.p);

  let homeWin = 0, draw = 0, awayWin = 0, over25 = 0, btts = 0;
  for (const s of scores) {
    if (s.home > s.away) homeWin += s.p;
    else if (s.home < s.away) awayWin += s.p;
    else draw += s.p;
    if (s.home + s.away > 2.5) over25 += s.p;
    if (s.home > 0 && s.away > 0) btts += s.p;
  }

  const mostLikelyMore = moreDist.indexOf(Math.max(...moreDist));
  let verdict;
  if (match.state === 'post') verdict = 'Full time';
  else if (pMoreGoal >= 0.75) verdict = 'Goal very likely';
  else if (pMoreGoal >= 0.55) verdict = 'Goal likely';
  else if (pMoreGoal >= 0.35) verdict = 'Could go either way';
  else verdict = 'Goal unlikely';

  return {
    verdict,
    pMoreGoal,
    expectedMore: remaining,
    expectedMoreHome: rh,
    expectedMoreAway: ra,
    expectedFinalTotal: hs + as + remaining,
    mostLikelyMore,
    moreDist,
    topScores: scores.slice(0, 4),
    outcome: { homeWin, draw, awayWin },
    over25,
    btts,
    fullMatch: { home: fullHome, away: fullAway },
    ratings: { home: ratings(home, sh), away: ratings(away, sa) },
    strength: { home: sh, away: sa },
    h2h,
    factors,
  };
}
