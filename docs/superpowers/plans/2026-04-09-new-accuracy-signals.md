# New Accuracy Signals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three new probability signals — bookmaker consensus (Signal 6), financial market correlations (Signal 7), and polling/legislative data (Signal 8) — to the prediction scoring pipeline in `analyzer.js`.

**Architecture:** Each signal is a standalone module (parallel to `agent/fred.js`) with a `fetchXxxData()` function and a `matchXxxContext(title, data)` function. All three are fetched in parallel during each analyzer run, then merged into `scorePrediction`'s signal pool and passed as additional context to the Claude AI prompt.

**Tech Stack:** Node.js, axios (already installed), The Odds API, Polygon.io, CME Group public API, FiveThirtyEight CSV endpoints, Congress.gov REST API.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `agent/odds.js` | Create | Signal 6 — fetch + match bookmaker consensus from The Odds API |
| `agent/financial.js` | Create | Signal 7 — fetch + match CME FedWatch + Polygon.io prices |
| `agent/polling.js` | Create | Signal 8 — fetch + match 538 polling averages + Congress.gov bill status |
| `agent/test-signals.js` | Create | Smoke tests for all three new modules (no test framework required) |
| `agent/analyzer.js` | Modify | Add 3 requires, parallel fetches, pass data to scorePrediction, merge signals, enrich AI context |
| `.env` | Modify | Add ODDS_API_KEY, POLYGON_API_KEY, CONGRESS_API_KEY |

---

## Task 1: Create `agent/odds.js` — Signal 6 (Bookmaker Consensus)

**Files:**
- Create: `agent/odds.js`

- [ ] **Step 1: Write the test first**

Create `agent/test-signals.js` with the odds module tests:

```js
// agent/test-signals.js
// Run with: node agent/test-signals.js
// Requires ODDS_API_KEY in .env (or omit key to test graceful degradation)

require('dotenv').config({ override: true });
const assert = require('assert');

async function testOdds() {
  const { fetchOddsData, matchOddsContext } = require('./odds');

  console.log('[Test] odds.js — fetchOddsData() with no key → should return {}');
  const saved = process.env.ODDS_API_KEY;
  delete process.env.ODDS_API_KEY;
  const emptyResult = await fetchOddsData();
  assert.deepStrictEqual(emptyResult, {}, 'Should return {} when key is missing');
  process.env.ODDS_API_KEY = saved;
  console.log('  ✓ no-key graceful degradation');

  console.log('[Test] matchOddsContext() — known team name match');
  const fakeData = {
    americanfootball_nfl: [{
      id: 'abc',
      home_team: 'Kansas City Chiefs',
      away_team: 'Philadelphia Eagles',
      bookmakers: [
        { key: 'draftkings', markets: [{ key: 'h2h', outcomes: [
          { name: 'Kansas City Chiefs', price: 1.75 },
          { name: 'Philadelphia Eagles', price: 2.10 },
        ]}]},
        { key: 'fanduel', markets: [{ key: 'h2h', outcomes: [
          { name: 'Kansas City Chiefs', price: 1.80 },
          { name: 'Philadelphia Eagles', price: 2.05 },
        ]}]},
      ],
    }],
  };

  const match = matchOddsContext('Will the Kansas City Chiefs win the Super Bowl?', fakeData);
  assert(match !== null, 'Should find a match for "Kansas City Chiefs"');
  assert(typeof match.probability === 'number', 'probability should be a number');
  assert(match.probability > 0.5, 'Chiefs should be favourite at these odds');
  assert(match.probability < 1.0, 'probability must be < 1.0');
  assert(Array.isArray(match.indicators), 'indicators should be an array');
  assert(match.indicators[0].books === 2, 'should count 2 bookmakers');
  console.log(`  ✓ match found: prob=${match.probability.toFixed(3)}, books=${match.indicators[0].books}`);

  const noMatch = matchOddsContext('Will Bitcoin exceed $100,000?', fakeData);
  assert(noMatch === null, 'Should return null for unrelated market');
  console.log('  ✓ no-match returns null');
}

testOdds().then(() => console.log('\n[Test] odds.js ✓ all passed')).catch(err => {
  console.error('[Test] FAILED:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd "/Users/henry/Documents/Claude/Projects/prediction market agent and dashboard"
node agent/test-signals.js
```

Expected: `Error: Cannot find module './odds'`

- [ ] **Step 3: Create `agent/odds.js`**

```js
/**
 * agent/odds.js — Signal 6: Bookmaker consensus via The Odds API
 *
 * fetchOddsData()  → { sport_key: [event, ...], ... }
 * matchOddsContext(marketTitle, oddsData) → { probability, indicators } | null
 *
 * API: https://the-odds-api.com — free tier: 500 req/month
 * Set ODDS_API_KEY in .env. Gracefully returns {} if key is missing.
 *
 * De-vig formula: p_clean = (1/odds) / sum(1/odds_all_outcomes)
 * averaged across all returned bookmakers.
 */

const axios = require('axios');
try { require('dotenv').config({ override: true }); } catch {}

const BASE_URL = 'https://api.the-odds-api.com/v4';

// Sports to fetch on each run. Keep this list short — each sport = 1 API call.
const SPORTS_TO_FETCH = [
  'americanfootball_nfl',
  'basketball_nba',
  'baseball_mlb',
  'icehockey_nhl',
  'soccer_epl',
  'politics_us_presidential_election_winner',
];

// ─────────────────────────────────────────────────────────────────────────────
// fetchOddsData
// Returns { sport_key: [event, ...] } or {} on failure / missing key.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchOddsData() {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    console.log('[Odds] ODDS_API_KEY not set — skipping Signal 6');
    return {};
  }

  console.log('[Odds] Fetching bookmaker odds…');
  const results = {};

  await Promise.allSettled(
    SPORTS_TO_FETCH.map(async sport => {
      try {
        const { data } = await axios.get(`${BASE_URL}/sports/${sport}/odds`, {
          params: {
            apiKey,
            regions: 'us',
            markets: 'h2h',
            oddsFormat: 'decimal',
          },
          timeout: 8000,
        });
        if (Array.isArray(data) && data.length > 0) {
          results[sport] = data;
        }
      } catch (err) {
        if (err.response?.status === 422) return; // sport not currently active — normal
        if (err.response?.status === 401) {
          console.warn('[Odds] Invalid API key');
        } else if (err.response?.status === 429) {
          console.warn('[Odds] Rate limit hit');
        }
        // All other errors: skip silently
      }
    })
  );

  const eventCount = Object.values(results).reduce((s, arr) => s + arr.length, 0);
  console.log(`[Odds] Loaded ${eventCount} events across ${Object.keys(results).length} sports`);
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// devig
// Strips the bookmaker's margin from decimal odds for a two-outcome market.
// Returns the de-vigged probability for the first outcome.
// ─────────────────────────────────────────────────────────────────────────────
function devig(oddsA, oddsB) {
  const implied_a = 1 / oddsA;
  const implied_b = 1 / oddsB;
  const vig = implied_a + implied_b;
  return implied_a / vig;
}

// ─────────────────────────────────────────────────────────────────────────────
// matchOddsContext
// Returns { probability, indicators } if market title matches a known event,
// otherwise null.
//
// Matching strategy: check if any word from either team name appears in the
// market title (case-insensitive). If both teams match, use home team.
// ─────────────────────────────────────────────────────────────────────────────
function matchOddsContext(marketTitle, oddsData) {
  if (!oddsData || Object.keys(oddsData).length === 0) return null;
  const title = marketTitle.toLowerCase();

  for (const [, events] of Object.entries(oddsData)) {
    for (const event of events) {
      const homeTeam = event.home_team || '';
      const awayTeam = event.away_team || '';

      // Check overlap: any significant word (≥4 chars) from team name in title
      const teamWords = w => w.toLowerCase().split(/\s+/).filter(t => t.length >= 4);
      const mentionsHome = teamWords(homeTeam).some(w => title.includes(w));
      const mentionsAway = teamWords(awayTeam).some(w => title.includes(w));

      if (!mentionsHome && !mentionsAway) continue;

      // Which side are we pricing?
      const targetIsHome = mentionsHome; // prefer home if both match

      // Compute de-vigged probability per book, then average
      const probs = [];
      for (const bookmaker of (event.bookmakers || [])) {
        const h2h = (bookmaker.markets || []).find(m => m.key === 'h2h');
        if (!h2h) continue;
        const homeOutcome = (h2h.outcomes || []).find(o => o.name === event.home_team);
        const awayOutcome = (h2h.outcomes || []).find(o => o.name === event.away_team);
        if (!homeOutcome?.price || !awayOutcome?.price) continue;
        const p = devig(homeOutcome.price, awayOutcome.price);
        probs.push(targetIsHome ? p : 1 - p);
      }

      if (probs.length === 0) continue;

      const avgProb = probs.reduce((s, p) => s + p, 0) / probs.length;
      const matchedTeam = targetIsHome ? homeTeam : awayTeam;

      return {
        probability: avgProb,
        indicators: [{
          indicator: `Bookmaker Consensus — ${matchedTeam}`,
          value: `${Math.round(avgProb * 100)}%`,
          books: probs.length,
          trend: 'unknown',
          source: 'OddsAPI',
        }],
      };
    }
  }

  return null;
}

module.exports = { fetchOddsData, matchOddsContext };
```

- [ ] **Step 4: Run test — expect pass**

```bash
node agent/test-signals.js
```

Expected output:
```
[Test] odds.js — fetchOddsData() with no key → should return {}
[Odds] ODDS_API_KEY not set — skipping Signal 6
  ✓ no-key graceful degradation
[Test] matchOddsContext() — known team name match
  ✓ match found: prob=0.573, books=2
  ✓ no-match returns null

[Test] odds.js ✓ all passed
```

- [ ] **Step 5: Commit**

```bash
cd "/Users/henry/Documents/Claude/Projects/prediction market agent and dashboard"
git add agent/odds.js agent/test-signals.js
git commit -m "feat: add agent/odds.js — Signal 6 bookmaker consensus (The Odds API)"
```

---

## Task 2: Create `agent/financial.js` — Signal 7 (CME FedWatch + Polygon.io)

**Files:**
- Create: `agent/financial.js`
- Modify: `agent/test-signals.js` (append financial tests)

- [ ] **Step 1: Append financial tests to `agent/test-signals.js`**

Add to the bottom of `agent/test-signals.js` (before the final `testOdds()` call block):

```js
async function testFinancial() {
  const { fetchFinancialData, matchFinancialContext } = require('./financial');

  console.log('\n[Test] financial.js — fetchFinancialData() with no Polygon key → partial result');
  const saved = process.env.POLYGON_API_KEY;
  delete process.env.POLYGON_API_KEY;
  const result = await fetchFinancialData();
  // Should still return something (CME doesn't need a key); won't throw
  assert(typeof result === 'object', 'Should return object even without Polygon key');
  process.env.POLYGON_API_KEY = saved;
  console.log('  ✓ no Polygon key returns object without throwing');

  console.log('[Test] matchFinancialContext() — Fed keywords match CME data');
  const fakeFin = {
    cme: { nextMeeting: '2025-06-18', cutProb: 0.34, hikeProb: 0.05, holdProb: 0.61 },
    polygon: { SPY: { close: 523.12, trend: 'rising' }, GLD: { close: 195.4, trend: 'stable' } },
  };

  const fedMatch = matchFinancialContext('Will the Fed cut rates at the June FOMC meeting?', fakeFin);
  assert(fedMatch !== null, 'Fed keywords should match CME data');
  assert(Math.abs(fedMatch.probability - 0.34) < 0.01, 'probability should equal cutProb');
  console.log(`  ✓ Fed match: prob=${fedMatch.probability.toFixed(3)}`);

  const spyMatch = matchFinancialContext('Will the S&P 500 close above 5500 by year end?', fakeFin);
  assert(spyMatch !== null, 'S&P keywords should match Polygon SPY data');
  assert(typeof spyMatch.probability === 'number', 'probability should be a number');
  console.log(`  ✓ S&P match: prob=${spyMatch.probability.toFixed(3)}`);

  const noMatch = matchFinancialContext('Will the Kansas City Chiefs win?', fakeFin);
  assert(noMatch === null, 'Sports market should not match financial context');
  console.log('  ✓ non-financial market returns null');
}
```

Also replace the invocation block at the bottom with:

```js
Promise.resolve()
  .then(testOdds)
  .then(testFinancial)
  .then(() => console.log('\n✅ All signal tests passed'))
  .catch(err => { console.error('\n❌ Test FAILED:', err.message); process.exit(1); });
```

- [ ] **Step 2: Run tests — financial tests should fail**

```bash
node agent/test-signals.js
```

Expected: `Error: Cannot find module './financial'`

- [ ] **Step 3: Create `agent/financial.js`**

```js
/**
 * agent/financial.js — Signal 7: Financial market correlations
 *
 * fetchFinancialData() → { cme: {...}, polygon: { TICKER: { close, trend } } }
 * matchFinancialContext(marketTitle, financialData) → { probability, indicators } | null
 *
 * Sub-sources:
 *   • CME FedWatch (no key) — Fed funds rate cut/hike/hold probabilities
 *   • Polygon.io (POLYGON_API_KEY) — equity/index/commodity prices
 */

const axios = require('axios');
try { require('dotenv').config({ override: true }); } catch {}

// Tickers to always fetch from Polygon (add more as needed)
const POLYGON_TICKERS = ['SPY', 'QQQ', 'GLD', 'USO', 'VIX'];

// ─────────────────────────────────────────────────────────────────────────────
// fetchCMEFedWatch
// Calls the CME Group's public FedWatch JSON endpoint.
// Returns { nextMeeting, cutProb, hikeProb, holdProb } or null on failure.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchCMEFedWatch() {
  try {
    // CME's FedWatch tool publishes probability data at this public endpoint.
    // It returns HTML with embedded JSON; we extract the JSON blob.
    const { data } = await axios.get(
      'https://www.cmegroup.com/CmeWS/mvc/MktData/FedWatch/get.html',
      { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );

    // The response may be JSON directly or HTML with embedded JSON.
    // Try parsing as JSON first; if that fails, extract from HTML.
    let parsed = null;
    if (typeof data === 'object') {
      parsed = data;
    } else if (typeof data === 'string') {
      const match = data.match(/var\s+fedWatchData\s*=\s*(\{[\s\S]+?\});/);
      if (match) parsed = JSON.parse(match[1]);
    }

    if (!parsed) return null;

    // Normalise: look for cut/hold/hike probabilities in the parsed object.
    // CME typically returns arrays of meetings with probability distributions.
    const meetings = parsed.meetings || parsed.data || [];
    const next = meetings[0];
    if (!next) return null;

    return {
      nextMeeting: next.meetingDate || next.date || 'unknown',
      cutProb:  parseFloat(next.cutProbability  || next.cut  || 0) / 100,
      hikeProb: parseFloat(next.hikeProbability || next.hike || 0) / 100,
      holdProb: parseFloat(next.holdProbability || next.hold || 0) / 100,
    };
  } catch {
    return null; // CME endpoint structure varies; fail silently
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchPolygonPrices
// Returns { TICKER: { close, trend, date } } or {} if no key.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchPolygonPrices(extraTickers = []) {
  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) return {};

  const tickers = [...new Set([...POLYGON_TICKERS, ...extraTickers])];
  const results = {};

  await Promise.allSettled(
    tickers.map(async ticker => {
      try {
        const { data } = await axios.get(
          `https://api.polygon.io/v2/aggs/ticker/${ticker}/prev`,
          { params: { apiKey }, timeout: 6000 }
        );
        const result = data?.results?.[0];
        if (!result) return;
        results[ticker] = {
          close: result.c,
          open:  result.o,
          high:  result.h,
          low:   result.l,
          trend: result.c >= result.o ? 'rising' : 'falling',
          date:  new Date(result.t).toISOString().split('T')[0],
        };
      } catch { /* skip individual ticker failures */ }
    })
  );

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchFinancialData
// ─────────────────────────────────────────────────────────────────────────────
async function fetchFinancialData() {
  console.log('[Financial] Fetching CME FedWatch + Polygon prices…');

  // Extract any extra stock tickers from the title? Not at fetch time — we
  // only fetch fixed tickers here. Per-market matching handles the rest.
  const [cmeResult, polygonResult] = await Promise.allSettled([
    fetchCMEFedWatch(),
    fetchPolygonPrices(),
  ]);

  const result = {
    cme:     cmeResult.status     === 'fulfilled' ? cmeResult.value     : null,
    polygon: polygonResult.status === 'fulfilled' ? polygonResult.value : {},
  };

  const hasPolygon = Object.keys(result.polygon).length > 0;
  console.log(`[Financial] CME: ${result.cme ? 'loaded' : 'unavailable'} | Polygon: ${hasPolygon ? Object.keys(result.polygon).join(', ') : 'unavailable'}`);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// matchFinancialContext
// Returns { probability, indicators } or null.
// ─────────────────────────────────────────────────────────────────────────────
function matchFinancialContext(marketTitle, financialData) {
  if (!financialData) return null;
  const title = marketTitle.toLowerCase();
  const matched = [];

  // ── Fed / FOMC keywords → CME FedWatch ───────────────────────────────────
  if (/\b(fed|federal reserve|fomc|rate cut|rate hike|interest rate)\b/.test(title)) {
    const cme = financialData.cme;
    if (cme) {
      // Determine which probability to use based on question direction
      let prob = cme.holdProb;
      if (/cut|lower|reduce|ease/.test(title))  prob = cme.cutProb;
      if (/hike|raise|increase|tighten/.test(title)) prob = cme.hikeProb;

      matched.push({
        indicator: `CME FedWatch — next meeting ${cme.nextMeeting}`,
        value: `cut ${Math.round(cme.cutProb * 100)}% / hold ${Math.round(cme.holdProb * 100)}% / hike ${Math.round(cme.hikeProb * 100)}%`,
        trend: 'unknown',
        source: 'CMEFedWatch',
        probability: prob,
      });
    }
  }

  // ── Equity / index keywords → Polygon ─────────────────────────────────────
  const equityPatterns = [
    { pattern: /\bs&p\b|s&p 500|spy\b/,        ticker: 'SPY'  },
    { pattern: /\bnasdaq\b|qqq\b/,              ticker: 'QQQ'  },
    { pattern: /\bgold\b|\bgld\b/,              ticker: 'GLD'  },
    { pattern: /\boil\b|crude|wti\b|\buso\b/,   ticker: 'USO'  },
    { pattern: /\bvix\b|volatility index/,       ticker: 'VIX'  },
  ];

  for (const { pattern, ticker } of equityPatterns) {
    if (!pattern.test(title)) continue;
    const asset = financialData.polygon?.[ticker];
    if (!asset) continue;

    // Try to extract a price threshold from the title ("above 5500", "over $500")
    const threshold = extractPriceThreshold(title);
    let probability = null;
    if (threshold !== null) {
      // Simple: if current price is above threshold, YES is likely; else NO is likely
      if (/above|exceed|over|hit|reach|break/.test(title)) {
        probability = asset.close >= threshold ? 0.75 : 0.28;
      } else if (/below|under|drop|fall/.test(title)) {
        probability = asset.close <= threshold ? 0.75 : 0.28;
      }
    }

    matched.push({
      indicator: `${ticker} Price`,
      value: `$${asset.close.toLocaleString()}`,
      trend: asset.trend,
      source: 'Polygon',
      probability,
    });
  }

  if (matched.length === 0) return null;

  // Average non-null probabilities
  const withProb = matched.filter(m => m.probability !== null);
  const avgProb  = withProb.length > 0
    ? withProb.reduce((s, m) => s + m.probability, 0) / withProb.length
    : null;

  return { probability: avgProb, indicators: matched };
}

// Extract a price threshold like "5500", "$523", "100k"
function extractPriceThreshold(text) {
  // Match "$5,500" or "5500" or "5.5k"
  const m = text.match(/\$?([\d,]+(?:\.\d+)?)\s*k?\b/);
  if (!m) return null;
  const base = parseFloat(m[1].replace(/,/g, ''));
  return /\d\s*k\b/i.test(text) ? base * 1000 : base;
}

module.exports = { fetchFinancialData, matchFinancialContext };
```

- [ ] **Step 4: Run tests — all should pass**

```bash
node agent/test-signals.js
```

Expected:
```
[Test] odds.js — ... ✓ no-key graceful degradation
  ✓ match found: prob=0.573, books=2
  ✓ no-match returns null

[Test] financial.js — ...
  ✓ no Polygon key returns object without throwing
  ✓ Fed match: prob=0.340
  ✓ S&P match: prob=0.280
  ✓ non-financial market returns null

✅ All signal tests passed
```

- [ ] **Step 5: Commit**

```bash
git add agent/financial.js agent/test-signals.js
git commit -m "feat: add agent/financial.js — Signal 7 CME FedWatch + Polygon.io"
```

---

## Task 3: Create `agent/polling.js` — Signal 8 (Polling + Legislative)

**Files:**
- Create: `agent/polling.js`
- Modify: `agent/test-signals.js` (append polling tests)

- [ ] **Step 1: Append polling tests to `agent/test-signals.js`**

Add after `testFinancial` function definition, before the `Promise.resolve()` chain:

```js
async function testPolling() {
  const { fetchPollingData, matchPollingContext } = require('./polling');

  console.log('\n[Test] polling.js — fetchPollingData() with no Congress key → partial');
  const saved = process.env.CONGRESS_API_KEY;
  delete process.env.CONGRESS_API_KEY;
  const result = await fetchPollingData();
  assert(typeof result === 'object', 'Should return object even without Congress key');
  process.env.CONGRESS_API_KEY = saved;
  console.log('  ✓ no Congress key returns object without throwing');

  console.log('[Test] matchPollingContext() — approval keywords match polling data');
  const fakePoll = {
    approval: { president: { approve: 44.2, disapprove: 52.1, trend: 'falling' } },
    bills: [
      { title: 'Infrastructure Investment Act', number: 'HR 1234', status: 'committee', statusScore: 0.15 },
      { title: 'Clean Energy Tax Credit Act', number: 'S 567', status: 'passed_house', statusScore: 0.60 },
    ],
  };

  const approvalMatch = matchPollingContext('Will Biden approval rating exceed 50%?', fakePoll);
  assert(approvalMatch !== null, 'Approval keywords should match polling data');
  assert(typeof approvalMatch.probability === 'number');
  assert(approvalMatch.probability < 0.5, 'Approval at 44% should give low prob for >50% question');
  console.log(`  ✓ approval match: prob=${approvalMatch.probability.toFixed(3)}`);

  const billMatch = matchPollingContext('Will the Infrastructure Investment Act pass Congress?', fakePoll);
  assert(billMatch !== null, 'Bill title keywords should match bill data');
  assert(Math.abs(billMatch.probability - 0.15) < 0.01, 'Should use statusScore for committee bill');
  console.log(`  ✓ bill match: prob=${billMatch.probability.toFixed(3)}`);

  const noMatch = matchPollingContext('Will Bitcoin exceed $100,000?', fakePoll);
  assert(noMatch === null, 'Crypto market should not match polling context');
  console.log('  ✓ non-political market returns null');
}
```

Update the invocation chain:

```js
Promise.resolve()
  .then(testOdds)
  .then(testFinancial)
  .then(testPolling)
  .then(() => console.log('\n✅ All signal tests passed'))
  .catch(err => { console.error('\n❌ Test FAILED:', err.message); process.exit(1); });
```

- [ ] **Step 2: Run tests — polling tests fail**

```bash
node agent/test-signals.js
```

Expected: `Error: Cannot find module './polling'`

- [ ] **Step 3: Create `agent/polling.js`**

```js
/**
 * agent/polling.js — Signal 8: Polling averages + legislative signals
 *
 * fetchPollingData() → { approval: { president: {...} }, bills: [...] }
 * matchPollingContext(marketTitle, pollingData) → { probability, indicators } | null
 *
 * Sub-sources:
 *   • FiveThirtyEight/ABC News polling averages (no key, CSV endpoints)
 *   • Congress.gov REST API (CONGRESS_API_KEY — free at api.congress.gov)
 *
 * Bill passage probability proxies (based on historical passage rates):
 *   introduced=0.08, committee=0.15, floor_vote=0.45,
 *   passed_house=0.60, passed_senate=0.60, enrolled=0.85
 */

const axios = require('axios');
try { require('dotenv').config({ override: true }); } catch {}

const BILL_STATUS_SCORES = {
  introduced:    0.08,
  committee:     0.15,
  floor_vote:    0.45,
  passed_house:  0.60,
  passed_senate: 0.60,
  enrolled:      0.85,
  signed:        0.97,
  vetoed:        0.05,
};

// ─────────────────────────────────────────────────────────────────────────────
// fetchApprovalRatings
// Uses FiveThirtyEight's public approval data CSV (no key required).
// Returns { president: { approve, disapprove, trend } } or null on failure.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchApprovalRatings() {
  try {
    // FiveThirtyEight/ABC publishes presidential approval averages here:
    const { data } = await axios.get(
      'https://projects.fivethirtyeight.com/biden-approval-data/approval_topline.csv',
      { timeout: 8000, responseType: 'text' }
    );

    // CSV format: "subgroup,modeldate,approve_estimate,disapprove_estimate,..."
    const lines = data.split('\n').filter(l => l.trim());
    // Find the "All adults" or "Adults" row with the most recent date
    const rows = lines.slice(1).map(l => l.split(','));
    const allAdults = rows
      .filter(r => /all adults/i.test(r[0]))
      .sort((a, b) => new Date(b[1]) - new Date(a[1]));

    if (allAdults.length === 0) return null;

    const latest = allAdults[0];
    const prev   = allAdults[1] || null;
    const approve    = parseFloat(latest[2]);
    const disapprove = parseFloat(latest[3]);
    const prevApprove = prev ? parseFloat(prev[2]) : null;
    const trend = prevApprove !== null
      ? approve > prevApprove ? 'rising' : approve < prevApprove ? 'falling' : 'stable'
      : 'unknown';

    return { president: { approve, disapprove, trend, date: latest[1] } };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchBills
// Fetches recent bills from Congress.gov. Returns array of bill objects.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchBills() {
  const apiKey = process.env.CONGRESS_API_KEY;
  if (!apiKey) return [];

  try {
    const { data } = await axios.get('https://api.congress.gov/v3/bill', {
      params: {
        api_key: apiKey,
        limit: 50,
        sort: 'updateDate+desc',
        format: 'json',
      },
      timeout: 8000,
    });

    return (data?.bills || []).map(bill => {
      const status = normaliseBillStatus(bill.latestAction?.text || '');
      return {
        title:       bill.title || '',
        number:      `${bill.type || ''} ${bill.number || ''}`.trim(),
        congress:    bill.congress,
        status,
        statusScore: BILL_STATUS_SCORES[status] ?? 0.08,
        latestAction: bill.latestAction?.text || '',
        sponsors:     bill.sponsors?.length || 0,
      };
    });
  } catch {
    return [];
  }
}

// Map a raw latestAction text to a normalised status key
function normaliseBillStatus(text) {
  const t = text.toLowerCase();
  if (/signed into law|became law/.test(t)) return 'signed';
  if (/vetoed/.test(t))                     return 'vetoed';
  if (/enrolled/.test(t))                   return 'enrolled';
  if (/passed house and senate|passed both/.test(t)) return 'enrolled';
  if (/passed the senate/.test(t))          return 'passed_senate';
  if (/passed the house/.test(t))           return 'passed_house';
  if (/placed on.*calendar|ordered to be reported|reported by committee/.test(t)) return 'floor_vote';
  if (/referred to.*committee|committee/.test(t)) return 'committee';
  return 'introduced';
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchPollingData
// ─────────────────────────────────────────────────────────────────────────────
async function fetchPollingData() {
  console.log('[Polling] Fetching 538 approval + Congress.gov bills…');

  const [approvalResult, billsResult] = await Promise.allSettled([
    fetchApprovalRatings(),
    fetchBills(),
  ]);

  const result = {
    approval: approvalResult.status === 'fulfilled' ? approvalResult.value : null,
    bills:    billsResult.status    === 'fulfilled' ? billsResult.value    : [],
  };

  console.log(`[Polling] Approval: ${result.approval ? `${result.approval.president?.approve?.toFixed(1)}% approve` : 'unavailable'} | Bills: ${result.bills.length} loaded`);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// matchPollingContext
// Returns { probability, indicators } or null.
// ─────────────────────────────────────────────────────────────────────────────
function matchPollingContext(marketTitle, pollingData) {
  if (!pollingData) return null;
  const title = marketTitle.toLowerCase();
  const matched = [];

  // ── Presidential approval ─────────────────────────────────────────────────
  if (/\b(approval|approve|disapprove|favorability|job rating)\b/.test(title) &&
      /\b(president|biden|trump|harris|administration)\b/.test(title)) {
    const pa = pollingData.approval?.president;
    if (pa) {
      const threshold = extractPctThreshold(title);
      let probability = null;

      if (threshold !== null) {
        if (/above|exceed|over|more than/.test(title)) {
          probability = pa.approve >= threshold ? 0.75 : 0.22;
        } else if (/below|under|less than/.test(title)) {
          probability = pa.approve <= threshold ? 0.75 : 0.22;
        }
      } else {
        // No threshold — just report the approval level as context (no direct probability)
        probability = null;
      }

      matched.push({
        indicator: 'Presidential Approval (538)',
        value: `${pa.approve?.toFixed(1)}% approve / ${pa.disapprove?.toFixed(1)}% disapprove`,
        trend: pa.trend,
        source: '538',
        probability,
      });
    }
  }

  // ── Bill passage ──────────────────────────────────────────────────────────
  if (/\b(bill|act|legislation|congress|senate|house|signed|pass|law)\b/.test(title)) {
    // Find the best-matching bill by keyword overlap with the title
    let bestBill = null;
    let bestScore = 0;

    for (const bill of (pollingData.bills || [])) {
      const billWords = bill.title.toLowerCase().split(/\s+/).filter(w => w.length >= 5);
      const matches   = billWords.filter(w => title.includes(w)).length;
      if (matches > bestScore) { bestScore = matches; bestBill = bill; }
    }

    if (bestBill && bestScore >= 2) {
      matched.push({
        indicator: `Bill status: ${bestBill.status} (${bestBill.number})`,
        value: bestBill.statusScore.toString(),
        trend: 'unknown',
        source: 'CongressGov',
        probability: bestBill.statusScore,
      });
    }
  }

  if (matched.length === 0) return null;

  const withProb = matched.filter(m => m.probability !== null);
  const avgProb  = withProb.length > 0
    ? withProb.reduce((s, m) => s + m.probability, 0) / withProb.length
    : null;

  return { probability: avgProb, indicators: matched };
}

function extractPctThreshold(text) {
  const m = text.match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? parseFloat(m[1]) : null;
}

module.exports = { fetchPollingData, matchPollingContext };
```

- [ ] **Step 4: Run all tests — all should pass**

```bash
node agent/test-signals.js
```

Expected final lines:
```
  ✓ approval match: prob=0.220
  ✓ bill match: prob=0.150
  ✓ non-political market returns null

✅ All signal tests passed
```

- [ ] **Step 5: Commit**

```bash
git add agent/polling.js agent/test-signals.js
git commit -m "feat: add agent/polling.js — Signal 8 polling averages + Congress.gov"
```

---

## Task 4: Update `.env` with new API key entries

**Files:**
- Modify: `.env`

- [ ] **Step 1: Add the three new keys to `.env`**

Open `.env` and append after the existing `AI_PRICE_DRIFT` line:

```ini

# ─── New accuracy signals ──────────────────────────────────────────────────────
# Signal 6 — Bookmaker Consensus (The Odds API)
# Free key at https://the-odds-api.com — 500 req/month on free tier
ODDS_API_KEY=

# Signal 7 — Financial Correlations (Polygon.io)
# Free key at https://polygon.io — 5 calls/min on free tier
POLYGON_API_KEY=

# Signal 8 — Polling / Legislative (Congress.gov)
# Free key at https://api.congress.gov — no rate limit stated
CONGRESS_API_KEY=
```

- [ ] **Step 2: Commit**

```bash
git add .env
git commit -m "chore: add ODDS_API_KEY, POLYGON_API_KEY, CONGRESS_API_KEY placeholders to .env"
```

---

## Task 5: Wire all three signals into `analyzer.js`

**Files:**
- Modify: `agent/analyzer.js` (lines 24-28 for requires; lines 90-113 for parallel fetch; line 117 for scorePrediction call; lines 265-313 for signal fusion; lines 176-181 for AI context)

This is the largest single change. Make all edits carefully — the existing signals must not regress.

- [ ] **Step 1: Add the three new requires at the top of `analyzer.js`**

Find this block (lines 24-28):

```js
const { fetchAllMarkets }        = require('./markets');
const { collectAllNews }         = require('./collector');
const { analyzeMarketSentiment } = require('./sentiment');
const { fetchEconomicData, matchEconomicContext } = require('./fred');
const { analyzeMarketWithAI, generateBriefing }   = require('./ai-engine');
```

Replace with:

```js
const { fetchAllMarkets }        = require('./markets');
const { collectAllNews }         = require('./collector');
const { analyzeMarketSentiment } = require('./sentiment');
const { fetchEconomicData, matchEconomicContext } = require('./fred');
const { analyzeMarketWithAI, generateBriefing }   = require('./ai-engine');
const { fetchOddsData,      matchOddsContext }     = require('./odds');
const { fetchFinancialData, matchFinancialContext } = require('./financial');
const { fetchPollingData,   matchPollingContext }   = require('./polling');
```

- [ ] **Step 2: Add the three new parallel fetches in `runFullAnalysis`**

Find this block (around lines 94-104):

```js
  // Track which parallel fetches have completed
  let marketsReady = false, newsReady = false, econReady = false;
  const checkParallel = () => {
    const done = [marketsReady, newsReady, econReady].filter(Boolean).length;
    onProgress(8 + done * 14, `Fetching data… (${done}/3 sources ready)`);
  };

  const [marketsResult, newsResult, economicData] = await Promise.all([
    fetchAllMarkets().then(r  => { marketsReady = true; checkParallel(); return r;  }),
    collectAllNews().then(r   => { newsReady    = true; checkParallel(); return r;  }),
    fetchEconomicData().then(r => { econReady   = true; checkParallel(); return r;  }),
  ]);
```

Replace with:

```js
  // Track which parallel fetches have completed
  let marketsReady = false, newsReady = false, econReady = false;
  const checkParallel = () => {
    const done = [marketsReady, newsReady, econReady].filter(Boolean).length;
    onProgress(8 + done * 8, `Fetching data… (${done}/3 core sources ready)`);
  };

  // Core sources (blocking — needed before scoring)
  const [marketsResult, newsResult, economicData] = await Promise.all([
    fetchAllMarkets().then(r  => { marketsReady = true; checkParallel(); return r;  }),
    collectAllNews().then(r   => { newsReady    = true; checkParallel(); return r;  }),
    fetchEconomicData().then(r => { econReady   = true; checkParallel(); return r;  }),
  ]);

  // Supplemental accuracy sources (parallel, graceful-degraded)
  onProgress(34, 'Fetching accuracy signals (bookmaker / financial / polling)…');
  const [oddsResult, financialResult, pollingResult] = await Promise.allSettled([
    fetchOddsData(),
    fetchFinancialData(),
    fetchPollingData(),
  ]);
  const oddsData     = oddsResult.status     === 'fulfilled' ? oddsResult.value     : {};
  const financialData = financialResult.status === 'fulfilled' ? financialResult.value : {};
  const pollingData  = pollingResult.status   === 'fulfilled' ? pollingResult.value   : {};
```

- [ ] **Step 3: Pass new data to `scorePrediction`**

Find this line (around line 117):

```js
    const scored = scorePrediction(allMarkets[i], allArticles, economicData);
```

Replace with:

```js
    const scored = scorePrediction(allMarkets[i], allArticles, economicData, oddsData, financialData, pollingData);
```

- [ ] **Step 4: Update the `scorePrediction` function signature and add signals 6/7/8**

Find the function declaration (around line 265):

```js
function scorePrediction(market, articles, economicData) {
```

Replace with:

```js
function scorePrediction(market, articles, economicData, oddsData = {}, financialData = {}, pollingData = {}) {
```

Then find the signal pool construction block (around lines 307-313):

```js
    // ── Probability fusion ─────────────────────────────────────────────────
    // Build weighted pool of all available signals (Claude added as Signal 5 post-hoc)
    const signalPool = [
      { prob: marketPrice,  weight: 0.28, label: 'Market price' },
      { prob: sentAdjusted, weight: 0.24, label: 'Sentiment-adjusted' },
    ];
    if (crossRefProb !== null) signalPool.push({ prob: crossRefProb, weight: 0.16, label: crossRefSource });
    if (econProb     !== null) signalPool.push({ prob: econProb,     weight: 0.12, label: 'Economic data' });
```

Replace with:

```js
    // ── Signals 6/7/8: Bookmaker, financial, polling ───────────────────────
    const oddsMatch    = matchOddsContext(market.title, oddsData);
    const finMatch     = matchFinancialContext(market.title, financialData);
    const pollMatch    = matchPollingContext(market.title, pollingData);

    // ── Probability fusion ─────────────────────────────────────────────────
    // Build weighted pool of all available signals (Claude added as Signal 5 post-hoc)
    const signalPool = [
      { prob: marketPrice,  weight: 0.28, label: 'Market price' },
      { prob: sentAdjusted, weight: 0.24, label: 'Sentiment-adjusted' },
    ];
    if (crossRefProb !== null)             signalPool.push({ prob: crossRefProb,          weight: 0.16, label: crossRefSource });
    if (econProb     !== null)             signalPool.push({ prob: econProb,              weight: 0.12, label: 'Economic data' });
    if (oddsMatch?.probability  != null)   signalPool.push({ prob: oddsMatch.probability, weight: 0.25, label: 'Bookmaker Consensus' });
    if (finMatch?.probability   != null)   signalPool.push({ prob: finMatch.probability,  weight: 0.20, label: 'Financial market' });
    if (pollMatch?.probability  != null)   signalPool.push({ prob: pollMatch.probability, weight: 0.20, label: 'Polling/legislative' });
```

- [ ] **Step 5: Store new signal context on the prediction object and enrich AI prompt**

Find the return block in `scorePrediction` — specifically where `economicContext` is set (around line 406):

```js
      crossRef: crossRefDetail,
      economicContext: econDetail,
```

Replace with:

```js
      crossRef: crossRefDetail,
      economicContext: econDetail,
      oddsContext:     oddsMatch?.indicators     || null,
      financialContext: finMatch?.indicators     || null,
      pollingContext:  pollMatch?.indicators     || null,
```

Then in the AI analysis section of `runFullAnalysis`, find the `analyzeMarketWithAI` call (around line 176):

```js
        const aiResult = await analyzeMarketWithAI(
          market,
          pred.topArticles || [],
          pred.economicContext || [],
          pred.signals || [],
        );
```

Replace with:

```js
        // Merge all external signal context so Claude sees the full picture
        const allContext = [
          ...(pred.economicContext  || []),
          ...(pred.oddsContext      || []),
          ...(pred.financialContext || []),
          ...(pred.pollingContext   || []),
        ];
        const aiResult = await analyzeMarketWithAI(
          market,
          pred.topArticles || [],
          allContext,
          pred.signals || [],
        );
```

- [ ] **Step 6: Run the server and verify no startup errors**

```bash
cd "/Users/henry/Documents/Claude/Projects/prediction market agent and dashboard"
node -e "require('./agent/analyzer'); console.log('✓ analyzer.js loads without errors')"
```

Expected: `✓ analyzer.js loads without errors`

- [ ] **Step 7: Commit**

```bash
git add agent/analyzer.js
git commit -m "feat: wire Signals 6/7/8 into analyzer.js — bookmaker, financial, polling"
```

---

## Task 6: End-to-end smoke test

**Files:** None modified — this is a verification step only.

- [ ] **Step 1: Run the unit test suite one final time**

```bash
node agent/test-signals.js
```

Expected: `✅ All signal tests passed`

- [ ] **Step 2: Start the server and trigger a manual analysis run**

```bash
node server.js &
sleep 3
curl -s http://localhost:3001/api/analyze -X POST | node -e "
const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
console.log('predictions:', d.predictions?.length);
console.log('top picks:', d.predictions?.filter(p=>p.isTopPick).length);
console.log('economic indicators:', d.economicIndicators);
const s6 = d.predictions?.find(p => p.signals?.some(s => s.label === 'Bookmaker Consensus'));
const s7 = d.predictions?.find(p => p.signals?.some(s => s.label === 'Financial market'));
const s8 = d.predictions?.find(p => p.signals?.some(s => s.label === 'Polling/legislative'));
console.log('Signal 6 fired:', s6 ? s6.title.slice(0,60) : 'no match (expected if no ODDS_API_KEY)');
console.log('Signal 7 fired:', s7 ? s7.title.slice(0,60) : 'no match (expected if no POLYGON_API_KEY)');
console.log('Signal 8 fired:', s8 ? s8.title.slice(0,60) : 'no match (expected if no CONGRESS_API_KEY)');
"
```

Expected (with empty API keys — keys not set yet):
```
predictions: <number>
top picks: <number>
economic indicators: <number>
Signal 6 fired: no match (expected if no ODDS_API_KEY)
Signal 7 fired: no match (expected if no POLYGON_API_KEY)
Signal 8 fired: no match (expected if no CONGRESS_API_KEY)
```

All existing signals continue to work. New signals activate once API keys are added to `.env`.

- [ ] **Step 3: Kill background server**

```bash
kill %1
```

- [ ] **Step 4: Final commit — bump analyzer version comment**

In `agent/analyzer.js`, update the header comment from `v3` to `v4` and update the signal table to include Signals 6/7/8:

```js
/**
 * analyzer.js — Multi-source prediction engine (v4)
 *
 * Probability fusion pipeline for each market:
 *
 *   Signal 1: Market price          (weight 0.28) — semi-efficient baseline
 *   Signal 2: Sentiment-adjusted    (weight 0.24) — news with credibility + recency
 *   Signal 3: Cross-ref forecast    (weight 0.16) — Metaculus / Manifold community
 *   Signal 4: Economic data         (weight 0.12) — FRED / World Bank / Coinbase
 *   Signal 5: Claude AI             (weight 0.20) — LLM analysis (qualifying markets only)
 *   Signal 6: Bookmaker consensus   (weight 0.25) — The Odds API (sports + political)
 *   Signal 7: Financial market      (weight 0.20) — CME FedWatch + Polygon.io
 *   Signal 8: Polling/legislative   (weight 0.20) — 538 polling + Congress.gov
 *
 * Signals 6-8 are optional — only included when a match is found and API key is present.
 * Weights renormalize automatically.
```

```bash
git add agent/analyzer.js
git commit -m "docs: bump analyzer to v4, document Signals 6/7/8 in header"
```

---

## Post-Implementation: Activate the new signals

After implementation, get API keys and add them to `.env`:

| Signal | Key Name | Where to get it |
|--------|----------|-----------------|
| 6 — Bookmaker | `ODDS_API_KEY` | https://the-odds-api.com (free: 500 req/month) |
| 7 — Financial | `POLYGON_API_KEY` | https://polygon.io (free: 5 calls/min) |
| 8 — Legislative | `CONGRESS_API_KEY` | https://api.congress.gov (free, no rate limit stated) |

Restart `node server.js` after adding keys. The next analysis run will automatically incorporate all three new signals for matching markets.
