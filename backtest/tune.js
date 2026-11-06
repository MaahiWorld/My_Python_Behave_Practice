// Fits the model's settings (js/model.js PARAMS) on the training seasons only, by coordinate
// descent on log loss. Usage: node backtest/tune.js <data-dir>
import { PARAMS } from '../js/model.js';
import { loadContexts, predictAll, logLoss, TRAIN_SEASONS } from './lib.js';

const contexts = loadContexts(process.argv[2]);
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
