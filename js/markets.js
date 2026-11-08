// Football markets: only validated, high-confidence picks.
//
// Markets: Over 1.5 / Over 2.5 goals, Both teams to score, Full-time result (1X2, settled on the
// 90-minute score), and first-half goals (Over 0.5 / Over 1.5 in the first half).
//
// A pick is shown only when ALL of these hold:
//  1. The prediction's confidence is High (season records, recent form and, when live, match stats).
//  2. The full model gives the pick at least the market's minimum (RULES.minProb unless the market
//     sets its own, chosen on the backtest's training seasons; see backtest/RESULTS.md).
//  3. Every independent cross-check that has enough data agrees, at RULES.minCheck (70%) or better
//     (or the market's own check level): season record alone, recent form alone, the prediction
//     without live match stats (live matches), and head-to-head history (4+ meetings, before kick-off).
//  4. The market isn't already decided (e.g. Over 1.5 once two goals are in).
// Picks are recorded on this device and checked after full time (js/records.js, Results page).
import { predict } from './model.js';
import { addRecords, updateRecords, loadRecords } from './records.js';

// Pick rules (checked by the backtest, backtest/RESULTS.md).
export const RULES = { minProb: 0.8, minCheck: 0.7 };

const yesNo = (p) => (p == null ? null : { yes: p, no: 1 - p });
const total = (r) => r.hs + r.as;
const ET_PHASES = ['BREAK_ET', 'ET', 'PEN'];

// Each market: sides and their labels, the model's probability of each side, which side won given
// a result { hs, as, ht: {home, away} | null, aet }, and (optionally) the side a past meeting landed on.
export const MARKETS = [
  {
    id: 'o15', tab: 'O1.5', name: 'Over 1.5 goals', key: 'over15', yes: 'Over 1.5', no: 'Under 1.5',
    probs: (p) => yesNo(p.over15), settle: (r) => (total(r) > 1.5 ? 'yes' : 'no'),
    h2h: (g) => (g.hs + g.as > 1.5 ? 'yes' : 'no'), decided: (m) => (m.home.score || 0) + (m.away.score || 0) > 1.5,
    rule: 'needs 2+ goals',
  },
  {
    id: 'o25', tab: 'O2.5', name: 'Over 2.5 goals', key: 'over25', yes: 'Over 2.5', no: 'Under 2.5',
    probs: (p) => yesNo(p.over25), settle: (r) => (total(r) > 2.5 ? 'yes' : 'no'),
    h2h: (g) => (g.hs + g.as > 2.5 ? 'yes' : 'no'), decided: (m) => (m.home.score || 0) + (m.away.score || 0) > 2.5,
    rule: 'needs 3+ goals',
  },
  {
    id: 'btts', tab: 'BTTS', name: 'Both teams to score', key: 'btts', yes: 'BTTS: Yes', no: 'BTTS: No',
    probs: (p) => yesNo(p.btts), settle: (r) => (r.hs > 0 && r.as > 0 ? 'yes' : 'no'),
    h2h: (g) => (g.hs > 0 && g.as > 0 ? 'yes' : 'no'), decided: (m) => (m.home.score || 0) > 0 && (m.away.score || 0) > 0,
    rule: 'both teams must score',
  },
  {
    id: '1x2', tab: '1X2', name: 'Full-time result', sides: ['home', 'draw', 'away'],
    label: (side, m) => (side === 'draw' ? 'Draw' : `${(side === 'home' ? m.home : m.away).short || (side === 'home' ? m.home : m.away).name} to win`),
    probs: (p) => ({ home: p.outcome.homeWin, draw: p.outcome.draw, away: p.outcome.awayWin }),
    // Settled on the 90-minute score: a match that went to extra time was a draw after 90.
    settle: (r) => (r.aet ? 'draw' : r.hs > r.as ? 'home' : r.hs < r.as ? 'away' : 'draw'),
    h2h: (g, homeId) => {
      const mine = g.homeId === homeId ? g.hs : g.as, theirs = g.homeId === homeId ? g.as : g.hs;
      return mine > theirs ? 'home' : mine < theirs ? 'away' : 'draw';
    },
    decided: (m, phase) => ET_PHASES.includes(phase),
    minProb: 0.75, minCheck: 0.5, rule: 'result after 90 minutes (extra time not counted)',
  },
  {
    id: 'h1o05', tab: '1H O0.5', name: '1st half: Over 0.5 goals', yes: '1st half Over 0.5', no: '1st half Under 0.5',
    probs: (p) => yesNo(p.firstHalf?.over05), settle: (r) => (r.ht ? (r.ht.home + r.ht.away > 0.5 ? 'yes' : 'no') : null),
    decided: (m, phase) => phase !== 'H1' || (m.home.score || 0) + (m.away.score || 0) > 0.5,
    minProb: 0.78, rule: 'needs a goal before half time',
  },
  {
    id: 'h1o15', tab: '1H O1.5', name: '1st half: Over 1.5 goals', yes: '1st half Over 1.5', no: '1st half Under 1.5',
    probs: (p) => yesNo(p.firstHalf?.over15), settle: (r) => (r.ht ? (r.ht.home + r.ht.away > 1.5 ? 'yes' : 'no') : null),
    decided: (m, phase) => phase !== 'H1' || (m.home.score || 0) + (m.away.score || 0) > 1.5,
    minProb: 0.85, rule: 'needs 2+ goals before half time',
  },
];
export const marketById = (id) => MARKETS.find((m) => m.id === id);
export const sidesOf = (mk) => mk.sides || ['yes', 'no'];
export const sideLabel = (mk, side, match) => (mk.label ? mk.label(side, match) : side === 'yes' ? mk.yes : mk.no);
const minProbOf = (mk) => mk.minProb ?? RULES.minProb;
const minCheckOf = (mk) => mk.minCheck ?? RULES.minCheck;

// Backwards-compatible helper for yes/no markets: did the Yes/Over side land?
export function outcome(market, hs, as, ht = null, aet = false) {
  return market.settle({ hs, as, ht, aet }) === 'yes';
}

// The side the model rates highest, and its probability.
export function bestSide(mk, pred) {
  const pr = mk.probs(pred);
  if (!pr) return null;
  const side = sidesOf(mk).reduce((a, b) => (pr[b] > pr[a] ? b : a));
  return { side, p: pr[side], probs: pr };
}

function h2hRate(mk, side, h2h, homeId) {
  if (!mk.h2h) return null;
  const games = (h2h || []).filter((g) => Number.isFinite(g.hs) && Number.isFinite(g.as));
  if (games.length < 4) return null;
  const hits = games.filter((g) => mk.h2h(g, homeId) === side).length;
  return { p: hits / games.length, txt: `${hits}/${games.length} past meetings` };
}

// Evaluates every market for a match and says why each one is, or isn't, a pick.
// status: 'pick' | 'decided' | 'low-confidence' | 'low-prob' | 'check-failed' | 'few-checks' | 'finished'
export function evaluateMarkets(match, detail) {
  if (match.state === 'post') return MARKETS.map((market) => ({ market, status: 'finished' }));
  detail = detail || {};
  const main = predict(match, detail);
  if (main.confidence.level !== 'High' || main.phase === 'PEN') {
    return MARKETS.map((market) => ({ market, status: 'low-confidence', missing: main.confidence.missing, p: bestSide(market, main)?.p }));
  }
  const live = match.state === 'in';
  const t = detail.table || {};
  const checks = [];
  if (t.home && t.away) checks.push({ label: 'Season record only', pred: predict(match, { ...detail, form: null }) });
  if (detail.form?.home?.length && detail.form?.away?.length) checks.push({ label: 'Recent form only', pred: predict(match, { ...detail, table: null }) });
  if (live && detail.liveStats && main.reasons.some((r) => r.key === 'live' && r.impact !== 'neutral')) {
    checks.push({ label: 'Without match stats', pred: predict(match, { ...detail, liveStats: null }) });
  }
  return MARKETS.map((mk) => {
    if (live && mk.decided(match, main.phase)) return { market: mk, status: 'decided' };
    const best = bestSide(mk, main);
    if (!best) return { market: mk, status: 'decided' };
    const { side, p } = best;
    const base = { market: mk, side, label: sideLabel(mk, side, match), p, pred: main };
    if (p < minProbOf(mk)) return { ...base, status: 'low-prob', need: minProbOf(mk) };
    const res = checks.map((c) => {
      const q = mk.probs(c.pred)[side];
      return { label: c.label, p: q, ok: q >= minCheckOf(mk), txt: `${Math.round(q * 100)}%` };
    });
    if (!live) {
      const h = h2hRate(mk, side, detail.h2h, match.home.id);
      if (h) res.push({ label: 'Head to head', p: h.p, ok: h.p >= 0.5, txt: h.txt });
    }
    if (res.length < 2) return { ...base, status: 'few-checks', checks: res };
    if (!res.every((r) => r.ok)) return { ...base, status: 'check-failed', checks: res, failed: res.filter((r) => !r.ok), needCheck: minCheckOf(mk) };
    return { ...base, status: 'pick', checks: res, level: p >= minProbOf(mk) + 0.05 ? 'Very high' : 'High' };
  });
}

export function marketPicks(match, detail) {
  if (!detail) return [];
  return evaluateMarkets(match, detail).filter((e) => e.status === 'pick');
}

// ---- Track record (stored on this device, see js/records.js) ----
export const recordId = (match, marketId) => `${match.league}/${match.id}/${marketId}`;

export function recordPicks(match, picks) {
  if (!picks.length) return;
  addRecords(picks.map((pk) => ({
    id: recordId(match, pk.market.id), sport: 'football', market: pk.market.id, side: pk.side, label: pk.label,
    p: Math.round(pk.p * 1000) / 1000,
    match: `${match.home.name} vs ${match.away.name}`, home: match.home.short || match.home.name, away: match.away.short || match.away.name,
    league: match.league, eventId: match.id, leagueName: match.leagueName, source: match.source || 'espn', kickoff: match.date,
    at: Date.now(), minute: match.state === 'in' ? match.minute : null, score: `${match.home.score || 0}-${match.away.score || 0}`,
    checks: (pk.checks || []).map((c) => `${c.label} ${c.txt}`),
    expected: pk.pred ? Math.round(pk.pred.expectedFinalTotal * 100) / 100 : null,
    result: null,
  })));
}

// Settles a football record from a finished result { hs, as, ht, aet }.
export function settleFootball(rec, r) {
  const mk = marketById(rec.market);
  if (!mk) return { result: 'unknown' };
  if (/postpon|cancel|abandon|suspend|awarded/i.test(r.detail || '')) return { result: 'void', note: r.detail };
  const winner = mk.settle(r);
  const final = `${r.hs}-${r.as}`;
  const ht = r.ht ? `${r.ht.home}-${r.ht.away}` : null;
  if (winner == null) return { result: 'unknown', final, ht, note: 'half-time score not available from the data source' };
  return { result: winner === rec.side ? 'won' : 'lost', final, ht, aet: !!r.aet, winner: sideLabel(mk, winner, { home: { short: rec.home }, away: { short: rec.away } }) };
}

export const resultOf = (m) => ({ hs: m.home.score || 0, as: m.away.score || 0, ht: m.ht || null, aet: !!m.extraTime, detail: m.detail || '' });

// Settles pending picks for matches in `matches` that have finished.
export function settlePicks(matches) {
  updateRecords((x) => {
    if (x.result || (x.sport && x.sport !== 'football')) return null;
    const [league, id] = x.id.split('/');
    const m = matches.find((mm) => mm.league === league && mm.id === id && mm.state === 'post');
    if (m) return { ...settleFootball(x, resultOf(m)), settledAt: Date.now() };
    // ESPN results can be fetched later on the Results page; other sources only while in the feed.
    const maxAge = (x.source || 'espn') === 'espn' ? 10 : 3;
    if (Date.now() - x.at > maxAge * 86_400_000) return { result: 'unknown', note: 'result not found' };
    return null;
  });
}

export function trackRecord() {
  const list = loadRecords().filter((x) => !x.sport || x.sport === 'football');
  const by = {};
  for (const mk of MARKETS) {
    const xs = list.filter((x) => x.market === mk.id);
    const done = xs.filter((x) => x.result === 'won' || x.result === 'lost');
    by[mk.id] = { won: done.filter((x) => x.result === 'won').length, settled: done.length, pending: xs.filter((x) => !x.result).length };
  }
  return { by, recent: list.filter((x) => x.result === 'won' || x.result === 'lost').slice(-10).reverse() };
}
