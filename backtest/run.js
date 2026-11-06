// Backtest report: replays every finished match through the app's own prediction code.
// Usage: node backtest/run.js <data-dir>     (fetch data first with backtest/fetch-data.sh)
// Seasons used to tune the model's settings are reported separately from the later seasons it never
// saw ("test"), which are the honest measure.
import { writeFileSync } from 'node:fs';
import { loadContexts, predictAll, score, TRAIN_SEASONS } from './lib.js';
import { PARAMS } from '../js/model.js';
import { RULES } from '../js/markets.js';

// The model and pick rules as first shipped, before tuning — kept to show the effect of tuning.
const ORIGINAL = {
  params: { homeAdv: 1.1, seasonK: 4, formK: 2, formWeight: 0.35, h2hWeight: 0.25, strengthPower: 1, firstHalfShare: 0.45, scoreTrail: 0.12, scoreLead: 0.06 },
  rules: { minProb: 0.75, minCheck: 0.6 },
};
function withSettings(settings, fn) {
  const saved = { params: { ...PARAMS }, rules: { ...RULES } };
  Object.assign(PARAMS, settings.params); Object.assign(RULES, settings.rules);
  try { return fn(); } finally { Object.assign(PARAMS, saved.params); Object.assign(RULES, saved.rules); }
}

const dir = process.argv[2];
if (!dir) { console.error('usage: node backtest/run.js <data-dir>'); process.exit(1); }
const contexts = loadContexts(dir);
const allSeasons = [...new Set(contexts.map((c) => c.m.season))].sort();
const testSeasons = allSeasons.filter((s) => !TRAIN_SEASONS.includes(s));
const results = {
  generated: new Date().toISOString(),
  leagues: [...new Set(contexts.map((c) => c.m.league))].sort(),
  settings: { params: { ...PARAMS }, rules: { ...RULES } },
  test: score(predictAll(contexts, { seasons: testSeasons, withPicks: true })),
  testBeforeTuning: withSettings(ORIGINAL, () => score(predictAll(contexts, { seasons: testSeasons, withPicks: true }))),
  train: score(predictAll(contexts, { seasons: TRAIN_SEASONS, withPicks: true })),
};
writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
