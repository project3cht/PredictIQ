# Expanded AI Analysis Calls — Design Spec
**Date:** 2026-04-10
**Status:** Approved

## Goals

Three simultaneous goals:
- **Accuracy** — improve signal quality for existing predictions
- **Coverage** — get AI analysis on markets currently filtered out of Signal 5
- **Features** — new output surfaces (risk narratives, cluster analysis, delta briefing)

---

## New AI Call Points (Summary)

| # | Name | Goal | Model | Trigger |
|---|------|------|-------|---------|
| 1 | AI Sentiment Batch | Accuracy | Haiku | volume ≥ 500, replaces keyword Signal 2 |
| 2 | Signal 5 Lite | Coverage | Haiku | EV 0.01–0.03 OR volume 50–100 |
| 3 | Risk Narrative | Features | Haiku | riskScore ≥ 0.60, batched post-scoring |
| 4 | Cluster Analysis | Features | Sonnet | Once per run, top 50 predictions |
| 5 | Delta Briefing | Features | Haiku | Top pick estimate shift > 5% vs previous run |

Existing Signal 5 (Sonnet, full chain-of-thought) and `generateBriefing` (Sonnet) are **unchanged**.

---

## Detailed Design

### 1. AI Sentiment Batch (Accuracy)

**Where:** `analyzer.js` (pre-scoring) + new function in `ai-engine.js`

**Trigger:** markets with `volume >= 500` before `scorePrediction()` is called.

**Implementation:**
- New function `analyzeSentimentBatch(markets, articles)` in `ai-engine.js`
- Markets batched in groups of 10; each batch is a single Haiku API call
- Prompt provides: market title + top 5 relevant article headlines per market
- Returns array of `{ marketId, sentimentScore: -1.0–1.0, sentimentLabel, confidence }`
- Results stored in a `Map<marketId, aiSentimentResult>` passed into `scorePrediction()`
- If an AI sentiment result exists for a market, it overrides the keyword-based Signal 2
- If the batch call fails, the market falls back silently to keyword scoring (no regression)
- Cached per-market with 6h TTL (same invalidation logic as Signal 5)

**Env vars:**
- `AI_SENTIMENT_MIN_VOLUME` (default: `500`) — threshold to qualify for AI sentiment
- `AI_SENTIMENT_MODEL` (default: `claude-haiku-4-5-20251001`)

---

### 2. Signal 5 Lite (Coverage)

**Where:** `analyzer.js` (after main Signal 5 block) + new function in `ai-engine.js`

**Trigger:** Markets that failed the Signal 5 pre-filter (`bestEV >= 0.03 && volume >= 100`) but pass a looser filter: `bestEV >= 0.01 || volume >= 50`. Excludes any market already processed by full Signal 5.

**Implementation:**
- New function `analyzeMarketWithAILite(market, topArticles, existingSignals)` in `ai-engine.js`
- Shorter prompt: no step-by-step chain-of-thought, no economic context, 200 max_tokens
- Returns same shape as full Signal 5: `{ estimatedProbability, confidence, keyFactors, reasoning, flags }`
- Result applied via existing `applyAIResult()` — same weight (0.20) as full Signal 5
- `pred.aiAnalysis.signalSource = 'claude-lite'` added to distinguish from full analysis
- Separate spend cap: `AI_LITE_MAX_MARKETS` (default: `100`)
- Same 6h cache + price-drift invalidation as Signal 5

**Env vars:**
- `AI_LITE_MAX_MARKETS` (default: `100`)
- `AI_LITE_EV_THRESHOLD` (default: `0.01`)
- `AI_LITE_MIN_VOLUME` (default: `50`)
- `AI_LITE_MODEL` (default: `claude-haiku-4-5-20251001`)

---

### 3. Risk Narrative (Features)

**Where:** `analyzer.js` (post-scoring, before ranking) + new function in `ai-engine.js`

**Trigger:** Any scored prediction with `riskScore >= 0.60`.

**Implementation:**
- New function `generateRiskNarratives(highRiskPredictions)` in `ai-engine.js`
- All qualifying markets sent in a single batched Haiku call (up to 30 at a time)
- Prompt per market: title, riskScore, contributing factors (spread, liquidity, time, volatility scores)
- Returns `{ marketId, riskNarrative: "≤120 char plain-English explanation" }`
- Result stored as `pred.riskNarrative` on each prediction
- No caching — risk scores change each run, narratives are cheap (Haiku, ~50 tokens each)
- Dashboard displays `riskNarrative` in the market detail panel under the risk badge

**Env vars:**
- `AI_RISK_NARRATIVE_THRESHOLD` (default: `0.60`)
- `AI_RISK_NARRATIVE_MODEL` (default: `claude-haiku-4-5-20251001`)

---

### 4. Cluster Analysis (Features)

**Where:** `analyzer.js` (after deduplication) + new function in `ai-engine.js`

**Trigger:** Once per run, unconditionally if `ANTHROPIC_API_KEY` is set.

**Implementation:**
- New function `generateClusterAnalysis(predictions)` in `ai-engine.js`
- Input: top 50 predictions by `finalScore` (title, platform, estimatedProbability, currentPrice, category)
- Single Sonnet call; returns:
  ```json
  {
    "clusters": [
      { "theme": "Fed Rate Policy", "marketIds": ["..."], "summary": "..." }
    ],
    "inconsistencies": [
      { "marketIds": ["a", "b"], "note": "Market A implies X but Market B implies Y" }
    ]
  }
  ```
- 3–6 clusters, 0–3 inconsistencies
- Stored in cache as `cache.clusterAnalysis`; served via new `GET /api/clusters` endpoint
- Cached until next run (no mid-run invalidation)
- Dashboard: new "Themes" tab or sidebar section showing clusters + inconsistency callouts

**Env vars:**
- `AI_CLUSTER_MODEL` (default: `claude-sonnet-4-6`)

---

### 5. Delta Briefing (Features)

**Where:** `server/agent-runner.js` (post-run comparison) + new function in `ai-engine.js`

**Trigger:** After each hourly run completes, compare new top-pick `estimatedProbability` values against previous run's values for the same `marketId`. Fire for any market where `|newEst - prevEst| > 0.05`.

**Implementation:**
- `agent-runner.js` retains the previous run's top-pick estimates in memory (simple `Map<marketId, prevEstimate>`)
- After a run, diffs are computed and passed to new `generateDeltaBriefing(deltas)` in `ai-engine.js`
- Each delta entry: `{ marketId, title, prevEstimate, newEstimate, prevPrice, newPrice, deltaContext }`
- `deltaContext` = any new articles since the last run (from `pred.topArticles`)
- Single Haiku call returns `{ marketId, deltaNote: "≤160 char explanation of what changed" }`
- Result stored as `pred.deltaNote` on the relevant predictions
- Dashboard: "⚡ What changed" badge/callout on market cards when `deltaNote` is present

**Env vars:**
- `AI_DELTA_THRESHOLD` (default: `0.05`)
- `AI_DELTA_MODEL` (default: `claude-haiku-4-5-20251001`)

---

## Pipeline Order (Updated)

```
fetchAllMarkets + collectAllNews + fetchEconomicData   [parallel]
fetchOddsData + fetchFinancialData + fetchPollingData  [parallel, graceful-degraded]
  ↓
analyzeSentimentBatch()        ← NEW: AI sentiment for volume ≥ 500 markets
  ↓
scorePrediction() × N          ← uses AI sentiment result if available
  ↓
Signal 5 (Sonnet, EV≥0.03, vol≥100, cap 50)          [existing]
Signal 5 Lite (Haiku, EV≥0.01, vol≥50, cap 100)      ← NEW
  ↓
generateRiskNarratives()       ← NEW: Haiku, riskScore ≥ 0.60
  ↓
sort + dedup + rank + tag top picks
  ↓
generateClusterAnalysis()      ← NEW: Sonnet, top 50
generateBriefing()             [existing]
  ↓
[post-run] generateDeltaBriefing()  ← NEW: Haiku, top pick shifts > 5%
```

---

## New API Endpoints

- `GET /api/clusters` — returns `cache.clusterAnalysis` (clusters + inconsistencies)

---

## New `.env` Variables

```
AI_SENTIMENT_MIN_VOLUME=500
AI_SENTIMENT_MODEL=claude-haiku-4-5-20251001

AI_LITE_MAX_MARKETS=100
AI_LITE_EV_THRESHOLD=0.01
AI_LITE_MIN_VOLUME=50
AI_LITE_MODEL=claude-haiku-4-5-20251001

AI_RISK_NARRATIVE_THRESHOLD=0.60
AI_RISK_NARRATIVE_MODEL=claude-haiku-4-5-20251001

AI_CLUSTER_MODEL=claude-sonnet-4-6

AI_DELTA_THRESHOLD=0.05
AI_DELTA_MODEL=claude-haiku-4-5-20251001
```

---

## Files Modified

| File | Change |
|------|--------|
| `agent/ai-engine.js` | Add 5 new exported functions |
| `agent/analyzer.js` | Wire in AI sentiment batch, Signal 5 Lite, risk narratives, cluster analysis |
| `server/agent-runner.js` | Retain prev-run estimates map, call delta briefing post-run |
| `server/cache.js` | Add `clusterAnalysis` field to cache shape |
| `server/routes.js` | Add `GET /api/clusters` endpoint |
| `.env` (docs only) | Document new env vars with defaults |

No new files created. Dashboard changes are additive (new display fields, new tab/section).

---

## Error Handling

All five new functions follow the existing pattern: errors are caught, logged with `[AIEngine]` prefix, and return `null`. Callers treat `null` as graceful degradation — the prediction is still scored and returned without the new field.
