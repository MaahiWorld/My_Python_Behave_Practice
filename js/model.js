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

// ---- Match clock ----
// Phases: H1 first half, HT half time, H2 second half, BREAK_ET break before extra time,
// ET extra time, PEN penalty shoot-out. About 45% of goals come in the first half and 55% in the
// second. Halves are modelled with typical added time: first half to 47', second half to 96'.
// Extra time is 30 minutes (+2 added) at a slightly lower scoring rate than the second half.
const H1_END = 47, H2_END = 96, ET_END = 122;
const RATE_H1 = 0.45 / H1_END, RATE_H2 = 0.55 / (H2_END - 45), RATE_ET = 0.0095;
export const phaseOf = (match) => {
  if (match.state !== 'in') return null;
  if (match.phase) return match.phase;
  const m = match.minute || 0;
  return match.detail === 'HT' ? 'HT' : m <= 45 ? 'H1' : m <= 100 ? 'H2' : 'ET';
};
const rem1 = (m) => RATE_H1 * Math.max(0, H1_END - m) + 0.55;
const rem2 = (m) => RATE_H2 * Math.max(0, H2_END - Math.max(45, m));
const remET = (m) => RATE_ET * Math.max(0, ET_END - Math.max(90, m));

// Share of a full match's goal expectancy still to come.
export function remainingShare(minute, state, phase) {
  if (state === 'pre') return 1;
  if (state === 'post') return 0;
  const m = clamp(minute || 0, 0, 130);
  switch (phase || (m <= 45 ? 'H1' : m <= 100 ? 'H2' : 'ET')) {
    case 'H1': return rem1(m);
    case 'HT': return 0.55;
    case 'H2': return Math.max(rem2(m), RATE_H2); // at least ~1 minute of added time
    case 'BREAK_ET': return remET(90);
    case 'ET': return Math.max(remET(m), RATE_ET);
    default: return 0; // PEN: shoot-out goals are not match goals
  }
}

// Share of a full match's goal expectancy in the next n minutes of play.
export function windowShare(minute, n, phase) {
  const m = clamp(minute || 0, 0, 130);
  switch (phase || (m <= 45 ? 'H1' : m <= 100 ? 'H2' : 'ET')) {
    case 'H1': return m + n <= H1_END ? rem1(m) - rem1(m + n) : rem1(m) - 0.55 + (0.55 - rem2(45 + (m + n - H1_END)));
    case 'HT': return 0.55 - rem2(45 + n);
    case 'H2': return m + n >= H2_END ? remainingShare(m, 'in', 'H2') : rem2(m) - rem2(m + n);
    case 'BREAK_ET': return remET(90) - remET(90 + n);
    case 'ET': return m + n >= ET_END ? remainingShare(m, 'in', 'ET') : remET(m) - remET(m + n);
    default: return 0;
  }
}

const PHASE_TEXT = {
  H1: (m) => `${m} minutes played in the first half. The rest of this half and the whole second half are still to come`,
  HT: () => 'Half time. The whole second half is still to come, and it usually produces more goals than the first',
  H2: (m) => (m >= 90 ? `${m} minutes played: we're in added time, so only a minute or two of play is likely left`
    : `${m} minutes played in the second half; about ${H2_END - m} minutes remain including typical added time`),
  BREAK_ET: () => 'Normal time has ended level and 30 minutes of extra time are about to start',
  ET: (m) => `${m} minutes played, in extra time; about ${Math.max(1, ET_END - m)} minutes remain`,
  PEN: () => 'The match has gone to a penalty shoot-out. Shoot-out penalties are not counted as match goals',
};

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

const f2 = (v) => v.toFixed(2);
const vsAvg = (x) => {
  const d = Math.round((x - 1) * 100);
  return d === 0 ? 'exactly league average' : `${Math.abs(d)}% ${d > 0 ? 'above' : 'below'} league average`;
};
const perGame = (t, k) => (t && t.gp ? (t[k] / t.gp).toFixed(2) : null);
function formLine(form) {
  if (!form?.length) return null;
  const gf = form.reduce((s, g) => s + g.gf, 0);
  const ga = form.reduce((s, g) => s + g.ga, 0);
  return `last ${form.length}: ${form.map((g) => g.res).join('')}, scored ${gf}, conceded ${ga}`;
}

// Confidence in the inputs: how much real evidence fed the model.
function confidence(match, detail, h2h) {
  const have = [], missing = [];
  const t = detail.table || {};
  if (t.home?.gp >= 5 && t.away?.gp >= 5) have.push('season goal records for both teams');
  else missing.push('season goal records (cup game or early season)');
  if (detail.form?.home?.length && detail.form?.away?.length) have.push('recent form for both teams');
  else missing.push('recent form');
  if (h2h.n >= 3) have.push(`${h2h.n} head-to-head meetings`);
  else missing.push('enough head-to-head history');
  if (match.state === 'in') {
    const ls = detail.liveStats?.home;
    if (ls && Number.isFinite(ls.xg)) have.push('live xG');
    else if (ls && Number.isFinite(ls.shotsOnTarget)) have.push('live shot data');
    else missing.push('live shot data');
  }
  const score = have.length / (have.length + missing.length);
  return { level: score >= 0.75 ? 'High' : score >= 0.45 ? 'Medium' : 'Low', have, missing };
}

export function predict(match, detail = {}) {
  const mu = detail.leagueAvg || DEFAULT_LEAGUE_AVG;
  const home = { ...match.home, form: detail.form?.home, table: detail.table?.home };
  const away = { ...match.away, form: detail.form?.away, table: detail.table?.away };
  const H = home.short || home.name;
  const A = away.short || away.name;
  const sh = teamStrength(home, mu);
  const sa = teamStrength(away, mu);
  const reasons = [];
  let rh, ra;
  // Records one reasoning step and how much it moved the expected goals still to come.
  const step = (r, fn) => {
    const before = rh + ra;
    fn();
    const delta = rh + ra - before;
    reasons.push({ ...r, delta, impact: Math.abs(delta) < 0.02 ? 'neutral' : delta > 0 ? 'up' : 'down' });
  };

  // 1. Baseline: an average match in this league.
  rh = mu * HOME_ADV;
  ra = mu / HOME_ADV;
  reasons.push({
    key: 'baseline', title: 'Starting point: an average match', delta: rh + ra, impact: 'neutral',
    short: `league average ${f2(mu * 2)} goals/match`,
    detail: `An average team in this competition scores ${f2(mu)} goals per match${detail.leagueAvg ? ' (from this season\'s table)' : ' (typical top-flight figure; no table available)'}. ` +
      `Home sides score about 10% more and away sides about 10% less, so we start from ${f2(rh)} for ${H} and ${f2(ra)} for ${A}: ${f2(rh + ra)} goals in a full match.`,
  });

  // 2. Attack vs defence.
  step({
    key: 'strength', title: 'Attacking power vs defensive strength',
    short: (() => {
      const best = [[sh.att, `${H} score`], [sa.att, `${A} score`], [sh.def, `${H} concede`], [sa.def, `${A} concede`]]
        .sort((x, y) => Math.abs(y[0] - 1) - Math.abs(x[0] - 1))[0];
      return `${best[1]} ${vsAvg(best[0]).replace('league average', 'avg')}`;
    })(),
    detail: `${H} score at a rate ${vsAvg(sh.att)} and concede at a rate ${vsAvg(sh.def)}. ` +
      `${A} score at a rate ${vsAvg(sa.att)} and concede at a rate ${vsAvg(sa.def)}. ` +
      `Each side's expected goals = its attack × the opponent's defence, giving ${f2(rh * sh.att * sa.def)} for ${H} and ${f2(ra * sa.att * sh.def)} for ${A}.`,
    evidence: [
      perGame(home.table, 'gf') && `${H} season: ${perGame(home.table, 'gf')} scored, ${perGame(home.table, 'ga')} conceded per game over ${home.table.gp} games`,
      formLine(home.form) && `${H} ${formLine(home.form)}`,
      perGame(away.table, 'gf') && `${A} season: ${perGame(away.table, 'gf')} scored, ${perGame(away.table, 'ga')} conceded per game over ${away.table.gp} games`,
      formLine(away.form) && `${A} ${formLine(away.form)}`,
      'Season record weighted 70%, last 5 games 30%; small samples are pulled toward average so one big result can\'t dominate.',
    ].filter(Boolean),
  }, () => { rh *= sh.att * sa.def; ra *= sa.att * sh.def; });

  // 3. Head to head.
  const h2h = h2hSummary(detail.h2h, match.home.id);
  if (h2h.n >= 2) {
    const w = (Math.min(h2h.n, 6) / 6) * 0.25;
    const modelTotal = rh + ra;
    const adj = clamp(1 + w * (h2h.avgGoals / modelTotal - 1), 0.8, 1.25);
    step({
      key: 'h2h', title: 'Head-to-head history',
      short: `past meetings average ${h2h.avgGoals.toFixed(1)} goals`,
      detail: `Their last ${h2h.n} meetings averaged ${h2h.avgGoals.toFixed(1)} goals, ${h2h.avgGoals > modelTotal ? 'more' : 'fewer'} than the ${f2(modelTotal)} the form figures predict. ` +
        `Meetings between the same two clubs carry some stylistic signal but are small samples, so they get a ${Math.round(w * 100)}% weight: expected goals ×${f2(adj)}.`,
      evidence: [`${H} won ${h2h.homeWins}, ${h2h.draws} drawn, ${A} won ${h2h.awayWins}`, `Both teams scored in ${h2h.btts} of ${h2h.n}`],
    }, () => { rh *= adj; ra *= adj; });
  }
  const fullHome = rh;
  const fullAway = ra;

  // 4. Time left.
  const live = match.state === 'in';
  const minute = live ? match.minute || 0 : 0;
  const phase = phaseOf(match);
  const share = remainingShare(minute, match.state, phase);
  if (live) {
    step({
      key: 'time', title: 'Time remaining',
      short: phase === 'HT' ? 'half time' : phase === 'PEN' ? 'penalty shoot-out' : phase === 'ET' || phase === 'BREAK_ET' ? 'extra time' : `${Math.max(1, 96 - minute)} min left`,
      detail: `${PHASE_TEXT[phase](minute)}. About 45% of goals come in the first half and 55% in the second, so ${Math.round(share * 100)}% of a normal match's expected goals are still to come.`,
    }, () => { rh *= share; ra *= share; });

    // 5. Scoreline.
    const diff = (match.home.score || 0) - (match.away.score || 0);
    if (diff !== 0) {
      const k = Math.min(Math.abs(diff), 2);
      const trail = 1 + 0.12 * k;
      const lead = 1 - 0.06 * k;
      const trailer = diff > 0 ? A : H;
      const leader = diff > 0 ? H : A;
      step({
        key: 'score', title: 'Game state',
        short: `${trailer} chasing the game`,
        detail: `${trailer} are ${Math.abs(diff)} down and will commit more players forward (their scoring rate ×${f2(trail)}), while ${leader} tend to protect the lead (×${f2(lead)}). The number on the right is the net effect on total goals.`,
      }, () => { if (diff > 0) { rh *= lead; ra *= trail; } else { rh *= trail; ra *= lead; } });
    } else {
      reasons.push({ key: 'score', title: 'Game state', delta: 0, impact: 'neutral', short: 'level game',
        detail: 'The scores are level, so neither side is forced to chase the game; no adjustment.' });
    }

    // 6. Red cards.
    const redH = Math.max(match.home.redCards || 0, detail.redCards?.home || 0);
    const redA = Math.max(match.away.redCards || 0, detail.redCards?.away || 0);
    if (redH || redA) {
      step({
        key: 'red', title: 'Red cards',
        short: `${redH ? H : A} down to ${11 - (redH || redA)} men`,
        detail: `${[redH && `${H} have had ${redH} sent off`, redA && `${A} have had ${redA} sent off`].filter(Boolean).join(' and ')}. ` +
          'A team a player down typically scores about 30% less and concedes about 20% more for the rest of the match.',
      }, () => {
        rh *= Math.pow(0.7, redH) * Math.pow(1.2, redA);
        ra *= Math.pow(0.7, redA) * Math.pow(1.2, redH);
      });
    }

    // 7. Live chance quality: expected goals (xG) when the source has it, otherwise shots on target.
    const lh = detail.liveStats?.home, la = detail.liveStats?.away;
    if (Number.isFinite(lh?.xg) && Number.isFinite(la?.xg) && minute >= 10) {
      const w = clamp(minute / 90, 0, 1) * 0.6;
      const played = ['ET', 'BREAK_ET', 'PEN'].includes(phase) ? 1 + Math.max(0, minute - 90) / 90 : 1 - share;
      const soFarH = fullHome * played, soFarA = fullAway * played;
      const xf = (xg, exp) => 1 + (clamp(exp > 0 ? xg / exp : 1, 0.5, 2) - 1) * w;
      const xh = xf(lh.xg, soFarH), xa = xf(la.xg, soFarA);
      step({
        key: 'xg', title: 'Live chance quality (xG)',
        short: xh * xa >= 1 ? 'creating better chances than expected' : 'chances below expected so far',
        detail: `Expected goals (xG) rates every chance by how often similar chances are scored, so it shows how dangerous a team has really been. ` +
          `So far ${H} have ${f2(lh.xg)} xG (the model expected about ${f2(soFarH)} by now) and ${A} have ${f2(la.xg)} xG (expected ${f2(soFarA)}). ` +
          `Teams creating more than expected tend to keep doing so; this is trusted more as the match goes on: ${H} ×${f2(xh)}, ${A} ×${f2(xa)}.`,
        evidence: [lh.shotsOnTarget != null && `Shots on target ${lh.shotsOnTarget}–${la.shotsOnTarget ?? 0}`, lh.possession != null && `Possession ${lh.possession}%–${la.possession ?? 0}%`].filter(Boolean),
      }, () => { rh *= xh; ra *= xa; });
    } else {
      const ph = pressureFactor(lh, minute);
      const pa = pressureFactor(la, minute);
      if (ph !== 1 || pa !== 1) {
        const pace = (s) => (s.shotsOnTarget / minute * 90).toFixed(1);
        step({
          key: 'pressure', title: 'Live attacking pressure',
          short: ph * pa >= 1 ? 'shots on target above normal pace' : 'few shots on target so far',
          detail: `Shots on target are the best live sign of chances being created. ${H} have ${lh.shotsOnTarget} (on pace for ${pace(lh)} per 90) and ${A} have ${la?.shotsOnTarget ?? 0} (${la ? pace(la) : '0.0'} per 90); a typical side manages about 4.5. ` +
            `The further into the match, the more this is trusted: ${H} ×${f2(ph)}, ${A} ×${f2(pa)}.`,
          evidence: [lh?.shots != null && `Total shots ${lh.shots}–${la?.shots ?? 0}`, lh?.possession != null && `Possession ${lh.possession}%–${la?.possession ?? 0}%`].filter(Boolean),
        }, () => { rh *= ph; ra *= pa; });
      }
    }
  }
  if (match.state === 'post') { rh = 0; ra = 0; }
  const conf = confidence(match, detail, h2h);

  const hs = match.home.score || 0;
  const as = match.away.score || 0;
  const remaining = rh + ra;

  // Short-term outlook: goal intensity per unit of "match share", applied to the next windows.
  let pNext15 = null, expectedNext15 = null, medianNextGoal = null;
  if (live) {
    const intensity = share > 0 ? remaining / share : 0;
    expectedNext15 = intensity * windowShare(minute, 15, phase);
    pNext15 = 1 - Math.exp(-expectedNext15);
    // Minutes until there is a 50% chance a goal has come (median wait), if within the match.
    for (let n = 1; n <= 80; n++) {
      if (intensity * windowShare(minute, n, phase) >= Math.LN2) { medianNextGoal = n; break; }
    }
  }
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
  else if (phase === 'PEN') verdict = 'Penalty shoot-out';
  else if (live && pNext15 >= 0.5) verdict = 'Goal expected soon';
  else if (pMoreGoal >= 0.75) verdict = 'Goal very likely';
  else if (pMoreGoal >= 0.55) verdict = 'Goal likely';
  else if (pMoreGoal >= 0.35) verdict = 'Could go either way';
  else verdict = 'Goal unlikely';

  return {
    verdict,
    pMoreGoal,
    pNext15,
    phase,
    expectedNext15,
    medianNextGoal,
    soonLevel: pNext15 == null ? null : pNext15 >= 0.5 ? 'hot' : pNext15 >= 0.35 ? 'warm' : 'quiet',
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
    reasons,
    confidence: conf,
    summary: reasons.filter((r) => !['baseline', 'time'].includes(r.key) && r.impact !== 'neutral')
      .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta)).slice(0, 2).map((r) => r.short),
  };
}
