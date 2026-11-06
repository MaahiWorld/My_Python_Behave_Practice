// Goal markets (Over 1.5, Over 2.5, Both teams to score): only validated, high-confidence picks.
//
// A pick is shown only when ALL of these hold:
//  1. The prediction's confidence is High (season records, recent form and, when live, match stats).
//  2. The full model gives the pick at least RULES.minProb (80%).
//  3. Every independent cross-check that has enough data agrees, at RULES.minCheck (70%) or better:
//     season record alone, recent form alone, the prediction without live match stats (live
//     matches), and head-to-head history (4+ meetings, before kick-off only).
//  4. The market isn't already decided (e.g. Over 1.5 once two goals are in).
// Picks are recorded on this device and marked won/lost at full time to build a track record.
import { predict } from './model.js';

// Pick rules (checked by the backtest, backtest/RESULTS.md).
export const RULES = { minProb: 0.8, minCheck: 0.7 };

export const MARKETS = [
  { id: 'o15', key: 'over15', name: 'Over 1.5 goals', yes: 'Over 1.5', no: 'Under 1.5', line: 1.5 },
  { id: 'o25', key: 'over25', name: 'Over 2.5 goals', yes: 'Over 2.5', no: 'Under 2.5', line: 2.5 },
  { id: 'btts', key: 'btts', name: 'Both teams to score', yes: 'BTTS: Yes', no: 'BTTS: No' },
];

// Did the market land, given a scoreline? (true = Yes/Over side won)
export function outcome(market, hs, as) {
  if (market.key === 'btts') return hs > 0 && as > 0;
  return hs + as > market.line;
}

// Already decided while the match is still going?
function settledEarly(market, hs, as) {
  return outcome(market, hs, as); // the Over/Yes side can only become true, never undone
}

function h2hRate(market, h2h) {
  const games = (h2h || []).filter((g) => Number.isFinite(g.hs) && Number.isFinite(g.as));
  if (games.length < 4) return null;
  const hits = games.filter((g) => outcome(market, g.hs, g.as)).length;
  return { p: hits / games.length, txt: `${hits}/${games.length} past meetings` };
}

// Evaluates every market for a match and says why each one is, or isn't, a pick.
// status: 'pick' | 'decided' | 'low-confidence' | 'low-prob' | 'check-failed' | 'few-checks' | 'finished'
export function evaluateMarkets(match, detail) {
  if (match.state === 'post') return MARKETS.map((market) => ({ market, status: 'finished' }));
  const main = predict(match, detail || {});
  if (main.confidence.level !== 'High' || main.phase === 'PEN') {
    return MARKETS.map((market) => ({ market, status: 'low-confidence', missing: main.confidence.missing, p: main[market.key] }));
  }
  const live = match.state === 'in';
  const t = detail.table || {};
  const checks = [];
  if (t.home && t.away) checks.push({ label: 'Season record only', pred: predict(match, { ...detail, form: null }) });
  if (detail.form?.home?.length && detail.form?.away?.length) checks.push({ label: 'Recent form only', pred: predict(match, { ...detail, table: null }) });
  if (live && detail.liveStats && main.reasons.some((r) => r.key === 'live' && r.impact !== 'neutral')) {
    checks.push({ label: 'Without match stats', pred: predict(match, { ...detail, liveStats: null }) });
  }
  const hs = match.home.score || 0, as = match.away.score || 0;
  return MARKETS.map((mk) => {
    if (live && settledEarly(mk, hs, as)) return { market: mk, status: 'decided' };
    const p = main[mk.key];
    const yes = p >= 0.5;
    const pSide = yes ? p : 1 - p;
    const base = { market: mk, side: yes ? 'yes' : 'no', label: yes ? mk.yes : mk.no, p: pSide, pred: main };
    if (pSide < RULES.minProb) return { ...base, status: 'low-prob' };
    const res = checks.map((c) => {
      const q = yes ? c.pred[mk.key] : 1 - c.pred[mk.key];
      return { label: c.label, p: q, ok: q >= RULES.minCheck, txt: `${Math.round(q * 100)}%` };
    });
    if (!live) {
      const h = h2hRate(mk, detail.h2h);
      if (h) {
        const q = yes ? h.p : 1 - h.p;
        res.push({ label: 'Head to head', p: q, ok: q >= 0.5, txt: h.txt });
      }
    }
    if (res.length < 2) return { ...base, status: 'few-checks', checks: res };
    if (!res.every((r) => r.ok)) return { ...base, status: 'check-failed', checks: res, failed: res.filter((r) => !r.ok) };
    return { ...base, status: 'pick', checks: res, level: pSide >= 0.85 ? 'Very high' : 'High' };
  });
}

export function marketPicks(match, detail) {
  if (!detail) return [];
  return evaluateMarkets(match, detail).filter((e) => e.status === 'pick');
}

// ---- Track record (stored on this device) ----
const KEY = 'gs:picks';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
const save = (list) => { try { localStorage.setItem(KEY, JSON.stringify(list.slice(-500))); } catch { /* ignore */ } };

export function recordPicks(match, picks) {
  if (!picks.length) return;
  const list = load();
  let changed = false;
  for (const pk of picks) {
    const id = `${match.league}/${match.id}/${pk.market.id}`;
    if (list.some((x) => x.id === id)) continue; // first time shown is what counts
    list.push({
      id, market: pk.market.id, side: pk.side, p: Math.round(pk.p * 1000) / 1000,
      match: `${match.home.name} vs ${match.away.name}`, league: match.leagueName,
      at: Date.now(), minute: match.state === 'in' ? match.minute : null, score: `${match.home.score || 0}-${match.away.score || 0}`,
      result: null,
    });
    changed = true;
  }
  if (changed) save(list);
}

export function settlePicks(matches) {
  const list = load();
  let changed = false;
  for (const x of list) {
    if (x.result) continue;
    const [league, id] = x.id.split('/');
    const m = matches.find((mm) => mm.league === league && mm.id === id && mm.state === 'post');
    if (m) {
      const mk = MARKETS.find((k) => k.id === x.market);
      const yesWon = outcome(mk, m.home.score || 0, m.away.score || 0);
      x.result = (x.side === 'yes') === yesWon ? 'won' : 'lost';
      x.final = `${m.home.score}-${m.away.score}`;
      changed = true;
    } else if (Date.now() - x.at > 3 * 86_400_000) { x.result = 'unknown'; changed = true; }
  }
  if (changed) save(list);
}

export function trackRecord() {
  const list = load();
  const by = {};
  for (const mk of MARKETS) {
    const xs = list.filter((x) => x.market === mk.id);
    const done = xs.filter((x) => x.result === 'won' || x.result === 'lost');
    by[mk.id] = { won: done.filter((x) => x.result === 'won').length, settled: done.length, pending: xs.filter((x) => !x.result).length };
  }
  return { by, recent: list.filter((x) => x.result === 'won' || x.result === 'lost').slice(-10).reverse() };
}
