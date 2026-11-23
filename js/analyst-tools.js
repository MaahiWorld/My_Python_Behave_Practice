// Match Analyst agent: the tools Claude can call, the answer format it must return, and the checks
// its answer must pass. The rules themselves are written for the agent in skills/match-analyst/SKILL.md;
// LIMITS below are the same numbers, enforced in code.
// Everything here is plain data and functions, so it runs in tests without a browser or an API key.
import { predict, poisson, PARAMS } from './model.js';
import { normName } from './merge.js';
import { LEAGUES } from './api.js';

export const LIMITS = {
  maxMatches: 5, // matches analysed per request
  resultShift: 0.05, // a result chance may move at most 5 percentage points from the model
  marketShift: 0.05, // a goals market chance may move at most 5 points from the model
  totalShift: 0.3, // expected total goals may move at most 0.3 from the model
  halvesTolerance: 0.1, // first + second half expected goals = expected total, within 0.1
  sumTolerance: 0.01, // home + draw + away = 1, within 1 point
};

const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const r3 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000);
export const matchId = (m) => `${m.league}/${m.id}`;
const STATUS = { pre: 'not started', in: 'in play', post: 'finished' };

// ---- Finding matches from free text ----
const ALIASES = {
  epl: 'eng.1', 'premier league': 'eng.1', 'english premier league': 'eng.1', 'la liga': 'esp.1', laliga: 'esp.1',
  'serie a': 'ita.1', bundesliga: 'ger.1', 'ligue 1': 'fra.1', ucl: 'uefa.champions', 'champions league': 'uefa.champions',
  uel: 'uefa.europa', 'europa league': 'uefa.europa', uecl: 'uefa.europa.conf', 'conference league': 'uefa.europa.conf',
  mls: 'usa.1', 'liga mx': 'mex.1', eredivisie: 'ned.1', 'primeira liga': 'por.1', championship: 'eng.2',
  'nations league': 'uefa.nations', 'saudi pro league': 'ksa.1', 'world cup': 'fifa.world',
};
const NAMED_LEAGUES = LEAGUES.filter(([, n]) => n);
// "Arsenal vs Chelsea", "Inter v Milan", "PSG - Lyon", "Real Madrid x Barcelona" -> two team terms.
export function parseQuery(q) {
  const text = String(q || '').trim();
  const parts = text.split(/\s+(?:vs\.?|v\.?|versus|x|-|–|—|@|against)\s+/i).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 2) return { type: 'fixture', teams: parts, text };
  return { type: 'text', text };
}
// "Man City" ~ "Manchester City", "Inter" ~ "Internazionale"; a 3-letter code only matches exactly.
export function teamMatches(term, team) {
  const x = normName(term);
  if (!x) return false;
  if (team.abbr && x === normName(team.abbr)) return true;
  return [team.name, team.short].filter(Boolean).map(normName).filter(Boolean)
    .some((y) => x === y || (x.length >= 3 && y.includes(x)) || (y.length >= 5 && x.includes(y)) || initialsMatch(term, y));
}
// "Man City" -> "manchestercity": every word of the term starts the next part of the name.
function initialsMatch(term, y) {
  const words = String(term).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length < 2) return false;
  let i = 0;
  for (const w of words) { const j = y.indexOf(w, i); if (j < 0 || (i && j - i > 12)) return false; i = j + w.length; }
  return true;
}
export function leagueSlugs(text) {
  const t = String(text || '').toLowerCase().trim();
  const out = new Set();
  if (ALIASES[t]) out.add(ALIASES[t]);
  const n = normName(t);
  for (const [slug, name] of NAMED_LEAGUES) if (n.length >= 3 && (normName(name) === n || normName(name).includes(n))) out.add(slug);
  if (LEAGUES.some(([s]) => s === t)) out.add(t);
  return [...out];
}
const byKickoff = (a, b) => (a.state === 'post') - (b.state === 'post') || new Date(a.date) - new Date(b.date);
export function findMatches(query, pool) {
  const q = parseQuery(query);
  const seen = new Set();
  const all = pool.filter((m) => (seen.has(matchId(m)) ? false : seen.add(matchId(m))));
  let found = [], type;
  if (q.type === 'fixture') {
    type = 'fixture';
    const [a, b] = q.teams;
    found = all.filter((m) => (teamMatches(a, m.home) && teamMatches(b, m.away)) || (teamMatches(a, m.away) && teamMatches(b, m.home)));
  }
  if (!found.length) {
    const slugs = leagueSlugs(q.text);
    if (slugs.length) {
      type = 'league';
      found = all.filter((m) => slugs.includes(m.league));
    } else {
      // A league name we don't know by alias, or a single team name.
      const byName = all.filter((m) => normName(m.leagueName) && normName(m.leagueName).includes(normName(q.text)) && normName(q.text).length >= 4);
      const byTeam = q.type === 'fixture' ? [] : all.filter((m) => teamMatches(q.text, m.home) || teamMatches(q.text, m.away));
      type = byName.length ? 'league' : byTeam.length ? 'team' : type || 'none';
      found = byName.length ? byName : byTeam;
      if (!found.length && q.type === 'fixture') {
        // Show each team's fixtures so the user can pick.
        found = all.filter((m) => q.teams.some((t) => teamMatches(t, m.home) || teamMatches(t, m.away)));
        type = found.length ? 'partial' : 'none';
      }
    }
  }
  found.sort(byKickoff);
  return {
    query_type: type,
    matches: found.slice(0, 12).map((m) => ({
      match_id: matchId(m),
      fixture: `${m.home.name} vs ${m.away.name}`,
      competition: m.leagueName,
      kickoff: m.date,
      status: STATUS[m.state] || m.state,
      ...(m.state !== 'pre' ? { score: `${m.home.score}-${m.away.score}`, minute: m.state === 'in' ? m.minute : undefined } : {}),
    })),
    total_found: found.length,
    note: !found.length ? 'No fixture in the feed (today and the next 7 days in the main competitions) matches this text.'
      : type === 'partial' ? 'No fixture between both teams was found; these involve one of them.' : undefined,
  };
}

// ---- Match data ----
const lastFive = (form) => (form || []).slice(0, 5).map((g) => ({
  date: g.date ? String(g.date).slice(0, 10) : null, opponent: g.opp || null, venue: g.home ? 'H' : 'A', score: `${g.gf}-${g.ga}`, result: g.res,
}));
function teamBlock(match, detail, pred, side) {
  const t = match[side];
  const table = detail.table?.[side];
  const form = (detail.form?.[side] || []).slice(0, 5);
  const st = pred.strength[side], rt = pred.ratings[side];
  const pts = form.reduce((s, g) => s + (g.res === 'W' ? 3 : g.res === 'D' ? 1 : 0), 0);
  return {
    name: t.name, plays_at: side,
    last_5: lastFive(form),
    form: form.map((g) => g.res).join('') || null,
    form_points: form.length ? `${pts}/${form.length * 3}` : null,
    last_5_goals_for: form.length ? form.reduce((s, g) => s + g.gf, 0) : null,
    last_5_goals_against: form.length ? form.reduce((s, g) => s + g.ga, 0) : null,
    season: table?.gp ? {
      record_from: table.league === 'international' ? 'international matches, last 12 months' : table.league ? `${table.league} table` : 'this competition',
      games: table.gp, goals_for: table.gf, goals_against: table.ga, goal_difference: table.gf - table.ga,
      goals_for_per_game: r2(table.gf / table.gp), goals_against_per_game: r2(table.ga / table.gp),
      points: table.pts ?? null, points_per_game: table.pts != null ? r2(table.pts / table.gp) : null, table_position: table.rank ?? null,
    } : null,
    attack_strength_vs_average: r2(st.att), // 1.00 = league average; 1.20 = scores 20% more
    defence_conceding_vs_average: r2(st.def), // 1.00 = average; below 1 = concedes less (better)
    attack_rating_0_100: rt.attack, defence_rating_0_100: rt.defense, form_rating_0_100: rt.form,
    strength_based_on: st.source,
  };
}
export function matchData(match, detail) {
  const pred = predict(match, detail);
  const home = teamBlock(match, detail, pred, 'home'), away = teamBlock(match, detail, pred, 'away');
  const hs = home.season, as = away.season;
  const sameTable = hs && as && hs.record_from === as.record_from;
  return {
    match_id: matchId(match), fixture: `${match.home.name} vs ${match.away.name}`, competition: match.leagueName,
    kickoff: match.date, status: STATUS[match.state] || match.state,
    ...(match.state !== 'pre' ? { score: `${match.home.score}-${match.away.score}`, minute: match.minute, half_time_score: match.ht ? `${match.ht.home}-${match.ht.away}` : null } : {}),
    home, away,
    table_context: sameTable ? {
      positions: hs.table_position != null && as.table_position != null ? `${hs.table_position} vs ${as.table_position}` : null,
      points_gap_home_minus_away: hs.points != null && as.points != null ? hs.points - as.points : null,
      points_per_game_gap: hs.points_per_game != null && as.points_per_game != null ? r2(hs.points_per_game - as.points_per_game) : null,
    } : { note: 'The two season records come from different tables, so positions are not directly comparable.' },
    head_to_head: {
      meetings: pred.h2h.n, [`${match.home.short || match.home.name}_wins`]: pred.h2h.homeWins, draws: pred.h2h.draws,
      [`${match.away.short || match.away.name}_wins`]: pred.h2h.awayWins,
      average_goals: pred.h2h.n ? r2(pred.h2h.avgGoals) : null, both_scored: pred.h2h.n ? `${pred.h2h.btts}/${pred.h2h.n}` : null,
      recent: (detail.h2h || []).slice(0, 6).map((g) => ({ date: g.date ? String(g.date).slice(0, 10) : null, score: `${g.homeId === match.home.id ? g.hs : g.as}-${g.homeId === match.home.id ? g.as : g.hs}`, venue_for_home_team: g.homeId === match.home.id ? 'H' : 'A' })),
    },
    league_average_goals_per_team: r2(detail.leagueAvg) ?? null,
    data_quality: { confidence: pred.confidence.level, have: pred.confidence.have, missing: pred.confidence.missing },
  };
}

// ---- The model's prediction, including both halves ----
function halfLine(already, lam) {
  if (already == null || lam == null || !Number.isFinite(lam)) return null;
  const at = (k) => (already >= k ? 1 : 1 - Array.from({ length: k - already }, (_, i) => poisson(i, lam)).reduce((s, v) => s + v, 0));
  return { expected_goals: r2(already + lam), most_likely_goals: already + Math.floor(lam), over_0_5: r3(at(1)), over_1_5: r3(at(2)) };
}
export function modelPrediction(match, detail) {
  const p = predict(match, detail);
  const hs = match.home.score || 0, as = match.away.score || 0, now = match.state === 'pre' ? 0 : hs + as;
  const remaining = p.expectedMore, share = PARAMS.firstHalfShare;
  let first = null, second = null;
  if (match.state === 'pre') {
    const full = p.fullMatch.home + p.fullMatch.away;
    first = halfLine(0, full * share); second = halfLine(0, full * (1 - share));
  } else if (match.state === 'in' && p.phase === 'H1') {
    const lam1 = Math.max(0, p.firstHalf.expected - now);
    first = halfLine(now, lam1); second = halfLine(0, Math.max(0, remaining - lam1));
  } else if (match.state === 'in' && (p.phase === 'HT' || p.phase === 'H2')) {
    const ht = match.ht ? match.ht.home + match.ht.away : p.phase === 'HT' ? now : null;
    first = ht == null ? null : { expected_goals: ht, most_likely_goals: ht, over_0_5: +(ht > 0), over_1_5: +(ht > 1) };
    second = ht == null ? null : halfLine(now - ht, remaining);
  }
  const dist = p.moreDist.map((v, k) => ({ total_goals: now + k + (k === 5 ? '+' : ''), chance: r3(v) }));
  return {
    match_id: matchId(match), status: STATUS[match.state] || match.state,
    ...(match.state !== 'pre' ? { current_score: `${hs}-${as}`, minute: match.minute } : {}),
    result: { home_win: r3(p.outcome.homeWin), draw: r3(p.outcome.draw), away_win: r3(p.outcome.awayWin) },
    expected_goals: { home: r2(hs + p.expectedMoreHome), away: r2(as + p.expectedMoreAway), total: r2(p.expectedFinalTotal) },
    most_likely_total: now + p.mostLikelyMore,
    total_goals_distribution: dist,
    over_1_5: r3(p.over15), over_2_5: r3(p.over25), btts: r3(p.btts),
    most_likely_scores: p.topScores.map((s) => ({ score: `${s.home}-${s.away}`, chance: r3(s.p) })),
    first_half: first, second_half: second,
    confidence: p.confidence.level, missing_data: p.confidence.missing,
    main_drivers: p.reasons.filter((r) => r.key !== 'baseline').map((r) => ({ step: r.title, effect_on_total_goals: r2(r.delta), detail: r.detail })),
  };
}

// ---- Tool definitions sent to Claude ----
const idInput = {
  type: 'object', additionalProperties: false, required: ['match_id'],
  properties: { match_id: { type: 'string', description: 'A match_id returned by find_matches, e.g. "eng.1/740123".' } },
};
export const TOOL_DEFS = [
  {
    name: 'find_matches', strict: true,
    description: 'Search the fixture feed (live, today and the next 7 days in the main competitions) by fixture ("Arsenal vs Chelsea"), team name or league name ("Premier League", "LaLiga"). Returns match_ids, kickoff times and status. Call this first; only match_ids it returns can be analysed.',
    input_schema: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string', description: 'The fixture, team or league as the user wrote it.' } } },
  },
  {
    name: 'get_match_data', strict: true,
    description: 'Data for one match: for both teams the last 5 results, form string and points, season goals for/against per game, attack and defence strength vs league average, table position and points; table context; head-to-head record and recent meetings; and which data is missing.',
    input_schema: idInput,
  },
  {
    name: 'get_model_prediction', strict: true,
    description: 'The app\'s backtested statistical model for one match: home/draw/away chances, expected goals per team and in total, total-goals distribution, Over 1.5 / Over 2.5 / both teams to score, most likely scores, first-half and second-half goals, its confidence and the steps that drive it. Start your prediction from these numbers.',
    input_schema: idInput,
  },
];

// Tool implementations. `ctx` supplies the app's data: pool() -> matches, ensureFixtures() loads the
// next 7 days, detail(match) -> detail. Results the model produced are kept for checkAnswer.
export function makeTools(ctx) {
  const models = new Map();
  const lookup = async (id) => {
    let m = ctx.pool().find((x) => matchId(x) === id);
    if (!m) { await ctx.ensureFixtures?.(); m = ctx.pool().find((x) => matchId(x) === id); }
    if (!m) throw new Error(`Unknown match_id "${id}". Use a match_id returned by find_matches.`);
    return m;
  };
  return {
    models,
    async find_matches({ query }) {
      // The next 7 days of fixtures (cached by the app for 30 minutes), so league queries see upcoming rounds.
      try { await ctx.ensureFixtures?.(); } catch { /* today's matches still searchable */ }
      return findMatches(query, ctx.pool());
    },
    async get_match_data({ match_id }) {
      const m = await lookup(match_id);
      return matchData(m, await ctx.detail(m));
    },
    async get_model_prediction({ match_id }) {
      const m = await lookup(match_id);
      const out = modelPrediction(m, await ctx.detail(m));
      models.set(match_id, out);
      return out;
    },
  };
}

// ---- The answer Claude must return (structured output) ----
const nullable = (s) => ({ anyOf: [s, { type: 'null' }] });
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const half = obj({ expected_goals: { type: 'number' }, most_likely_goals: { type: 'integer' }, over_0_5: { type: 'number' }, over_1_5: { type: 'number' } });
export const ANSWER_SCHEMA = obj({
  status: { type: 'string', enum: ['ok', 'needs_clarification', 'no_matches', 'out_of_scope'] },
  message: { type: 'string', description: 'One or two sentences for the user (what was analysed, or what is needed).' },
  clarification_question: nullable({ type: 'string' }),
  candidates: { type: 'array', items: obj({ match_id: { type: 'string' }, label: { type: 'string' } }) },
  predictions: {
    type: 'array',
    items: obj({
      match_id: { type: 'string' }, fixture: { type: 'string' }, competition: { type: 'string' }, kickoff: { type: 'string' },
      live: { type: 'boolean' },
      summary: { type: 'string' },
      factors: { type: 'array', items: obj({
        factor: { type: 'string' }, team: { type: 'string', enum: ['home', 'away', 'both'] },
        effect: { type: 'string', enum: ['favours_home', 'favours_away', 'more_goals', 'fewer_goals', 'neutral'] },
        evidence: { type: 'string' },
      }) },
      result: obj({ home_win: { type: 'number' }, draw: { type: 'number' }, away_win: { type: 'number' }, pick: { type: 'string', enum: ['home', 'draw', 'away'] } }),
      goals: obj({ expected_total: { type: 'number' }, most_likely_total: { type: 'integer' }, over_1_5: { type: 'number' }, over_2_5: { type: 'number' }, btts: { type: 'number' } }),
      first_half: nullable(half),
      second_half: nullable(half),
      adjustments: { type: 'array', items: obj({ market: { type: 'string' }, model_value: { type: 'number' }, new_value: { type: 'number' }, reason: { type: 'string' } }) },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      caveats: { type: 'array', items: { type: 'string' } },
    }),
  },
});

// ---- Rule checks on the answer (the constraints in SKILL.md) ----
// Returns a list of plain-language violations; empty means the answer follows the rules.
export function checkAnswer(answer, models) {
  const v = [];
  if (!answer || typeof answer !== 'object') return ['The answer is not a JSON object.'];
  const preds = answer.predictions || [];
  if (answer.status === 'ok' && !preds.length) v.push('status is "ok" but there are no predictions.');
  if (answer.status !== 'ok' && preds.length) v.push(`status is "${answer.status}" but predictions were given.`);
  if (preds.length > LIMITS.maxMatches) v.push(`At most ${LIMITS.maxMatches} matches per request (got ${preds.length}).`);
  const pt = (x) => `${Math.round(x * 1000) / 10}%`;
  for (const p of preds) {
    const id = p.match_id, m = models.get(id);
    const at = (s) => `${p.fixture || id}: ${s}`;
    if (!m) { v.push(at(`no get_model_prediction call for match_id "${id}"; only matches the tools returned can be predicted.`)); continue; }
    if (m.status === 'finished') { v.push(at('the match has finished; report the result instead of predicting it.')); continue; }
    const low = m.confidence === 'Low';
    if (low && p.confidence !== 'low') v.push(at('the model\'s confidence is Low, so the prediction\'s confidence must be "low".'));
    const prob = (name, x) => { if (!(x >= 0 && x <= 1)) v.push(at(`${name} must be a chance between 0 and 1 (got ${x}).`)); };
    const near = (name, x, model, limit) => {
      if (x == null || model == null) return false;
      const d = Math.abs(x - model);
      const max = low ? 0.011 : limit + 0.005;
      if (d > max) v.push(at(`${name} ${low ? 'must equal the model (confidence Low: no adjustments)' : `may move at most ${limit < 1 ? pt(limit) + ' points' : limit} from the model`}: model ${model}, answer ${x}.`));
      return d > 0.015;
    };
    const r = p.result || {}, g = p.goals || {};
    ['home_win', 'draw', 'away_win'].forEach((k) => prob(k, r[k]));
    ['over_1_5', 'over_2_5', 'btts'].forEach((k) => prob(k, g[k]));
    const sum = (r.home_win || 0) + (r.draw || 0) + (r.away_win || 0);
    if (Math.abs(sum - 1) > LIMITS.sumTolerance) v.push(at(`home win + draw + away win must be 100% (got ${pt(sum)}).`));
    const best = Math.max(r.home_win ?? 0, r.draw ?? 0, r.away_win ?? 0);
    if (r.pick && r[{ home: 'home_win', draw: 'draw', away: 'away_win' }[r.pick]] < best - 1e-9) v.push(at(`pick "${r.pick}" is not the outcome with the highest chance.`));
    let moved = false;
    moved = near('home_win', r.home_win, m.result.home_win, LIMITS.resultShift) || moved;
    moved = near('draw', r.draw, m.result.draw, LIMITS.resultShift) || moved;
    moved = near('away_win', r.away_win, m.result.away_win, LIMITS.resultShift) || moved;
    moved = near('expected_total', g.expected_total, m.expected_goals.total, LIMITS.totalShift) || moved;
    moved = near('over_1_5', g.over_1_5, m.over_1_5, LIMITS.marketShift) || moved;
    moved = near('over_2_5', g.over_2_5, m.over_2_5, LIMITS.marketShift) || moved;
    moved = near('btts', g.btts, m.btts, LIMITS.marketShift) || moved;
    for (const h of ['first_half', 'second_half']) {
      const a = p[h], b = m[h];
      if (!a || !b) continue;
      prob(`${h}.over_0_5`, a.over_0_5); prob(`${h}.over_1_5`, a.over_1_5);
      moved = near(`${h}.over_0_5`, a.over_0_5, b.over_0_5, LIMITS.marketShift) || moved;
      moved = near(`${h}.over_1_5`, a.over_1_5, b.over_1_5, LIMITS.marketShift) || moved;
    }
    if (p.first_half && p.second_half && Number.isFinite(g.expected_total)) {
      const s = p.first_half.expected_goals + p.second_half.expected_goals;
      if (Math.abs(s - g.expected_total) > LIMITS.halvesTolerance) v.push(at(`first-half + second-half expected goals (${r2(s)}) must equal expected_total (${g.expected_total}) within ${LIMITS.halvesTolerance}.`));
    }
    if (m.first_half && !p.first_half) v.push(at('first_half is missing although the model has it.'));
    if (m.second_half && !p.second_half) v.push(at('second_half is missing although the model has it.'));
    if (low && (p.adjustments || []).length) v.push(at('no adjustments are allowed when the model\'s confidence is Low.'));
    if (moved && !(p.adjustments || []).length) v.push(at('numbers differ from the model but no adjustment (with its reason) is listed.'));
    if (!(p.factors || []).length) v.push(at('list the factors behind the prediction, each with evidence from the data.'));
  }
  return v;
}
