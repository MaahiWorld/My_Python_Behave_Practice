import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketPicks, MARKETS, outcome, recordPicks, settlePicks, trackRecord, RULES } from '../js/markets.js';

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
  assert.ok(o15.p >= RULES.minProb);
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
    'full model alone gives Over 1.5 ~85%, but recent form alone is only ~60%, below the 70% check, so no pick');
});

test('picks are made before kick-off only; live markets are decided or in play', async () => {
  const { evaluateMarkets } = await import('../js/markets.js');
  const live = { ...pre, state: 'in', minute: 60, phase: 'H2', home: T('h', 1), away: T('a', 1) };
  const stats = { shotsOnTarget: 5, shots: 12, corners: 5, possession: 50 };
  const d = { ...open, liveStats: { home: stats, away: stats } };
  assert.deepEqual(marketPicks(live, d), [], 'no in-play picks');
  const ev = evaluateMarkets(live, d);
  assert.equal(ev.find((e) => e.market.id === 'o15').status, 'decided', 'Over 1.5 already landed');
  assert.equal(ev.find((e) => e.market.id === 'btts').status, 'decided', 'BTTS already landed');
  const o25 = ev.find((e) => e.market.id === 'o25');
  assert.equal(o25.status, 'in-play');
  assert.ok(o25.p > 0 && o25.p < 1, 'live probability still shown');
  assert.ok(marketPicks(pre, open).length > 0, 'the same fixture gives picks before kick-off');
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

test('full-time result and first-half markets settle correctly', async () => {
  const { marketById, settleFootball } = await import('../js/markets.js');
  const x12 = marketById('1x2'), h05 = marketById('h1o05'), h15 = marketById('h1o15');
  assert.equal(x12.settle({ hs: 2, as: 1 }), 'home');
  assert.equal(x12.settle({ hs: 1, as: 1 }), 'draw');
  assert.equal(x12.settle({ hs: 2, as: 1, aet: true }), 'draw', 'extra-time win was a draw after 90 minutes');
  assert.equal(h05.settle({ hs: 2, as: 1, ht: { home: 0, away: 0 } }), 'no');
  assert.equal(h15.settle({ hs: 2, as: 1, ht: { home: 1, away: 1 } }), 'yes');
  assert.equal(h05.settle({ hs: 2, as: 1, ht: null }), null, 'no half-time score: can\'t settle');
  const rec = { market: '1x2', side: 'home', home: 'H', away: 'A' };
  assert.equal(settleFootball(rec, { hs: 3, as: 0, ht: null }).result, 'won');
  assert.equal(settleFootball(rec, { hs: 0, as: 0, ht: null, detail: 'Postponed' }).result, 'void');
  assert.equal(settleFootball({ market: 'h1o05', side: 'yes' }, { hs: 1, as: 0, ht: null }).result, 'unknown');
});

test('a strong home favourite gives a validated 1X2 pick', () => {
  const lop = {
    table: { home: { gp: 12, gf: 34, ga: 6 }, away: { gp: 12, gf: 8, ga: 30 } },
    form: { home: games(3, 0, 'W'), away: games(0, 3, 'L') },
    h2h: Array.from({ length: 5 }, () => ({ homeId: 'h', hs: 3, as: 0 })), leagueAvg: 1.4,
  };
  const pk = marketPicks(pre, lop).find((p) => p.market.id === '1x2');
  assert.ok(pk, '1X2 picked');
  assert.equal(pk.side, 'home');
  assert.equal(pk.label, 'h to win');
  assert.ok(pk.checks.some((c) => c.label === 'Head to head' && c.txt === '5/5 past meetings'));
});

test('first-half markets are decided once the first half is over', async () => {
  const { evaluateMarkets } = await import('../js/markets.js');
  const stats = { shotsOnTarget: 5, shots: 12, corners: 5, possession: 50 };
  const ht = { ...pre, state: 'in', minute: 45, phase: 'HT', detail: 'HT' };
  const ev = evaluateMarkets(ht, { ...open, liveStats: { home: stats, away: stats } });
  assert.equal(ev.find((e) => e.market.id === 'h1o05').status, 'decided');
  assert.equal(ev.find((e) => e.market.id === 'h1o15').status, 'decided');
});

test('records keep every first sighting and summarise claimed vs actual', async () => {
  const { addRecords, loadRecords, summarize, toCSV } = await import('../js/records.js');
  store.clear();
  addRecords([{ id: 'a', market: 'o15', p: 0.8, result: 'won' }, { id: 'b', market: 'o15', p: 0.9, result: 'lost' }]);
  addRecords([{ id: 'a', market: 'o15', p: 0.5, result: null }]);
  assert.equal(loadRecords().length, 2);
  const [g] = summarize(loadRecords());
  assert.equal(g.settled, 2); assert.equal(g.won, 1);
  assert.ok(Math.abs(g.claimed - 0.85) < 1e-9);
  assert.match(toCSV(loadRecords()), /^sport,/);
});
