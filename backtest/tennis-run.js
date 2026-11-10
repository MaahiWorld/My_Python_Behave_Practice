// Tennis backtest report: replays finished ATP matches through js/tennis.js before the first ball.
// Usage: node backtest/tennis-run.js <data-dir> [--bars]   (fetch data with backtest/fetch-tennis.sh)
//   --bars  also chooses each market's pick bar on the training years and prints it.
// Writes backtest/tennis-results.json.
import { writeFileSync } from 'node:fs';
import { loadTennis, TRAIN_YEARS } from './tennis-lib.js';
import { TENNIS_PARAMS, TENNIS_RULES } from '../js/tennis.js';
import { evaluate, pickTable } from './tennis-eval.js';

// The model as first shipped (rank-based, no day-to-day form, no surface, no recalibration, 75% bar).
const ORIGINAL = {
  params: { serveBase: { atp: 0.64, wta: 0.56 }, surface: { Hard: 0, Clay: 0, Grass: 0 }, rankPower: 0.5, dayForm: 0, calib: {} },
  rules: { minProb: 0.75, markets: {} },
};
function withSettings(st, fn) {
  const saved = { params: JSON.parse(JSON.stringify(TENNIS_PARAMS)), rules: JSON.parse(JSON.stringify(TENNIS_RULES)) };
  Object.assign(TENNIS_PARAMS, st.params); Object.assign(TENNIS_RULES, st.rules);
  try { return fn(); } finally { Object.assign(TENNIS_PARAMS, saved.params); Object.assign(TENNIS_RULES, saved.rules); }
}

const dir = process.argv[2];
if (!dir) { console.error('usage: node backtest/tennis-run.js <data-dir> [--bars]'); process.exit(1); }
const all = loadTennis(dir);
const train = all.filter((m) => TRAIN_YEARS.includes(m.year)), test = all.filter((m) => !TRAIN_YEARS.includes(m.year));

// Hit rate of every side at a range of bars (with every bar open, so all candidates are seen).
function barScan(matches) {
  const ev = withSettings({ params: {}, rules: { minProb: 0.5, markets: {} } }, () => evaluate(matches, { picks: true }));
  const out = {};
  for (const { pk, won, m } of ev.picks) {
    if (pk.status === 'low-confidence') continue;
    for (const bar of [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9]) {
      if (pk.p < bar) continue;
      const k = `${pk.market}|${pk.side}|${bar}`;
      const o = out[k] || (out[k] = { n: 0, won: 0 });
      o.n++; o.won += won;
    }
  }
  return out;
}
const TARGET = 0.8, MIN_PICKS = 40;
function chooseBars(scan) {
  const bars = {};
  for (const [k, o] of Object.entries(scan)) {
    const [mk, side, bar] = k.split('|');
    if (o.n >= MIN_PICKS && o.won / o.n >= TARGET) {
      bars[mk] = bars[mk] || {};
      if (bars[mk][side] == null || +bar < bars[mk][side]) bars[mk][side] = +bar;
    }
  }
  return bars;
}

const summary = (ev) => ({
  matches: ev.n, logLoss: Object.fromEntries(Object.entries(ev.ll).map(([k, v]) => [k, Math.round(v * 10000) / 10000])),
  picks: pickTable(ev.picks),
});
const results = {
  generated: new Date().toISOString(),
  data: { source: 'TML-Database (ATP main tour)', train: `${TRAIN_YEARS[0]}-${TRAIN_YEARS.at(-1)}`, test: `${Math.min(...test.map((m) => m.year))}-${Math.max(...test.map((m) => m.year))}` },
  settings: { params: TENNIS_PARAMS, rules: TENNIS_RULES },
  test: summary(evaluate(test, { picks: true })),
  testOriginal: withSettings(ORIGINAL, () => summary(evaluate(test, { picks: true }))),
  train: summary(evaluate(train, { picks: true })),
};
if (process.argv.includes('--bars')) {
  const scanTrain = barScan(train), scanTest = barScan(test);
  results.barScan = { train: scanTrain, test: scanTest, chosen: chooseBars(scanTrain), target: TARGET, minPicks: MIN_PICKS };
}
writeFileSync(new URL('./tennis-results.json', import.meta.url), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ ...results, barScan: results.barScan && { chosen: results.barScan.chosen } }, null, 2));
