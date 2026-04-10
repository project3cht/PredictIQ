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
  if (saved !== undefined) process.env.ODDS_API_KEY = saved;
  else delete process.env.ODDS_API_KEY;
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

async function testFinancial() {
  const { fetchFinancialData, matchFinancialContext } = require('./financial');

  console.log('\n[Test] financial.js — fetchFinancialData() with no Polygon key → partial result');
  const saved = process.env.POLYGON_API_KEY;
  delete process.env.POLYGON_API_KEY;
  const result = await fetchFinancialData();
  // Should still return something (CME doesn't need a key); won't throw
  assert(typeof result === 'object', 'Should return object even without Polygon key');
  if (saved !== undefined) process.env.POLYGON_API_KEY = saved;
  else delete process.env.POLYGON_API_KEY;
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

  const hikeMatch = matchFinancialContext('Will the Fed raise interest rates at the June meeting?', fakeFin);
  assert(hikeMatch !== null, 'Hike keywords should match CME data');
  assert(Math.abs(hikeMatch.probability - 0.05) < 0.01, `hikeProb should be 0.05, got ${hikeMatch.probability}`);
  console.log(`  ✓ hike match: prob=${hikeMatch.probability.toFixed(3)}`);

  const holdMatch = matchFinancialContext('Will the FOMC hold steady at the July meeting?', fakeFin);
  assert(holdMatch !== null, 'FOMC keywords should match CME data');
  assert(Math.abs(holdMatch.probability - 0.61) < 0.01, `holdProb should be 0.61, got ${holdMatch.probability}`);
  console.log(`  ✓ hold match: prob=${holdMatch.probability.toFixed(3)}`);

  const spyMatch = matchFinancialContext('Will the S&P 500 close above 5500 by year end?', fakeFin);
  assert(spyMatch !== null, 'S&P keywords should match Polygon SPY data');
  assert(typeof spyMatch.probability === 'number', 'probability should be a number');
  console.log(`  ✓ S&P match: prob=${spyMatch.probability.toFixed(3)}`);

  const noMatch = matchFinancialContext('Will the Kansas City Chiefs win?', fakeFin);
  assert(noMatch === null, 'Sports market should not match financial context');
  console.log('  ✓ non-financial market returns null');
}

async function testPolling() {
  const { fetchPollingData, matchPollingContext } = require('./polling');

  console.log('\n[Test] polling.js — fetchPollingData() with no Congress key → partial');
  const saved = process.env.CONGRESS_API_KEY;
  delete process.env.CONGRESS_API_KEY;
  const result = await fetchPollingData();
  assert(typeof result === 'object', 'Should return object even without Congress key');
  if (saved !== undefined) process.env.CONGRESS_API_KEY = saved;
  else delete process.env.CONGRESS_API_KEY;
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

Promise.resolve()
  .then(testOdds)
  .then(testFinancial)
  .then(testPolling)
  .then(() => console.log('\n✅ All signal tests passed'))
  .catch(err => { console.error('\n❌ Test FAILED:', err.message); process.exit(1); });
