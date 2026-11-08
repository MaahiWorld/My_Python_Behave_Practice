import { test } from 'node:test';
import assert from 'node:assert/strict';
import { predict, remainingShare, poisson, teamStrength, PARAMS } from '../js/model.js';
import { parseScoreboard, parseSummary, parseStandings, parseMinute, parsePhase } from '../js/api.js';
import { demoMatches, demoDetail } from '../js/demo.js';

const team = (id, score = 0, extra = {}) => ({ id, name: 'T' + id, short: 'T' + id, abbr: 'T' + id, score, redCards: 0, ...extra });
const match = (o = {}) => ({ id: '1', league: 'x', state: 'pre', minute: 0, home: team('h'), away: team('a'), ...o });

test('poisson probabilities sum to ~1', () => {
  let s = 0;
  for (let k = 0; k < 30; k++) s += poisson(k, 2.7);
  assert.ok(Math.abs(s - 1) < 1e-9);
});

test('remaining share falls from 1 to near 0 across a match', () => {
  assert.equal(remainingShare(0, 'pre'), 1);
  assert.equal(remainingShare(90, 'post'), 0);
  assert.ok(Math.abs(remainingShare(45, 'in', 'HT') - (1 - PARAMS.firstHalfShare)) < 1e-9);
  assert.ok(remainingShare(30, 'in') > remainingShare(70, 'in'));
  assert.ok(remainingShare(94, 'in') > 0);
});

test('neutral pre-match teams produce a sensible goal expectancy', () => {
  const p = predict(match());
  assert.ok(p.expectedMore > 2.4 && p.expectedMore < 3.0, String(p.expectedMore));
  assert.ok(p.pMoreGoal > 0.9);
  assert.ok(Math.abs(p.outcome.homeWin + p.outcome.draw + p.outcome.awayWin - 1) < 1e-6);
  assert.ok(p.outcome.homeWin > p.outcome.awayWin, 'home advantage');
});

test('goal chance shrinks late in a live match', () => {
  const early = predict(match({ state: 'in', minute: 10 }));
  const late = predict(match({ state: 'in', minute: 85 }));
  assert.ok(early.pMoreGoal > late.pMoreGoal);
  assert.ok(late.pMoreGoal < 0.3);
});

test('strong attack vs weak defence raises expected goals', () => {
  const detail = {
    table: { home: { gp: 10, gf: 28, ga: 8 }, away: { gp: 10, gf: 9, ga: 25 } },
    form: { home: [], away: [] },
  };
  const strong = predict(match(), detail);
  const neutral = predict(match());
  assert.ok(strong.expectedMoreHome > neutral.expectedMoreHome * 1.3);
  assert.ok(strong.ratings.home.attack > strong.ratings.away.attack);
  assert.ok(strong.ratings.home.defense > strong.ratings.away.defense);
});

test('red card and scoreline shift the live split', () => {
  const base = predict(match({ state: 'in', minute: 50 }));
  const red = predict(match({ state: 'in', minute: 50, home: team('h', 0, { redCards: 1 }) }));
  assert.ok(red.expectedMoreHome < base.expectedMoreHome);
  assert.ok(red.expectedMoreAway > base.expectedMoreAway);
  const trailingHome = predict(match({ state: 'in', minute: 50, away: team('a', 1) }));
  assert.ok(trailingHome.expectedMoreHome > base.expectedMoreHome);
});

test('final score candidates include the current score as a floor', () => {
  const p = predict(match({ state: 'in', minute: 70, home: team('h', 2), away: team('a', 1) }));
  for (const s of p.topScores) assert.ok(s.home >= 2 && s.away >= 1);
});

test('team strength shrinks small samples toward average', () => {
  const s = teamStrength({ table: { gp: 1, gf: 5, ga: 0 } });
  assert.ok(s.att < 2 && s.att > 1);
});

test('parseMinute handles ESPN clock formats', () => {
  assert.equal(parseMinute({ displayClock: "67'" }), 67);
  assert.equal(parseMinute({ displayClock: "90'+3'" }), 93);
  assert.equal(parseMinute({ type: { name: 'STATUS_HALFTIME' }, displayClock: "45'" }), 45);
});

test('parses an ESPN-style scoreboard and summary', () => {
  const sb = {
    events: [{
      id: '700', date: '2026-11-06T15:00Z',
      status: { displayClock: "58'", type: { state: 'in', shortDetail: "58'" } },
      competitions: [{
        venue: { fullName: 'Ground' },
        details: [{ redCard: true, team: { id: '2' } }],
        competitors: [
          { homeAway: 'home', score: '1', form: 'WWDLW', team: { id: '1', displayName: 'Alpha FC', shortDisplayName: 'Alpha', abbreviation: 'ALP', logo: 'a.png' } },
          { homeAway: 'away', score: '0', team: { id: '2', displayName: 'Beta FC', abbreviation: 'BET' } },
        ],
      }],
    }],
  };
  const [m] = parseScoreboard(sb, 'eng.1');
  assert.equal(m.minute, 58);
  assert.equal(m.home.score, 1);
  assert.equal(m.away.redCards, 1);
  assert.equal(m.leagueName, 'Premier League');

  const summary = {
    boxscore: {
      form: [{ team: { id: '1' }, events: [{ gameResult: 'W', homeTeamId: '1', awayTeamId: '9', homeTeamScore: '3', awayTeamScore: '1' }] }],
      teams: [{ team: { id: '1' }, statistics: [{ name: 'shotsOnTarget', displayValue: '5' }, { name: 'possessionPct', displayValue: '61.2' }] }],
    },
    headToHeadGames: [{ team: { id: '1' }, events: [{ id: 'g1', homeTeamId: '2', awayTeamId: '1', homeTeamScore: '2', awayTeamScore: '2' }] }],
    rosters: [{ team: { id: '1' }, roster: [
      { starter: true, athlete: { displayName: 'Keeper' }, position: { abbreviation: 'G' }, stats: [] },
      { starter: true, subbedOut: true, athlete: { displayName: 'Tired' } },
      { starter: false, subbedIn: { didSub: true }, athlete: { displayName: 'Fresh' }, stats: [{ name: 'totalGoals', value: 1 }] },
    ] }],
  };
  const standings = parseStandings({ children: [{ standings: { entries: [
    { team: { id: '1' }, stats: [{ name: 'gamesPlayed', value: 10 }, { name: 'pointsFor', value: 20 }, { name: 'pointsAgainst', value: 8 }] },
    { team: { id: '2' }, stats: [{ name: 'gamesPlayed', value: 10 }, { name: 'pointsFor', value: 12 }, { name: 'pointsAgainst', value: 15 }] },
  ] } }] });
  const d = parseSummary(summary, m, standings);
  assert.deepEqual(d.form.home[0], { ...d.form.home[0], gf: 3, ga: 1, res: 'W' });
  assert.equal(d.h2h.length, 1);
  assert.equal(d.liveStats.home.shotsOnTarget, 5);
  assert.equal(d.table.home.gf, 20);
  const onPitch = d.lineups.home.filter((p) => p.onPitch).map((p) => p.name);
  assert.deepEqual(onPitch, ['Keeper', 'Fresh']);
  const p = predict(m, d);
  assert.ok(p.pMoreGoal > 0 && p.pMoreGoal < 1);
});

test('demo data runs through the model', () => {
  for (const m of demoMatches()) {
    const p = predict(m, demoDetail(m));
    assert.ok(Number.isFinite(p.pMoreGoal));
  }
});

test('every prediction carries a reasoning ledger that adds up', () => {
  const m = match({ state: 'in', minute: 60, home: team('h', 0, { redCards: 1 }), away: team('a', 1) });
  const d = {
    table: { home: { gp: 10, gf: 20, ga: 10 }, away: { gp: 10, gf: 10, ga: 15 } },
    form: { home: Array(5).fill({ gf: 2, ga: 1, res: 'W' }), away: Array(5).fill({ gf: 0, ga: 0, res: 'D' }) },
    h2h: [{ homeId: 'h', hs: 3, as: 2 }, { homeId: 'a', hs: 1, as: 1 }, { homeId: 'h', hs: 2, as: 2 }],
    liveStats: { home: { shotsOnTarget: 6 }, away: { shotsOnTarget: 1 } },
  };
  const p = predict(m, d);
  const keys = p.reasons.map((r) => r.key);
  for (const k of ['baseline', 'strength', 'form', 'h2h', 'time', 'score', 'red', 'live']) assert.ok(keys.includes(k), k);
  const total = p.reasons.reduce((s, r) => s + r.delta, 0);
  assert.ok(Math.abs(total - p.expectedMore) < 1e-9, 'step deltas sum to expected remaining goals');
  for (const r of p.reasons) assert.ok(r.detail.length > 20 && !r.detail.includes('undefined') && !r.detail.includes('NaN'), r.key);
  assert.equal(p.confidence.level, 'High');
  assert.equal(predict(m, { ...d, form: { home: [{ gf: 2, ga: 1, res: 'W' }], away: [] } }).confidence.level, 'Medium', 'one recent match is not enough');
  assert.equal(p.summary.length, 2);
});

test('finished matches expect no more goals', () => {
  const p = predict(match({ state: 'post', home: team('h', 2), away: team('a', 1) }));
  assert.equal(p.expectedMore, 0);
  assert.equal(p.pMoreGoal, 0);
});

test('rest-of-match goal scope exists for every minute, from kick-off to the end of extra time', () => {
  const t = (id) => ({ id, name: id, short: id, abbr: id, score: 0 });
  const at = (minute, phase) => predict({ id: '1', state: 'in', minute, phase, home: t('h'), away: t('a') });
  let prev = Infinity;
  for (let m = 0; m <= 100; m++) {
    const p = at(m, m <= 45 ? 'H1' : 'H2');
    assert.ok(p.expectedMore > 0 && p.expectedMore <= prev + 1e-9, `${m}' expected goals left never rises as time passes`);
    assert.ok(p.pMoreGoal > 0 && p.pMoreGoal < 1, `${m}' chance of 1+ more`);
    assert.ok(Math.abs(p.moreDist.reduce((s, v) => s + v, 0) - 1) < 1e-9, `${m}' goal-count distribution sums to 1`);
    assert.ok(p.reasons.every((r) => !/undefined|NaN/.test(r.detail)), `${m}' reasoning text`);
    prev = p.expectedMore;
  }
  assert.ok(at(85, 'H2').expectedMore > at(93, 'H2').expectedMore, 'late added time tapers, not frozen');
  assert.ok(Math.abs(at(45, 'HT').expectedMore - at(45, 'H2').expectedMore) < 0.05, 'half time: the whole second half remains');
  assert.ok(at(47, 'H1').expectedMore > at(47, 'H2').expectedMore, '45+2 is still the first half');
  for (let m = 91; m <= 121; m++) assert.ok(at(m, 'ET').expectedMore > 0, `${m}' ET`);
  assert.ok(at(90, 'BREAK_ET').expectedMore > at(110, 'ET').expectedMore);
  const pen = at(120, 'PEN');
  assert.equal(pen.expectedMore, 0);
  assert.equal(pen.verdict, 'Penalty shoot-out');
  assert.equal(at(10, 'H1').scopeLevel, 'high');
  assert.equal(at(88, 'H2').scopeLevel, 'low');
});

test('ESPN phase parsing', () => {
  assert.equal(parsePhase({ period: 1, type: { name: 'STATUS_FIRST_HALF' } }), 'H1');
  assert.equal(parsePhase({ period: 1, type: { name: 'STATUS_HALFTIME' } }), 'HT');
  assert.equal(parsePhase({ period: 2, type: { name: 'STATUS_SECOND_HALF' } }), 'H2');
  assert.equal(parsePhase({ period: 2, type: { name: 'STATUS_END_OF_REGULATION' } }), 'BREAK_ET');
  assert.equal(parsePhase({ period: 3, type: { name: 'STATUS_FIRST_HALF_EXTRA_TIME' } }), 'ET');
  assert.equal(parsePhase({ period: 5, type: { name: 'STATUS_SHOOTOUT' } }), 'PEN');
  assert.equal(parseMinute({ period: 1, displayClock: "45'+2'" }), 47);
});

test('each input moves the goal scope the right way: attack/defence, recent form, current match stats', () => {
  const t = (id, score = 0) => ({ id, name: id, short: id, abbr: id, score });
  const m = { id: '1', state: 'in', minute: 55, phase: 'H2', home: t('h'), away: t('a') };
  const avgTable = { home: { gp: 12, gf: 16, ga: 16 }, away: { gp: 12, gf: 16, ga: 16 } };
  const games = (gf, ga, res) => Array.from({ length: 5 }, () => ({ gf, ga, res }));
  const base = predict(m, { table: avgTable }).expectedMore;

  // Attacking and defending power.
  const attacking = predict(m, { table: { home: { gp: 12, gf: 30, ga: 10 }, away: { gp: 12, gf: 20, ga: 26 } } }).expectedMore;
  const defensive = predict(m, { table: { home: { gp: 12, gf: 9, ga: 7 }, away: { gp: 12, gf: 8, ga: 8 } } }).expectedMore;
  assert.ok(attacking > base * 1.15 && defensive < base * 0.85, `${attacking} / ${base} / ${defensive}`);

  // Recent form on top of the season level.
  const hot = predict(m, { table: avgTable, form: { home: games(3, 2, 'W'), away: games(2, 3, 'L') } });
  const cold = predict(m, { table: avgTable, form: { home: games(0, 0, 'D'), away: games(0, 1, 'L') } });
  assert.ok(hot.expectedMore > base && cold.expectedMore < base);
  assert.equal(hot.reasons.find((r) => r.key === 'form').impact, 'up');
  assert.equal(cold.reasons.find((r) => r.key === 'form').impact, 'down');
  // Form alone sets the level when there is no season record.
  assert.ok(predict(m, { form: { home: games(3, 2, 'W'), away: games(2, 3, 'L') } }).expectedMore > predict(m, {}).expectedMore);

  // Current match stats.
  const busy = { shotsOnTarget: 7, shots: 15, corners: 7, possession: 55 };
  const quiet = { shotsOnTarget: 0, shots: 2, corners: 0, possession: 45 };
  const open = predict(m, { table: avgTable, liveStats: { home: busy, away: busy } });
  const flat = predict(m, { table: avgTable, liveStats: { home: quiet, away: quiet } });
  assert.ok(open.expectedMore > base && flat.expectedMore < base);
  const live = open.reasons.find((r) => r.key === 'live');
  assert.ok(['shots on target', 'shots', 'corners', 'possession'].every((k) => live.evidence.some((e) => e.includes(k))), 'all match stats used');
  // Match stats count for more late in the game than early on.
  const early = predict({ ...m, minute: 20, phase: 'H1' }, { table: avgTable, liveStats: { home: { ...busy, shotsOnTarget: 3, shots: 6, corners: 3 }, away: quiet } });
  const late = predict({ ...m, minute: 75 }, { table: avgTable, liveStats: { home: { ...busy, shotsOnTarget: 11, shots: 23, corners: 10 }, away: quiet } });
  const trust = (p) => p.reasons.find((r) => r.key === 'live').detail.match(/(\d+)% weight/)[1];
  assert.ok(+trust(late) > +trust(early));
});

test('first-half goal chances, pre-match and live', async () => {
  const { predict: pr } = await import('../js/model.js');
  const T2 = (id, score = 0) => ({ id, name: id, short: id, abbr: id, score });
  const base = { id: '1', league: 'x', leagueName: 'X', date: '2026-11-06T15:00:00Z', home: T2('h'), away: T2('a') };
  const pre = pr({ ...base, state: 'pre', minute: 0 });
  assert.ok(pre.firstHalf.over05 > 0.6 && pre.firstHalf.over05 < 0.8);
  assert.ok(pre.firstHalf.over15 < pre.firstHalf.over05);
  const early = pr({ ...base, state: 'in', minute: 10, phase: 'H1' });
  const late = pr({ ...base, state: 'in', minute: 40, phase: 'H1' });
  assert.ok(late.firstHalf.over05 < early.firstHalf.over05);
  const scored = pr({ ...base, state: 'in', minute: 30, phase: 'H1', home: T2('h', 1) });
  assert.equal(scored.firstHalf.over05, 1);
  const second = pr({ ...base, state: 'in', minute: 60, phase: 'H2', ht: { home: 1, away: 1 } });
  assert.deepEqual([second.firstHalf.decided, second.firstHalf.over15], [true, 1]);
  const o = pre.outcome;
  assert.ok(Math.abs(o.homeWin + o.draw + o.awayWin - 1) < 1e-9);
  assert.ok(o.homeWin > o.awayWin, 'home advantage');
});

test('league points per game sharpen the result but not goal totals', async () => {
  const { predict: pr, ppgEdge } = await import('../js/model.js');
  const T2 = (id) => ({ id, name: id, short: id, abbr: id, score: 0 });
  const m = { id: '1', league: 'x', state: 'pre', minute: 0, home: T2('h'), away: T2('a') };
  const row = (pts) => ({ gp: 10, gf: 14, ga: 14, pts });
  const level = pr(m, { table: { home: row(15), away: row(15) } });
  const strong = pr(m, { table: { home: row(25), away: row(8) } });
  assert.equal(ppgEdge({ table: { home: row(15), away: row(15) } }), 0);
  assert.ok(strong.outcome.homeWin > level.outcome.homeWin + 0.1, 'better points record wins more often');
  assert.ok(Math.abs(strong.expectedFinalTotal - level.expectedFinalTotal) < 1e-9, 'goal totals unchanged');
  assert.ok(Math.abs(strong.over25 - level.over25) < 1e-9);
  // No table: points per game from recent form, at its own (smaller) weight.
  const f = (res) => Array.from({ length: 5 }, () => ({ gf: 1, ga: 1, res }));
  assert.ok(ppgEdge({ form: { home: f('W'), away: f('L') } }) > 0);
  assert.equal(ppgEdge({ form: { home: f('W'), away: f('L').slice(0, 3) } }), 0, 'needs 4+ matches each');
});

test('market calibration applies before kick-off only', async () => {
  const { predict: pr, calibrate, PARAMS: P } = await import('../js/model.js');
  const T2 = (id, score = 0) => ({ id, name: id, short: id, abbr: id, score });
  const base = { id: '1', league: 'x', home: T2('h'), away: T2('a') };
  const saved = P.calib;
  try {
    P.calib = {};
    const rawPre = pr({ ...base, state: 'pre', minute: 0 });
    const rawLive = pr({ ...base, state: 'in', minute: 20, phase: 'H1' });
    P.calib = saved;
    const pre = pr({ ...base, state: 'pre', minute: 0 });
    const live = pr({ ...base, state: 'in', minute: 20, phase: 'H1' });
    assert.equal(pre.btts, calibrate('btts', rawPre.btts));
    assert.notEqual(pre.btts, rawPre.btts);
    assert.equal(live.btts, rawLive.btts);
    assert.equal(calibrate('none', 0.7), 0.7);
  } finally { P.calib = saved; }
});

test('backtest loader reads goalless draws in both openfootball formats', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loadContexts } = await import('../backtest/lib.js');
  const dir = mkdtempSync(join(tmpdir(), 'gs-'));
  try {
    writeFileSync(join(dir, '2025-26.en.1.json'), JSON.stringify({ matches: [
      { date: '2025-08-15', team1: 'A', team2: 'B', score: { ft: [2, 1], ht: [1, 0] } },
      { date: '2025-08-16', team1: 'C', team2: 'D', score: [0, 0] },
      { date: '2025-08-17', team1: 'E', team2: 'F', score: { ft: [0, 0] } },
      { date: '2025-08-18', team1: 'G', team2: 'H' },
    ] }));
    const rows = loadContexts(dir);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.m.ht), [[1, 0], [0, 0], [0, 0]]);
    assert.equal(rows[0].match.league, 'eng.1');
  } finally { rmSync(dir, { recursive: true }); }
});
