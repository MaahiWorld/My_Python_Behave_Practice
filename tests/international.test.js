import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchDetail, internationalCandidates, isInternational, LEAGUES } from '../js/api.js';
import { confidence, h2hSummary } from '../js/model.js';

// One completed game in an ESPN team schedule.
const game = (id, date, me, opp, gf, ga) => ({
  id, date, competitions: [{ status: { type: { completed: true } }, competitors: [
    { id: me, homeAway: 'home', score: { value: gf }, team: { id: me } },
    { id: opp, homeAway: 'away', score: { value: ga }, team: { id: opp, shortDisplayName: `T${opp}` } }] }],
});

test('Nations League is scanned and treated as an international competition', () => {
  assert.ok(LEAGUES.some(([s, name]) => s === 'uefa.nations' && name === 'Nations League'));
  assert.ok(isInternational('uefa.nations') && isInternational('fifa.friendly') && !isInternational('uefa.champions'));
  const c = internationalCandidates('uefa.nations');
  assert.equal(c[0], 'uefa.nations');
  assert.ok(c.includes('fifa.worldq.uefa') && c.includes('fifa.friendly') && c.includes('fifa.world'));
  assert.ok(!c.includes('fifa.worldq.afc'));
});

test('Nations League game: season record built from the last 12 months of internationals', async () => {
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(url);
    let body = { events: [] };
    if (url.includes('/standings')) body = { children: [] }; // 4 games each in the group: too short
    else if (url.includes('summary')) body = {};
    else if (url.includes('/uefa.nations/teams/10/schedule')) body = { events: [game('a1', '2026-09-05T18:45Z', '10', '1', 2, 0), game('a2', '2026-09-08T18:45Z', '10', '2', 1, 1), game('a3', '2026-10-10T18:45Z', '10', '3', 3, 1), game('a4', '2026-10-13T18:45Z', '10', '4', 0, 1)] };
    else if (url.includes('/fifa.world/teams/10/schedule')) body = { events: [game('w1', '2026-06-15T18:00Z', '10', '5', 2, 1), game('w2', '2026-06-20T18:00Z', '10', '6', 1, 0), game('old', '2025-03-20T18:00Z', '10', '7', 9, 0)] };
    else if (url.includes('/uefa.nations/teams/20/schedule')) body = { events: [game('b1', '2026-09-05T18:45Z', '20', '8', 1, 2), game('b2', '2026-09-08T18:45Z', '20', '9', 0, 0), game('b3', '2026-10-10T18:45Z', '20', '11', 2, 2), game('b4', '2026-10-13T18:45Z', '20', '12', 1, 0)] };
    else if (url.includes('/fifa.friendly/teams/20/schedule')) body = { events: [game('f1', '2026-06-06T18:00Z', '20', '13', 4, 0), game('b4', '2026-10-13T18:45Z', '20', '12', 1, 0)] };
    return { ok: true, json: async () => body };
  };
  const match = { id: '99', league: 'uefa.nations', state: 'pre', date: '2026-11-14T19:45:00Z', home: { id: '10' }, away: { id: '20' } };
  const d = await fetchDetail(match);
  assert.deepEqual({ ...d.table.home }, { gp: 6, gf: 9, ga: 4, pts: 13, rank: null, league: 'international' }); // 2025 game is outside the window
  assert.equal(d.table.away.gp, 5); // the duplicate b4 counted once
  assert.equal(d.form.home.length, 5);
  assert.equal(d.form.home[0].opp, 'T4'); // newest first
  assert.ok(!requested.some((u) => /eng\.1|ger\.1/.test(u)), 'no domestic leagues are tried for national teams');
  const c = confidence(match, d, h2hSummary([], '10'));
  assert.equal(c.level, 'High');
  assert.match(c.have[0], /international match records/);
});
