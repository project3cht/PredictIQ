/**
 * markets.js — Fetches open markets from 5 platforms:
 *   Kalshi, Polymarket, PredictIt  (tradeable — real money)
 *   Metaculus, Manifold            (reference probability sources)
 *
 * Metaculus and Manifold are not tradeable here, but their community
 * probability estimates act as independent signals the analyzer fuses
 * alongside news sentiment and economic data.
 */
const axios = require('axios');

// ─────────────────────────────────────────────────────────────────────────────
// PredictIt
// ─────────────────────────────────────────────────────────────────────────────
async function fetchPredictIt() {
  try {
    const { data } = await axios.get('https://www.predictit.org/api/marketdata/all/', {
      timeout: 10000,
      headers: { 'User-Agent': 'PredictIQ-Dashboard/1.0' },
    });

    const markets = [];
    for (const market of (data.markets || [])) {
      if (market.status !== 'Open') continue;
      for (const contract of (market.contracts || [])) {
        if (contract.status !== 'Open') continue;
        const bestYes = contract.bestBuyYesCost || 0;
        const bestNo  = contract.bestBuyNoCost  || 0;
        if (bestYes <= 0 || bestYes >= 1) continue;

        markets.push({
          id: `predictit_${market.id}_${contract.id}`,
          platform: 'PredictIt',
          title: contract.name !== market.name ? `${market.name} — ${contract.name}` : market.name,
          url: market.url,
          bestYes,
          bestNo,
          volume: contract.tradeVolume || 0,
          closes: market.end || null,
          category: categorize(market.name),
        });
      }
    }
    console.log(`[Markets] PredictIt: ${markets.length} contracts loaded`);
    return markets;
  } catch (err) {
    console.error('[Markets] PredictIt error:', err.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Polymarket
// ─────────────────────────────────────────────────────────────────────────────
async function fetchPolymarket() {
  try {
    const { data } = await axios.get(
      'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&order=volume&ascending=false',
      { timeout: 10000, headers: { 'User-Agent': 'PredictIQ-Dashboard/1.0' } }
    );

    const markets = [];
    for (const market of (Array.isArray(data) ? data : [])) {
      const outcomePrices = parseOutcomePrices(market.outcomePrices);
      if (!outcomePrices || outcomePrices.length < 2) continue;
      const bestYes = outcomePrices[0];
      const bestNo  = outcomePrices[1];
      if (bestYes <= 0 || bestYes >= 1) continue;

      markets.push({
        id: `polymarket_${market.id}`,
        platform: 'Polymarket',
        title: market.question,
        url: market.slug ? `https://polymarket.com/event/${market.slug}` : 'https://polymarket.com',
        bestYes,
        bestNo,
        volume: parseFloat(market.volumeNum || market.volume || 0),
        closes: market.endDate || null,
        category: categorize(market.question),
        conditionId: market.conditionId || null,   // needed for price history API
      });
    }
    console.log(`[Markets] Polymarket: ${markets.length} markets loaded`);
    return markets;
  } catch (err) {
    console.error('[Markets] Polymarket error:', err.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Kalshi — requires authentication (Kalshi locked down their API in 2024).
//
// Set ONE of the following in your .env file:
//   Option A — API key (recommended, free at https://kalshi.com/api-access):
//     KALSHI_API_KEY=your_key_here
//
//   Option B — Account credentials (auto-login on each run):
//     KALSHI_EMAIL=you@example.com
//     KALSHI_PASSWORD=yourpassword
//
// Without credentials Kalshi returns 403 for all market endpoints.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Build signed headers for Kalshi's API Key + Private Key auth.
 * Kalshi uses RSA-PSS (SHA-256) signing:
 *   message  = timestampMs + HTTP_METHOD + /path/without/query
 *   signature = base64( RSA-PSS-SHA256( privateKey, message ) )
 */
function buildKalshiHeaders(method, urlPath) {
  try { require('dotenv').config({ override: true }); } catch {}
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

async function fetchKalshi() {
  // Guard: no credentials
  if (!process.env.KALSHI_KEY_ID || !process.env.KALSHI_KEY_FILE) {
    console.warn(
      '[Markets] Kalshi: no credentials configured.\n' +
      '  Set KALSHI_KEY_ID and KALSHI_KEY_FILE in .env'
    );
    return [];
  }

  // ── Primary: events endpoint with nested markets ───────────────────────────
  //
  // The /markets endpoint is overwhelmed with auto-generated KXMVE parlay combo
  // markets (Multi-Variant Events) that have no single-outcome probability.
  // The /events endpoint returns real single-outcome events and includes full
  // market price data when ?with_nested_markets=true is passed.
  //
  // Price format (2025 API): yes_ask_dollars / no_ask_dollars are dollar strings
  // ("0.4200" = 42¢ = 0.42 probability).  The old integer yes_ask (cents) field
  // is no longer returned.
  try {
    const allMarkets = [];
    let cursor = null;
    let page   = 0;

    do {
      const urlPath = '/trade-api/v2/events';
      const params  = new URLSearchParams({ status: 'open', limit: '200', with_nested_markets: 'true' });
      if (cursor) params.set('cursor', cursor);

      const freshSigned = buildKalshiHeaders('GET', urlPath);
      if (!freshSigned) break;

      const { data } = await axios.get(
        `https://api.elections.kalshi.com${urlPath}?${params}`,
        { timeout: 15000, headers: { 'Accept': 'application/json', ...freshSigned } }
      );

      for (const event of (data.events || [])) {
        // Skip KXMVE multi-variant parlay events — they're not single-outcome markets
        if (event.event_ticker?.startsWith('KXMVE')) continue;

        for (const market of (event.markets || [])) {
          const bestYes = market.yes_ask_dollars != null ? parseFloat(market.yes_ask_dollars)
            : market.yes_ask   != null ? market.yes_ask / 100
            : null;
          const bestNo = market.no_ask_dollars != null ? parseFloat(market.no_ask_dollars)
            : market.no_ask   != null ? market.no_ask / 100
            : bestYes         != null ? Math.max(0.01, 1 - bestYes - 0.02)
            : null;

          if (!bestYes || !bestNo || bestYes <= 0.01 || bestYes >= 0.99) continue;

          const volume = parseFloat(market.volume_fp || market.open_interest_fp || 0) || 0;

          allMarkets.push({
            id:          `kalshi_${market.ticker}`,
            platform:    'Kalshi',
            title:       market.title || event.title || market.ticker,
            url:         `https://kalshi.com/markets/${market.ticker}`,
            bestYes,
            bestNo,
            volume,
            closes:      market.close_time || event.close_time || null,
            category:    categorize(event.title || market.title || ''),
            eventTicker: event.event_ticker || null, // used for dedup: one top pick per event
          });
        }
      }

      cursor = data.cursor || null;
      page++;
    } while (cursor && page < 5); // up to 1 000 events → ~5 000 markets

    if (allMarkets.length > 0) {
      console.log(`[Markets] Kalshi: ${allMarkets.length} markets from ${page} event pages`);
      return allMarkets;
    }
  } catch (err) {
    const status = err.response?.status;
    const body   = err.response?.data;
    if (status === 401 || status === 403) {
      console.error(`[Markets] Kalshi auth failed (${status}): ${JSON.stringify(body)}`);
    } else {
      console.warn('[Markets] Kalshi events endpoint failed:', err.message);
    }
  }

  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Metaculus — crowdsourced forecasting, community probability as reference
//
// API change (2025): Metaculus moved to a posts-based v3 API. Community
// predictions are in q.aggregations.recency_weighted.latest.centers[0].
// Questions where the community prediction is hidden (cp_reveal_time in future
// or user hasn't forecasted) will have aggregations = null — skip those.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchMetaculus() {
  try {
    const headers = {
      'User-Agent': 'PredictIQ-Dashboard/1.0',
      'Accept':     'application/json',
    };
    if (process.env.METACULUS_API_KEY) {
      headers['Authorization'] = `Token ${process.env.METACULUS_API_KEY}`;
    }

    // Use the v3 /api/posts/ endpoint sorted by forecaster count for quality
    const { data } = await axios.get(
      'https://www.metaculus.com/api/posts/?status=open&forecast_type=binary&limit=200&order_by=-forecasters_count',
      { timeout: 12000, headers }
    );

    const questions = (data.results || []).reduce((acc, post) => {
      const q    = post.question;
      if (!q) return acc;

      // Try v3 aggregation path first, then v2 legacy path
      const prob =
        q.aggregations?.recency_weighted?.latest?.centers?.[0] ??
        post.community_prediction?.full?.q2 ??
        null;

      if (prob == null || prob <= 0 || prob >= 1) return acc;

      acc.push({
        id:          `metaculus_${post.id}`,
        title:       post.title || q.title || '',
        probability: prob,
        url:         `https://www.metaculus.com/questions/${post.id}`,
        closes:      q.scheduled_close_time || q.actual_close_time || null,
        forecasters: post.nr_forecasters || 0,
        source:      'Metaculus',
      });
      return acc;
    }, []);

    console.log(`[Markets] Metaculus: ${questions.length} reference forecasts loaded`);
    return questions;
  } catch (err) {
    console.error('[Markets] Metaculus error:', err.response?.status || err.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Manifold Markets — play-money but well-calibrated community forecasts
//
// API change (2024): `filter=open` param was removed. Use `limit` only.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchManifold() {
  try {
    const { data } = await axios.get(
      'https://manifold.markets/api/v0/markets?limit=200',
      { timeout: 12000, headers: { 'User-Agent': 'PredictIQ-Dashboard/1.0' } }
    );

    const markets = (Array.isArray(data) ? data : [])
      .filter(m => m.probability != null && m.outcomeType === 'BINARY' && !m.isResolved)
      .map(m => ({
        id:          `manifold_${m.id}`,
        title:       m.question || '',
        probability: m.probability,
        url:         m.url || 'https://manifold.markets',
        closes:      m.closeTime ? new Date(m.closeTime).toISOString() : null,
        liquidity:   m.totalLiquidity || 0,
        source:      'Manifold',
      }));

    console.log(`[Markets] Manifold: ${markets.length} reference forecasts loaded`);
    return markets;
  } catch (err) {
    console.error('[Markets] Manifold error:', err.response?.status || err.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-reference: find the best matching Metaculus/Manifold question
// for a given tradeable market using Jaccard keyword similarity
// ─────────────────────────────────────────────────────────────────────────────
const STOP_WORDS = new Set([
  // Articles / prepositions / conjunctions
  'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'by',
  'with', 'this', 'that', 'it', 'its', 'into', 'from', 'between', 'about',
  // Auxiliaries
  'be', 'is', 'are', 'was', 'were', 'have', 'has', 'had', 'do', 'does', 'did',
  'not', 'no',
  // Very generic prediction-market question words — appear in nearly every title
  // and add no discriminative value for cross-reference matching
  'will', 'who', 'what', 'when', 'which', 'how', 'why',
  'win', 'wins', 'won', 'winning', 'winner',
  'yes', 'get', 'make', 'take', 'give',
  'over', 'under', 'than', 'more', 'less', 'before', 'after',
]);

function titleToKeywords(title) {
  return new Set(
    title.toLowerCase()
      .split(/\W+/)
      .filter(w => w.length >= 3 && !STOP_WORDS.has(w))
  );
}

function jaccardSimilarity(setA, setB) {
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union        = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

function findBestCrossRef(market, referenceList, threshold = 0.28) {
  const marketKw = titleToKeywords(market.title);
  let best = null, bestScore = 0;

  for (const ref of referenceList) {
    const refKw = titleToKeywords(ref.title);
    const score = jaccardSimilarity(marketKw, refKw);
    if (score > bestScore && score >= threshold) {
      bestScore = score;
      best = { ...ref, matchScore: +score.toFixed(3) };
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// Category helper
// ─────────────────────────────────────────────────────────────────────────────
const CATEGORY_PATTERNS = [
  { pattern: /election|president|senate|congress|vote|democrat|republican|trump|biden|harris/i, category: 'Politics' },
  { pattern: /bitcoin|crypto|ethereum|btc|eth|blockchain|defi|solana/i, category: 'Crypto' },
  { pattern: /inflation|cpi|fed|federal reserve|interest rate|gdp|recession|economy/i, category: 'Economics' },
  { pattern: /ukraine|russia|nato|war|ceasefire|military|troops|china|taiwan/i, category: 'Geopolitics' },
  { pattern: /super bowl|nfl|nba|mlb|nhl|championship|world cup|soccer|basketball|football/i, category: 'Sports' },
  { pattern: /ai|artificial intelligence|openai|chatgpt|microsoft|apple|google|amazon|tech/i, category: 'Tech' },
  { pattern: /oil|gas|energy|climate|carbon|renewable/i, category: 'Energy' },
];

function categorize(title) {
  for (const { pattern, category } of CATEGORY_PATTERNS) {
    if (pattern.test(title)) return category;
  }
  return 'General';
}

function parseOutcomePrices(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') { try { return JSON.parse(raw).map(Number); } catch { return null; } }
  if (Array.isArray(raw)) return raw.map(Number);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregate all markets + reference forecasts
// ─────────────────────────────────────────────────────────────────────────────
async function fetchAllMarkets() {
  const [predictit, polymarket, kalshi, metaculus, manifold] = await Promise.allSettled([
    fetchPredictIt(),
    fetchPolymarket(),
    fetchKalshi(),
    fetchMetaculus(),
    fetchManifold(),
  ]);

  const tradeableMarkets = [
    ...(predictit.status  === 'fulfilled' ? predictit.value  : []),
    ...(polymarket.status === 'fulfilled' ? polymarket.value : []),
    ...(kalshi.status     === 'fulfilled' ? kalshi.value     : []),
  ];

  const referenceForecasts = [
    ...(metaculus.status === 'fulfilled' ? metaculus.value : []),
    ...(manifold.status  === 'fulfilled' ? manifold.value  : []),
  ];

  // Attach the best cross-reference to each tradeable market
  for (const market of tradeableMarkets) {
    const ref = findBestCrossRef(market, referenceForecasts);
    market.crossRef = ref || null;
  }

  console.log(`[Markets] Total: ${tradeableMarkets.length} tradeable markets, ${referenceForecasts.length} reference forecasts`);
  return tradeableMarkets;
}

module.exports = { fetchAllMarkets, categorize };
