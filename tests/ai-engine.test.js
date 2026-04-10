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
  global.__anthropicMockImpl__ = null;
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
    expect(result.get('mkt-1').sentimentLabel).toBe('bearish');
    expect(result.get('mkt-1').analyzedAt).toBeDefined();
    expect(result.get('mkt-2').sentimentScore).toBeCloseTo(0.4);
    expect(result.get('mkt-2').sentimentLabel).toBe('bullish');
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
      }).slice(1) // strip leading '{' because ai-engine prefills '{'
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
    const lower = await aiEngine.analyzeMarketWithAILite(market, [], []);
    expect(lower.estimatedProbability).toBeGreaterThanOrEqual(0.02);

    mockApiResponse(
      JSON.stringify({ estimatedProbability: 0.999, confidence: 0.5, reasoning: 'x', keyFactors: [], flags: [] }).slice(1)
    );
    const upper = await aiEngine.analyzeMarketWithAILite(market, [], []);
    expect(upper.estimatedProbability).toBeLessThanOrEqual(0.98);
  });
});

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
      ]).slice(1) // strip leading '[' — function prefills '['
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

