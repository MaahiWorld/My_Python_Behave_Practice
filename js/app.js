import { SOURCES, sourceById, afQuota } from './sources.js';
import { scanStats as espnScan, fetchUpcoming, fetchResult } from './api.js';
import { demoMatches, demoDetail } from './demo.js';
import { predict, phaseOf } from './model.js';
import { mergeMatches } from './merge.js';
import { MARKETS, RULES, marketPicks, evaluateMarkets, recordPicks, settlePicks, trackRecord, bestSide, sideLabel, marketById, settleFootball } from './markets.js';
import { loadRecords, updateRecords, summarize, toCSV, saveRecords } from './records.js';
import { fetchTennis, fetchTennisDay, predictTennis, tennisMarkets, recordTennisPicks, settleTennisPicks, settleTennisMarket, scoreState, TENNIS_MARKETS, TENNIS_RULES, demoTennis } from './tennis.js';

const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (p) => `${Math.round(p * 100)}%`;

// ---- Settings ----
const store = {
  get(k, d) { try { const v = localStorage.getItem('gs:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('gs:' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};
const settings = {
  demo: store.get('demo', false),
  proxy: store.get('proxy', ''),
  refresh: store.get('refresh', 30),
  showAll: store.get('showall', false),
};
const keyFor = (id) => store.get('key:' + id, '');
const scanOn = (id) => store.get('scan:' + id, true);
// ESPN is always scanned; keyed sources join the scan once a key is saved (and not switched off).
const enabledSources = () => SOURCES.filter((s) => !s.needsKey || (keyFor(s.id) && scanOn(s.id)));

// ---- State ----
const state = {
  matches: [],
  tab: store.get('tab', 'live'),
  sort: store.get('sort', 'chance'),
  market: store.get('market', 'o15'),
  upcoming: [], // next 7 days in the best-known competitions (Goal markets page)
  upcomingAt: 0,
  upLeague: 'all',
  tennis: [], tennisAt: 0, tennisError: null, tennisMarket: store.get('tmarket', 'tw'), tennisTab: 'all',
  res: { sport: 'all', status: 'all', market: 'all' }, checking: false, checkMsg: '',
  league: 'all',
  details: new Map(), // key -> { detail, at }
  error: null,
  sourceErrors: [],
  sourceCounts: [],
  usingDemo: settings.demo,
  loading: false,
  updated: null,
};
const keyOf = (m) => `${m.league}/${m.id}`;

// ---- Data ----
async function loadMatches(force = false) {
  state.loading = true;
  $('#refresh').classList.add('spin');
  try {
    if (settings.demo) {
      state.matches = demoMatches();
      state.usingDemo = true;
    } else {
      const srcs = enabledSources();
      const results = await Promise.allSettled(srcs.map((s) => s.adapter.fetchMatches({ proxy: settings.proxy, key: keyFor(s.id), force })));
      const lists = [], errors = [];
      results.forEach((r, i) => (r.status === 'fulfilled' ? lists.push({ src: srcs[i], matches: r.value }) : errors.push(`${srcs[i].name}: ${r.reason?.message || r.reason}`)));
      if (!lists.length) throw new Error(errors.join('; ') || 'No data source available');
      state.matches = mergeMatches(lists);
      state.sourceErrors = errors;
      state.sourceCounts = lists.map(({ src, matches }) => ({ name: src.name, id: src.id, n: matches.length, live: matches.filter((m) => m.state === 'in').length }));
      state.usingDemo = false;
    }
    settlePicks(state.matches);
    state.error = null;
    state.updated = new Date();
  } catch (e) {
    state.error = e.message || String(e);
    if (!state.matches.length) {
      state.matches = demoMatches();
      state.usingDemo = true;
    }
  } finally {
    state.loading = false;
    $('#refresh').classList.remove('spin');
    $('#updated').textContent = state.updated ? state.updated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  }
}

// Pre-match analyses are kept on the device for 6 hours, so reopening the app doesn't refetch them.
const DETAIL_STORE = 'gs:details';
const SAVED_MS = 6 * 3_600_000;
(function restoreDetails() {
  try {
    const saved = JSON.parse(localStorage.getItem(DETAIL_STORE) || '{}');
    for (const [k, v] of Object.entries(saved)) if (Date.now() - v.at < SAVED_MS) state.details.set(k, v);
  } catch { /* nothing saved */ }
})();
let saveTimer = null;
function saveDetailsSoon(k, entry, m) {
  if (m.state !== 'pre' || m.league === 'demo') return;
  pendingSaves.set(k, entry);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(DETAIL_STORE) || '{}');
      for (const [kk, v] of pendingSaves) saved[kk] = { at: v.at, detail: { ...v.detail, lineups: { home: [], away: [] }, events: [] } };
      for (const [kk, v] of Object.entries(saved)) if (Date.now() - v.at > SAVED_MS) delete saved[kk];
      localStorage.setItem(DETAIL_STORE, JSON.stringify(saved));
      pendingSaves.clear();
    } catch { /* storage full or unavailable */ }
  }, 1500);
}
const pendingSaves = new Map();

async function getDetail(m, { force = false, ttl } = {}) {
  const k = keyOf(m);
  const hit = state.details.get(k);
  const maxAge = ttl ?? (m.state === 'in' ? 25_000 : 600_000);
  if (!force && hit && Date.now() - hit.at < maxAge) return hit.detail;
  const src = sourceById(m.source);
  const detail = m.league === 'demo' ? demoDetail(m) : await src.adapter.fetchDetail(m, { proxy: settings.proxy, key: keyFor(src.id) });
  const entry = { detail, at: Date.now() };
  state.details.set(k, entry);
  saveDetailsSoon(k, entry, m);
  return detail;
}

// Pre-load full analysis on free sources for live matches and those kicking off within 12 hours,
// so confidence can be judged. Limited-quota sources are only fetched when you open a match.
let warming = false;
let rerenderTimer = null;
function rerenderSoon() {
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(() => {
    const r = route().name;
    if (r === 'list') renderList();
    else if (r === 'markets') renderMarkets();
    else if (r === 'tennis') renderTennis();
    else if (r === 'results') renderResults();
  }, 700);
}
const warmable = (m) => (m.league === 'demo' || !sourceById(m.source).needsKey)
  && (m.state === 'in' || (m.state === 'pre' && new Date(m.date) - Date.now() < 12 * 3_600_000));
const detailErrors = new Map(); // match key -> { msg, at } from the last failed analysis
const RETRY_FAILED_MS = 3 * 60_000;
const failedRecently = (m) => { const e = detailErrors.get(keyOf(m)); return !!e && Date.now() - e.at < RETRY_FAILED_MS; };
const noteFailure = (m, e) => detailErrors.set(keyOf(m), { msg: e?.message || String(e), at: Date.now() });
async function warm() {
  if (warming) return;
  warming = true;
  const queue = state.matches.filter((m) => warmable(m) && !failedRecently(m))
    .sort((a, b) => (a.state === 'in' ? 0 : 1) - (b.state === 'in' ? 0 : 1) || new Date(a.date) - new Date(b.date));
  const worker = async () => {
    while (queue.length) {
      const m = queue.shift();
      try { await getDetail(m, { ttl: m.state === 'in' ? 60_000 : SAVED_MS }); detailErrors.delete(keyOf(m)); } catch (e) { noteFailure(m, e); }
      rerenderSoon();
    }
  };
  try { await Promise.all([worker(), worker()]); } finally { warming = false; }
  rerenderSoon();
}

// ---- Routing ----
function route() {
  const h = location.hash.replace(/^#\/?/, '');
  if (h === 'sources') return { name: 'sources' };
  if (h === 'markets') return { name: 'markets' };
  if (h === 'tennis') return { name: 'tennis' };
  if (h === 'results') return { name: 'results' };
  const m = h.match(/^m\/([^/]+)\/(.+)$/);
  return m ? { name: 'match', league: decodeURIComponent(m[1]), id: decodeURIComponent(m[2]) } : { name: 'list' };
}

function render() {
  const r = route();
  if (r.name === 'match') renderMatch(r);
  else if (r.name === 'sources') renderSources();
  else if (r.name === 'markets') { renderMarkets(); warm(); loadUpcoming(); }
  else if (r.name === 'tennis') { loadTennis(); renderTennis(); }
  else if (r.name === 'results') { renderResults(); checkResults(); }
  else renderList();
}

// ---- Shared bits ----
function crest(team, lg = false) {
  const cls = `crest${lg ? ' lg' : ''}`;
  if (team.logo) return `<img class="${cls}" src="${esc(team.logo)}" alt="" loading="lazy">`;
  return `<span class="${cls}" style="background:${esc(team.color || '#64748b')}">${esc(team.abbr)}</span>`;
}
function statusLabel(m) {
  if (m.state === 'in') {
    const ph = phaseOf(m);
    if (ph === 'HT') return 'HT';
    if (ph === 'BREAK_ET') return 'ET break';
    if (ph === 'PEN') return 'Pens';
    const clock = ph === 'H1' && m.minute > 45 ? `45+${m.minute - 45}` : ph === 'H2' && m.minute > 90 ? `90+${m.minute - 90}`
      : ph === 'ET' && m.minute > 120 ? `120+${m.minute - 120}` : String(m.minute);
    return `${m.estimatedClock ? '≈' : ''}${clock}'${ph === 'ET' ? ' ET' : ''}`;
  }
  if (m.state === 'post') return 'FT';
  const d = new Date(m.date);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}
const reds = (n) => '<span class="red-card" title="Red card"></span>'.repeat(n || 0);
const predFor = (m) => predict(m, state.details.get(keyOf(m))?.detail);
// "Until the end" in words, for the current stage of the match.
const untilEnd = (ph) => ({ HT: 'in the second half', BREAK_ET: 'in extra time', ET: 'before the end of extra time' }[ph] || 'before full time');
const moreGoals = (n) => `${n.toFixed(1)} more goal${n.toFixed(1) === '1.0' ? '' : 's'}`;

// ---- List view ----
function counts() {
  const c = { live: 0, upcoming: 0, finished: 0 };
  for (const m of state.matches) c[m.state === 'in' ? 'live' : m.state === 'pre' ? 'upcoming' : 'finished']++;
  return c;
}
// Only high-confidence predictions are listed (unless "show all" is on in Settings).
const isConfident = (m) => state.details.has(keyOf(m)) && predFor(m).confidence.level === 'High';
function hiddenInfo(want) {
  if (settings.showAll || want === 'post') return { pending: 0, thin: 0 };
  const pool = state.matches.filter((m) => m.state === want && (state.league === 'all' || m.league === state.league) && !isConfident(m));
  const pending = pool.filter((m) => !state.details.has(keyOf(m)) && warmable(m) && !detailErrors.has(keyOf(m))).length;
  return { pending, thin: pool.length - pending };
}
function filtered() {
  const want = { live: 'in', upcoming: 'pre', finished: 'post' }[state.tab];
  const list = state.matches.filter((m) => m.state === want && (state.league === 'all' || m.league === state.league)
    && (settings.showAll || want === 'post' || isConfident(m)));
  if (state.tab === 'live' && state.sort === 'chance') {
    const score = new Map(list.map((m) => [m, predFor(m).expectedMore]));
    return list.sort((a, b) => score.get(b) - score.get(a));
  }
  if (state.tab === 'upcoming') return list.sort((a, b) => new Date(a.date) - new Date(b.date) || a.leagueName.localeCompare(b.leagueName));
  return list.sort((a, b) => a.leagueName.localeCompare(b.leagueName) || new Date(a.date) - new Date(b.date));
}

function cardChance(m) {
  const hit = state.details.get(keyOf(m));
  const p = predFor(m);
  if (m.state === 'post') return `<div class="chance"><div class="lbl">${m.home.score + m.away.score} goals</div></div>`;
  if (m.state === 'in' && p.phase === 'PEN') return '<div class="chance low"><div class="lbl">Penalty<br>shoot-out</div></div>';
  if (m.state === 'in') {
    return `<div class="chance ${p.scopeLevel}">
      <div class="pct">${p.expectedMore.toFixed(1)}</div>
      <div class="lbl">more goals expected${hit ? '' : ' ~'}</div>
      <div class="mini-bar"><i style="width:${pct(p.pMoreGoal)}"></i></div>
      <div class="lbl2">${pct(p.pMoreGoal)} chance of 1+ more</div>
    </div>`;
  }
  return `<div class="chance">
    <div class="pct">${p.expectedMore.toFixed(1)}</div>
    <div class="lbl">goals expected${hit ? '' : ' ~'}</div>
    <div class="mini-bar"><i style="width:${pct(p.pMoreGoal)}"></i></div>
    <div class="lbl2">${pct(p.pMoreGoal)} chance of a goal</div>
  </div>`;
}

// One line per card: how each factor moved the goals expected for the rest of the match.
const DRIVERS = [['strength', 'Attack/defence'], ['form', 'Form'], ['live', 'Match stats'], ['score', 'Scoreline'], ['red', 'Red card'], ['h2h', 'H2H']];
function whyLine(m) {
  const hit = state.details.get(keyOf(m));
  if (!hit || m.state === 'post') return '';
  const p = predict(m, hit.detail);
  const chips = DRIVERS.map(([k, label]) => {
    const r = p.reasons.find((x) => x.key === k);
    if (!r || (['score', 'red', 'h2h'].includes(k) && r.impact === 'neutral')) return '';
    const arrow = r.impact === 'up' ? '▲' : r.impact === 'down' ? '▼' : '•';
    const d = Math.abs(r.delta);
    const val = r.impact === 'neutral' ? '' : ` ${r.delta > 0 ? '+' : '−'}${d < 0.1 ? d.toFixed(2) : d.toFixed(1)}`;
    return `<span class="drv ${r.impact}" title="${esc(r.short)}">${label} ${arrow}${val}</span>`;
  }).join('');
  return `<div class="why"><div class="drivers">${chips}</div>${p.summary.length ? `<div>${esc(p.summary.join(' · '))}</div>` : ''}</div>`;
}

function matchCard(m, showLeague = false) {
  const p = m.state === 'in' ? predFor(m) : null;
  const hot = p?.scopeLevel === 'high' && state.details.has(keyOf(m));
  return `<a class="card match${hot ? ' hot' : ''}" href="#/m/${encodeURIComponent(m.league)}/${encodeURIComponent(m.id)}" data-key="${esc(keyOf(m))}" data-showleague="${showLeague ? 1 : ''}">
    <div class="status ${m.state === 'in' ? 'live' : ''}">${esc(statusLabel(m))}</div>
    <div class="teams">
      ${showLeague ? `<div class="lg-line">${esc(m.leagueName)}</div>` : ''}
      <div class="team-line">${crest(m.home)}<span class="nm">${esc(m.home.short)}${reds(m.home.redCards)}</span><span class="sc">${m.state === 'pre' ? '' : m.home.score}</span></div>
      <div class="team-line">${crest(m.away)}<span class="nm">${esc(m.away.short)}${reds(m.away.redCards)}</span><span class="sc">${m.state === 'pre' ? '' : m.away.score}</span></div>
    </div>
    ${cardChance(m)}
    ${hot ? `<div class="soon">⚡ High goal scope · most likely ${p.mostLikelyMore} more ${untilEnd(p.phase)}</div>` : ''}
    ${whyLine(m)}
  </a>`;
}

function footer() {
  if (state.usingDemo) return '';
  const lines = state.sourceCounts.map((c) => {
    const extra = c.id === 'espn' ? ` · ${espnScan.leagues} competitions scanned` : c.id === 'apifootball' ? ` · ${afQuota.remaining}/${afQuota.limit} free requests left today` : '';
    return `${esc(c.name)}: ${c.live} live / ${c.n} today${extra}`;
  });
  for (const e of state.sourceErrors) lines.push(`⚠ ${esc(e)}`);
  return `<p class="muted small src-line">${lines.join('<br>')}<br><a href="#/sources">Data sources</a></p>`;
}

function renderList() {
  const c = counts();
  const list = filtered();
  const want = { live: 'in', upcoming: 'pre', finished: 'post' }[state.tab];
  const leagues = [...new Map(state.matches.filter((m) => m.state === want).map((m) => [m.league, m.leagueName])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  const tabs = [['live', 'Live'], ['upcoming', 'Upcoming'], ['finished', 'Finished']];
  const byChance = state.tab === 'live' && state.sort === 'chance';
  const hidden = hiddenInfo(want);
  let body = '';
  if (state.loading && !state.matches.length) body = '<div class="skeleton"></div>'.repeat(5);
  else if (!list.length && (hidden.pending || hidden.thin)) {
    body = `<div class="empty muted">No high-confidence predictions ${state.tab === 'live' ? 'among live matches' : 'among upcoming matches'} yet.
      ${hidden.pending ? `<br>Analysing ${hidden.pending} match${hidden.pending > 1 ? 'es' : ''}…` : ''}
      ${hidden.thin ? `<br>${hidden.thin} match${hidden.thin > 1 ? 'es' : ''} hidden: not enough data for a confident prediction.` : ''}</div>`;
  } else if (!list.length) {
    body = `<div class="empty muted">${state.tab === 'live' ? `No matches are live right now${state.usingDemo ? '' : ` across the ${espnScan.leagues}+ competitions scanned`}.` : 'Nothing here right now.'}
      ${state.tab === 'live' && c.upcoming ? '<p><button class="btn" data-tab="upcoming">See upcoming matches</button></p>' : ''}</div>`;
  } else if (byChance) {
    const hot = list.filter((m) => state.details.has(keyOf(m)) && predFor(m).scopeLevel === 'high');
    const rest = list.filter((m) => !hot.includes(m));
    if (hot.length) body += `<div class="league-head watch">⚡ High goal scope · ${hot.length} match${hot.length > 1 ? 'es' : ''} where more goals are very likely</div>${hot.map((m) => matchCard(m, true)).join('')}`;
    body += `<div class="league-head">${hot.length ? 'Other live matches' : 'Live matches'} · most goals expected first</div>${rest.map((m) => matchCard(m, true)).join('')}`;
  } else {
    let lastLeague = null;
    for (const m of list) {
      if (m.leagueName !== lastLeague) { body += `<div class="league-head">${esc(m.leagueName)}</div>`; lastLeague = m.leagueName; }
      body += matchCard(m);
    }
  }
  const banner = state.usingDemo
    ? `<div class="banner">${state.error && !settings.demo ? `Couldn't reach live data (${esc(state.error)}). ` : ''}Showing <b>demo matches</b>. ${settings.demo ? 'Turn off demo mode in ⚙ for real fixtures.' : 'Check your connection or set a CORS proxy in ⚙.'}</div>`
    : state.error ? `<div class="banner">Refresh failed: ${esc(state.error)}</div>` : '';
  view.innerHTML = `${banner}${nav('list')}
    <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button class="tab" role="tab" data-tab="${k}" aria-selected="${state.tab === k}">${l}<span class="count">${c[k]}</span></button>`).join('')}</div>
    ${state.tab === 'live' ? `<div class="chips sort"><button class="chip" data-sort="chance" aria-pressed="${state.sort === 'chance'}">⚡ Most goals expected</button><button class="chip" data-sort="league" aria-pressed="${state.sort === 'league'}">By league</button></div>` : ''}
    ${leagues.length > 1 ? `<div class="chips">${[['all', `All (${leagues.length})`], ...leagues].map(([k, l]) => `<button class="chip" data-league="${esc(k)}" aria-pressed="${state.league === k}">${esc(l)}</button>`).join('')}</div>` : ''}
    ${list.length && (hidden.pending || hidden.thin) ? `<p class="hidden-note">Showing ${list.length} high-confidence prediction${list.length > 1 ? 's' : ''} · ${hidden.thin ? `${hidden.thin} hidden (not enough data)` : ''}${hidden.thin && hidden.pending ? ' · ' : ''}${hidden.pending ? `${hidden.pending} still being analysed` : ''}</p>` : ''}
    ${settings.showAll && want !== 'post' ? '<p class="hidden-note">Showing all matches, including low-confidence ones (change in ⚙ Settings).</p>' : ''}
    ${body}
    ${footer()}
    <p class="disclaimer">Goal chances are model estimates · ≈ = clock estimated between updates</p>`;
}

view.addEventListener('click', (e) => {
  const t = e.target.closest('[data-tab]');
  if (t) { state.tab = t.dataset.tab; state.league = 'all'; store.set('tab', state.tab); renderList(); return; }
  const l = e.target.closest('[data-league]');
  if (l) { state.league = l.dataset.league; renderList(); return; }
  const ul = e.target.closest('[data-upleague]');
  if (ul) { state.upLeague = ul.dataset.upleague; renderMarkets(); return; }
  const mt = e.target.closest('[data-market]');
  if (mt) { state.market = mt.dataset.market; store.set('market', state.market); renderMarkets(); return; }
  const tm = e.target.closest('[data-tmarket]');
  if (tm) { state.tennisMarket = tm.dataset.tmarket; store.set('tmarket', state.tennisMarket); renderTennis(); return; }
  const tt = e.target.closest('[data-ttab]');
  if (tt) { state.tennisTab = tt.dataset.ttab; renderTennis(); return; }
  const rf = e.target.closest('[data-res]');
  if (rf) { const [k, v] = rf.dataset.res.split(':'); state.res[k] = v; if (k === 'sport') state.res.market = 'all'; renderResults(); return; }
  const ra = e.target.closest('[data-resact]');
  if (ra) { resultsAction(ra.dataset.resact); return; }
  const so = e.target.closest('[data-sort]');
  if (so) { state.sort = so.dataset.sort; store.set('sort', state.sort); renderList(); }
});

function nav(current) {
  const link = (href, id, label) => `<a href="${href}" ${current === id ? 'aria-current="page"' : ''}>${label}</a>`;
  return `<nav class="nav">${link('#/', 'list', 'Matches')}${link('#/markets', 'markets', 'Markets')}${link('#/tennis', 'tennis', 'Tennis')}${link('#/results', 'results', 'Results')}</nav>`;
}

// ---- Upcoming fixtures (next 7 days, best-known competitions) ----
let upLoading = false, upWarming = false, upPromise = null;
function loadUpcoming() {
  if (upPromise) return upPromise; // one request at a time; callers share it
  if (state.usingDemo || Date.now() - state.upcomingAt < 30 * 60_000) { warmUpcoming(); return Promise.resolve(); }
  upLoading = true;
  upPromise = fetchUpcoming({ proxy: settings.proxy, days: 7 })
    .then((list) => { state.upcoming = list; state.upcomingError = null; })
    .catch((e) => { state.upcomingError = e.message || String(e); })
    .finally(() => { state.upcomingAt = Date.now(); upLoading = false; upPromise = null; rerenderSoon(); warmUpcoming(); });
  return upPromise;
}
// Analyses upcoming fixtures in kick-off order (free ESPN data; kept for 3 hours).
async function warmUpcoming() {
  if (upWarming) return;
  upWarming = true;
  const queue = state.upcoming.filter((m) => !state.details.has(keyOf(m)) && !failedRecently(m));
  const worker = async () => {
    while (queue.length) {
      const m = queue.shift();
      try { await getDetail(m, { ttl: SAVED_MS }); detailErrors.delete(keyOf(m)); } catch (e) { noteFailure(m, e); }
      rerenderSoon();
    }
  };
  try { await Promise.all([worker(), worker()]); } finally { upWarming = false; }
  // Retry anything that failed once the pause has passed.
  if (state.upcoming.some((m) => !state.details.has(keyOf(m)) && detailErrors.has(keyOf(m)))) setTimeout(warmUpcoming, RETRY_FAILED_MS + 1000);
}
// Everything the Goal markets page considers: live and soon-starting matches, plus the next 7 days
// in the best-known competitions.
function marketCandidates() {
  const out = new Map();
  for (const m of state.matches) if (m.state === 'in' || (m.state === 'pre' && new Date(m.date) - Date.now() < 12 * 3_600_000)) out.set(keyOf(m), m);
  for (const m of state.upcoming) if (!out.has(keyOf(m))) out.set(keyOf(m), m);
  return [...out.values()];
}

// ---- Goal markets page ----
// Backtest figures (unseen seasons) from backtest/results.json, shown next to the on-device record.
let backtest = null;
fetch('backtest/results.json').then((r) => (r.ok ? r.json() : null)).then((j) => { backtest = j; if (route().name === 'markets') renderMarkets(); }).catch(() => {});
function backtestLine(id) {
  const t = backtest?.test;
  if (!t) return '';
  const m = t.picks.byMarket[id];
  if (!m) return '';
  const base = t.highConfidenceMarkets[id];
  const txt = m.picks
    ? `<b>${Math.round(m.hitRate)} of 100</b> correct (${m.won.toLocaleString()} of ${m.picks.toLocaleString()} picks)${id === 'o15' || id === 'h1o05' ? `; ${id === 'o15' ? 'Over 1.5' : 'a first-half goal'} happens ${Math.round(base.baseline)} in 100 anyway` : ''}`
    : `no pick reached the confidence bar in ${t.data.matches.toLocaleString()} matches, so expect this tab to be empty most of the time`;
  return `<p class="small">Backtest on ${t.data.seasons} (${t.data.matches.toLocaleString()} past matches the model wasn't tuned on): ${txt}. <a href="https://github.com/MaahiWorld/My_Python_Behave_Practice/blob/main/backtest/RESULTS.md" target="_blank" rel="noopener">Details</a></p>`;
}
function renderMarkets() {
  const mk = MARKETS.find((x) => x.id === state.market) || MARKETS[0];
  const all = [];
  const cands = marketCandidates();
  for (const m of cands) {
    const hit = state.details.get(keyOf(m));
    if (!hit || (m.state !== 'in' && m.state !== 'pre')) continue;
    const picks = marketPicks(m, hit.detail);
    recordPicks(m, picks);
    for (const pk of picks) all.push({ m, pk });
  }
  const counts = Object.fromEntries(MARKETS.map((x) => [x.id, all.filter((a) => a.pk.market.id === x.id).length]));
  const list = all.filter((a) => a.pk.market.id === mk.id).sort((a, b) => b.pk.p - a.pk.p);
  const pending = cands.filter((m) => (warmable(m) || state.upcoming.includes(m)) && !state.details.has(keyOf(m)) && !detailErrors.has(keyOf(m))).length;
  const tr = trackRecord().by[mk.id];
  const record = tr.settled
    ? `<b>${tr.won} of ${tr.settled}</b> correct (${Math.round((tr.won / tr.settled) * 100)}%)${tr.pending ? ` · ${tr.pending} awaiting full time` : ''}`
    : `No settled picks yet${tr.pending ? ` · ${tr.pending} awaiting full time` : ''}. Every pick shown is recorded and checked at full time.`;
  const card = ({ m, pk }) => {
    const live = m.state === 'in';
    return `<a class="card pick" href="#/m/${encodeURIComponent(m.league)}/${encodeURIComponent(m.id)}">
      <div class="pick-top"><span class="lg-line">${esc(m.leagueName)}</span><span class="status ${live ? 'live' : ''}">${esc(statusLabel(m))}</span></div>
      <div class="pick-teams">${esc(m.home.short)} ${m.state === 'pre' ? 'vs' : `<b>${m.home.score}–${m.away.score}</b>`} ${esc(m.away.short)}</div>
      <div class="pick-main"><span class="pick-label ${pk.side}">${esc(pk.label)}</span><span class="pick-p">${pct(pk.p)}</span><span class="badge on">${pk.level} confidence</span></div>
      <div class="checks">${pk.checks.map((c) => `<span class="chk">✓ ${esc(c.label)} ${esc(c.txt)}</span>`).join('')}</div>
      <div class="muted small">Expected ${live ? 'final ' : ''}total ${pk.pred.expectedFinalTotal.toFixed(1)} goals${live ? ` · ${pk.pred.expectedMore.toFixed(1)} more expected` : ''}</div>
    </a>`;
  };
  view.innerHTML = `${nav('markets')}
    <div class="tabs wrap" role="tablist">${MARKETS.map((x) => `<button class="tab" role="tab" data-market="${x.id}" aria-selected="${x.id === mk.id}">${esc(x.tab)}<span class="count">${counts[x.id]}</span></button>`).join('')}</div>
    <div class="card section record"><h3>${esc(mk.name)} · track record</h3><p class="small">On this device: ${record}</p>${backtestLine(mk.id)}</div>
    <details class="howto"><summary>How picks are validated</summary>
      <ol>
        <li>The match prediction must be <b>high confidence</b>: season attack/defence records and recent form for both teams, plus current match stats when live.</li>
        <li>The model must give the pick at least <b>${Math.round((mk.minProb ?? RULES.minProb) * 100)}%</b>${mk.minProb ? ' (this market\'s own bar, set on the backtest\'s training seasons)' : ''}.</li>
        <li>Independent cross-checks must all agree (at least ${Math.round((mk.minCheck ?? RULES.minCheck) * 100)}%): the season record alone, recent form alone, the prediction without live match stats, and head-to-head history (4+ meetings, before kick-off). At least two checks are required.</li>
        <li>Markets already decided (e.g. Over 1.5 with two goals in, or first-half markets after half time) are left out.</li>
      </ol>
      <p class="small">Settles on: ${esc(mk.rule)}. Every pick is checked after full time on the <a href="#/results">Results</a> page.</p>
      <p class="muted small">Covers live matches, matches starting today, and the next 7 days in the best-known competitions (free ESPN data). Statistical estimates, not betting advice.</p>
    </details>
    ${list.length ? list.map(card).join('') : `<div class="empty muted">No validated ${esc(mk.name)} picks right now.${pending ? `<br>Analysing ${pending} match${pending > 1 ? 'es' : ''}…` : ''}</div>`}
    ${upcomingFixtures(mk, all)}
    ${whyNoPicks(mk)}
    <p class="disclaimer">Statistical estimates only — not betting advice.</p>`;
}

// Upcoming fixtures in the best-known competitions with their market predictions (high confidence only).
function upcomingFixtures(mk, picks) {
  if (state.usingDemo) return '';
  if (!state.upcoming.length) {
    return `<div class="card section"><h3>Upcoming fixtures · top leagues</h3><p class="small muted">${upLoading || !state.upcomingAt ? 'Loading the next 7 days of fixtures…' : `No fixtures found in the next 7 days${state.upcomingError ? ` (${esc(state.upcomingError)})` : ''}.`}</p></div>`;
  }
  const picked = new Set(picks.map((a) => `${keyOf(a.m)}|${a.pk.market.id}`));
  const leagues = [...new Map(state.upcoming.map((m) => [m.league, m.leagueName])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const inLeague = state.upcoming.filter((m) => state.upLeague === 'all' || m.league === state.upLeague);
  let shown = 0, thin = 0, pending = 0, failed = 0, html = '', lastDay = '';
  for (const m of inLeague) {
    const hit = state.details.get(keyOf(m));
    if (!hit) { detailErrors.has(keyOf(m)) ? failed++ : pending++; continue; }
    const p = predict(m, hit.detail);
    if (p.confidence.level !== 'High' && !settings.showAll) { thin++; continue; }
    shown++;
    const day = new Date(m.date).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
    if (day !== lastDay) { html += `<div class="fx-day">${esc(day)}</div>`; lastDay = day; }
    const cell = (x) => {
      const isPick = picked.has(`${keyOf(m)}|${x.id}`);
      let small = x.tab, v;
      if (x.sides) { const b = bestSide(x, p); v = b.p; small = `${x.tab} ${{ home: '1', draw: 'X', away: '2' }[b.side]}`; } else v = x.probs(p).yes;
      return `<span class="fx-p ${x.id === mk.id ? 'sel' : ''} ${isPick ? 'fx-pick' : ''}" title="${esc(x.name)}"><small>${esc(small)}</small>${pct(v)}${isPick ? ' ✓' : ''}</span>`;
    };
    html += `<a class="fx" href="#/m/${encodeURIComponent(m.league)}/${encodeURIComponent(m.id)}">
      <span class="fx-time">${new Date(m.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      <span class="fx-teams"><span class="lg-line">${esc(m.leagueName)}</span>${esc(m.home.short)} vs ${esc(m.away.short)}</span>
      <span class="fx-ps">${MARKETS.map(cell).join('')}</span>
    </a>`;
  }
  return `<div class="card section fixtures"><h3>Upcoming fixtures · top leagues · next 7 days</h3>
    ${leagues.length > 1 ? `<div class="chips">${[['all', `All (${state.upcoming.length})`], ...leagues].map(([k, l]) => `<button class="chip" data-upleague="${esc(k)}" aria-pressed="${state.upLeague === k}">${esc(l)}</button>`).join('')}</div>` : ''}
    <p class="small muted">Chance of each market's Yes/Over side (1X2: the most likely result, 1 = home, X = draw, 2 = away) for each match. ✓ marks a validated pick. Tap a match for the full reasoning.</p>
    ${html || '<p class="small muted">No high-confidence predictions here yet.</p>'}
    <p class="small muted">${[shown && `${shown} shown`, thin && `${thin} hidden (not enough data for a high-confidence prediction)`, pending && `${pending} still being analysed…`, failed && `${failed} couldn't load their stats yet (retrying)`].filter(Boolean).join(' · ')}</p>
  </div>`;
}

// Explains, for the chosen market, why each candidate match did or didn't produce a pick.
function whyNoPicks(mk) {
  const cands = marketCandidates();
  if (!cands.length) {
    return `<div class="card section diag"><h3>Why no picks?</h3><p>No live or upcoming matches found${state.usingDemo ? ' in the demo data' : ''}.</p></div>`;
  }
  const c = { pending: 0, failed: 0, keyed: 0, thin: 0, missing: {}, lowProb: 0, checkFailed: 0, decided: 0, fewChecks: 0, picks: 0 };
  const near = [];
  for (const m of cands) {
    const k = keyOf(m);
    const hit = state.details.get(k);
    if (!hit) {
      if (detailErrors.has(k)) c.failed++;
      else if (!warmable(m) && !state.upcoming.includes(m)) c.keyed++;
      else c.pending++;
      continue;
    }
    const e = evaluateMarkets(m, hit.detail).find((x) => x.market.id === mk.id);
    switch (e.status) {
      case 'pick': c.picks++; break;
      case 'decided': c.decided++; break;
      case 'low-confidence': c.thin++; for (const x of e.missing) c.missing[x] = (c.missing[x] || 0) + 1; break;
      case 'low-prob': c.lowProb++; near.push({ m, e, gap: e.need - e.p, why: `${pct(e.p)} (needs ${pct(e.need)})` }); break;
      case 'few-checks': c.fewChecks++; break;
      case 'check-failed': c.checkFailed++; near.push({ m, e, gap: Math.max(...e.failed.map((f) => e.needCheck - f.p)), why: `${pct(e.p)}, but ${e.failed.map((f) => `${f.label.toLowerCase()} ${f.txt}`).join(', ')} (checks need ${pct(e.needCheck)})` }); break;
      default: break;
    }
  }
  const rows = [
    [c.picks, 'gave a validated pick'],
    [c.lowProb, `rated below ${pct(mk.minProb ?? RULES.minProb)} for ${mk.name}`],
    [c.checkFailed, 'reached the bar, but a cross-check disagreed'],
    [c.fewChecks, 'had too few independent checks'],
    [c.decided, 'already decided on the scoreboard'],
    [c.thin, 'not enough data for a high-confidence prediction'],
    [c.pending, 'still being analysed'],
    [c.failed, 'couldn\'t load their stats yet (retrying)'],
    [c.keyed, 'from API-Football (only analysed when opened, to save the free requests)'],
  ].filter(([n]) => n);
  const missing = Object.entries(c.missing).sort((a, b) => b[1] - a[1]);
  const errs = {};
  for (const m of cands) { const e = detailErrors.get(keyOf(m)); if (e && !state.details.has(keyOf(m))) errs[e.msg] = (errs[e.msg] || 0) + 1; }
  const errList = Object.entries(errs).sort((a, b) => b[1] - a[1]).slice(0, 3);
  near.sort((a, b) => a.gap - b.gap);
  return `<div class="card section diag"><h3>Why ${c.picks ? 'only these' : 'no'} picks?</h3>
    <p class="small">Checked <b>${cands.length}</b> match${cands.length > 1 ? 'es' : ''} (live, kicking off today, or in the top leagues over the next 7 days):</p>
    <ul class="diag-list">${rows.map(([n, t]) => `<li><b>${n}</b> ${t}</li>`).join('')}</ul>
    ${missing.length ? `<p class="small muted">Missing data: ${missing.map(([t, n]) => `${esc(t)} (${n})`).join('; ')}.</p>` : ''}
    ${errList.length ? `<p class="small muted">Load errors (retried automatically every few minutes): ${errList.map(([t, n]) => `“${esc(t)}” (${n})`).join('; ')}.</p>` : ''}
    ${near.length ? `<h3 style="margin-top:12px">Closest to a pick</h3><ul class="near">${near.slice(0, 5).map(({ m, e, why }) => `<li><a href="#/m/${encodeURIComponent(m.league)}/${encodeURIComponent(m.id)}">${esc(m.home.short)} vs ${esc(m.away.short)}</a> <span class="muted">· ${esc(statusLabel(m))}</span><br><b>${esc(e.label)}</b> ${esc(why)}</li>`).join('')}</ul>` : ''}
    <p class="small muted">The bar is high on purpose: in the backtest about 1 match in 4 gave a pick, most of them Over 1.5.</p>
  </div>`;
}

// Every football market for one match: the model's best side and whether it's a validated pick.
const STATUS_TXT = {
  pick: 'validated pick', decided: 'already decided', 'low-confidence': 'not enough data', 'low-prob': 'below the bar',
  'check-failed': 'a cross-check disagreed', 'few-checks': 'too few cross-checks', finished: 'finished',
};
function marketsPanel(m, d) {
  if (m.state === 'post' || !d) return '';
  const p = predict(m, d);
  const rows = evaluateMarkets(m, d).map((e) => {
    const b = bestSide(e.market, p);
    if (!b) return `<tr><td>${esc(e.market.name)}</td><td colspan="2" class="muted">${e.market.id.startsWith('h1') ? 'first half over' : '–'}</td><td class="muted small">${STATUS_TXT[e.status] || ''}</td></tr>`;
    const label = e.label || sideLabel(e.market, b.side, m);
    const p100 = e.p ?? b.p;
    const extra = e.market.sides ? ` <span class="muted small">(${e.market.sides.map((sd) => `${{ home: '1', draw: 'X', away: '2' }[sd]} ${pct(b.probs[sd])}`).join(' · ')})</span>` : '';
    return `<tr class="${e.status === 'pick' ? 'is-pick' : ''}"><td>${esc(e.market.name)}</td><td><b>${esc(label)}</b>${extra}</td><td class="num">${pct(p100)}</td>
      <td class="small ${e.status === 'pick' ? 'good' : 'muted'}">${e.status === 'pick' ? '✓ ' : ''}${STATUS_TXT[e.status] || ''}</td></tr>`;
  }).join('');
  return `<section class="card section"><h3>Markets for this match</h3>
    <table class="mk-table"><tbody>${rows}</tbody></table>
    <p class="muted small">Most likely side of each market. Only validated picks (see <a href="#/markets">Markets</a>) are recorded and checked on the <a href="#/results">Results</a> page.</p></section>`;
}

// ---- Tennis page ----
let tennisPromise = null;
function loadTennis(force = false) {
  if (tennisPromise) return tennisPromise;
  if (settings.demo) {
    if (!state.tennis.length) { state.tennis = demoTennis(); state.tennisDemo = true; }
    return Promise.resolve();
  }
  if (!force && Date.now() - state.tennisAt < 60_000) return Promise.resolve();
  tennisPromise = fetchTennis({ proxy: settings.proxy, days: 1 })
    .then((list) => { state.tennis = list; state.tennisError = null; state.tennisDemo = false; settleTennisPicks(list); })
    .catch((e) => { state.tennisError = e.message || String(e); })
    .finally(() => { state.tennisAt = Date.now(); tennisPromise = null; if (route().name === 'tennis') renderTennis(); });
  return tennisPromise;
}
const tPredCache = new Map();
function tPred(m) {
  const k = `${m.tour}/${m.id}|${m.state}|${JSON.stringify([m.a.sets, m.b.sets, m.a.rank, m.b.rank])}`;
  if (!tPredCache.has(k)) { if (tPredCache.size > 400) tPredCache.clear(); tPredCache.set(k, predictTennis(m)); }
  return tPredCache.get(k);
}
const setsTxt = (m) => scoreState(m).sets.map(([x, y]) => `${x}-${y}`).join('  ');
const tStatus = (m) => (m.state === 'in' ? 'Live' : m.state === 'post' ? 'Final' : statusLabel({ state: 'pre', date: m.date }));
const rk = (pl) => (pl.rank ? `<span class="muted small">#${pl.rank}</span>` : '<span class="muted small">unranked</span>');

function tennisCard(m) {
  const p = m.state === 'post' ? null : tPred(m);
  const mk = p ? tennisMarkets(m, p) : [];
  const st = scoreState(m);
  const line = (pl, side) => `<div class="team-line"><span class="nm">${esc(pl.name)} ${rk(pl)}${pl.winner ? ' ✓' : ''}</span>
    <span class="sc tsets">${st.sets.map(([x, y]) => `<i>${side === 'a' ? x : y}</i>`).join('')}</span></div>`;
  const chips = mk.map((x) => `<span class="drv ${x.status === 'pick' ? 'up' : 'neutral'}" title="${esc(TENNIS_MARKETS.find((t) => t.id === x.market).name)}">${esc(x.label)} ${pct(x.p)}${x.status === 'pick' ? ' ✓' : ''}</span>`).join('');
  const detail = p && p.dist ? `<details class="t-more"><summary>Sets, games and likely scores</summary>
      <p class="small">${esc(m.a.short)} win chance <b>${pct(p.pA)}</b>${p.preWin != null && m.state === 'in' ? ` (before the match: ${pct(p.preWin)})` : ''}.
        Expected total games <b>${p.expectedGames.toFixed(1)}</b>. ${esc(m[p.dog].short)} win at least one set: <b>${pct(p.dogSet)}</b>.</p>
      <div class="scores">${p.topScores.slice(0, 6).map(([sc, v]) => `<span class="score-pill"><b>${esc(sc)}</b>${pct(v)}</span>`).join('')}</div>
      <p class="small">Sets: ${Object.entries(p.dist.sets).map(([n, v]) => `${n} sets ${pct(v)}`).join(' · ')}</p>
      <p class="small">Games: ${p.gameLines.map((g) => `O${g.line} ${pct(g.over)}`).join(' · ')}</p>
      <p class="muted small">Serve points won assumed: ${esc(m.a.short)} ${pct(p.pa)}, ${esc(m.b.short)} ${pct(p.pb)} (set so the ranking gap gives a ${pct(p.preWin ?? 0.5)} pre-match chance over best of 3).${p.confidence.missing.length ? ` Missing: ${esc(p.confidence.missing.join(', '))}.` : ''}</p>
    </details>` : '';
  return `<div class="card tmatch">
    <div class="pick-top"><span class="lg-line">${esc([m.event, m.round].filter(Boolean).join(' · '))} · best of ${m.bestOf}</span><span class="status ${m.state === 'in' ? 'live' : ''}">${esc(tStatus(m))}</span></div>
    <div class="teams">${line(m.a, 'a')}${line(m.b, 'b')}</div>
    ${p?.confidence.level === 'Low' ? '<div class="muted small">No ranking for one of the players: shown for reference, no picks.</div>' : ''}
    ${chips ? `<div class="drivers">${chips}</div>` : ''}
    ${m.state === 'post' && m.void ? `<div class="muted small">${esc(m.detail || 'Retired / walkover')}</div>` : ''}
    ${detail}
  </div>`;
}

function renderTennis() {
  const all = state.tennis;
  const tabs = [['all', 'All'], ['in', 'Live'], ['pre', 'Upcoming'], ['post', 'Finished']];
  const cnt = (s) => all.filter((m) => s === 'all' || m.state === s).length;
  const list = all.filter((m) => state.tennisTab === 'all' || m.state === state.tennisTab)
    .sort((a, b) => ({ in: 0, pre: 1, post: 2 }[a.state] - { in: 0, pre: 1, post: 2 }[b.state]) || new Date(a.date) - new Date(b.date));
  const mk = TENNIS_MARKETS.find((x) => x.id === state.tennisMarket) || TENNIS_MARKETS[0];
  const picks = [];
  for (const m of all) {
    if (m.state === 'post') continue;
    const ps = tennisMarkets(m, tPred(m)).filter((x) => x.status === 'pick');
    if (!state.tennisDemo) recordTennisPicks(m, ps);
    for (const x of ps) picks.push({ m, x });
  }
  const shown = picks.filter((a) => a.x.market === mk.id).sort((a, b) => b.x.p - a.x.p);
  const recs = loadRecords().filter((x) => x.sport === 'tennis' && x.market === mk.id);
  const done = recs.filter((x) => x.result === 'won' || x.result === 'lost');
  const won = done.filter((x) => x.result === 'won').length;
  const pickCard = ({ m, x }) => `<div class="card pick">
      <div class="pick-top"><span class="lg-line">${esc(m.event)}${m.round ? ` · ${esc(m.round)}` : ''}</span><span class="status ${m.state === 'in' ? 'live' : ''}">${esc(tStatus(m))}</span></div>
      <div class="pick-teams">${esc(m.a.short)} ${rk(m.a)} vs ${esc(m.b.short)} ${rk(m.b)}${m.state === 'in' ? ` · <b>${esc(setsTxt(m))}</b>` : ''}</div>
      <div class="pick-main"><span class="pick-label yes">${esc(x.label)}</span><span class="pick-p">${pct(x.p)}</span><span class="badge ready">Model only · untested</span></div>
    </div>`;
  const banner = state.tennisDemo ? '<div class="banner">Showing <b>demo tennis matches</b> (fictional players). Turn off demo mode in ⚙ for the live ATP/WTA feed.</div>'
    : state.tennisError ? `<div class="banner">Couldn't load tennis (${esc(state.tennisError)}). ${all.length ? 'Showing the last list.' : 'Check your connection or set a CORS proxy in ⚙.'}</div>` : '';
  view.innerHTML = `${banner}${nav('tennis')}
    <div class="tabs wrap" role="tablist">${TENNIS_MARKETS.map((x) => `<button class="tab" role="tab" data-tmarket="${x.id}" aria-selected="${x.id === mk.id}">${esc(x.tab)}<span class="count">${picks.filter((a) => a.x.market === x.id).length}</span></button>`).join('')}</div>
    <div class="card section record"><h3>${esc(mk.name)} · picks</h3>
      <p class="small">On this device: ${done.length ? `<b>${won} of ${done.length}</b> correct (${Math.round((won / done.length) * 100)}%)` : 'no settled picks yet'}${recs.length - done.length ? ` · ${recs.length - done.length} awaiting a result` : ''}. <a href="#/results">Check results</a></p>
      <p class="small muted">Experimental: picks need the model at ${pct(TENNIS_RULES.minProb)}+, and both players ranked. Unlike football there are no independent cross-checks and no backtest yet, so treat the first weeks of results as the test.</p></div>
    ${shown.length ? shown.map(pickCard).join('') : `<div class="empty muted">${!state.tennisAt && !all.length ? 'Loading ATP and WTA matches…' : `No ${esc(mk.name.toLowerCase())} picks right now.`}</div>`}
    <details class="howto"><summary>How tennis predictions work</summary>
      <ol>
        <li>Each player's world ranking gives a pre-match win chance over best of 3: 1 ÷ (1 + (rank A ÷ rank B)<sup>0.5</sup>). For example #3 vs #41 → 79%.</li>
        <li>That chance is turned into how often each player wins a point on serve (around 64% on the ATP tour, 56% on the WTA tour, plus or minus the gap).</li>
        <li>A point → game → set → match model (tiebreak at 6–6) then gives every market: the winner, whether the underdog takes a set, the number of sets and the number of games (a tiebreak counts as one game). Best of 5 is used for men's Grand Slam singles.</li>
        <li>Live, the model restarts from the current set and game score, so a player a set and a break up is rated accordingly.</li>
      </ol>
      <p class="small muted">Not used, because the free feed doesn't provide them: serve/return statistics, surface form, fatigue, injuries, head-to-head. Retirements and walkovers are void.</p>
    </details>
    <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button class="tab" role="tab" data-ttab="${k}" aria-selected="${state.tennisTab === k}">${l}<span class="count">${cnt(k)}</span></button>`).join('')}</div>
    ${list.length ? list.map(tennisCard).join('') : `<div class="empty muted">${state.tennisAt || state.tennisDemo ? 'No singles matches in the ATP/WTA feed for this filter.' : 'Loading…'}</div>`}
    <p class="disclaimer">Statistical estimates only — not betting advice.</p>`;
}

// ---- Results page: every recorded pick, checked against the final result ----
const marketName = (x) => (x.sport === 'tennis' ? TENNIS_MARKETS.find((t) => t.id === x.market)?.name : marketById(x.market)?.name) || x.market;
const RESULT_BADGE = { won: ['won', '✓ Won'], lost: ['lost', '✗ Lost'], void: ['void', 'Void'], unknown: ['void', 'No result'] };

async function checkResults(force = false) {
  if (state.checking) return;
  const now = Date.now();
  const due = loadRecords().filter((x) => !x.result && x.league !== 'demo' && (x.source || 'espn') === 'espn'
    && now - new Date(x.kickoff || x.at).getTime() > (x.sport === 'tennis' ? 1 : 2) * 3_600_000
    && (force || !x.checkedAt || now - x.checkedAt > 15 * 60_000));
  if (!due.length) { if (force) { state.checkMsg = 'Nothing to check: every pick whose match should be over has a result.'; renderResults(); } return; }
  state.checking = true; state.checkMsg = `Checking ${due.length} result${due.length > 1 ? 's' : ''}…`;
  if (route().name === 'results') renderResults();
  let settled = 0, failed = 0;
  const football = [...new Map(due.filter((x) => x.sport !== 'tennis').map((x) => [`${x.league}/${x.eventId || x.id.split('/')[1]}`, x])).keys()].slice(0, 30);
  const tennisDays = [...new Set(due.filter((x) => x.sport === 'tennis').map((x) => `${x.league}|${(x.kickoff || '').slice(0, 10)}`))].slice(0, 10);
  const patches = new Map(); // record id -> patch
  await Promise.all(football.map(async (k) => {
    const [league, id] = k.split('/');
    try {
      const r = await fetchResult(league, id, { proxy: settings.proxy });
      for (const x of due.filter((y) => y.sport !== 'tennis' && y.id.startsWith(`${league}/${id}/`))) {
        if (r?.state === 'post') { patches.set(x.id, { ...settleFootball(x, r), settledAt: Date.now() }); settled++; } else patches.set(x.id, { checkedAt: Date.now() });
      }
    } catch { failed++; }
  }));
  await Promise.all(tennisDays.map(async (k) => {
    const [tour, day] = k.split('|');
    try {
      const ms = await fetchTennisDay(tour, day ? `${day}T12:00:00Z` : new Date().toISOString(), { proxy: settings.proxy });
      for (const x of due.filter((y) => y.sport === 'tennis' && y.league === tour)) {
        const m = ms.find((mm) => mm.id === x.eventId);
        const r = m && settleTennisMarket(x, m);
        if (r) { patches.set(x.id, { ...r, settledAt: Date.now() }); settled++; } else if (m) patches.set(x.id, { checkedAt: Date.now() });
      }
    } catch { failed++; }
  }));
  updateRecords((x) => patches.get(x.id) || null);
  state.checking = false;
  state.checkMsg = `Checked just now: ${settled} newly settled${failed ? ` · ${failed} couldn't be reached (try again later)` : ''}.`;
  if (route().name === 'results') renderResults();
}

function resultsAction(act) {
  if (act === 'check') { checkResults(true); return; }
  if (act === 'csv') {
    const blob = new Blob([toCSV(loadRecords())], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `goalscope-results-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return;
  }
  if (act === 'clear' && confirm('Delete every recorded pick and result on this device?')) { saveRecords([]); renderResults(); }
}

function explainResult(x) {
  if (x.result === 'void') return x.note ? `Void: ${x.note}` : 'Void';
  if (x.result === 'unknown') return x.note ? `Couldn't settle: ${x.note}` : 'Couldn\'t settle';
  if (!x.result) return new Date(x.kickoff || x.at) > new Date() ? 'Not started yet' : 'Waiting for the final result';
  if (x.sport === 'tennis') return `Final ${x.final} in sets (${x.sets}) · ${x.totalGames} games`;
  const mk = marketById(x.market);
  const tot = x.final ? x.final.split('-').reduce((s, v) => s + +v, 0) : null;
  const bits = [`Full time ${x.final}${x.aet ? ' (after extra time; 1X2 settles as a draw)' : ''}`];
  if (x.ht) bits.push(`half time ${x.ht}`);
  if (mk?.id === '1x2' && x.winner) bits.push(`result: ${x.winner}`);
  else if (mk && !mk.sides && tot != null) bits.push(`${mk.rule}`);
  return bits.join(' · ');
}

function renderResults() {
  const all = loadRecords().slice().sort((a, b) => new Date(b.kickoff || b.at) - new Date(a.kickoff || a.at));
  const f = state.res;
  const bySport = all.filter((x) => f.sport === 'all' || (x.sport || 'football') === f.sport);
  const marketsHere = [...new Set(bySport.map((x) => `${x.sport || 'football'}|${x.market}`))];
  const isStatus = (x) => f.status === 'all' || (f.status === 'pending' ? !x.result : f.status === 'other' ? ['void', 'unknown'].includes(x.result) : x.result === f.status);
  const list = bySport.filter((x) => (f.market === 'all' || `${x.sport || 'football'}|${x.market}` === f.market) && isStatus(x));
  const sum = summarize(bySport);
  const tot = sum.reduce((s, g) => ({ settled: s.settled + g.settled, won: s.won + g.won, pending: s.pending + g.pending, sumP: s.sumP + g.sumP }), { settled: 0, won: 0, pending: 0, sumP: 0 });
  const chip = (k, v, l) => `<button class="chip" data-res="${k}:${esc(v)}" aria-pressed="${f[k] === v}">${esc(l)}</button>`;
  const rows = sum.sort((a, b) => b.picks - a.picks).map((g) => `<tr>
      <td>${g.sport === 'tennis' ? '🎾' : '⚽'} ${esc(marketName(g))}</td><td class="num">${g.picks}</td>
      <td class="num">${g.settled ? `${g.won}/${g.settled}` : '–'}</td>
      <td class="num"><b>${g.hitRate == null ? '–' : pct(g.hitRate)}</b></td><td class="num muted">${g.claimed == null ? '–' : pct(g.claimed)}</td>
      <td class="num muted">${g.pending || ''}</td></tr>`).join('');
  let body = '', lastDay = '';
  for (const x of list.slice(0, 300)) {
    const day = new Date(x.kickoff || x.at).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
    if (day !== lastDay) { body += `<div class="fx-day">${esc(day)}</div>`; lastDay = day; }
    const [cls, txt] = RESULT_BADGE[x.result] || ['pending', '⏳ Pending'];
    const label = x.label || (x.sport === 'tennis' ? x.side : sideLabel(marketById(x.market) || { yes: 'Yes', no: 'No' }, x.side, { home: { short: x.home || 'Home' }, away: { short: x.away || 'Away' } }));
    const when = x.minute != null ? `at ${x.minute}' (${x.score})` : x.score && x.sport === 'tennis' ? `during play (${x.score})` : 'before kick-off';
    const link = x.sport !== 'tennis' && x.result == null ? `#/m/${encodeURIComponent(x.league)}/${encodeURIComponent(x.eventId || x.id.split('/')[1])}` : null;
    body += `<div class="card res-row ${cls}">
      <div class="pick-top"><span class="lg-line">${x.sport === 'tennis' ? '🎾' : '⚽'} ${esc(x.leagueName || '')}</span><span class="badge res-${cls}">${txt}</span></div>
      <div class="pick-teams">${link ? `<a href="${link}">${esc(x.match)}</a>` : esc(x.match)}</div>
      <div class="pick-main"><span class="pick-label yes">${esc(label)}</span><span class="pick-p">${pct(x.p)}</span><span class="muted small">${esc(marketName(x))} · picked ${esc(when)}</span></div>
      <div class="small ${x.result === 'won' ? 'good' : x.result === 'lost' ? 'bad' : 'muted'}">${esc(explainResult(x))}</div>
      ${x.checks?.length ? `<div class="checks">${x.checks.map((c) => `<span class="chk">✓ ${esc(c)}</span>`).join('')}</div>` : ''}
    </div>`;
  }
  view.innerHTML = `${nav('results')}
    <h2 class="page-title">Results</h2>
    <p class="muted small">Every pick shown on the Markets and Tennis pages is saved on this device the first time it appears, with the chance the model gave it, then checked against the final score once the match is over. Use this page to cross-check the predictions.</p>
    <div class="card section record">
      <h3>Track record${f.sport !== 'all' ? ` · ${f.sport}` : ''}</h3>
      <p>${tot.settled ? `<b>${tot.won} of ${tot.settled}</b> picks correct (<b>${pct(tot.won / tot.settled)}</b>); the model claimed ${pct(tot.sumP / tot.settled)} on average.` : 'No settled picks yet.'}${tot.pending ? ` ${tot.pending} awaiting a result.` : ''}</p>
      ${rows ? `<table class="mk-table res-sum"><thead><tr><th>Market</th><th>Picks</th><th>Won</th><th>Hit rate</th><th>Claimed</th><th>Pending</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="muted small">If the hit rate keeps falling well below the claimed chance, that market's predictions are too confident.</p>` : ''}
      <div class="src-actions">
        <button class="btn" data-resact="check" type="button" ${state.checking ? 'disabled' : ''}>⟳ Check results now</button>
        <button class="btn" data-resact="csv" type="button" ${all.length ? '' : 'disabled'}>Export CSV</button>
        ${all.length ? '<button class="btn" data-resact="clear" type="button">Clear history</button>' : ''}
      </div>
      ${state.checkMsg ? `<p class="small muted">${esc(state.checkMsg)}</p>` : ''}
    </div>
    <div class="chips">${chip('sport', 'all', 'All sports')}${chip('sport', 'football', '⚽ Football')}${chip('sport', 'tennis', '🎾 Tennis')}</div>
    <div class="chips">${chip('status', 'all', 'All')}${chip('status', 'pending', 'Pending')}${chip('status', 'won', 'Won')}${chip('status', 'lost', 'Lost')}${chip('status', 'other', 'Void / no result')}</div>
    ${marketsHere.length > 1 ? `<div class="chips">${chip('market', 'all', 'All markets')}${marketsHere.map((k) => { const [sp, id] = k.split('|'); return chip('market', k, marketName({ sport: sp, market: id })); }).join('')}</div>` : ''}
    ${body || `<div class="empty muted">${all.length ? 'No picks match these filters.' : 'No picks recorded yet. Open <a href="#/markets">Markets</a> or <a href="#/tennis">Tennis</a>: every validated pick shown there is saved here and checked after the match.'}</div>`}
    ${list.length > 300 ? '<p class="muted small">Showing the latest 300. Export CSV for everything.</p>' : ''}
    <p class="disclaimer">Results are fetched from the free ESPN feed. Statistical estimates only — not betting advice.</p>`;
}

// ---- Match view ----
function gauge(p) {
  const r = 52, c = 2 * Math.PI * r;
  const color = p >= 0.55 ? 'var(--accent)' : p >= 0.35 ? 'var(--warn)' : 'var(--muted)';
  return `<div class="gauge"><svg width="120" height="120" viewBox="0 0 120 120">
      <circle cx="60" cy="60" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="12"/>
      <circle cx="60" cy="60" r="${r}" fill="none" stroke="${color}" stroke-width="12" stroke-linecap="round"
        stroke-dasharray="${(c * p).toFixed(1)} ${c.toFixed(1)}"/>
    </svg><div class="val"><b>${pct(p)}</b><span>chance</span></div></div>`;
}

function runner(label, h, a, max = 100, fmt = (v) => v) {
  if (h == null && a == null) return '';
  const hv = h ?? 0, av = a ?? 0;
  const w = (v) => `${Math.min(100, (v / max) * 100).toFixed(0)}%`;
  return `<div class="runner">
    <span class="v">${h == null ? '–' : fmt(h)}</span>
    <div class="mid"><div class="lbl">${esc(label)}</div>
      <div class="track"><div><i style="width:${w(hv)}"></i></div><div><i style="width:${w(av)}"></i></div></div></div>
    <span class="v">${a == null ? '–' : fmt(a)}</span>
  </div>`;
}

function formPills(form) {
  if (!form?.length) return '<span class="muted small">No recent data</span>';
  return `<div class="pills">${form.map((g) => `<span class="res ${esc(g.res)}" title="${esc(`${g.home ? 'vs' : '@'} ${g.opp} ${g.gf}-${g.ga}`)}">${esc(g.res)}</span>`).join('')}</div>`;
}

function lineupList(players) {
  if (!players?.length) return '<p class="muted small">Lineup not announced yet.</p>';
  const sorted = [...players].sort((a, b) => (b.onPitch - a.onPitch) || (b.starter - a.starter));
  return `<ul>${sorted.filter((p) => p.starter || p.subIn).map((p) => `<li class="${p.onPitch ? '' : 'off'}">
      <span class="j">${esc(p.jersey)}</span><span class="p">${esc(p.pos)}</span><span class="n">${esc(p.name)}</span>
      ${p.goals ? `<span title="Goals">⚽${p.goals > 1 ? '×' + p.goals : ''}</span>` : ''}
      ${p.red ? '<span class="red-card"></span>' : ''}
      ${p.subIn ? '<span class="tag">sub</span>' : ''}</li>`).join('')}</ul>`;
}

async function renderMatch(r, background = false) {
  const m = state.matches.find((x) => x.league === r.league && x.id === r.id)
    || state.upcoming.find((x) => x.league === r.league && x.id === r.id);
  if (!m && !state.upcomingAt && !state.usingDemo) {
    // Opened directly (e.g. after a reload) on an upcoming fixture: load the fixture list first.
    view.innerHTML = '<div class="skeleton" style="height:180px"></div>';
    await loadUpcoming();
    if (route().name === 'match' && route().id === r.id) renderMatch(r, background);
    return;
  }
  if (!m) {
    view.innerHTML = state.loading
      ? '<div class="skeleton" style="height:180px"></div>'
      : '<a class="back" href="#/">‹ All matches</a><div class="empty muted">Match not found — it may have left today\'s feed.</div>';
    return;
  }
  if (!background) {
    window.scrollTo(0, 0);
    view.innerHTML = `<a class="back" href="#/">‹ All matches</a>${scoreboard(m)}<div class="skeleton" style="height:200px;margin-top:12px"></div><div class="skeleton" style="height:240px"></div>`;
  }
  let detail = null, err = null;
  try { detail = await getDetail(m); } catch (e) { err = e.message; }
  const cur = route();
  if (cur.name !== 'match' || cur.id !== r.id) return;
  view.innerHTML = matchHTML(m, detail, err);
}

function scoreboard(m) {
  const live = m.state === 'in';
  return `<section class="card scoreboard">
    <div class="meta">${esc(m.leagueName)}${m.venue ? ' · ' + esc(m.venue) : ''}</div>
    <div class="sb-grid">
      <div class="sb-team">${crest(m.home, true)}<span>${esc(m.home.name)}${reds(m.home.redCards)}</span></div>
      <div><div class="sb-score">${m.state === 'pre' ? 'vs' : `${m.home.score}–${m.away.score}`}</div>
        <div class="sb-min ${live ? 'live' : ''}">${live ? '● ' : ''}${esc(m.state === 'pre' ? new Date(m.date).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : m.detail || statusLabel(m))}</div></div>
      <div class="sb-team">${crest(m.away, true)}<span>${esc(m.away.name)}${reds(m.away.redCards)}</span></div>
    </div>
  </section>`;
}

function matchHTML(m, d, err) {
  const p = predict(m, d || {});
  const H = esc(m.home.short), A = esc(m.away.short);
  const live = m.state === 'in';
  const post = m.state === 'post';
  const maxP = Math.max(...p.moreDist);
  const ls = d?.liveStats || {};
  const hasLive = live && (ls.home?.shots != null || ls.home?.possession != null);

  const verdict = post
    ? `<section class="card section"><h3>Result</h3><p>Final score ${m.home.score}–${m.away.score}. Before kick-off the model expected about
        <b>${(p.fullMatch.home + p.fullMatch.away).toFixed(1)}</b> goals (${p.fullMatch.home.toFixed(1)} – ${p.fullMatch.away.toFixed(1)}).</p></section>`
    : `<section class="card section">
      ${live ? `<div class="headline ${p.scopeLevel}">
        <div class="hl-match">${esc(m.home.name)} vs ${esc(m.away.name)} · ${esc(statusLabel(m))} · ${m.home.score}–${m.away.score}</div>
        <div class="hl-text">${p.phase === 'PEN' ? 'The match has gone to penalties. Shoot-out penalties don\'t count as match goals, so no more goals are expected.'
          : `About <b>${moreGoals(p.expectedMore)}</b> expected ${untilEnd(p.phase)}. <b>${pct(p.pMoreGoal)}</b> chance of at least one more goal;
          most likely <b>${p.mostLikelyMore === 0 ? 'no more goals' : `${p.mostLikelyMore} more`}</b>.`}</div>
        ${p.phase === 'PEN' ? '' : `<div class="hl-dist">${p.moreDist.map((v, k) => `<span>${k === 5 ? '5+' : k} more <b>${pct(v)}</b></span>`).slice(0, 4).join('')}<span>4+ more <b>${pct(p.moreDist[4] + p.moreDist[5])}</b></span></div>`}</div>
      </div>` : ''}
      <h3>${live ? 'Will there be another goal before full time?' : 'Will there be goals?'}</h3>
      <div class="verdict">${gauge(p.pMoreGoal)}
        <div><h2>${esc(p.verdict)}</h2>
          <div class="muted">Most likely: <b>${p.mostLikelyMore === 0 ? 'no more goals' : `${p.mostLikelyMore} more goal${p.mostLikelyMore > 1 ? 's' : ''}`}</b>
          <br>Single most likely final score: <b>${p.topScores[0].home}–${p.topScores[0].away}</b></div>
        </div>
      </div>
      <div class="kpis">
        <div class="kpi"><b>${p.expectedMore.toFixed(2)}</b><span>expected ${live ? 'more ' : ''}goals</span></div>
        <div class="kpi"><b>${p.expectedFinalTotal.toFixed(1)}</b><span>expected final total</span></div>
        <div class="kpi"><b>${p.expectedMoreHome.toFixed(2)} · ${p.expectedMoreAway.toFixed(2)}</b><span>${H} · ${A} xG ${live ? 'remaining' : ''}</span></div>
        <div class="kpi"><b>${pct(p.over25)} · ${pct(p.btts)}</b><span>Over 2.5 · both score</span></div>
        ${p.firstHalf.decided ? (p.firstHalf.expected != null ? `<div class="kpi"><b>${p.firstHalf.expected}</b><span>goals in the first half</span></div>` : '')
          : `<div class="kpi"><b>${pct(p.firstHalf.over05)} · ${pct(p.firstHalf.over15)}</b><span>1st half Over 0.5 · Over 1.5 (${p.firstHalf.expected.toFixed(1)} expected)</span></div>`}
      </div>
    </section>
    <section class="card section">
      <h3>How many ${live ? 'more ' : ''}goals?</h3>
      <div class="dist">${p.moreDist.map((v, k) => `<div class="col ${v === maxP ? 'top' : ''}">
        <span class="p">${pct(v)}</span>
        <div class="bar-wrap"><div class="bar" style="height:${Math.max(2, Math.round((v / maxP) * 80))}px"></div></div>
        <span class="muted">${k === 5 ? '5+' : k}</span></div>`).join('')}</div>
      <h3 style="margin-top:14px">Likely final scores</h3>
      <div class="scores">${p.topScores.map((s) => `<span class="score-pill"><b>${s.home}–${s.away}</b>${pct(s.p)}</span>`).join('')}</div>
      <h3 style="margin-top:14px">Result probability</h3>
      <div class="outcome">
        <div class="h" style="flex:${p.outcome.homeWin}">${pct(p.outcome.homeWin)}</div>
        <div class="d" style="flex:${p.outcome.draw}">${pct(p.outcome.draw)}</div>
        <div class="a" style="flex:${p.outcome.awayWin}">${pct(p.outcome.awayWin)}</div>
      </div>
      <div class="legend"><span>${H} win</span><span>Draw</span><span>${A} win</span></div>
    </section>`;

  const rh = p.ratings.home, ra = p.ratings.away;
  const statsRunner = `<section class="card section">
    <h3>Stats runner</h3>
    <div class="runner-head"><span class="home">${H}</span><span></span><span class="away">${A}</span></div>
    ${runner('Attacking power', rh.attack, ra.attack)}
    ${runner('Defensive strength', rh.defense, ra.defense)}
    ${runner('Recent form', rh.form, ra.form)}
    ${d?.table?.home || d?.table?.away ? runner('Goals scored / game', d.table.home && +(d.table.home.gf / d.table.home.gp).toFixed(2), d.table.away && +(d.table.away.gf / d.table.away.gp).toFixed(2), 3.5) : ''}
    ${d?.table?.home || d?.table?.away ? runner('Goals conceded / game', d.table.home && +(d.table.home.ga / d.table.home.gp).toFixed(2), d.table.away && +(d.table.away.ga / d.table.away.gp).toFixed(2), 3.5) : ''}
    ${hasLive ? `<h3 style="margin-top:14px">Live match stats</h3>
      ${runner('Possession %', ls.home.possession, ls.away.possession)}
      ${runner('Shots', ls.home.shots, ls.away.shots, Math.max(ls.home.shots || 0, ls.away.shots || 0, 1))}
      ${runner('Shots on target', ls.home.shotsOnTarget, ls.away.shotsOnTarget, Math.max(ls.home.shotsOnTarget || 0, ls.away.shotsOnTarget || 0, 1))}
      ${runner('Corners', ls.home.corners, ls.away.corners, Math.max(ls.home.corners || 0, ls.away.corners || 0, 1))}` : ''}
    <p class="muted small" style="margin:8px 0 0">Attack/defence: 50 = league average. Form: share of points from last 5.</p>
  </section>`;

  const form = `<section class="card section"><h3>Recent form (last 5)</h3>
    <div class="form-row"><span class="nm">${H}</span>${formPills(d?.form?.home)}</div>
    <div class="form-row"><span class="nm">${A}</span>${formPills(d?.form?.away)}</div>
  </section>`;

  const h = p.h2h;
  const h2hList = (d?.h2h || []).slice(0, 6).map((g) => {
    const homeName = g.homeId === m.home.id ? m.home.short : g.homeId === m.away.id ? m.away.short : '';
    const awayName = g.homeId === m.home.id ? m.away.short : m.home.short;
    return `<div><span>${esc(homeName)} ${g.hs}–${g.as} ${esc(awayName)}</span><span class="muted">${esc((g.date || '').slice(0, 10))}</span></div>`;
  }).join('');
  const h2hSec = `<section class="card section"><h3>Head to head</h3>
    ${h.n ? `<div class="h2h-summary">
      <div><b>${h.homeWins}</b><span>${H} wins</span></div>
      <div><b>${h.draws}</b><span>Draws</span></div>
      <div><b>${h.awayWins}</b><span>${A} wins</span></div></div>
      <p class="muted small">${h.avgGoals.toFixed(1)} goals per game · both scored in ${h.btts}/${h.n}</p>
      <div class="h2h-list">${h2hList}</div>` : '<p class="muted small">No recent meetings found.</p>'}
  </section>`;

  const lineups = `<section class="card section"><h3>${live ? 'Players on the pitch' : 'Lineups'}</h3>
    <div class="lineups"><div><h4>${H}</h4>${lineupList(d?.lineups?.home)}</div><div><h4>${A}</h4>${lineupList(d?.lineups?.away)}</div></div>
  </section>`;

  const sign = (v) => (Math.abs(v) < 0.005 ? '±0.00' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`);
  const conf = p.confidence;
  const how = `<section class="card section why-sec"><h3>Why this prediction</h3>
    <div class="conf conf-${conf.level.toLowerCase()}"><b>${conf.level} confidence</b>
      <span>Based on ${esc(conf.have.join(', ') || 'the score and clock only')}.${conf.missing.length ? ` Missing: ${esc(conf.missing.join(', '))}.` : ''}</span></div>
    <ol class="steps">${p.reasons.map((r, i) => `<li class="step ${r.impact}">
      <div class="step-head"><span class="step-n">${i + 1}</span><b>${esc(r.title)}</b>
        <span class="delta">${i === 0 ? r.delta.toFixed(2) : sign(r.delta)}</span></div>
      <p>${esc(r.detail)}</p>
      ${r.evidence?.length ? `<details><summary>Evidence</summary><ul>${r.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></details>` : ''}
    </li>`).join('')}
    <li class="step total"><div class="step-head"><span class="step-n">=</span><b>${post ? 'Match finished' : `${p.expectedMore.toFixed(2)} expected ${live ? 'more ' : ''}goals`}</b></div>
      <p>${post ? 'No more goals possible.' : `Goals arrive close to randomly at that rate, so the chance of at least one is 1 − e<sup>−${p.expectedMore.toFixed(2)}</sup> = <b>${pct(p.pMoreGoal)}</b>. The same rate gives the 0/1/2/3+ goal probabilities above.`}</p></li>
    </ol>
    <p class="muted small">Column on the right: how many expected goals each step adds (+) or removes (−).</p>
  </section>`;

  return `<a class="back" href="#/">‹ All matches</a>
    ${scoreboard(m)}
    ${err ? `<div class="banner" style="margin-top:12px">Detailed stats unavailable (${esc(err)}). Showing an estimate from the score and clock only.</div>` : ''}
    ${verdict}${marketsPanel(m, d)}${how}${statsRunner}${form}${h2hSec}${lineups}
    <p class="disclaimer">Statistical estimate only — not betting advice.</p>`;
}

// ---- Data sources page ----
function renderSources() {
  view.innerHTML = `<a class="back" href="#/">‹ All matches</a>
    <h2 class="page-title">Data sources</h2>
    <p class="muted small">The app scans every source that's switched on and merges the results, so a match covered by two
      sources appears once. ESPN is free and always on. To add another source, paste its API key and tap <b>Test</b>;
      it joins the scan straight away.</p>
    <div class="banner small">🔒 Keys are saved only in this browser on this device. They are never put in the code or on GitHub.
      Anyone using this phone's browser could see them, so don't share the device.</div>
    ${SOURCES.map((s) => {
      const key = keyFor(s.id);
      const on = !s.needsKey || (key && scanOn(s.id));
      const status = !s.needsKey ? '<span class="badge on">Always on</span>'
        : on ? '<span class="badge on">Scanning</span>' : key ? '<span class="badge ready">Off</span>' : '<span class="badge off">Needs key</span>';
      const quota = s.id === 'apifootball' && key ? `<p class="small quota">Free requests left today: <b>${afQuota.remaining}/${afQuota.limit}</b> (resets 00:00 UTC)</p>` : '';
      const espnInfo = s.id === 'espn' ? `<p class="small quota">${espnScan.leagues} competitions in the scan list${espnScan.active ? ` · ${espnScan.active} with matches today` : ''}</p>` : '';
      return `<section class="card section src" data-src="${s.id}">
        <div class="src-head"><h3>${esc(s.name)}</h3>${status}</div>
        <div class="src-cost">${esc(s.cost)}</div>
        <ul class="feat">${s.provides.map((f) => `<li class="yes">${esc(f)}</li>`).join('')}${(s.lacks || []).map((f) => `<li class="no">${esc(f)}</li>`).join('')}</ul>
        ${quota}${espnInfo}
        <p class="muted small">${esc(s.note)}${s.signup ? ` <a href="${esc(s.signup)}" target="_blank" rel="noopener">Get a key ↗</a>` : ''}</p>
        ${s.needsKey ? `<div class="key-row">
            <input type="password" class="key-input" placeholder="Paste API key" value="${esc(key)}" autocomplete="off" spellcheck="false" aria-label="${esc(s.name)} API key">
            <button class="btn small-btn" data-act="show" type="button">Show</button>
          </div>
          <div class="src-actions">
            <button class="btn" data-act="save" type="button">Save</button>
            <button class="btn" data-act="test" type="button">Test</button>
            ${key ? '<button class="btn" data-act="remove" type="button">Remove</button>' : ''}
          </div>` : ''}
        ${s.needsKey && key ? `<label class="scan-toggle"><input type="checkbox" data-act="scan" ${scanOn(s.id) ? 'checked' : ''}> Include in the match scan</label>` : ''}
        <p class="test-result small" aria-live="polite"></p>
      </section>`;
    }).join('')}
    <p class="muted small">Not supported yet: TheStatsAPI. Ask and it can be added the same way.</p>`;
}

view.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  const card = b?.closest('[data-src]');
  if (!card) return;
  const id = card.dataset.src;
  const input = card.querySelector('.key-input');
  const out = card.querySelector('.test-result');
  const act = b.dataset.act;
  if (act === 'show') { input.type = input.type === 'password' ? 'text' : 'password'; b.textContent = input.type === 'password' ? 'Show' : 'Hide'; return; }
  if (act === 'save') { store.set('key:' + id, input.value.trim()); onSourceChange(); renderSources(); flash(id, input.value.trim() ? 'Key saved and added to the scan.' : 'Key cleared.'); return; }
  if (act === 'remove') {
    store.set('key:' + id, '');
    onSourceChange(); renderSources(); flash(id, 'Key removed. This source has left the scan.'); return;
  }
  if (act === 'scan') {
    store.set('scan:' + id, b.checked); onSourceChange(); renderSources();
    flash(id, b.checked ? 'Included in the scan.' : 'Left out of the scan.'); return;
  }
  if (act === 'test') {
    const key = input.value.trim();
    if (!key) { out.textContent = 'Paste a key first.'; out.className = 'test-result small bad'; return; }
    out.textContent = 'Testing…'; out.className = 'test-result small';
    try {
      const msg = await sourceById(id).adapter.test({ key, proxy: settings.proxy });
      store.set('key:' + id, key);
      onSourceChange(); renderSources(); flash(id, `✓ ${msg}. Key saved and added to the scan.`);
    } catch (err) {
      out.textContent = `✗ ${err.message === 'Failed to fetch' ? 'Could not reach the service from this browser. Try setting the CORS proxy in ⚙ Settings.' : err.message}`;
      out.className = 'test-result small bad';
    }
  }
});
function flash(id, msg) {
  const out = view.querySelector(`[data-src="${id}"] .test-result`);
  if (out) { out.textContent = msg; out.className = 'test-result small good'; }
}
function onSourceChange() {
  state.league = 'all';
  loadMatches();
}

// ---- Refresh loop ----
let timer = null;
async function refresh(full = true, force = false) {
  await loadMatches(force);
  const r = route();
  if (r.name === 'list') { renderList(); warm(); }
  else if (r.name === 'markets') { renderMarkets(); warm(); loadUpcoming(); }
  else if (r.name === 'tennis') { loadTennis(); renderTennis(); }
  else if (r.name === 'results') { renderResults(); checkResults(); }
  else if (r.name === 'match') renderMatch(r, !full);
}
function schedule() {
  clearInterval(timer);
  if (settings.refresh > 0) timer = setInterval(() => { if (!document.hidden) refresh(false); }, settings.refresh * 1000);
}

$('#refresh').addEventListener('click', () => { state.details.clear(); state.tennisAt = 0; refresh(false, true); });
window.addEventListener('hashchange', render);
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.updated && Date.now() - state.updated > 20_000) refresh(false); });

// Settings dialog
const dlg = $('#settings');
$('#settings-btn').addEventListener('click', () => {
  $('#opt-demo').checked = settings.demo;
  $('#opt-proxy').value = settings.proxy;
  $('#opt-refresh').value = String(settings.refresh);
  $('#opt-showall').checked = settings.showAll;
  dlg.showModal();
});
$('#sources-link').addEventListener('click', () => dlg.close());
dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'save') return;
  settings.demo = $('#opt-demo').checked;
  settings.proxy = $('#opt-proxy').value.trim();
  settings.refresh = parseInt($('#opt-refresh').value, 10);
  settings.showAll = $('#opt-showall').checked;
  store.set('showall', settings.showAll);
  store.set('demo', settings.demo); store.set('proxy', settings.proxy); store.set('refresh', settings.refresh);
  state.details.clear();
  state.matches = [];
  state.tennis = []; state.tennisAt = 0; state.tennisDemo = false;
  schedule();
  refresh();
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

render();
refresh();
schedule();
