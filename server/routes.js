/**
 * server/routes.js — All Express API routes
 *
 * Exports:
 *   createRouter() — returns an Express Router mounted at /api
 *
 * Routes:
 *   GET  /api/predictions           — all scored predictions
 *   GET  /api/news                  — latest articles
 *   GET  /api/status                — agent run status
 *   GET  /api/progress              — SSE stream for live progress updates
 *   GET  /api/history               — historical score records (jsonl → array)
 *   GET  /api/briefing              — latest AI daily briefing
 *   GET  /api/clusters              — latest cluster analysis
 *   GET  /api/price-history/:id     — on-demand price history from platform APIs
 *   POST /api/chat                  — AI question answering
 *   POST /api/refresh               — trigger immediate re-analysis
 */

const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');
const { answerQuestion } = require('../agent/ai-engine');

const {
  getCache,
  addSSEClient,
  removeSSEClient,
} = require('./cache');
const { runAgent } = require('./agent-runner');

const HISTORY_FILE = path.join(__dirname, '..', 'data', 'history.jsonl');

function createRouter() {
  const router = express.Router();

  // ── Predictions & news ─────────────────────────────────────────────────────
  router.get('/predictions', (_req, res) => {
    res.json(getCache().predictions);
  });

  router.get('/news', (_req, res) => {
    res.json(getCache().news);
  });

  // ── Status ─────────────────────────────────────────────────────────────────
  router.get('/status', (_req, res) => {
    res.json(getCache().status);
  });

  // ── SSE progress stream ────────────────────────────────────────────────────
  router.get('/progress', (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    // Send current status immediately so client knows where we are
    const s = getCache().status;
    res.write(`data: ${JSON.stringify({ progress: s.progress, stage: s.progressStage, running: s.running })}\n\n`);

    addSSEClient(res);
    req.on('close', () => removeSSEClient(res));
  });

  // ── Briefing ───────────────────────────────────────────────────────────────
  router.get('/briefing', (_req, res) => {
    res.json(getCache().briefing || null);
  });

  // ── Cluster Analysis ───────────────────────────────────────────────────────
  router.get('/clusters', (_req, res) => {
    res.json(getCache().clusterAnalysis || null);
  });

  // ── Chat ───────────────────────────────────────────────────────────────────
  router.post('/chat', async (req, res) => {
    const { question } = req.body || {};
    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'question is required' });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'AI features not available (ANTHROPIC_API_KEY not set)' });
    }
    const cache = getCache();
    const topPredictions = cache.predictions.filter(p => p.isTopPick).slice(0, 20);
    const headlines      = (cache.news || []).slice(0, 15);
    const result = await answerQuestion(question.trim(), topPredictions, headlines);
    if (!result) return res.status(502).json({ error: 'AI request failed' });
    res.json(result);
  });

  // ── History ────────────────────────────────────────────────────────────────
  router.get('/history', (_req, res) => {
    if (!fs.existsSync(HISTORY_FILE)) return res.json([]);
    const lines   = fs.readFileSync(HISTORY_FILE, 'utf-8').split('\n').filter(Boolean);
    const records = lines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    res.json(records);
  });

  // ── On-demand price history ────────────────────────────────────────────────
  router.get('/price-history/:marketId', async (req, res) => {
    const { marketId } = req.params;
    try {
      if (marketId.startsWith('polymarket_')) {
        const pred = getCache().predictions.find(p => p.id === marketId);
        const conditionId = pred?.conditionId;
        if (conditionId) {
          const endTs   = Math.floor(Date.now() / 1000);
          const startTs = endTs - 7 * 24 * 3600;
          const { data } = await axios.get(
            `https://clob.polymarket.com/prices-history?market=${conditionId}&startTs=${startTs}&endTs=${endTs}&fidelity=120`,
            { timeout: 8000 }
          );
          return res.json({ source: 'Polymarket CLOB', history: data.history || [] });
        }
      }
      if (marketId.startsWith('predictit_')) {
        const parts      = marketId.replace('predictit_', '').split('_');
        const contractId = parts[1];
        const { data } = await axios.get(
          `https://www.predictit.org/api/Trade/${contractId}/PriceHistory`,
          { timeout: 8000, headers: { 'User-Agent': 'PredictIQ-Dashboard/1.0' } }
        );
        const history = (data || []).map(d => ({ t: d.dateString, p: d.closeSharePrice }));
        return res.json({ source: 'PredictIt', history });
      }
      res.json({ source: null, history: [] });
    } catch (err) {
      res.json({ source: null, history: [], error: err.message });
    }
  });

  // ── Manual refresh ─────────────────────────────────────────────────────────
  router.post('/refresh', (_req, res) => {
    if (getCache().status.running) {
      return res.json({ message: 'Analysis already in progress.' });
    }
    res.json({ message: 'Analysis started. Results available shortly.' });
    runAgent();
  });

  return router;
}

module.exports = { createRouter };
