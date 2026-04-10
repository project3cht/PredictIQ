import { useState, useEffect, useCallback, useRef } from 'react';
import TopPicks from './components/TopPicks.jsx';
import AllPredictions from './components/AllPredictions.jsx';
import NewsStream from './components/NewsStream.jsx';
import PredictionDetail from './components/PredictionDetail.jsx';
import Briefing from './components/Briefing.jsx';
import AIChat from './components/AIChat.jsx';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // auto-poll every 5 minutes

export default function App() {
  const [predictions, setPredictions]       = useState([]);
  const [news, setNews]                     = useState([]);
  const [status, setStatus]                 = useState({});
  const [briefing, setBriefing]             = useState(null);
  const [loading, setLoading]               = useState(true);
  const [refreshing, setRefreshing]         = useState(false);
  const [activeTab, setActiveTab]           = useState('All');
  const [error, setError]                   = useState(null);
  const [selectedPrediction, setSelected]   = useState(null);
  const intervalRef = useRef(null);

  // ── Fetch data from backend ──────────────────────────────────────────────
  const fetchData = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const [predRes, newsRes, statusRes, briefingRes] = await Promise.all([
        fetch('/api/predictions'),
        fetch('/api/news'),
        fetch('/api/status'),
        fetch('/api/briefing'),
      ]);

      if (!predRes.ok) throw new Error(`API error: ${predRes.status}`);

      const [preds, newsData, statusData, briefingData] = await Promise.all([
        predRes.json(),
        newsRes.json(),
        statusRes.json(),
        briefingRes.ok ? briefingRes.json() : Promise.resolve(null),
      ]);

      setPredictions(Array.isArray(preds) ? preds : []);
      setNews(Array.isArray(newsData) ? newsData : []);
      setStatus(statusData || {});
      setBriefing(briefingData || null);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Trigger manual refresh ────────────────────────────────────────────────
  const handleRefresh = useCallback(async () => {
    if (refreshing || status.running) return;
    setRefreshing(true);
    try {
      await fetch('/api/refresh', { method: 'POST' });
      // Poll status every 3s until done
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        const res = await fetch('/api/status');
        const s   = await res.json();
        setStatus(s);
        if (!s.running || attempts > 60) {
          clearInterval(poll);
          setRefreshing(false);
          fetchData();
        }
      }, 3000);
    } catch {
      setRefreshing(false);
    }
  }, [refreshing, status.running, fetchData]);

  // ── Initial load + polling ────────────────────────────────────────────────
  useEffect(() => {
    fetchData(true);
    intervalRef.current = setInterval(() => fetchData(), REFRESH_INTERVAL_MS);
    return () => clearInterval(intervalRef.current);
  }, [fetchData]);

  // ── SSE progress stream — replaces polling while analysis runs ────────────
  useEffect(() => {
    const es = new EventSource('/api/progress');
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        setStatus(prev => ({
          ...prev,
          progress:      data.progress,
          progressStage: data.stage,
          running:       data.running,
        }));
        if (!data.running) fetchData();
      } catch {}
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [fetchData]);

  // ── Derived data ─────────────────────────────────────────────────────────
  const topPicks    = predictions.filter(p => p.isTopPick);
  const allPlatforms = ['All', 'Kalshi', 'Polymarket', 'PredictIt'];
  const filtered    = activeTab === 'All'
    ? predictions
    : predictions.filter(p => p.platform === activeTab);

  const platformCounts = {};
  for (const p of predictions) {
    platformCounts[p.platform] = (platformCounts[p.platform] || 0) + 1;
  }

  // ── Status display helpers ────────────────────────────────────────────────
  const dotClass  = status.running ? 'running' : status.lastRun ? '' : 'idle';
  const dotStatus = status.running ? 'Analyzing…' : status.lastRun ? 'Live' : 'Waiting';

  const fmtTime = iso => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const fmtNextRun = iso => {
    if (!iso) return '—';
    const mins = Math.max(0, Math.round((new Date(iso) - Date.now()) / 60000));
    return mins === 0 ? 'now' : `in ${mins}m`;
  };

  return (
    <div className="app">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="header" style={{ flexWrap: 'wrap', gap: '.5rem' }}>
        <div className="header-brand">
          🔮 <span>PredictIQ</span>
        </div>

        <div className="header-meta">
          <div className="header-status">
            <div className={`pulse-dot ${dotClass}`} />
            <span>{dotStatus}</span>
          </div>
          {status.running && status.progress > 0 && (
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--blue)', fontWeight: 700, fontSize: '.78rem' }}>
              {status.progress}%
            </span>
          )}
          {status.lastRun && (
            <span>Last run: {fmtTime(status.lastRun)}</span>
          )}
          {status.nextRun && !status.running && (
            <span>Next: {fmtNextRun(status.nextRun)}</span>
          )}
          {status.topPickCount > 0 && (
            <span className="badge badge-green">🔥 {status.topPickCount} Top Picks</span>
          )}
        </div>

        <button
          className="btn btn-primary"
          onClick={handleRefresh}
          disabled={refreshing || status.running}
        >
          {refreshing || status.running ? '⟳ Analyzing…' : '⟳ Refresh Now'}
        </button>

        {/* Progress bar — full width, shown only while running */}
        {status.running && (
          <div style={{ width: '100%', order: 10 }}>
            <div style={{
              height: 4, background: 'rgba(255,255,255,.08)', borderRadius: 99,
              overflow: 'hidden', marginTop: '.1rem',
            }}>
              <div style={{
                height: '100%', background: 'var(--blue)',
                width: `${status.progress || 0}%`,
                borderRadius: 99,
                transition: 'width .6s ease',
                boxShadow: '0 0 8px var(--blue)',
              }} />
            </div>
            <div style={{ fontSize: '.65rem', color: 'var(--text-3)', marginTop: '.2rem', paddingLeft: '.1rem' }}>
              {status.progressStage || 'Analyzing…'}
            </div>
          </div>
        )}
      </header>

      {/* ── Main layout ────────────────────────────────────────────────── */}
      <div className="main-layout">
        <main className="content-area">
          {/* Error banner */}
          {error && (
            <div style={{ background: 'rgba(239,68,68,.1)', border: '1px solid rgba(239,68,68,.3)', borderRadius: 8, padding: '.75rem 1rem', marginBottom: '1rem', color: '#fca5a5', fontSize: '.8rem' }}>
              ⚠️ {error} — Make sure the server is running (<code>npm run dev</code>)
            </div>
          )}

          {/* ── AI Briefing ────────────────────────────────────────────── */}
          <Briefing briefing={briefing} />

          {/* ── Top Picks ──────────────────────────────────────────────── */}
          <section>
            <div className="section-header">
              <h2 className="section-title">
                🔥 Top Picks
                <span className="badge badge-green">{topPicks.length} opportunities</span>
              </h2>
              <span style={{ fontSize: '.73rem', color: 'var(--text-3)' }}>
                High EV · Low Risk · News-confirmed
              </span>
            </div>
            <TopPicks picks={topPicks} loading={loading} onSelect={setSelected} />
          </section>

          {/* ── All Markets ────────────────────────────────────────────── */}
          <section style={{ marginTop: '2rem' }}>
            <div className="section-header">
              <h2 className="section-title">
                📊 All Markets
                <span className="badge">{predictions.length} total</span>
              </h2>
            </div>

            {/* Platform tabs */}
            <div className="tab-bar">
              {allPlatforms.map(tab => (
                <button
                  key={tab}
                  className={`tab-btn ${activeTab === tab ? 'active' : ''}`}
                  onClick={() => setActiveTab(tab)}
                >
                  {tab}
                  {tab !== 'All' && platformCounts[tab] !== undefined && (
                    <span style={{ marginLeft: '.35rem', opacity: .6 }}>({platformCounts[tab]})</span>
                  )}
                </button>
              ))}
            </div>

            <AllPredictions predictions={filtered} loading={loading} onSelect={setSelected} />
          </section>
        </main>

        {/* ── News sidebar ───────────────────────────────────────────────── */}
        <NewsStream articles={news} />
      </div>

      {/* ── Prediction detail drawer ───────────────────────────────────── */}
      {selectedPrediction && (
        <PredictionDetail
          prediction={selectedPrediction}
          onClose={() => setSelected(null)}
        />
      )}

      {/* ── Floating AI chat ────────────────────────────────────────────── */}
      <AIChat />

      {/* ── Status bar ─────────────────────────────────────────────────── */}
      <footer className="status-bar">
        <div className="status-item">
          <span>🏪</span>
          <span><strong>{status.marketsChecked || 0}</strong> markets scanned</span>
        </div>
        <div className="status-item">
          <span>📰</span>
          <span>
            <strong>{status.newsSourcesSucceeded || status.newsSourcesChecked || 0}</strong>
            {status.newsSourcesChecked ? `/${status.newsSourcesChecked}` : ''} news sources
          </span>
        </div>
        <div className="status-item">
          <span>🔁</span>
          <span>Hourly auto-refresh enabled</span>
        </div>
        <div className="status-item">
          <span>📡</span>
          <span>Kalshi · Polymarket · PredictIt</span>
        </div>
        {status.error && (
          <div className="status-item" style={{ color: 'var(--red)' }}>
            ⚠️ {status.error}
          </div>
        )}
      </footer>
    </div>
  );
}
