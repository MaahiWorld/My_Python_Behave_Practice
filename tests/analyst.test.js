import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const T = await import('../js/analyst-tools.js');
const { runAnalyst, MODEL } = await import('../js/analyst.js');
const { demoMatches, demoDetail } = await import('../js/demo.js');

const pool = demoMatches();
const ctx = { pool: () => pool, detail: async (m) => demoDetail(m) };
const pre = pool.find((m) => m.state === 'pre'); // Northgate United vs Harbour City
const preId = T.matchId(pre);

// An answer that copies the model exactly (always allowed).
function answerFrom(model, extra = {}) {
  const r = model.result;
  const best = Object.entries({ home: r.home_win, draw: r.draw, away: r.away_win }).sort((a, b) => b[1] - a[1])[0][0];
  return {
    status: 'ok', message: 'One match analysed.', clarification_question: null, candidates: [],
    predictions: [{
      match_id: model.match_id, fixture: 'Northgate United vs Harbour City', competition: 'Demo League', kickoff: pre.date, live: false,
      summary: 'Northgate are favoured.',
      factors: [{ factor: 'Home attack', team: 'home', effect: 'favours_home', evidence: 'scores 1.6 per game' }],
      result: { ...r, pick: best },
      goals: { expected_total: model.expected_goals.total, most_likely_total: model.most_likely_total, over_1_5: model.over_1_5, over_2_5: model.over_2_5, btts: model.btts },
      first_half: model.first_half, second_half: model.second_half,
      adjustments: [], confidence: 'high', caveats: ['No team news in the data.'],
      ...extra,
    }],
  };
}

test('parses fixtures and league names from free text', () => {
  assert.deepEqual(T.parseQuery('Arsenal vs Chelsea').teams, ['Arsenal', 'Chelsea']);
  assert.deepEqual(T.parseQuery('Inter v Milan').teams, ['Inter', 'Milan']);
  assert.deepEqual(T.parseQuery('Real Madrid x Barcelona').teams, ['Real Madrid', 'Barcelona']);
  assert.equal(T.parseQuery('Premier League').type, 'text');
  assert.ok(T.leagueSlugs('Premier League').includes('eng.1'));
  assert.ok(T.leagueSlugs('EPL').includes('eng.1'));
  assert.ok(T.leagueSlugs('laliga').includes('esp.1'));
  assert.ok(T.leagueSlugs('Champions League').includes('uefa.champions'));
});

test('finds a fixture in either order, by team or by league', () => {
  const a = T.findMatches('Northgate vs Harbour City', pool);
  assert.equal(a.query_type, 'fixture');
  assert.equal(a.matches[0].match_id, preId);
  assert.equal(T.findMatches('Harbour City v Northgate United', pool).matches[0].match_id, preId);
  const lg = T.findMatches('Demo League', pool);
  assert.equal(lg.query_type, 'league');
  assert.equal(lg.matches.length, pool.length);
  assert.equal(lg.matches.at(-1).status, 'finished', 'finished matches listed last');
  const none = T.findMatches('Atlantis vs Lemuria', pool);
  assert.equal(none.matches.length, 0);
  assert.ok(none.note);
  assert.equal(T.findMatches('Northgate vs Lemuria', pool).query_type, 'partial');
});

test('match data has form, last 5, strength, table and head-to-head for both teams', () => {
  const d = T.matchData(pre, demoDetail(pre));
  for (const side of ['home', 'away']) {
    const t = d[side];
    assert.equal(t.last_5.length, 5);
    assert.match(t.form, /^[WDL]{5}$/);
    assert.ok(t.season.games >= 5 && t.season.table_position >= 1);
    assert.ok(t.attack_strength_vs_average > 0 && t.defence_conceding_vs_average > 0);
    assert.ok(t.attack_rating_0_100 >= 0 && t.attack_rating_0_100 <= 100);
  }
  assert.equal(d.head_to_head.meetings, 5);
  assert.ok(d.table_context.positions);
  assert.equal(d.data_quality.confidence, 'High');
});

test('model prediction: result sums to 1 and the two halves add up to the total', () => {
  const m = T.modelPrediction(pre, demoDetail(pre));
  const s = m.result.home_win + m.result.draw + m.result.away_win;
  assert.ok(Math.abs(s - 1) < 0.005);
  assert.ok(Math.abs(m.first_half.expected_goals + m.second_half.expected_goals - m.expected_goals.total) < 0.02);
  assert.ok(m.second_half.expected_goals > m.first_half.expected_goals, 'more goals after the break');
  assert.equal(m.total_goals_distribution.length, 6);
  // Live, first half: goals so far count in the first half.
  const h1 = pool.find((x) => x.state === 'in' && x.phase === 'H1');
  const live = T.modelPrediction(h1, demoDetail(h1));
  assert.ok(live.first_half.expected_goals >= h1.home.score + h1.away.score);
  assert.ok(live.second_half.expected_goals > 0);
});

test('checkAnswer accepts the model numbers and small, explained adjustments', () => {
  const model = T.modelPrediction(pre, demoDetail(pre));
  const models = new Map([[preId, model]]);
  assert.deepEqual(T.checkAnswer(answerFrom(model), models), []);
  const shifted = answerFrom(model);
  const p = shifted.predictions[0];
  p.goals.expected_total = +(model.expected_goals.total + 0.2).toFixed(2);
  p.first_half = { ...p.first_half, expected_goals: +(p.first_half.expected_goals + 0.1).toFixed(2) };
  p.second_half = { ...p.second_half, expected_goals: +(p.second_half.expected_goals + 0.1).toFixed(2) };
  p.adjustments = [{ market: 'expected_total', model_value: model.expected_goals.total, new_value: p.goals.expected_total, reason: 'H2H 4+ meetings average 4 goals' }];
  assert.deepEqual(T.checkAnswer(shifted, models), []);
});

test('checkAnswer rejects answers that break the skill constraints', () => {
  const model = T.modelPrediction(pre, demoDetail(pre));
  const models = new Map([[preId, model]]);
  const big = answerFrom(model);
  big.predictions[0].result.home_win += 0.1; big.predictions[0].result.away_win -= 0.1;
  big.predictions[0].adjustments = [{ market: 'home_win', model_value: 0, new_value: 0, reason: 'x' }];
  assert.ok(T.checkAnswer(big, models).some((x) => /at most 5% points/.test(x)));

  const silent = answerFrom(model);
  silent.predictions[0].goals.over_2_5 = +(model.over_2_5 + 0.03).toFixed(3);
  assert.ok(T.checkAnswer(silent, models).some((x) => /no adjustment/.test(x)));

  const halves = answerFrom(model);
  halves.predictions[0].first_half = { ...model.first_half, expected_goals: 3 };
  assert.ok(T.checkAnswer(halves, models).some((x) => /first-half \+ second-half/.test(x)));

  const sum = answerFrom(model);
  sum.predictions[0].result.draw += 0.04; // within the 5-point limit but no longer sums to 100%
  sum.predictions[0].adjustments = [{ market: 'draw', model_value: model.result.draw, new_value: sum.predictions[0].result.draw, reason: 'x' }];
  assert.ok(T.checkAnswer(sum, models).some((x) => /must be 100%/.test(x)));

  const unknown = answerFrom(model, { match_id: 'eng.1/123' });
  assert.ok(T.checkAnswer(unknown, models).some((x) => /no get_model_prediction call/.test(x)));

  const lowModel = { ...model, confidence: 'Low' };
  const low = answerFrom(model);
  low.predictions[0].adjustments = [{ market: 'x', model_value: 1, new_value: 1, reason: 'y' }];
  const lv = T.checkAnswer(low, new Map([[preId, lowModel]]));
  assert.ok(lv.some((x) => /confidence must be "low"/.test(x)));
  assert.ok(lv.some((x) => /no adjustments are allowed/.test(x)));

  const post = pool.find((m) => m.state === 'post');
  const postModel = T.modelPrediction(post, demoDetail(post));
  assert.ok(T.checkAnswer(answerFrom(postModel), new Map([[postModel.match_id, postModel]])).some((x) => /finished/.test(x)));

  const many = answerFrom(model);
  many.predictions = Array(6).fill(many.predictions[0]);
  assert.ok(T.checkAnswer(many, models).some((x) => /At most 5 matches/.test(x)));
});

test('the skill states the same limits the code enforces', () => {
  const skill = readFileSync(new URL('../skills/match-analyst/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, new RegExp(`at most \\*\\*${T.LIMITS.maxMatches}\\*\\* matches`));
  assert.match(skill, new RegExp(`at most \\*\\*${Math.round(T.LIMITS.resultShift * 100)} percentage points\\*\\*`));
  assert.match(skill, new RegExp(`at most \\*\\*${T.LIMITS.totalShift} goals\\*\\*`));
  assert.match(skill, new RegExp(`within ${T.LIMITS.halvesTolerance}`));
  for (const d of T.TOOL_DEFS) assert.ok(skill.includes('`' + d.name + '`'), `skill mentions ${d.name}`);
});

test('tool and answer schemas are strict-mode compatible', () => {
  const walk = (s, path) => {
    if (s.type === 'object') {
      assert.equal(s.additionalProperties, false, `${path} additionalProperties`);
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort(), `${path} required`);
      for (const [k, v] of Object.entries(s.properties)) walk(v, `${path}.${k}`);
    }
    if (s.items) walk(s.items, `${path}[]`);
    for (const a of s.anyOf || []) walk(a, path);
  };
  walk(T.ANSWER_SCHEMA, 'answer');
  for (const d of T.TOOL_DEFS) { assert.equal(d.strict, true); walk(d.input_schema, d.name); }
});

// A scripted stand-in for the Anthropic client: returns the queued responses in order and records requests.
function fakeClient(script) {
  const requests = [];
  return {
    requests,
    beta: { messages: { create: async (req) => { requests.push(structuredClone(req)); return script(requests.length, req); } } },
  };
}
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const resp = (stop_reason, content) => ({ stop_reason, content, usage: { input_tokens: 100, output_tokens: 50 } });

test('agent loop: finds the match, calls the tools in parallel, returns a checked answer', async () => {
  const tools = T.makeTools(ctx);
  const steps = [];
  const client = fakeClient((n) => {
    if (n === 1) return resp('tool_use', [toolUse('t1', 'find_matches', { query: 'Northgate vs Harbour City' })]);
    if (n === 2) return resp('tool_use', [toolUse('t2', 'get_match_data', { match_id: preId }), toolUse('t3', 'get_model_prediction', { match_id: preId })]);
    return resp('end_turn', [{ type: 'text', text: JSON.stringify(answerFrom(tools.models.get(preId))) }]);
  });
  const out = await runAnalyst({ client, skill: 'SKILL', query: 'Northgate vs Harbour City', tools, onStep: (s) => steps.push(s) });
  assert.equal(out.answer.status, 'ok');
  assert.deepEqual(out.violations, []);
  assert.equal(client.requests.length, 3);
  const req = client.requests[0];
  assert.equal(req.model, MODEL);
  assert.deepEqual(req.thinking, { type: 'adaptive' });
  assert.equal(req.fallbacks, 'default');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.equal(req.system[0].text, 'SKILL');
  // Both results of the parallel turn come back in a single user message.
  const third = client.requests[2].messages;
  const results = third.at(-1).content;
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.type === 'tool_result' && !r.is_error));
  assert.equal(steps.filter((s) => s.kind === 'tool').length, 3);
});

test('agent loop: a rule-breaking answer is sent back once to be fixed', async () => {
  const tools = T.makeTools(ctx);
  const client = fakeClient(async (n) => {
    if (n === 1) return resp('tool_use', [toolUse('t1', 'get_model_prediction', { match_id: preId })]);
    const a = answerFrom(tools.models.get(preId));
    if (n === 2) a.predictions[0].goals.expected_total += 1; // breaks the 0.3 limit
    return resp('end_turn', [{ type: 'text', text: JSON.stringify(a) }]);
  });
  const out = await runAnalyst({ client, skill: 'S', query: 'x', tools });
  assert.deepEqual(out.violations, []);
  assert.equal(client.requests.length, 3);
  assert.match(client.requests[2].messages.at(-1).content, /breaks these rules/);
});

test('agent loop: tool errors are returned to Claude, refusals stop the run', async () => {
  const tools = T.makeTools(ctx);
  const client = fakeClient((n) => (n === 1
    ? resp('tool_use', [toolUse('t1', 'get_match_data', { match_id: 'nope/1' })])
    : { stop_reason: 'refusal', content: [], stop_details: { explanation: 'test' }, usage: {} }));
  await assert.rejects(runAnalyst({ client, skill: 'S', query: 'x', tools }), /declined/);
  const r = client.requests[1].messages.at(-1).content[0];
  assert.equal(r.is_error, true);
  assert.match(r.content, /Unknown match_id/);
});

test('team names: short forms match, 3-letter codes only exactly', () => {
  const city = { name: 'Manchester City', short: 'Man City', abbr: 'MNC' };
  assert.ok(T.teamMatches('Man City', city));
  assert.ok(T.teamMatches('manchester city', city));
  assert.ok(T.teamMatches('City', city));
  assert.ok(T.teamMatches('MNC', city));
  assert.ok(!T.teamMatches('Man United', city));
  assert.ok(!T.teamMatches('Northgate vs Lemuria', { name: 'Riverside', short: 'Riverside', abbr: 'NOR' }));
});
