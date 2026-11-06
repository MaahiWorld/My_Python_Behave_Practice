// Data layer: ESPN's public soccer endpoints (no API key needed).
// Every parser is defensive — missing fields degrade the analysis rather than break it.

export const LEAGUES = [
  ['eng.1', 'Premier League'], ['esp.1', 'LaLiga'], ['ita.1', 'Serie A'],
  ['ger.1', 'Bundesliga'], ['fra.1', 'Ligue 1'], ['uefa.champions', 'Champions League'],
  ['uefa.europa', 'Europa League'], ['uefa.europa.conf', 'Conference League'],
  ['eng.2', 'Championship'], ['ned.1', 'Eredivisie'], ['por.1', 'Primeira Liga'],
  ['sco.1', 'Scottish Premiership'], ['tur.1', 'Süper Lig'], ['bel.1', 'Belgian Pro League'],
  ['usa.1', 'MLS'], ['mex.1', 'Liga MX'], ['bra.1', 'Brasileirão'], ['arg.1', 'Liga Profesional'],
  ['sau.1', 'Saudi Pro League'], ['eng.fa', 'FA Cup'], ['esp.copa_del_rey', 'Copa del Rey'],
  ['conmebol.libertadores', 'Copa Libertadores'], ['fifa.world', 'World Cup'],
  ['uefa.euro', 'Euro'], ['fifa.friendly', 'Friendlies'],
];
const LEAGUE_NAME = Object.fromEntries(LEAGUES);
const BASE = 'https://site.api.espn.com/apis';

export const num = (v) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
};
const yes = (v) => v === true || (v && typeof v === 'object' && v.didSub === true);

export function proxied(url, proxy) {
  if (!proxy) return url;
  return proxy.includes('{url}') ? proxy.replace('{url}', encodeURIComponent(url)) : proxy + url;
}

async function getJSON(url, proxy) {
  const res = await fetch(proxied(url, proxy), { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export function parseMinute(status) {
  if (!status) return 0;
  const name = status.type?.name || '';
  if (name.includes('HALFTIME')) return 45;
  const txt = String(status.displayClock || status.type?.shortDetail || '');
  const m = txt.match(/(\d+)'?\s*(?:\+\s*(\d+))?/);
  if (m) return parseInt(m[1], 10) + (m[2] ? parseInt(m[2], 10) : 0);
  if (Number.isFinite(status.clock)) return Math.floor(status.clock / 60);
  return 0;
}

function parseTeam(c, details) {
  const t = c.team || {};
  const reds = (details || []).filter((d) => d.redCard && String(d.team?.id) === String(t.id)).length;
  return {
    id: String(t.id ?? c.id ?? ''),
    name: t.displayName || t.name || 'Team',
    short: t.shortDisplayName || t.displayName || t.name || 'Team',
    abbr: t.abbreviation || (t.displayName || '???').slice(0, 3).toUpperCase(),
    logo: t.logo || t.logos?.[0]?.href || '',
    score: num(c.score?.value ?? c.score) ?? 0,
    formString: typeof c.form === 'string' ? c.form : '',
    redCards: reds,
  };
}

export function parseScoreboard(json, league) {
  return (json?.events || []).flatMap((e) => {
    const comp = e.competitions?.[0];
    const cs = comp?.competitors || [];
    const h = cs.find((c) => c.homeAway === 'home') || cs[0];
    const a = cs.find((c) => c.homeAway === 'away') || cs[1];
    if (!h || !a) return [];
    const st = e.status || comp.status || {};
    const state = st.type?.state || 'pre';
    return [{
      id: String(e.id),
      league, source: 'espn',
      leagueName: LEAGUE_NAME[league] || json?.leagues?.[0]?.name || league,
      date: e.date,
      state,
      minute: state === 'in' ? parseMinute(st) : 0,
      detail: st.type?.shortDetail || st.type?.detail || '',
      venue: comp.venue?.fullName || '',
      home: parseTeam(h, comp.details),
      away: parseTeam(a, comp.details),
    }];
  });
}

function parseGame(ev, teamId) {
  const hs = num(ev.homeTeamScore);
  const as = num(ev.awayTeamScore);
  const homeId = String(ev.homeTeamId ?? '');
  const awayId = String(ev.awayTeamId ?? '');
  const isHome = homeId === String(teamId);
  let gf = isHome ? hs : as;
  let ga = isHome ? as : hs;
  if ((gf == null || ga == null) && typeof ev.score === 'string') {
    const m = ev.score.match(/(\d+)\s*-\s*(\d+)/);
    if (m) { gf = +m[1]; ga = +m[2]; }
  }
  let res = ev.gameResult;
  if (!res && gf != null && ga != null) res = gf > ga ? 'W' : gf < ga ? 'L' : 'D';
  return {
    gf: gf ?? 0, ga: ga ?? 0, res: res || '-',
    hs, as, homeId, awayId,
    opp: ev.opponent?.displayName || ev.opponent?.abbreviation || '',
    home: isHome,
    date: ev.gameDate || ev.date || '',
    league: ev.leagueName || ev.competitionName || '',
  };
}

function statMap(list) {
  const out = {};
  for (const s of list || []) {
    const key = s.name || s.abbreviation;
    if (key) out[key] = num(s.value ?? s.displayValue);
  }
  return out;
}

function parseLiveStats(teamBox) {
  const s = statMap(teamBox?.statistics);
  return {
    possession: s.possessionPct,
    shots: s.totalShots,
    shotsOnTarget: s.shotsOnTarget,
    corners: s.wonCorners,
    fouls: s.foulsCommitted,
    yellow: s.yellowCards,
    red: s.redCards,
  };
}

function parseRoster(r) {
  return (r?.roster || []).map((p) => {
    const st = statMap(p.stats);
    const starter = !!p.starter;
    const subIn = yes(p.subbedIn);
    const subOut = yes(p.subbedOut);
    return {
      name: p.athlete?.displayName || p.athlete?.shortName || 'Player',
      jersey: p.jersey || p.athlete?.jersey || '',
      pos: p.position?.abbreviation || p.position?.name || '',
      starter, subIn, subOut,
      onPitch: (starter || subIn) && !subOut,
      goals: st.totalGoals || 0,
      assists: st.goalAssists || 0,
      yellow: st.yellowCards || 0,
      red: st.redCards || 0,
    };
  });
}

// Find standings entries anywhere in a payload (shape differs between endpoints).
export function parseStandings(json) {
  const rows = {};
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.entries)) {
      for (const e of node.entries) {
        const id = String(e.team?.id ?? e.id ?? '');
        const s = statMap(e.stats);
        const gp = s.gamesPlayed;
        if (id && gp != null) {
          rows[id] = { gp, gf: s.pointsFor ?? 0, ga: s.pointsAgainst ?? 0, rank: s.rank ?? null, pts: s.points ?? null };
        }
      }
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v);
  };
  walk(json);
  return rows;
}

export function leagueAverage(rows) {
  let gp = 0, gf = 0;
  for (const r of Object.values(rows)) { gp += r.gp; gf += r.gf; }
  return gp >= 20 ? gf / gp : null;
}

export function parseSummary(json, match, standings = {}) {
  const hId = match.home.id;
  const aId = match.away.id;
  const forms = json?.boxscore?.form || [];
  const formFor = (id) => {
    const f = forms.find((x) => String(x.team?.id) === String(id));
    return (f?.events || []).slice(0, 5).map((ev) => parseGame(ev, id));
  };
  const h2hRaw = (json?.headToHeadGames || []).flatMap((g) => g.events || []);
  const seen = new Set();
  const h2h = h2hRaw
    .filter((ev) => { const k = ev.id || ev.gameDate; if (seen.has(k)) return false; seen.add(k); return true; })
    .map((ev) => parseGame(ev, hId))
    .filter((g) => g.hs != null && g.as != null)
    .slice(0, 10);
  const box = json?.boxscore?.teams || [];
  const boxFor = (id) => box.find((b) => String(b.team?.id) === String(id));
  const rosters = json?.rosters || [];
  const rosterFor = (id, side) =>
    rosters.find((r) => String(r.team?.id) === String(id)) || rosters.find((r) => r.homeAway === side);

  const table = { ...standings, ...parseStandings(json?.standings) };
  return {
    form: { home: formFor(hId), away: formFor(aId) },
    h2h,
    liveStats: { home: parseLiveStats(boxFor(hId)), away: parseLiveStats(boxFor(aId)) },
    lineups: { home: parseRoster(rosterFor(hId, 'home')), away: parseRoster(rosterFor(aId, 'away')) },
    table: { home: table[hId] || null, away: table[aId] || null },
    leagueAvg: leagueAverage(table),
    events: (json?.keyEvents || []).map((k) => ({
      minute: k.clock?.displayValue || '',
      text: k.text || k.type?.text || '',
      type: k.type?.type || k.type?.text || '',
      teamId: String(k.team?.id ?? ''),
    })),
  };
}

// ---- Fetching with a tiny cache ----
const cache = new Map();
export async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

export async function fetchMatches({ proxy, leagues = LEAGUES.map((l) => l[0]), date } = {}) {
  const q = date ? `?dates=${date}` : '';
  const results = await Promise.allSettled(
    leagues.map((lg) =>
      cached(`sb:${lg}:${date || ''}`, 25_000, () =>
        getJSON(`${BASE}/site/v2/sports/soccer/${lg}/scoreboard${q}`, proxy).then((j) => parseScoreboard(j, lg))
      )
    )
  );
  const ok = results.filter((r) => r.status === 'fulfilled');
  if (!ok.length) throw new Error(results[0]?.reason?.message || 'Network error');
  return ok.flatMap((r) => r.value);
}

export async function fetchDetail(match, { proxy } = {}) {
  const standings = await cached(`st:${match.league}`, 3_600_000, () =>
    getJSON(`${BASE}/v2/sports/soccer/${match.league}/standings`, proxy).then(parseStandings).catch(() => ({}))
  );
  const summary = await getJSON(
    `${BASE}/site/v2/sports/soccer/${match.league}/summary?event=${match.id}`,
    proxy
  );
  return parseSummary(summary, match, standings);
}
