# PredictIQ Upgrade — Design Spec
**Date:** 2026-04-08  
**Status:** Approved  
**Approach:** Phased — Phase 1 now, Phase 2 when Anthropic API key is ready

---

## Overview

Two-phase upgrade to the PredictIQ prediction market dashboard:

- **Phase 1:** Fix broken data sources (Kalshi, Manifold, Metaculus) + refactor `server.js` monolith into clean modules
- **Phase 2:** Add Claude as Signal 5 in the scoring pipeline, per-pick confidence breakdowns, daily briefing, and a chat panel

---

## Phase 1 — Bug Fixes + Server Refactor

### 1.1 Kalshi 403 Fix

**Root cause:** `buildKalshiHeaders()` in `agent/markets.js` passes the raw PKCS#1 PEM string directly to `crypto.sign()`. Node.js crypto requires a `KeyObject` for reliable RSA-PSS behaviour with PKCS#1-format keys (`BEGIN RSA PRIVATE KEY`).

**Fix:**
```js
// Before
const signature = crypto.sign('sha256', Buffer.from(message), {
  key: privateKeyPem,
  padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
  saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
});

// After
const privateKeyObj = crypto.createPrivateKey(privateKeyPem);
const signature = crypto.sign('sha256', Buffer.from(message), {
  key: privateKeyObj,
  padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
  saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
});
```

Also add `err.response?.data` logging so the exact Kalshi rejection reason is visible if auth still fails.

Add a standalone `scripts/test-kalshi-auth.js` script that makes one signed request and prints the full response — allows credential verification without running the full agent.

**Env vars required (already present):**
- `KALSHI_KEY_ID`
- `KALSHI_KEY_FILE=./kalshi_private.key`

---

### 1.2 Manifold 400 Fix

**Root cause:** `sort=liquidity` query param removed from Manifold's v0 API; base URL changed.

**Fix:** Update `agent/markets.js` `fetchManifold()`:
- Remove `sort=liquidity` — this param was removed from their v0 API (primary fix)
- Keep `limit=100&filter=open`
- If still failing: try `https://api.manifold.markets/v0/markets` as the base URL (their subdomain routing may have changed)

---

### 1.3 Metaculus 403 Fix

**Root cause:** Metaculus added token authentication in 2024. Unauthenticated requests return 403.

**Fix:** Add `Authorization: Token ${METACULUS_API_KEY}` header when key is present; skip gracefully when not set (already using `Promise.allSettled`).

**Env var required (now present):** `METACULUS_API_KEY`

---

### 1.4 FRED Data Now Active

`FRED_API_KEY` is now set in `.env`. No code change needed — `agent/fred.js` already reads it. This unlocks 8 additional indicators: CPI level, core CPI, unemployment, fed funds rate, yield curve spread, real GDP, VIX, WTI oil price.

---

### 1.5 Server Refactor

Split `server.js` (220 lines, 4 responsibilities) into focused modules:

```
server/
  cache.js          — shared in-memory store + disk read/write
  agent-runner.js   — runAgent() + onProgress callbacks, no HTTP
  routes.js         — all Express routes, reads cache, calls agent-runner
server.js           — entry point: wires modules, sets up cron, starts listener (~40 lines)
```

**Boundaries:**
- `cache.js` exports `getCache()`, `updateCache(patch)`, `persistToDisk()`, `loadFromDisk()`
- `agent-runner.js` exports `runAgent(cache, onProgress)` — takes cache as argument, no global state
- `routes.js` exports `createRouter(cache, runAgent)` — Express Router factory
- `server.js` imports all three, assembles them, starts the cron and HTTP server

No behaviour changes — same API endpoints, same cron schedule, same disk persistence path.

---

## Phase 2 — AI Confidence Enhancement (requires `ANTHROPIC_API_KEY`)

### 2.1 Claude as Signal 5

Claude becomes a 5th signal in `agent/analyzer.js`'s probability fusion pipeline, replacing the current rule-based `generateReasoning()` function.

**New file:** `agent/ai-engine.js`

```js
// Exported function
async function analyzeMarketWithAI(market, topArticles, economicContext, existingSignals)
// Returns:
{
  estimatedProbability: 0.42,   // Claude's own probability estimate
  confidence: 0.71,             // 0–1, Claude's self-reported confidence
  keyFactors: [
    { direction: 'up',    text: 'Reuters + WSJ both cite Powell hawkish language' },
    { direction: 'down',  text: 'Only 3 weeks to expiry — time risk elevated' },
    { direction: 'warn',  text: 'Manifold community forecast partially contradicts' },
  ],
  reasoning: '...',             // 2–3 sentence natural language explanation
  flags: [],                    // e.g. ['thin_data', 'high_uncertainty', 'contradicting_signals']
}
```

**Prompt design:** Claude receives a structured context block (market title, current price, top 5 articles with source credibility, economic indicators, existing signal estimates) and returns structured JSON. Uses `claude-sonnet-4-6`.

**Weight adjustment in `analyzer.js`:**

| Signal | Before | After |
|--------|--------|-------|
| Market price | 35% | 28% |
| Sentiment | 30% | 24% |
| Cross-ref | 20% | 16% |
| Economic data | 15% | 12% |
| **Claude (new)** | — | **20%** |

Weights still renormalize when signals are missing — existing logic unchanged.

**Cost control:** Claude is called only for markets that pass a pre-filter: `bestEV >= 0.03 && volume >= 100`. This limits API calls to meaningful markets. Estimated ~50–150 Claude calls per analysis run.

---

### 2.2 Confidence Breakdown UI

Add a "Why this pick" section to the `PredictionDetail.jsx` drawer:

- Stacked confidence bar showing contribution of each signal (colour-coded)
- Key factors list with directional indicators (↑ up, ↓ down, ⚠ warning)
- Claude's 2–3 sentence natural language reasoning block
- `flags` rendered as small warning badges (e.g. "Thin data", "Signals disagree")

New field on each prediction object: `aiAnalysis: { estimatedProbability, confidence, keyFactors, reasoning, flags }` — null when Phase 2 is inactive.

---

### 2.3 Daily Briefing

**Endpoint:** `GET /api/briefing`

After each analysis run completes, call `generateBriefing(topPredictions, economicData)` in `ai-engine.js`. Claude receives the top 10 scored predictions and returns:

```js
{
  summary: '3 high-conviction opportunities today...',
  highlights: [
    { label: 'Fed rate cut: lean NO', sentiment: 'bearish' },
    ...
  ],
  generatedAt: '...',
}
```

Briefing displayed at the top of the dashboard, above Top Picks. Cached in `server/cache.js` alongside predictions.

---

### 2.4 Chat Panel

**Endpoint:** `POST /api/chat` — `{ question: string, context?: 'markets' | 'specific' | 'news' }`

Claude receives the question plus a context snapshot (top 20 predictions + current news headlines) and returns a direct answer. Stateless — no conversation history maintained server-side.

Frontend: floating panel, bottom-right corner of dashboard. Collapsed by default (icon button). Expands to show message thread. Uses the same `keyFactors` and `reasoning` already computed — no redundant API calls for questions about specific markets.

**Env var required:** `ANTHROPIC_API_KEY`

---

## Data Sources Summary

| Source | Status after Phase 1 | Auth |
|--------|---------------------|------|
| Kalshi | ✅ Fixed | RSA-PSS key pair |
| Polymarket | ✅ Working | None |
| PredictIt | ✅ Working | None |
| Metaculus | ✅ Fixed | Token (env var) |
| Manifold | ✅ Fixed | None |
| FRED | ✅ Now active | API key (env var) |
| World Bank | ✅ Working | None |
| Coinbase | ✅ Working | None |
| US Treasury | ✅ Working | None |
| RSS (28 feeds) | ✅ Working | None |
| Reddit (12 subs) | ✅ Working | None |
| Hacker News | ✅ Working | None |

---

## Phase 1 Additional Fixes

### 1.6 Static File Serving Bug

**Root cause:** `server.js:182` serves static files from `dist3`, but the SPA fallback at line 184 checks `dist/index.html`. Any unmatched route falls through to the wrong directory and returns a placeholder HTML page instead of the app.

**Fix:** Unify both references to `dist` and configure `vite.config.js` to build to `dist` (not `dist3`). Remove `emptyOutDir: false` — it was added to work around a macOS sandbox restriction that no longer applies. Delete the stale `dist2/` and `dist3/` directories.

---

### 1.7 Honest `newsSourcesChecked` Count

**Root cause:** `agent/collector.js` hardcodes `totalSources = RSS_SOURCES.length + REDDIT_SOURCES.length + 1` regardless of how many feeds actually returned data. The status bar shows "41 news sources" even when 15 of them timed out.

**Fix:** Count actual successful fetches (feeds that returned ≥1 article) and return `sourcesSucceeded` alongside `sourcesChecked`. Update the server cache and status bar to show both: e.g. "28/41 news sources".

---

### 1.8 Historical Score Tracking

**Root cause:** `data/latest.json` is overwritten on every run — no record of how confidence scores, market prices, or EV estimates change over time. Without history, there's no way to calibrate the model or see when estimates diverged from resolution.

**Fix:** After each successful analysis run, append a summary record to `data/history.jsonl`:

```json
{"runAt":"2026-04-08T14:00:00Z","predictions":[{"id":"kalshi_FED-25APR","finalScore":0.72,"confidence":0.68,"currentPrice":0.32,"estimatedProbability":0.44},...]}
```

Keep only prediction identity + scores (not full objects) to keep the file small. Cap at 30 days of runs (~720 entries). Expose via `GET /api/history` for future charting.

---

### 1.9 Sentiment Decay Scaled by Market Horizon

**Root cause:** `HALF_LIFE_HOURS = 6` in `agent/sentiment.js` is appropriate for same-day markets but severely underweights relevant news for long-dated markets. A polling article from 5 days ago has ~0.5% weight even for an election market closing in 6 months.

**Fix:** Make half-life a function of days-to-close:

```js
function getHalfLifeHours(closesAt) {
  if (!closesAt) return 6;
  const daysOut = (new Date(closesAt) - Date.now()) / 86_400_000;
  if (daysOut < 1)   return 6;    // same-day: aggressive decay
  if (daysOut < 7)   return 24;   // this week: 1-day half-life
  if (daysOut < 30)  return 72;   // this month: 3-day half-life
  if (daysOut < 180) return 168;  // ~6 months: 1-week half-life
  return 336;                      // long-dated: 2-week half-life
}
```

Pass `market.closes` into `analyzeMarketSentiment()` and use the dynamic half-life in `recencyWeight()`.

---

### 1.10 SSE Progress Stream

**Root cause:** The dashboard polls `/api/status` every 2-3 seconds while analysis runs — noisy and laggy. Server-Sent Events push progress updates the moment they happen.

**New endpoint:** `GET /api/progress` — SSE stream

```
data: {"progress":22,"stage":"Fetching data... (1/3 sources ready)","running":true}
data: {"progress":50,"stage":"Scoring 897 markets...","running":true}
data: {"progress":100,"stage":"Done — 245 predictions, 18 top picks","running":false}
```

**Server side:** `agent-runner.js` already calls `onProgress(percent, stage)` throughout the pipeline. Wire that callback to write SSE events to all connected clients via a response set. Store active SSE responses in `server/cache.js` as a `Set`.

**Frontend:** Replace the `setInterval` polling in `App.jsx` with an `EventSource('/api/progress')` that updates status state directly. Fall back to polling if SSE connection fails.

---

## File Change Summary

### Phase 1
| File | Change |
|------|--------|
| `agent/markets.js` | Kalshi: `createPrivateKey()` + error body logging + Metaculus auth header + Manifold URL/params fix |
| `agent/collector.js` | Track + return actual successful source count alongside total |
| `agent/sentiment.js` | Dynamic half-life based on market close date; accept `closesAt` param |
| `agent/analyzer.js` | Pass `market.closes` to `analyzeMarketSentiment()` |
| `server/cache.js` | New — extracted from server.js; add history append + SSE clients Set |
| `server/agent-runner.js` | New — extracted from server.js; wire onProgress to SSE broadcast |
| `server/routes.js` | New — extracted from server.js; add `/api/progress` SSE + `/api/history` |
| `server.js` | Refactored to ~40-line entry point; fix static serving to use single `dist/` |
| `vite.config.js` | outDir → `dist`, remove `emptyOutDir: false` |
| `src/App.jsx` | Replace status polling with EventSource SSE; show `sourcesSucceeded/sourcesChecked` |
| `scripts/test-kalshi-auth.js` | New — standalone auth debug script |

### Phase 2
| File | Change |
|------|--------|
| `agent/ai-engine.js` | New — Claude integration |
| `agent/analyzer.js` | Add Signal 5 (Claude), call ai-engine, store aiAnalysis on prediction |
| `server/routes.js` | Add `/api/chat` and `/api/briefing` endpoints |
| `server/cache.js` | Add briefing field |
| `src/components/PredictionDetail.jsx` | Add confidence breakdown + AI reasoning section |
| `src/components/Briefing.jsx` | New — daily briefing component |
| `src/components/AIChat.jsx` | New — floating chat panel |
| `src/App.jsx` | Add Briefing + AIChat components |

---

## Out of Scope
- Palantir data streams (enterprise-gated, not publicly accessible)
- User accounts / saved picks
- Real-money trade execution
- GDELT / Alpha Vantage / BLS integration (can be added as Signal 6+ later)
