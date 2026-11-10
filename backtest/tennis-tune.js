// Fits the tennis model's settings (js/tennis.js TENNIS_PARAMS) on the training years by log loss,
// then the per-market recalibration, and prints the result. Usage: node backtest/tennis-tune.js <dir>
import { loadTennis, TRAIN_YEARS } from './tennis-lib.js';
import { TENNIS_PARAMS } from '../js/tennis.js';
import { evaluate, fitPlatt } from './tennis-eval.js';

const dir = process.argv[2];
if (!dir) { console.error('usage: node backtest/tennis-tune.js <data-dir>'); process.exit(1); }
const train = loadTennis(dir).filter((m) => TRAIN_YEARS.includes(m.year));
TENNIS_PARAMS.calib = {};
// The match-winner chance comes straight from the rankings, so rankPower is fitted on that market
// alone; the other settings shape how sets and games fall for a given winner chance.
let objective = (e) => e.ll.tw;
const total = (e) => objective(e);
let best = { ...TENNIS_PARAMS, surface: { ...TENNIS_PARAMS.surface } }, bestLL = Infinity;
const tryP = (patch) => {
  Object.assign(TENNIS_PARAMS, best, patch);
  const e = evaluate(train);
  const v = total(e);
  console.log(JSON.stringify(patch), Object.fromEntries(Object.entries(e.ll).map(([k, x]) => [k, +x.toFixed(4)])), v.toFixed(4));
  if (v < bestLL) { bestLL = v; best = { ...TENNIS_PARAMS, surface: { ...TENNIS_PARAMS.surface } }; }
};
for (const rankPower of [0.4, 0.45, 0.5, 0.55, 0.6]) tryP({ rankPower });
objective = (e) => e.ll.tset + e.ll.tsets + e.ll.tgames;
bestLL = Infinity;
for (const dayForm of [0, 0.03, 0.035, 0.04, 0.045, 0.05]) tryP({ dayForm });
for (const atp of [0.62, 0.63, 0.64, 0.65, 0.66]) tryP({ serveBase: { ...best.serveBase, atp } });
for (const c of [-0.03, -0.02, -0.01, 0]) tryP({ surface: { ...best.surface, Clay: c } });
for (const g of [0, 0.01, 0.02, 0.03]) tryP({ surface: { ...best.surface, Grass: g } });
for (const dayForm of [best.dayForm - 0.005, best.dayForm + 0.005]) if (dayForm >= 0) tryP({ dayForm });
Object.assign(TENNIS_PARAMS, best);
const e = evaluate(train, { keep: true });
const calib = Object.fromEntries(['tset', 'tsets', 'tgames'].map((k) => [k, fitPlatt(e.rows[k]).map((x) => Math.round(x * 1000) / 1000)]));
console.log('\nbest', JSON.stringify({ ...best, calib }, null, 1));
