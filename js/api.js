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
export const BASE = 'https://site.api.espn.com/apis';

export const num = (v) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
};
const yes = (v) => v === true || (v && typeof v === 'object' && v.didSub === true);

export function proxied(url, proxy) {
  if (!proxy) return url;
  return proxy.includes('{url}') ? proxy.replace('{url}', encodeURIComponent(url)) : proxy + url;
}

// ESPN refuses bursts of requests, so at most MAX_IN_FLIGHT run at once and refused or failed
// requests are retried after a pause. (A refusal often reaches the browser as "Failed to fetch".)
const MAX_IN_FLIGHT = 4;
let inFlight = 0;
const waiting = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function slot(fn) {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise((r) => waiting.push(r));
  inFlight++;
  try { return await fn(); } finally { inFlight--; waiting.shift()?.(); }
}
export async function getJSON(url, proxy, { retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await slot(async () => {
        const res = await fetch(proxied(url, proxy), { cache: 'no-store' });
        if (!res.ok) throw Object.assign(new Error(`${res.status} ${res.statusText || 'error'}`), { status: res.status });
        return res.json();
      });
    } catch (e) {
      const retryable = !e.status || e.status === 429 || e.status >= 500; // network error, rate limit, server error
      if (!retryable || attempt >= retries) throw e;
      await sleep(1500 * 2 ** attempt + Math.random() * 500);
    }
  }
}

// Which part of the match is being played: H1, HT, H2, BREAK_ET, ET or PEN.
export function parsePhase(status) {
  const name = status?.type?.name || '';
  const period = status?.period || 0;
  if (/SHOOTOUT|PENALT/.test(name) || period >= 5) return 'PEN';
  if (/HALFTIME/.test(name) && period >= 3) return 'ET';
  if (/HALFTIME/.test(name)) return 'HT';
  if (/END_OF_REGULATION|END_REGULATION/.test(name)) return 'BREAK_ET';
  if (/END_OF_EXTRATIME|END_EXTRATIME/.test(name)) return 'PEN';
  if (period === 3 || period === 4 || /OVERTIME|EXTRA/.test(name)) return 'ET';
  if (period === 1) return 'H1';
  if (period === 2) return 'H2';
  return null;
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
    const ht = halfTime(h, a);
    return [{
      id: String(e.id),
      league, source: 'espn',
      leagueName: LEAGUE_NAME[league] || json?.leagues?.[0]?.name || league,
      date: e.date,
      state,
      minute: state === 'in' ? parseMinute(st) : 0,
      phase: state === 'in' ? parsePhase(st) : null,
      detail: st.type?.shortDetail || st.type?.detail || '',
      venue: comp.venue?.fullName || '',
      home: parseTeam(h, comp.details),
      away: parseTeam(a, comp.details),
      ...(ht && (state === 'post' || (state === 'in' && (st.period || 0) >= 2)) ? { ht } : {}),
      ...(state === 'post' && wentToExtraTime(st) ? { extraTime: true } : {}),
    }];
  });
}

// Half-time score from each side's per-period line scores (first entry = first half).
export function halfTime(h, a) {
  const first = (c) => num(c?.linescores?.[0]?.value ?? c?.linescores?.[0]?.displayValue);
  const hh = first(h), aa = first(a);
  return hh == null || aa == null ? null : { home: hh, away: aa };
}
// Finished after extra time or penalties (1X2 is settled on the 90-minute score, which was level).
export const wentToExtraTime = (st) => /AET|PEN|EXTRA|SHOOTOUT/i.test(`${st?.type?.name || ''} ${st?.type?.shortDetail || ''}`) || (st?.period || 0) > 2;

// Final result of one ESPN football match from its summary (Results page re-checks).
export function parseResult(json) {
  const comp = json?.header?.competitions?.[0];
  const cs = comp?.competitors || [];
  const h = cs.find((c) => c.homeAway === 'home') || cs[0];
  const a = cs.find((c) => c.homeAway === 'away') || cs[1];
  const st = comp?.status || json?.header?.status || {};
  const state = st.type?.state || (st.type?.completed ? 'post' : 'pre');
  if (!h || !a) return null;
  const hs = num(h.score?.value ?? h.score), as = num(a.score?.value ?? a.score);
  if (hs == null || as == null) return { state };
  return { state, hs, as, ht: halfTime(h, a), aet: state === 'post' && wentToExtraTime(st), detail: st.type?.shortDetail || '' };
}

export async function fetchResult(league, id, { proxy } = {}) {
  return parseResult(await getJSON(`${BASE}/site/v2/sports/soccer/${league}/summary?event=${id}`, proxy, { retries: 1 }));
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
  // ESPN has carried recent form under different names.
  const forms = [json?.boxscore?.form, json?.lastFiveGames, json?.form].find((x) => Array.isArray(x) && x.length) || [];
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

// Tiered scanning: every competition every 10 minutes, and every 30 seconds only those
// with a live match or one kicking off soon.
const FULL_SCAN_MS = 600_000;
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
      if (r.reason?.status === 400 || r.reason?.status === 404) { bad[lg] = now; byLeague.delete(lg); } // unknown competition only
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

// ---- Upcoming fixtures in the best-known competitions ----
export const FAMOUS = [
  'eng.1', 'esp.1', 'ita.1', 'ger.1', 'fra.1', 'uefa.champions', 'uefa.europa', 'uefa.europa.conf',
  'ned.1', 'por.1', 'eng.2', 'sco.1', 'tur.1', 'bel.1', 'ksa.1', 'usa.1', 'mex.1', 'bra.1', 'arg.1',
  'eng.fa', 'eng.league_cup', 'esp.copa_del_rey', 'ger.dfb_pokal', 'ita.coppa_italia', 'fra.coupe_de_france',
  'conmebol.libertadores', 'uefa.nations', 'fifa.worldq.uefa', 'fifa.world', 'uefa.euro',
];
export const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

// Fixtures not yet started in the next `days` days. One request per competition for the whole
// date range; if ESPN rejects the range, falls back to one request per day.
export async function fetchUpcoming({ proxy, days = 7 } = {}) {
  const from = new Date(), to = new Date(Date.now() + days * 86_400_000);
  const one = async (lg) => {
    const url = (q) => `${BASE}/site/v2/sports/soccer/${lg}/scoreboard?dates=${q}`;
    try {
      return parseScoreboard(await getJSON(url(`${ymd(from)}-${ymd(to)}`), proxy), lg);
    } catch (e) {
      if (!(e.status >= 400 && e.status < 500)) throw e;
      const out = [];
      for (let i = 0; i <= days; i++) {
        try { out.push(...parseScoreboard(await getJSON(url(ymd(new Date(Date.now() + i * 86_400_000))), proxy), lg)); } catch { /* skip day */ }
      }
      return out;
    }
  };
  const leagues = FAMOUS.filter((s) => !bad[s]);
  const results = await Promise.allSettled(leagues.map((lg) => cached(`up:${lg}:${ymd(from)}`, 30 * 60_000, () => one(lg))));
  const seen = new Set();
  return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    .filter((m) => m.state === 'pre' && new Date(m.date) - Date.now() < days * 86_400_000)
    .filter((m) => (seen.has(m.league + m.id) ? false : seen.add(m.league + m.id)))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

// League standings, cached for an hour. A failed or empty fetch is only remembered for 5 minutes,
// so one refused request (ESPN rejects bursts) doesn't leave every match in that league without a table.
const standingsCache = new Map();
export async function leagueStandings(league, proxy) {
  const hit = standingsCache.get(league);
  if (hit && Date.now() - hit.t < (Object.keys(hit.v).length ? 3_600_000 : 300_000)) return hit.v;
  let v = {};
  try { v = parseStandings(await getJSON(`${BASE}/v2/sports/soccer/${league}/standings`, proxy, { retries: 3 })); } catch { /* none */ }
  standingsCache.set(league, { t: Date.now(), v });
  return v;
}

// Domestic league competitions look like "eng.1", "bra.2".
const isDomestic = (slug) => /^[a-z]{3}\.\d$/.test(slug);
const NON_COUNTRY = new Set(['uefa', 'fifa', 'conmebol', 'concacaf', 'afc', 'caf', 'ofc', 'club']);
// Leagues a team may have a season record in, besides the match's own competition:
// leagues where it appears in the current scan, then the country's divisions for a domestic cup.
export function homeLeagueCandidates(teamId, league, scanned = byLeague) {
  const out = [];
  for (const [lg, ms] of scanned) {
    if (lg !== league && isDomestic(lg) && ms.some((m) => m.home.id === String(teamId) || m.away.id === String(teamId))) out.push(lg);
  }
  const country = league.split('.')[0];
  if (!NON_COUNTRY.has(country)) {
    for (const [lg] of LEAGUES) if (lg !== league && lg.startsWith(`${country}.`) && isDomestic(lg) && !out.includes(lg) && !bad[lg]) out.push(lg);
  }
  return out.slice(0, 5);
}

// Season record from the team's domestic league, for cup and continental games or when the
// competition's own table is short (league phase after 4 games, early rounds).
async function domesticRecord(teamId, league, proxy) {
  for (const lg of homeLeagueCandidates(teamId, league)) {
    const row = (await leagueStandings(lg, proxy))[String(teamId)];
    if (row?.gp >= 5) return { row: { ...row, league: lg }, league: lg };
  }
  return null;
}

export async function fetchDetail(match, { proxy } = {}) {
  const standings = await leagueStandings(match.league, proxy);
  const summary = await getJSON(
    `${BASE}/site/v2/sports/soccer/${match.league}/summary?event=${match.id}`,
    proxy
  );
  const detail = parseSummary(summary, match, standings);
  const formLeague = { home: match.league, away: match.league };
  // No usable season record in this competition for either team (cup tie, continental league phase,
  // early rounds): use both teams' domestic league tables instead, so the two records are comparable.
  if (!(detail.table.home?.gp >= 5 && detail.table.away?.gp >= 5)) {
    const dom = await Promise.all(['home', 'away'].map((side) => domesticRecord(match[side].id, match.league, proxy).catch(() => null)));
    ['home', 'away'].forEach((side, i) => {
      if (dom[i]) { detail.table[side] = dom[i].row; formLeague[side] = dom[i].league; }
    });
    if (dom[0] && dom[1] && dom[0].league === dom[1].league) detail.leagueAvg = leagueAverage(await leagueStandings(dom[0].league, proxy));
  }
  for (const side of ['home', 'away']) {
    const id = match[side].id;
    // Recent form missing from the match data: build it from each team's own fixture list,
    // in this competition and, if that's too short, in its domestic league.
    if (detail.form[side].length >= 4) continue;
    for (const lg of [...new Set([match.league, formLeague[side], ...homeLeagueCandidates(id, match.league).slice(0, 2)])]) {
      try {
        const games = await teamForm(lg, id, match.date, proxy);
        if (games.length > detail.form[side].length) detail.form[side] = games;
      } catch { /* keep what we have */ }
      if (detail.form[side].length >= 4) break;
    }
  }
  return detail;
}

// A team's last 5 completed matches before `before`, from ESPN's team schedule (newest first).
export function parseSchedule(json, teamId, before) {
  const cutoff = before ? new Date(before).getTime() : Date.now();
  const games = [];
  for (const e of json?.events || []) {
    const c = e.competitions?.[0];
    const done = c?.status?.type?.completed ?? e.status?.type?.completed ?? (c?.status?.type?.state || e.status?.type?.state) === 'post';
    if (!done || new Date(e.date).getTime() >= cutoff) continue;
    const cs = c?.competitors || [];
    const me = cs.find((x) => String(x.id ?? x.team?.id) === String(teamId));
    const opp = cs.find((x) => x !== me);
    const score = (x) => num(x?.score?.value ?? x?.score?.displayValue ?? x?.score);
    const gf = score(me), ga = score(opp);
    if (!me || !opp || gf == null || ga == null) continue;
    const homeIsMe = me.homeAway === 'home';
    games.push({
      gf, ga, res: gf > ga ? 'W' : gf < ga ? 'L' : 'D', home: homeIsMe, date: e.date,
      opp: opp.team?.shortDisplayName || opp.team?.displayName || '',
      hs: homeIsMe ? gf : ga, as: homeIsMe ? ga : gf,
      homeId: String(homeIsMe ? teamId : opp.id ?? opp.team?.id), awayId: String(homeIsMe ? opp.id ?? opp.team?.id : teamId),
    });
  }
  return games.sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5);
}
function teamForm(league, teamId, before, proxy) {
  return cached(`sched:${league}:${teamId}`, 6 * 3_600_000, () =>
    getJSON(`${BASE}/site/v2/sports/soccer/${league}/teams/${teamId}/schedule`, proxy)
  ).then((j) => parseSchedule(j, teamId, before));
}
