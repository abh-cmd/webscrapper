const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');
const { computeBackoffMs, parseRetryAfterMs } = require('../../net/backoff');

// A real LLM provider, generic to any OpenAI-chat-completions-compatible
// endpoint (which covers OpenAI itself, Azure OpenAI, and many
// self-hosted/open model servers). Configured entirely via environment —
// AI_API_BASE_URL, AI_API_KEY, AI_MODEL — never hard-coded credentials.
//
// IMPORTANT, disclosed limitation: no AI_API_KEY is configured anywhere
// in this project's environments as of this writing, so this provider has
// never actually been exercised against a real endpoint — it is
// code-reviewed, not live-verified. tests/ai-provider.test.js and
// tests/ai-http-provider-hardening.test.js prove the request/response
// shape, retry behavior, and error classification against a local mock
// HTTP server standing in for the API, not a real LLM. Do not report this
// provider as "tested live" absent an actual model response.

function requireConfig(env) {
  const baseUrl = env.AI_API_BASE_URL;
  const apiKey = env.AI_API_KEY;
  const model = env.AI_MODEL || 'gpt-4o-mini';
  if (!baseUrl || !apiKey) {
    throw new Error('http-llm-provider requires AI_API_BASE_URL and AI_API_KEY to be set.');
  }
  const timeoutMs = env.AI_REQUEST_TIMEOUT_MS !== undefined ? Number(env.AI_REQUEST_TIMEOUT_MS) : 30000;
  const maxRetries = env.AI_MAX_RETRIES !== undefined ? Number(env.AI_MAX_RETRIES) : 2;
  return { baseUrl, apiKey, model, timeoutMs, maxRetries };
}

// Status codes worth retrying for an LLM API specifically — this is
// deliberately NOT the same set backoff.js uses for web-crawling anti-bot
// responses (that set includes 403, which for an LLM API means "bad API
// key," not "transient block," and retrying it would just burn attempts
// for no reason). 401/403/404/400 fail immediately; 429/5xx get retried.
const RETRYABLE_AI_STATUSES = new Set([429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function postJsonOnce(url, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      reject(Object.assign(new Error(`Invalid AI_API_BASE_URL: ${error.message}`), { type: 'AI_CONFIG_ERROR' }));
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify(body), 'utf8');

    const req = client.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, ...headers },
      timeout: timeoutMs
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(Object.assign(new Error(`AI provider HTTP ${res.statusCode}: ${text.slice(0, 500)}`), {
            type: 'AI_HTTP_ERROR',
            statusCode: res.statusCode,
            retryAfterHeader: res.headers['retry-after'] || null
          }));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(Object.assign(new Error(`AI provider returned non-JSON response: ${error.message}`), { type: 'AI_MALFORMED_RESPONSE' }));
        }
      });
    });

    req.on('timeout', () => req.destroy(Object.assign(new Error('AI provider request timed out'), { type: 'AI_TIMEOUT' })));
    req.on('error', (error) => {
      if (error.type) { reject(error); return; }
      reject(Object.assign(new Error(`AI provider network error: ${error.message}`), { type: 'AI_NETWORK_ERROR', cause: error }));
    });
    req.write(payload);
    req.end();
  });
}

// Bounded retry: up to `maxRetries` additional attempts (never indefinite)
// for a 429/5xx response or a network/timeout error. A 400/401/403/404
// (bad request, bad key, forbidden, not found) fails on the first attempt
// — retrying a bad API key can't ever succeed. Honors a real Retry-After
// header when present; falls back to computeBackoffMs() otherwise (the
// same exponential-backoff-with-jitter primitive the crawl queue uses).
async function postJsonWithRetry(url, body, headers, { timeoutMs, maxRetries }) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await postJsonOnce(url, body, headers, timeoutMs);
    } catch (error) {
      lastError = error;
      const retryableStatus = typeof error.statusCode === 'number' && RETRYABLE_AI_STATUSES.has(error.statusCode);
      const retryableTransient = error.type === 'AI_TIMEOUT' || error.type === 'AI_NETWORK_ERROR';
      const canRetry = (retryableStatus || retryableTransient) && attempt <= maxRetries;
      if (!canRetry) throw error;

      const retryAfterMs = parseRetryAfterMs(error.retryAfterHeader);
      const waitMs = retryAfterMs !== null ? retryAfterMs : computeBackoffMs({ attempt, baseMs: 500, maxMs: 8000 });
      await sleep(waitMs);
    }
  }
  throw lastError;
}

async function chatCompletion(config, messages, { jsonMode = false } = {}) {
  const body = { model: config.model, messages, temperature: 0.2 };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const response = await postJsonWithRetry(
    `${config.baseUrl.replace(/\/$/, '')}/chat/completions`,
    body,
    { Authorization: `Bearer ${config.apiKey}` },
    { timeoutMs: config.timeoutMs, maxRetries: config.maxRetries }
  );

  const content = response?.choices?.[0]?.message?.content;
  if (!content) throw Object.assign(new Error('AI provider response had no message content.'), { type: 'AI_INVALID_RESPONSE_SCHEMA' });
  return content;
}

async function paraphrase({ text, kind }, env = process.env) {
  if (!text) {
    return { text: null, changed: false, provider: 'http-llm', model: null };
  }

  const config = requireConfig(env);
  const fieldLabel = kind === 'food_pairing' ? 'food pairing recommendation' : 'product description';

  const content = await chatCompletion(config, [
    {
      role: 'system',
      content: 'You paraphrase wine product text for a retail catalog. Preserve every factual detail (wine style, flavors, pairing suggestions) and the original intent. Use natural, customer-friendly language. Never invent facts not present in the source text. Return only the rewritten text, nothing else.'
    },
    { role: 'user', content: `Rewrite this ${fieldLabel}:\n\n${text}` }
  ]);

  return { text: content.trim(), changed: content.trim() !== text, provider: 'http-llm', model: config.model, kind };
}

async function analyzeProduct(product, env = process.env) {
  const config = requireConfig(env);

  const content = await chatCompletion(config, [
    {
      role: 'system',
      content: 'You review wine catalog product records for data quality issues: incorrect attribute values, missing attributes, and inconsistent information. Every finding is a RECOMMENDATION derived from the record\'s own internal consistency (e.g. a varietal implying a color that contradicts the stored color) — never invent a fact that is not evidenced by the record itself, and never claim outside/world knowledge not present in the input as if it were a source fact. Respond with a JSON object: {"findings": [{"field": string, "currentValue": string|null, "suggestedValue": string|null, "confidence": number (0-100), "reason": string}]}. Only include a finding when you have a concrete, statable reason grounded in the record you were given. Never fabricate a correction you are not reasonably confident about.'
    },
    { role: 'user', content: JSON.stringify(product) }
  ], { jsonMode: true });

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw Object.assign(new Error(`AI provider's message content was not valid JSON: ${error.message}`), { type: 'AI_MALFORMED_RESPONSE' });
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.findings)) {
    throw Object.assign(new Error('AI provider response did not match the expected {findings: [...]} schema.'), { type: 'AI_INVALID_RESPONSE_SCHEMA' });
  }

  return { findings: parsed.findings, provider: 'http-llm', model: config.model };
}

module.exports = { paraphrase, analyzeProduct, requireConfig, RETRYABLE_AI_STATUSES };
