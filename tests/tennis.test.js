import { test } from 'node:test';
import assert from 'node:assert/strict';
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
const T = await import('../js/tennis.js');
const { loadRecords } = await import('../js/records.js');

const P = (name, rank, sets = [], winner = false) => ({ id: name, name, short: name, rank, winner, sets: sets.map((g) => ({ games: g })) });
const M = (o) => ({ sport: 'tennis', id: '1', tour: 'atp', league: 'atp', event: 'Open', date: new Date().toISOString(), state: 'pre', bestOf: 3, a: P('A', 5), b: P('B', 60), ...o });

test('point → game → set → match chain is consistent', () => {
  assert.ok(Math.abs(T.holdProb(0.64) - 0.813) < 0.002);
  assert.ok(Math.abs(T.tiebreakProb(0.64, 0.64) - 0.5) < 1e-9);
  const d = T.matchDist(0.64, 0.64, 3);
  assert.ok(Math.abs(d.pA - 0.5) < 1e-9);
  const sum = (o) => Object.values(o).reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum(d.games) - 1) < 1e-9 && Math.abs(sum(d.sets) - 1) < 1e-9);
  assert.ok(Math.min(...Object.keys(d.games).map(Number)) === 12 && Math.max(...Object.keys(d.games).map(Number)) === 39);
  assert.ok(T.matchDist(0.66, 0.62, 5).pA > T.matchDist(0.66, 0.62, 3).pA, 'best of 5 favours the stronger player more');
});

test('ranking calibration reproduces the pre-match chance', () => {
  const p = T.rankWinProb(5, 60);
  const c = T.calibrate(p, 'atp');
  assert.ok(Math.abs(T.matchDistMix(c.s, c.d, 3).pA - p) < 0.002, 'allowing for day-to-day form');
  assert.equal(T.rankWinProb(null, 3), null);
});

test('live score moves the prediction and the markets', () => {
  const pre = T.predictTennis(M());
  const up = T.predictTennis(M({ state: 'in', a: P('A', 5, [6, 4]), b: P('B', 60, [3, 1]) }));
  const down = T.predictTennis(M({ state: 'in', a: P('A', 5, [3, 1]), b: P('B', 60, [6, 4]) }));
  assert.ok(up.pA > pre.pA && down.pA < pre.pA);
  assert.equal(up.st.setsA, 1); assert.deepEqual(up.st.cur, [4, 1]);
  assert.equal(down.dogSet, 1, 'underdog already won a set');
  const mk = T.tennisMarkets(M({ state: 'in', a: P('A', 5, [3, 1]), b: P('B', 60, [6, 4]) }));
  assert.equal(mk.find((x) => x.market === 'tset').status, 'decided');
  assert.equal(T.tennisMarkets(M({ b: P('B', null) }))[0].status, 'low-confidence');
});

test('tennis picks are recorded and settled from the final score', () => {
  const m = M({ a: P('A', 1), b: P('B', 150) });
  const picks = T.tennisMarkets(m).filter((x) => x.status === 'pick');
  assert.ok(picks.some((x) => x.market === 'tw' && x.side === 'a'));
  T.recordTennisPicks(m, picks);
  T.settleTennisPicks([{ ...m, state: 'post', a: P('A', 1, [6, 7, 6], true), b: P('B', 150, [3, 6, 2]) }]);
  const recs = loadRecords().filter((x) => x.sport === 'tennis');
  assert.equal(recs.find((x) => x.market === 'tw').result, 'won');
  const tset = recs.find((x) => x.market === 'tset');
  if (tset) assert.equal(tset.result, tset.side === 'yes' ? 'won' : 'lost', 'underdog took the second set');
  const g = recs.find((x) => x.market === 'tgames');
  if (g) assert.equal(g.result, (g.side === 'over') === 30 > g.line ? 'won' : 'lost');
  assert.equal(T.settleTennisMarket({ market: 'tw', side: 'a' }, { ...m, state: 'post', void: true }).result, 'void');
});

test('parses the ESPN tennis scoreboard (singles only) and rankings', () => {
  const comp = (id, state, a, b, extra = {}) => ({
    id, date: '2026-11-08T12:00:00Z', status: { type: { state, name: state === 'post' ? 'STATUS_FINAL' : 'STATUS_IN_PROGRESS', shortDetail: '' } },
    round: { displayName: 'Round 1' },
    competitors: [
      { id: 'p1', order: 1, winner: a.w, athlete: { id: 'p1', displayName: 'Ann Alpha', shortName: 'A. Alpha' }, curatedRank: { current: 4 }, linescores: a.ls.map((v) => ({ value: v })) },
      { id: 'p2', order: 2, athlete: { id: 'p2', displayName: 'Bea Beta', shortName: 'B. Beta' }, linescores: b.ls.map((v) => ({ value: v })) },
    ], ...extra,
  });
  const json = { events: [{ id: 'e1', name: 'US Open', groupings: [
    { grouping: { slug: 'mens-singles', displayName: "Men's Singles" }, competitions: [comp('c1', 'in', { ls: [6, 2] }, { ls: [4, 3] })] },
    { grouping: { slug: 'mens-doubles', displayName: "Men's Doubles" }, competitions: [comp('c2', 'in', { ls: [] }, { ls: [] })] },
    { grouping: { slug: 'womens-singles', displayName: "Women's Singles" }, competitions: [comp('c3', 'post', { ls: [6, 6], w: true }, { ls: [1, 2] })] },
  ] }] };
  const ms = T.parseTennisScoreboard(json, 'atp');
  assert.deepEqual(ms.map((m) => m.id), ['c1', 'c3']);
  assert.equal(ms[0].bestOf, 5, "men's Grand Slam singles are best of 5");
  assert.equal(ms[1].bestOf, 3);
  assert.equal(ms[0].a.rank, 4);
  assert.equal(ms[0].b.rank, null);
  assert.deepEqual(T.scoreState(ms[0]).cur, [2, 3]);
  assert.equal(T.settleTennisMarket({ market: 'tsets', side: 'under', line: 2.5 }, ms[1]).result, 'won');
  assert.deepEqual(T.parseRankings({ rankings: [{ ranks: [{ current: 1, athlete: { id: 'x' } }, { current: 2, athlete: { id: 'p2' } }] }] }), { x: 1, p2: 2 });
});

test('day-to-day form keeps the win chance but makes straight sets more common', () => {
  const saved = T.TENNIS_PARAMS.dayForm;
  try {
    T.TENNIS_PARAMS.dayForm = 0;
    const flat = T.predictTennis(M({ a: P('A', 10), b: P('B', 30) }));
    T.TENNIS_PARAMS.dayForm = 0.04;
    const mix = T.predictTennis(M({ a: P('A', 10), b: P('B', 30) }));
    assert.ok(Math.abs(mix.pA - flat.pA) < 0.002, 'win chance still matches the rankings');
    assert.ok(mix.dist.sets[2] > flat.dist.sets[2], 'more two-set matches');
    const sum = (o) => Object.values(o).reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(sum(mix.dist.games) - 1) < 1e-9);
  } finally { T.TENNIS_PARAMS.dayForm = saved; }
});

test('surface from the tournament name and month', () => {
  assert.equal(T.surfaceOf('Roland Garros', '2026-05-30'), 'Clay');
  assert.equal(T.surfaceOf('Mutua Madrid Open', '2026-05-01'), 'Clay');
  assert.equal(T.surfaceOf('Wimbledon', '2026-07-01'), 'Grass');
  assert.equal(T.surfaceOf('Terra Wortmann Open', '2026-06-20'), 'Grass');
  assert.equal(T.surfaceOf('Stuttgart', '2026-04-20'), 'Hard', 'Stuttgart in April is not the grass event');
  assert.equal(T.surfaceOf('US Open', '2026-09-01'), 'Hard');
  assert.ok(T.serveLevel('atp', 'Grass') > T.serveLevel('atp', 'Clay'));
});

test('per-market bars: null means the market gives no picks, and none are made in play', () => {
  const saved = JSON.parse(JSON.stringify(T.TENNIS_RULES.markets));
  try {
    T.TENNIS_RULES.markets = { tgames: null, tw: { a: 0.6 } };
    const mk = T.tennisMarkets(M({ a: P('A', 1), b: P('B', 150) }));
    assert.equal(mk.find((x) => x.market === 'tgames').status, 'low-prob');
    assert.equal(mk.find((x) => x.market === 'tw').status, 'pick');
    assert.equal(T.barOf('tset', 'yes'), T.TENNIS_RULES.minProb);
    const live = T.tennisMarkets(M({ state: 'in', a: P('A', 1, [3]), b: P('B', 150, [2]) }));
    assert.equal(live.find((x) => x.market === 'tw').status, 'in-play');
  } finally { T.TENNIS_RULES.markets = saved; }
});

test('backtest score parser', async () => {
  const { parseScore } = await import('../backtest/tennis-lib.js');
  assert.deepEqual(parseScore('6-4 6-7(2) 7-6(5)'), [[6, 4], [6, 7], [7, 6]]);
  assert.equal(parseScore('6-4 2-1 RET'), null);
  assert.equal(parseScore('W/O'), null);
});
