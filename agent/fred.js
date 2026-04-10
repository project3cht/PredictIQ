/**
 * fred.js — Economic data layer
 *
 * Pulls real economic indicators so the agent can KNOW the answer to some
 * markets rather than guessing from news alone.
 *
 * Sources (all free, no API key required by default):
 *   • World Bank API  — CPI, unemployment (global, official)
 *   • US Treasury API — T-bill / yield data
 *   • Coinbase API    — BTC, ETH real-time spot prices (no key)
 *   • FRED API        — optional; set FRED_API_KEY in .env for richer data
 *
 * Returns an object keyed by indicator name with { value, date, unit, trend }.
 * The analyzer uses this to directly inform probability estimates on economic markets.
 */

const axios = require('axios');

// Load optional .env
try { require('dotenv').config({ override: true }); } catch {}

const FRED_KEY = process.env.FRED_API_KEY || null;

// ─────────────────────────────────────────────────────────────────────────────
// World Bank — free, no key, slight lag (~1 month)
// ─────────────────────────────────────────────────────────────────────────────
const WORLD_BANK_SERIES = [
  { id: 'FP.CPI.TOTL.ZG',      name: 'cpi_yoy',        label: 'US CPI (YoY %)',        unit: '%' },
  { id: 'SL.UEM.TOTL.ZS',      name: 'unemployment',   label: 'US Unemployment Rate',  unit: '%' },
  { id: 'NY.GDP.MKTP.KD.ZG',   name: 'gdp_growth',     label: 'US GDP Growth (YoY %)', unit: '%' },
];

async function fetchWorldBank() {
  const results = {};
  await Promise.allSettled(
    WORLD_BANK_SERIES.map(async series => {
      try {
        const { data } = await axios.get(
          `https://api.worldbank.org/v2/country/US/indicator/${series.id}?format=json&mrv=4&per_page=4`,
          { timeout: 8000 }
        );
        const entries = data?.[1] || [];
        const valid = entries.filter(e => e.value !== null);
        if (valid.length === 0) return;

        const latest  = valid[0];
        const prev    = valid[1] || null;
        const trend   = prev ? (latest.value > prev.value ? 'rising' : latest.value < prev.value ? 'falling' : 'stable') : 'unknown';

        results[series.name] = {
          label: series.label,
          value: parseFloat(latest.value.toFixed(2)),
          date: latest.date,
          unit: series.unit,
          trend,
          prevValue: prev ? parseFloat(prev.value.toFixed(2)) : null,
          source: 'World Bank',
        };
      } catch { /* skip silently */ }
    })
  );
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// FRED (Federal Reserve) — requires free API key from fred.stlouisfed.org
// Falls back silently if no key is configured.
// ─────────────────────────────────────────────────────────────────────────────
const FRED_SERIES = [
  { id: 'CPIAUCSL',  name: 'cpi_level',      label: 'CPI Level (SA)',              unit: 'index' },
  { id: 'CPILFESL',  name: 'core_cpi',       label: 'Core CPI (excl food/energy)', unit: 'index' },
  { id: 'UNRATE',    name: 'unemployment',   label: 'Unemployment Rate',           unit: '%' },
  { id: 'FEDFUNDS',  name: 'fed_funds',      label: 'Federal Funds Rate',          unit: '%' },
  { id: 'T10Y2Y',    name: 'yield_curve',    label: '10Y-2Y Yield Spread',         unit: '%' },
  { id: 'GDPC1',     name: 'real_gdp',       label: 'Real GDP',                    unit: 'billions' },
  { id: 'VIXCLS',    name: 'vix',            label: 'VIX Volatility Index',        unit: 'points' },
  { id: 'DCOILWTICO',name: 'oil_price',      label: 'WTI Crude Oil Price',         unit: '$/barrel' },
];

async function fetchFRED() {
  if (!FRED_KEY) return {};
  const results = {};

  await Promise.allSettled(
    FRED_SERIES.map(async series => {
      try {
        const { data } = await axios.get('https://api.stlouisfed.org/fred/series/observations', {
          params: {
            series_id: series.id,
            api_key: FRED_KEY,
            file_type: 'json',
            limit: 4,
            sort_order: 'desc',
          },
          timeout: 8000,
        });

        const obs = (data.observations || []).filter(o => o.value !== '.' && o.value !== 'NA');
        if (obs.length === 0) return;

        const latest = obs[0];
        const prev   = obs[1] || null;
        const val    = parseFloat(latest.value);
        const prevVal = prev ? parseFloat(prev.value) : null;
        const trend  = prevVal !== null ? (val > prevVal ? 'rising' : val < prevVal ? 'falling' : 'stable') : 'unknown';

        // Don't overwrite World Bank data if already present (FRED is more granular)
        results[series.name] = {
          label: series.label,
          value: +val.toFixed(3),
          date: latest.date,
          unit: series.unit,
          trend,
          prevValue: prevVal !== null ? +prevVal.toFixed(3) : null,
          source: 'FRED',
        };
      } catch { /* skip silently */ }
    })
  );

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Coinbase — real-time crypto spot prices, no key needed
// ─────────────────────────────────────────────────────────────────────────────
const CRYPTO_PAIRS = [
  { pair: 'BTC-USD', name: 'btc_price', label: 'Bitcoin (BTC) Price' },
  { pair: 'ETH-USD', name: 'eth_price', label: 'Ethereum (ETH) Price' },
  { pair: 'SOL-USD', name: 'sol_price', label: 'Solana (SOL) Price'   },
];

async function fetchCryptoPrices() {
  const results = {};
  await Promise.allSettled(
    CRYPTO_PAIRS.map(async ({ pair, name, label }) => {
      try {
        const { data } = await axios.get(`https://api.coinbase.com/v2/prices/${pair}/spot`, {
          timeout: 6000,
          headers: { 'CB-VERSION': '2016-02-18' },
        });
        const price = parseFloat(data?.data?.amount);
        if (!isNaN(price)) {
          results[name] = {
            label,
            value: price,
            date: new Date().toISOString().split('T')[0],
            unit: 'USD',
            trend: 'unknown',
            source: 'Coinbase',
          };
        }
      } catch { /* skip */ }
    })
  );
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// US Treasury — average interest rates, no key needed
// ─────────────────────────────────────────────────────────────────────────────
async function fetchTreasuryYields() {
  try {
    const { data } = await axios.get(
      'https://api.fiscaldata.treasury.gov/services/api/v1/accounting/od/avg_interest_rates' +
      '?fields=record_date,security_desc,avg_interest_rate_amt' +
      '&filter=security_desc:in:(Treasury Bills,Treasury Notes,Treasury Bonds)' +
      '&sort=-record_date&page[size]=9',
      { timeout: 8000 }
    );

    const results = {};
    for (const entry of (data?.data || [])) {
      const key = entry.security_desc.toLowerCase().replace(/\s+/g, '_');
      if (!results[key]) {
        results[key] = {
          label: `${entry.security_desc} Avg Rate`,
          value: parseFloat(entry.avg_interest_rate_amt),
          date: entry.record_date,
          unit: '%',
          trend: 'unknown',
          source: 'US Treasury',
        };
      }
    }
    return results;
  } catch {
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregate all economic data
// ─────────────────────────────────────────────────────────────────────────────
async function fetchEconomicData() {
  console.log(`[FRED] Fetching economic indicators${FRED_KEY ? ' (FRED key active)' : ' (World Bank + Coinbase + Treasury)'}...`);

  const [worldBank, fred, crypto, treasury] = await Promise.allSettled([
    fetchWorldBank(),
    fetchFRED(),
    fetchCryptoPrices(),
    fetchTreasuryYields(),
  ]);

  // Merge all sources (FRED takes precedence over World Bank for same indicator)
  const merged = {
    ...(worldBank.status === 'fulfilled' ? worldBank.value : {}),
    ...(fred.status      === 'fulfilled' ? fred.value      : {}),  // overwrites WB where available
    ...(crypto.status    === 'fulfilled' ? crypto.value    : {}),
    ...(treasury.status  === 'fulfilled' ? treasury.value  : {}),
  };

  const count = Object.keys(merged).length;
  console.log(`[FRED] Loaded ${count} economic indicators`);
  return merged;
}

// ─────────────────────────────────────────────────────────────────────────────
// Match economic data to a market title
// Returns { probability, context, indicators } or null if no match
// ─────────────────────────────────────────────────────────────────────────────
function matchEconomicContext(marketTitle, economicData) {
  const title = marketTitle.toLowerCase();
  const matched = [];

  // ── Inflation / CPI ───────────────────────────────────────────────────────
  if (/inflation|cpi|consumer price|price level/.test(title)) {
    const cpi = economicData.cpi_yoy || economicData.cpi_level;
    if (cpi) {
      const threshold = extractThreshold(title);
      let probability = null;

      if (threshold !== null && cpi.unit === '%') {
        // "Will CPI exceed X%?" — compare actual value to threshold
        if (/above|exceed|over|more than|higher than/.test(title)) {
          probability = cpi.value >= threshold ? 0.82 : 0.22;
        } else if (/below|under|less than|lower than/.test(title)) {
          probability = cpi.value <= threshold ? 0.82 : 0.22;
        }
      }

      matched.push({
        indicator: cpi.label,
        value: `${cpi.value}${cpi.unit}`,
        trend: cpi.trend,
        probability,
        source: cpi.source,
      });
    }
  }

  // ── Unemployment / Jobs ───────────────────────────────────────────────────
  if (/unemployment|jobless|jobs report|labor|payroll/.test(title)) {
    const unemp = economicData.unemployment;
    if (unemp) {
      const threshold = extractThreshold(title);
      let probability = null;
      if (threshold !== null) {
        if (/above|exceed|over/.test(title)) probability = unemp.value >= threshold ? 0.80 : 0.25;
        if (/below|under/.test(title))       probability = unemp.value <= threshold ? 0.80 : 0.25;
      }
      matched.push({ indicator: unemp.label, value: `${unemp.value}%`, trend: unemp.trend, probability, source: unemp.source });
    }
  }

  // ── Fed / Interest Rates ──────────────────────────────────────────────────
  if (/fed|federal reserve|interest rate|rate hike|rate cut|fomc/.test(title)) {
    const rate = economicData.fed_funds;
    if (rate) {
      const threshold = extractThreshold(title);
      let probability = null;
      if (threshold !== null) {
        if (/above|exceed|raise|hike/.test(title)) probability = rate.value >= threshold ? 0.75 : 0.30;
        if (/below|cut|reduce|lower/.test(title))  probability = rate.value <= threshold ? 0.75 : 0.30;
      }
      matched.push({ indicator: rate.label, value: `${rate.value}%`, trend: rate.trend, probability, source: rate.source });
    }
  }

  // ── Recession / GDP ───────────────────────────────────────────────────────
  if (/recession|gdp|economic contraction|negative growth/.test(title)) {
    const gdp = economicData.gdp_growth || economicData.real_gdp;
    if (gdp) {
      let probability = null;
      if (/recession/.test(title) && gdp.unit === '%') {
        // Two consecutive negative quarters = recession
        probability = gdp.value < 0 ? 0.70 : 0.20;
      }
      matched.push({ indicator: gdp.label, value: `${gdp.value}${gdp.unit}`, trend: gdp.trend, probability, source: gdp.source });
    }
  }

  // ── Bitcoin / Crypto ──────────────────────────────────────────────────────
  if (/bitcoin|btc/.test(title)) {
    const btc = economicData.btc_price;
    if (btc) {
      const threshold = extractDollarThreshold(title);
      let probability = null;
      if (threshold !== null) {
        if (/above|exceed|over|hit|reach/.test(title)) probability = btc.value >= threshold ? 0.78 : 0.28;
        if (/below|under|drop|fall/.test(title))       probability = btc.value <= threshold ? 0.78 : 0.28;
      }
      matched.push({ indicator: btc.label, value: `$${btc.value.toLocaleString()}`, trend: btc.trend, probability, source: btc.source });
    }
  }

  if (/ethereum|eth/.test(title)) {
    const eth = economicData.eth_price;
    if (eth) {
      const threshold = extractDollarThreshold(title);
      let probability = null;
      if (threshold !== null) {
        if (/above|exceed|over|hit|reach/.test(title)) probability = eth.value >= threshold ? 0.78 : 0.28;
        if (/below|under|drop|fall/.test(title))       probability = eth.value <= threshold ? 0.78 : 0.28;
      }
      matched.push({ indicator: eth.label, value: `$${eth.value.toLocaleString()}`, trend: eth.trend, probability, source: eth.source });
    }
  }

  if (matched.length === 0) return null;

  // Average probabilities from all matched indicators
  const withProb   = matched.filter(m => m.probability !== null);
  const avgProb    = withProb.length > 0
    ? withProb.reduce((s, m) => s + m.probability, 0) / withProb.length
    : null;

  return { probability: avgProb, indicators: matched };
}

// Extract a numeric percentage threshold from text like "exceed 3.5%" → 3.5
function extractThreshold(text) {
  const m = text.match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? parseFloat(m[1]) : null;
}

// Extract a dollar amount like "$100,000" or "100k" → 100000
function extractDollarThreshold(text) {
  const m = text.match(/\$?([\d,]+)(?:k|K)?/);
  if (!m) return null;
  const base = parseFloat(m[1].replace(/,/g, ''));
  return /k/i.test(text) ? base * 1000 : base;
}

module.exports = { fetchEconomicData, matchEconomicContext };
