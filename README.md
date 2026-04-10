# PredictIQ

An AI-powered prediction market agent and dashboard. Monitors Kalshi, Polymarket, and PredictIt in real time, scores every market using 8 independent signals, and surfaces the highest-EV opportunities with AI-generated reasoning, risk narratives, and a daily briefing.

---

## Disclaimer

For informational and research purposes only. Not financial advice. Prediction markets carry real financial risk — do your own research before placing any trades.

---
## Quick start

```bash
# Install dependencies
npm install

# Copy and fill in your keys
cp .env.example .env

# Dev mode (API on :3001, Vite on :5173 with hot reload)
npm run dev

# Production (build frontend first)
npm run build
npm start
```

Open **http://localhost:5173** in dev mode, or **http://localhost:3001** in production.

---

## Environment variables

### Required

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key — enables Signal 5 AI analysis and all AI features |
| `KALSHI_KEY_ID` | Kalshi API Key ID |
| `KALSHI_KEY_FILE` | Path to Kalshi RSA private key PEM file |

### Optional — improves signal coverage

| Variable | Description | Where to get it |
|---|---|---|
| `FRED_API_KEY` | FRED economic data (Signal 4) | fred.stlouisfed.org — free |
| `METACULUS_API_KEY` | Reference forecasts (now required by their API) | metaculus.com — free |
| `ODDS_API_KEY` | Bookmaker consensus (Signal 6) | the-odds-api.com — 500 req/month free |
| `POLYGON_API_KEY` | Stock/ETF prices (Signal 7) | polygon.io — 5 calls/min free |
| `CONGRESS_API_KEY` | Bill tracking (Signal 8) | api.congress.gov — free |

### AI spend controls

All AI features degrade gracefully when `ANTHROPIC_API_KEY` is absent.

| Variable | Default | Description |
|---|---|---|
| `AI_MAX_MARKETS` | `50` | Cap on full Signal 5 analysis per run |
| `AI_EV_THRESHOLD` | `0.03` | Min EV to qualify for Signal 5 |
| `AI_MIN_VOLUME` | `100` | Min volume to qualify for Signal 5 |
| `AI_LITE_MAX_MARKETS` | `50` | Cap on Signal 5 Lite per run |
| `AI_LITE_EV_THRESHOLD` | `0.01` | Min EV for Signal 5 Lite |
| `AI_LITE_MIN_VOLUME` | `50` | Min volume for Signal 5 Lite |
| `AI_SENTIMENT_MIN_VOLUME` | `2000` | Min volume for AI sentiment batch |
| `AI_SENTIMENT_MAX_MARKETS` | `200` | Cap on AI sentiment batch per run |
| `AI_CACHE_HOURS` | `6` | Hours before re-analysing a market |
| `AI_PRICE_DRIFT` | `0.03` | Price move (in cents) that invalidates the cache |
| `AI_DELTA_THRESHOLD` | `0.05` | Probability shift that triggers a delta note |
| `AI_RISK_NARRATIVE_THRESHOLD` | `0.60` | Risk score threshold for narrative generation |

### Model selection

Each AI feature uses its own model, all configurable via env var:

| Variable | Default | Used for |
|---|---|---|
| `AI_ANALYSIS_MODEL` | `claude-sonnet-4-5` | Signal 5 full analysis |
| `AI_BRIEFING_MODEL` | `claude-sonnet-4-5` | Daily briefing |
| `AI_CLUSTER_MODEL` | `claude-sonnet-4-6` | Cluster analysis |
| `AI_CHAT_MODEL` | `claude-haiku-4-5` | Real-time chat |
| `AI_SENTIMENT_MODEL` | `claude-haiku-4-5-20251001` | Sentiment batch |
| `AI_LITE_MODEL` | `claude-haiku-4-5-20251001` | Signal 5 Lite |
| `AI_RISK_NARRATIVE_MODEL` | `claude-haiku-4-5-20251001` | Risk narratives |
| `AI_DELTA_MODEL` | `claude-haiku-4-5-20251001` | Delta briefing |

---

## Signal pipeline

Each market is scored by combining up to 8 independent signals. Weights renormalize automatically when optional signals are absent.

| # | Signal | Weight | Source |
|---|---|---|---|
| 1 | Market price | 0.28 | Platform implied probability (semi-efficient baseline) |
| 2 | Sentiment | 0.24 | News credibility + recency decay; AI upgrade for high-volume markets |
| 3 | Cross-reference | 0.16 | Metaculus / Manifold community forecasts (Jaccard match) |
| 4 | Economic data | 0.12 | FRED, World Bank, Coinbase, US Treasury |
| 5 | Claude AI | 0.20 | Full LLM analysis for high-EV markets |
| 6 | Bookmaker consensus | 0.25 | De-vigged odds across bookmakers (optional) |
| 7 | Financial markets | 0.20 | CME FedWatch cut/hold/hike probabilities, Polygon ETFs (optional) |
| 8 | Polling / legislative | 0.20 | Presidential approval, Congress.gov bill status (optional) |

### Top pick criteria

A market is tagged as a top pick when all four conditions are true:

- `finalScore ≥ 0.45`
- `bestEV ≥ 0.05` (+5¢ per $1 wagered)
- `riskScore ≤ 0.65`
- `confidence ≥ 0.30`

---

## AI features

**Signal 5 — Full analysis (Sonnet)**
Chain-of-thought reasoning for high-EV markets. Returns estimated probability, confidence, key factors, and risk flags (thin data, contradicting signals, near expiry).

**Signal 5 Lite (Haiku)**
Same output shape as Signal 5 but a shorter prompt for sub-threshold markets (EV 0.01–0.03, vol 50–100). 15s per-call timeout prevents pipeline stalls.

**AI Sentiment Batch (Haiku)**
Replaces keyword Signal 2 for the highest-volume markets. Runs 5 batches of 10 in parallel. Returns sentiment score (−1 to +1), label, and confidence.

**Risk Narratives (Haiku)**
Plain-English risk explanation (≤120 chars) for every market with `riskScore ≥ 0.60`. Batched 30 at a time.

**Cluster Analysis (Sonnet)**
Groups the top 50 predictions into 3–6 thematic clusters and flags potential contradictions where related markets have divergent estimates.

**Daily Briefing (Sonnet)**
2–3 sentence macro summary plus 5 highlighted opportunities, regenerated each run.

**Delta Briefing (Haiku)**
When a top pick's estimate shifts more than 5% since the previous run, generates a ≤160-character explanation of the move.

**AI Chat**
Real-time Q&A about top picks, market context, and latest news via `/api/chat`.

---

## API reference

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/predictions` | All scored predictions, ranked by finalScore |
| GET | `/api/news` | Top 120 articles sorted by recency + relevance |
| GET | `/api/status` | Run status, progress, next scheduled run |
| GET | `/api/briefing` | AI daily briefing text and highlights |
| GET | `/api/clusters` | Cluster analysis of top 50 predictions |
| GET | `/api/history` | Historical run records (up to 30 days) |
| GET | `/api/progress` | SSE stream — live progress % during analysis |
| GET | `/api/price-history/:id` | On-demand price history for a market |
| POST | `/api/chat` | `{ question }` → `{ answer }` |
| POST | `/api/refresh` | Trigger immediate re-analysis |

---

## Project structure

```
├── server.js              # Entry point: cron + Express server
├── collect.js             # Standalone script for offline data collection
│
├── agent/
│   ├── analyzer.js        # Main pipeline: scores markets, dedup, top picks
│   ├── markets.js         # Fetches Kalshi, Polymarket, PredictIt, Metaculus, Manifold
│   ├── collector.js       # News: 28 RSS feeds + 12 subreddits + Hacker News
│   ├── sentiment.js       # Signal 2: keyword credibility + recency decay
│   ├── fred.js            # Signal 4: FRED / World Bank / Coinbase / Treasury
│   ├── odds.js            # Signal 6: bookmaker consensus (The Odds API)
│   ├── financial.js       # Signal 7: CME FedWatch + Polygon.io
│   ├── polling.js         # Signal 8: approval ratings + Congress.gov
│   └── ai-engine.js       # All Claude API calls
│
├── server/
│   ├── routes.js          # Express route handlers
│   ├── cache.js           # In-memory cache + disk persistence + SSE broadcast
│   └── agent-runner.js    # Orchestrates the full pipeline, emits progress events
│
├── src/                   # React frontend (Vite)
│   ├── App.jsx
│   └── components/
│       ├── TopPicks.jsx
│       ├── AllPredictions.jsx
│       ├── PredictionCard.jsx
│       ├── PredictionDetail.jsx
│       ├── NewsStream.jsx
│       ├── Briefing.jsx
│       └── AIChat.jsx
│
├── scripts/
│   ├── test-kalshi-auth.js   # Validate Kalshi RSA key setup
│   └── test-signals.js       # Manual integration tests for Signals 6–8
│
└── tests/
    └── ai-engine.test.js     # Jest unit tests for AI engine functions
```

---

## Scripts

```bash
npm run dev       # Development: API + Vite with hot reload
npm run build     # Build frontend to dist/
npm start         # Production server only
npm run collect   # One-shot analysis without starting the server
npm test          # Jest unit tests

node scripts/test-kalshi-auth.js   # Validate Kalshi key setup
node scripts/test-signals.js       # Test Signals 6–8 matching logic
```
