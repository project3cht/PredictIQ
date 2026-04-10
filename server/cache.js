/**
 * server/cache.js — Shared in-memory state, disk persistence, and SSE clients
 *
 * Exports:
 *   getCache()                      — returns the live cache object (by reference)
 *   updateCache(patch)              — shallow-merges patch; deep-merges patch.status
 *   persistToDisk()                 — writes predictions/news/status to data/latest.json
 *   appendHistory()                 — appends scored summary to data/history.jsonl (capped 720 entries)
 *   loadFromDisk()                  — hydrates cache from data/latest.json on startup
 *   broadcastProgress(pct, stage)  — sends SSE event to all connected clients
 *   addSSEClient(res)               — registers an SSE response stream
 *   removeSSEClient(res)            — deregisters an SSE response stream
 */

const fs   = require('fs');
const path = require('path');

const DATA_FILE    = path.join(__dirname, '..', 'data', 'latest.json');
const HISTORY_FILE = path.join(__dirname, '..', 'data', 'history.jsonl');
const MAX_HISTORY  = 720; // ~30 days at hourly runs

// ── Internal state ────────────────────────────────────────────────────────────
const sseClients = new Set();

let cache = {
  predictions:     [],
  news:            [],
  briefing:        null,
  clusterAnalysis: null,
  status: {
    lastRun:               null,
    nextRun:               null,
    running:               false,
    marketsChecked:        0,
    newsSourcesChecked:    0,
    newsSourcesSucceeded:  0,
    topPickCount:          0,
    error:                 null,
    runCount:              0,
    progress:              0,
    progressStage:         'Idle',
  },
};

// ── Public API ────────────────────────────────────────────────────────────────
function getCache() {
  return cache;
}

function updateCache(patch) {
  const { status: statusPatch, ...rest } = patch;
  Object.assign(cache, rest);
  if (statusPatch) {
    Object.assign(cache.status, statusPatch);
  }
}

function broadcastProgress(progress, stage) {
  const payload = JSON.stringify({ progress, stage, running: cache.status.running });
  for (const res of sseClients) {
    try { res.write(`data: ${payload}\n\n`); } catch { sseClients.delete(res); }
  }
}

function addSSEClient(res) {
  sseClients.add(res);
}

function removeSSEClient(res) {
  sseClients.delete(res);
}

function persistToDisk() {
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify({
    predictions:     cache.predictions,
    news:            cache.news,
    briefing:        cache.briefing,
    clusterAnalysis: cache.clusterAnalysis,
    status:          cache.status,
  }, null, 2));
}

function appendHistory() {
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const record = {
    runAt: new Date().toISOString(),
    predictions: cache.predictions.map(p => ({
      id:                   p.id,
      platform:             p.platform,
      title:                p.title,
      finalScore:           p.finalScore,
      confidence:           p.confidence,
      currentPrice:         p.currentPrice,
      estimatedProbability: p.estimatedProbability,
      bestEV:               p.bestEV,
      isTopPick:            p.isTopPick,
    })),
  };

  let lines = [];
  if (fs.existsSync(HISTORY_FILE)) {
    lines = fs.readFileSync(HISTORY_FILE, 'utf-8').split('\n').filter(Boolean);
  }
  lines.push(JSON.stringify(record));
  if (lines.length > MAX_HISTORY) lines = lines.slice(lines.length - MAX_HISTORY);
  fs.writeFileSync(HISTORY_FILE, lines.join('\n') + '\n');
}

function loadFromDisk() {
  if (!fs.existsSync(DATA_FILE)) return;
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    Object.assign(cache, saved);
    Object.assign(cache.status, saved.status || {});
    cache.status.running = false; // always start non-running
    console.log(`[Cache] Loaded ${cache.predictions.length} cached predictions from disk.`);
  } catch (e) {
    console.error('[Cache] Failed to load cached data:', e.message);
  }
}

module.exports = {
  getCache,
  updateCache,
  persistToDisk,
  appendHistory,
  loadFromDisk,
  broadcastProgress,
  addSSEClient,
  removeSSEClient,
};
