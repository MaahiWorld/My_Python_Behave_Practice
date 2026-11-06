import { fetchMatches, fetchDetail } from './api.js';
import { demoMatches, demoDetail } from './demo.js';
import { predict } from './model.js';

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
};

// ---- State ----
const state = {
  matches: [],
  tab: store.get('tab', 'live'),
  league: 'all',
  details: new Map(), // key -> { detail, at }
  error: null,
  usingDemo: settings.demo,
  loading: false,
  updated: null,
};
const keyOf = (m) => `${m.league}/${m.id}`;

// ---- Data ----
async function loadMatches() {
  state.loading = true;
  $('#refresh').classList.add('spin');
  try {
    if (settings.demo) {
      state.matches = demoMatches();
      state.usingDemo = true;
    } else {
      state.matches = await fetchMatches({ proxy: settings.proxy });
      state.usingDemo = false;
    }
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

async function getDetail(m, force = false) {
  const k = keyOf(m);
  const hit = state.details.get(k);
  const ttl = m.state === 'in' ? 25_000 : 600_000;
  if (!force && hit && Date.now() - hit.at < ttl) return hit.detail;
  const detail = m.league === 'demo' ? demoDetail(m) : await fetchDetail(m, { proxy: settings.proxy });
  state.details.set(k, { detail, at: Date.now() });
  return detail;
}

// Pre-load analysis for live matches so the list shows real goal chances.
async function warmLive() {
  const live = state.matches.filter((m) => m.state === 'in');
  const queue = [...live];
  const worker = async () => {
    while (queue.length) {
      const m = queue.shift();
      try { await getDetail(m); } catch { /* keep the quick estimate */ }
      if (route().name === 'list') patchCard(m);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

// ---- Routing ----
function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const m = h.match(/^m\/([^/]+)\/(.+)$/);
  return m ? { name: 'match', league: decodeURIComponent(m[1]), id: decodeURIComponent(m[2]) } : { name: 'list' };
}

function render() {
  const r = route();
  if (r.name === 'match') renderMatch(r);
  else renderList();
}

// ---- Shared bits ----
function crest(team, lg = false) {
  const cls = `crest${lg ? ' lg' : ''}`;
  if (team.logo) return `<img class="${cls}" src="${esc(team.logo)}" alt="" loading="lazy">`;
  return `<span class="${cls}" style="background:${esc(team.color || '#64748b')}">${esc(team.abbr)}</span>`;
}
function statusLabel(m) {
  if (m.state === 'in') return m.detail === 'HT' ? 'HT' : `${m.minute}'`;
  if (m.state === 'post') return 'FT';
  return new Date(m.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
const reds = (n) => '<span class="red-card" title="Red card"></span>'.repeat(n || 0);

// ---- List view ----
function counts() {
  const c = { live: 0, upcoming: 0, finished: 0 };
  for (const m of state.matches) c[m.state === 'in' ? 'live' : m.state === 'pre' ? 'upcoming' : 'finished']++;
  return c;
}
function filtered() {
  const want = { live: 'in', upcoming: 'pre', finished: 'post' }[state.tab];
  return state.matches
    .filter((m) => m.state === want && (state.league === 'all' || m.league === state.league))
    .sort((a, b) => a.leagueName.localeCompare(b.leagueName) || new Date(a.date) - new Date(b.date));
}

function cardChance(m) {
  const hit = state.details.get(keyOf(m));
  const p = predict(m, hit?.detail);
  if (m.state === 'post') return `<div class="chance"><div class="lbl">${m.home.score + m.away.score} goals</div></div>`;
  return `<div class="chance">
    <div class="pct">${pct(p.pMoreGoal)}</div>
    <div class="lbl">${m.state === 'in' ? 'another goal' : 'any goal'}${hit ? '' : ' ~'}</div>
    <div class="mini-bar"><i style="width:${pct(p.pMoreGoal)}"></i></div>
  </div>`;
}

function whyLine(m) {
  const hit = state.details.get(keyOf(m));
  if (!hit || m.state === 'post') return '';
  const p = predict(m, hit.detail);
  return p.summary.length ? `<div class="why">Why: ${esc(p.summary.join(' · '))}</div>` : '';
}

function matchCard(m) {
  return `<a class="card match" href="#/m/${encodeURIComponent(m.league)}/${encodeURIComponent(m.id)}" data-key="${esc(keyOf(m))}">
    <div class="status ${m.state === 'in' ? 'live' : ''}">${esc(statusLabel(m))}</div>
    <div class="teams">
      <div class="team-line">${crest(m.home)}<span class="nm">${esc(m.home.short)}${reds(m.home.redCards)}</span><span class="sc">${m.state === 'pre' ? '' : m.home.score}</span></div>
      <div class="team-line">${crest(m.away)}<span class="nm">${esc(m.away.short)}${reds(m.away.redCards)}</span><span class="sc">${m.state === 'pre' ? '' : m.away.score}</span></div>
    </div>
    ${cardChance(m)}
    ${whyLine(m)}
  </a>`;
}

function patchCard(m) {
  const el = view.querySelector(`[data-key="${CSS.escape(keyOf(m))}"]`);
  if (el) el.outerHTML = matchCard(m);
}

function renderList() {
  const c = counts();
  const list = filtered();
  const leagues = [...new Map(state.matches.map((m) => [m.league, m.leagueName])).entries()];
  const tabs = [['live', 'Live'], ['upcoming', 'Upcoming'], ['finished', 'Finished']];
  let body = '';
  if (state.loading && !state.matches.length) body = '<div class="skeleton"></div>'.repeat(5);
  else if (!list.length) {
    body = `<div class="empty muted">${state.tab === 'live' ? 'No matches are live right now in the tracked leagues.' : 'Nothing here right now.'}
      ${state.tab === 'live' && c.upcoming ? '<p><button class="btn" data-tab="upcoming">See upcoming matches</button></p>' : ''}</div>`;
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
  view.innerHTML = `${banner}
    <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button class="tab" role="tab" data-tab="${k}" aria-selected="${state.tab === k}">${l}<span class="count">${c[k]}</span></button>`).join('')}</div>
    ${leagues.length > 1 ? `<div class="chips">${[['all', 'All leagues'], ...leagues].map(([k, l]) => `<button class="chip" data-league="${esc(k)}" aria-pressed="${state.league === k}">${esc(l)}</button>`).join('')}</div>` : ''}
    ${body}
    <p class="disclaimer">Goal chances are model estimates · ~ = quick estimate before full stats load</p>`;
}

view.addEventListener('click', (e) => {
  const t = e.target.closest('[data-tab]');
  if (t) { state.tab = t.dataset.tab; store.set('tab', state.tab); renderList(); return; }
  const l = e.target.closest('[data-league]');
  if (l) { state.league = l.dataset.league; renderList(); }
});

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
      <h3>${live ? 'Will there be another goal?' : 'Will there be goals?'}</h3>
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

// ---- Refresh loop ----
let timer = null;
async function refresh(full = true) {
  await loadMatches();
  const r = route();
  if (r.name === 'list') { renderList(); warmLive(); }
  else renderMatch(r, !full);
}
function schedule() {
  clearInterval(timer);
  if (settings.refresh > 0) timer = setInterval(() => { if (!document.hidden) refresh(false); }, settings.refresh * 1000);
}

$('#refresh').addEventListener('click', () => { state.details.clear(); refresh(false); });
window.addEventListener('hashchange', render);
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.updated && Date.now() - state.updated > 20_000) refresh(false); });

// Settings dialog
const dlg = $('#settings');
$('#settings-btn').addEventListener('click', () => {
  $('#opt-demo').checked = settings.demo;
  $('#opt-proxy').value = settings.proxy;
  $('#opt-refresh').value = String(settings.refresh);
  dlg.showModal();
});
dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'save') return;
  settings.demo = $('#opt-demo').checked;
  settings.proxy = $('#opt-proxy').value.trim();
  settings.refresh = parseInt($('#opt-refresh').value, 10);
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
