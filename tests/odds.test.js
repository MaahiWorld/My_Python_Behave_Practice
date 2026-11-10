import { test } from 'node:test';
import assert from 'node:assert/strict';
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const O = await import('../js/odds.js');
const { summarize } = await import('../js/records.js');
const { oddsFields } = await import('../js/markets.js');

const bk = (title, h, d, a, over, under) => ({
  key: title.toLowerCase(), title, markets: [
    { key: 'h2h', outcomes: [{ name: 'Arsenal', price: h }, { name: 'Draw', price: d }, { name: 'Chelsea', price: a }] },
    { key: 'totals', outcomes: [{ name: 'Over', price: over, point: 2.5 }, { name: 'Under', price: under, point: 2.5 }] },
  ],
});
const football = [{ id: 'e1', sport_key: 'soccer_epl', commence_time: '2026-11-12T15:00:00Z', home_team: 'Arsenal', away_team: 'Chelsea',
  bookmakers: [bk('BookA', 2.0, 3.5, 4.0, 1.9, 1.9), bk('BookB', 2.1, 3.4, 3.8, 1.8, 2.0)] }];

test('parses football odds: margin removed, averaged, best price kept', () => {
  const [o] = O.parseOdds(football);
  const sum = o.h2h.home.fair + o.h2h.draw.fair + o.h2h.away.fair;
  assert.ok(Math.abs(sum - 1) < 1e-9, 'fair chances sum to 1');
  assert.equal(o.h2h.home.best, 2.1);
  assert.equal(o.h2h.home.bestBook, 'BookB');
  assert.equal(o.h2h.books, 2);
  assert.ok(Math.abs(o.totals[2.5].over.fair - (0.5 + (1 / 1.8) / (1 / 1.8 + 1 / 2.0)) / 2) < 1e-9);
  assert.equal(o.totals[2.5].under.best, 2.0);
});

test('matches odds to the app match and maps markets to sides', () => {
  const list = O.parseOdds(football);
  const m = { date: '2026-11-12T15:00:00Z', home: { name: 'Arsenal FC' }, away: { name: 'Chelsea' } };
  const o = O.findFootballOdds(m, list);
  assert.ok(o);
  assert.equal(O.findFootballOdds({ ...m, date: '2026-11-13T15:00:00Z' }, list), null, 'different day');
  assert.equal(O.oddsForSide(o, 'o25', 'no').best, 2.0);
  assert.equal(O.oddsForSide(o, 'o15', 'yes'), null, 'line 1.5 not offered');
  assert.equal(O.oddsForSide(o, 'btts', 'yes'), null);
  assert.equal(O.oddsForSide(o, '1x2', 'away').best, 4.0);
  assert.ok(Math.abs(O.edgeOf(0.6, 2.0) - 0.2) < 1e-9);
});

test('tennis odds: players matched by surname, sides flipped when listed the other way', () => {
  const json = [{ id: 't1', sport_key: 'tennis_atp_paris', commence_time: '2026-11-12T12:00:00Z', home_team: 'Carlos Alcaraz', away_team: 'Jannik Sinner',
    bookmakers: [{ title: 'B', markets: [{ key: 'h2h', outcomes: [{ name: 'Carlos Alcaraz', price: 2.2 }, { name: 'Jannik Sinner', price: 1.7 }] }] }] }];
  const list = O.parseOdds(json, 'tennis');
  const m = { date: '2026-11-12T13:00:00Z', a: { name: 'Jannik Sinner' }, b: { name: 'Carlos Alcaraz' } };
  const o = O.findTennisOdds(m, list);
  assert.equal(o.h2h.a.best, 1.7, 'player a is Sinner');
  assert.equal(O.oddsForSide(o, 'tw', 'b').best, 2.2);
});

test('records keep the price and the Results summary shows profit per stake', () => {
  assert.deepEqual(oddsFields({ best: 1.5, bestBook: 'B', fair: 0.6251 }), { odds: 1.5, oddsBook: 'B', fairP: 0.625 });
  assert.deepEqual(oddsFields(null), {});
  const [g] = summarize([
    { market: 'o15', p: 0.8, result: 'won', odds: 1.5 },
    { market: 'o15', p: 0.8, result: 'lost', odds: 1.4 },
    { market: 'o15', p: 0.8, result: 'won' },
  ]);
  assert.equal(g.priced, 2);
  assert.ok(Math.abs(g.profit - -0.5) < 1e-9);
  assert.ok(Math.abs(g.roi - -0.25) < 1e-9);
});
