// Data source registry. ESPN is free and needs no key; the others activate as soon as
// a key is saved on the Data sources page and the source is selected.
// Every adapter returns the same normalized shapes as js/api.js (ESPN).
import { fetchMatches as espnMatches, fetchDetail as espnDetail, num, proxied, cached } from './api.js';

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const leagueAvgFrom = (rows) => {
  let gp = 0, gf = 0;
  for (const r of Object.values(rows)) { gp += r.gp; gf += r.gf; }
  return gp >= 20 ? gf / gp : null;
};
const gameFrom = (teamId, homeId, awayId, hs, as, date, opp) => {
  const isHome = String(homeId) === String(teamId);
  const gf = isHome ? hs : as, ga = isHome ? as : hs;
  return {
    gf, ga, res: gf > ga ? 'W' : gf < ga ? 'L' : 'D', hs, as,
    homeId: String(homeId), awayId: String(awayId), home: isHome, opp: opp || '', date: date || '',
  };
};
// Mark who is on the pitch from substitution pairs, whichever field order the API uses.
function applySubs(players, subs) {
  const byName = new Map(players.map((p) => [p.name, p]));
  for (const [a, b] of subs) {
    const pa = byName.get(a), pb = byName.get(b);
    const out = pa?.onPitch && !pa.subOut ? pa : pb?.onPitch && !pb.subOut ? pb : null;
    const inn = out === pa ? pb : pa;
    if (out) { out.subOut = true; out.onPitch = false; }
    if (inn) { inn.subIn = true; inn.onPitch = true; }
  }
  return players;
}
const player = (name, jersey, pos, starter) => ({
  name: name || 'Player', jersey: jersey == null ? '' : String(jersey), pos: pos || '',
  starter, subIn: false, subOut: false, onPitch: starter, goals: 0, assists: 0, yellow: 0, red: 0,
});

// ---------------- API-Football (api-sports.io) ----------------
const AF = 'https://v3.football.api-sports.io';
async function afGet(path, key, proxy) {
  const res = await fetch(proxied(AF + path, proxy), { headers: { 'x-apisports-key': key } });
  if (!res.ok) throw new Error(`API-Football ${res.status}`);
  const j = await res.json();
  const errs = j.errors && (Array.isArray(j.errors) ? j.errors : Object.values(j.errors));
  if (errs?.length) throw new Error(`API-Football: ${errs.join('; ')}`);
  return j.response || [];
}
const AF_LIVE = ['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'INT', 'SUSP'];
const AF_DONE = ['FT', 'AET', 'PEN', 'AWD', 'WO', 'CANC', 'ABD', 'PST'];
export function afParseFixture(f) {
  const st = f.fixture?.status || {};
  const state = AF_LIVE.includes(st.short) ? 'in' : AF_DONE.includes(st.short) ? 'post' : 'pre';
  const team = (t, g) => ({
    id: String(t?.id ?? ''), name: t?.name || 'Team', short: t?.name || 'Team',
    abbr: (t?.name || '???').slice(0, 3).toUpperCase(), logo: t?.logo || '', score: num(g) ?? 0, redCards: 0, formString: '',
  });
  return {
    id: String(f.fixture?.id), source: 'apifootball',
    league: `af:${f.league?.id}`, leagueId: f.league?.id, season: f.league?.season,
    leagueName: [f.league?.name, f.league?.country && f.league.country !== 'World' ? `(${f.league.country})` : ''].filter(Boolean).join(' '),
    date: f.fixture?.date, state,
    minute: state === 'in' ? (st.short === 'HT' ? 45 : (st.elapsed || 0) + (st.extra || 0)) : 0,
    detail: st.short === 'HT' ? 'HT' : state === 'in' ? `${st.elapsed}'` : st.short || '',
    venue: f.fixture?.venue?.name || '',
    home: team(f.teams?.home, f.goals?.home), away: team(f.teams?.away, f.goals?.away),
  };
}
export function afParseDetail(match, { stats = [], lineups = [], events = [], h2h = [], formH = [], formA = [], standings = [] }) {
  const hId = match.home.id, aId = match.away.id;
  const statFor = (id) => {
    const s = {};
    for (const x of stats.find((t) => String(t.team?.id) === id)?.statistics || []) s[x.type] = x.value;
    return {
      possession: num(String(s['Ball Possession'] ?? '').replace('%', '')), shots: num(s['Total Shots']),
      shotsOnTarget: num(s['Shots on Goal']), corners: num(s['Corner Kicks']), fouls: num(s.Fouls),
      yellow: num(s['Yellow Cards']), red: num(s['Red Cards']), xg: num(s.expected_goals),
    };
  };
  const lineupFor = (id) => {
    const l = lineups.find((t) => String(t.team?.id) === id);
    const ps = (l?.startXI || []).map((x) => player(x.player?.name, x.player?.number, x.player?.pos, true))
      .concat((l?.substitutes || []).map((x) => player(x.player?.name, x.player?.number, x.player?.pos, false)));
    const subs = events.filter((e) => String(e.team?.id) === id && /subst/i.test(e.type)).map((e) => [e.player?.name, e.assist?.name]);
    applySubs(ps, subs);
    for (const e of events) {
      if (String(e.team?.id) !== id) continue;
      const p = ps.find((x) => x.name === e.player?.name);
      if (e.type === 'Goal' && !/missed/i.test(e.detail || '') && !/own/i.test(e.detail || '') && p) p.goals++;
      if (e.type === 'Card' && /red/i.test(e.detail || '') && p) p.red++;
    }
    return ps;
  };
  const reds = (id) => events.filter((e) => String(e.team?.id) === id && e.type === 'Card' && /red/i.test(e.detail || '')).length;
  const toGame = (f, teamId) => gameFrom(teamId, f.teams?.home?.id, f.teams?.away?.id, num(f.goals?.home) ?? 0, num(f.goals?.away) ?? 0,
    f.fixture?.date, String(f.teams?.home?.id) === String(teamId) ? f.teams?.away?.name : f.teams?.home?.name);
  const table = {};
  for (const row of standings.flat()) {
    if (row?.team?.id != null && row.all?.played != null)
      table[String(row.team.id)] = { gp: row.all.played, gf: row.all.goals?.for ?? 0, ga: row.all.goals?.against ?? 0, rank: row.rank ?? null };
  }
  return {
    form: { home: formH.map((f) => toGame(f, hId)).slice(0, 5), away: formA.map((f) => toGame(f, aId)).slice(0, 5) },
    h2h: h2h.filter((f) => f.goals?.home != null).map((f) => toGame(f, hId)).slice(0, 10),
    liveStats: { home: statFor(hId), away: statFor(aId) },
    lineups: { home: lineupFor(hId), away: lineupFor(aId) },
    table: { home: table[hId] || null, away: table[aId] || null },
    leagueAvg: leagueAvgFrom(table),
    redCards: { home: reds(hId), away: reds(aId) },
    events: [],
  };
}
const apiFootball = {
  async fetchMatches({ key, proxy }) {
    const list = await cached(`af:list:${today()}`, 25_000, () => afGet(`/fixtures?date=${today()}`, key, proxy));
    return list.map(afParseFixture);
  },
  async fetchDetail(m, { key, proxy }) {
    const id = m.id, g = (p) => afGet(p, key, proxy).catch(() => []);
    const long = (k, p) => cached(`af:${k}`, 6 * 3_600_000, () => g(p));
    const [stats, lineups, events, h2h, formH, formA, st] = await Promise.all([
      g(`/fixtures/statistics?fixture=${id}`), long(`lu:${id}`, `/fixtures/lineups?fixture=${id}`), g(`/fixtures/events?fixture=${id}`),
      long(`h2h:${m.home.id}-${m.away.id}`, `/fixtures/headtohead?h2h=${m.home.id}-${m.away.id}&last=10`),
      long(`form:${m.home.id}`, `/fixtures?team=${m.home.id}&last=5`), long(`form:${m.away.id}`, `/fixtures?team=${m.away.id}&last=5`),
      long(`st:${m.leagueId}:${m.season}`, `/standings?league=${m.leagueId}&season=${m.season}`),
    ]);
    return afParseDetail(m, { stats, lineups, events, h2h, formH, formA, standings: st[0]?.league?.standings || [] });
  },
  async test({ key, proxy }) {
    const res = await fetch(proxied(`${AF}/status`, proxy), { headers: { 'x-apisports-key': key } });
    const j = await res.json();
    const errs = j.errors && Object.values(j.errors);
    if (!res.ok || errs?.length) throw new Error(errs?.join('; ') || `HTTP ${res.status}`);
    const r = j.response || {};
    return `Key OK${r.subscription?.plan ? ` · plan: ${r.subscription.plan}` : ''}${r.requests ? ` · ${r.requests.current}/${r.requests.limit_day} requests used today` : ''}`;
  },
};

// ---------------- Sportmonks (v3) ----------------
const SM = 'https://api.sportmonks.com/v3/football';
async function smGet(path, key, proxy) {
  const url = `${SM}${path}${path.includes('?') ? '&' : '?'}api_token=${encodeURIComponent(key)}`;
  const res = await fetch(proxied(url, proxy));
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Sportmonks: ${j.message || res.status}`);
  return j;
}
const SM_STAT = { 86: 'shotsOnTarget', 42: 'shots', 45: 'possession', 34: 'corners', 56: 'fouls', 84: 'yellow', 83: 'red' };
const SM_XG = 5304;
const smState = (s) => {
  const d = s?.developer_name || s?.state || '';
  if (/INPLAY|^HT$|BREAK|PEN_BREAK|EXTRA_TIME/.test(d)) return 'in';
  if (/^(FT|AET|FT_PEN|AWARDED|CANCELLED|ABANDONED|POSTPONED|WALKOVER|DELETED)$/.test(d)) return 'post';
  return 'pre';
};
export function smParseFixture(f) {
  const ps = f.participants || [];
  const side = (loc) => ps.find((p) => p.meta?.location === loc) || {};
  const cur = (loc) => {
    const s = (f.scores || []).filter((x) => x.score?.participant === loc && x.description === 'CURRENT');
    return s.length ? num(s[0].score.goals) ?? 0 : 0;
  };
  const team = (p, loc) => ({
    id: String(p.id ?? ''), name: p.name || 'Team', short: p.name || 'Team', abbr: p.short_code || (p.name || '???').slice(0, 3).toUpperCase(),
    logo: p.image_path || '', score: cur(loc), redCards: 0, formString: '',
  });
  const state = smState(f.state);
  const ticking = (f.periods || []).find((p) => p.ticking) || (f.periods || []).slice(-1)[0];
  const isHT = /^HT$/.test(f.state?.developer_name || '');
  const minute = state === 'in' ? (isHT ? 45 : num(ticking?.minutes) ?? 0) : 0;
  return {
    id: String(f.id), source: 'sportmonks', league: `sm:${f.league_id ?? f.league?.id}`,
    leagueName: f.league?.name || 'League', seasonId: f.season_id,
    date: f.starting_at_timestamp ? new Date(f.starting_at_timestamp * 1000).toISOString() : f.starting_at,
    state, minute, detail: isHT ? 'HT' : state === 'in' ? `${minute}'` : f.state?.short_name || '',
    venue: '', home: team(side('home'), 'home'), away: team(side('away'), 'away'),
  };
}
export function smParseDetail(match, f, h2hList = [], formH = [], formA = []) {
  const hId = match.home.id, aId = match.away.id;
  const statFor = (id) => {
    const s = {};
    for (const x of f.statistics || []) if (String(x.participant_id) === id && SM_STAT[x.type_id]) s[SM_STAT[x.type_id]] = num(x.data?.value);
    const xg = (f.xgfixture || f.xGFixture || []).find((x) => String(x.participant_id) === id && x.type_id === SM_XG);
    return { ...s, xg: xg ? num(xg.data?.value) : null };
  };
  const events = f.events || [];
  const lineupFor = (id) => {
    const ps = (f.lineups || []).filter((l) => String(l.team_id) === id)
      .map((l) => player(l.player_name, l.jersey_number, '', l.type_id === 11));
    applySubs(ps, events.filter((e) => String(e.participant_id) === id && e.type_id === 18).map((e) => [e.player_name, e.related_player_name]));
    for (const e of events) {
      if (String(e.participant_id) !== id) continue;
      const p = ps.find((x) => x.name === e.player_name);
      if (e.type_id === 14 && p) p.goals++;
      if ((e.type_id === 20 || e.type_id === 21) && p) p.red++;
    }
    return ps;
  };
  const reds = (id) => events.filter((e) => String(e.participant_id) === id && (e.type_id === 20 || e.type_id === 21)).length;
  const toGame = (fx, teamId) => {
    const m = smParseFixture(fx);
    return gameFrom(teamId, m.home.id, m.away.id, m.home.score, m.away.score, m.date,
      m.home.id === String(teamId) ? m.away.name : m.home.name);
  };
  const done = (list) => list.filter((x) => smState(x.state) === 'post' || (x.scores || []).length);
  return {
    form: { home: done(formH).slice(0, 5).map((x) => toGame(x, hId)), away: done(formA).slice(0, 5).map((x) => toGame(x, aId)) },
    h2h: done(h2hList).slice(0, 10).map((x) => toGame(x, hId)),
    liveStats: { home: statFor(hId), away: statFor(aId) },
    lineups: { home: lineupFor(hId), away: lineupFor(aId) },
    table: { home: null, away: null }, leagueAvg: null,
    redCards: { home: reds(hId), away: reds(aId) },
    events: [],
  };
}
const SM_INC = 'participants;scores;state;league;periods';
const sportmonks = {
  async fetchMatches({ key, proxy }) {
    return cached(`sm:list:${today()}`, 25_000, async () => {
      const out = [];
      for (let page = 1; page <= 5; page++) {
        const j = await smGet(`/fixtures/date/${today()}?include=${SM_INC}&per_page=50&page=${page}`, key, proxy);
        out.push(...(j.data || []));
        if (!j.pagination?.has_more) break;
      }
      return out.map(smParseFixture);
    });
  },
  async fetchDetail(m, { key, proxy }) {
    const g = (p) => smGet(p, key, proxy).then((j) => j.data || []).catch(() => []);
    const long = (k, p) => cached(`sm:${k}`, 6 * 3_600_000, () => g(p));
    const latest = (id) => long(`form:${id}`, `/teams/${id}?include=latest.participants;latest.scores;latest.state`).then((t) => t.latest || []);
    const [f, h2h, formH, formA] = await Promise.all([
      smGet(`/fixtures/${m.id}?include=${SM_INC};statistics;lineups;events;xGFixture`, key, proxy).then((j) => j.data || {}),
      long(`h2h:${m.home.id}-${m.away.id}`, `/fixtures/head-to-head/${m.home.id}/${m.away.id}?include=participants;scores;state`),
      latest(m.home.id), latest(m.away.id),
    ]);
    return smParseDetail(m, f, h2h, formH, formA);
  },
  async test({ key, proxy }) {
    const j = await smGet('/leagues?per_page=1', key, proxy);
    return `Key OK${j.subscription?.[0]?.plans?.[0]?.plan ? ` · plan: ${j.subscription[0].plans[0].plan}` : ''}${j.rate_limit ? ` · ${j.rate_limit.remaining} requests left this hour` : ''}`;
  },
};

// ---------------- football-data.org (v4) ----------------
const FD = 'https://api.football-data.org/v4';
async function fdGet(path, key, proxy) {
  const res = await fetch(proxied(FD + path, proxy), { headers: { 'X-Auth-Token': key } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`football-data.org: ${j.message || res.status}`);
  return j;
}
const FD_STATE = (s) => (/IN_PLAY|PAUSED|LIVE/.test(s) ? 'in' : /FINISHED|AWARDED|POSTPONED|SUSPENDED|CANCELLED/.test(s) ? 'post' : 'pre');
export function fdParseMatch(x) {
  const state = FD_STATE(x.status);
  let minute = num(x.minute);
  if (state === 'in' && minute == null) {
    const el = Math.floor((Date.now() - new Date(x.utcDate)) / 60000);
    minute = x.status === 'PAUSED' ? 45 : el > 60 ? Math.min(90, el - 15) : Math.min(45, el);
  }
  const team = (t, g) => ({
    id: String(t?.id ?? ''), name: t?.name || 'Team', short: t?.shortName || t?.name || 'Team',
    abbr: t?.tla || (t?.name || '???').slice(0, 3).toUpperCase(), logo: t?.crest || '', score: num(g) ?? 0, redCards: 0, formString: '',
  });
  return {
    id: String(x.id), source: 'footballdata', league: `fd:${x.competition?.code}`, compCode: x.competition?.code,
    leagueName: x.competition?.name || 'Competition', date: x.utcDate, state, minute: state === 'in' ? minute : 0,
    detail: x.status === 'PAUSED' ? 'HT' : state === 'in' ? `${minute}'` : '', venue: x.venue || '',
    home: team(x.homeTeam, x.score?.fullTime?.home), away: team(x.awayTeam, x.score?.fullTime?.away),
  };
}
export function fdParseDetail(match, { standings, h2h, formH, formA, full }) {
  const hId = match.home.id, aId = match.away.id;
  const table = {};
  const total = (standings?.standings || []).filter((s) => s.type === 'TOTAL').flatMap((s) => s.table || []);
  for (const r of total) table[String(r.team?.id)] = { gp: r.playedGames, gf: r.goalsFor, ga: r.goalsAgainst, rank: r.position };
  const toGame = (x, teamId) => {
    const m = fdParseMatch(x);
    return gameFrom(teamId, m.home.id, m.away.id, m.home.score, m.away.score, m.date, m.home.id === String(teamId) ? m.away.short : m.home.short);
  };
  const recent = (list) => (list?.matches || []).filter((x) => x.status === 'FINISHED').slice(-5).reverse();
  const lineup = (t) => (t?.lineup || []).map((p) => player(p.name, p.shirtNumber, p.position, true))
    .concat((t?.bench || []).map((p) => player(p.name, p.shirtNumber, p.position, false)));
  return {
    form: { home: recent(formH).map((x) => toGame(x, hId)), away: recent(formA).map((x) => toGame(x, aId)) },
    h2h: (h2h?.matches || []).filter((x) => x.status === 'FINISHED').map((x) => toGame(x, hId)).slice(0, 10),
    liveStats: { home: {}, away: {} },
    lineups: { home: lineup(full?.homeTeam), away: lineup(full?.awayTeam) },
    table: { home: table[hId] || null, away: table[aId] || null },
    leagueAvg: leagueAvgFrom(table),
    events: [],
  };
}
const footballData = {
  async fetchMatches({ key, proxy }) {
    const j = await cached(`fd:list:${today()}`, 30_000, () => fdGet('/matches', key, proxy));
    return (j.matches || []).map(fdParseMatch);
  },
  async fetchDetail(m, { key, proxy }) {
    const g = (p) => fdGet(p, key, proxy).catch(() => ({}));
    const long = (k, p) => cached(`fd:${k}`, 6 * 3_600_000, () => g(p));
    const [standings, h2h, formH, formA, full] = await Promise.all([
      long(`st:${m.compCode}`, `/competitions/${m.compCode}/standings`), long(`h2h:${m.id}`, `/matches/${m.id}/head2head?limit=10`),
      long(`form:${m.home.id}`, `/teams/${m.home.id}/matches?status=FINISHED&limit=10`),
      long(`form:${m.away.id}`, `/teams/${m.away.id}/matches?status=FINISHED&limit=10`), g(`/matches/${m.id}`),
    ]);
    return fdParseDetail(m, { standings, h2h, formH, formA, full });
  },
  async test({ key, proxy }) {
    const j = await fdGet('/competitions', key, proxy);
    return `Key OK · ${j.count ?? (j.competitions || []).length} competitions available`;
  },
};

// ---------------- Registry ----------------
export const SOURCES = [
  {
    id: 'espn', name: 'ESPN (public feed)', cost: 'Free', needsKey: false, adapter: { fetchMatches: espnMatches, fetchDetail: espnDetail },
    provides: ['Live scores', 'Lineups & subs', 'Form', 'Head-to-head', 'League tables', 'Shots & possession'],
    lacks: ['Live xG'], note: 'Default. About 25 competitions. Unofficial feed, so it can change without notice.',
  },
  {
    id: 'apifootball', name: 'API-Football (api-sports.io)', cost: 'Free 100 req/day · paid from ~$19/mo', needsKey: true,
    signup: 'https://dashboard.api-football.com/register', adapter: apiFootball,
    provides: ['Live scores (1,000+ leagues)', 'Lineups & subs', 'Form', 'Head-to-head', 'League tables', 'Shots & possession', 'xG (some leagues)'],
    note: 'Each match analysis uses ~7 requests, so the free 100/day only covers light use; set auto-refresh to 1 minute or off.',
  },
  {
    id: 'sportmonks', name: 'Sportmonks', cost: 'From ~€29/mo · live xG add-on ~€199/mo', needsKey: true,
    signup: 'https://my.sportmonks.com/register', adapter: sportmonks,
    provides: ['Live scores', 'Lineups & subs', 'Form', 'Head-to-head', 'Shots & possession', 'Live xG (with xG add-on)'],
    lacks: ['League tables (not used yet)'], note: 'Best option for live expected goals. May need the CORS proxy in Settings.',
  },
  {
    id: 'footballdata', name: 'football-data.org', cost: 'Free tier (delayed) · live from ~€12/mo', needsKey: true,
    signup: 'https://www.football-data.org/client/register', adapter: footballData,
    provides: ['Scores (12 competitions free)', 'Form', 'Head-to-head', 'League tables', 'Lineups (paid tiers)'],
    lacks: ['Shot stats', 'xG'], note: 'Free tier scores are delayed and limited to 10 requests/minute.',
  },
];
export const sourceById = (id) => SOURCES.find((s) => s.id === id) || SOURCES[0];
