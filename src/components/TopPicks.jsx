import PredictionCard from './PredictionCard.jsx';

export default function TopPicks({ picks, loading, onSelect }) {
  if (loading) {
    return (
      <div className="top-picks-grid">
        {[1, 2, 3].map(i => (
          <div key={i} className="prediction-card" style={{ minHeight: 260 }}>
            <div className="skeleton" style={{ height: 14, width: '40%', marginBottom: 10 }} />
            <div className="skeleton" style={{ height: 18, width: '90%', marginBottom: 6 }} />
            <div className="skeleton" style={{ height: 18, width: '70%', marginBottom: 16 }} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 12 }}>
              <div className="skeleton" style={{ height: 48 }} />
              <div className="skeleton" style={{ height: 48 }} />
              <div className="skeleton" style={{ height: 48 }} />
            </div>
            <div className="skeleton" style={{ height: 40, marginBottom: 8 }} />
            <div className="skeleton" style={{ height: 50 }} />
          </div>
        ))}
      </div>
    );
  }

  if (picks.length === 0) {
    return (
      <div className="top-picks-grid">
        <div className="no-data">
          <div style={{ fontSize: '2rem', marginBottom: '.5rem' }}>🔍</div>
          <div style={{ fontWeight: 600, marginBottom: '.3rem' }}>No top picks yet</div>
          <div>The agent is scanning markets. Strong opportunities will appear here when found.</div>
          <div style={{ marginTop: '.5rem', fontSize: '.73rem' }}>
            Top picks require: EV ≥ 5¢ · Risk ≤ 65% · Confidence ≥ 30%
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="top-picks-grid">
      {picks.map(pick => (
        <div
          key={pick.id}
          className="clickable-card"
          onClick={() => onSelect && onSelect(pick)}
          title="Click for full AI analysis"
        >
          <PredictionCard prediction={pick} highlight />
        </div>
      ))}
    </div>
  );
}
