// Match Analyst agent: free-tier LLMs (js/llm.js) with the tools in analyst-tools.js, under the rules in
// skills/match-analyst/SKILL.md. checkAnswer() enforces those rules; an answer that breaks them is sent
// back once to be fixed. builtinAnalyst() gives the same answer format with no AI at all, so the page
// always works for free (no key, offline demo, or when a free quota runs out).
import { TOOL_DEFS, checkAnswer, LIMITS } from './analyst-tools.js';

const MAX_TURNS = 14;

// Tool definitions in the OpenAI function format, kept to the JSON-schema subset every provider accepts.
const plain = (s) => {
  if (Array.isArray(s)) return s.map(plain);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) if (k !== 'additionalProperties') out[k] = plain(v);
  return out;
};
export const FUNCTION_TOOLS = TOOL_DEFS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: plain(t.input_schema) } }));

// The answer format, described in words (free models follow a written template more reliably than a schema).
export const ANSWER_FORMAT = `When you have the data, reply with ONLY one JSON object (no other text) in this shape:
{"status":"ok"|"needs_clarification"|"no_matches"|"out_of_scope","message":string,"clarification_question":string|null,
 "candidates":[{"match_id":string,"label":string}],
 "predictions":[{"match_id":string,"fixture":"Home vs Away","competition":string,"kickoff":string,"live":boolean,"summary":string,
   "factors":[{"factor":string,"team":"home"|"away"|"both","effect":"favours_home"|"favours_away"|"more_goals"|"fewer_goals"|"neutral","evidence":string}],
   "result":{"home_win":number,"draw":number,"away_win":number,"pick":"home"|"draw"|"away"},
   "goals":{"expected_total":number,"most_likely_total":integer,"over_1_5":number,"over_2_5":number,"btts":number},
   "first_half":{"expected_goals":number,"most_likely_goals":integer,"over_0_5":number,"over_1_5":number}|null,
   "second_half":{"expected_goals":number,"most_likely_goals":integer,"over_0_5":number,"over_1_5":number}|null,
   "adjustments":[{"market":string,"model_value":number,"new_value":number,"reason":string}],
   "confidence":"high"|"medium"|"low","caveats":[string]}]}
Chances are decimals between 0 and 1 (0.62, not 62). Copy first_half and second_half from get_model_prediction.`;

// Pulls the JSON object out of a reply (tolerates code fences or text around it).
export function parseAnswer(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}
// Fills missing lists so a slightly incomplete answer can still be checked and shown.
export function normalizeAnswer(x) {
  const a = { status: 'ok', message: '', clarification_question: null, candidates: [], predictions: [], ...x };
  a.candidates = Array.isArray(a.candidates) ? a.candidates : [];
  a.predictions = (Array.isArray(a.predictions) ? a.predictions : []).map((p) => ({
    factors: [], adjustments: [], caveats: [], first_half: null, second_half: null, result: {}, goals: {}, ...p,
  }));
  if (a.predictions.length && a.status !== 'ok') a.status = 'ok';
  return a;
}

// chat({ messages, tools }) -> { message, finish, usage } (see llm.js). tools comes from makeTools().
export async function runAnalyst({ chat, skill, query, tools, onStep = () => {}, today = new Date(), signal } = {}) {
  const messages = [
    { role: 'system', content: `${skill}\n\n## Answer format\n\n${ANSWER_FORMAT}` },
    { role: 'user', content: `Today is ${today.toISOString().slice(0, 10)}. Analyse: ${String(query).trim()}` },
  ];
  const usage = { input: 0, output: 0, requests: 0 };
  let retried = false, nudged = false;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (signal?.aborted) throw new Error('Stopped.');
    onStep({ kind: 'thinking', turn });
    const { message, finish, usage: u } = await chat({ messages, tools: FUNCTION_TOOLS }, { signal });
    usage.requests++; usage.input += u?.prompt_tokens || 0; usage.output += u?.completion_tokens || 0;
    const calls = (message.tool_calls || []).map((c, i) => ({ ...c, id: c.id || `call_${turn}_${i}`, type: c.type || 'function' }));
    messages.push(calls.length ? { role: 'assistant', content: message.content || null, tool_calls: calls } : { role: 'assistant', content: message.content ?? '' });

    if (calls.length) {
      const results = await Promise.all(calls.map(async (c) => {
        const name = c.function?.name;
        let input = {};
        try {
          input = typeof c.function?.arguments === 'string' ? JSON.parse(c.function.arguments || '{}') : c.function?.arguments || {};
          onStep({ kind: 'tool', name, input });
          const fn = tools[name];
          if (typeof fn !== 'function') throw new Error(`Unknown tool ${name}`);
          return { role: 'tool', tool_call_id: c.id, name, content: JSON.stringify(await fn(input)) };
        } catch (e) {
          onStep({ kind: 'tool_error', name, message: e.message });
          return { role: 'tool', tool_call_id: c.id, name, content: `Error: ${e.message}` };
        }
      }));
      messages.push(...results);
      continue;
    }
    if (finish === 'length') throw new Error('The answer was cut off. Try one fixture instead of a whole league.');

    const parsed = parseAnswer(message.content);
    if (!parsed) {
      if (nudged) throw new Error('The model did not return an answer in the required format.');
      nudged = true;
      messages.push({ role: 'user', content: `Reply with only the JSON object described in "Answer format". Use the tools first if you have not called get_model_prediction yet.` });
      continue;
    }
    const answer = normalizeAnswer(parsed);
    const violations = checkAnswer(answer, tools.models);
    if (violations.length && !retried) {
      retried = true;
      onStep({ kind: 'fixing', violations });
      messages.push({ role: 'user', content: `Your answer breaks these rules from the skill. Fix them (call the tools again only if needed) and reply with only the corrected JSON:\n- ${violations.join('\n- ')}` });
      continue;
    }
    return { answer, violations, usage };
  }
  throw new Error('The analysis took too many steps and was stopped.');
}

// ---- Built-in analyst: no AI, no key, no cost ----
// Same tools, same answer format: the model's numbers unchanged, with factors and a summary written from the data.
const p100 = (x) => `${Math.round(x * 100)}%`;
function factorsFor(d) {
  const H = d.home, A = d.away, out = [];
  const hs = H.season, as = A.season;
  const hEdge = (H.attack_strength_vs_average || 1) * (A.defence_conceding_vs_average || 1);
  const aEdge = (A.attack_strength_vs_average || 1) * (H.defence_conceding_vs_average || 1);
  out.push({
    factor: `${hEdge >= aEdge ? H.name : A.name} attack vs ${hEdge >= aEdge ? A.name : H.name} defence`,
    team: hEdge >= aEdge ? 'home' : 'away', effect: Math.abs(hEdge - aEdge) < 0.08 ? 'neutral' : hEdge > aEdge ? 'favours_home' : 'favours_away',
    evidence: hs && as ? `${H.name} score ${hs.goals_for_per_game} and concede ${hs.goals_against_per_game} per game; ${A.name} score ${as.goals_for_per_game} and concede ${as.goals_against_per_game}`
      : `Attack strength ${H.attack_strength_vs_average} vs ${A.attack_strength_vs_average} (1.00 = league average)`,
  });
  if (H.form && A.form) {
    const pts = (t) => parseInt(t.form_points, 10);
    out.push({
      factor: 'Recent form (last 5)', team: pts(H) === pts(A) ? 'both' : pts(H) > pts(A) ? 'home' : 'away',
      effect: Math.abs(pts(H) - pts(A)) < 3 ? 'neutral' : pts(H) > pts(A) ? 'favours_home' : 'favours_away',
      evidence: `${H.name} ${H.form} (${H.form_points} pts, ${H.last_5_goals_for}-${H.last_5_goals_against} goals); ${A.name} ${A.form} (${A.form_points} pts, ${A.last_5_goals_for}-${A.last_5_goals_against})`,
    });
    const goals = (H.last_5_goals_for + H.last_5_goals_against + A.last_5_goals_for + A.last_5_goals_against) / 10;
    out.push({ factor: 'Goals in recent games', team: 'both', effect: goals >= 3 ? 'more_goals' : goals <= 2.2 ? 'fewer_goals' : 'neutral', evidence: `Their last 5 games averaged ${goals.toFixed(1)} goals each` });
  }
  const tc = d.table_context;
  if (tc?.positions) {
    const gap = tc.points_per_game_gap;
    out.push({
      factor: 'League table', team: gap == null || Math.abs(gap) < 0.2 ? 'both' : gap > 0 ? 'home' : 'away',
      effect: gap == null || Math.abs(gap) < 0.2 ? 'neutral' : gap > 0 ? 'favours_home' : 'favours_away',
      evidence: `Positions ${tc.positions}${tc.points_gap_home_minus_away != null ? `, points gap ${tc.points_gap_home_minus_away > 0 ? '+' : ''}${tc.points_gap_home_minus_away}` : ''}${gap != null ? `, ${gap > 0 ? '+' : ''}${gap} points per game` : ''}`,
    });
  }
  const h = d.head_to_head;
  if (h.meetings >= 3) {
    out.push({ factor: 'Head-to-head', team: 'both', effect: h.average_goals >= 3 ? 'more_goals' : h.average_goals <= 2 ? 'fewer_goals' : 'neutral',
      evidence: `${h.meetings} meetings, ${h.average_goals} goals on average, both scored in ${h.both_scored}` });
  }
  out.push({ factor: 'Home advantage', team: 'home', effect: 'favours_home', evidence: `${H.name} play at home (home sides score about 10% more)` });
  return out.slice(0, 6);
}
function predictionFrom(d, m) {
  const r = m.result;
  const pick = [['home', r.home_win], ['draw', r.draw], ['away', r.away_win]].sort((x, y) => y[1] - x[1])[0][0];
  const [home, away] = [d.home.name, d.away.name];
  const fav = pick === 'draw' ? 'Neither side is a clear favourite' : `${pick === 'home' ? home : away} are favoured (${p100(Math.max(r.home_win, r.away_win))})`;
  const goals = m.expected_goals.total;
  return {
    match_id: d.match_id, fixture: d.fixture, competition: d.competition, kickoff: d.kickoff, live: d.status === 'in play',
    summary: `${fav}, with a draw at ${p100(r.draw)}. Expect about ${goals.toFixed(1)} goals (most likely ${m.most_likely_total})` +
      `${m.first_half && m.second_half ? `, around ${m.first_half.expected_goals.toFixed(1)} before half time and ${m.second_half.expected_goals.toFixed(1)} after` : ''}.`,
    factors: factorsFor(d),
    result: { ...r, pick },
    goals: { expected_total: goals, most_likely_total: m.most_likely_total, over_1_5: m.over_1_5, over_2_5: m.over_2_5, btts: m.btts },
    first_half: m.first_half, second_half: m.second_half,
    adjustments: [],
    confidence: m.confidence.toLowerCase(),
    caveats: [...m.missing_data.map((x) => `Missing: ${x}`), 'Team news and injuries are not in the data.'],
  };
}
export async function builtinAnalyst({ query, tools, onStep = () => {} }) {
  onStep({ kind: 'tool', name: 'find_matches', input: { query } });
  const found = await tools.find_matches({ query });
  const open = found.matches.filter((m) => m.status !== 'finished');
  const label = (m) => `${m.fixture} (${m.competition}, ${new Date(m.kickoff).toLocaleDateString([], { day: 'numeric', month: 'short' })})`;
  const base = { clarification_question: null, candidates: [], predictions: [] };
  if (!found.matches.length) return { answer: { ...base, status: 'no_matches', message: `No fixture found for “${query}” today or in the next 7 days in the main competitions.` }, violations: [], usage: null };
  if (found.query_type === 'partial' || (found.query_type === 'team' && open.length > 1)) {
    return { answer: { ...base, status: 'needs_clarification', message: 'Several fixtures could match.', clarification_question: 'Which match do you mean?',
      candidates: found.matches.slice(0, LIMITS.maxMatches).map((m) => ({ match_id: m.match_id, label: label(m) })) }, violations: [], usage: null };
  }
  if (!open.length) return { answer: { ...base, status: 'no_matches', message: `${found.matches[0].fixture} has finished (${found.matches[0].score}); there is nothing left to predict.` }, violations: [], usage: null };
  const picks = found.query_type === 'fixture' ? open.slice(0, 1) : open.slice(0, LIMITS.maxMatches);
  const predictions = [];
  for (const m of picks) {
    onStep({ kind: 'tool', name: 'get_match_data', input: { match_id: m.match_id } });
    const d = await tools.get_match_data({ match_id: m.match_id });
    onStep({ kind: 'tool', name: 'get_model_prediction', input: { match_id: m.match_id } });
    predictions.push(predictionFrom(d, await tools.get_model_prediction({ match_id: m.match_id })));
  }
  const answer = { ...base, status: 'ok', message: `Analysed ${predictions.length} match${predictions.length > 1 ? 'es' : ''} with the built-in analyst (no AI, free).`, predictions };
  return { answer, violations: checkAnswer(answer, tools.models), usage: null };
}
