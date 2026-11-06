import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeMatches, sameTeam, sameMatch, extrapolate, normName } from '../js/merge.js';
import { predict, windowShare } from '../js/model.js';
import { fetchMatches, scanStats, LEAGUES } from '../js/api.js';
import { SOURCES, afQuota } from '../js/sources.js';

const T = (name, score = 0) => ({ id: name, name, short: name, abbr: name.slice(0, 3), score });
const M = (o) => ({ id: '1', league: 'x', leagueName: 'X', state: 'in', minute: 50, date: '2026-11-06T15:00:00Z', home: T('Home'), away: T('Away'), ...o });

test('team names match across sources despite prefixes, suffixes and accents', () => {
  assert.ok(sameTeam({ name: 'Atlético Madrid' }, { name: 'Atletico Madrid' }));
  assert.ok(sameTeam({ name: 'FC Barcelona' }, { name: 'Barcelona' }));
  assert.ok(sameTeam({ name: 'Club América' }, { name: 'America' }));
  const at = (h, a) => M({ home: T(h), away: T(a) });
  assert.ok(!sameMatch(at('Inter', 'Orlando'), at('Inter Miami', 'Orlando City')), 'different clubs sharing a prefix');
  assert.ok(sameMatch(at('Brighton', 'Everton'), at('Brighton & Hove Albion', 'Everton')));
  assert.ok(!sameTeam({ name: 'Manchester City' }, { name: 'Manchester United' }));
  assert.equal(normName('1. FC Köln'), '1koln');
});

test('merge keeps one copy of a match, preferring the higher-priority source', () => {
  const espn = SOURCES.find((s) => s.id === 'espn');
  const af = SOURCES.find((s) => s.id === 'apifootball');
  const a = M({ id: 'e1', source: 'espn', home: T('Arsenal'), away: T('Chelsea') });
  const b = M({ id: 'a1', source: 'apifootball', home: T('Arsenal FC'), away: T('Chelsea FC'), date: '2026-11-06T15:05:00Z' });
  const c = M({ id: 'a2', source: 'apifootball', home: T('Vitesse'), away: T('Volendam') });
  const out = mergeMatches([{ src: af, matches: [b, c] }, { src: espn, matches: [a] }]);
  assert.deepEqual(out.map((m) => m.id), ['e1', 'a2']);
  assert.deepEqual(out[0].alsoIn, [af.name]);
});

test('clock is moved forward between infrequent list updates, capped at half time', () => {
  const m = M({ minute: 30, fetchedAt: Date.now() - 6 * 60_000 });
  assert.equal(extrapolate(m).minute, 36);
  assert.equal(extrapolate({ ...m, minute: 44 }).minute, 47);
  assert.equal(extrapolate({ ...m, detail: 'HT' }).minute, 30);
});

test('next-15-minute outlook is consistent with the rest-of-match chance', () => {
  assert.ok(Math.abs(windowShare(0, 90) - 1) < 1e-9);
  assert.ok(windowShare(60, 15) > windowShare(10, 15), 'second-half minutes carry more goals');
  const p = predict(M({ minute: 50 }));
  assert.ok(p.pNext15 > 0.3 && p.pNext15 < p.pMoreGoal);
  assert.ok(p.medianNextGoal > 10 && p.medianNextGoal < 30);
  assert.equal(predict(M({ state: 'pre', minute: 0 })).pNext15, null);
  const strong = predict(M({ minute: 50 }), { table: { home: { gp: 10, gf: 30, ga: 20 }, away: { gp: 10, gf: 25, ga: 28 } } });
  assert.equal(strong.soonLevel, 'hot');
  assert.equal(strong.verdict, 'Goal expected soon');
});

test('ESPN scan covers ~185 competitions, skips unknown ones and re-polls only busy leagues', async () => {
  assert.ok(LEAGUES.length >= 150);
  const calls = [];
  const live = { events: [{ id: '9', date: new Date().toISOString(), status: { displayClock: "50'", type: { state: 'in' } },
    competitions: [{ competitors: [{ homeAway: 'home', score: '1', team: { id: '1', displayName: 'A' } }, { homeAway: 'away', score: '0', team: { id: '2', displayName: 'B' } }] }] }] };
  globalThis.fetch = async (url) => {
    const lg = url.split('/soccer/')[1].split('/')[0];
    calls.push(lg);
    if (lg === 'eng.1') return { ok: true, json: async () => live };
    if (lg === 'mlt.1') return { ok: false, status: 400, statusText: 'Bad Request' };
    return { ok: true, json: async () => ({ events: [] }) };
  };
  const first = await fetchMatches({});
  assert.equal(first.length, 1);
  assert.equal(calls.length, LEAGUES.length, 'full scan hits every competition');
  calls.length = 0;
  await fetchMatches({});
  assert.deepEqual(calls, ['eng.1'], 'quick refresh only polls leagues with live matches');
  calls.length = 0;
  await fetchMatches({ force: true });
  assert.ok(!calls.includes('mlt.1'), 'unknown slug skipped after a 400');
  assert.equal(scanStats.active, 1);
});

test('API-Football stops before the free daily limit', async () => {
  const af = SOURCES.find((s) => s.id === 'apifootball');
  Object.assign(afQuota, { day: new Date().toISOString().slice(0, 10), remaining: 5, limit: 100 });
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, headers: new Map(), json: async () => ({ response: [] }) }; };
  await assert.rejects(af.adapter.fetchMatches({ key: 'k' }), /daily free limit/);
  assert.equal(called, false);
});
