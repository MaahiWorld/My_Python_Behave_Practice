// Free-tier LLM providers for the Match Analyst, all called through their OpenAI-compatible
// chat-completions endpoints straight from the browser with the user's own free API key.
// Model IDs change often: the defaults below can be replaced on the Data sources page, where
// "Test" lists the models the key can use.

export const PROVIDERS = [
  {
    id: 'gemini', name: 'Google Gemini (free tier)', base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash', signup: 'https://aistudio.google.com/apikey',
    cost: 'Free tier · no card needed', note: 'Free key from Google AI Studio. Free-tier requests may be used by Google to improve its models.',
  },
  {
    id: 'groq', name: 'Groq (free tier)', base: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile', signup: 'https://console.groq.com/keys',
    cost: 'Free tier · no card needed', note: 'Very fast open models. The free tier has a low tokens-per-minute limit, so a whole league may need a short wait between steps.',
  },
  {
    id: 'openrouter', name: 'OpenRouter (free models)', base: 'https://openrouter.ai/api/v1',
    model: 'meta-llama/llama-3.3-70b-instruct:free', signup: 'https://openrouter.ai/keys', freeOnly: true,
    cost: 'Free models (IDs ending in :free) · no card needed', note: 'Only models whose ID ends in ":free" are allowed here, so nothing is ever charged. Test lists the free models that support tools.',
  },
  {
    id: 'cerebras', name: 'Cerebras (free tier)', base: 'https://api.cerebras.ai/v1',
    model: 'llama-3.3-70b', signup: 'https://cloud.cerebras.ai/',
    cost: 'Free tier · no card needed', note: 'Fast open models with a daily free token allowance.',
  },
];
export const providerById = (id) => PROVIDERS.find((p) => p.id === id);

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Stopped.')); }, { once: true });
});

export class LLMError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function call(provider, key, path, init = {}, { signal, fetchFn = fetch, retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchFn(provider.base + path, {
        ...init, signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(init.headers || {}) },
      });
    } catch (e) {
      if (signal?.aborted) throw new Error('Stopped.');
      if (attempt >= retries) throw new LLMError(`Could not reach ${provider.name} from this browser.`);
      await sleep(2000 * 2 ** attempt, signal);
      continue;
    }
    if (res.ok) return res.json();
    const text = await res.text().catch(() => '');
    let msg = text;
    try { const j = JSON.parse(text); msg = j.error?.message || j.message || (Array.isArray(j) && j[0]?.error?.message) || text; } catch { /* plain text */ }
    // Free tiers rate-limit hard: wait as told (or back off) and try again.
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const after = parseFloat(res.headers.get('retry-after'));
      await sleep(Number.isFinite(after) ? Math.min(after, 60) * 1000 : 4000 * 2 ** attempt, signal);
      continue;
    }
    const hint = res.status === 401 || res.status === 403 ? ' Check the API key on the Data sources page.'
      : res.status === 429 ? ' The free limit was reached; wait a minute, or pick another provider.' : '';
    throw new LLMError(`${provider.name}: ${res.status} ${String(msg).slice(0, 300)}${hint}`, res.status);
  }
}

// Only free models on providers that also sell paid ones.
export function assertFree(provider, model) {
  if (provider.freeOnly && !String(model).endsWith(':free')) {
    throw new LLMError(`${provider.name}: "${model}" is not a free model. Choose a model whose ID ends in ":free".`);
  }
}

// One chat-completions request. Returns the assistant message ({ content, tool_calls }) and finish reason.
export async function chat(provider, key, model, { messages, tools }, opts = {}) {
  assertFree(provider, model);
  const json = await call(provider, key, '/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', temperature: 0.2 }),
  }, opts);
  const choice = json.choices?.[0];
  if (!choice?.message) throw new LLMError(`${provider.name}: empty reply.`);
  return { message: choice.message, finish: choice.finish_reason, usage: json.usage || {} };
}

// Models the key can use (OpenRouter: free models that support tools only).
export async function listModels(provider, key, opts = {}) {
  const json = await call(provider, key, '/models', { method: 'GET' }, { ...opts, retries: 1 });
  let list = json.data || json.models || [];
  if (provider.freeOnly) list = list.filter((m) => String(m.id).endsWith(':free') && (!m.supported_parameters || m.supported_parameters.includes('tools')));
  return list.map((m) => String(m.id || m.name).replace(/^models\//, '')).filter(Boolean).sort();
}
