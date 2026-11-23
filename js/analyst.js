// Match Analyst agent loop (Claude, called from the browser with the user's own API key).
// Claude reads the skill (skills/match-analyst/SKILL.md), calls the tools in analyst-tools.js, and returns
// a JSON answer in ANSWER_SCHEMA. checkAnswer() enforces the skill's constraints; an answer that breaks
// them is sent back once to be fixed, and any violations left are shown to the user.
import { TOOL_DEFS, ANSWER_SCHEMA, checkAnswer } from './analyst-tools.js';

export const MODEL = 'claude-opus-5-5';
// Official Anthropic SDK, loaded only when the analyst runs (no build step in this app).
export const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.6.0/+esm';
const MAX_TURNS = 14;

export async function makeClient(apiKey) {
  const { default: Anthropic } = await import(SDK_URL);
  // The key belongs to the user and stays in their browser, like the app's other API keys.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

// Checks a key with a free request (model lookup). Used by the Data sources page.
export async function testKey({ key }) {
  const client = await makeClient(key);
  const m = await client.models.retrieve(MODEL);
  return `Key works (${m.display_name || MODEL})`;
}

function request(system, messages) {
  return {
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default', // a declined request is re-run on Anthropic's recommended fallback model
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: ANSWER_SCHEMA } },
    cache_control: { type: 'ephemeral' }, // the skill and tool definitions repeat on every turn
    system,
    tools: TOOL_DEFS,
    messages,
  };
}

const textOf = (content) => content.filter((b) => b.type === 'text').map((b) => b.text).join('');

// Runs one analysis. `tools` comes from makeTools(); onStep({ kind, ... }) reports progress.
export async function runAnalyst({ client, skill, query, tools, onStep = () => {}, today = new Date(), signal } = {}) {
  const system = [{ type: 'text', text: skill }];
  const messages = [{
    role: 'user',
    content: `Today is ${today.toISOString().slice(0, 10)}. Analyse: ${String(query).trim()}`,
  }];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
  let retried = false;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (signal?.aborted) throw new Error('Stopped.');
    onStep({ kind: 'thinking', turn });
    const res = await client.beta.messages.create(request(system, messages), { signal });
    usage.requests++;
    usage.input += res.usage?.input_tokens || 0;
    usage.output += res.usage?.output_tokens || 0;
    usage.cacheRead += res.usage?.cache_read_input_tokens || 0;
    usage.cacheWrite += res.usage?.cache_creation_input_tokens || 0;
    // Pass the whole content back unchanged (thinking blocks included) on the next request.
    messages.push({ role: 'assistant', content: res.content });

    if (res.stop_reason === 'refusal') throw new Error(`Claude declined this request${res.stop_details?.explanation ? `: ${res.stop_details.explanation}` : '.'}`);
    if (res.stop_reason === 'max_tokens') throw new Error('The answer was cut off (too long). Try fewer matches, e.g. one fixture.');
    if (res.stop_reason === 'pause_turn') continue;

    if (res.stop_reason === 'tool_use') {
      const calls = res.content.filter((b) => b.type === 'tool_use');
      // Run every call from this turn in parallel and return all results in one message.
      const results = await Promise.all(calls.map(async (c) => {
        onStep({ kind: 'tool', name: c.name, input: c.input });
        try {
          const fn = tools[c.name];
          if (typeof fn !== 'function') throw new Error(`Unknown tool ${c.name}`);
          const out = await fn(c.input || {});
          return { type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(out) };
        } catch (e) {
          onStep({ kind: 'tool_error', name: c.name, message: e.message });
          return { type: 'tool_result', tool_use_id: c.id, content: `Error: ${e.message}`, is_error: true };
        }
      }));
      messages.push({ role: 'user', content: results });
      continue;
    }

    // end_turn: the JSON answer.
    let answer;
    try { answer = JSON.parse(textOf(res.content)); } catch { throw new Error('Claude did not return a readable answer. Try again.'); }
    const violations = checkAnswer(answer, tools.models);
    if (violations.length && !retried) {
      retried = true;
      onStep({ kind: 'fixing', violations });
      messages.push({
        role: 'user',
        content: `Your answer breaks these rules from the skill. Fix them (call the tools again only if you need to) and answer again in the same format:\n- ${violations.join('\n- ')}`,
      });
      continue;
    }
    return { answer, violations, usage };
  }
  throw new Error('The analysis took too many steps and was stopped.');
}

// Rough cost of a run in US dollars at Claude Opus 5.5 list prices ($4 / $20 per million tokens,
// cache writes 1.25×, cache reads $0.20 per million).
export const costOf = (u) => (u.input * 4 + u.cacheWrite * 5 + u.cacheRead * 0.2 + u.output * 20) / 1e6;
