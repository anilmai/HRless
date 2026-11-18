'use strict'
// USD per 1M tokens, as the public API price list stood on 2026-11-18 (Claude: Anthropic's
// first-party rates; GPT: OpenAI's standard rates; Gemini: Google's paid tier). What a run would cost at API prices: someone on a
// subscription (Claude Max, ChatGPT) does not pay this per token.
// Cache writes default to 1.25x input and cache reads to 0.1x input where a price is not listed.
// Add or correct a price in ~/.hrless/config.json:
//   { "prices": { "gemini-3.8-flash": { "in": 0.3, "out": 2.5, "cacheRead": 0.03 } } }
// A key matches any model whose id contains it; the longest matching key wins.
const BUILTIN = {
  'claude-fable-5-2': { in: 8, out: 40, cacheRead: 0.2 },
  'claude-mythos-5-2': { in: 8, out: 40, cacheRead: 0.2 },
  'claude-fable-5-1': { in: 10, out: 50 },
  'claude-mythos-5-1': { in: 10, out: 50 },
  'claude-fable-5': { in: 10, out: 50 },
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4': { in: 5, out: 25 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-sonnet-4': { in: 3, out: 15 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5 },
  'claude-haiku-4': { in: 1, out: 5 },
  'gpt-6.2-astra': { in: 8, out: 40, cacheRead: 0.4 },
  'gpt-6.2-sol': { in: 2, out: 10, cacheRead: 0.1 },
  'gpt-6.1-sol': { in: 2, out: 10 },
  // shortcut: introductory rate through 2026-12-31 (then $1.50 / $7.50); update it in January.
  'gemini-3.8-flash': { in: 0.75, out: 3.75, cacheRead: 0.075 },
  'gpt-6-luna': { in: 0.1, out: 0.5 },
}

function find(model, extra) {
  if (!model) return null
  const table = { ...BUILTIN, ...(extra || {}) }
  let best = null
  for (const k of Object.keys(table)) if (model.includes(k) && (!best || k.length > best.length)) best = k
  return best ? table[best] : null
}

// use: { in, out, cr, cw } token counts. null when the model has no known price.
function cost(model, use, extra) {
  const p = find(model, extra)
  if (!p || !use) return null
  const n = v => (Number.isFinite(v) ? v : 0)
  const cr = p.cacheRead ?? p.in * 0.1, cw = p.cacheWrite ?? p.in * 1.25
  return (n(use.in) * p.in + n(use.out) * p.out + n(use.cr) * cr + n(use.cw) * cw) / 1e6
}

module.exports = { cost, find }

if (require.main === module) {
  const assert = require('node:assert')
  // 1M input + 1M output on Opus 5.5 = $4 + $20; cache read priced at its listed $0.20.
  assert.strictEqual(cost('claude-opus-5-5', { in: 1e6, out: 1e6 }), 24)
  assert.strictEqual(cost('claude-opus-5-5', { cr: 1e6 }), 0.2)
  // Unlisted cache rates fall back to 0.1x / 1.25x input; longest key wins (opus-5-5 over opus-5).
  assert.strictEqual(cost('claude-opus-5', { cr: 1e6, cw: 1e6 }), 0.5 + 6.25)
  // Codex's GPT-6.2 models, cache reads at their listed rate.
  assert.strictEqual(cost('gpt-6.2-astra', { in: 1e6, out: 1e6, cr: 1e6 }), 8 + 40 + 0.4)
  assert.strictEqual(cost('gpt-6.2-sol', { cr: 1e6 }), 0.1)
  // A config price overrides the built-in one; a model with no price stays null.
  assert.strictEqual(cost('gemini-3.8-flash-high', { in: 1e6 }, { 'gemini-3.8-flash': { in: 0.3, out: 2.5 } }), 0.3)
  assert.strictEqual(cost('gemini-4-hydrogen-medium', { in: 1e6 }), null)
  console.log('prices: ok')
}
