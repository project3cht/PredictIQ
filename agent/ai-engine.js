/**
 * agent/ai-engine.js — Claude as Signal 5 in the prediction scoring pipeline
 *
 * Eight functions:
 *   analyzeMarketWithAI(market, topArticles, economicContext, existingSignals)
 *   generateBriefing(topPredictions, economicData)
 *   answerQuestion(question, topPredictions, headlines)
 *   analyzeSentimentBatch(markets, articles, prevPredictionsMap)
 *   analyzeMarketWithAILite(market, topArticles, existingSignals)
 *   generateRiskNarratives(predictions)
 *   generateClusterAnalysis(predictions)
 *   generateDeltaBriefing(deltas)
 *
 * Model selection (set in .env to override):
 *   AI_ANALYSIS_MODEL      — per-market analysis        (default: claude-sonnet-4-5)
 *   AI_BRIEFING_MODEL      — daily briefing             (default: claude-sonnet-4-5)
 *   AI_CHAT_MODEL          — real-time chat             (default: claude-haiku-4-5)
 *   AI_SENTIMENT_MODEL     — sentiment batch            (default: claude-haiku-4-5-20251001)
 *   AI_LITE_MODEL          — Signal 5 Lite              (default: claude-haiku-4-5-20251001)
 *   AI_RISK_NARRATIVE_MODEL — risk narratives           (default: claude-haiku-4-5-20251001)
 *   AI_CLUSTER_MODEL       — cluster analysis           (default: claude-sonnet-4-6)
 *   AI_DELTA_MODEL         — delta briefing             (default: claude-haiku-4-5-20251001)
 *
 * Cost control:
 *   analyzeMarketWithAI() should only be called for markets that pass the
 *   pre-filter (bestEV >= 0.03 && volume >= 100).  Smart caching in analyzer.js
 *   prevents redundant re-analysis of stable markets.
 */

const Anthropic = require('@anthropic-ai/sdk');

let _client = null;
function getClient() {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

// Model names — override in .env for cost/quality tuning
const ANALYSIS_MODEL = () => process.env.AI_ANALYSIS_MODEL || 'claude-sonnet-4-5';
const BRIEFING_MODEL = () => process.env.AI_BRIEFING_MODEL || 'claude-sonnet-4-5';
const CHAT_MODEL     = () => process.env.AI_CHAT_MODEL     || 'claude-haiku-4-5';
const SENTIMENT_MODEL      = () => process.env.AI_SENTIMENT_MODEL      || 'claude-haiku-4-5-20251001';
const LITE_MODEL           = () => process.env.AI_LITE_MODEL           || 'claude-haiku-4-5-20251001';
const RISK_NARRATIVE_MODEL = () => process.env.AI_RISK_NARRATIVE_MODEL || 'claude-haiku-4-5-20251001';
const CLUSTER_MODEL        = () => process.env.AI_CLUSTER_MODEL        || 'claude-sonnet-4-6';
const DELTA_MODEL          = () => process.env.AI_DELTA_MODEL          || 'claude-haiku-4-5-20251001';

// ─────────────────────────────────────────────────────────────────────────────
// analyzeMarketWithAI
//
// Enhanced with:
//  • Up to 10 news articles (was 5) with full credibility + recency signals
//  • Up to 8 economic indicators (was 4)
//  • Structured chain-of-thought prompt guiding step-by-step reasoning
//  • 700 max_tokens (was 400) for deeper analysis
//  • Returns priceAtAnalysis + analyzedAt for smart caching in analyzer.js
// ─────────────────────────────────────────────────────────────────────────────
async function analyzeMarketWithAI(market, topArticles = [], economicContext = [], existingSignals = []) {
  try {
    const client = getClient();

    // ── Build context blocks ───────────────────────────────────────────────
    const articleLines = topArticles.slice(0, 10).map((a, i) => {
      const credTag  = a.credibility >= 1.4 ? ' [Tier-1]' : a.credibility >= 1.2 ? ' [Tier-2]' : '';
      const sentTag  = a.sentiment > 0.15 ? 'bullish' : a.sentiment < -0.15 ? 'bearish' : 'neutral';
      const age      = timeAgoLabel(a.publishedAt);
      return `${i + 1}.${credTag} "${a.title}" — ${a.source || 'Unknown'}, ${age}, sentiment: ${sentTag}`;
    }).join('\n');

    const econLines = economicContext.slice(0, 8).map(d =>
      `• ${d.indicator}: ${d.value}  (trend: ${d.trend})`
    ).join('\n');

    const signalLines = existingSignals.map(s =>
      `• ${s.label}: ${Math.round(s.prob * 100)}%  (weight ${Math.round(s.weight * 100)}%)`
    ).join('\n');

    const closes = market.closes
      ? `Closes: ${new Date(market.closes).toLocaleDateString()} (${daysOutLabel(market.closes)})`
      : 'Close date: unknown';

    const impliedProb = Math.round((market.bestYes || 0) * 100);

    // ── Prompt — structured chain-of-thought ──────────────────────────────
    const prompt = `You are an expert prediction market analyst with deep knowledge of politics, economics, sports, and current events. Your job is to produce a calibrated probability estimate for the following market.

═══ MARKET ═══
Title:    "${market.title}"
Platform: ${market.platform}
Price (YES): ${impliedProb}¢  ← market's implied probability
Volume:   $${(market.volume || 0).toLocaleString()}
${closes}

═══ NEWS COVERAGE (most relevant, newest first) ═══
${articleLines || 'No relevant articles found.'}

═══ MACRO / ECONOMIC INDICATORS ═══
${econLines || 'No relevant indicators.'}

═══ EXISTING MODEL SIGNALS ═══
${signalLines || 'No signals yet.'}

═══ INSTRUCTIONS ═══
Think step by step before answering:

1. BASE RATE — What is the unconditional probability of this type of event?
2. EVIDENCE — Does the news/data above shift the probability up or down? By how much?
3. MARKET PRICE — Is the market price reasonable, too high, or too low given your analysis?
4. KEY FACTORS — List the 2-4 most decisive factors (bullish = raises YES prob, bearish = lowers it).
5. UNCERTAINTY — How confident are you? Flag data gaps or contradictions.

Respond with a JSON object with these fields:
- "estimatedProbability": your honest YES probability (0.0-1.0, don't just echo market price)
- "confidence": how certain you are (0 = guess, 0.5 = moderate evidence, 1 = near-certain)
- "keyFactors": array of 2-4 objects: { "direction": "up"|"down"|"warn", "text": "≤140 chars" }
- "reasoning": 3-4 sentence plain-English explanation incorporating the chain-of-thought steps above
- "flags": array of any applicable: "thin_data", "high_uncertainty", "contradicting_signals", "near_expiry"

Calibration: avoid anchoring on the market price — correct it when evidence supports a different estimate.`;

    // Assistant prefill forces the response to begin with '{', preventing
    // the model from outputting prose reasoning before the JSON object.
    const message = await client.messages.create({
      model:      ANALYSIS_MODEL(),
      max_tokens: 700,
      messages:   [
        { role: 'user',      content: prompt },
        { role: 'assistant', content: '{'    },  // prefill — model must continue as JSON
      ],
    });

    // Re-attach the opening brace we consumed in the prefill
    const raw    = '{' + (message.content[0]?.text?.trim() || '');
    const result = JSON.parse(raw);

    // Validate + normalise
    if (typeof result.estimatedProbability !== 'number') throw new Error('Missing estimatedProbability');
    result.estimatedProbability = clamp(result.estimatedProbability, 0.02, 0.98);
    result.confidence           = clamp(result.confidence || 0.5, 0, 1);
    result.keyFactors           = Array.isArray(result.keyFactors) ? result.keyFactors.slice(0, 4) : [];
    result.reasoning            = result.reasoning || '';
    result.flags                = Array.isArray(result.flags) ? result.flags : [];

    // Cache metadata — used by analyzer.js to skip re-analysis of stable markets
    result.analyzedAt       = new Date().toISOString();
    result.priceAtAnalysis  = market.bestYes ?? null;
    result.modelUsed        = ANALYSIS_MODEL();

    return result;
  } catch (err) {
    console.error(`[AIEngine] analyzeMarketWithAI failed for ${market.id}: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// generateBriefing
// Returns { summary, highlights, generatedAt } or null on error.
// ─────────────────────────────────────────────────────────────────────────────
async function generateBriefing(topPredictions, economicData = {}) {
  try {
    const client = getClient();

    const topLines = topPredictions.slice(0, 10).map((p, i) => {
      const ev  = Math.round(p.bestEV * 100);
      const est = Math.round(p.estimatedProbability * 100);
      const mkt = Math.round(p.currentPrice * 100);
      const closes = p.closes ? `, closes ${daysOutLabel(p.closes)}` : '';
      return `${i + 1}. [${p.platform}] "${p.title}" — BET ${p.bestSide} @ ${mkt}¢, est ${est}%, EV +${ev}¢, conf ${Math.round(p.confidence * 100)}%${closes}`;
    }).join('\n');

    const econSummary = Object.entries(economicData)
      .slice(0, 8)
      .map(([k, v]) => `${k}: ${v?.value ?? v}`)
      .join(' | ');

    const prompt = `You are a daily prediction market briefing analyst. Produce an insightful summary for a trader starting their day.

TOP OPPORTUNITIES:
${topLines || 'No top picks today.'}

MACRO SNAPSHOT: ${econSummary || 'Data unavailable.'}

Respond ONLY with valid JSON (no markdown, no code fences):
{
  "summary": "<2-3 sentences: what are the dominant themes today, what should a trader focus on?>",
  "highlights": [
    { "label": "<short phrase ≤60 chars>", "sentiment": "bullish"|"bearish"|"neutral" }
  ]
}

Rules:
- summary: specific and actionable — reference actual markets/themes, not generic advice
- highlights: 3-5 takeaways covering different categories (politics, economics, sports, etc.)
- Be honest about uncertainty — don't oversell picks`;

    const message = await client.messages.create({
      model:      BRIEFING_MODEL(),
      max_tokens: 450,
      messages:   [{ role: 'user', content: prompt }],
    });

    const raw    = message.content[0]?.text?.trim() || '';
    const result = JSON.parse(raw);

    return {
      summary:     result.summary    || '',
      highlights:  Array.isArray(result.highlights) ? result.highlights.slice(0, 5) : [],
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error('[AIEngine] generateBriefing failed:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// answerQuestion — for the /api/chat endpoint
// Uses a fast, cheap model since it's real-time interactive.
// Returns { answer } or null on error.
// ─────────────────────────────────────────────────────────────────────────────
async function answerQuestion(question, topPredictions = [], headlines = []) {
  try {
    const client = getClient();

    const pickLines = topPredictions.slice(0, 20).map(p => {
      const ev     = Math.round(p.bestEV * 100);
      const closes = p.closes ? `, closes ${daysOutLabel(p.closes)}` : '';
      return `• [${p.platform}] "${p.title}" — BET ${p.bestSide} @ ${Math.round(p.currentPrice * 100)}¢, EV +${ev}¢${closes}`;
    }).join('\n');

    const newsLines = headlines.slice(0, 15).map(a =>
      `• [${a.source}] "${a.title}"`
    ).join('\n');

    const prompt = `You are a prediction market AI assistant. Answer the user's question using only the data provided.

CURRENT TOP OPPORTUNITIES:
${pickLines || 'No predictions loaded.'}

RECENT HEADLINES:
${newsLines || 'No headlines available.'}

USER QUESTION: ${question}

Answer in 2-4 sentences. Be direct, specific, and reference specific markets or headlines when relevant. No markdown, no bullet points.`;

    const message = await client.messages.create({
      model:      CHAT_MODEL(),
      max_tokens: 350,
      messages:   [{ role: 'user', content: prompt }],
    });

    return { answer: message.content[0]?.text?.trim() || '' };
  } catch (err) {
    console.error('[AIEngine] answerQuestion failed:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function timeAgoLabel(iso) {
  if (!iso) return 'unknown age';
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function daysOutLabel(iso) {
  if (!iso) return '';
  const days = Math.round((new Date(iso) - Date.now()) / 86_400_000);
  if (days < 0)   return 'expired';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 30)  return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

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

  const client     = getClient();
  const BATCH_SIZE = 10;
  const CONCURRENCY = 5; // parallel Haiku calls

  const buildBatchPromise = (batch, i) => {
    const marketBlocks = batch.map((m, idx) => {
      const keywords  = m.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
      const relevant  = articles
        .filter(a => keywords.some(kw => a.title?.toLowerCase().includes(kw)))
        .sort((a, b) => (b.credibility || 1) - (a.credibility || 1))
        .slice(0, 5);
      const headlineLines = relevant.length
        ? relevant.map(a => `   - ${(a.title || '').replace(/"/g, "'")} — ${a.source || 'Unknown'}`).join('\n')
        : '   (no relevant headlines found)';
      return `${idx + 1}. [id: "${m.id}"] ${m.title.replace(/"/g, "'")}\n   Headlines:\n${headlineLines}`;
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

    return client.messages.create({
      model:      SENTIMENT_MODEL(),
      max_tokens: 1200,
      messages: [
        { role: 'user',      content: prompt },
        { role: 'assistant', content: '['    },
      ],
    }).then(message => {
      const rawFull = '[' + (message.content[0]?.text?.trim() || '');
      const raw     = rawFull.slice(0, rawFull.lastIndexOf(']') + 1);
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
    }).catch(err => {
      console.error(`[AIEngine] analyzeSentimentBatch failed (batch ${i}):`, err.message);
      // Graceful degradation — markets in this batch fall back to keyword scoring
    });
  };

  // Run batches in parallel with a sliding concurrency window
  const batches = [];
  for (let i = 0; i < toAnalyze.length; i += BATCH_SIZE) {
    batches.push({ batch: toAnalyze.slice(i, i + BATCH_SIZE), i });
  }
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    await Promise.all(batches.slice(i, i + CONCURRENCY).map(({ batch, i: idx }) => buildBatchPromise(batch, idx)));
  }

  return resultMap;
}

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

    const TIMEOUT_MS = 15_000;
    const message = await Promise.race([
      client.messages.create({
        model:      LITE_MODEL(),
        max_tokens: 400,
        messages: [
          { role: 'user',      content: prompt },
          { role: 'assistant', content: '{'    },
        ],
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('analyzeMarketWithAILite timeout')), TIMEOUT_MS)
      ),
    ]);

    const rawFull = '{' + (message.content[0]?.text?.trim() || '');
    const raw     = rawFull.slice(0, rawFull.lastIndexOf('}') + 1);
    const result  = JSON.parse(raw);

    if (typeof result.estimatedProbability !== 'number') throw new Error('Missing estimatedProbability');
    result.estimatedProbability = clamp(result.estimatedProbability, 0.02, 0.98);
    result.confidence           = clamp(result.confidence || 0.5, 0, 1);
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
      return `${idx + 1}. [id: "${p.id}"] "${p.title}" — risk ${Math.round((p.riskScore ?? 0) * 100)}%, ${timeStr}, vol $${(p.volume || 0).toLocaleString()}`;
    }).join('\n');

    const prompt = `For each high-risk prediction market, write a single plain-English sentence (≤120 chars) explaining WHY it is high-risk. Focus on the specific risk: thin liquidity, imminent expiry, wide spread, or sparse news coverage.

${marketLines}

Return JSON array in the same order:
[{"id": "<market id>", "riskNarrative": "<≤120 char explanation>"}]`;

    try {
      const message = await client.messages.create({
        model:      RISK_NARRATIVE_MODEL(),
        max_tokens: 1500,
        messages: [
          { role: 'user',      content: prompt },
          { role: 'assistant', content: '['    },
        ],
      });

      const rawFull = '[' + (message.content[0]?.text?.trim() || '');
      const raw     = rawFull.slice(0, rawFull.lastIndexOf(']') + 1);
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

    const rawText = message.content[0]?.text?.trim() || '';
    // Strip markdown code fences that Sonnet sometimes wraps around JSON
    const raw     = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    const result  = JSON.parse(raw);

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
      const prevEst   = Math.round((d.prevEstimate ?? 0) * 100);
      const currEst   = Math.round((d.newEstimate  ?? 0) * 100);
      const prevPx    = d.prevPrice != null ? `${Math.round(d.prevPrice * 100)}¢` : '?';
      const currPx    = d.newPrice  != null ? `${Math.round(d.newPrice  * 100)}¢` : '?';
      const dir       = currEst > prevEst ? '▲' : '▼';
      const headlines = (d.topArticles || []).slice(0, 3)
        .map(a => `"${a.title}" — ${a.source || 'Unknown'}`)
        .join('; ');
      return `${i + 1}. [id: "${d.id}"] "${d.title}"\n   est: ${dir} ${prevEst}% → ${currEst}% | price: ${prevPx} → ${currPx} | Recent: ${headlines || 'no new headlines'}`;
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

    const rawFull = '[' + (message.content[0]?.text?.trim() || '');
    const raw     = rawFull.slice(0, rawFull.lastIndexOf(']') + 1);
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
