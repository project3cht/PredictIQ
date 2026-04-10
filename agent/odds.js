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
  // Update this sport key each election cycle — returns 422 (ignored) when no active markets
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
      const teamWords = w => w.toLowerCase().split(/\s+/).filter(t => t.length >= 5);
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
        if (!(homeOutcome?.price > 0) || !(awayOutcome?.price > 0)) continue;
        const p = devig(homeOutcome.price, awayOutcome.price);
        probs.push(targetIsHome ? p : 1 - p);
      }

      if (probs.length === 0) continue;

      const avgProb = probs.reduce((s, p) => s + p, 0) / probs.length;
      const matchedTeam = targetIsHome ? homeTeam : awayTeam;

      return {
        probability: avgProb,
        indicators: [{
          indicator: `Bookmaker Consensus — ${matchedTeam}${(mentionsHome && mentionsAway) ? ' (home team assumed)' : ''}`,
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
