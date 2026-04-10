# PredictIQ Phase 1 — Fixes & Server Refactor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Kalshi/Manifold/Metaculus data sources, improve sentiment scoring and source tracking, refactor server.js into clean modules, add SSE progress streaming, and historical score tracking.

**Architecture:** Data source fixes go in `agent/markets.js`, `agent/collector.js`, `agent/sentiment.js`. Server monolith splits into `server/cache.js` (state), `server/agent-runner.js` (pipeline), `server/routes.js` (HTTP), with `server.js` as a slim entry point. Frontend replaces polling with SSE.

**Tech Stack:** Node.js 18+, Express 4, node-cron, Vite 5, React 18, built-in `crypto` module (no new deps required)

---

## File Map

**Modified:**
- `agent/markets.js` — Kalshi RSA fix, Metaculus auth header, Manifold param fix
- `agent/collector.js` — track real succeeded source count
- `agent/sentiment.js` — dynamic half-life based on market close date
- `agent/analyzer.js` — pass `newsSourcesSucceeded` through result; call updated sentiment signature
- `vite.config.js` — outDir → `dist`, remove `emptyOutDir: false`
- `src/App.jsx` — replace polling with SSE EventSource, show succeeded/total source count

**Created:**
- `server/cache.js` — shared in-memory store, disk persistence, SSE client set, history append
- `server/agent-runner.js` — runAgent() wired to cache and SSE broadcast
- `server/routes.js` — all Express routes including `/api/progress` SSE and `/api/history`
- `scripts/test-kalshi-auth.js` — standalone Kalshi credential verification

**Replaced:**
- `server.js` — gutted to ~40-line entry point that wires the above modules

**Deleted:**
- `dist2/` directory (stale build)
- `dist3/` directory (stale build)

---

## Task 1: Fix Kalshi Auth (PKCS#1 Key Wrapping)

**Files:**
- Modify: `agent/markets.js` — `buildKalshiHeaders()` function, lines 110–160

The bug: Node.js `crypto.sign()` is unreliable with raw PKCS#1 PEM strings for RSA-PSS. Wrapping in `crypto.createPrivateKey()` forces correct key parsing. Also adds `err.response?.data` logging so Kalshi's rejection message is visible.

- [ ] **Step 1: Open `agent/markets.js` and replace `buildKalshiHeaders`**

Replace the entire `buildKalshiHeaders` function (lines 110–160) with:

```js
function buildKalshiHeaders(method, urlPath) {
  try { require('dotenv').config(); } catch {}
  const crypto = require('crypto');
  const fs     = require('fs');
  const path   = require('path');

  const keyId   = process.env.KALSHI_KEY_ID;
  const keyFile = process.env.KALSHI_KEY_FILE;

  if (!keyId || !keyFile) return null;

  const keyPath = path.isAbsolute(keyFile)
    ? keyFile
    : path.join(__dirname, '..', keyFile);

  if (!fs.existsSync(keyPath)) {
    console.warn(`[Markets] Kalshi: key file not found at ${keyPath}`);
    return null;
  }

  const privateKeyPem = fs.readFileSync(keyPath, 'utf8');
  const timestampMs   = Date.now().toString();
  const pathOnly      = urlPath.split('?')[0];
  const message       = timestampMs + method.toUpperCase() + pathOnly;

  try {
    // Wrap PEM in KeyObject — required for reliable RSA-PSS with PKCS#1 keys
    const privateKeyObj = crypto.createPrivateKey({ key: privateKeyPem, format: 'pem' });
    const signature = crypto.sign(
      'sha256',
      Buffer.from(message),
      {
        key: privateKeyObj,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      }
    );

    return {
      'KALSHI-ACCESS-KEY':       keyId,
      'KALSHI-ACCESS-TIMESTAMP': timestampMs,
      'KALSHI-ACCESS-SIGNATURE': signature.toString('base64'),
      'Content-Type':            'application/json',
      'Accept':                  'application/json',
    };
  } catch (err) {
    console.warn('[Markets] Kalshi: signing failed —', err.message);
    return null;
  }
}
```

- [ ] **Step 2: Add response body logging to Kalshi error handler**

Find the catch block in `fetchKalshi()` that checks `status === 401 || status === 403` and replace it:

```js
  } catch (err) {
    const status = err.response?.status;
    const body   = err.response?.data;
    if (status === 401 || status === 403) {
      console.error(
        '[Markets] Kalshi: auth failed (' + status + ').\n' +
        '  Body: ' + JSON.stringify(body) + '\n' +
        '  → Check KALSHI_KEY_ID matches the private key in KALSHI_KEY_FILE'
      );
    } else {
      console.warn('[Markets] Kalshi primary endpoint failed:', err.message, body ? JSON.stringify(body) : '');
    }
  }
```

- [ ] **Step 3: Verify the fix compiles cleanly**

```bash
node -e "require('./agent/markets')" 2>&1
```

Expected: no output (no syntax errors on require).

- [ ] **Step 4: Commit**

```bash
git add agent/markets.js
git commit -m "fix: wrap Kalshi PKCS#1 key in createPrivateKey for reliable RSA-PSS signing"
```

---

## Task 2: Fix Metaculus Auth Header

**Files:**
- Modify: `agent/markets.js` — `fetchMetaculus()` function, lines 293–320

- [ ] **Step 1: Update `fetchMetaculus()` to add auth header when key is present**

Replace the `axios.get` call inside `fetchMetaculus()` with:

```js
async function fetchMetaculus() {
  try {
    const headers = {
      'User-Agent': 'PredictIQ-Dashboard/1.0',
      'Accept':     'application/json',
    };
    if (process.env.METACULUS_API_KEY) {
      headers['Authorization'] = `Token ${process.env.METACULUS_API_KEY}`;
    }

    const { data } = await axios.get(
      'https://www.metaculus.com/api2/questions/?status=open&type=forecast&limit=100&order_by=-activity',
      { timeout: 12000, headers }
    );

    const questions = (data.results || [])
      .filter(q => q.community_prediction?.full?.q2 != null)
      .map(q => ({
        id:          `metaculus_${q.id}`,
        title:       q.title || '',
        probability: q.community_prediction.full.q2,
        url:         `https://www.metaculus.com/questions/${q.id}`,
        closes:      q.resolution_date || null,
        forecasters: q.number_of_forecasters || 0,
        source:      'Metaculus',
      }));

    console.log(`[Markets] Metaculus: ${questions.length} reference forecasts loaded`);
    return questions;
  } catch (err) {
    console.error('[Markets] Metaculus error:', err.response?.status || err.message);
    return [];
  }
}
```

- [ ] **Step 2: Verify**

```bash
node -e "require('./agent/markets')" 2>&1
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add agent/markets.js
git commit -m "fix: add Metaculus Authorization header when METACULUS_API_KEY is set"
```

---

## Task 3: Fix Manifold 400 Error

**Files:**
- Modify: `agent/markets.js` — `fetchManifold()` function, lines 326–351

- [ ] **Step 1: Update `fetchManifold()` — remove deprecated `sort=liquidity`**

Replace the entire `fetchManifold` function:

```js
async function fetchManifold() {
  try {
    const { data } = await axios.get(
      'https://manifold.markets/api/v0/markets?limit=100&filter=open',
      { timeout: 12000, headers: { 'User-Agent': 'PredictIQ-Dashboard/1.0' } }
    );

    const markets = (Array.isArray(data) ? data : [])
      .filter(m => m.probability != null && m.outcomeType === 'BINARY')
      .map(m => ({
        id:         `manifold_${m.id}`,
        title:      m.question || '',
        probability: m.probability,
        url:        m.url || 'https://manifold.markets',
        closes:     m.closeTime ? new Date(m.closeTime).toISOString() : null,
        liquidity:  m.totalLiquidity || 0,
        source:     'Manifold',
      }));

    console.log(`[Markets] Manifold: ${markets.length} reference forecasts loaded`);
    return markets;
  } catch (err) {
    console.error('[Markets] Manifold error:', err.response?.status || err.message);
    return [];
  }
}
```

- [ ] **Step 2: Verify**

```bash
node -e "require('./agent/markets')" 2>&1
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add agent/markets.js
git commit -m "fix: remove deprecated sort=liquidity param from Manifold API call"
```

---

## Task 4: Add Kalshi Auth Test Script

**Files:**
- Create: `scripts/test-kalshi-auth.js`

- [ ] **Step 1: Create `scripts/` directory and write the script**

```bash
mkdir -p scripts
```

Create `scripts/test-kalshi-auth.js`:

```js
/**
 * scripts/test-kalshi-auth.js
 * Standalone Kalshi credential verification — runs a single signed request
 * and prints the full response so you can confirm auth works without
 * running the full agent.
 *
 * Usage: node scripts/test-kalshi-auth.js
 */

require('dotenv').config();
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const axios  = require('axios');

const keyId   = process.env.KALSHI_KEY_ID;
const keyFile = process.env.KALSHI_KEY_FILE;

if (!keyId || !keyFile) {
  console.error('❌ Missing KALSHI_KEY_ID or KALSHI_KEY_FILE in .env');
  process.exit(1);
}

const keyPath = path.isAbsolute(keyFile)
  ? keyFile
  : path.join(__dirname, '..', keyFile);

if (!fs.existsSync(keyPath)) {
  console.error(`❌ Key file not found: ${keyPath}`);
  process.exit(1);
}

const privateKeyPem = fs.readFileSync(keyPath, 'utf8');
const keyType = privateKeyPem.split('\n')[0];
console.log(`Key type: ${keyType}`);
console.log(`Key ID:   ${keyId}`);

const timestampMs   = Date.now().toString();
const urlPath       = '/trade-api/v2/markets';
const message       = timestampMs + 'GET' + urlPath;

let signature;
try {
  const privateKeyObj = crypto.createPrivateKey({ key: privateKeyPem, format: 'pem' });
  signature = crypto.sign('sha256', Buffer.from(message), {
    key: privateKeyObj,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  console.log('✅ Signing succeeded');
} catch (err) {
  console.error('❌ Signing failed:', err.message);
  process.exit(1);
}

const headers = {
  'KALSHI-ACCESS-KEY':       keyId,
  'KALSHI-ACCESS-TIMESTAMP': timestampMs,
  'KALSHI-ACCESS-SIGNATURE': signature.toString('base64'),
  'Content-Type':            'application/json',
  'Accept':                  'application/json',
};

console.log('\nSending test request to Kalshi...');

axios.get('https://trading-api.kalshi.com/trade-api/v2/markets?status=open&limit=5', {
  headers,
  timeout: 10000,
})
  .then(({ data }) => {
    console.log('✅ Auth successful!');
    console.log(`Markets returned: ${data.markets?.length ?? 0}`);
    if (data.markets?.length) {
      console.log('Sample markets:');
      data.markets.slice(0, 3).forEach(m =>
        console.log(`  ${m.ticker} — ${m.title}`)
      );
    }
  })
  .catch(err => {
    console.error('❌ Request failed');
    console.error('  Status:', err.response?.status);
    console.error('  Body:  ', JSON.stringify(err.response?.data, null, 2));
  });
```

- [ ] **Step 2: Run the test script**

```bash
node scripts/test-kalshi-auth.js
```

Expected on success:
```
Key type: -----BEGIN RSA PRIVATE KEY-----
Key ID:   10c43512-ec9b-47e4-be79-921ae279f755
✅ Signing succeeded
Sending test request to Kalshi...
✅ Auth successful!
Markets returned: 5
Sample markets:
  FED-25APR — Will the Fed cut rates in April 2025?
  ...
```

If you see `❌ Request failed` with `Status: 403` and a body like `{"code":"invalid_key"}`, the Key ID and private key file are from different API keys — regenerate on kalshi.com and update `.env`.

- [ ] **Step 3: Commit**

```bash
git add scripts/test-kalshi-auth.js
git commit -m "feat: add standalone Kalshi auth verification script"
```

---

## Task 5: Fix Collector — Honest Source Count

**Files:**
- Modify: `agent/collector.js` — `collectAllNews()` function (lines 241–285)
- Modify: `agent/analyzer.js` — pass `newsSourcesSucceeded` through result

- [ ] **Step 1: Update `collectAllNews()` to track succeeded sources**

Replace the `collectAllNews` function:

```js
async function collectAllNews() {
  console.log(`[Collector] Starting: ${RSS_SOURCES.length} RSS + ${REDDIT_SOURCES.length} subreddits + Hacker News...`);

  let sourcesSucceeded = 0;

  // RSS in batches of 6
  const rssBatches = chunkArray(RSS_SOURCES, 6);
  let allRSS = [];
  for (const batch of rssBatches) {
    const results = await Promise.allSettled(batch.map(fetchRSS));
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.length > 0) {
        allRSS = allRSS.concat(r.value);
        sourcesSucceeded++;
      }
    }
  }

  // Reddit in batches of 3
  const redditBatches = chunkArray(REDDIT_SOURCES, 3);
  let allReddit = [];
  for (const batch of redditBatches) {
    const results = await Promise.allSettled(batch.map(fetchReddit));
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.length > 0) {
        allReddit = allReddit.concat(r.value);
        sourcesSucceeded++;
      }
    }
    await delay(400);
  }

  // Hacker News
  const hn = await fetchHackerNews();
  if (hn.length > 0) sourcesSucceeded++;

  const all = [...allRSS, ...allReddit, ...hn];

  // Deduplicate by title (first 60 chars)
  const seen   = new Set();
  const deduped = all.filter(item => {
    const key = item.title.toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  deduped.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  const totalSources = RSS_SOURCES.length + REDDIT_SOURCES.length + 1;
  console.log(`[Collector] ✓ ${deduped.length} unique articles — ${sourcesSucceeded}/${totalSources} sources responded`);

  return { articles: deduped, sourcesChecked: totalSources, sourcesSucceeded };
}
```

- [ ] **Step 2: Update `agent/analyzer.js` to thread `sourcesSucceeded` through**

In `runFullAnalysis`, find where `sources` is set and update the return:

```js
  const allMarkets  = marketsResult;
  const allArticles = newsResult.articles;
  const sources     = newsResult.sourcesChecked;
  const sourcesSucceeded = newsResult.sourcesSucceeded;
```

And update the return statement at the bottom of `runFullAnalysis`:

```js
  return {
    predictions,
    news:                  allArticles.slice(0, 120),
    marketsChecked:        allMarkets.length,
    newsSourcesChecked:    sources,
    newsSourcesSucceeded:  sourcesSucceeded,
    economicIndicators:    Object.keys(economicData).length,
  };
```

- [ ] **Step 3: Update `server.js` to store `newsSourcesSucceeded` in cache status**

Find where `cache.status.newsSourcesChecked` is set in `runAgent()` and add the new field alongside it:

```js
    cache.status.marketsChecked          = result.marketsChecked;
    cache.status.newsSourcesChecked      = result.newsSourcesChecked;
    cache.status.newsSourcesSucceeded    = result.newsSourcesSucceeded;
```

Also add `newsSourcesSucceeded: 0` to the initial `cache.status` object at the top of `server.js`.

- [ ] **Step 4: Verify**

```bash
node -e "require('./agent/collector')" 2>&1
node -e "require('./agent/analyzer')" 2>&1
```

Expected: no output (no syntax errors).

- [ ] **Step 5: Commit**

```bash
git add agent/collector.js agent/analyzer.js server.js
git commit -m "fix: track actual succeeded source count instead of hardcoded total"
```

---

## Task 6: Dynamic Sentiment Half-Life

**Files:**
- Modify: `agent/sentiment.js` — `recencyWeight()` and `analyzeMarketSentiment()`

- [ ] **Step 1: Replace `HALF_LIFE_HOURS` constant and `recencyWeight` function**

In `agent/sentiment.js`, replace:

```js
const HALF_LIFE_HOURS = 6;
const DECAY_CONSTANT  = Math.LN2 / HALF_LIFE_HOURS;  // 0.1155

function recencyWeight(publishedAt) {
  if (!publishedAt) return 0.5;
  const ageHours = (Date.now() - new Date(publishedAt)) / 3_600_000;
  if (ageHours < 0) return 1.0;
  return Math.exp(-DECAY_CONSTANT * ageHours);
}
```

With:

```js
// Half-life scales with how far out the market closes.
// Same-day markets decay aggressively; long-dated markets weight older news more.
function getHalfLifeHours(closesAt) {
  if (!closesAt) return 6;
  const daysOut = (new Date(closesAt) - Date.now()) / 86_400_000;
  if (daysOut < 1)   return 6;    // same-day: 6h half-life
  if (daysOut < 7)   return 24;   // this week: 1-day half-life
  if (daysOut < 30)  return 72;   // this month: 3-day half-life
  if (daysOut < 180) return 168;  // ~6 months: 1-week half-life
  return 336;                      // long-dated: 2-week half-life
}

function recencyWeight(publishedAt, halfLifeHours) {
  if (!publishedAt) return 0.5;
  const ageHours     = (Date.now() - new Date(publishedAt)) / 3_600_000;
  if (ageHours < 0) return 1.0;
  const decayConst   = Math.LN2 / halfLifeHours;
  return Math.exp(-decayConst * ageHours);
}
```

- [ ] **Step 2: Update `analyzeMarketSentiment` to use dynamic half-life**

In `analyzeMarketSentiment(market, articles)`, replace the line that calls `recencyWeight`:

```js
  const halfLifeHours = getHalfLifeHours(market.closes);

  const scored = articles.map(article => {
    const text = `${article.title} ${article.summary}`.toLowerCase();
    const matchCount = keywords.filter(kw => text.includes(kw)).length;
    const relevance  = matchCount / Math.max(keywords.length, 1);

    const cred    = article.credibility || 1.0;
    const recency = recencyWeight(article.publishedAt, halfLifeHours);
    const weight  = relevance * cred * recency;

    return {
      ...article,
      relevance,
      weight,
      sentiment: scoreSentiment(`${article.title} ${article.summary}`),
    };
  });
```

- [ ] **Step 3: Verify**

```bash
node -e "require('./agent/sentiment')" 2>&1
```

Expected: no output.

- [ ] **Step 4: Quick sanity check in node REPL**

```bash
node -e "
const { analyzeMarketSentiment } = require('./agent/sentiment');
const market = { title: 'Will Trump win the 2028 election?', closes: new Date(Date.now() + 180*86400000).toISOString() };
const result = analyzeMarketSentiment(market, []);
console.log('OK — relevantCount:', result.relevantCount);
"
```

Expected: `OK — relevantCount: 0` (no articles passed, no crash)

- [ ] **Step 5: Commit**

```bash
git add agent/sentiment.js
git commit -m "feat: scale sentiment recency half-life by market close date (6h same-day → 2wk long-dated)"
```

---

## Task 7: Create `server/cache.js`

**Files:**
- Create: `server/cache.js`

This module owns all shared in-memory state, disk persistence, history appending, and SSE client management.

- [ ] **Step 1: Create `server/` directory and write `cache.js`**

```bash
mkdir -p server
```

Create `server/cache.js`:

```js
/**
 * server/cache.js — Shared in-memory state, disk persistence, and SSE clients
 *
 * Exports:
 *   getCache()                      — returns the live cache object (by reference)
 *   updateCache(patch)              — shallow-merges patch; deep-merges patch.status
 *   persistToDisk()                 — writes predictions/news/status to data/latest.json
 *   appendHistory()                 — appends scored summary to data/history.jsonl (capped 720 entries)
 *   loadFromDisk()                  — hydrates cache from data/latest.json on startup
 *   broadcastProgress(pct, stage)  — sends SSE event to all connected clients
 *   addSSEClient(res)               — registers an SSE response stream
 *   removeSSEClient(res)            — deregisters an SSE response stream
 */

const fs   = require('fs');
const path = require('path');

const DATA_FILE    = path.join(__dirname, '..', 'data', 'latest.json');
const HISTORY_FILE = path.join(__dirname, '..', 'data', 'history.jsonl');
const MAX_HISTORY  = 720; // ~30 days at hourly runs

// ── Internal state ────────────────────────────────────────────────────────────
const sseClients = new Set();

let cache = {
  predictions: [],
  news:        [],
  status: {
    lastRun:               null,
    nextRun:               null,
    running:               false,
    marketsChecked:        0,
    newsSourcesChecked:    0,
    newsSourcesSucceeded:  0,
    topPickCount:          0,
    error:                 null,
    runCount:              0,
    progress:              0,
    progressStage:         'Idle',
  },
};

// ── Public API ────────────────────────────────────────────────────────────────
function getCache() {
  return cache;
}

function updateCache(patch) {
  const { status: statusPatch, ...rest } = patch;
  Object.assign(cache, rest);
  if (statusPatch) {
    Object.assign(cache.status, statusPatch);
  }
}

function broadcastProgress(progress, stage) {
  const payload = JSON.stringify({ progress, stage, running: cache.status.running });
  for (const res of sseClients) {
    try { res.write(`data: ${payload}\n\n`); } catch { sseClients.delete(res); }
  }
}

function addSSEClient(res) {
  sseClients.add(res);
}

function removeSSEClient(res) {
  sseClients.delete(res);
}

function persistToDisk() {
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify({
    predictions: cache.predictions,
    news:        cache.news,
    status:      cache.status,
  }, null, 2));
}

function appendHistory() {
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const record = {
    runAt: new Date().toISOString(),
    predictions: cache.predictions.map(p => ({
      id:                   p.id,
      platform:             p.platform,
      title:                p.title,
      finalScore:           p.finalScore,
      confidence:           p.confidence,
      currentPrice:         p.currentPrice,
      estimatedProbability: p.estimatedProbability,
      bestEV:               p.bestEV,
      isTopPick:            p.isTopPick,
    })),
  };

  let lines = [];
  if (fs.existsSync(HISTORY_FILE)) {
    lines = fs.readFileSync(HISTORY_FILE, 'utf-8').split('\n').filter(Boolean);
  }
  lines.push(JSON.stringify(record));
  if (lines.length > MAX_HISTORY) lines = lines.slice(lines.length - MAX_HISTORY);
  fs.writeFileSync(HISTORY_FILE, lines.join('\n') + '\n');
}

function loadFromDisk() {
  if (!fs.existsSync(DATA_FILE)) return;
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    Object.assign(cache, saved);
    Object.assign(cache.status, saved.status || {});
    cache.status.running = false; // always start non-running
    console.log(`[Cache] Loaded ${cache.predictions.length} cached predictions from disk.`);
  } catch (e) {
    console.error('[Cache] Failed to load cached data:', e.message);
  }
}

module.exports = {
  getCache,
  updateCache,
  persistToDisk,
  appendHistory,
  loadFromDisk,
  broadcastProgress,
  addSSEClient,
  removeSSEClient,
};
```

- [ ] **Step 2: Verify**

```bash
node -e "const c = require('./server/cache'); c.loadFromDisk(); console.log('predictions:', c.getCache().predictions.length)" 2>&1
```

Expected: `predictions: 745` (or whatever is in data/latest.json)

- [ ] **Step 3: Commit**

```bash
git add server/cache.js
git commit -m "feat: add server/cache.js — shared state, disk persistence, SSE broadcast, history"
```

---

## Task 8: Create `server/agent-runner.js`

**Files:**
- Create: `server/agent-runner.js`

- [ ] **Step 1: Create `server/agent-runner.js`**

```js
/**
 * server/agent-runner.js — Runs the full analysis pipeline
 *
 * Exports:
 *   runAgent() — triggers analysis; no-ops if already running
 *
 * Dependencies: server/cache.js (state), agent/analyzer.js (pipeline)
 * No HTTP, no cron — just the run logic.
 */

const { runFullAnalysis }  = require('../agent/analyzer');
const {
  getCache,
  updateCache,
  persistToDisk,
  appendHistory,
  broadcastProgress,
} = require('./cache');

async function runAgent() {
  const cache = getCache();
  if (cache.status.running) {
    console.log('[Agent] Already running, skipping...');
    return;
  }

  updateCache({ status: { running: true, error: null, progress: 0, progressStage: 'Starting…' } });
  console.log('[Agent] ── Analysis started ──────────────────────');

  const onProgress = (percent, stage) => {
    updateCache({ status: { progress: percent, progressStage: stage } });
    broadcastProgress(percent, stage);
    console.log(`[Agent] ${String(percent).padStart(3)}%  ${stage}`);
  };

  try {
    const result = await runFullAnalysis(onProgress);

    updateCache({
      predictions: result.predictions,
      news:        result.news,
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

module.exports = { runAgent };
```

- [ ] **Step 2: Verify**

```bash
node -e "require('./server/agent-runner')" 2>&1
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add server/agent-runner.js
git commit -m "feat: add server/agent-runner.js — extracted runAgent from server.js"
```

---

## Task 9: Create `server/routes.js`

**Files:**
- Create: `server/routes.js`

Includes all existing API routes plus new `/api/progress` (SSE) and `/api/history`.

- [ ] **Step 1: Create `server/routes.js`**

```js
/**
 * server/routes.js — All Express API routes
 *
 * Exports:
 *   createRouter() — returns an Express Router mounted at /api
 *
 * Routes:
 *   GET  /api/predictions           — all scored predictions
 *   GET  /api/news                  — latest articles
 *   GET  /api/status                — agent run status
 *   GET  /api/progress              — SSE stream for live progress updates
 *   GET  /api/history               — historical score records (jsonl → array)
 *   GET  /api/price-history/:id     — on-demand price history from platform APIs
 *   POST /api/refresh               — trigger immediate re-analysis
 */

const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

const {
  getCache,
  addSSEClient,
  removeSSEClient,
} = require('./cache');
const { runAgent } = require('./agent-runner');

const HISTORY_FILE = path.join(__dirname, '..', 'data', 'history.jsonl');

function createRouter() {
  const router = express.Router();

  // ── Predictions & news ─────────────────────────────────────────────────────
  router.get('/predictions', (_req, res) => {
    res.json(getCache().predictions);
  });

  router.get('/news', (_req, res) => {
    res.json(getCache().news);
  });

  // ── Status ─────────────────────────────────────────────────────────────────
  router.get('/status', (_req, res) => {
    res.json(getCache().status);
  });

  // ── SSE progress stream ────────────────────────────────────────────────────
  router.get('/progress', (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    // Send current status immediately so client knows where we are
    const s = getCache().status;
    res.write(`data: ${JSON.stringify({ progress: s.progress, stage: s.progressStage, running: s.running })}\n\n`);

    addSSEClient(res);
    req.on('close', () => removeSSEClient(res));
  });

  // ── History ────────────────────────────────────────────────────────────────
  router.get('/history', (_req, res) => {
    if (!fs.existsSync(HISTORY_FILE)) return res.json([]);
    const lines   = fs.readFileSync(HISTORY_FILE, 'utf-8').split('\n').filter(Boolean);
    const records = lines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    res.json(records);
  });

  // ── On-demand price history ────────────────────────────────────────────────
  router.get('/price-history/:marketId', async (req, res) => {
    const { marketId } = req.params;
    try {
      if (marketId.startsWith('polymarket_')) {
        const pred = getCache().predictions.find(p => p.id === marketId);
        const conditionId = pred?.conditionId;
        if (conditionId) {
          const endTs   = Math.floor(Date.now() / 1000);
          const startTs = endTs - 7 * 24 * 3600;
          const { data } = await axios.get(
            `https://clob.polymarket.com/prices-history?market=${conditionId}&startTs=${startTs}&endTs=${endTs}&fidelity=120`,
            { timeout: 8000 }
          );
          return res.json({ source: 'Polymarket CLOB', history: data.history || [] });
        }
      }
      if (marketId.startsWith('predictit_')) {
        const parts      = marketId.replace('predictit_', '').split('_');
        const contractId = parts[1];
        const { data } = await axios.get(
          `https://www.predictit.org/api/Trade/${contractId}/PriceHistory`,
          { timeout: 8000, headers: { 'User-Agent': 'PredictIQ-Dashboard/1.0' } }
        );
        const history = (data || []).map(d => ({ t: d.dateString, p: d.closeSharePrice }));
        return res.json({ source: 'PredictIt', history });
      }
      res.json({ source: null, history: [] });
    } catch (err) {
      res.json({ source: null, history: [], error: err.message });
    }
  });

  // ── Manual refresh ─────────────────────────────────────────────────────────
  router.post('/refresh', (_req, res) => {
    if (getCache().status.running) {
      return res.json({ message: 'Analysis already in progress.' });
    }
    res.json({ message: 'Analysis started. Results available shortly.' });
    runAgent();
  });

  return router;
}

module.exports = { createRouter };
```

- [ ] **Step 2: Verify**

```bash
node -e "require('./server/routes')" 2>&1
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add server/routes.js
git commit -m "feat: add server/routes.js — all API routes extracted from server.js, add SSE /progress and /history"
```

---

## Task 10: Refactor `server.js` to Slim Entry Point

**Files:**
- Modify: `server.js` — replace entire file content

- [ ] **Step 1: Replace `server.js` with slim entry point**

Overwrite the entire file:

```js
/**
 * server.js — Entry point
 *
 * Wires together server/cache, server/agent-runner, server/routes.
 * Sets up hourly cron and starts the HTTP server.
 *
 * Run:  node server.js
 * Dev:  npm run dev  (concurrently runs vite + this server)
 */

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');
const path    = require('path');
const fs      = require('fs');

const { loadFromDisk, updateCache } = require('./server/cache');
const { runAgent }                  = require('./server/agent-runner');
const { createRouter }              = require('./server/routes');

const app  = express();
const PORT = process.env.PORT || 3001;
const DIST = path.join(__dirname, 'dist');

app.use(cors());
app.use(express.json());

loadFromDisk();

app.use('/api', createRouter());
app.use(express.static(DIST));
app.get('*', (_req, res) => {
  const idx = path.join(DIST, 'index.html');
  fs.existsSync(idx)
    ? res.sendFile(idx)
    : res.status(200).send(`
        <html><body style="font-family:monospace;padding:2rem;background:#050d1e;color:#22c55e">
          <h2>🔮 PredictIQ Server Running</h2>
          <p>API live at <a href="/api/status" style="color:#3b82f6">/api/status</a></p>
          <p>Run <code>npm run build</code> then reload to see the dashboard.</p>
        </body></html>
      `);
});

function scheduleNextRun() {
  updateCache({ status: { nextRun: new Date(Date.now() + 60 * 60 * 1000).toISOString() } });
}

cron.schedule('0 * * * *', () => {
  console.log('[Cron] ⏰ Hourly trigger fired');
  scheduleNextRun();
  runAgent();
});

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   🔮 PredictIQ Server                  ║
║   http://localhost:${PORT}               ║
║   Hourly analysis: ENABLED             ║
╚════════════════════════════════════════╝
  `);
  scheduleNextRun();
  runAgent();
});
```

- [ ] **Step 2: Start the server and confirm it works**

```bash
node server.js
```

Expected output (within ~30 seconds):
```
[Cache] Loaded 745 cached predictions from disk.
╔════════════════════════════════════════╗
║   🔮 PredictIQ Server                  ║
...
[Agent] ── Analysis started ──────────────────────
[Agent]   3%  Connecting to data sources...
[Markets] Polymarket: 100 markets loaded
[Markets] Kalshi: 200 markets loaded        ← NEW: should appear now
[Markets] Metaculus: 85 reference forecasts loaded   ← NEW
[Markets] Manifold: 97 reference forecasts loaded    ← NEW (was failing)
```

- [ ] **Step 3: Confirm all API endpoints respond**

```bash
curl -s http://localhost:3001/api/status | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.parse(d).progressStage))"
```

Expected: `Idle` or `Starting…` or a progress stage.

```bash
curl -s http://localhost:3001/api/predictions | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log('predictions:', JSON.parse(d).length))"
```

Expected: `predictions: 745` (or more once new analysis completes).

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "refactor: slim server.js to entry point — delegates to server/cache, agent-runner, routes"
```

---

## Task 11: Fix Vite Config + Clean Build Dirs

**Files:**
- Modify: `vite.config.js`
- Delete: `dist2/`, `dist3/`

- [ ] **Step 1: Update `vite.config.js`**

Replace the entire file:

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
```

- [ ] **Step 2: Delete stale build directories**

```bash
rm -rf dist2 dist3
```

- [ ] **Step 3: Run a build to confirm it lands in `dist/`**

```bash
npm run build 2>&1 | tail -5
```

Expected:
```
✓ built in Xs
dist/index.html            0.46 kB
dist/assets/index-XXX.js  ...
dist/assets/index-XXX.css ...
```

- [ ] **Step 4: Commit**

```bash
git add vite.config.js
git rm -r --cached dist2 dist3 2>/dev/null; rm -rf dist2 dist3
git commit -m "chore: unify build output to dist/, remove stale dist2/ dist3/"
```

---

## Task 12: Update Frontend — SSE + Source Count Display

**Files:**
- Modify: `src/App.jsx`

Replaces the clunky 2-3s polling loop with an SSE EventSource. Also shows `succeeded/total` source count in the status bar.

- [ ] **Step 1: Replace the "fast status polling while analysis is running" useEffect in `App.jsx`**

Find and remove this entire block (lines ~81–92):

```js
  // ── Fast status polling while analysis is running ─────────────────────────
  useEffect(() => {
    if (!status.running) return;
    const fastPoll = setInterval(async () => {
      try {
        const res = await fetch('/api/status');
        const s   = await res.json();
        setStatus(s);
        if (!s.running) fetchData();
      } catch {}
    }, 2000);
    return () => clearInterval(fastPoll);
  }, [status.running, fetchData]);
```

Replace it with:

```js
  // ── SSE progress stream — replaces polling while analysis runs ────────────
  useEffect(() => {
    const es = new EventSource('/api/progress');
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        setStatus(prev => ({
          ...prev,
          progress:      data.progress,
          progressStage: data.stage,
          running:       data.running,
        }));
        if (!data.running) fetchData();
      } catch {}
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [fetchData]);
```

- [ ] **Step 2: Update the news sources status bar item to show succeeded/total**

Find this in the status bar section (around line 255):

```jsx
        <div className="status-item">
          <span>📰</span>
          <span><strong>{status.newsSourcesChecked || 0}</strong> news sources</span>
        </div>
```

Replace with:

```jsx
        <div className="status-item">
          <span>📰</span>
          <span>
            <strong>{status.newsSourcesSucceeded || status.newsSourcesChecked || 0}</strong>
            {status.newsSourcesChecked ? `/${status.newsSourcesChecked}` : ''} news sources
          </span>
        </div>
```

- [ ] **Step 3: Start dev server and verify SSE works**

```bash
npm run dev
```

Open http://localhost:5173, click "⟳ Refresh Now", and open browser DevTools → Network tab. Filter by "EventStream". You should see a `progress` request with a stream of `data:` events updating in real time — no more rapid-fire `/api/status` calls.

- [ ] **Step 4: Commit**

```bash
git add src/App.jsx
git commit -m "feat: replace status polling with SSE EventSource; show succeeded/total source count"
```

---

## Self-Review

**Spec coverage check:**

| Spec section | Covered by task |
|---|---|
| 1.1 Kalshi PKCS#1 fix + error logging | Task 1 |
| Kalshi test script | Task 4 |
| 1.2 Manifold sort=liquidity fix | Task 3 |
| 1.3 Metaculus auth header | Task 2 |
| 1.4 FRED now active | No code change needed — key is in .env |
| 1.5 Server refactor: cache.js | Task 7 |
| 1.5 Server refactor: agent-runner.js | Task 8 |
| 1.5 Server refactor: routes.js | Task 9 |
| 1.5 Server refactor: server.js entry point | Task 10 |
| 1.6 Static serving dist3 → dist bug | Task 11 |
| 1.7 Honest newsSourcesChecked | Task 5 |
| 1.8 Historical tracking (history.jsonl) | Task 7 (appendHistory in cache.js), Task 9 (/api/history route) |
| 1.9 Dynamic sentiment half-life | Task 6 |
| 1.10 SSE progress stream | Task 9 (/api/progress route), Task 7 (broadcastProgress), Task 12 (frontend) |
| dist2/dist3 cleanup | Task 11 |

All spec sections covered. ✅

---

## Execution Options

Plan complete and saved to `docs/superpowers/plans/2026-04-08-phase1-fixes-and-refactor.md`.

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
