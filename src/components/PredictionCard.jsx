import { useState } from 'react';

export default function PredictionCard({ prediction: p, highlight = false }) {
  const [expanded, setExpanded] = useState(false);

  const platformClass = {
    Kalshi:      'platform-kalshi',
    Polymarket:  'platform-polymarket',
    PredictIt:   'platform-predictit',
  }[p.platform] || 'platform-kalshi';

  const evColor   = p.bestEV  >= 0.05 ? 'positive' : p.bestEV > 0 ? 'neutral' : 'negative';
  const scoreColor = p.finalScore >= 0.6 ? '#22c55e' : p.finalScore >= 0.4 ? '#f59e0b' : '#94a3b8';
  const sentimentColor = p.sentimentLabel === 'Bullish' ? '#22c55e'
    : p.sentimentLabel === 'Bearish' ? '#ef4444' : '#94a3b8';

  // Signal badge colors by source
  const signalColor = label => {
    if (label === 'Metaculus' || label === 'Manifold') return '#a855f7';
    if (label === 'Economic data') return '#f59e0b';
    if (label === 'Sentiment-adjusted') return '#3b82f6';
    return '#5a7a99';
  };

  // Parse **bold** markdown in reasoning
  const renderReasoning = text => {
    if (!text) return null;
    const parts = text.split(/\*\*(.*?)\*\*/g);
    return parts.map((part, i) => i % 2 === 1 ? <strong key={i}>{part}</strong> : part);
  };

  return (
    <div className={`prediction-card ${highlight ? 'top-pick' : ''}`}>
      {/* Platform + Score */}
      <div className="card-platform-row">
        <span className={`platform-chip ${platformClass}`}>{p.platform}</span>
        <div className="card-score-ring" style={{ color: scoreColor }}>
          <span style={{ fontSize: '.85rem' }}>▲</span>
          <span>{(p.finalScore * 100).toFixed(0)}</span>
          <span style={{ fontSize: '.65rem', fontWeight: 400, color: 'var(--text-3)' }}>/100</span>
          {p.isTopPick && <span title="Top Pick">🔥</span>}
        </div>
      </div>

      {/* Title */}
      <div className="card-title" title={p.title}>
        <a href={p.url} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>
          {p.title}
        </a>
      </div>

      {/* Metrics grid */}
      <div className="card-metrics">
        <div className="metric-box">
          <div className="metric-label">Market Price</div>
          <div className={`metric-value ${p.bestSide === 'YES' ? 'positive' : 'negative'}`}>
            {(p.currentPrice * 100).toFixed(0)}¢
          </div>
        </div>
        <div className="metric-box">
          <div className="metric-label">Est. Prob</div>
          <div className="metric-value neutral">
            {(p.estimatedProbability * 100).toFixed(0)}%
          </div>
        </div>
        <div className="metric-box">
          <div className="metric-label">EV / $1</div>
          <div className={`metric-value ${evColor}`}>
            {p.bestEV >= 0 ? '+' : ''}{(p.bestEV * 100).toFixed(1)}¢
          </div>
        </div>
      </div>

      {/* Recommendation */}
      <div className="card-side-row">
        <span className="side-label">Agent Recommendation:</span>
        <span className={`side-recommendation side-${p.bestSide.toLowerCase()}`}>
          BET {p.bestSide}
        </span>
        <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>
          @ {(p.currentPrice * 100).toFixed(0)}¢
        </span>
      </div>

      {/* Signal pills — show all probability sources */}
      {p.signals && p.signals.length > 0 && (
        <div style={{ display: 'flex', gap: '.3rem', flexWrap: 'wrap', marginBottom: '.65rem' }}>
          {p.signals.map((s, i) => (
            <span key={i} style={{
              fontSize: '.64rem', padding: '.15rem .45rem', borderRadius: 99,
              background: `${signalColor(s.label)}22`,
              color: signalColor(s.label),
              border: `1px solid ${signalColor(s.label)}44`,
              fontWeight: 600,
            }}>
              {s.label}: {Math.round(s.prob * 100)}%
            </span>
          ))}
          {p.signalCount >= 3 && (
            <span style={{ fontSize: '.64rem', color: '#22c55e', padding: '.15rem .3rem', fontWeight: 700 }}>
              ✓ {p.signalCount} sources agree
            </span>
          )}
        </div>
      )}

      {/* Cross-reference callout */}
      {p.crossRef && (
        <div style={{
          background: 'rgba(168,85,247,.07)', border: '1px solid rgba(168,85,247,.2)',
          borderRadius: 6, padding: '.4rem .6rem', marginBottom: '.65rem',
          fontSize: '.72rem',
        }}>
          <span style={{ color: '#a855f7', fontWeight: 700 }}>🔮 {p.crossRef.source}: </span>
          <span style={{ color: 'var(--text-2)' }}>
            Community puts this at <strong style={{ color: 'var(--text-1)' }}>{Math.round(p.crossRef.probability * 100)}%</strong>
            {p.crossRef.forecasters ? ` (${p.crossRef.forecasters} forecasters)` : ''}
            {Math.abs(Math.round(p.crossRef.probability * 100) - Math.round(p.currentPrice * 100)) >= 5
              ? <span style={{ color: '#f59e0b' }}> — {Math.abs(Math.round(p.crossRef.probability * 100) - Math.round(p.currentPrice * 100))}% gap vs market!</span>
              : ''}
          </span>
        </div>
      )}

      {/* Economic data context */}
      {p.economicContext && p.economicContext.length > 0 && (
        <div style={{
          background: 'rgba(245,158,11,.07)', border: '1px solid rgba(245,158,11,.2)',
          borderRadius: 6, padding: '.4rem .6rem', marginBottom: '.65rem',
          fontSize: '.72rem', display: 'flex', gap: '.5rem', flexWrap: 'wrap',
        }}>
          <span style={{ color: '#f59e0b', fontWeight: 700 }}>📊 Live data: </span>
          {p.economicContext.map((d, i) => (
            <span key={i} style={{ color: 'var(--text-2)' }}>
              {d.indicator} = <strong style={{ color: 'var(--text-1)' }}>{d.value}</strong>
              <span style={{ color: d.trend === 'rising' ? '#22c55e' : d.trend === 'falling' ? '#ef4444' : '#94a3b8', marginLeft: '.2rem' }}>
                {d.trend === 'rising' ? '↑' : d.trend === 'falling' ? '↓' : '→'}
              </span>
              {i < p.economicContext.length - 1 ? ' · ' : ''}
            </span>
          ))}
        </div>
      )}

      {/* Progress bars */}
      <div className="card-bars">
        <BarRow
          label="Confidence"
          value={p.confidence}
          color={p.confidence >= 0.6 ? '#22c55e' : p.confidence >= 0.3 ? '#f59e0b' : '#94a3b8'}
          display={`${(p.confidence * 100).toFixed(0)}%`}
        />
        <BarRow
          label="Risk"
          value={p.riskScore}
          color={p.riskScore <= 0.35 ? '#22c55e' : p.riskScore <= 0.65 ? '#f59e0b' : '#ef4444'}
          display={p.riskLabel}
        />
        <BarRow
          label="Sentiment"
          value={(Math.abs(p.sentimentScore) + 1) / 2}
          color={sentimentColor}
          display={p.sentimentLabel}
        />
      </div>

      {/* Reasoning */}
      <div
        className="card-reasoning"
        style={expanded ? { WebkitLineClamp: 'unset' } : {}}
      >
        {renderReasoning(p.reasoning)}
      </div>

      {/* Footer */}
      <div className="card-footer">
        <span className="card-news-count">
          📰 {p.relevantCount} article{p.relevantCount !== 1 ? 's' : ''} · {p.category}
        </span>
        <div style={{ display: 'flex', gap: '.75rem', alignItems: 'center' }}>
          <button
            onClick={() => setExpanded(!expanded)}
            style={{ background: 'none', color: 'var(--text-3)', fontSize: '.7rem', cursor: 'pointer', border: 'none' }}
          >
            {expanded ? '▲ Less' : '▼ More'}
          </button>
          <a className="card-link" href={p.url} target="_blank" rel="noopener noreferrer">
            View ↗
          </a>
        </div>
      </div>

      {/* Expanded: top articles */}
      {expanded && p.topArticles && p.topArticles.length > 0 && (
        <div style={{ marginTop: '.75rem', borderTop: '1px solid var(--border)', paddingTop: '.75rem' }}>
          <div style={{ fontSize: '.68rem', color: 'var(--text-3)', marginBottom: '.4rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>Supporting Articles</div>
          {p.topArticles.map((a, i) => (
            <div key={i} style={{ marginBottom: '.4rem', display: 'flex', gap: '.5rem', alignItems: 'flex-start' }}>
              <span style={{ fontSize: '.65rem', color: a.sentiment > 0.1 ? '#22c55e' : a.sentiment < -0.1 ? '#ef4444' : '#5a7a99', flexShrink: 0, marginTop: '.1rem' }}>
                {a.sentiment > 0.1 ? '↑' : a.sentiment < -0.1 ? '↓' : '→'}
              </span>
              <div>
                <a href={a.url} target="_blank" rel="noopener noreferrer"
                   style={{ fontSize: '.73rem', color: 'var(--text-1)', lineHeight: 1.3, display: 'block' }}>
                  {a.title}
                </a>
                <span style={{ fontSize: '.63rem', color: 'var(--text-3)' }}>{a.source}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BarRow({ label, value, color, display }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="bar-row">
      <span className="bar-row-label">{label}</span>
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="bar-value" style={{ color }}>{display}</span>
    </div>
  );
}
