// Offline demo data in the app's normalized shape (fictional clubs).
const T = (id, name, abbr, color) => ({ id, name, short: name, abbr, color, logo: '' });

const TEAMS = {
  riv: T('d1', 'Riverside FC', 'RIV', '#e4572e'),
  nor: T('d2', 'Northgate United', 'NOR', '#2e86de'),
  har: T('d3', 'Harbour City', 'HAR', '#17a589'),
  ash: T('d4', 'Ashford Athletic', 'ASH', '#8e44ad'),
  vale: T('d5', 'Vale Rovers', 'VAL', '#f1c40f'),
  kin: T('d6', 'Kingsbridge Town', 'KIN', '#c0392b'),
  mill: T('d7', 'Millbrook Wanderers', 'MIL', '#34495e'),
  east: T('d8', 'Eastport Albion', 'EAS', '#27ae60'),
};

function seq(seed) {
  let s = seed;
  return () => ((s = (s * 9301 + 49297) % 233280) / 233280);
}

function makeForm(rand, strength) {
  return Array.from({ length: 5 }, (_, i) => {
    const gf = Math.round(rand() * 2.2 * strength);
    const ga = Math.round(rand() * 2.2 / strength);
    return { gf, ga, res: gf > ga ? 'W' : gf < ga ? 'L' : 'D', opp: 'Opponent ' + (i + 1), home: i % 2 === 0, date: '' };
  });
}

function makeLineup(prefix, rand) {
  const pos = ['G', 'D', 'D', 'D', 'D', 'M', 'M', 'M', 'F', 'F', 'F'];
  const players = pos.map((p, i) => ({
    name: `${prefix} Player ${i + 1}`, jersey: String(i + 1), pos: p,
    starter: true, subIn: false, subOut: false, onPitch: true, goals: 0, assists: 0, yellow: 0, red: 0,
  }));
  if (rand() > 0.4) {
    players[9].subOut = true; players[9].onPitch = false;
    players.push({ name: `${prefix} Sub 12`, jersey: '12', pos: 'F', starter: false, subIn: true, subOut: false, onPitch: true, goals: 0, assists: 0, yellow: 0, red: 0 });
  }
  return players;
}

const FIXTURES = [
  ['riv', 'nor', 'in', 63, 1, 1, 1.25, 1.1],
  ['har', 'ash', 'in', 28, 0, 0, 0.85, 0.9],
  ['vale', 'kin', 'in', 81, 2, 0, 1.2, 0.8],
  ['mill', 'east', 'in', 45, 0, 1, 1.0, 1.15],
  ['nor', 'har', 'pre', 0, 0, 0, 1.1, 0.85],
  ['ash', 'riv', 'post', 90, 2, 3, 0.9, 1.25],
];

export function demoMatches() {
  const now = Date.now();
  return FIXTURES.map(([h, a, state, minute, hs, as], i) => ({
    id: 'demo' + i,
    league: 'demo',
    leagueName: 'Demo League',
    date: new Date(now + (state === 'pre' ? 2 : -1) * 3_600_000).toISOString(),
    state,
    minute,
    detail: state === 'in' ? (minute === 45 ? 'HT' : `${minute}'`) : state === 'post' ? 'FT' : '',
    phase: state !== 'in' ? null : minute === 45 ? 'HT' : minute < 45 ? 'H1' : 'H2',
    venue: TEAMS[h].name + ' Stadium',
    home: { ...TEAMS[h], score: hs, redCards: i === 2 ? 1 : 0, formString: '' },
    away: { ...TEAMS[a], score: as, redCards: 0, formString: '' },
  }));
}

export function demoDetail(match) {
  const i = parseInt(match.id.replace('demo', ''), 10) || 0;
  const [, , , minute, , , sH, sA] = FIXTURES[i] || FIXTURES[0];
  const rand = seq(17 + i * 31);
  const gp = 11;
  const table = (s) => ({ gp, gf: Math.round(gp * 1.35 * s), ga: Math.round(gp * 1.35 / s), rank: Math.ceil(rand() * 20), pts: null });
  const h2h = Array.from({ length: 5 }, (_, k) => {
    const homeFirst = k % 2 === 0;
    return {
      hs: Math.round(rand() * 3), as: Math.round(rand() * 2.5),
      homeId: homeFirst ? match.home.id : match.away.id,
      awayId: homeFirst ? match.away.id : match.home.id,
      date: `${2025 - k}-03-1${k}`, gf: 0, ga: 0, res: '-', opp: '', home: homeFirst,
    };
  });
  const live = (s) => match.state === 'pre' ? {} : {
    possession: Math.round(50 * s / ((sH + sA) / 2)),
    shots: Math.round(minute / 7 * s), shotsOnTarget: Math.round(minute / 18 * s),
    corners: Math.round(minute / 15 * s), fouls: Math.round(minute / 9), yellow: Math.round(rand() * 2), red: 0,
  };
  return {
    form: { home: makeForm(rand, sH), away: makeForm(rand, sA) },
    h2h,
    liveStats: { home: live(sH), away: live(sA) },
    lineups: { home: makeLineup(match.home.abbr, rand), away: makeLineup(match.away.abbr, rand) },
    table: { home: table(sH), away: table(sA) },
    leagueAvg: 1.35,
    events: [],
  };
}
