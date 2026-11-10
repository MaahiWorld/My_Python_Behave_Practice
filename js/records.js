// Every pick the app shows (football and tennis) is stored on this device, then checked against the
// final result so the Results page can show how each prediction did.
const KEY = 'gs:picks';
const MAX = 1500;

export function loadRecords() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}
export function saveRecords(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX))); } catch { /* storage full or unavailable */ }
}

// Adds records not already stored (the first time a pick is shown is what counts).
export function addRecords(recs) {
  const list = loadRecords();
  const ids = new Set(list.map((x) => x.id));
  let changed = false;
  for (const r of recs) if (!ids.has(r.id)) { list.push(r); ids.add(r.id); changed = true; }
  if (changed) saveRecords(list);
  return changed;
}

// fn(record) returns a patch to merge, or null to leave it unchanged.
export function updateRecords(fn) {
  const list = loadRecords();
  let changed = 0;
  for (let i = 0; i < list.length; i++) {
    const patch = fn(list[i]);
    if (patch) { list[i] = { ...list[i], ...patch }; changed++; }
  }
  if (changed) saveRecords(list);
  return changed;
}

export function deleteRecords(pred) {
  const list = loadRecords();
  const keep = list.filter((x) => !pred(x));
  if (keep.length !== list.length) saveRecords(keep);
}

// Summary per sport + market: picks, settled, won, hit rate and the average probability claimed,
// so the claimed and actual hit rates can be compared.
export function summarize(list) {
  const groups = new Map();
  for (const x of list) {
    const k = `${x.sport || 'football'}|${x.market}`;
    const g = groups.get(k) || { sport: x.sport || 'football', market: x.market, picks: 0, settled: 0, won: 0, pending: 0, void: 0, sumP: 0, priced: 0, profit: 0 };
    g.picks++;
    if (x.result === 'won' || x.result === 'lost') {
      g.settled++; g.sumP += x.p; if (x.result === 'won') g.won++;
      // Level stakes of 1 at the best price recorded when the pick was made.
      if (x.odds > 1) { g.priced++; g.profit += x.result === 'won' ? x.odds - 1 : -1; }
    }
    else if (!x.result) g.pending++;
    else g.void++;
    groups.set(k, g);
  }
  return [...groups.values()].map((g) => ({ ...g, hitRate: g.settled ? g.won / g.settled : null, claimed: g.settled ? g.sumP / g.settled : null,
    roi: g.priced ? g.profit / g.priced : null }));
}

export function toCSV(list) {
  const cols = ['sport', 'leagueName', 'kickoff', 'match', 'market', 'label', 'p', 'odds', 'oddsBook', 'fairP', 'minute', 'score', 'final', 'ht', 'sets', 'result'];
  const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(','), ...list.map((x) => cols.map((c) => q(c === 'sport' ? x.sport || 'football' : x[c])).join(','))].join('\n');
}
