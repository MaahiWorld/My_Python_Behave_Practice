import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchDetail, homeLeagueCandidates } from '../js/api.js';
import { confidence, h2hSummary } from '../js/model.js';

const team = (id, gp, gf, ga, pts) => ({ team: { id }, stats: [
  { name: 'gamesPlayed', value: gp }, { name: 'pointsFor', value: gf }, { name: 'pointsAgainst', value: ga }, { name: 'points', value: pts }] });
const form = (n) => Array.from({ length: n }, (_, i) => ({ homeTeamScore: 2, awayTeamScore: 1, homeTeamId: 'x', awayTeamId: 'y', gameResult: 'W', gameDate: `2026-10-0${i + 1}` }));

test('domestic cup: candidate leagues are the country\'s divisions', () => {
  const c = homeLeagueCandidates('1', 'eng.fa', new Map());
  assert.deepEqual(c.slice(0, 3), ['eng.1', 'eng.2', 'eng.3']);
  assert.deepEqual(homeLeagueCandidates('1', 'uefa.champions', new Map()), []);
  const scanned = new Map([['ger.1', [{ home: { id: '1' }, away: { id: '2' } }]]]);
  assert.deepEqual(homeLeagueCandidates('1', 'uefa.champions', scanned), ['ger.1']);
});

test('cup game without a table borrows both teams\' domestic league records', async () => {
  globalThis.fetch = async (url) => {
    const body = url.includes('/eng.1/standings') ? { children: [{ standings: { entries: [team('10', 11, 20, 10, 22), team('20', 11, 15, 14, 16), team('30', 11, 5, 25, 4)] } }] }
      : url.includes('/standings') ? { children: [] }
      : url.includes('summary') ? { boxscore: { form: [{ team: { id: '10' }, events: form(5) }, { team: { id: '20' }, events: form(5) }] } }
      : { events: [] };
    return { ok: true, json: async () => body };
  };
  const match = { id: '1', league: 'eng.fa', state: 'pre', date: '2026-11-15T15:00:00Z', home: { id: '10' }, away: { id: '20' } };
  const d = await fetchDetail(match);
  assert.equal(d.table.home.gp, 11);
  assert.equal(d.table.home.league, 'eng.1');
  assert.equal(d.table.away.gf, 15);
  assert.ok(d.leagueAvg > 0);
  assert.equal(confidence(match, d, h2hSummary([], '10')).level, 'High');
});

test('records from different divisions are not treated as comparable', () => {
  const match = { state: 'pre', home: { id: '1' }, away: { id: '2' } };
  const f = form(5).map(() => ({ gf: 1, ga: 1, res: 'D' }));
  const d = (lh, la) => ({ form: { home: f, away: f }, table: { home: { gp: 10, gf: 10, ga: 10, league: lh }, away: { gp: 10, gf: 10, ga: 10, league: la } } });
  assert.equal(confidence(match, d('eng.1', 'ger.1'), h2hSummary([], '1')).level, 'High');
  const lower = confidence(match, d('eng.1', 'eng.3'), h2hSummary([], '1'));
  assert.equal(lower.level, 'Medium');
  assert.match(lower.missing[0], /different divisions/);
});
