import { SOURCES, sourceById, afQuota } from './sources.js';
import { scanStats as espnScan } from './api.js';
import { demoMatches, demoDetail } from './demo.js';
import { predict, phaseOf } from './model.js';
import { mergeMatches } from './merge.js';
import { MARKETS, RULES, marketPicks, evaluateMarkets, recordPicks, settlePicks, trackRecord } from './markets.js';

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
  market: store.get('market', 'o25'),
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

async function getDetail(m, { force = false, ttl } = {}) {
  const k = keyOf(m);
  const hit = state.details.get(k);
  const maxAge = ttl ?? (m.state === 'in' ? 25_000 : 600_000);
  if (!force && hit && Date.now() - hit.at < maxAge) return hit.detail;
  const src = sourceById(m.source);
  const detail = m.league === 'demo' ? demoDetail(m) : await src.adapter.fetchDetail(m, { proxy: settings.proxy, key: keyFor(src.id) });
  state.details.set(k, { detail, at: Date.now() });
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
  }, 700);
}
const warmable = (m) => (m.league === 'demo' || !sourceById(m.source).needsKey)
  && (m.state === 'in' || (m.state === 'pre' && new Date(m.date) - Date.now() < 12 * 3_600_000));
const detailErrors = new Map(); // match key -> error message from the last failed analysis
async function warm() {
  if (warming) return;
  warming = true;
  const queue = state.matches.filter(warmable)
    .sort((a, b) => (a.state === 'in' ? 0 : 1) - (b.state === 'in' ? 0 : 1) || new Date(a.date) - new Date(b.date));
  const worker = async () => {
    while (queue.length) {
      const m = queue.shift();
      try { await getDetail(m, { ttl: m.state === 'in' ? 60_000 : 1_800_000 }); detailErrors.delete(keyOf(m)); } catch (e) { detailErrors.set(keyOf(m), e.message || String(e)); }
      rerenderSoon();
    }
  };
  try { await Promise.all([worker(), worker(), worker(), worker()]); } finally { warming = false; }
  rerenderSoon();
}

// ---- Routing ----
function route() {
  const h = location.hash.replace(/^#\/?/, '');
  if (h === 'sources') return { name: 'sources' };
  if (h === 'markets') return { name: 'markets' };
  const m = h.match(/^m\/([^/]+)\/(.+)$/);
  return m ? { name: 'match', league: decodeURIComponent(m[1]), id: decodeURIComponent(m[2]) } : { name: 'list' };
}

function render() {
  const r = route();
  if (r.name === 'match') renderMatch(r);
  else if (r.name === 'sources') renderSources();
  else if (r.name === 'markets') { renderMarkets(); warm(); }
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
  return new Date(m.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
  const mt = e.target.closest('[data-market]');
  if (mt) { state.market = mt.dataset.market; store.set('market', state.market); renderMarkets(); return; }
  const so = e.target.closest('[data-sort]');
  if (so) { state.sort = so.dataset.sort; store.set('sort', state.sort); renderList(); }
});

function nav(current) {
  return `<nav class="nav"><a href="#/" ${current === 'list' ? 'aria-current="page"' : ''}>Matches</a><a href="#/markets" ${current === 'markets' ? 'aria-current="page"' : ''}>Goal markets</a></nav>`;
}

// ---- Goal markets page ----
// Backtest figures (unseen seasons) from backtest/results.json, shown next to the on-device record.
let backtest = null;
fetch('backtest/results.json').then((r) => (r.ok ? r.json() : null)).then((j) => { backtest = j; if (route().name === 'markets') renderMarkets(); }).catch(() => {});
function backtestLine(id) {
  const t = backtest?.test;
  if (!t) return '';
  const m = t.picks.byMarket[id];
  const base = t.highConfidenceMarkets[id];
  const txt = m.picks
    ? `<b>${Math.round(m.hitRate)} of 100</b> correct (${m.won.toLocaleString()} of ${m.picks.toLocaleString()} picks)${id === 'o15' ? `; Over 1.5 happens ${Math.round(base.baseline)} in 100 anyway` : ''}`
    : `no pick reached the confidence bar in ${t.data.matches.toLocaleString()} matches, so expect this tab to be empty most of the time`;
  return `<p class="small">Backtest on ${t.data.seasons} (${t.data.matches.toLocaleString()} past matches the model wasn't tuned on): ${txt}. <a href="https://github.com/MaahiWorld/My_Python_Behave_Practice/blob/main/backtest/RESULTS.md" target="_blank" rel="noopener">Details</a></p>`;
}
function renderMarkets() {
  const mk = MARKETS.find((x) => x.id === state.market) || MARKETS[1];
  const all = [];
  for (const m of state.matches) {
    const hit = state.details.get(keyOf(m));
    if (!hit || (m.state !== 'in' && m.state !== 'pre')) continue;
    const picks = marketPicks(m, hit.detail);
    recordPicks(m, picks);
    for (const pk of picks) all.push({ m, pk });
  }
  const counts = Object.fromEntries(MARKETS.map((x) => [x.id, all.filter((a) => a.pk.market.id === x.id).length]));
  const list = all.filter((a) => a.pk.market.id === mk.id).sort((a, b) => b.pk.p - a.pk.p);
  const pending = state.matches.filter((m) => warmable(m) && !state.details.has(keyOf(m)) && !detailErrors.has(keyOf(m))).length;
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
    <div class="tabs" role="tablist">${MARKETS.map((x) => `<button class="tab" role="tab" data-market="${x.id}" aria-selected="${x.id === mk.id}">${x.id === 'btts' ? 'BTTS' : x.yes}<span class="count">${counts[x.id]}</span></button>`).join('')}</div>
    <div class="card section record"><h3>${esc(mk.name)} · track record</h3><p class="small">On this device: ${record}</p>${backtestLine(mk.id)}</div>
    <details class="howto"><summary>How picks are validated</summary>
      <ol>
        <li>The match prediction must be <b>high confidence</b>: season attack/defence records and recent form for both teams, plus current match stats when live.</li>
        <li>The model must give the pick at least <b>${Math.round(RULES.minProb * 100)}%</b>.</li>
        <li>Independent cross-checks must all agree (at least ${Math.round(RULES.minCheck * 100)}%): the season record alone, recent form alone, the prediction without live match stats, and head-to-head history (4+ meetings, before kick-off). At least two checks are required.</li>
        <li>Markets already decided (e.g. Over 1.5 with two goals in) are left out.</li>
      </ol>
      <p class="muted small">Covers live matches and those starting within 12 hours on free data. Statistical estimates, not betting advice.</p>
    </details>
    ${list.length ? list.map(card).join('') : `<div class="empty muted">No validated ${esc(mk.name)} picks right now.${pending ? `<br>Analysing ${pending} match${pending > 1 ? 'es' : ''}…` : ''}</div>`}
    ${whyNoPicks(mk)}
    <p class="disclaimer">Statistical estimates only — not betting advice.</p>`;
}

// Explains, for the chosen market, why each candidate match did or didn't produce a pick.
function whyNoPicks(mk) {
  const cands = state.matches.filter((m) => m.state === 'in' || (m.state === 'pre' && new Date(m.date) - Date.now() < 12 * 3_600_000));
  if (!cands.length) {
    return `<div class="card section diag"><h3>Why no picks?</h3><p>No matches are live or kicking off in the next 12 hours in the ${state.usingDemo ? 'demo data' : 'competitions scanned'}. Check back closer to match time.</p></div>`;
  }
  const c = { pending: 0, failed: 0, keyed: 0, thin: 0, missing: {}, lowProb: 0, checkFailed: 0, decided: 0, fewChecks: 0, picks: 0 };
  const near = [];
  for (const m of cands) {
    const k = keyOf(m);
    const hit = state.details.get(k);
    if (!hit) {
      if (detailErrors.has(k)) c.failed++;
      else if (!warmable(m)) c.keyed++;
      else c.pending++;
      continue;
    }
    const e = evaluateMarkets(m, hit.detail).find((x) => x.market.id === mk.id);
    switch (e.status) {
      case 'pick': c.picks++; break;
      case 'decided': c.decided++; break;
      case 'low-confidence': c.thin++; for (const x of e.missing) c.missing[x] = (c.missing[x] || 0) + 1; break;
      case 'low-prob': c.lowProb++; near.push({ m, e, gap: RULES.minProb - e.p, why: `${pct(e.p)} (needs ${pct(RULES.minProb)})` }); break;
      case 'few-checks': c.fewChecks++; break;
      case 'check-failed': c.checkFailed++; near.push({ m, e, gap: Math.max(...e.failed.map((f) => RULES.minCheck - f.p)), why: `${pct(e.p)}, but ${e.failed.map((f) => `${f.label.toLowerCase()} ${f.txt}`).join(', ')} (checks need ${pct(RULES.minCheck)})` }); break;
      default: break;
    }
  }
  const rows = [
    [c.picks, 'gave a validated pick'],
    [c.lowProb, `rated below ${pct(RULES.minProb)} for ${mk.name}`],
    [c.checkFailed, 'reached the bar, but a cross-check disagreed'],
    [c.fewChecks, 'had too few independent checks'],
    [c.decided, 'already decided on the scoreboard'],
    [c.thin, 'not enough data for a high-confidence prediction'],
    [c.pending, 'still being analysed'],
    [c.failed, 'couldn\'t load their stats'],
    [c.keyed, 'from API-Football (only analysed when opened, to save the free requests)'],
  ].filter(([n]) => n);
  const missing = Object.entries(c.missing).sort((a, b) => b[1] - a[1]);
  near.sort((a, b) => a.gap - b.gap);
  return `<div class="card section diag"><h3>Why ${c.picks ? 'only these' : 'no'} picks?</h3>
    <p class="small">Checked <b>${cands.length}</b> match${cands.length > 1 ? 'es' : ''} (live, or kicking off in the next 12 hours):</p>
    <ul class="diag-list">${rows.map(([n, t]) => `<li><b>${n}</b> ${t}</li>`).join('')}</ul>
    ${missing.length ? `<p class="small muted">Missing data: ${missing.map(([t, n]) => `${esc(t)} (${n})`).join('; ')}.</p>` : ''}
    ${near.length ? `<h3 style="margin-top:12px">Closest to a pick</h3><ul class="near">${near.slice(0, 5).map(({ m, e, why }) => `<li><a href="#/m/${encodeURIComponent(m.league)}/${encodeURIComponent(m.id)}">${esc(m.home.short)} vs ${esc(m.away.short)}</a> <span class="muted">· ${esc(statusLabel(m))}</span><br><b>${esc(e.label)}</b> ${esc(why)}</li>`).join('')}</ul>` : ''}
    <p class="small muted">The bar is high on purpose: in the backtest about 1 match in 5 gave a pick, almost all Over 1.5.</p>
  </div>`;
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
  const m = state.matches.find((x) => x.league === r.league && x.id === r.id);
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
    ${verdict}${how}${statsRunner}${form}${h2hSec}${lineups}
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
  else if (r.name === 'markets') { renderMarkets(); warm(); }
  else if (r.name === 'match') renderMatch(r, !full);
}
function schedule() {
  clearInterval(timer);
  if (settings.refresh > 0) timer = setInterval(() => { if (!document.hidden) refresh(false); }, settings.refresh * 1000);
}

$('#refresh').addEventListener('click', () => { state.details.clear(); refresh(false, true); });
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
  schedule();
  refresh();
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

render();
refresh();
schedule();
