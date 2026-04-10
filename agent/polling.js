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

// ── Approval polling URL ──────────────────────────────────────────────────────
// 538/ABC News creates a new CSV per president. Update this when the president changes.
// Biden (historical): https://projects.fivethirtyeight.com/biden-approval-data/approval_topline.csv
// Trump (current):    https://projects.fivethirtyeight.com/trump-approval-data/approval_topline.csv
const APPROVAL_CSV_URL = 'https://projects.fivethirtyeight.com/trump-approval-data/approval_topline.csv';

// ─────────────────────────────────────────────────────────────────────────────
// fetchApprovalRatings
// Uses FiveThirtyEight's public approval data CSV (no key required).
// Returns { president: { approve, disapprove, trend } } or null on failure.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchApprovalRatings() {
  try {
    // FiveThirtyEight/ABC publishes presidential approval averages here:
    const { data } = await axios.get(
      APPROVAL_CSV_URL,
      { timeout: 8000, responseType: 'text' }
    );

    // CSV format: "subgroup,modeldate,approve_estimate,disapprove_estimate,..."
    const lines = data.split('\n').filter(l => l.trim());
    // Find the "All adults" or "Adults" row with the most recent date
    const rows = lines.slice(1).map(l => l.split(','));
    const allAdults = rows
      .filter(r => /all adults/i.test(r[0]))
      .sort((a, b) => new Date(b[1]) - new Date(a[1]));

    if (allAdults.length === 0) {
      console.warn('[Polling] 538: no "All adults" rows found in CSV');
      return null;
    }

    const latest = allAdults[0];
    const prev   = allAdults[1] || null;
    const approve    = parseFloat(latest[2]);
    const disapprove = parseFloat(latest[3]);
    const prevApprove = prev ? parseFloat(prev[2]) : null;
    const trend = prevApprove !== null
      ? approve > prevApprove ? 'rising' : approve < prevApprove ? 'falling' : 'stable'
      : 'unknown';

    console.log('[Polling] 538 approval loaded for president');
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
  if (!apiKey) {
    console.log('[Polling] CONGRESS_API_KEY not set — skipping bill data');
    return [];
  }

  try {
    // sort=updateDate+desc is in the URL string (not axios params) so axios does not encode the literal '+' as '%2B'
    const { data } = await axios.get(
      'https://api.congress.gov/v3/bill?sort=updateDate+desc',
      {
        params: {
          api_key: apiKey,
          limit: 50,
          format: 'json',
        },
        timeout: 8000,
      }
    );

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
  if (/enrolled|presented to president|passed the house and senate|passed both/.test(t)) return 'enrolled';
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
