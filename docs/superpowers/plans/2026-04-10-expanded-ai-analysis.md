# Expanded AI Analysis Calls — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add five new AI call points to PredictIQ — AI sentiment batch, Signal 5 Lite, risk narratives, cluster analysis, and delta briefing — spanning accuracy, coverage, and features goals.

**Architecture:** New functions added to `agent/ai-engine.js`; `agent/analyzer.js` wired to call them in pipeline order; `server/agent-runner.js` handles post-run delta briefing; `server/cache.js` and `server/routes.js` expose cluster analysis. `runFullAnalysis()` gains an optional `prevPredictionsMap` parameter for cache lookups.

**Tech Stack:** Node.js, `@anthropic-ai/sdk`, Jest (new dev dependency), Express

---

## File Map

| File | Change |
|------|--------|
| `agent/ai-engine.js` | Add 5 exported functions + 5 model constants |
| `agent/analyzer.js` | Update `runFullAnalysis` signature; add AI sentiment, Signal 5 Lite, risk narratives, cluster analysis blocks; update `scorePrediction` signature |
| `server/agent-runner.js` | Add `prevPredictionsMap` build; add delta briefing post-run; update `updateCache` call with `clusterAnalysis` |
| `server/cache.js` | Add `clusterAnalysis: null` to initial cache shape |
| `server/routes.js` | Add `GET /api/clusters` endpoint |
| `tests/ai-engine.test.js` | New — Jest tests for all 5 functions |
| `package.json` | Add Jest dev dependency + `"test"` script |

---

## Task 1: Install Jest

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install Jest**

```bash
npm install --save-dev jest
```

Expected output: `added N packages` with no errors.

- [ ] **Step 2: Add test script to package.json**

In `package.json`, update the `"scripts"` block and add a `"jest"` config block:

```json
"scripts": {
  "dev": "concurrently -n \"API,UI\" -c \"cyan,magenta\" \"node server.js\" \"vite\"",
  "server": "node server.js",
  "client": "vite",
  "build": "vite build",
  "start": "node server.js",
  "collect": "node collect.js",
  "test": "jest"
},
"jest": {
  "testEnvironment": "node"
},
```

- [ ] **Step 3: Create tests directory and smoke-test Jest**

```bash
mkdir -p tests
echo "test('sanity', () => { expect(1 + 1).toBe(2); });" > tests/sanity.test.js
npm test
```

Expected: `Tests: 1 passed`.

- [ ] **Step 4: Delete sanity file and commit**

```bash
rm tests/sanity.test.js
git add package.json package-lock.json
git commit -m "chore: add Jest for unit testing"
```

---

## Task 2: Write tests for `analyzeSentimentBatch`

**Files:**
- Create: `tests/ai-engine.test.js`

- [ ] **Step 1: Create the test file with mock setup**

```js
// tests/ai-engine.test.js

// Must be called before any require() so Jest can hoist correctly.
jest.mock('@anthropic-ai/sdk');

const Anthropic = require('@anthropic-ai/sdk');

// Helper: configure the mock to return a given API response text
function mockApiResponse(text) {
  const mockCreate = jest.fn().mockResolvedValue({
    content: [{ text }],
  });
  Anthropic.mockImplementation(() => ({
    messages: { create: mockCreate },
  }));
  return mockCreate;
}

// Re-require ai-engine fresh each test (it uses a module-level singleton _client)
let aiEngine;
beforeEach(() => {
  jest.resetModules();
  jest.mock('@anthropic-ai/sdk');
  process.env.ANTHROPIC_API_KEY = 'test-key';
  aiEngine = require('../agent/ai-engine');
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

// ── analyzeSentimentBatch ─────────────────────────────────────────────────────

describe('analyzeSentimentBatch', () => {
  const markets = [
    { id: 'mkt-1', title: 'Will the Fed cut rates in June?', volume: 5000 },
    { id: 'mkt-2', title: 'Will Trump win 2024?', volume: 8000 },
  ];
  const articles = [
    { title: 'Fed signals patience on rates', source: 'Reuters', credibility: 1.5, publishedAt: new Date().toISOString() },
  ];

  test('returns a Map with entries for each market', async () => {
    mockApiResponse(
      JSON.stringify([
        { id: 'mkt-1', sentimentScore: -0.3, sentimentLabel: 'bearish', confidence: 0.7 },
        { id: 'mkt-2', sentimentScore:  0.4, sentimentLabel: 'bullish', confidence: 0.6 },
      ]).slice(1) // strip leading '[' because ai-engine prefills it
    );
    const result = await aiEngine.analyzeSentimentBatch(markets, articles);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(2);
    expect(result.get('mkt-1').sentimentScore).toBeCloseTo(-0.3);
    expect(result.get('mkt-1').analyzedAt).toBeDefined();
  });

  test('returns empty Map when markets array is empty', async () => {
    const result = await aiEngine.analyzeSentimentBatch([], articles);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  test('returns empty Map and does not throw on API failure', async () => {
    Anthropic.mockImplementation(() => ({
      messages: { create: jest.fn().mockRejectedValue(new Error('network error')) },
    }));
    const result = await aiEngine.analyzeSentimentBatch(markets, articles);
    expect(result).toBeInstanceOf(Map);
    // Graceful degradation — no entries, no throw
    expect(result.size).toBe(0);
  });

  test('returns cached entry without calling API when cache is fresh', async () => {
    const mockCreate = mockApiResponse('[]');
    const prevPredictionsMap = new Map([
      ['mkt-1', {
        aiSentiment: {
          sentimentScore: 0.2,
          sentimentLabel: 'bullish',
          confidence: 0.8,
          analyzedAt: new Date().toISOString(), // fresh
        },
      }],
    ]);
    const result = await aiEngine.analyzeSentimentBatch([markets[0]], articles, prevPredictionsMap);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(result.get('mkt-1').sentimentScore).toBeCloseTo(0.2);
  });

  test('clamps sentimentScore to [-1, 1]', async () => {
    mockApiResponse(
      JSON.stringify([
        { id: 'mkt-1', sentimentScore: 5.0, sentimentLabel: 'bullish', confidence: 0.9 },
      ]).slice(1)
    );
    const result = await aiEngine.analyzeSentimentBatch([markets[0]], articles);
    expect(result.get('mkt-1').sentimentScore).toBe(1);
  });
});
```

- [ ] **Step 2: Run — confirm all tests fail with "not a function"**

```bash
npm test -- --testPathPattern=ai-engine
```

Expected: `TypeError: aiEngine.analyzeSentimentBatch is not a function`

---

## Task 3: Implement `analyzeSentimentBatch` in `ai-engine.js`

**Files:**
- Modify: `agent/ai-engine.js`

- [ ] **Step 1: Add model constant after existing model constants (line ~35)**

```js
const SENTIMENT_MODEL      = () => process.env.AI_SENTIMENT_MODEL      || 'claude-haiku-4-5-20251001';
const LITE_MODEL           = () => process.env.AI_LITE_MODEL           || 'claude-haiku-4-5-20251001';
const RISK_NARRATIVE_MODEL = () => process.env.AI_RISK_NARRATIVE_MODEL || 'claude-haiku-4-5-20251001';
const CLUSTER_MODEL        = () => process.env.AI_CLUSTER_MODEL        || 'claude-sonnet-4-6';
const DELTA_MODEL          = () => process.env.AI_DELTA_MODEL          || 'claude-haiku-4-5-20251001';
```

- [ ] **Step 2: Add `analyzeSentimentBatch` function before `module.exports`**

```js
// ─────────────────────────────────────────────────────────────────────────────
// analyzeSentimentBatch
//
// Replaces keyword-based Signal 2 for high-volume markets.
// Returns Map<marketId, { sentimentScore, sentimentLabel, confidence, analyzedAt }>
// Markets not in the result map fall back to keyword scoring — no regression.
// ─────────────────────────────────────────────────────────────────────────────
async function analyzeSentimentBatch(markets, articles, prevPredictionsMap = new Map()) {
  if (!markets.length) return new Map();

  const CACHE_HOURS = parseFloat(process.env.AI_CACHE_HOURS || '6');
  const cacheMs     = CACHE_HOURS * 3_600_000;

  // Start with cached results from previous run
  const resultMap = new Map();
  for (const m of markets) {
    const cached = prevPredictionsMap.get(m.id)?.aiSentiment;
    if (cached?.analyzedAt && (Date.now() - new Date(cached.analyzedAt).getTime()) <= cacheMs) {
      resultMap.set(m.id, cached);
    }
  }

  // Only call API for markets with stale or missing cache
  const toAnalyze = markets.filter(m => !resultMap.has(m.id));
  if (!toAnalyze.length) return resultMap;

  const client    = getClient();
  const BATCH_SIZE = 10;

  for (let i = 0; i < toAnalyze.length; i += BATCH_SIZE) {
    const batch = toAnalyze.slice(i, i + BATCH_SIZE);

    const marketBlocks = batch.map((m, idx) => {
      const keywords  = m.title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const relevant  = articles
        .filter(a => keywords.some(kw => a.title?.toLowerCase().includes(kw)))
        .sort((a, b) => (b.credibility || 1) - (a.credibility || 1))
        .slice(0, 5);
      const headlineLines = relevant.length
        ? relevant.map(a => `   - "${a.title}" — ${a.source || 'Unknown'}`).join('\n')
        : '   (no relevant headlines found)';
      return `${idx + 1}. [id: "${m.id}"] "${m.title}"\n   Headlines:\n${headlineLines}`;
    }).join('\n\n');

    const prompt = `You are a sentiment analyst for prediction markets. For each market, score the sentiment toward the YES outcome based on the provided headlines.

${marketBlocks}

Return a JSON array in the same order (${batch.length} objects):
[
  {
    "id": "<market id>",
    "sentimentScore": <-1.0 to 1.0, negative=bearish/NO favored, positive=bullish/YES favored>,
    "sentimentLabel": "strongly_bearish"|"bearish"|"neutral"|"bullish"|"strongly_bullish",
    "confidence": <0.0-1.0, lower when fewer relevant headlines>
  }
]

Rules: 0.0 = no signal. confidence < 0.3 when fewer than 2 relevant headlines.`;

    try {
      const message = await client.messages.create({
        model:      SENTIMENT_MODEL(),
        max_tokens: 400,
        messages: [
          { role: 'user',      content: prompt },
          { role: 'assistant', content: '['    }, // prefill — model continues as JSON array
        ],
      });

      const raw     = '[' + (message.content[0]?.text?.trim() || '');
      const results = JSON.parse(raw);

      for (const r of results) {
        if (typeof r.id === 'string' && typeof r.sentimentScore === 'number') {
          resultMap.set(r.id, {
            sentimentScore: clamp(r.sentimentScore, -1, 1),
            sentimentLabel: r.sentimentLabel || 'neutral',
            confidence:     clamp(r.confidence || 0.5, 0, 1),
            analyzedAt:     new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      console.error(`[AIEngine] analyzeSentimentBatch failed (batch ${i}):`, err.message);
      // Graceful degradation — markets in this batch fall back to keyword scoring
    }
  }

  return resultMap;
}
```

- [ ] **Step 3: Update `module.exports` at the bottom of ai-engine.js**

```js
module.exports = { analyzeMarketWithAI, generateBriefing, answerQuestion, analyzeSentimentBatch };
```

- [ ] **Step 4: Run tests — confirm sentiment batch tests pass**

```bash
npm test -- --testPathPattern=ai-engine
```

Expected: `analyzeSentimentBatch` describe block: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add agent/ai-engine.js tests/ai-engine.test.js
git commit -m "feat: add analyzeSentimentBatch to ai-engine"
```

---

## Task 4: Write tests for `analyzeMarketWithAILite`

**Files:**
- Modify: `tests/ai-engine.test.js`

- [ ] **Step 1: Add test block after existing describe blocks**

```js
// ── analyzeMarketWithAILite ───────────────────────────────────────────────────

describe('analyzeMarketWithAILite', () => {
  const market = { id: 'mkt-3', title: 'Will BTC reach $100k?', bestYes: 0.35, volume: 75, platform: 'Kalshi' };

  test('returns expected shape with estimatedProbability', async () => {
    mockApiResponse(
      JSON.stringify({
        estimatedProbability: 0.28,
        confidence: 0.5,
        reasoning: 'BTC has been volatile and current momentum is negative.',
        keyFactors: [{ direction: 'down', text: 'Recent sell-off pressure' }],
        flags: [],
      }).slice(1)
    );
    const result = await aiEngine.analyzeMarketWithAILite(market, [], []);
    expect(result.estimatedProbability).toBeCloseTo(0.28);
    expect(result.signalSource).toBe('claude-lite');
    expect(result.analyzedAt).toBeDefined();
    expect(result.modelUsed).toBeDefined();
  });

  test('returns null on API failure', async () => {
    Anthropic.mockImplementation(() => ({
      messages: { create: jest.fn().mockRejectedValue(new Error('timeout')) },
    }));
    const result = await aiEngine.analyzeMarketWithAILite(market, [], []);
    expect(result).toBeNull();
  });

  test('clamps estimatedProbability to [0.02, 0.98]', async () => {
    mockApiResponse(
      JSON.stringify({ estimatedProbability: 0.001, confidence: 0.5, reasoning: 'x', keyFactors: [], flags: [] }).slice(1)
    );
    const result = await aiEngine.analyzeMarketWithAILite(market, [], []);
    expect(result.estimatedProbability).toBeGreaterThanOrEqual(0.02);
  });
});
```

- [ ] **Step 2: Run — confirm new tests fail**

```bash
npm test -- --testPathPattern=ai-engine
```

Expected: `TypeError: aiEngine.analyzeMarketWithAILite is not a function`

---

## Task 5: Implement `analyzeMarketWithAILite` in `ai-engine.js`

**Files:**
- Modify: `agent/ai-engine.js`

- [ ] **Step 1: Add function before `module.exports`**

```js
// ─────────────────────────────────────────────────────────────────────────────
// analyzeMarketWithAILite
//
// Lightweight Signal 5 for below-threshold markets (EV 0.01–0.03 or vol 50–100).
// Shorter prompt, 200 max_tokens, Haiku model.
// Returns same shape as analyzeMarketWithAI with signalSource: 'claude-lite'.
// ─────────────────────────────────────────────────────────────────────────────
async function analyzeMarketWithAILite(market, topArticles = [], existingSignals = []) {
  try {
    const client = getClient();

    const articleLines = topArticles.slice(0, 5).map((a, i) =>
      `${i + 1}. "${a.title}" — ${a.source || 'Unknown'}`
    ).join('\n');

    const signalLines = existingSignals.map(s =>
      `• ${s.label}: ${Math.round(s.prob * 100)}%`
    ).join('\n');

    const impliedProb = Math.round((market.bestYes || 0) * 100);
    const closes = market.closes
      ? `Closes: ${new Date(market.closes).toLocaleDateString()}`
      : 'Close date: unknown';

    const prompt = `Prediction market: "${market.title}"
Platform: ${market.platform}
Price (YES): ${impliedProb}¢ | Volume: $${(market.volume || 0).toLocaleString()} | ${closes}

News (top 5):
${articleLines || 'None.'}

Existing signals:
${signalLines || 'None.'}

Respond with JSON only — no prose:
{"estimatedProbability": <0.0-1.0>, "confidence": <0.0-1.0>, "reasoning": "<1-2 sentences>", "keyFactors": [{"direction": "up"|"down"|"warn", "text": "<≤80 chars>"}], "flags": []}`;

    const message = await client.messages.create({
      model:      LITE_MODEL(),
      max_tokens: 200,
      messages: [
        { role: 'user',      content: prompt },
        { role: 'assistant', content: '{'    },
      ],
    });

    const raw    = '{' + (message.content[0]?.text?.trim() || '');
    const result = JSON.parse(raw);

    if (typeof result.estimatedProbability !== 'number') throw new Error('Missing estimatedProbability');
    result.estimatedProbability = clamp(result.estimatedProbability, 0.02, 0.98);
    result.confidence           = clamp(result.confidence || 0.4, 0, 1);
    result.keyFactors           = Array.isArray(result.keyFactors) ? result.keyFactors.slice(0, 2) : [];
    result.reasoning            = result.reasoning || '';
    result.flags                = Array.isArray(result.flags) ? result.flags : [];
    result.analyzedAt           = new Date().toISOString();
    result.priceAtAnalysis      = market.bestYes ?? null;
    result.modelUsed            = LITE_MODEL();
    result.signalSource         = 'claude-lite';

    return result;
  } catch (err) {
    console.error(`[AIEngine] analyzeMarketWithAILite failed for ${market.id}:`, err.message);
    return null;
  }
}
```

- [ ] **Step 2: Update `module.exports`**

```js
module.exports = { analyzeMarketWithAI, generateBriefing, answerQuestion, analyzeSentimentBatch, analyzeMarketWithAILite };
```

- [ ] **Step 3: Run tests — confirm all pass**

```bash
npm test -- --testPathPattern=ai-engine
```

Expected: all tests in `analyzeSentimentBatch` and `analyzeMarketWithAILite` pass.

- [ ] **Step 4: Commit**

```bash
git add agent/ai-engine.js tests/ai-engine.test.js
git commit -m "feat: add analyzeMarketWithAILite to ai-engine"
```

---

## Task 6: Write tests for `generateRiskNarratives`, `generateClusterAnalysis`, `generateDeltaBriefing`

**Files:**
- Modify: `tests/ai-engine.test.js`

- [ ] **Step 1: Add three new describe blocks**

```js
// ── generateRiskNarratives ────────────────────────────────────────────────────

describe('generateRiskNarratives', () => {
  const preds = [
    { id: 'mkt-4', title: 'Will Congress pass the bill?', riskScore: 0.75, volume: 80, closes: new Date(Date.now() + 86400000).toISOString() },
    { id: 'mkt-5', title: 'Will BTC drop below $50k?',   riskScore: 0.80, volume: 50, closes: null },
  ];

  test('returns a Map with a narrative for each market', async () => {
    mockApiResponse(
      JSON.stringify([
        { id: 'mkt-4', riskNarrative: 'Expires tomorrow with thin volume and wide spread.' },
        { id: 'mkt-5', riskNarrative: 'No close date and very low liquidity.' },
      ]).slice(1)
    );
    const result = await aiEngine.generateRiskNarratives(preds);
    expect(result).toBeInstanceOf(Map);
    expect(result.get('mkt-4')).toContain('tomorrow');
    expect(result.get('mkt-5')).toBeDefined();
  });

  test('returns empty Map for empty input', async () => {
    const result = await aiEngine.generateRiskNarratives([]);
    expect(result.size).toBe(0);
  });

  test('truncates narratives longer than 120 chars', async () => {
    mockApiResponse(
      JSON.stringify([{ id: 'mkt-4', riskNarrative: 'x'.repeat(200) }]).slice(1)
    );
    const result = await aiEngine.generateRiskNarratives([preds[0]]);
    expect(result.get('mkt-4').length).toBeLessThanOrEqual(120);
  });
});

// ── generateClusterAnalysis ───────────────────────────────────────────────────

describe('generateClusterAnalysis', () => {
  const preds = [
    { id: 'p1', title: 'Fed rate cut June?',   platform: 'Kalshi',    currentPrice: 0.4, estimatedProbability: 0.45, category: 'economics' },
    { id: 'p2', title: 'Trump wins 2024?',     platform: 'PredictIt', currentPrice: 0.5, estimatedProbability: 0.48, category: 'politics'  },
    { id: 'p3', title: 'BTC above $100k?',     platform: 'Polymarket',currentPrice: 0.3, estimatedProbability: 0.28, category: 'crypto'   },
  ];

  test('returns clusters and inconsistencies', async () => {
    Anthropic.mockImplementation(() => ({
      messages: {
        create: jest.fn().mockResolvedValue({
          content: [{ text: JSON.stringify({
            clusters: [
              { theme: 'Monetary Policy', marketIds: [1], summary: 'Fed rate decisions.' },
              { theme: 'US Politics',     marketIds: [2], summary: 'Election outcomes.'   },
            ],
            inconsistencies: [],
          }) }],
        }),
      },
    }));
    const result = await aiEngine.generateClusterAnalysis(preds);
    expect(result.clusters).toHaveLength(2);
    expect(result.clusters[0].theme).toBe('Monetary Policy');
    expect(result.clusters[0].marketIds).toContain('p1');
    expect(result.inconsistencies).toEqual([]);
    expect(result.generatedAt).toBeDefined();
  });

  test('returns null on API failure', async () => {
    Anthropic.mockImplementation(() => ({
      messages: { create: jest.fn().mockRejectedValue(new Error('quota exceeded')) },
    }));
    const result = await aiEngine.generateClusterAnalysis(preds);
    expect(result).toBeNull();
  });

  test('returns null for empty predictions', async () => {
    const result = await aiEngine.generateClusterAnalysis([]);
    expect(result).toBeNull();
  });
});

// ── generateDeltaBriefing ─────────────────────────────────────────────────────

describe('generateDeltaBriefing', () => {
  const deltas = [
    { id: 'p1', title: 'Fed rate cut June?', prevEstimate: 0.40, newEstimate: 0.52, topArticles: [{ title: 'CPI falls to 2.9%', source: 'Reuters' }] },
  ];

  test('returns a Map with delta notes', async () => {
    mockApiResponse(
      JSON.stringify([{ id: 'p1', deltaNote: 'CPI data surprised to the downside, raising cut probability.' }]).slice(1)
    );
    const result = await aiEngine.generateDeltaBriefing(deltas);
    expect(result).toBeInstanceOf(Map);
    expect(result.get('p1')).toContain('CPI');
  });

  test('returns empty Map for empty input without calling API', async () => {
    const mockCreate = mockApiResponse('[]');
    const result = await aiEngine.generateDeltaBriefing([]);
    expect(result.size).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('returns empty Map on API failure', async () => {
    Anthropic.mockImplementation(() => ({
      messages: { create: jest.fn().mockRejectedValue(new Error('server error')) },
    }));
    const result = await aiEngine.generateDeltaBriefing(deltas);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  test('truncates deltaNote to 160 chars', async () => {
    mockApiResponse(
      JSON.stringify([{ id: 'p1', deltaNote: 'z'.repeat(300) }]).slice(1)
    );
    const result = await aiEngine.generateDeltaBriefing(deltas);
    expect(result.get('p1').length).toBeLessThanOrEqual(160);
  });
});
```

- [ ] **Step 2: Run — confirm new tests fail**

```bash
npm test -- --testPathPattern=ai-engine
```

Expected: `TypeError: aiEngine.generateRiskNarratives is not a function` (and similar for others).

---

## Task 7: Implement `generateRiskNarratives`, `generateClusterAnalysis`, `generateDeltaBriefing`

**Files:**
- Modify: `agent/ai-engine.js`

- [ ] **Step 1: Add `generateRiskNarratives` before `module.exports`**

```js
// ─────────────────────────────────────────────────────────────────────────────
// generateRiskNarratives
//
// One Haiku call per batch of 30 high-risk markets.
// Returns Map<marketId, riskNarrative (≤120 chars)>.
// No caching — risk scores change each run and Haiku calls are cheap.
// ─────────────────────────────────────────────────────────────────────────────
async function generateRiskNarratives(predictions) {
  if (!predictions.length) return new Map();

  const client     = getClient();
  const resultMap  = new Map();
  const BATCH_SIZE = 30;

  for (let i = 0; i < predictions.length; i += BATCH_SIZE) {
    const batch = predictions.slice(i, i + BATCH_SIZE);

    const marketLines = batch.map((p, idx) => {
      const days    = p.closes ? Math.round((new Date(p.closes) - Date.now()) / 86_400_000) : null;
      const timeStr = days !== null ? `closes in ${days}d` : 'no close date';
      return `${idx + 1}. [id: "${p.id}"] "${p.title}" — risk ${Math.round(p.riskScore * 100)}%, ${timeStr}, vol $${(p.volume || 0).toLocaleString()}`;
    }).join('\n');

    const prompt = `For each high-risk prediction market, write a single plain-English sentence (≤120 chars) explaining WHY it is high-risk. Focus on the specific risk: thin liquidity, imminent expiry, wide spread, or sparse news coverage.

${marketLines}

Return JSON array in the same order:
[{"id": "<market id>", "riskNarrative": "<≤120 char explanation>"}]`;

    try {
      const message = await client.messages.create({
        model:      RISK_NARRATIVE_MODEL(),
        max_tokens: 600,
        messages: [
          { role: 'user',      content: prompt },
          { role: 'assistant', content: '['    },
        ],
      });

      const raw     = '[' + (message.content[0]?.text?.trim() || '');
      const results = JSON.parse(raw);

      for (const r of results) {
        if (typeof r.id === 'string' && typeof r.riskNarrative === 'string') {
          resultMap.set(r.id, r.riskNarrative.slice(0, 120));
        }
      }
    } catch (err) {
      console.error(`[AIEngine] generateRiskNarratives failed (batch ${i}):`, err.message);
    }
  }

  return resultMap;
}
```

- [ ] **Step 2: Add `generateClusterAnalysis` before `module.exports`**

```js
// ─────────────────────────────────────────────────────────────────────────────
// generateClusterAnalysis
//
// Single Sonnet call on the top 50 predictions per run.
// Returns { clusters, inconsistencies, generatedAt } or null on error.
// ─────────────────────────────────────────────────────────────────────────────
async function generateClusterAnalysis(predictions) {
  if (!predictions.length) return null;

  try {
    const client = getClient();
    const top50  = predictions.slice(0, 50);

    const marketLines = top50.map((p, i) => {
      const mkt = Math.round(p.currentPrice * 100);
      const est = Math.round(p.estimatedProbability * 100);
      return `${i + 1}. [${p.platform}] "${p.title}" — market ${mkt}%, est ${est}%, category: ${p.category || 'unknown'}`;
    }).join('\n');

    const prompt = `You are a prediction market analyst. Below are today's top predictions.

${marketLines}

Group these into 3-6 thematic clusters and flag any cross-market inconsistencies (where two markets imply contradictory outcomes).

Return JSON only:
{
  "clusters": [
    {
      "theme": "<short name ≤40 chars>",
      "marketIds": [<1-based indices>],
      "summary": "<1-2 sentences>"
    }
  ],
  "inconsistencies": [
    {
      "marketIndices": [<1-based index>, <1-based index>],
      "note": "<≤160 char explanation of contradiction>"
    }
  ]
}

Rules: 3-6 clusters, 0-3 inconsistencies (only genuine logical contradictions), empty array is fine.`;

    const message = await client.messages.create({
      model:      CLUSTER_MODEL(),
      max_tokens: 800,
      messages:   [{ role: 'user', content: prompt }],
    });

    const raw    = message.content[0]?.text?.trim() || '';
    const result = JSON.parse(raw);

    const clusters = (result.clusters || []).map(c => ({
      theme:     c.theme || '',
      marketIds: (c.marketIds || []).map(idx => top50[idx - 1]?.id).filter(Boolean),
      summary:   c.summary || '',
    }));

    const inconsistencies = (result.inconsistencies || [])
      .map(inc => ({
        marketIds: (inc.marketIndices || []).map(idx => top50[idx - 1]?.id).filter(Boolean),
        note:      inc.note || '',
      }))
      .filter(inc => inc.marketIds.length >= 2);

    return { clusters, inconsistencies, generatedAt: new Date().toISOString() };
  } catch (err) {
    console.error('[AIEngine] generateClusterAnalysis failed:', err.message);
    return null;
  }
}
```

- [ ] **Step 3: Add `generateDeltaBriefing` before `module.exports`**

```js
// ─────────────────────────────────────────────────────────────────────────────
// generateDeltaBriefing
//
// Called post-run when a top pick's estimate shifts > AI_DELTA_THRESHOLD.
// Returns Map<marketId, deltaNote (≤160 chars)> or empty Map on error.
// ─────────────────────────────────────────────────────────────────────────────
async function generateDeltaBriefing(deltas) {
  if (!deltas.length) return new Map();

  try {
    const client = getClient();

    const deltaLines = deltas.map((d, i) => {
      const prev      = Math.round(d.prevEstimate * 100);
      const curr      = Math.round(d.newEstimate  * 100);
      const dir       = curr > prev ? '▲' : '▼';
      const headlines = (d.topArticles || []).slice(0, 3)
        .map(a => `"${a.title}" — ${a.source || 'Unknown'}`)
        .join('; ');
      return `${i + 1}. [id: "${d.id}"] "${d.title}"\n   ${dir} ${prev}% → ${curr}% | Recent: ${headlines || 'no new headlines'}`;
    }).join('\n\n');

    const prompt = `For each prediction market below, the AI estimate has shifted significantly since the last hourly run. Write a single plain-English sentence (≤160 chars) explaining what likely drove the change, referencing the recent headlines.

${deltaLines}

Return JSON array in same order:
[{"id": "<market id>", "deltaNote": "<≤160 char explanation>"}]`;

    const message = await client.messages.create({
      model:      DELTA_MODEL(),
      max_tokens: 500,
      messages: [
        { role: 'user',      content: prompt },
        { role: 'assistant', content: '['    },
      ],
    });

    const raw     = '[' + (message.content[0]?.text?.trim() || '');
    const results = JSON.parse(raw);

    const resultMap = new Map();
    for (const r of results) {
      if (typeof r.id === 'string' && typeof r.deltaNote === 'string') {
        resultMap.set(r.id, r.deltaNote.slice(0, 160));
      }
    }
    return resultMap;
  } catch (err) {
    console.error('[AIEngine] generateDeltaBriefing failed:', err.message);
    return new Map();
  }
}
```

- [ ] **Step 4: Update `module.exports`**

```js
module.exports = {
  analyzeMarketWithAI,
  generateBriefing,
  answerQuestion,
  analyzeSentimentBatch,
  analyzeMarketWithAILite,
  generateRiskNarratives,
  generateClusterAnalysis,
  generateDeltaBriefing,
};
```

- [ ] **Step 5: Run full test suite — all tests pass**

```bash
npm test
```

Expected: all tests pass, no failures.

- [ ] **Step 6: Commit**

```bash
git add agent/ai-engine.js tests/ai-engine.test.js
git commit -m "feat: add generateRiskNarratives, generateClusterAnalysis, generateDeltaBriefing to ai-engine"
```

---

## Task 8: Wire AI Sentiment Batch + Signal 5 Lite into `analyzer.js`

**Files:**
- Modify: `agent/analyzer.js`

- [ ] **Step 1: Update imports at the top of `analyzer.js`**

Replace the existing `ai-engine` import line:

```js
const { analyzeMarketWithAI, generateBriefing, analyzeSentimentBatch, analyzeMarketWithAILite, generateClusterAnalysis } = require('./ai-engine');
```

- [ ] **Step 2: Update `runFullAnalysis` signature to accept `prevPredictionsMap`**

```js
async function runFullAnalysis(onProgress = () => {}, prevPredictionsMap = new Map()) {
```

- [ ] **Step 3: Add AI sentiment batch call after the parallel fetch block, before the scoring loop**

Find the line `onProgress(50, ...)` and insert before it:

```js
  // ── AI Sentiment Batch (Signal 2 upgrade for high-volume markets) ──────────
  let aiSentimentMap = new Map();
  if (process.env.ANTHROPIC_API_KEY) {
    const SENTIMENT_MIN_VOL = parseFloat(process.env.AI_SENTIMENT_MIN_VOLUME || '500');
    const sentimentMarkets  = allMarkets.filter(m => (m.volume || 0) >= SENTIMENT_MIN_VOL);
    if (sentimentMarkets.length > 0) {
      onProgress(48, `AI sentiment batch: ${sentimentMarkets.length} high-volume markets…`);
      aiSentimentMap = await analyzeSentimentBatch(sentimentMarkets, allArticles, prevPredictionsMap);
      console.log(`[Analyzer] AI sentiment: ${aiSentimentMap.size} markets scored`);
    }
  }

```

- [ ] **Step 4: Pass `aiSentimentMap` into the scoring loop**

Find `const scored = scorePrediction(allMarkets[i], ...)` and update it:

```js
    const scored = scorePrediction(allMarkets[i], allArticles, economicData, oddsData, financialData, pollingData, aiSentimentMap);
```

- [ ] **Step 5: Update `scorePrediction` signature to accept `aiSentimentMap`**

```js
function scorePrediction(market, articles, economicData, oddsData = {}, financialData = {}, pollingData = {}, aiSentimentMap = new Map()) {
```

- [ ] **Step 6: Update the Signal 2 block in `scorePrediction` to use AI sentiment when available**

Find the Signal 2 block and replace it:

```js
    // ── Signal 2: News sentiment ───────────────────────────────────────────
    const sentimentData = analyzeMarketSentiment(market, articles);
    const { relevantCount, topArticles } = sentimentData;

    // AI sentiment overrides keyword scoring for high-volume markets
    const aiSent        = aiSentimentMap.get(market.id);
    const sentimentScore = aiSent ? aiSent.sentimentScore  : sentimentData.sentimentScore;
    const sentimentLabel = aiSent ? aiSent.sentimentLabel  : sentimentData.sentimentLabel;
    const sentConf       = aiSent ? aiSent.confidence      : sentimentData.confidence;

    const SENT_MAX_SHIFT = 0.12;
    const sentAdjusted   = clamp(marketPrice + sentimentScore * SENT_MAX_SHIFT * sentConf, 0.02, 0.98);
```

- [ ] **Step 7: Store `aiSentiment` on the prediction object for next-run caching**

In the `return { ... }` block of `scorePrediction`, add after `analyzedAt`:

```js
      aiSentiment: aiSent ? { ...aiSent } : undefined,
```

- [ ] **Step 8: Add Signal 5 Lite block after the existing Signal 5 block in `runFullAnalysis`**

The existing Signal 5 block is inside `if (process.env.ANTHROPIC_API_KEY)`. Add Signal 5 Lite as a second block after it (still inside the same outer `if`):

```js
    // ── Signal 5 Lite: Claude AI for sub-threshold markets ──────────────────
    {
      const LITE_EV_THRESHOLD = parseFloat(process.env.AI_LITE_EV_THRESHOLD  || '0.01');
      const LITE_MIN_VOLUME   = parseFloat(process.env.AI_LITE_MIN_VOLUME     || '50');
      const LITE_MAX_MARKETS  = parseInt(  process.env.AI_LITE_MAX_MARKETS    || '100', 10);
      const LITE_CACHE_MS     = parseFloat(process.env.AI_CACHE_HOURS || '6') * 3_600_000;
      const PRICE_DRIFT       = parseFloat(process.env.AI_PRICE_DRIFT || '0.03');

      const fullSignal5Ids = new Set(qualifying.map(p => p.id));

      const liteQualifying = predictions
        .filter(p =>
          !fullSignal5Ids.has(p.id) &&
          (p.volume || 0) >= LITE_MIN_VOLUME &&
          p.bestEV >= LITE_EV_THRESHOLD
        )
        .sort((a, b) => b.bestEV - a.bestEV)
        .slice(0, LITE_MAX_MARKETS);

      const liteNeedsAnalysis = liteQualifying.filter(pred => {
        const ai = prevPredictionsMap.get(pred.id)?.aiAnalysis;
        if (!ai?.analyzedAt || ai.signalSource !== 'claude-lite') return true;
        if (Date.now() - new Date(ai.analyzedAt).getTime() > LITE_CACHE_MS) return true;
        const prev = ai.priceAtAnalysis ?? null;
        if (prev !== null && Math.abs(pred.currentPrice - prev) > PRICE_DRIFT) return true;
        return false;
      });

      // Re-apply valid cached lite results
      liteQualifying
        .filter(p => !liteNeedsAnalysis.includes(p))
        .forEach(pred => {
          const ai = prevPredictionsMap.get(pred.id)?.aiAnalysis;
          if (ai?.signalSource === 'claude-lite') applyAIResult(pred, ai);
        });

      const liteCached = liteQualifying.length - liteNeedsAnalysis.length;
      console.log(`[Analyzer] Signal 5 Lite: ${liteNeedsAnalysis.length} fresh + ${liteCached} cached`);
      onProgress(91, `Signal 5 Lite: ${liteNeedsAnalysis.length} markets…`);

      const BATCH = 5;
      for (let b = 0; b < liteNeedsAnalysis.length; b += BATCH) {
        const batch = liteNeedsAnalysis.slice(b, b + BATCH);
        await Promise.all(batch.map(async pred => {
          const market = allMarkets.find(m => m.id === pred.id) || {
            id: pred.id, bestYes: pred.currentPrice, volume: pred.volume,
            platform: pred.platform, title: pred.title, closes: pred.closes,
          };
          const aiResult = await analyzeMarketWithAILite(market, pred.topArticles || [], pred.signals || []);
          if (!aiResult) return;
          applyAIResult(pred, aiResult);
        }));
      }
    }
```

- [ ] **Step 9: Verify the server starts without errors**

```bash
node -e "require('./agent/analyzer')" && echo "OK"
```

Expected: `OK` with no errors.

- [ ] **Step 10: Commit**

```bash
git add agent/analyzer.js
git commit -m "feat: wire AI sentiment batch and Signal 5 Lite into analyzer pipeline"
```

---

## Task 9: Wire Risk Narratives + Cluster Analysis into `analyzer.js`

**Files:**
- Modify: `agent/analyzer.js`

- [ ] **Step 1: Add risk narratives block after the Signal 5 Lite block, before `sort`**

```js
  // ── Risk Narratives ─────────────────────────────────────────────────────────
  if (process.env.ANTHROPIC_API_KEY) {
    const RISK_THRESHOLD = parseFloat(process.env.AI_RISK_NARRATIVE_THRESHOLD || '0.60');
    const highRisk       = predictions.filter(p => p.riskScore >= RISK_THRESHOLD);
    if (highRisk.length > 0) {
      onProgress(93, `Risk narratives: ${highRisk.length} high-risk markets…`);
      const narrativeMap = await generateRiskNarratives(highRisk);
      for (const pred of highRisk) {
        const n = narrativeMap.get(pred.id);
        if (n) pred.riskNarrative = n;
      }
      console.log(`[Analyzer] Risk narratives: ${narrativeMap.size} generated`);
    }
  }

```

- [ ] **Step 2: Replace the existing briefing block with a parallel briefing + cluster analysis call**

Find:
```js
  let briefing = null;
  if (process.env.ANTHROPIC_API_KEY) {
    const topPicks = deduped.filter(p => p.isTopPick).slice(0, 10);
    onProgress(96, 'Generating daily briefing…');
    briefing = await generateBriefing(topPicks, economicData);
  }
```

Replace with:
```js
  let briefing        = null;
  let clusterAnalysis = null;
  if (process.env.ANTHROPIC_API_KEY) {
    const topPicks = deduped.filter(p => p.isTopPick).slice(0, 10);
    onProgress(96, 'Generating briefing and cluster analysis…');
    [briefing, clusterAnalysis] = await Promise.all([
      generateBriefing(topPicks, economicData),
      generateClusterAnalysis(deduped),
    ]);
  }
```

- [ ] **Step 3: Update the return value of `runFullAnalysis` to include `clusterAnalysis`**

Find the `return {` block at the end and add:

```js
    clusterAnalysis,
```

- [ ] **Step 4: Verify no syntax errors**

```bash
node -e "require('./agent/analyzer')" && echo "OK"
```

Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add agent/analyzer.js
git commit -m "feat: wire risk narratives and cluster analysis into analyzer pipeline"
```

---

## Task 10: Add `clusterAnalysis` to cache + `/api/clusters` endpoint

**Files:**
- Modify: `server/cache.js`
- Modify: `server/routes.js`

- [ ] **Step 1: Add `clusterAnalysis: null` to the initial cache state in `cache.js`**

Find:
```js
let cache = {
  predictions: [],
  news:        [],
  briefing:    null,
```

Replace with:
```js
let cache = {
  predictions:    [],
  news:           [],
  briefing:       null,
  clusterAnalysis: null,
```

- [ ] **Step 2: Add `clusterAnalysis` to `persistToDisk` in `cache.js`**

Find:
```js
  fs.writeFileSync(DATA_FILE, JSON.stringify({
    predictions: cache.predictions,
    news:        cache.news,
    briefing:    cache.briefing,
    status:      cache.status,
  }, null, 2));
```

Replace with:
```js
  fs.writeFileSync(DATA_FILE, JSON.stringify({
    predictions:    cache.predictions,
    news:           cache.news,
    briefing:       cache.briefing,
    clusterAnalysis: cache.clusterAnalysis,
    status:          cache.status,
  }, null, 2));
```

- [ ] **Step 3: Add `GET /api/clusters` route in `routes.js`**

After the existing `/briefing` route:

```js
  // ── Cluster Analysis ───────────────────────────────────────────────────────
  router.get('/clusters', (_req, res) => {
    res.json(getCache().clusterAnalysis || null);
  });
```

- [ ] **Step 4: Verify routes load without errors**

```bash
node -e "require('./server/routes')" && echo "OK"
```

Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add server/cache.js server/routes.js
git commit -m "feat: add clusterAnalysis to cache and GET /api/clusters endpoint"
```

---

## Task 11: Wire delta briefing into `agent-runner.js`

**Files:**
- Modify: `server/agent-runner.js`

- [ ] **Step 1: Add the `generateDeltaBriefing` import at the top**

```js
const { runFullAnalysis }     = require('../agent/analyzer');
const { generateDeltaBriefing } = require('../agent/ai-engine');
const {
  getCache,
  updateCache,
  persistToDisk,
  appendHistory,
  broadcastProgress,
} = require('./cache');
```

- [ ] **Step 2: Replace `runAgent` with the updated version**

```js
async function runAgent() {
  const cache = getCache();
  if (cache.status.running) {
    console.log('[Agent] Already running, skipping...');
    return;
  }

  updateCache({ status: { running: true, error: null, progress: 0, progressStage: 'Starting…' } });
  console.log('[Agent] ── Analysis started ──────────────────────');

  // Capture previous top-pick estimates for delta briefing comparison
  const prevTopPicks = new Map(
    (cache.predictions || [])
      .filter(p => p.isTopPick)
      .map(p => [p.id, { estimate: p.estimatedProbability, title: p.title, topArticles: p.topArticles }])
  );

  // Build prev predictions map for AI cache lookups (sentiment, Signal 5 Lite)
  const prevPredictionsMap = new Map(
    (cache.predictions || []).map(p => [p.id, p])
  );

  const onProgress = (percent, stage) => {
    updateCache({ status: { progress: percent, progressStage: stage } });
    broadcastProgress(percent, stage);
    console.log(`[Agent] ${String(percent).padStart(3)}%  ${stage}`);
  };

  try {
    const result = await runFullAnalysis(onProgress, prevPredictionsMap);

    // ── Delta briefing: explain top-pick estimate shifts since last run ────────
    if (process.env.ANTHROPIC_API_KEY && prevTopPicks.size > 0) {
      const DELTA_THRESHOLD = parseFloat(process.env.AI_DELTA_THRESHOLD || '0.05');
      const deltas = result.predictions
        .filter(p => p.isTopPick)
        .flatMap(p => {
          const prev = prevTopPicks.get(p.id);
          if (!prev) return [];
          if (Math.abs(p.estimatedProbability - prev.estimate) < DELTA_THRESHOLD) return [];
          return [{ id: p.id, title: p.title, prevEstimate: prev.estimate, newEstimate: p.estimatedProbability, topArticles: p.topArticles || [] }];
        });

      if (deltas.length > 0) {
        const deltaMap = await generateDeltaBriefing(deltas);
        for (const pred of result.predictions) {
          const note = deltaMap.get(pred.id);
          if (note) pred.deltaNote = note;
        }
        console.log(`[Agent] Delta briefing: ${deltaMap.size} markets updated`);
      }
    }

    updateCache({
      predictions:     result.predictions,
      news:            result.news,
      briefing:        result.briefing        || null,
      clusterAnalysis: result.clusterAnalysis || null,
      status: {
        lastRun:              new Date().toISOString(),
        marketsChecked:       result.marketsChecked,
        newsSourcesChecked:   result.newsSourcesChecked,
        newsSourcesSucceeded: result.newsSourcesSucceeded,
        topPickCount:         result.predictions.filter(p => p.isTopPick).length,
        runCount:             (getCache().status.runCount || 0) + 1,
        error:                null,
      },
    });

    persistToDisk();
    appendHistory();

    const { predictions, status } = getCache();
    console.log(`[Agent] ✓ Complete: ${predictions.length} predictions, ${status.topPickCount} top picks`);
  } catch (err) {
    updateCache({ status: { error: err.message } });
    console.error('[Agent] ✗ Error:', err.message);
  } finally {
    const errMsg = getCache().status.error;
    updateCache({ status: { running: false, progress: 0, progressStage: errMsg ? 'Error' : 'Idle' } });
    broadcastProgress(0, errMsg ? 'Error' : 'Idle');
  }
}
```

- [ ] **Step 3: Verify agent-runner loads without errors**

```bash
node -e "require('./server/agent-runner')" && echo "OK"
```

Expected: `OK`

- [ ] **Step 4: Run full test suite one final time**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Final commit**

```bash
git add server/agent-runner.js
git commit -m "feat: wire delta briefing into agent-runner, complete expanded AI analysis pipeline"
```

---

## Self-Review

**Spec coverage:**
- AI Sentiment Batch — Tasks 2, 3, 8 ✓
- Signal 5 Lite — Tasks 4, 5, 8 ✓
- Risk Narratives — Tasks 6, 7, 9 ✓
- Cluster Analysis — Tasks 6, 7, 9, 10 ✓
- Delta Briefing — Tasks 6, 7, 11 ✓
- New `GET /api/clusters` endpoint — Task 10 ✓
- All new `.env` vars documented in spec and used in code ✓
- `prevPredictionsMap` threading through `runFullAnalysis` → `agent-runner.js` ✓

**Placeholder scan:** No TBDs or placeholder text found.

**Type consistency:**
- `applyAIResult(pred, aiResult)` reused for Signal 5 Lite — `analyzeMarketWithAILite` returns same shape (confirmed in Task 5). ✓
- `analyzeSentimentBatch` returns `Map<string, {...}>`, consumed with `aiSentimentMap.get(market.id)` — consistent. ✓
- `generateRiskNarratives` returns `Map<string, string>`, consumed with `narrativeMap.get(pred.id)` — consistent. ✓
- `generateClusterAnalysis` returns `{ clusters, inconsistencies, generatedAt }`, stored as `cache.clusterAnalysis` — consistent with `/api/clusters` response. ✓
- `generateDeltaBriefing` returns `Map<string, string>`, consumed with `deltaMap.get(pred.id)` — consistent. ✓
