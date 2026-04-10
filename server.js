/**
 * server.js — Entry point
 *
 * Wires together server/cache, server/agent-runner, server/routes.
 * Sets up hourly cron and starts the HTTP server.
 *
 * Run:  node server.js
 * Dev:  npm run dev  (concurrently runs vite + this server)
 */

require('dotenv').config({ override: true });

const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');
const path    = require('path');
const fs      = require('fs');

const { loadFromDisk, updateCache } = require('./server/cache');
const { runAgent }                  = require('./server/agent-runner');
const { createRouter }              = require('./server/routes');

const app  = express();
const PORT = process.env.PORT || 3001;
const DIST = path.join(__dirname, 'dist');

app.use(cors());
app.use(express.json());

loadFromDisk();

app.use('/api', createRouter());
app.use(express.static(DIST));
app.get('*', (_req, res) => {
  const idx = path.join(DIST, 'index.html');
  fs.existsSync(idx)
    ? res.sendFile(idx)
    : res.status(200).send(`
        <html><body style="font-family:monospace;padding:2rem;background:#050d1e;color:#22c55e">
          <h2>🔮 PredictIQ Server Running</h2>
          <p>API live at <a href="/api/status" style="color:#3b82f6">/api/status</a></p>
          <p>Run <code>npm run build</code> then reload to see the dashboard.</p>
        </body></html>
      `);
});

function scheduleNextRun() {
  updateCache({ status: { nextRun: new Date(Date.now() + 60 * 60 * 1000).toISOString() } });
}

cron.schedule('0 * * * *', () => {
  console.log('[Cron] ⏰ Hourly trigger fired');
  scheduleNextRun();
  runAgent();
});

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║   🔮 PredictIQ Server                  ║
║   http://localhost:${PORT}               ║
║   Hourly analysis: ENABLED             ║
╚════════════════════════════════════════╝
  `);
  scheduleNextRun();
  runAgent();
});
