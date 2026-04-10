/**
 * server/agent-runner.js — Runs the full analysis pipeline
 *
 * Exports:
 *   runAgent() — triggers analysis; no-ops if already running
 *
 * Dependencies: server/cache.js (state), agent/analyzer.js (pipeline)
 * No HTTP, no cron — just the run logic.
 */

const { runFullAnalysis }       = require('../agent/analyzer');
const { generateDeltaBriefing } = require('../agent/ai-engine');
const {
  getCache,
  updateCache,
  persistToDisk,
  appendHistory,
  broadcastProgress,
} = require('./cache');

async function runAgent() {
  const cache = getCache();
  if (cache.status.running) {
    console.log('[Agent] Already running, skipping...');
    return;
  }

  updateCache({ status: { running: true, error: null, progress: 0, progressStage: 'Starting…' } });
  console.log('[Agent] ── Analysis started ──────────────────────');

  // Capture previous top-pick estimates for delta briefing comparison
  const prevTopPicks = new Map(
    (cache.predictions || [])
      .filter(p => p.isTopPick)
      .map(p => [p.id, { estimate: p.estimatedProbability, price: p.currentPrice, title: p.title, topArticles: p.topArticles }])
  );

  // Build prev predictions map for AI cache lookups (sentiment, Signal 5 Lite)
  const prevPredictionsMap = new Map(
    (cache.predictions || []).map(p => [p.id, p])
  );

  const onProgress = (percent, stage) => {
    updateCache({ status: { progress: percent, progressStage: stage } });
    broadcastProgress(percent, stage);
    console.log(`[Agent] ${String(percent).padStart(3)}%  ${stage}`);
  };

  try {
    const result = await runFullAnalysis(onProgress, prevPredictionsMap);

    // ── Delta briefing: explain top-pick estimate shifts since last run ────────
    if (process.env.ANTHROPIC_API_KEY && prevTopPicks.size > 0) {
      const DELTA_THRESHOLD = parseFloat(process.env.AI_DELTA_THRESHOLD || '0.05');
      const deltas = result.predictions
        .filter(p => p.isTopPick)
        .flatMap(p => {
          const prev = prevTopPicks.get(p.id);
          if (!prev) return [];
          if (Math.abs(p.estimatedProbability - prev.estimate) < DELTA_THRESHOLD) return [];
          return [{ id: p.id, title: p.title, prevEstimate: prev.estimate, newEstimate: p.estimatedProbability, prevPrice: prev.price, newPrice: p.currentPrice, topArticles: p.topArticles || [] }];
        });

      if (deltas.length > 0) {
        const deltaMap = await generateDeltaBriefing(deltas);
        for (const pred of result.predictions) {
          const note = deltaMap.get(pred.id);
          if (note) pred.deltaNote = note;
        }
        console.log(`[Agent] Delta briefing: ${deltaMap.size} markets updated`);
      }
    }

    updateCache({
      predictions:     result.predictions,
      news:            result.news,
      briefing:        result.briefing        || null,
      clusterAnalysis: result.clusterAnalysis || null,
      status: {
        lastRun:              new Date().toISOString(),
        marketsChecked:       result.marketsChecked,
        newsSourcesChecked:   result.newsSourcesChecked,
        newsSourcesSucceeded: result.newsSourcesSucceeded,
        topPickCount:         result.predictions.filter(p => p.isTopPick).length,
        runCount:             (getCache().status.runCount || 0) + 1,
        error:                null,
      },
    });

    persistToDisk();
    appendHistory();

    const { predictions, status } = getCache();
    console.log(`[Agent] ✓ Complete: ${predictions.length} predictions, ${status.topPickCount} top picks`);
  } catch (err) {
    updateCache({ status: { error: err.message } });
    console.error('[Agent] ✗ Error:', err.message);
  } finally {
    const errMsg = getCache().status.error;
    updateCache({ status: { running: false, progress: 0, progressStage: errMsg ? 'Error' : 'Idle' } });
    broadcastProgress(0, errMsg ? 'Error' : 'Idle');
  }
}

module.exports = { runAgent };
