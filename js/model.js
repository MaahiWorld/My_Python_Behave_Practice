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

const PHASE_TEXT = {
  H1: (m) => `${m} minutes played in the first half. The rest of this half and the whole second half are still to come`,
  HT: () => 'Half time. The whole second half is still to come, and it usually produces more goals than the first',
  H2: (m) => (m >= 90 ? `${m} minutes played: we're in added time, so only a minute or two of play is likely left`
    : `${m} minutes played in the second half; about ${H2_END - m} minutes remain including typical added time`),
  BREAK_ET: () => 'Normal time has ended level and 30 minutes of extra time are about to start',
  ET: (m) => `${m} minutes played, in extra time; about ${Math.max(1, ET_END - m)} minutes remain`,
  PEN: () => 'The match has gone to a penalty shoot-out. Shoot-out penalties are not counted as match goals',
};

// Attack / defence multipliers (1.0 = league average). Small samples are pulled toward average.
export function seasonStrength(t, mu = DEFAULT_LEAGUE_AVG) {
  if (!t || !(t.gp > 0)) return null;
  const K = 4;
  return {
    att: clamp(((t.gf / t.gp / mu) * t.gp + K) / (t.gp + K), 0.35, 2.8),
    def: clamp(((t.ga / t.gp / mu) * t.gp + K) / (t.gp + K), 0.35, 2.8),
  };
}
export function formStrength(form, mu = DEFAULT_LEAGUE_AVG) {
  const f = (form || []).slice(0, 5);
  if (!f.length) return null;
  const n = f.length, K = 2;
  const gf = f.reduce((s, g) => s + g.gf, 0), ga = f.reduce((s, g) => s + g.ga, 0);
  const pts = f.reduce((s, g) => s + (g.res === 'W' ? 3 : g.res === 'D' ? 1 : 0), 0);
  return {
    att: clamp(((gf / n / mu) * n + K) / (n + K), 0.35, 2.8),
    def: clamp(((ga / n / mu) * n + K) / (n + K), 0.35, 2.8),
    n, gf, ga, pts, results: f.map((g) => g.res).join(''),
  };
}
// How far recent form moves a team away from its season level (35% weight when a season record
// exists; recent form is all we have otherwise).
const FORM_WEIGHT = 0.35;
function formAdjust(season, form) {
  if (!form) return { att: 1, def: 1 };
  if (!season) return { att: form.att, def: form.def };
  return {
    att: clamp(1 + FORM_WEIGHT * (form.att / season.att - 1), 0.6, 1.6),
    def: clamp(1 + FORM_WEIGHT * (form.def / season.def - 1), 0.6, 1.6),
  };
}
// Combined attack / defence (season level adjusted by recent form), used for the ratings bars.
export function teamStrength(team, leagueAvg = DEFAULT_LEAGUE_AVG) {
  const mu = leagueAvg || DEFAULT_LEAGUE_AVG;
  const season = seasonStrength(team.table, mu);
  const form = formStrength(team.form, mu);
  const adj = formAdjust(season, form);
  if (!season && !form) return { att: 1, def: 1, source: 'none', season, form, adj };
  return {
    att: clamp((season?.att ?? 1) * adj.att, 0.35, 2.8),
    def: clamp((season?.def ?? 1) * adj.def, 0.35, 2.8),
    source: season && form ? 'table+form' : season ? 'table' : 'form', season, form, adj,
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

// Current match stats: each team's attacking output so far compared with a typical team's pace.
// Typical per team per 90 minutes: 12.5 shots, 4.3 on target, 5 corners, 50% possession.
const TYPICAL = { shots: 12.5, shotsOnTarget: 4.3, corners: 5 };
export function liveThreat(stats, minute, expectedSoFar) {
  if (!stats || minute < 10) return null;
  const mins = Math.max(10, minute);
  const parts = [];
  const xg = Number.isFinite(stats.xg);
  if (xg && expectedSoFar > 0) parts.push({ k: 'xG', w: 0.5, r: stats.xg / expectedSoFar, txt: `${stats.xg.toFixed(2)} xG (about ${expectedSoFar.toFixed(2)} expected by now)` });
  for (const [k, label, w, wx] of [['shotsOnTarget', 'shots on target', 0.45, 0.25], ['shots', 'shots', 0.25, 0.15], ['corners', 'corners', 0.15, 0.05]]) {
    if (!Number.isFinite(stats[k])) continue;
    const pace = (stats[k] / mins) * 90;
    parts.push({ k, w: xg ? wx : w, r: pace / TYPICAL[k], txt: `${stats[k]} ${label} (on pace for ${pace.toFixed(1)} per 90; typical ${TYPICAL[k]})` });
  }
  if (Number.isFinite(stats.possession)) parts.push({ k: 'possession', w: xg ? 0.05 : 0.15, r: stats.possession / 50, txt: `${stats.possession}% possession` });
  if (!parts.length) return null;
  const wSum = parts.reduce((s, p) => s + p.w, 0);
  const raw = parts.reduce((s, p) => s + clamp(p.r, 0.4, 2.2) * p.w, 0) / wSum;
  const trust = clamp(minute / 90, 0, 1) * (xg ? 0.6 : 0.5); // trusted more as the match goes on
  return { factor: clamp(1 + (raw - 1) * trust, 0.6, 1.6), raw, trust, parts, hasXg: xg };
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

// Confidence in the inputs. "High" needs every core input:
//  - season attacking/defensive records for both teams (5+ games each)
//  - recent form for both teams (4+ matches each)
//  - for live matches from 10', current match stats for both teams
// Head-to-head history is a bonus, not required.
export function confidence(match, detail, h2h) {
  const have = [], missing = [];
  const t = detail.table || {};
  const core = [];
  const seasonOk = t.home?.gp >= 5 && t.away?.gp >= 5;
  core.push(seasonOk);
  (seasonOk ? have : missing).push(seasonOk ? 'attacking and defensive records for both teams' : 'season attacking/defensive records for both teams (cup game or early season)');
  const formOk = (detail.form?.home?.length || 0) >= 4 && (detail.form?.away?.length || 0) >= 4;
  core.push(formOk);
  (formOk ? have : missing).push(formOk ? 'recent form for both teams' : 'recent form for both teams');
  if (match.state === 'in' && (match.minute || 0) >= 10 && phaseOf(match) !== 'PEN') {
    const ok = (s) => s && (Number.isFinite(s.xg) || Number.isFinite(s.shotsOnTarget) || Number.isFinite(s.shots));
    const liveOk = ok(detail.liveStats?.home) && ok(detail.liveStats?.away);
    core.push(liveOk);
    if (liveOk) have.push(Number.isFinite(detail.liveStats.home.xg) ? 'current match stats with xG' : 'current match stats');
    else missing.push('current match stats');
  }
  if (h2h.n >= 3) have.push(`${h2h.n} head-to-head meetings`);
  const okCount = core.filter(Boolean).length;
  const level = okCount === core.length ? 'High' : okCount >= core.length - 1 ? 'Medium' : 'Low';
  return { level, have, missing };
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

  // 2. Attacking power vs defensive strength (season record).
  const ssH = sh.season, ssA = sa.season;
  if (ssH || ssA) {
    const hA = ssH?.att ?? 1, hD = ssH?.def ?? 1, aA = ssA?.att ?? 1, aD = ssA?.def ?? 1;
    step({
      key: 'strength', title: 'Attacking power vs defensive strength',
      short: (() => {
        const best = [[hA, `${H} score`], [aA, `${A} score`], [hD, `${H} concede`], [aD, `${A} concede`]]
          .sort((x, y) => Math.abs(y[0] - 1) - Math.abs(x[0] - 1))[0];
        return `${best[1]} ${vsAvg(best[0]).replace('league average', 'avg')}`;
      })(),
      detail: `Over the season, ${H} ${ssH ? `score at a rate ${vsAvg(hA)} and concede at a rate ${vsAvg(hD)}` : 'have no season record here (treated as average)'}; ` +
        `${A} ${ssA ? `score at a rate ${vsAvg(aA)} and concede at a rate ${vsAvg(aD)}` : 'have no season record here (treated as average)'}. ` +
        `Each side's goals come from its attacking power against the other's defence: ${H}'s attack × ${A}'s defence gives ${f2(rh * hA * aD)}, ` +
        `${A}'s attack × ${H}'s defence gives ${f2(ra * aA * hD)}.`,
      evidence: [
        perGame(home.table, 'gf') && `${H}: ${perGame(home.table, 'gf')} scored, ${perGame(home.table, 'ga')} conceded per game over ${home.table.gp} games`,
        perGame(away.table, 'gf') && `${A}: ${perGame(away.table, 'gf')} scored, ${perGame(away.table, 'ga')} conceded per game over ${away.table.gp} games`,
        'Small samples are pulled toward average so a few big results can\'t dominate.',
      ].filter(Boolean),
    }, () => { rh *= hA * aD; ra *= aA * hD; });
  } else {
    reasons.push({ key: 'strength', title: 'Attacking power vs defensive strength', delta: 0, impact: 'neutral', short: 'no season record',
      detail: 'No season goal record is available for these teams (a cup tie or very early in the season), so attacking and defensive power are judged from recent form below.' });
  }

  // 3. Recent form (last 5 matches).
  const fH = sh.form, fA = sa.form;
  if (fH || fA) {
    const jH = sh.adj, jA = sa.adj;
    const desc = (name, f, season) => {
      if (!f) return `${name}: no recent results available`;
      const pace = f.gf / f.n, conc = f.ga / f.n;
      const vs = season ? ` against a season rate of ${f2(season.att * mu)} scored and ${f2(season.def * mu)} conceded` : '';
      return `${name} ${f.results} in the last ${f.n}: ${f.gf} scored (${pace.toFixed(1)} a game) and ${f.ga} conceded (${conc.toFixed(1)} a game)${vs}`;
    };
    const hot = [[jH.att, `${H} scoring more lately`, `${H} scoring less lately`], [jA.att, `${A} scoring more lately`, `${A} scoring less lately`],
      [jH.def, `${H} leaking more goals lately`, `${H} tighter at the back lately`], [jA.def, `${A} leaking more goals lately`, `${A} tighter at the back lately`]]
      .sort((x, y) => Math.abs(y[0] - 1) - Math.abs(x[0] - 1))[0];
    step({
      key: 'form', title: 'Recent form',
      short: Math.abs(hot[0] - 1) < 0.03 ? 'form in line with season' : hot[0] > 1 ? hot[1] : hot[2],
      detail: `${desc(H, fH, ssH)}. ${desc(A, fA, ssA)}. ` +
        (ssH || ssA ? `Recent form counts for ${Math.round(FORM_WEIGHT * 100)}% against the season level, so a hot or cold run shifts the picture without overriding it.`
          : 'With no season record, recent form sets attacking and defensive power on its own.'),
      evidence: [fH && `${H} form points: ${fH.pts}/${fH.n * 3}`, fA && `${A} form points: ${fA.pts}/${fA.n * 3}`].filter(Boolean),
    }, () => { rh *= jH.att * jA.def; ra *= jA.att * jH.def; });
  } else {
    reasons.push({ key: 'form', title: 'Recent form', delta: 0, impact: 'neutral', short: 'no recent results',
      detail: 'No recent results are available for these teams, so form makes no adjustment.' });
  }

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

    // 7. Current match stats.
    const played = ['ET', 'BREAK_ET', 'PEN'].includes(phase) ? 1 + Math.max(0, minute - 90) / 90 : 1 - share;
    const th = liveThreat(detail.liveStats?.home, minute, fullHome * played);
    const ta = liveThreat(detail.liveStats?.away, minute, fullAway * played);
    if ((th || ta) && phase !== 'PEN') {
      const fh = th?.factor ?? 1, fa = ta?.factor ?? 1;
      const word = (t) => (!t ? 'no stats' : t.raw >= 1.15 ? 'well above a typical pace' : t.raw >= 1.03 ? 'slightly above a typical pace' : t.raw > 0.97 ? 'at a typical pace' : t.raw > 0.85 ? 'slightly below a typical pace' : 'well below a typical pace');
      step({
        key: 'live', title: 'Current match stats',
        short: fh * fa >= 1.03 ? (fh >= fa ? `${H} creating plenty` : `${A} creating plenty`) : fh * fa <= 0.97 ? 'few chances created so far' : 'chances at a normal rate',
        detail: `What has happened in this match so far: ${H} are attacking ${word(th)} and ${A} ${word(ta)}. ` +
          `${th?.hasXg || ta?.hasXg ? 'Expected goals (xG) rates every chance by how often similar chances are scored, so it carries the most weight, with shots, corners and possession adding detail. ' : 'Shots on target carry the most weight, then total shots, corners and possession. '}` +
          `These stats are trusted more as the match goes on (${Math.round((th?.trust ?? ta?.trust ?? 0) * 100)}% weight at ${minute}'): ${H}'s scoring rate ×${f2(fh)}, ${A}'s ×${f2(fa)}.`,
        evidence: [...(th?.parts || []).map((p) => `${H}: ${p.txt}`), ...(ta?.parts || []).map((p) => `${A}: ${p.txt}`)],
      }, () => { rh *= fh; ra *= fa; });
    } else if (phase !== 'PEN') {
      reasons.push({ key: 'live', title: 'Current match stats', delta: 0, impact: 'neutral', short: minute < 10 ? 'too early for match stats' : 'no match stats',
        detail: minute < 10 ? 'Fewer than 10 minutes played, too early for match stats to say anything reliable.' : 'This data source has no live match statistics for this game, so no adjustment.' });
    }
  }
  if (match.state === 'post') { rh = 0; ra = 0; }
  const conf = confidence(match, detail, h2h);

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

  let homeWin = 0, draw = 0, awayWin = 0, over15 = 0, over25 = 0, btts = 0;
  for (const s of scores) {
    if (s.home > s.away) homeWin += s.p;
    else if (s.home < s.away) awayWin += s.p;
    else draw += s.p;
    if (s.home + s.away > 1.5) over15 += s.p;
    if (s.home + s.away > 2.5) over25 += s.p;
    if (s.home > 0 && s.away > 0) btts += s.p;
  }

  const mostLikelyMore = moreDist.indexOf(Math.max(...moreDist));
  let verdict;
  if (match.state === 'post') verdict = 'Full time';
  else if (phase === 'PEN') verdict = 'Penalty shoot-out';
  else if (pMoreGoal >= 0.75) verdict = 'Goal very likely';
  else if (pMoreGoal >= 0.55) verdict = 'Goal likely';
  else if (pMoreGoal >= 0.35) verdict = 'Could go either way';
  else verdict = 'Goal unlikely';

  return {
    verdict,
    pMoreGoal,
    phase,
    // How much goal scope is left from this point to the end: high / medium / low.
    scopeLevel: match.state === 'post' || phase === 'PEN' ? 'low' : pMoreGoal >= 0.75 ? 'high' : pMoreGoal >= 0.5 ? 'medium' : 'low',
    expectedMore: remaining,
    expectedMoreHome: rh,
    expectedMoreAway: ra,
    expectedFinalTotal: hs + as + remaining,
    mostLikelyMore,
    moreDist,
    topScores: scores.slice(0, 4),
    outcome: { homeWin, draw, awayWin },
    over15,
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
