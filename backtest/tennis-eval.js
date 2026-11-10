// Scores tennis predictions: log loss per market, calibration, and the picks the app would show.
import { predictTennis, tennisMarkets, settleTennisMarket } from '../js/tennis.js';

const eps = 1e-6, ll = (p, y) => -Math.log(Math.min(1 - eps, Math.max(eps, y ? p : 1 - p)));

// Pre-match prediction for each finished match, with what happened.
export function evaluate(matches, { keep = false, picks = false } = {}) {
  const sum = { tw: 0, tset: 0, tsets: 0, tgames: 0 }, n = { tw: 0, tset: 0, tsets: 0, tgames: 0 };
  const rows = { tset: [], tsets: [], tgames: [] }, pickRows = [];
  for (const m of matches) {
    const pre = { ...m, state: 'pre' };
    const p = predictTennis(pre);
    const sa = m.a.sets.filter((x, i) => x.games > m.b.sets[i].games).length, sb = m.a.sets.length - sa;
    const games = m.a.sets.reduce((s, x, i) => s + x.games + m.b.sets[i].games, 0);
    const dogSets = p.dog === 'a' ? sa : sb;
    const y = { tw: sa > sb, tset: dogSets > 0, tsets: sa + sb > p.setsLine };
    sum.tw += ll(p.pA, y.tw); n.tw++;
    sum.tset += ll(p.dogSet, y.tset); n.tset++;
    sum.tsets += ll(p.overSets, y.tsets); n.tsets++;
    for (const g of p.gameLines) { sum.tgames += ll(g.over, games > g.line); n.tgames++; if (keep) rows.tgames.push([raw(p, 'tgames', g.line), games > g.line]); }
    if (keep) { rows.tset.push([raw(p, 'tset'), y.tset]); rows.tsets.push([raw(p, 'tsets'), y.tsets]); }
    if (picks) for (const pk of tennisMarkets(pre, p)) pickRows.push({ m, pk, won: settleTennisMarket(pk, m).result === 'won' });
  }
  return { ll: Object.fromEntries(Object.keys(sum).map((k) => [k, sum[k] / n[k]])), rows, picks: pickRows, n: matches.length };
}
// The model's probability before recalibration (what calibration is fitted on).
function raw(p, key, line) {
  const d = p.dist;
  if (key === 'tset') return p.dog === 'a' ? d.aSet : d.bSet;
  const over = (dist, l) => Object.entries(dist).reduce((s, [k, v]) => s + (+k > l ? v : 0), 0);
  if (key === 'tsets') return over(d.sets, p.setsLine);
  return over(d.games, line);
}

// Logistic recalibration [a, b] fitted by Newton's method: p' = sigmoid(a + b·logit p).
export function fitPlatt(rows) {
  let a = 0, b = 1;
  const xs = rows.map(([p, y]) => [Math.log(Math.min(1 - eps, Math.max(eps, p)) / (1 - Math.min(1 - eps, Math.max(eps, p)))), y ? 1 : 0]);
  for (let it = 0; it < 30; it++) {
    let ga = 0, gb = 0, haa = 0, hab = 0, hbb = 0;
    for (const [x, y] of xs) {
      const q = 1 / (1 + Math.exp(-(a + b * x))), w = q * (1 - q);
      ga += q - y; gb += (q - y) * x; haa += w; hab += w * x; hbb += w * x * x;
    }
    const det = haa * hbb - hab * hab;
    a -= (hbb * ga - hab * gb) / det; b -= (haa * gb - hab * ga) / det;
  }
  return [a, b];
}

// Hit rate of picks at a bar, per market and side.
export function pickTable(pickRows) {
  const out = {};
  for (const { pk, won } of pickRows) {
    if (pk.status !== 'pick') continue;
    const k = pk.market;
    const o = out[k] || (out[k] = { picks: 0, won: 0, said: 0, bySide: {} });
    o.picks++; o.won += won; o.said += pk.p;
    const s = o.bySide[pk.side] || (o.bySide[pk.side] = { n: 0, won: 0 });
    s.n++; s.won += won;
  }
  for (const o of Object.values(out)) { o.hitRate = Math.round((1000 * o.won) / o.picks) / 10; o.said = Math.round((1000 * o.said) / o.picks) / 10; }
  return out;
}
