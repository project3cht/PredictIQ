/**
 * collect.js — Standalone data collection script
 *
 * Runs a full analysis and saves results to data/latest.json
 * Called by the Cowork hourly scheduled task (even when the server is offline).
 *
 * Usage:  node collect.js
 */

const path = require('path');
const fs   = require('fs');
const { runFullAnalysis } = require('./agent/analyzer');

const DATA_FILE = path.join(__dirname, 'data', 'latest.json');

(async () => {
  console.log(`[collect.js] Starting analysis at ${new Date().toISOString()}`);

  try {
    const result = await runFullAnalysis();

    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    const payload = {
      predictions:   result.predictions,
      news:          result.news,
      status: {
        lastRun:            new Date().toISOString(),
        nextRun:            new Date(Date.now() + 3600 * 1000).toISOString(),
        marketsChecked:     result.marketsChecked,
        newsSourcesChecked: result.newsSourcesChecked,
        topPickCount:       result.predictions.filter(p => p.isTopPick).length,
        running:            false,
        error:              null,
      },
    };

    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2));

    console.log(`[collect.js] ✓ Saved ${result.predictions.length} predictions (${payload.status.topPickCount} top picks) to ${DATA_FILE}`);
    process.exit(0);
  } catch (err) {
    console.error('[collect.js] ✗ Error:', err.message);
    process.exit(1);
  }
})();
