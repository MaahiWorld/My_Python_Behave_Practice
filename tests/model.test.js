import { test } from 'node:test';
import assert from 'node:assert/strict';
import { predict, remainingShare, poisson, teamStrength } from '../js/model.js';
import { parseScoreboard, parseSummary, parseStandings, parseMinute } from '../js/api.js';
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
  assert.ok(Math.abs(remainingShare(45, 'in') - 0.55) < 1e-9);
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
  assert.ok(strong.expectedMoreHome > neutral.expectedMoreHome * 1.5);
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
