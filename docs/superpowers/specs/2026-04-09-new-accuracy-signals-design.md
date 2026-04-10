# PredictIQ — New Accuracy Signals Design

**Date:** 2026-04-09  
**Status:** Approved  
**Scope:** Add three new probability signals (bookmaker consensus, financial market correlations, polling/legislative) to the prediction scoring pipeline

---

## 1. Background & Goal

PredictIQ's current probability fusion pipeline uses five signals: news sentiment, economic data match, platform price, volume/liquidity, and Claude AI analysis. The goal of this change is to add three new high-accuracy external signals that provide direct ground-truth data for specific market categories (sports/politics, macro/rates, elections/legislation), improving calibration beyond what news sentiment and AI reasoning alone can achieve.

---

## 2. Architecture Overview

Each new source is implemented as a standalone fetcher module (parallel to `fred.js`) and integrated into `analyzer.js` as a new signal in the probability fusion loop.

### Signal weights (applied only when a match is found for that market)

| # | Signal | Weight | Applies to |
|---|--------|--------|------------|
| 1 | News sentiment | 0.30 | All |
| 2 | Economic data match | 0.25 | Economic/crypto |
| 3 | Platform price | 0.30 | All |
| 4 | Volume/liquidity | 0.15 | All |
| 5 | Claude AI | 0.20 | Qualifying markets (EV ≥ 0.03, vol ≥ $100) |
| **6** | **Bookmaker consensus** | **0.25** | Sports & political event markets |
| **7** | **Financial correlations** | **0.20** | Fed/rates/macro/equity markets |
| **8** | **Polling/legislative** | **0.20** | Election, approval, bill passage markets |

Weights are normalised to sum to 1.0 across whichever signals fire for a given market. A market with no bookmaker, financial, or polling match is unaffected.

### New files

```
agent/
  odds.js        ← Signal 6 — The Odds API bookmaker consensus
  financial.js   ← Signal 7 — CME FedWatch + Polygon.io
  polling.js     ← Signal 8 — 538 polling + Congress.gov
  analyzer.js    ← modified: fetches all 3, merges signals
  ai-engine.js   ← modified: new signal context passed to Claude prompt
.env             ← adds ODDS_API_KEY, POLYGON_API_KEY, CONGRESS_API_KEY
```

No changes to `server.js`, `fred.js`, or any frontend files.

---

## 3. Signal 6 — Bookmaker Consensus (`odds.js`)

### Purpose
Derive a sharp-money implied probability from the consensus of 10–40 sportsbooks (DraftKings, FanDuel, Bet365, etc.) by averaging de-vigged (vig-removed) odds. Bookmaker consensus is among the best-calibrated signals for sports and many political event markets.

### API
- **Provider:** [The Odds API](https://the-odds-api.com/)
- **Key:** `ODDS_API_KEY` in `.env`
- **Free tier:** 500 requests/month (~8 calls/run × 24 runs/day = 192/day — within free tier)
- **Endpoints used:**
  - `GET /v4/sports` — list active sports
  - `GET /v4/sports/{sport}/odds?regions=us&markets=h2h` — head-to-head odds for a sport

### Matching logic (`matchOddsContext`)
- Fetch once per analyzer run, cache in memory for that run
- For each prediction market title, search fetched odds events for name overlap (team names, athlete names, event keywords)
- De-vig formula: `p_clean = (1/odds_decimal) / sum(1/odds_i)` across all outcomes, then average across books

### Output shape
```js
{
  probability: 0.67,       // de-vigged consensus YES probability
  indicators: [
    { indicator: 'Bookmaker Consensus', value: '67%', books: 14, source: 'OddsAPI' }
  ]
}
```

### Signal integration
```js
{ label: 'Bookmaker Consensus', prob: 0.67, weight: 0.25 }
```

---

## 4. Signal 7 — Financial Market Correlations (`financial.js`)

### Purpose
Provide direct price/probability data for markets correlated to financial instruments: Fed funds rate decisions (CME FedWatch) and equity/index/commodity levels (Polygon.io).

### Sub-source A: CME FedWatch
- **URL:** `https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html` (public JSON endpoint used by their UI)
- **Key:** None required
- **Data:** Probability distribution of Fed funds target rate at upcoming FOMC meetings
- **Matching keywords:** `fed`, `federal reserve`, `fomc`, `rate cut`, `rate hike`, `interest rate`

### Sub-source B: Polygon.io
- **URL:** `https://api.polygon.io/v2/aggs/ticker/{ticker}/prev`
- **Key:** `POLYGON_API_KEY` in `.env`
- **Free tier:** 5 calls/min, unlimited historical; sufficient for ~10 asset lookups/run
- **Assets tracked:** SPY (S&P 500), QQQ (Nasdaq), VIX, GLD (gold), USO (oil), plus individual tickers parsed from market titles
- **Matching keywords:** `s&p`, `nasdaq`, `dow`, `stock`, `vix`, `oil`, `gold`, plus ticker symbols (e.g. `TSLA`, `AAPL`)

### Output shape
```js
{
  probability: 0.34,
  indicators: [
    { indicator: 'CME FedWatch — Jun cut probability', value: '34%', source: 'CMEFedWatch' },
    { indicator: 'S&P 500 (SPY)', value: '$523.12', trend: 'rising', source: 'Polygon' }
  ]
}
```

### Signal integration
```js
{ label: 'CME FedWatch', prob: 0.34, weight: 0.20 }
// or
{ label: 'Polygon financial', prob: 0.61, weight: 0.20 }
```

---

## 5. Signal 8 — Polling & Legislative (`polling.js`)

### Purpose
Provide polling-derived probabilities for election/approval markets and bill-passage proxies for legislative markets.

### Sub-source A: FiveThirtyEight / ABC News polling averages
- **URL:** `https://projects.fivethirtyeight.com/polls/data/` CSV/JSON endpoints (stable public data)
- **Key:** None required
- **Data:** Presidential approval ratings, generic congressional ballot, race-level polling averages
- **Matching keywords:** candidate names, `approval`, `election`, `win`, `president`, `senate`, `house`
- **Probability conversion:** polling average → simple logistic transform (e.g. 55% poll avg → ~0.70 win prob accounting for historical polling error)

### Sub-source B: Congress.gov API
- **URL:** `https://api.congress.gov/v3/bill`
- **Key:** `CONGRESS_API_KEY` in `.env` (free at api.congress.gov)
- **Data:** Bill status, co-sponsor count, committee referral, latest action
- **Matching keywords:** `bill`, `act`, `legislation`, `congress`, `senate`, `signed`, `pass`
- **Probability proxy:** status-based scoring (introduced=0.08, committee=0.15, floor vote=0.45, passed one chamber=0.60, enrolled=0.85)

### Output shape
```js
{
  probability: 0.52,
  indicators: [
    { indicator: '538 Presidential Approval', value: '44.2%', trend: 'falling', source: '538' },
    { indicator: 'Bill status: In Committee', value: '0.15', source: 'CongressGov' }
  ]
}
```

### Signal integration
```js
{ label: '538 Polling', prob: 0.52, weight: 0.20 }
// or
{ label: 'Bill passage proxy', prob: 0.18, weight: 0.20 }
```

---

## 6. analyzer.js Changes

### Parallel data fetching (added alongside existing fred.js + news fetches)
```js
const [oddsData, financialData, pollingData] = await Promise.allSettled([
  fetchOddsData(),
  fetchFinancialData(),
  fetchPollingData(),
]);
```

### Per-market signal merging (inside scoreMarket / signal fusion loop)
```js
const oddsMatch    = matchOddsContext(market.title, oddsData);
const finMatch     = matchFinancialContext(market.title, financialData);
const pollMatch    = matchPollingContext(market.title, pollingData);

if (oddsMatch?.probability)  signals.push({ label: 'Bookmaker Consensus', prob: oddsMatch.probability,  weight: 0.25 });
if (finMatch?.probability)   signals.push({ label: 'Financial market',    prob: finMatch.probability,   weight: 0.20 });
if (pollMatch?.probability)  signals.push({ label: 'Polling/legislative', prob: pollMatch.probability,  weight: 0.20 });
```

### ai-engine.js prompt enrichment
The `analyzeMarketWithAI()` call already accepts `economicContext[]`. The new signal context arrays (bookmaker indicators, financial indicators, polling indicators) are merged into this array before the call, so Claude sees them as additional context lines in the prompt.

---

## 7. Error Handling

- All three fetchers use `Promise.allSettled` internally — individual failures return `{}` and are logged, never crashing the analyzer run
- Missing API keys: each fetcher checks for its key at startup and logs a warning, returning `{}` gracefully
- Rate limit hits: The Odds API and Polygon both return HTTP 429; caught and logged, returning partial results
- Stale data tolerance: financial and polling data changes slowly enough that a per-run in-memory cache (no TTL needed within a single run) is sufficient

---

## 8. Environment Variables Added

```ini
# Signal 6 — Bookmaker Consensus
ODDS_API_KEY=your_key_here

# Signal 7 — Financial Correlations  
POLYGON_API_KEY=your_key_here

# Signal 8 — Polling / Legislative
CONGRESS_API_KEY=your_key_here
```

All three are optional — signals are simply skipped if keys are missing.

---

## 9. Testing Criteria

- Each new fetcher returns a non-empty object on a live run
- `matchXxxContext()` correctly matches at least 3 known market titles in manual test
- Probability fusion still produces values in [0.02, 0.98] with new signals active
- Analyzer run time does not increase by more than 5 seconds (all fetches are parallel)
- No regression in existing signals or dedup logic
