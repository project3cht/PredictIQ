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
      // Strategy 1: the whole string is JSON (sometimes CME returns text/plain JSON)
      try { parsed = JSON.parse(data); } catch { /* not raw JSON */ }
      // Strategy 2: try to find a top-level JSON object via greedy extraction
      if (!parsed) {
        const m = data.match(/var\s+fedWatchData\s*=\s*(\{[\s\S]+\})\s*;/);
        if (m) {
          try { parsed = JSON.parse(m[1]); } catch { /* malformed extraction */ }
        }
      }
    }

    if (!parsed) {
      console.warn('[Financial] CME: could not parse FedWatch response');
      return null;
    }

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
      if (/\b(cut|lower|reduce|ease)\b/.test(title))  prob = cme.cutProb;
      if (/\b(hike|raise|increase|tighten)\b/.test(title)) prob = cme.hikeProb;

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
  const m = text.match(/(?:above|over|exceed|hit|reach|break|below|under|drop|fall)\s+\$?([\d,]+(?:\.\d+)?)\s*k?\b/i);
  if (!m) return null;
  const base = parseFloat(m[1].replace(/,/g, ''));
  return /\d\s*k\b/i.test(m[0]) ? base * 1000 : base;
}

module.exports = { fetchFinancialData, matchFinancialContext };
