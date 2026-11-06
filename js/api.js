// Data layer: ESPN's public soccer endpoints (no API key needed).
// Every parser is defensive — missing fields degrade the analysis rather than break it.

// Competitions scanned on ESPN. Names come from the feed when not given here.
// Slugs ESPN doesn't recognise are skipped automatically (remembered for 24 hours).
const NAMED = [
  ['eng.1', 'Premier League'], ['esp.1', 'LaLiga'], ['ita.1', 'Serie A'], ['ger.1', 'Bundesliga'], ['fra.1', 'Ligue 1'],
  ['uefa.champions', 'Champions League'], ['uefa.europa', 'Europa League'], ['uefa.europa.conf', 'Conference League'],
  ['eng.2', 'Championship'], ['ned.1', 'Eredivisie'], ['por.1', 'Primeira Liga'], ['sco.1', 'Scottish Premiership'],
  ['tur.1', 'Süper Lig'], ['bel.1', 'Belgian Pro League'], ['usa.1', 'MLS'], ['mex.1', 'Liga MX'], ['bra.1', 'Brasileirão'],
  ['arg.1', 'Liga Profesional'], ['ksa.1', 'Saudi Pro League'], ['eng.fa', 'FA Cup'], ['esp.copa_del_rey', 'Copa del Rey'],
  ['conmebol.libertadores', 'Copa Libertadores'], ['fifa.world', 'World Cup'], ['uefa.euro', 'Euro'], ['fifa.friendly', 'International Friendlies'],
];
const MORE = [
  // Europe
  'eng.3', 'eng.4', 'eng.5', 'eng.league_cup', 'eng.trophy', 'eng.w.1', 'sco.2', 'sco.3', 'sco.4', 'sco.tennents', 'sco.cis',
  'wal.1', 'nir.1', 'irl.1', 'irl.2', 'esp.2', 'esp.w.1', 'ger.2', 'ger.3', 'ger.dfb_pokal', 'ita.2', 'ita.coppa_italia',
  'fra.2', 'fra.coupe_de_france', 'ned.2', 'ned.cup', 'por.2', 'gre.1', 'aut.1', 'sui.1', 'den.1', 'nor.1', 'swe.1', 'fin.1',
  'isl.1', 'rus.1', 'ukr.1', 'pol.1', 'cze.1', 'svk.1', 'hun.1', 'rou.1', 'bul.1', 'srb.1', 'cro.1', 'svn.1', 'bih.1',
  'cyp.1', 'isr.1', 'kaz.1', 'aze.1', 'geo.1', 'arm.1', 'alb.1', 'mkd.1', 'mne.1', 'lux.1', 'mlt.1', 'est.1', 'lva.1', 'ltu.1', 'blr.1', 'mda.1',
  'uefa.super_cup', 'uefa.nations', 'uefa.euroq', 'uefa.champions_qual', 'uefa.europa_qual', 'uefa.europa.conf_qual', 'uefa.wchampions', 'uefa.youth_league',
  // Americas
  'usa.open', 'usa.usl.1', 'usa.usl.l1', 'usa.nwsl', 'can.1', 'mex.2', 'bra.2', 'bra.3', 'bra.copa_do_brazil', 'arg.2', 'arg.copa',
  'chi.1', 'col.1', 'col.2', 'per.1', 'uru.1', 'par.1', 'ecu.1', 'bol.1', 'ven.1', 'crc.1', 'hon.1', 'gua.1', 'slv.1', 'pan.1', 'jam.1',
  'conmebol.sudamericana', 'conmebol.recopa', 'conmebol.america', 'concacaf.champions', 'concacaf.gold', 'concacaf.nations.league',
  'concacaf.leagues.cup', 'concacaf.central_american_cup',
  // Asia & Oceania
  'jpn.1', 'jpn.2', 'chn.1', 'kor.1', 'aus.1', 'aus.w.1', 'ind.1', 'uae.1', 'qat.1', 'irn.1', 'irq.1', 'jor.1', 'kuw.1', 'bhr.1', 'oma.1',
  'tha.1', 'idn.1', 'mys.1', 'sgp.1', 'vie.1', 'phi.1', 'uzb.1', 'afc.champions', 'afc.cup', 'afc.asian.cup', 'sau.1',
  // Africa
  'rsa.1', 'egy.1', 'mar.1', 'tun.1', 'alg.1', 'nga.1', 'gha.1', 'ken.1', 'uga.1', 'tan.1', 'zam.1', 'zim.1',
  'caf.champions', 'caf.confed', 'caf.nations', 'caf.nations_qual',
  // World
  'fifa.cwc', 'fifa.wwc', 'fifa.worldq.uefa', 'fifa.worldq.conmebol', 'fifa.worldq.concacaf', 'fifa.worldq.afc', 'fifa.worldq.caf',
  'fifa.worldq.ofc', 'fifa.intercontinental_cup', 'fifa.olympics', 'fifa.u20.world', 'fifa.u17.world', 'club.friendly',
];
export const LEAGUES = [...NAMED, ...MORE.map((s) => [s, null])];
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
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${res.statusText}`), { status: res.status });
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

// Tiered scanning: every competition every 3 minutes, and every 30 seconds only those
// with a live match or one kicking off soon.
const FULL_SCAN_MS = 180_000;
const BAD_KEY = 'gs:espn-bad';
const byLeague = new Map();
let lastFull = 0;
let bad = {};
try { bad = JSON.parse(localStorage.getItem(BAD_KEY) || '{}'); } catch { /* no storage */ }
for (const [k, t] of Object.entries(bad)) if (Date.now() - t > 86_400_000) delete bad[k];

export const scanStats = { leagues: 0, active: 0, skipped: 0, lastFull: 0 };

export async function fetchMatches({ proxy, force = false } = {}) {
  const now = Date.now();
  const full = force || !byLeague.size || now - lastFull > FULL_SCAN_MS;
  const slugs = LEAGUES.map((l) => l[0]).filter((s) => !bad[s]);
  const busy = (s) => (byLeague.get(s) || []).some((m) => m.state === 'in' || (m.state === 'pre' && new Date(m.date) - now < 20 * 60_000));
  const targets = full ? slugs : slugs.filter(busy);
  const results = await Promise.allSettled(
    targets.map((lg) => getJSON(`${BASE}/site/v2/sports/soccer/${lg}/scoreboard`, proxy).then((j) => parseScoreboard(j, lg)))
  );
  let ok = 0, lastErr = null;
  results.forEach((r, i) => {
    const lg = targets[i];
    if (r.status === 'fulfilled') { byLeague.set(lg, r.value); ok++; }
    else {
      lastErr = r.reason;
      if (r.reason?.status >= 400 && r.reason.status < 500) { bad[lg] = now; byLeague.delete(lg); }
    }
  });
  try { localStorage.setItem(BAD_KEY, JSON.stringify(bad)); } catch { /* ignore */ }
  if (targets.length && !ok && !byLeague.size) throw new Error(lastErr?.message || 'Network error');
  if (full && ok) lastFull = now;
  const all = [...byLeague.values()].flat();
  Object.assign(scanStats, {
    leagues: slugs.length,
    active: new Set(all.map((m) => m.league)).size, skipped: Object.keys(bad).length, lastFull,
  });
  return all;
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
