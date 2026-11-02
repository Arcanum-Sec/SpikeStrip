import fs from 'node:fs/promises';
import { payloads } from './payloads.mjs';
import { artexPayloads } from './profiles.mjs';

const endpoints = {
  openai: 'https://api.openai.com/v1/responses',
  anthropic: 'https://api.anthropic.com/v1/messages',
};
const normalize = value => value.toLowerCase().replace(/[^a-z0-9]/g, '');

export function validatePayload(text) {
  if (typeof text !== 'string' || text.length < 30 || text.length > 320 ||
      /[^\x20-\x7e]/.test(text) || /\/\*|\*\/|<!--|-->|<\/?[a-z]|https?:\/\//i.test(text))
    throw new Error('Generated payload must be one ASCII line, 30–320 characters, without markup or URLs');
  return text;
}

export function validateDynamic({ provider, model, count, maxOutputTokens = 8192 }) {
  if (!Object.hasOwn(endpoints, provider)) throw new Error('--provider must be openai or anthropic');
  if (typeof model !== 'string' || !model.trim()) throw new Error('--model is required for dynamic generation');
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000)
    throw new Error('Dynamic --count must be between 1 and 1000');
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1024 || maxOutputTokens > 32768)
    throw new Error('--max-output-tokens must be between 1024 and 32768');
}

export async function generatePayloads({ provider, model, count, promptFile,
  referencePayloads = payloads,
  maxOutputTokens = 8192, fetchImpl = globalThis.fetch, env = process.env }) {
  validateDynamic({ provider, model, count, maxOutputTokens });
  const variable = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  const apiKey = env[variable];
  if (!apiKey?.trim()) throw new Error(`Set ${variable} in your environment`);
  const template = await fs.readFile(promptFile ?? new URL('../prompts/generate.txt', import.meta.url), 'utf8');
  if (template.length > 32000) throw new Error('Prompt file exceeds 32,000 characters');
  const seen = new Set([...payloads, ...artexPayloads].map(normalize)), generated = [];
  const usage = [];
  // At most ceil(count / 25) calls; no retries or automatic repair calls.
  while (generated.length < count) {
    const batchSize = Math.min(25, count - generated.length);
    const prompt = template.replaceAll('{{count}}', String(batchSize)) +
      '\n\nReference items to avoid copying:\n' + JSON.stringify(referencePayloads) +
      '\n\nPreviously generated items to avoid copying:\n' + JSON.stringify(generated);
    const schema = { type: 'object', additionalProperties: false,
      required: ['payloads'], properties: { payloads: { type: 'array',
        items: { type: 'string' }, minItems: batchSize, maxItems: batchSize } } };
    const body = provider === 'openai' ? {
      model, input: prompt, store: false, max_output_tokens: maxOutputTokens,
      text: { format: { type: 'json_schema', name: 'source_decoys', strict: true, schema } },
    } : { model, max_tokens: maxOutputTokens,
      messages: [{ role: 'user', content: prompt }] };
    const headers = { 'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}` };
    if (provider === 'anthropic') headers['anthropic-version'] = '2026-10-21';
    let response;
    try {
      response = await fetchImpl(endpoints[provider], { method: 'POST', headers,
        body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(120000) });
    } catch {
      throw new Error(`${provider} request failed or timed out; no retry performed`);
    }
    // Provider response bodies may contain submitted input; never echo errors.
    if (!response.ok) throw new Error(`${provider} returned HTTP ${response.status}; no retry performed`);
    let data;
    try { data = await response.json(); }
    catch { throw new Error(`${provider} returned an invalid JSON response`); }
    if ((provider === 'openai' && data.status !== 'completed') ||
        (provider === 'anthropic' && data.stop_reason !== 'end_turn'))
      throw new Error(`${provider} generation was incomplete or refused`);
    const text = provider === 'openai'
      ? (data.output ?? []).filter(item => item.type === 'message')
        .flatMap(item => item.content ?? []).filter(item => item.type === 'output_text')
        .map(item => item.text).join('')
      : (data.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('');
    let result;
    try { result = JSON.parse(text); }
    catch { throw new Error(`${provider} did not return the requested JSON object`); }
    if (!result || Object.keys(result).length !== 1 || !Array.isArray(result.payloads) ||
        result.payloads.length !== batchSize) throw new Error('Generation returned the wrong number of payloads');
    for (const value of result.payloads) {
      validatePayload(value);
      if (value.includes(apiKey)) throw new Error('Provider output contained credential material');
      const identity = normalize(value);
      if (seen.has(identity)) throw new Error('Generation repeated a built-in or previously generated payload');
      seen.add(identity); generated.push(value);
    }
    usage.push(Object.fromEntries(Object.entries(data.usage ?? {})
      .filter(([name, value]) => /^[a-z_]*tokens$/.test(name) && Number.isFinite(value))));
  }
  return { payloads: generated, provider, model, usage };
}
