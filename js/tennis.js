// Tennis predictions (experimental): match winner, underdog to win a set, total sets, total games.
//
// Model: each player's chance of winning a point on serve drives a point → game → set → match
// Markov chain (standard tiebreak at 6–6 in every set). Pre-match, the two serve strengths are set so
// the match-winner chance equals a ranking-based estimate; live, the chain starts from the current
// set and game score. Only what the free ESPN feed provides is used: world rankings and the score.
// There is no serve/return history, surface record or head-to-head, and the model has not been
// backtested (no free historical tennis data was reachable when it was built), so every pick is
// recorded and checked on the Results page to build a track record.
import { BASE, getJSON, cached, num, ymd } from './api.js';
import { addRecords, updateRecords } from './records.js';

export const TENNIS_PARAMS = {
  serveBase: { atp: 0.64, wta: 0.56 }, // average share of service points won
  rankPower: 0.5, // P(A beats B, best of 3) = 1 / (1 + (rankA / rankB)^power)
  maxRank: 400, // beyond this, rankings say too little for a pick
};
export const TENNIS_RULES = { minProb: 0.75 };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---- Point → game → set → match ----
export function holdProb(p) {
  const q = 1 - p;
  return p ** 4 * (1 + 4 * q + 10 * q * q) + 20 * p ** 3 * q ** 3 * (p * p / (1 - 2 * p * q));
}

// Chance A wins a 7-point tiebreak in which A serves first. pa / pb: each player's serve-point win rate.
export function tiebreakProb(pa, pb) {
  const memo = new Map();
  const f = (a, b) => {
    if (a >= 7 && a - b >= 2) return 1;
    if (b >= 7 && b - a >= 2) return 0;
    if (a >= 6 && a === b) { const w = pa * (1 - pb), l = (1 - pa) * pb; return w / (w + l); }
    const k = `${a},${b}`;
    if (memo.has(k)) return memo.get(k);
    const n = a + b;
    const aServes = n === 0 || Math.floor((n - 1) / 2) % 2 === 1;
    const pw = aServes ? pa : 1 - pb;
    const v = pw * f(a + 1, b) + (1 - pw) * f(a, b + 1);
    memo.set(k, v);
    return v;
  };
  return f(0, 0);
}

export const setDone = (x, y) => (Math.max(x, y) >= 6 && Math.abs(x - y) >= 2) || Math.max(x, y) >= 7;

function chain(pa, pb) {
  const hA = holdProb(pa), hB = holdProb(pb);
  const tbA = tiebreakProb(pa, pb), tbB = 1 - tiebreakProb(pb, pa);
  const memo = new Map();
  // Outcomes of the rest of a set from (ga, gb) with aServes serving the next game: [{ a, g, p }]
  const set = (ga, gb, aServes) => {
    if (setDone(ga, gb)) return [{ a: ga > gb, g: ga + gb, p: 1 }];
    if (ga === 6 && gb === 6) { const t = aServes ? tbA : tbB; return [{ a: true, g: 13, p: t }, { a: false, g: 13, p: 1 - t }]; }
    const k = `${ga},${gb},${aServes}`;
    if (memo.has(k)) return memo.get(k);
    const pw = aServes ? hA : 1 - hB;
    const acc = new Map();
    for (const [w, next] of [[pw, set(ga + 1, gb, !aServes)], [1 - pw, set(ga, gb + 1, !aServes)]]) {
      for (const o of next) {
        const kk = `${o.a}|${o.g}`;
        const cur = acc.get(kk) || { a: o.a, g: o.g, p: 0 };
        cur.p += w * o.p;
        acc.set(kk, cur);
      }
    }
    const out = [...acc.values()];
    memo.set(k, out);
    return out;
  };
  return { set };
}

// Full distribution of the rest of a match. state: { setsA, setsB, games (in finished sets), cur: [ga, gb] }.
// Who serves next is not in the feed, so both possibilities are averaged.
export function matchDist(pa, pb, bestOf = 3, state = {}) {
  const need = Math.ceil(bestOf / 2);
  const { set } = chain(pa, pb);
  const [ga, gb] = state.cur || [0, 0];
  let frontier = new Map();
  const add = (m, sa, sb, aServes, games, p) => {
    const k = `${sa}|${sb}|${aServes}|${games}`;
    const cur = m.get(k);
    if (cur) cur.p += p; else m.set(k, { sa, sb, aServes, games, p });
  };
  const sa0 = state.setsA || 0, sb0 = state.setsB || 0, g0 = state.games || 0;
  if (sa0 >= need || sb0 >= need) add(frontier, sa0, sb0, true, g0 + ga + gb, 1);
  else {
    for (const aServes of [true, false]) {
      for (const o of set(ga, gb, aServes)) {
        const next = (o.g - ga - gb) % 2 === 0 ? aServes : !aServes;
        add(frontier, sa0 + (o.a ? 1 : 0), sb0 + (o.a ? 0 : 1), next, g0 + o.g, 0.5 * o.p);
      }
    }
  }
  const done = [];
  while (frontier.size) {
    const nextF = new Map();
    for (const s of frontier.values()) {
      if (s.sa >= need || s.sb >= need) { done.push(s); continue; }
      for (const o of set(0, 0, s.aServes)) {
        const next = o.g % 2 === 0 ? s.aServes : !s.aServes;
        add(nextF, s.sa + (o.a ? 1 : 0), s.sb + (o.a ? 0 : 1), next, s.games + o.g, s.p * o.p);
      }
    }
    frontier = nextF;
  }
  const res = { pA: 0, sets: {}, games: {}, score: {}, aSet: 0, bSet: 0, expectedGames: 0 };
  for (const s of done) {
    if (s.sa > s.sb) res.pA += s.p;
    const n = s.sa + s.sb;
    res.sets[n] = (res.sets[n] || 0) + s.p;
    res.games[s.games] = (res.games[s.games] || 0) + s.p;
    const sc = `${s.sa}-${s.sb}`;
    res.score[sc] = (res.score[sc] || 0) + s.p;
    if (s.sa > 0) res.aSet += s.p;
    if (s.sb > 0) res.bSet += s.p;
    res.expectedGames += s.games * s.p;
  }
  return res;
}

const overProb = (dist, line) => Object.entries(dist).reduce((s, [k, p]) => s + (+k > line ? p : 0), 0);

// Ranking-based chance that A beats B over best of 3.
export function rankWinProb(rankA, rankB) {
  if (!(rankA > 0) || !(rankB > 0)) return null;
  return 1 / (1 + (rankA / rankB) ** TENNIS_PARAMS.rankPower);
}

// Serve-point strengths that reproduce a best-of-3 win chance for A.
const calCache = new Map();
export function calibrate(pWin, tour = 'atp') {
  const s = TENNIS_PARAMS.serveBase[tour] ?? 0.6;
  const key = `${tour}|${pWin.toFixed(4)}`;
  if (calCache.has(key)) return calCache.get(key);
  let lo = -0.2, hi = 0.2;
  for (let i = 0; i < 30; i++) {
    const d = (lo + hi) / 2;
    if (matchDist(s + d, s - d, 3).pA < pWin) lo = d; else hi = d;
  }
  const d = (lo + hi) / 2;
  const out = { pa: s + d, pb: s - d };
  calCache.set(key, out);
  return out;
}

// Current score from the line scores: finished sets and the set in progress.
export function scoreState(m) {
  const n = Math.max(m.a.sets.length, m.b.sets.length);
  const st = { setsA: 0, setsB: 0, games: 0, cur: [0, 0], sets: [] };
  for (let i = 0; i < n; i++) {
    const x = m.a.sets[i]?.games ?? 0, y = m.b.sets[i]?.games ?? 0;
    st.sets.push([x, y]);
    if (setDone(x, y)) { st.games += x + y; if (x > y) st.setsA++; else st.setsB++; } else if (m.state !== 'post') st.cur = [x, y];
  }
  return st;
}

const LINES = { 3: [16.5, 18.5, 20.5, 22.5, 24.5, 26.5], 5: [30.5, 32.5, 34.5, 36.5, 38.5, 40.5, 42.5] };

export function predictTennis(m) {
  const pre = rankWinProb(m.a.rank, m.b.rank);
  const tour = m.tour === 'wta' ? 'wta' : 'atp';
  const have = [], missing = [];
  (m.a.rank && m.b.rank ? have : missing).push('world rankings for both players');
  const known = pre != null;
  const { pa, pb } = calibrate(known ? pre : 0.5, tour);
  const st = scoreState(m);
  const d = m.state === 'post' ? null : matchDist(pa, pb, m.bestOf, m.state === 'in' ? st : {});
  const fav = (known ? pre : 0.5) >= 0.5 ? 'a' : 'b';
  const dog = fav === 'a' ? 'b' : 'a';
  const ranksOk = known && Math.max(m.a.rank, m.b.rank) <= TENNIS_PARAMS.maxRank;
  return {
    known, preWin: pre, pa, pb, fav, dog, st, dist: d, bestOf: m.bestOf,
    pA: d ? clamp(d.pA, 0, 1) : null, dogSet: d ? clamp(dog === 'a' ? d.aSet : d.bSet, 0, 1) : null,
    setsLine: m.bestOf === 5 ? 3.5 : 2.5,
    overSets: d ? clamp(overProb(d.sets, m.bestOf === 5 ? 3.5 : 2.5), 0, 1) : null,
    gameLines: d ? (LINES[m.bestOf] || LINES[3]).map((line) => ({ line, over: clamp(overProb(d.games, line), 0, 1) })) : [],
    expectedGames: d?.expectedGames,
    topScores: d ? Object.entries(d.score).sort((x, y) => y[1] - x[1]) : [],
    confidence: { level: ranksOk ? 'Medium' : 'Low', have, missing: ranksOk || !known ? missing : ['rankings inside the top 400'] },
  };
}

// ---- Markets ----
const nm = (pl) => pl.short || pl.name;
export const TENNIS_MARKETS = [
  { id: 'tw', tab: 'Winner', name: 'Match winner' },
  { id: 'tset', tab: 'Set', name: 'Underdog to win at least 1 set' },
  { id: 'tsets', tab: 'Sets', name: 'Total sets' },
  { id: 'tgames', tab: 'Games', name: 'Total games' },
];

// Every market's best side for a match: [{ market, side, label, p, status, line? }]
export function tennisMarkets(m, pred = predictTennis(m)) {
  if (m.state === 'post' || !pred.dist) return [];
  const ok = pred.confidence.level !== 'Low';
  const fav = m[pred.fav], dog = m[pred.dog];
  const out = [];
  const push = (market, side, label, p, extra = {}) => {
    const decided = p >= 0.999 || p <= 0.001;
    out.push({ market, side, label, p, ...extra, status: !ok ? 'low-confidence' : decided ? 'decided' : p >= TENNIS_RULES.minProb ? 'pick' : 'low-prob' });
  };
  const pA = pred.pA;
  push('tw', pA >= 0.5 ? 'a' : 'b', `${nm(pA >= 0.5 ? m.a : m.b)} to win`, Math.max(pA, 1 - pA));
  push('tset', pred.dogSet >= 0.5 ? 'yes' : 'no', pred.dogSet >= 0.5 ? `${nm(dog)} to win a set` : `${nm(fav)} in straight sets`, Math.max(pred.dogSet, 1 - pred.dogSet), { dog: pred.dog });
  push('tsets', pred.overSets >= 0.5 ? 'over' : 'under', `${pred.overSets >= 0.5 ? 'Over' : 'Under'} ${pred.setsLine} sets`, Math.max(pred.overSets, 1 - pred.overSets), { line: pred.setsLine });
  // Games: the line closest to an even split among those that clear the bar (most informative pick).
  const cands = pred.gameLines.map((g) => ({ ...g, side: g.over >= 0.5 ? 'over' : 'under', p: Math.max(g.over, 1 - g.over) }))
    .filter((g) => g.p < 0.999);
  const clear = cands.filter((g) => g.p >= TENNIS_RULES.minProb).sort((x, y) => x.p - y.p);
  const g = clear[0] || cands.sort((x, y) => y.p - x.p)[0];
  if (g) push('tgames', g.side, `${g.side === 'over' ? 'Over' : 'Under'} ${g.line} games`, g.p, { line: g.line });
  return out;
}

// Which side won, from a finished match. null = can't settle (retirement, walkover, no score).
export function settleTennisMarket(rec, m) {
  if (m.state !== 'post') return null;
  if (m.void) return { result: 'void', note: m.detail || 'retired / walkover' };
  const st = scoreState(m);
  const sets = st.sets.map(([x, y]) => `${x}-${y}`).join(' ');
  const totalGames = st.sets.reduce((s, [x, y]) => s + x + y, 0);
  const winner = m.a.winner ? 'a' : m.b.winner ? 'b' : st.setsA > st.setsB ? 'a' : st.setsB > st.setsA ? 'b' : null;
  if (!winner) return { result: 'unknown', sets };
  let won;
  if (rec.market === 'tw') won = rec.side === winner;
  else if (rec.market === 'tset') {
    const dogSets = rec.dog === 'a' ? st.setsA : st.setsB;
    won = (rec.side === 'yes') === dogSets > 0;
  } else if (rec.market === 'tsets') won = (rec.side === 'over') === st.setsA + st.setsB > rec.line;
  else if (rec.market === 'tgames') won = (rec.side === 'over') === totalGames > rec.line;
  else return { result: 'unknown', sets };
  return { result: won ? 'won' : 'lost', sets, final: `${st.setsA}-${st.setsB}`, totalGames };
}

export function recordTennisPicks(m, picks) {
  if (!picks.length) return;
  addRecords(picks.map((pk) => ({
    id: `tennis/${m.tour}/${m.id}/${pk.market}`, sport: 'tennis', market: pk.market, side: pk.side, label: pk.label,
    p: Math.round(pk.p * 1000) / 1000, line: pk.line ?? null, dog: pk.dog ?? null,
    match: `${m.a.name} vs ${m.b.name}`, home: nm(m.a), away: nm(m.b), league: m.tour, eventId: m.id,
    leagueName: [m.event, m.round].filter(Boolean).join(' · '), source: 'espn', kickoff: m.date,
    at: Date.now(), minute: null, score: m.state === 'in' ? scoreState(m).sets.map(([x, y]) => `${x}-${y}`).join(' ') : null,
    ranks: [m.a.rank, m.b.rank], result: null,
  })));
}

export function settleTennisPicks(matches) {
  return updateRecords((x) => {
    if (x.sport !== 'tennis' || x.result) return null;
    const m = matches.find((mm) => mm.tour === x.league && mm.id === x.eventId);
    const r = m && settleTennisMarket(x, m);
    if (r) return { ...r, settledAt: Date.now() };
    if (Date.now() - x.at > 10 * 86_400_000) return { result: 'unknown', note: 'result not found' };
    return null;
  });
}

// ---- ESPN tennis feed ----
const SLAMS = /australian open|roland garros|french open|wimbledon|us open/i;
export function parseTennisScoreboard(json, tour) {
  const out = [];
  for (const e of json?.events || []) {
    const event = e.name || e.shortName || '';
    const groups = e.groupings?.length ? e.groupings : [{ grouping: {}, competitions: e.competitions || [] }];
    for (const g of groups) {
      const draw = g.grouping?.displayName || g.grouping?.slug || '';
      if (/doubles|mixed/i.test(draw)) continue;
      for (const c of g.competitions || []) {
        const cs = [...(c.competitors || [])];
        if (cs.length !== 2 || cs.some((x) => x.type === 'team' || x.roster)) continue;
        cs.sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
        const st = c.status || e.status || {};
        const state = st.type?.state || 'pre';
        const pl = (x) => {
          const a = x.athlete || {};
          return {
            id: String(a.id ?? x.id ?? ''), name: a.displayName || a.fullName || x.displayName || 'Player',
            short: a.shortName || a.displayName || 'Player', country: a.flag?.alt || '', flag: a.flag?.href || '',
            rank: num(x.curatedRank?.current) ?? num(x.rank) ?? null, seed: num(x.seed) ?? null, winner: x.winner === true,
            sets: (x.linescores || []).map((l) => ({ games: num(l.value ?? l.displayValue) ?? 0, tb: num(l.tiebreak) })),
          };
        };
        const name = st.type?.name || '', detail = st.type?.shortDetail || st.type?.detail || '';
        const bestOf = num(c.format?.regulation?.periods) || (tour === 'atp' && SLAMS.test(event) && !/women/i.test(draw) ? 5 : 3);
        out.push({
          sport: 'tennis', id: String(c.id), tour, league: tour, event, eventId: String(e.id), draw,
          round: c.round?.displayName || '', date: c.date || e.date, state, detail, bestOf,
          void: state === 'post' && /RETIRED|WALKOVER|ABANDON|CANCEL|DEFAULT|FORFEIT/i.test(`${name} ${detail}`),
          a: pl(cs[0]), b: pl(cs[1]),
        });
      }
    }
  }
  return out;
}

// World rankings: athlete id → rank, from wherever the payload keeps them.
export function parseRankings(json) {
  const out = {};
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const id = node.athlete?.id;
    const r = num(node.current ?? node.rank);
    if (id != null && r != null) { out[String(id)] = r; return; }
    Object.values(node).forEach(walk);
  };
  walk(json);
  return out;
}

export const TOURS = [['atp', 'ATP'], ['wta', 'WTA']];

export async function fetchTennis({ proxy, days = 1 } = {}) {
  const lists = await Promise.allSettled(TOURS.map(async ([tour]) => {
    const ranks = await cached(`tr:${tour}`, 12 * 3_600_000, () =>
      getJSON(`${BASE}/site/v2/sports/tennis/${tour}/rankings`, proxy, { retries: 1 }).then(parseRankings).catch(() => ({})));
    const dates = Array.from({ length: days + 1 }, (_, i) => ymd(new Date(Date.now() + i * 86_400_000)));
    const boards = await Promise.allSettled([
      getJSON(`${BASE}/site/v2/sports/tennis/${tour}/scoreboard`, proxy),
      ...dates.slice(1).map((d) => cached(`ts:${tour}:${d}`, 30 * 60_000, () => getJSON(`${BASE}/site/v2/sports/tennis/${tour}/scoreboard?dates=${d}`, proxy))),
    ]);
    const ms = boards.flatMap((b) => (b.status === 'fulfilled' ? parseTennisScoreboard(b.value, tour) : []));
    if (!ms.length && boards.every((b) => b.status === 'rejected')) throw boards[0].reason;
    for (const m of ms) for (const p of [m.a, m.b]) if (p.rank == null && ranks[p.id] != null) p.rank = ranks[p.id];
    return ms;
  }));
  const seen = new Set();
  const all = lists.flatMap((l) => (l.status === 'fulfilled' ? l.value : []))
    .filter((m) => (seen.has(m.tour + m.id) ? false : seen.add(m.tour + m.id)));
  if (!all.length && lists.every((l) => l.status === 'rejected')) throw lists[0].reason;
  return all;
}

// One finished match by date (Results page re-checks).
export async function fetchTennisDay(tour, date, { proxy } = {}) {
  return parseTennisScoreboard(await getJSON(`${BASE}/site/v2/sports/tennis/${tour}/scoreboard?dates=${ymd(new Date(date))}`, proxy, { retries: 1 }), tour);
}

// ---- Demo data (fictional players) ----
export function demoTennis() {
  const P = (id, name, rank, sets = []) => ({ id, name, short: name, country: '', flag: '', rank, seed: null, winner: false, sets: sets.map((g) => ({ games: g, tb: null })) });
  const now = Date.now();
  return [
    { sport: 'tennis', id: 'dt1', tour: 'atp', league: 'atp', event: 'Demo Open', eventId: 'd', draw: "Men's Singles", round: 'Quarterfinal', date: new Date(now - 3_600_000).toISOString(), state: 'in', detail: '2nd set', bestOf: 3,
      a: P('p1', 'A. Rivera', 3, [6, 3]), b: P('p2', 'L. Novak', 41, [4, 2]) },
    { sport: 'tennis', id: 'dt2', tour: 'atp', league: 'atp', event: 'Demo Open', eventId: 'd', draw: "Men's Singles", round: 'Quarterfinal', date: new Date(now + 2 * 3_600_000).toISOString(), state: 'pre', detail: '', bestOf: 3,
      a: P('p3', 'M. Okafor', 12, []), b: P('p4', 'J. Lindqvist', 15, []) },
    { sport: 'tennis', id: 'dt3', tour: 'wta', league: 'wta', event: 'Demo Classic', eventId: 'e', draw: "Women's Singles", round: 'Semifinal', date: new Date(now + 4 * 3_600_000).toISOString(), state: 'pre', detail: '', bestOf: 3,
      a: P('p5', 'S. Moreau', 1, []), b: P('p6', 'K. Tanaka', 88, []) },
    { sport: 'tennis', id: 'dt4', tour: 'atp', league: 'atp', event: 'Demo Slam', eventId: 'f', draw: "Men's Singles", round: 'Round 2', date: new Date(now + 6 * 3_600_000).toISOString(), state: 'pre', detail: '', bestOf: 5,
      a: P('p7', 'D. Petrov', 6, []), b: P('p8', 'R. Silva', 140, []) },
  ];
}
