/**
 * Briefing.jsx — Daily AI briefing strip above Top Picks
 *
 * Props: briefing — { summary, highlights: [{label, sentiment}], generatedAt } | null
 */

export default function Briefing({ briefing }) {
  if (!briefing) return null;

  const fmtTime = iso => {
    if (!iso) return '';
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const sentimentColor = s => {
    if (s === 'bullish')  return '#22c55e';
    if (s === 'bearish')  return '#ef4444';
    return '#94a3b8';
  };

  const sentimentIcon = s => {
    if (s === 'bullish') return '↑';
    if (s === 'bearish') return '↓';
    return '→';
  };

  return (
    <div style={{
      background:    'linear-gradient(135deg, rgba(99,102,241,.12) 0%, rgba(139,92,246,.08) 100%)',
      border:        '1px solid rgba(139,92,246,.3)',
      borderRadius:  10,
      padding:       '1rem 1.2rem',
      marginBottom:  '1.5rem',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', marginBottom: '.7rem' }}>
        <span style={{ fontSize: '.72rem', fontWeight: 700, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: '.08em' }}>
          🤖 AI Daily Briefing
        </span>
        <span style={{ fontSize: '.65rem', color: 'var(--text-3)' }}>
          Generated {fmtTime(briefing.generatedAt)}
        </span>
      </div>

      {/* Summary */}
      <p style={{ fontSize: '.82rem', color: 'var(--text-1)', lineHeight: 1.6, margin: '0 0 .75rem' }}>
        {briefing.summary}
      </p>

      {/* Highlights */}
      {briefing.highlights && briefing.highlights.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.4rem' }}>
          {briefing.highlights.map((h, i) => {
            const col = sentimentColor(h.sentiment);
            return (
              <span key={i} style={{
                display:        'inline-flex',
                alignItems:     'center',
                gap:            '.25rem',
                padding:        '.2rem .55rem',
                borderRadius:   99,
                background:     `${col}15`,
                border:         `1px solid ${col}35`,
                color:          col,
                fontSize:       '.71rem',
                fontWeight:     600,
              }}>
                <span>{sentimentIcon(h.sentiment)}</span>
                {h.label}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
