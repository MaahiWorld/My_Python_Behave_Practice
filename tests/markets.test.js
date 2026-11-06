import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketPicks, MARKETS, outcome, recordPicks, settlePicks, trackRecord, MIN_PROB } from '../js/markets.js';

const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };

const T = (id, score = 0) => ({ id, name: id, short: id, abbr: id, score });
const games = (gf, ga, res) => Array.from({ length: 5 }, () => ({ gf, ga, res }));
const h2hGames = (hs, as) => Array.from({ length: 5 }, () => ({ homeId: 'h', hs, as }));
const open = {
  table: { home: { gp: 12, gf: 30, ga: 18 }, away: { gp: 12, gf: 26, ga: 24 } },
  form: { home: games(3, 2, 'W'), away: games(2, 2, 'D') },
  h2h: h2hGames(2, 2), leagueAvg: 1.4,
};
const pre = { id: '1', league: 'x', leagueName: 'X', state: 'pre', minute: 0, date: new Date().toISOString(), home: T('h'), away: T('a') };

test('outcome rules', () => {
  const [o15, o25, btts] = MARKETS;
  assert.equal(outcome(o15, 1, 1), true);
  assert.equal(outcome(o25, 1, 1), false);
  assert.equal(outcome(btts, 2, 0), false);
  assert.equal(outcome(btts, 1, 1), true);
});

test('validated picks for an attacking fixture, with every check agreeing', () => {
  const picks = marketPicks(pre, open);
  const o15 = picks.find((p) => p.market.id === 'o15');
  assert.ok(o15, 'Over 1.5 picked');
  assert.equal(o15.side, 'yes');
  assert.ok(o15.p >= MIN_PROB);
  assert.ok(o15.checks.length >= 3 && o15.checks.every((c) => c.ok));
  assert.deepEqual(o15.checks.map((c) => c.label), ['Season record only', 'Recent form only', 'Head to head']);
});

test('no picks without high confidence', () => {
  assert.deepEqual(marketPicks(pre, { ...open, form: { home: games(3, 2, 'W').slice(0, 2), away: [] } }), []);
  assert.deepEqual(marketPicks(pre, { leagueAvg: 1.4 }), []);
});

test('a pick is dropped when an independent check disagrees', () => {
  // Season record says lots of goals, but both teams have scored almost nothing lately.
  const split = {
    table: { home: { gp: 12, gf: 34, ga: 20 }, away: { gp: 12, gf: 30, ga: 26 } },
    form: { home: games(0, 0, 'D'), away: games(0, 1, 'L') }, leagueAvg: 1.4,
  };
  assert.equal(marketPicks(pre, split).find((p) => p.market.id === 'o15'), undefined,
    'full model alone would give Over 1.5 ~88%, but recent form alone disagrees, so no pick');
});

test('decided markets are left out of live picks', () => {
  const live = { ...pre, state: 'in', minute: 60, phase: 'H2', home: T('h', 1), away: T('a', 1) };
  const stats = { shotsOnTarget: 5, shots: 12, corners: 5, possession: 50 };
  const picks = marketPicks(live, { ...open, liveStats: { home: stats, away: stats } });
  assert.ok(!picks.some((p) => p.market.id === 'o15'), 'Over 1.5 already landed');
  assert.ok(!picks.some((p) => p.market.id === 'btts'), 'BTTS already landed');
});

test('picks are recorded once and settled at full time', () => {
  const picks = marketPicks(pre, open);
  recordPicks(pre, picks);
  recordPicks(pre, picks);
  const n = picks.length;
  assert.equal(Object.values(trackRecord().by).reduce((s, x) => s + x.pending, 0), n);
  settlePicks([{ ...pre, state: 'post', home: T('h', 2), away: T('a', 1) }]);
  const tr = trackRecord().by;
  assert.equal(tr.o15.won, 1);
  assert.equal(Object.values(tr).reduce((s, x) => s + x.pending, 0), 0);
});
