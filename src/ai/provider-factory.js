const deterministicProvider = require('./providers/deterministic-test-provider');
const httpLlmProvider = require('./providers/http-llm-provider');

// AI_PROVIDER env var selects the implementation: 'http' for a real
// configured LLM endpoint, 'none' to disable AI enrichment entirely
// (paraphrase becomes a no-op passthrough, analyzeProduct returns no
// findings), or the default 'deterministic-test' — safe by construction,
// since it never makes a network call or claims to be real AI, so nothing
// here silently starts spending money on a real API without an explicit
// AI_PROVIDER=http opt-in.

const NOOP_PROVIDER = {
  async paraphrase({ text, kind }) {
    return { text, changed: false, provider: 'none', model: null, kind };
  },
  async analyzeProduct() {
    return { findings: [], provider: 'none', model: null };
  }
};

function getAiProvider(env = process.env) {
  const selected = env.AI_PROVIDER || 'deterministic-test';

  if (selected === 'none') return NOOP_PROVIDER;
  if (selected === 'http') return httpLlmProvider;
  if (selected === 'deterministic-test') return deterministicProvider;

  throw new Error(`Unknown AI_PROVIDER: "${selected}". Expected 'deterministic-test', 'http', or 'none'.`);
}

module.exports = { getAiProvider, NOOP_PROVIDER };
