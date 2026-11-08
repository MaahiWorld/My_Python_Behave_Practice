// Fits the model's settings (js/model.js PARAMS) on the training seasons only, by coordinate
// descent on log loss. Usage: node backtest/tune.js <data-dir>
// Stage 1: the goal model. Stage 2: the match-result settings (1X2 log loss). Stage 3: per-market
// logistic calibration of the pre-match yes/no markets.
import { PARAMS, predict } from '../js/model.js';
import { MARKETS } from '../js/markets.js';
import { loadContexts, predictAll, logLoss, TRAIN_SEASONS, resultOf } from './lib.js';

const contexts = loadContexts(process.argv[2]);
// Calibration sits on top of the model, so every stage is fitted with it switched off.
PARAMS.calib = {};
const GRID = {
  strengthPower: [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1],
  seasonK: [4, 8, 12, 16, 24],
  formK: [2, 4, 8, 12],
  formWeight: [0, 0.1, 0.2, 0.35, 0.5],
  h2hWeight: [0, 0.1, 0.25],
  scoreTrail: [0, 0.06, 0.12, 0.2, 0.3, 0.4],
  scoreLead: [-0.1, -0.05, 0, 0.06, 0.12],
};
// Home advantage and first-half share are measured directly from the data, not tuned.
const evalNow = () => logLoss(predictAll(contexts, { seasons: TRAIN_SEASONS }));
let best = evalNow();
console.log('start', JSON.stringify(PARAMS), best.toFixed(5));
for (let pass = 1; pass <= 3; pass++) {
  let improved = false;
  for (const [k, values] of Object.entries(GRID)) {
    for (const v of values) {
      const old = PARAMS[k];
      if (v === old) continue;
      PARAMS[k] = v;
      const ll = evalNow();
      if (ll < best - 1e-6) { best = ll; improved = true; } else PARAMS[k] = old;
    }
    console.log(`pass ${pass} ${k}=${PARAMS[k]} logloss=${best.toFixed(5)}`);
  }
  if (!improved) break;
}
console.log('best', JSON.stringify(PARAMS), best.toFixed(5));

// ---- Stage 2: match result (1X2). Stage 1's log loss leaves 1X2 out, so the stages don't interact.
const eps = 1e-6, ll = (p) => -Math.log(Math.min(1 - eps, Math.max(eps, p)));
const train = contexts.filter((c) => TRAIN_SEASONS.includes(c.m.season));
const high = train.filter((c) => predict(c.match, c.detail).confidence.level === 'High');
const mk1 = MARKETS.find((m) => m.id === '1x2');
const ll1x2 = (noTable = false) => high.reduce((s, c) => s + ll(mk1.probs(predict(c.match, noTable ? { ...c.detail, table: null } : c.detail))[mk1.settle(resultOf(c.m))]), 0) / high.length;
let best1 = { v: Infinity };
for (const resultSharpen of [1, 1.2, 1.4, 1.5, 1.7]) for (const ptsWeight of [0, 0.1, 0.2, 0.3, 0.4]) for (const drawFactor of [1, 1.05, 1.1]) {
  Object.assign(PARAMS, { resultSharpen, ptsWeight, drawFactor });
  const v = ll1x2();
  if (v < best1.v) best1 = { v, resultSharpen, ptsWeight, drawFactor };
}
Object.assign(PARAMS, { resultSharpen: best1.resultSharpen, ptsWeight: best1.ptsWeight, drawFactor: best1.drawFactor });
// Points per game from recent form only matters without a table: fit it on the "recent form only" check.
let bestF = { v: Infinity };
for (const ptsFormWeight of [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3]) {
  PARAMS.ptsFormWeight = ptsFormWeight;
  const v = ll1x2(true);
  if (v < bestF.v) bestF = { v, ptsFormWeight };
}
PARAMS.ptsFormWeight = bestF.ptsFormWeight;
console.log('1x2', JSON.stringify(best1), 'form-only', JSON.stringify(bestF));

// ---- Stage 3: logistic calibration p' = sigmoid(a + b·logit p) per market, by Newton's method.
const lg = (p) => Math.log(p / (1 - p)), sg = (z) => 1 / (1 + Math.exp(-z));
const pairs = {};
const KEYS = { o15: 'over15', o25: 'over25', btts: 'btts' };
for (const c of high) {
  const p = predict(c.match, c.detail), r = resultOf(c.m);
  for (const [id, key] of Object.entries(KEYS)) {
    const mk = MARKETS.find((m) => m.id === id);
    (pairs[key] ||= []).push([Math.min(1 - eps, Math.max(eps, mk.probs(p).yes)), mk.settle(r) === 'yes' ? 1 : 0]);
  }
}
const calib = {};
for (const [key, xs] of Object.entries(pairs)) {
  let a = 0, b = 1;
  for (let it = 0; it < 50; it++) {
    let ga = 0, gb = 0, haa = 0, hab = 0, hbb = 0;
    for (const [p, y] of xs) { const x = lg(p), q = sg(a + b * x), e = q - y, w = q * (1 - q); ga += e; gb += e * x; haa += w; hab += w * x; hbb += w * x * x; }
    const det = haa * hbb - hab * hab;
    a -= (hbb * ga - hab * gb) / det; b -= (haa * gb - hab * ga) / det;
  }
  calib[key] = [Math.round(a * 1000) / 1000, Math.round(b * 1000) / 1000];
}
console.log('calib', JSON.stringify(calib));
