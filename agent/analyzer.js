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
 * The more independent signals agree, the higher the confidence score.
 *
 * TOP PICKS criteria (all must be true):
 *   finalScore  ≥ 0.45
 *   bestEV      ≥ 0.05  (+5¢ per $1 wagered)
 *   riskScore   ≤ 0.65
 *   confidence  ≥ 0.30
 *
 * Claude pre-filter (cost control): bestEV ≥ 0.03 && volume ≥ 100
 */

const { fetchAllMarkets }        = require('./markets');
const { collectAllNews }         = require('./collector');
const { analyzeMarketSentiment } = require('./sentiment');
const { fetchEconomicData, matchEconomicContext } = require('./fred');
const {
  analyzeMarketWithAI,
  generateBriefing,
  analyzeSentimentBatch,
  analyzeMarketWithAILite,
  generateRiskNarratives,
  generateClusterAnalysis,
} = require('./ai-engine');
const { fetchOddsData,      matchOddsContext }     = require('./odds');
const { fetchFinancialData, matchFinancialContext } = require('./financial');
const { fetchPollingData,   matchPollingContext }   = require('./polling');

// ─────────────────────────────────────────────────────────────────────────────
// getEventKey — returns a dedup key for a prediction, or null if it is a
// standalone market that should never be collapsed.
//
//  • Kalshi multi-leg events:  use eventTicker  (set by fetchKalshi)
//  • PredictIt / Polymarket:   many markets use "Base question — Option" titles.
//    Strip the " — Option" suffix to get a stable per-event key.
//  • Single-outcome markets:   return null (no dedup)
// ─────────────────────────────────────────────────────────────────────────────
function getEventKey(p) {
  // Kalshi: explicit event group
  if (p.eventTicker) return `kalshi::${p.eventTicker}`;

  // Any platform: detect "Question — Option" title pattern (em-dash or plain dash)
  if (p.title) {
    const emDashIdx   = p.title.indexOf(' \u2014 ');  // ' — '
    const hyphenIdx   = p.title.indexOf(' - ');        // ' - '  (fallback)
    const splitIdx    = emDashIdx !== -1 ? emDashIdx : hyphenIdx;
    if (splitIdx !== -1) {
      const baseQuestion = p.title.slice(0, splitIdx).trim();
      // Only treat as a multi-leg market if the base question is at least
      // 20 chars (avoids splitting on ordinary hyphens in short titles)
      if (baseQuestion.length >= 20) {
        return `${p.platform}::${baseQuestion.toLowerCase()}`;
      }
    }
  }

  return null; // standalone market — no dedup
}

// ─────────────────────────────────────────────────────────────────────────────
// applyAIResult — merges a Claude AI result into a prediction in-place.
// Used for both fresh API results and when replaying a valid cached result.
// ─────────────────────────────────────────────────────────────────────────────
function applyAIResult(pred, aiResult) {
  const newSignals  = [...pred.signals, { label: 'Claude AI', prob: aiResult.estimatedProbability, weight: 0.20 }];
  const totalW      = newSignals.reduce((s, x) => s + x.weight, 0);
  const newEP       = clamp(newSignals.reduce((s, x) => s + x.prob * (x.weight / totalW), 0), 0.02, 0.98);
  const newEvYes    = newEP - pred.currentPrice;
  const newEvNo     = (1 - newEP) - (1 - pred.currentPrice - 0.05);
  const newBestEV   = Math.max(newEvYes, newEvNo);
  const newBestSide = newEvYes >= newEvNo ? 'YES' : 'NO';

  pred.estimatedProbability = +newEP.toFixed(3);
  pred.evYes      = +newEvYes.toFixed(3);
  pred.evNo       = +newEvNo.toFixed(3);
  pred.bestEV     = +newBestEV.toFixed(3);
  pred.bestSide   = newBestSide;
  pred.currentPrice = newBestSide === 'YES' ? pred.currentPrice : +(1 - pred.currentPrice - 0.05).toFixed(3);
  pred.signals    = newSignals.map(s => ({ label: s.label, prob: +s.prob.toFixed(3), weight: +(s.weight / totalW).toFixed(2) }));
  pred.signalCount  = newSignals.length;
  pred.aiAnalysis   = aiResult;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// onProgress(percent 0-100, stageLabel) called throughout so the server can
// stream live progress to the dashboard.
// ─────────────────────────────────────────────────────────────────────────────
async function runFullAnalysis(onProgress = () => {}, prevPredictionsMap = new Map()) {
  onProgress(3, 'Connecting to data sources…');

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
  const oddsData      = oddsResult.status      === 'fulfilled' ? oddsResult.value      : {};
  const financialData = financialResult.status === 'fulfilled' ? financialResult.value : {};
  const pollingData   = pollingResult.status   === 'fulfilled' ? pollingResult.value   : {};

  const allMarkets       = marketsResult;
  const allArticles      = newsResult.articles;
  const sources          = newsResult.sourcesChecked;
  const sourcesSucceeded = newsResult.sourcesSucceeded;

  // ── AI Sentiment Batch (Signal 2 upgrade for high-volume markets) ──────────
  let aiSentimentMap = new Map();
  if (process.env.ANTHROPIC_API_KEY) {
    const SENTIMENT_MIN_VOL = parseFloat(process.env.AI_SENTIMENT_MIN_VOLUME || '2000');
    const SENTIMENT_MAX     = parseInt(process.env.AI_SENTIMENT_MAX_MARKETS  || '200', 10);
    const sentimentMarkets  = allMarkets
      .filter(m => (m.volume || 0) >= SENTIMENT_MIN_VOL)
      .sort((a, b) => (b.volume || 0) - (a.volume || 0))
      .slice(0, SENTIMENT_MAX);
    if (sentimentMarkets.length > 0) {
      onProgress(48, `AI sentiment batch: ${sentimentMarkets.length} high-volume markets…`);
      aiSentimentMap = await analyzeSentimentBatch(sentimentMarkets, allArticles, prevPredictionsMap);
      console.log(`[Analyzer] AI sentiment: ${aiSentimentMap.size} markets scored`);
    }
  }

  onProgress(50, `Scoring ${allMarkets.length} markets against ${allArticles.length} articles…`);
  console.log(`[Analyzer] Scoring ${allMarkets.length} markets | ${allArticles.length} articles | ${Object.keys(economicData).length} indicators`);

  // Score each market, reporting progress every 15 markets
  const predictions = [];
  for (let i = 0; i < allMarkets.length; i++) {
    const scored = scorePrediction(allMarkets[i], allArticles, economicData, oddsData, financialData, pollingData, aiSentimentMap);
    if (scored) predictions.push(scored);
    if (i % 15 === 0 || i === allMarkets.length - 1) {
      const pct = 40 + Math.round(((i + 1) / Math.max(allMarkets.length, 1)) * 30);
      onProgress(pct, `Scoring market ${i + 1} of ${allMarkets.length}…`);
    }
  }

  // ── Signal 5: Claude AI analysis (qualifying markets only) ─────────────────
  const PRICE_DRIFT = parseFloat(process.env.AI_PRICE_DRIFT || '0.03'); // re-analyze if price moved >3%
  let qualifying = []; // hoisted so Signal 5 Lite block can reference it
  if (process.env.ANTHROPIC_API_KEY) {
    // Configurable spend controls (set in .env to override defaults)
    const EV_THRESHOLD  = parseFloat(process.env.AI_EV_THRESHOLD  || '0.03');
    const MIN_VOLUME    = parseFloat(process.env.AI_MIN_VOLUME     || '100');
    const MAX_MARKETS   = parseInt(  process.env.AI_MAX_MARKETS    || '50', 10);
    const CACHE_HOURS   = parseFloat(process.env.AI_CACHE_HOURS    || '6');   // hours before re-analyzing

    // Sort by bestEV descending so the cap keeps the highest-value markets
    qualifying = predictions
      .filter(p => p.bestEV >= EV_THRESHOLD && (p.volume || 0) >= MIN_VOLUME)
      .sort((a, b) => b.bestEV - a.bestEV)
      .slice(0, MAX_MARKETS);

    // ── Smart cache: skip markets whose AI analysis is still fresh ───────────
    // A cached result is valid when ALL of:
    //   1. aiAnalysis exists with an analyzedAt timestamp
    //   2. analysed within CACHE_HOURS
    //   3. market price hasn't drifted more than PRICE_DRIFT since analysis
    const cacheMs = CACHE_HOURS * 3_600_000;

    const needsAnalysis = qualifying.filter(pred => {
      const ai = pred.aiAnalysis;
      if (!ai?.analyzedAt) return true;                               // never analyzed
      const age = Date.now() - new Date(ai.analyzedAt).getTime();
      if (age > cacheMs) return true;                                 // stale
      const prevPrice = ai.priceAtAnalysis ?? null;
      if (prevPrice !== null && Math.abs(pred.currentPrice - prevPrice) > PRICE_DRIFT) return true; // price moved
      return false;
    });

    const cached = qualifying.length - needsAnalysis.length;
    console.log(`[Analyzer] AI analysis: ${needsAnalysis.length} fresh calls + ${cached} cached (cap ${MAX_MARKETS}, EV≥${EV_THRESHOLD}, vol≥${MIN_VOLUME}, cache ${CACHE_HOURS}h)`);
    onProgress(72, `AI analysis: ${needsAnalysis.length} markets (${cached} cached)…`);

    // Re-apply cached AI results to predictions that are still valid
    qualifying.filter(p => !needsAnalysis.includes(p)).forEach(pred => {
      if (!pred.aiAnalysis) return;
      applyAIResult(pred, pred.aiAnalysis);
    });

    // Process fresh markets in batches of 5
    const BATCH = 5;
    for (let b = 0; b < needsAnalysis.length; b += BATCH) {
      const batch = needsAnalysis.slice(b, b + BATCH);
      await Promise.all(batch.map(async pred => {
        const market = allMarkets.find(m => m.id === pred.id) || {
          id: pred.id, bestYes: pred.currentPrice, volume: pred.volume,
          platform: pred.platform, title: pred.title, closes: pred.closes,
        };
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
        if (!aiResult) return;
        applyAIResult(pred, aiResult);
      }));
      const pct = 72 + Math.round(((b + BATCH) / Math.max(needsAnalysis.length, 1)) * 18);
      onProgress(Math.min(pct, 91), `AI analysis: ${Math.min(b + BATCH, needsAnalysis.length)}/${needsAnalysis.length}…`);
    }
  }

  // ── Signal 5 Lite: Claude AI for sub-threshold markets ──────────────────
  if (process.env.ANTHROPIC_API_KEY) {
    const LITE_EV_THRESHOLD = parseFloat(process.env.AI_LITE_EV_THRESHOLD  || '0.01');
    const LITE_MIN_VOLUME   = parseFloat(process.env.AI_LITE_MIN_VOLUME     || '50');
    const LITE_MAX_MARKETS  = parseInt(  process.env.AI_LITE_MAX_MARKETS    || '50', 10);
    const LITE_CACHE_MS     = parseFloat(process.env.AI_CACHE_HOURS || '6') * 3_600_000;

    const fullSignal5Ids = new Set(qualifying.map(p => p.id));

    const liteQualifying = predictions
      .filter(p =>
        !fullSignal5Ids.has(p.id) &&
        (p.volume || 0) >= LITE_MIN_VOLUME &&
        p.bestEV >= LITE_EV_THRESHOLD
      )
      .sort((a, b) => b.bestEV - a.bestEV)
      .slice(0, LITE_MAX_MARKETS);

    const liteNeedsAnalysis = liteQualifying.filter(pred => {
      const ai = prevPredictionsMap.get(pred.id)?.aiAnalysis;
      if (!ai?.analyzedAt || ai.signalSource !== 'claude-lite') return true;
      if (Date.now() - new Date(ai.analyzedAt).getTime() > LITE_CACHE_MS) return true;
      const prev = ai.priceAtAnalysis ?? null;
      if (prev !== null && Math.abs(pred.currentPrice - prev) > PRICE_DRIFT) return true;
      return false;
    });

    // Re-apply valid cached lite results
    liteQualifying
      .filter(p => !liteNeedsAnalysis.includes(p))
      .forEach(pred => {
        const ai = prevPredictionsMap.get(pred.id)?.aiAnalysis;
        if (ai?.signalSource === 'claude-lite') applyAIResult(pred, ai);
      });

    const liteCached = liteQualifying.length - liteNeedsAnalysis.length;
    console.log(`[Analyzer] Signal 5 Lite: ${liteNeedsAnalysis.length} fresh + ${liteCached} cached`);
    onProgress(91, `Signal 5 Lite: ${liteNeedsAnalysis.length} markets…`);

    const BATCH = 5;
    for (let b = 0; b < liteNeedsAnalysis.length; b += BATCH) {
      const batch = liteNeedsAnalysis.slice(b, b + BATCH);
      await Promise.all(batch.map(async pred => {
        const market = allMarkets.find(m => m.id === pred.id) || {
          id: pred.id, bestYes: pred.currentPrice, volume: pred.volume,
          platform: pred.platform, title: pred.title, closes: pred.closes,
        };
        const aiResult = await analyzeMarketWithAILite(market, pred.topArticles || [], pred.signals || []);
        if (!aiResult) return;
        applyAIResult(pred, aiResult);
      }));
    }
  }

  onProgress(92, 'Ranking predictions & tagging top picks…');

  predictions.sort((a, b) => b.finalScore - a.finalScore);

  // ── Cross-platform event-level deduplication ──────────────────────────────
  // Collapse mutually exclusive legs into a single "best bet" per event:
  //
  //  • Kalshi:    keyed by eventTicker  (e.g. KXNFLMVP-27)
  //  • PredictIt: keyed by base question from "Question — Option" title format
  //  • Polymarket: same title-based detection
  //
  // Predictions are already sorted by finalScore DESC, so the first leg seen
  // per key is the highest-scoring one.  All subsequent legs are dropped.
  const seenEvents = new Set();
  const deduped = predictions.filter(p => {
    const key = getEventKey(p);
    if (!key) return true;               // standalone market — always keep
    if (seenEvents.has(key)) return false; // already have the best leg
    seenEvents.add(key);
    return true;
  });

  // Re-rank and tag top picks on the deduped list
  const TOP_PICK_MIN_SCORE      = 0.45;
  const TOP_PICK_MIN_EV         = 0.05;
  const TOP_PICK_MAX_RISK       = 0.65;
  const TOP_PICK_MIN_CONFIDENCE = 0.30;

  const seenTopEvents = new Set();
  deduped.forEach((p, i) => {
    p.rank = i + 1;
    const meetsThreshold = (
      p.finalScore  >= TOP_PICK_MIN_SCORE      &&
      p.bestEV      >= TOP_PICK_MIN_EV         &&
      p.riskScore   <= TOP_PICK_MAX_RISK       &&
      p.confidence  >= TOP_PICK_MIN_CONFIDENCE
    );
    const key = getEventKey(p);
    if (meetsThreshold && key) {
      if (seenTopEvents.has(key)) {
        p.isTopPick = false;
      } else {
        seenTopEvents.add(key);
        p.isTopPick = true;
      }
    } else {
      p.isTopPick = meetsThreshold;
    }
  });

  const rawCount   = predictions.length;
  const dedupedCount = deduped.length;
  console.log(`[Analyzer] Deduped ${rawCount} → ${dedupedCount} predictions (${rawCount - dedupedCount} redundant event legs removed)`);

  // ── Risk Narratives ─────────────────────────────────────────────────────────
  if (process.env.ANTHROPIC_API_KEY) {
    const RISK_THRESHOLD = parseFloat(process.env.AI_RISK_NARRATIVE_THRESHOLD || '0.60');
    const highRisk       = deduped.filter(p => p.riskScore >= RISK_THRESHOLD);
    if (highRisk.length > 0) {
      onProgress(93, `Risk narratives: ${highRisk.length} high-risk markets…`);
      const narrativeMap = await generateRiskNarratives(highRisk);
      for (const pred of highRisk) {
        const n = narrativeMap.get(pred.id);
        if (n) pred.riskNarrative = n;
      }
      console.log(`[Analyzer] Risk narratives: ${narrativeMap.size} generated`);
    }
  }

  // ── Briefing ───────────────────────────────────────────────────────────────
  let briefing        = null;
  let clusterAnalysis = null;
  if (process.env.ANTHROPIC_API_KEY) {
    const topPicks = deduped.filter(p => p.isTopPick).slice(0, 10);
    onProgress(96, 'Generating briefing and cluster analysis…');
    [briefing, clusterAnalysis] = await Promise.all([
      generateBriefing(topPicks, economicData),
      generateClusterAnalysis(deduped),
    ]);
  }

  const topPickCount = deduped.filter(p => p.isTopPick).length;
  onProgress(100, `Done — ${dedupedCount} predictions, ${topPickCount} top picks`);
  console.log(`[Analyzer] ✓ ${dedupedCount} predictions, ${topPickCount} top picks`);

  return {
    predictions:           deduped,
    briefing,
    clusterAnalysis,
    news:                  allArticles.slice(0, 120),
    marketsChecked:        allMarkets.length,
    newsSourcesChecked:    sources,
    newsSourcesSucceeded:  sourcesSucceeded,
    economicIndicators:    Object.keys(economicData).length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Score a single market using all available signals
// ─────────────────────────────────────────────────────────────────────────────
function scorePrediction(market, articles, economicData, oddsData = {}, financialData = {}, pollingData = {}, aiSentimentMap = new Map()) {
  try {
    const { bestYes, bestNo } = market;
    if (!bestYes || !bestNo || bestYes <= 0.01 || bestYes >= 0.99) return null;

    // ── Signal 1: Market price (always available) ──────────────────────────
    const marketPrice = bestYes;

    // ── Signal 2: News sentiment ───────────────────────────────────────────
    const sentimentData = analyzeMarketSentiment(market, articles);
    const { relevantCount, topArticles } = sentimentData;

    // AI sentiment overrides keyword scoring for high-volume markets
    const aiSent        = aiSentimentMap.get(market.id);
    const sentimentScore = aiSent ? aiSent.sentimentScore  : sentimentData.sentimentScore;
    const sentimentLabel = aiSent ? aiSent.sentimentLabel  : sentimentData.sentimentLabel;
    const sentConf       = aiSent ? aiSent.confidence      : sentimentData.confidence;

    const SENT_MAX_SHIFT = 0.12;
    const sentAdjusted   = clamp(marketPrice + sentimentScore * SENT_MAX_SHIFT * sentConf, 0.02, 0.98);

    // ── Signal 3: Cross-reference forecast (Metaculus / Manifold) ─────────
    let crossRefProb   = null;
    let crossRefSource = null;
    let crossRefDetail = null;
    if (market.crossRef) {
      crossRefProb   = market.crossRef.probability;
      crossRefSource = market.crossRef.source;
      crossRefDetail = {
        title:      market.crossRef.title,
        url:        market.crossRef.url,
        source:     market.crossRef.source,
        probability: crossRefProb,
        matchScore: market.crossRef.matchScore,
        forecasters: market.crossRef.forecasters || null,
      };
    }

    // ── Signal 4: Economic data context ───────────────────────────────────
    let econProb   = null;
    let econDetail = null;
    const econContext = matchEconomicContext(market.title, economicData);
    if (econContext && econContext.probability !== null) {
      econProb   = econContext.probability;
      econDetail = econContext.indicators;
    }

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
    if (crossRefProb !== null)            signalPool.push({ prob: crossRefProb,          weight: 0.16, label: crossRefSource });
    if (econProb     !== null)            signalPool.push({ prob: econProb,              weight: 0.12, label: 'Economic data' });
    if (oddsMatch?.probability  != null)  signalPool.push({ prob: oddsMatch.probability, weight: 0.25, label: 'Bookmaker Consensus' });
    if (finMatch?.probability   != null)  signalPool.push({ prob: finMatch.probability,  weight: 0.20, label: 'Financial market' });
    if (pollMatch?.probability  != null)  signalPool.push({ prob: pollMatch.probability, weight: 0.20, label: 'Polling/legislative' });

    // Renormalize weights so they always sum to 1
    const totalW = signalPool.reduce((s, x) => s + x.weight, 0);
    const estimatedProbability = clamp(
      signalPool.reduce((s, x) => s + x.prob * (x.weight / totalW), 0),
      0.02, 0.98
    );

    // Signal agreement — how much do independent sources agree?
    const signalVariance  = signalPool.length > 1
      ? stdDev(signalPool.map(x => x.prob)) : 0.15;
    const signalAgreement = Math.max(0, 1 - signalVariance * 3); // low spread = high agreement

    // ── Expected Value ─────────────────────────────────────────────────────
    const evYes = estimatedProbability - bestYes;
    const evNo  = (1 - estimatedProbability) - bestNo;
    const bestEV    = Math.max(evYes, evNo);
    const bestSide  = evYes >= evNo ? 'YES' : 'NO';
    const currentPrice = bestSide === 'YES' ? bestYes : bestNo;

    // ── Risk Score ─────────────────────────────────────────────────────────
    const spreadRisk    = calcSpreadRisk(bestYes, bestNo);
    const liquidityRisk = calcLiquidityRisk(market.volume);
    const timeRisk      = calcTimeRisk(market.closes);
    const volatilityRisk = relevantCount < 2 ? 0.6 : Math.max(0, 0.6 - relevantCount / 20);
    const riskScore = clamp(
      spreadRisk * 0.25 + liquidityRisk * 0.30 + timeRisk * 0.20 + volatilityRisk * 0.25,
      0, 1
    );

    // ── Confidence (composite) ─────────────────────────────────────────────
    const sourceCount       = signalPool.length;           // 2–4
    const sourceCountFactor = Math.min((sourceCount - 1) / 6, 1);  // 0 … 1 for 2–7 sources
    const confidence = clamp(
      sentConf * 0.45 +
      signalAgreement * 0.30 +
      sourceCountFactor * 0.25,
      0.05, 1
    );

    // ── Final composite score ──────────────────────────────────────────────
    const evComponent          = clamp(bestEV / 0.20, 0, 1);
    const sentimentComponent   = clamp(Math.abs(sentimentScore), 0, 1);
    const coverageComponent    = clamp(relevantCount / 10, 0, 1);
    const agreementComponent   = signalAgreement;
    const confidenceComponent  = confidence;

    const rawScore = (
      evComponent         * 0.35 +
      sentimentComponent  * 0.20 +
      coverageComponent   * 0.10 +
      agreementComponent  * 0.15 +
      confidenceComponent * 0.20
    );
    const riskPenalty = 1 + riskScore * 0.6;
    const finalScore  = clamp(rawScore / riskPenalty, 0, 1);

    // ── Reasoning ──────────────────────────────────────────────────────────
    const reasoning = generateReasoning({
      market, bestSide, currentPrice, estimatedProbability,
      evYes, evNo, bestEV, sentimentLabel, sentimentScore,
      relevantCount, confidence, riskScore, topArticles,
      signalPool, crossRefDetail, econDetail,
    });

    return {
      // Identity
      id:          market.id,
      platform:    market.platform,
      title:       market.title,
      url:         market.url,
      category:    market.category,
      closes:      market.closes,
      volume:      market.volume,
      eventTicker: market.eventTicker || null, // Kalshi event group for dedup

      // Recommendation
      bestSide,
      currentPrice:        +currentPrice.toFixed(3),
      estimatedProbability: +estimatedProbability.toFixed(3),
      evYes:  +evYes.toFixed(3),
      evNo:   +evNo.toFixed(3),
      bestEV: +bestEV.toFixed(3),

      // Signals
      sentimentScore: +sentimentScore.toFixed(3),
      sentimentLabel,
      relevantCount,
      confidence:     +confidence.toFixed(3),
      signalCount:    signalPool.length,
      signalAgreement: +signalAgreement.toFixed(3),
      signals: signalPool.map(s => ({ label: s.label, prob: +s.prob.toFixed(3), weight: +(s.weight / totalW).toFixed(2) })),
      crossRef: crossRefDetail,
      economicContext: econDetail,
      oddsContext:      oddsMatch?.indicators  || null,
      financialContext: finMatch?.indicators   || null,
      pollingContext:   pollMatch?.indicators  || null,

      // Risk
      riskScore: +riskScore.toFixed(3),
      riskLabel: riskScore < 0.35 ? 'Low' : riskScore < 0.60 ? 'Medium' : 'High',

      // Ranking
      finalScore: +finalScore.toFixed(4),
      isTopPick:  false,
      rank:       0,

      // Explainability
      reasoning,
      topArticles,
      analyzedAt: new Date().toISOString(),
      aiSentiment: aiSent ? { ...aiSent } : undefined,
    };
  } catch (err) {
    console.error(`[Analyzer] Error scoring ${market.id}:`, err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Risk helpers
// ─────────────────────────────────────────────────────────────────────────────
function calcSpreadRisk(yes, no) {
  return clamp(Math.max(0, 1 - yes - no) / 0.30, 0, 1);
}

function calcLiquidityRisk(volume) {
  if (!volume || volume <= 0) return 0.90;
  if (volume > 100_000) return 0.05;
  if (volume > 10_000)  return 0.20;
  if (volume > 1_000)   return 0.45;
  if (volume > 100)     return 0.65;
  return 0.85;
}

function calcTimeRisk(closesAt) {
  if (!closesAt) return 0.50;
  const days = (new Date(closesAt) - Date.now()) / 86_400_000;
  if (days < 0)  return 0.95;
  if (days < 1)  return 0.80;
  if (days < 7)  return 0.50;
  if (days < 30) return 0.30;
  return 0.15;
}

// ─────────────────────────────────────────────────────────────────────────────
// Human-readable reasoning — now includes cross-ref and economic signals
// ─────────────────────────────────────────────────────────────────────────────
function generateReasoning({ market, bestSide, currentPrice, estimatedProbability,
  evYes, evNo, bestEV, sentimentLabel, sentimentScore, relevantCount, confidence,
  riskScore, topArticles, signalPool, crossRefDetail, econDetail }) {

  const currentPct = Math.round(currentPrice * 100);
  const estPct     = Math.round(estimatedProbability * 100);
  const evCents    = Math.round(bestEV * 100);
  const riskLabel  = riskScore < 0.35 ? 'low' : riskScore < 0.60 ? 'medium' : 'high';

  let text = `The agent recommends betting **${bestSide}** at ${currentPct}¢ (est. true prob ~${estPct}%). `;

  // Signal breakdown
  text += `**${signalPool.length} signals fused:** `;
  text += signalPool.map(s => `${s.label} → ${Math.round(s.prob * 100)}%`).join(', ') + '. ';

  // Cross-reference
  if (crossRefDetail) {
    const xPct = Math.round(crossRefDetail.probability * 100);
    const diff = Math.abs(xPct - Math.round(currentPrice * 100));
    text += `**${crossRefDetail.source}** community forecasts this at ${xPct}%`;
    if (diff >= 5) text += ` — a **${diff}% gap** vs the market price`;
    text += '. ';
  }

  // Economic data
  if (econDetail && econDetail.length > 0) {
    const d = econDetail[0];
    text += `**Economic data:** ${d.indicator} = ${d.value} (${d.trend}). `;
  }

  // Sentiment
  text += `News sentiment across ${relevantCount} relevant article${relevantCount !== 1 ? 's' : ''} is **${sentimentLabel}** (${(sentimentScore * 100).toFixed(0)}%). `;

  // EV summary
  text += `EV on ${bestSide}: **+${evCents}¢ per $1 wagered**. `;
  text += `Risk: **${riskLabel}**. `;

  // Confidence annotation
  if (confidence < 0.30) text += '⚠️ Low confidence — insufficient data, use caution.';
  else if (confidence >= 0.70) text += '✅ High confidence — multiple independent signals agree.';

  // Top article
  if (topArticles.length > 0) {
    text += ` Key article: "${topArticles[0].title}" (${topArticles[0].source}).`;
  }

  return text;
}

// ─────────────────────────────────────────────────────────────────────────────
// Math helpers
// ─────────────────────────────────────────────────────────────────────────────
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function stdDev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length);
}

module.exports = { runFullAnalysis };
