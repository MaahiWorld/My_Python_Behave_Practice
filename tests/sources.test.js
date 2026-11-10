import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afParseFixture, afParseDetail, smParseFixture, smParseDetail, fdParseMatch, fdParseDetail, SOURCES } from '../js/sources.js';
import { predict } from '../js/model.js';

test('registry: ESPN is free and keyless, others need keys and have adapters', () => {
  assert.equal(SOURCES[0].id, 'espn');
  assert.equal(SOURCES[0].needsKey, false);
  for (const s of SOURCES.slice(1)) {
    assert.equal(s.needsKey, true);
    const fns = s.kind === 'odds' ? ['test'] : ['fetchMatches', 'fetchDetail', 'test'];
    for (const fn of fns) assert.equal(typeof s.adapter[fn], 'function', `${s.id}.${fn}`);
  }
});

test('API-Football fixture + detail parse, with xG flowing into the reasoning', () => {
  const m = afParseFixture({
    fixture: { id: 99, date: '2026-11-06T15:00:00+00:00', status: { short: '2H', elapsed: 67, extra: null }, venue: { name: 'Park' } },
    league: { id: 39, name: 'Premier League', country: 'England', season: 2026 },
    teams: { home: { id: 1, name: 'Home FC', logo: 'h.png' }, away: { id: 2, name: 'Away FC' } },
    goals: { home: 1, away: 0 },
  });
  assert.equal(m.state, 'in');
  assert.equal(m.minute, 67);
  assert.equal(m.home.score, 1);
  assert.equal(m.leagueName, 'Premier League (England)');
  assert.equal(m.phase, 'H2');
  const base = { fixture: { id: 1 }, league: {}, teams: { home: { id: 1 }, away: { id: 2 } }, goals: {} };
  assert.equal(afParseFixture({ ...base, fixture: { id: 1, status: { short: '1H', elapsed: 45, extra: 3 } } }).minute, 48);
  assert.equal(afParseFixture({ ...base, fixture: { id: 1, status: { short: '1H', elapsed: 45, extra: 3 } } }).phase, 'H1');
  assert.equal(afParseFixture({ ...base, fixture: { id: 1, status: { short: 'ET', elapsed: 104 } } }).phase, 'ET');
  assert.equal(afParseFixture({ ...base, fixture: { id: 1, status: { short: 'P', elapsed: 120 } } }).phase, 'PEN');
  assert.equal(afParseFixture({ ...base, fixture: { id: 1, status: { short: 'BT', elapsed: 90 } } }).phase, 'BREAK_ET');

  const fx = (h, a, hg, ag) => ({ fixture: { date: '2026-10-01' }, teams: { home: { id: h, name: 'T' + h }, away: { id: a, name: 'T' + a } }, goals: { home: hg, away: ag } });
  const d = afParseDetail(m, {
    stats: [
      { team: { id: 1 }, statistics: [{ type: 'Shots on Goal', value: 5 }, { type: 'Ball Possession', value: '58%' }, { type: 'expected_goals', value: '1.84' }] },
      { team: { id: 2 }, statistics: [{ type: 'Shots on Goal', value: 1 }, { type: 'Ball Possession', value: '42%' }, { type: 'expected_goals', value: '0.31' }] },
    ],
    lineups: [{ team: { id: 1 }, startXI: [{ player: { name: 'Starter', number: 9, pos: 'F' } }], substitutes: [{ player: { name: 'Bench', number: 14, pos: 'F' } }] }],
    events: [
      { team: { id: 1 }, type: 'subst', player: { name: 'Starter' }, assist: { name: 'Bench' } },
      { team: { id: 2 }, type: 'Card', detail: 'Red Card', player: { name: 'X' } },
    ],
    h2h: [fx(2, 1, 2, 2), fx(1, 2, 3, 1)],
    formH: [fx(1, 5, 2, 0)], formA: [fx(6, 2, 1, 1)],
    standings: [[{ team: { id: 1 }, rank: 2, all: { played: 10, goals: { for: 20, against: 8 } } }, { team: { id: 2 }, rank: 15, all: { played: 10, goals: { for: 9, against: 18 } } }]],
  });
  assert.equal(d.liveStats.home.xg, 1.84);
  assert.equal(d.liveStats.home.possession, 58);
  assert.equal(d.redCards.away, 1);
  assert.deepEqual(d.lineups.home.filter((p) => p.onPitch).map((p) => p.name), ['Bench']);
  assert.equal(d.form.home[0].res, 'W');
  assert.equal(d.h2h.length, 2);
  assert.equal(d.table.home.gf, 20);

  const p = predict(m, d);
  const keys = p.reasons.map((r) => r.key);
  const liveStep = p.reasons.find((r) => r.key === 'live');
  assert.ok(liveStep && /xG/.test(liveStep.detail) && liveStep.evidence.some((e) => e.includes('xG')), 'xG used in match stats');
  assert.ok(keys.includes('red'), 'red card from events');
  assert.ok(p.confidence.have.includes('current match stats with xG'));
});

test('Sportmonks fixture + detail parse', () => {
  const raw = {
    id: 5, league_id: 8, season_id: 1, starting_at_timestamp: 1_790_000_000,
    league: { name: 'Premier League' }, state: { developer_name: 'INPLAY_2ND_HALF' },
    periods: [{ ticking: false, minutes: 45 }, { ticking: true, minutes: 71 }],
    participants: [{ id: 10, name: 'Home', short_code: 'HOM', meta: { location: 'home' } }, { id: 20, name: 'Away', meta: { location: 'away' } }],
    scores: [{ description: 'CURRENT', score: { goals: 2, participant: 'home' } }, { description: 'CURRENT', score: { goals: 2, participant: 'away' } }, { description: '1ST_HALF', score: { goals: 1, participant: 'home' } }],
  };
  const m = smParseFixture(raw);
  assert.equal(m.state, 'in');
  assert.equal(m.minute, 71);
  assert.equal(m.home.score, 2);
  assert.equal(m.away.score, 2);
  const d = smParseDetail(m, {
    ...raw,
    statistics: [{ type_id: 86, participant_id: 10, data: { value: 4 } }, { type_id: 86, participant_id: 20, data: { value: 3 } }],
    xgfixture: [{ type_id: 5304, participant_id: 10, data: { value: 1.2 } }, { type_id: 5304, participant_id: 20, data: { value: 1.6 } }],
    lineups: [{ team_id: 10, player_name: 'A', jersey_number: 7, type_id: 11 }, { team_id: 10, player_name: 'B', jersey_number: 12, type_id: 12 }],
    events: [{ type_id: 18, participant_id: 10, player_name: 'B', related_player_name: 'A' }],
  });
  assert.equal(d.liveStats.away.xg, 1.6);
  assert.equal(d.liveStats.home.shotsOnTarget, 4);
  assert.deepEqual(d.lineups.home.filter((p) => p.onPitch).map((p) => p.name), ['B']);
});

test('football-data.org match + detail parse', () => {
  const m = fdParseMatch({
    id: 3, utcDate: '2026-11-06T15:00:00Z', status: 'IN_PLAY', minute: 30, competition: { code: 'PL', name: 'Premier League' },
    homeTeam: { id: 57, name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS' }, awayTeam: { id: 61, name: 'Chelsea FC', shortName: 'Chelsea', tla: 'CHE' },
    score: { fullTime: { home: 0, away: 1 } },
  });
  assert.equal(m.state, 'in');
  assert.equal(m.minute, 30);
  assert.equal(m.away.score, 1);
  const fin = (h, a, hg, ag) => ({ status: 'FINISHED', utcDate: '2026-10-01T15:00:00Z', homeTeam: { id: h }, awayTeam: { id: a }, score: { fullTime: { home: hg, away: ag } } });
  const d = fdParseDetail(m, {
    standings: { standings: [{ type: 'TOTAL', table: [{ team: { id: 57 }, playedGames: 10, goalsFor: 22, goalsAgainst: 7, position: 1 }, { team: { id: 61 }, playedGames: 10, goalsFor: 15, goalsAgainst: 12, position: 5 }] }] },
    h2h: { matches: [fin(61, 57, 1, 1)] },
    formH: { matches: [fin(57, 1, 3, 0), fin(2, 57, 0, 1)] }, formA: { matches: [fin(61, 3, 0, 2)] },
  });
  assert.equal(d.table.home.gf, 22);
  assert.equal(d.form.home.length, 2);
  assert.equal(d.form.home[0].res, 'W');
  assert.equal(d.form.away[0].res, 'L');
  assert.equal(d.h2h[0].res, 'D');
  assert.ok(Number.isFinite(predict(m, d).pMoreGoal));
});

import { parseSchedule, parseSummary } from '../js/api.js';

test('ESPN recent form is read from lastFiveGames when boxscore.form is absent', () => {
  const match = { home: { id: '1' }, away: { id: '2' } };
  const ev = (h, a, hs, as) => ({ homeTeamId: h, awayTeamId: a, homeTeamScore: String(hs), awayTeamScore: String(as) });
  const d = parseSummary({ lastFiveGames: [{ team: { id: '1' }, events: [ev('1', '9', 2, 0), ev('8', '1', 1, 1), ev('1', '7', 0, 1), ev('6', '1', 0, 3)] }] }, match);
  assert.deepEqual(d.form.home.map((g) => g.res), ['W', 'D', 'L', 'W']);
});

test('recent form can be rebuilt from a team schedule (completed games only, newest first)', () => {
  const g = (date, done, myScore, oppScore, home = true) => ({
    date, competitions: [{ status: { type: { completed: done } }, competitors: [
      { id: '5', homeAway: home ? 'home' : 'away', score: { value: myScore }, team: { id: '5' } },
      { id: '9', homeAway: home ? 'away' : 'home', score: { displayValue: String(oppScore) }, team: { id: '9', shortDisplayName: 'Opp' } }] }],
  });
  const json = { events: [g('2026-10-01T15:00Z', true, 2, 1), g('2026-10-08T15:00Z', true, 0, 0, false), g('2026-10-15T15:00Z', true, 1, 3),
    g('2026-10-22T15:00Z', true, 4, 0), g('2026-10-29T15:00Z', true, 1, 2), g('2026-09-20T15:00Z', true, 3, 3), g('2026-11-20T15:00Z', false, 0, 0)] };
  const form = parseSchedule(json, '5', '2026-11-07T15:00Z');
  assert.equal(form.length, 5);
  assert.deepEqual(form.map((x) => x.res), ['L', 'W', 'L', 'D', 'W']);
  assert.equal(form[3].home, false);
  assert.equal(form[0].opp, 'Opp');
});

test('half-time score, extra time and ESPN result parsing', async () => {
  const { halfTime, parseResult, wentToExtraTime } = await import('../js/api.js');
  assert.deepEqual(halfTime({ linescores: [{ value: 1 }, { value: 1 }] }, { linescores: [{ value: 0 }, { value: 2 }] }), { home: 1, away: 0 });
  assert.equal(halfTime({}, {}), null);
  assert.ok(wentToExtraTime({ type: { name: 'STATUS_FINAL_AET' } }));
  assert.ok(!wentToExtraTime({ type: { name: 'STATUS_FULL_TIME', shortDetail: 'FT' }, period: 2 }));
  const r = parseResult({ header: { competitions: [{ status: { type: { state: 'post', name: 'STATUS_FULL_TIME', shortDetail: 'FT' }, period: 2 }, competitors: [
    { homeAway: 'home', score: '2', linescores: [{ displayValue: '1' }, { displayValue: '1' }] },
    { homeAway: 'away', score: '1', linescores: [{ displayValue: '0' }, { displayValue: '1' }] }] }] } });
  assert.deepEqual(r, { state: 'post', hs: 2, as: 1, ht: { home: 1, away: 0 }, aet: false, detail: 'FT' });
});
