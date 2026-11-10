// Bookmaker odds from The Odds API (the-odds-api.com). Keyed source: the key is entered on the Data
// sources page and stored only in this browser.
//
// What it adds:
//  - the bookmakers' consensus chance for each side (each bookmaker's prices with its margin removed,
//    then averaged), shown next to the model's chance;
//  - the best decimal price on offer, and the edge: model chance × best price − 1;
//  - every pick records the best price when it was made, so the Results page can show profit per
//    stake, not just the hit rate.
// Odds do not change which picks are made: the pick rules were backtested without odds (there is no
// free odds history), so until enough priced picks have settled, odds are information only.
//
// Free tier: 500 credits a month. Each league request costs 1 credit per market per region, and only
// the EU region is used: football h2h + totals = 2 credits, tennis h2h = 1. Lists are cached for
// 2 hours and only requested for leagues with a match in the next 2 days.
import { proxied, num } from './api.js';
import { sameTeam } from './merge.js';

export const ODDS_API = 'https://api.the-odds-api.com/v4';
const REGION = 'eu';

// ESPN league id → The Odds API sport key.
export const ODDS_SPORT = {
  'eng.1': 'soccer_epl', 'eng.2': 'soccer_efl_champ', 'eng.fa': 'soccer_fa_cup', 'eng.league_cup': 'soccer_england_efl_cup',
  'ger.1': 'soccer_germany_bundesliga', 'ger.2': 'soccer_germany_bundesliga2', 'esp.1': 'soccer_spain_la_liga', 'esp.2': 'soccer_spain_segunda_division',
  'ita.1': 'soccer_italy_serie_a', 'ita.2': 'soccer_italy_serie_b', 'fra.1': 'soccer_france_ligue_one', 'fra.2': 'soccer_france_ligue_two',
  'ned.1': 'soccer_netherlands_eredivisie', 'por.1': 'soccer_portugal_primeira_liga', 'sco.1': 'soccer_spl', 'tur.1': 'soccer_turkey_super_league',
  'bel.1': 'soccer_belgium_first_div', 'aut.1': 'soccer_austria_bundesliga', 'sui.1': 'soccer_switzerland_superleague', 'den.1': 'soccer_denmark_superliga',
  'nor.1': 'soccer_norway_eliteserien', 'swe.1': 'soccer_sweden_allsvenskan', 'gre.1': 'soccer_greece_super_league', 'pol.1': 'soccer_poland_ekstraklasa',
  'uefa.champions': 'soccer_uefa_champs_league', 'uefa.europa': 'soccer_uefa_europa_league', 'uefa.europa.conf': 'soccer_uefa_europa_conference_league',
  'usa.1': 'soccer_usa_mls', 'mex.1': 'soccer_mexico_ligamx', 'bra.1': 'soccer_brazil_campeonato', 'arg.1': 'soccer_argentina_primera_division',
  'ksa.1': 'soccer_saudi_arabia_pro_league', 'jpn.1': 'soccer_japan_j_league', 'aus.1': 'soccer_australia_aleague', 'chn.1': 'soccer_china_superleague',
};

// ---- Quota (from response headers) ----
const QUOTA_KEY = 'gs:odds-quota';
export const oddsQuota = (() => {
  try { return JSON.parse(localStorage.getItem(QUOTA_KEY) || 'null') || { remaining: null, used: null }; } catch { return { remaining: null, used: null }; }
})();
const RESERVE = 10; // never spend the last few credits
function noteQuota(res) {
  const rem = num(res.headers.get('x-requests-remaining')), used = num(res.headers.get('x-requests-used'));
  if (rem != null) oddsQuota.remaining = rem;
  if (used != null) oddsQuota.used = used;
  oddsQuota.at = Date.now();
  try { localStorage.setItem(QUOTA_KEY, JSON.stringify(oddsQuota)); } catch { /* ignore */ }
}
async function oddsGet(path, key, proxy, { free = false } = {}) {
  if (!free && oddsQuota.remaining != null && oddsQuota.remaining <= RESERVE) throw new Error('The Odds API monthly credits used up');
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(proxied(`${ODDS_API}${path}${sep}apiKey=${encodeURIComponent(key)}`, proxy));
  noteQuota(res);
  if (res.status === 401) throw new Error('The Odds API: key not valid');
  if (res.status === 429) throw new Error('The Odds API: request limit reached');
  if (!res.ok) throw new Error(`The Odds API ${res.status}`);
  return res.json();
}

// ---- Parsing ----
// One bookmaker's prices for a set of outcomes → chances with its margin removed (proportional).
function fair(prices) {
  const inv = prices.map((p) => (p > 1 ? 1 / p : 0));
  const s = inv.reduce((a, b) => a + b, 0);
  return s > 0 ? inv.map((x) => x / s) : null;
}
// Aggregates many bookmakers: consensus fair chance (mean) and best price per outcome.
function combine(books) {
  // books: [{ book, prices: { side: price } }] all with the same sides
  if (!books.length) return null;
  const sides = Object.keys(books[0].prices);
  const out = {};
  for (const sd of sides) out[sd] = { fair: 0, best: 0, bestBook: '', n: 0 };
  for (const b of books) {
    const f = fair(sides.map((sd) => b.prices[sd]));
    if (!f) continue;
    sides.forEach((sd, i) => {
      out[sd].fair += f[i]; out[sd].n++;
      if (b.prices[sd] > out[sd].best) { out[sd].best = b.prices[sd]; out[sd].bestBook = b.book; }
    });
  }
  for (const sd of sides) {
    if (!out[sd].n) return null;
    out[sd].fair /= out[sd].n;
    out[sd].best = Math.round(out[sd].best * 100) / 100;
  }
  return { ...out, books: books.length };
}

// The Odds API /odds response → [{ id, date, home, away, h2h, totals: { [line]: { over, under } } }].
// Football h2h sides are home / draw / away; tennis h2h sides are a / b (in the API's listed order).
export function parseOdds(json, sport = 'football') {
  const out = [];
  for (const e of Array.isArray(json) ? json : []) {
    const home = e.home_team, away = e.away_team;
    const players = sport === 'tennis' ? [home, away] : null;
    const h2h = [], totals = new Map();
    for (const bk of e.bookmakers || []) {
      for (const mk of bk.markets || []) {
        const oc = mk.outcomes || [];
        if (mk.key === 'h2h') {
          const price = (name) => oc.find((o) => o.name === name)?.price;
          if (sport === 'tennis') {
            const pa = price(players[0]), pb = price(players[1]);
            if (pa && pb) h2h.push({ book: bk.title, prices: { a: pa, b: pb } });
          } else {
            const ph = price(home), pa = price(away), pd = price('Draw');
            if (ph && pa && pd) h2h.push({ book: bk.title, prices: { home: ph, draw: pd, away: pa } });
          }
        } else if (mk.key === 'totals') {
          const lines = new Set(oc.map((o) => o.point));
          for (const line of lines) {
            const over = oc.find((o) => o.point === line && /^over$/i.test(o.name))?.price;
            const under = oc.find((o) => o.point === line && /^under$/i.test(o.name))?.price;
            if (!over || !under) continue;
            const list = totals.get(line) || [];
            list.push({ book: bk.title, prices: { over, under } });
            totals.set(line, list);
          }
        }
      }
    }
    out.push({
      id: e.id, sportKey: e.sport_key, date: e.commence_time, home, away,
      h2h: combine(h2h), totals: Object.fromEntries([...totals].map(([l, b]) => [l, combine(b)]).filter(([, v]) => v)),
    });
  }
  return out;
}

// ---- Matching to the app's matches ----
const lastName = (n) => String(n || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z\s-]/g, '').trim().split(/\s+/).pop();
const near = (a, b, hrs) => Math.abs(new Date(a) - new Date(b)) < hrs * 3_600_000;

export function findFootballOdds(match, list) {
  return (list || []).find((o) => near(o.date, match.date, 3) && sameTeam({ name: o.home }, match.home) && sameTeam({ name: o.away }, match.away)) || null;
}
// Tennis: same two surnames within a day; flips sides if the API lists the players the other way round.
export function findTennisOdds(m, list) {
  const a = lastName(m.a.name), b = lastName(m.b.name);
  for (const o of list || []) {
    if (!near(o.date, m.date, 30)) continue;
    const x = lastName(o.home), y = lastName(o.away);
    if (x === a && y === b) return o;
    if (x === b && y === a) return { ...o, h2h: o.h2h && { ...o.h2h, a: o.h2h.b, b: o.h2h.a }, home: o.away, away: o.home };
  }
  return null;
}

// Bookmaker numbers for one side of an app market: { fair, best, bestBook, edge(p) } or null.
// Football markets: o15 / o25 (totals at that line), 1x2. BTTS isn't in the league odds feed.
export function oddsForSide(odds, marketId, side) {
  if (!odds) return null;
  let o = null;
  if (marketId === '1x2' || marketId === 'tw') o = odds.h2h?.[side];
  else if (marketId === 'o15' || marketId === 'o25') o = odds.totals?.[marketId === 'o15' ? 1.5 : 2.5]?.[side === 'yes' ? 'over' : 'under'];
  return o ? { fair: o.fair, best: o.best, bestBook: o.bestBook, books: odds.h2h?.books || null } : null;
}
export const edgeOf = (p, best) => (best > 1 && p != null ? p * best - 1 : null);

// ---- Fetching, cached per sport key ----
const TTL = 2 * 3_600_000;
const mem = new Map(); // sportKey -> { at, list, error }
const inflight = new Map();
const CACHE_KEY = (k) => `gs:odds:${k}`;
function readCache(k) {
  if (mem.has(k)) return mem.get(k);
  try { const v = JSON.parse(localStorage.getItem(CACHE_KEY(k)) || 'null'); if (v) mem.set(k, v); return v; } catch { return null; }
}
function writeCache(k, v) {
  mem.set(k, v);
  try { localStorage.setItem(CACHE_KEY(k), JSON.stringify(v)); } catch { /* storage full */ }
}

async function loadSport(sportKey, sport, key, proxy) {
  const markets = sport === 'tennis' ? 'h2h' : 'h2h,totals';
  const json = await oddsGet(`/sports/${sportKey}/odds?regions=${REGION}&markets=${markets}&oddsFormat=decimal&dateFormat=iso`, key, proxy);
  return parseOdds(json, sport);
}

// Returns the cached list for a sport key now (or null), and refreshes it in the background when it's
// older than 2 hours. onUpdate() is called when fresh odds arrive.
export function oddsList(sportKey, sport, { key, proxy, onUpdate }) {
  if (!key || !sportKey) return null;
  const c = readCache(sportKey);
  const stale = !c || Date.now() - c.at > (c.error ? 30 * 60_000 : TTL);
  if (stale && !inflight.has(sportKey)) {
    inflight.set(sportKey, loadSport(sportKey, sport, key, proxy)
      .then((list) => writeCache(sportKey, { at: Date.now(), list }))
      .catch((err) => writeCache(sportKey, { at: Date.now(), list: c?.list || [], error: err.message }))
      .finally(() => { inflight.delete(sportKey); onUpdate?.(); }));
  }
  return c;
}

// Tennis sport keys change with each tournament; the sports list is free (no credits).
let tennisKeys = null;
export function activeTennisKeys({ key, proxy, onUpdate }) {
  if (!key) return [];
  if (tennisKeys && Date.now() - tennisKeys.at < 6 * 3_600_000) return tennisKeys.keys;
  if (!tennisKeys?.loading) {
    tennisKeys = { ...(tennisKeys || { keys: [] }), loading: true, at: tennisKeys?.at || 0 };
    oddsGet('/sports', key, proxy, { free: true })
      .then((j) => { tennisKeys = { at: Date.now(), keys: (j || []).filter((s) => s.active && /^tennis_(atp|wta)_/.test(s.key)).map((s) => s.key) }; })
      .catch(() => { tennisKeys = { at: Date.now(), keys: tennisKeys?.keys || [] }; })
      .finally(() => onUpdate?.());
  }
  return tennisKeys.keys;
}

export const oddsSource = {
  async test({ key, proxy }) {
    const j = await oddsGet('/sports', key, proxy, { free: true });
    const soccer = (j || []).filter((s) => s.active && s.key.startsWith('soccer_')).length;
    const tennis = (j || []).filter((s) => s.active && s.key.startsWith('tennis_')).length;
    return `Key OK · ${soccer} football and ${tennis} tennis competitions with odds${oddsQuota.remaining != null ? ` · ${oddsQuota.remaining} credits left this month` : ''}`;
  },
};
