import { useState, useMemo } from 'react';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Days until a closes ISO string. Returns Infinity if missing/unparseable. */
function daysUntil(iso) {
  if (!iso) return Infinity;
  const diff = new Date(iso) - Date.now();
  return diff < 0 ? 0 : diff / 86_400_000;
}

/** Human-readable relative time: "2d", "3w", "6m", "1y+" */
function fmtExpiry(iso) {
  if (!iso) return '—';
  const d = daysUntil(iso);
  if (d === 0)      return 'Ended';
  if (d < 1)        return `${Math.round(d * 24)}h`;
  if (d < 7)        return `${Math.round(d)}d`;
  if (d < 30)       return `${Math.round(d / 7)}w`;
  if (d < 365)      return `${Math.round(d / 30)}mo`;
  return `${(d / 365).toFixed(1)}y`;
}

/** Color-code the expiry: red = urgent, yellow = soon, grey = far */
function expiryColor(iso) {
  const d = daysUntil(iso);
  if (d <= 7)   return '#ef4444';
  if (d <= 30)  return '#f59e0b';
  if (d <= 90)  return '#60a5fa';
  return 'var(--text-3)';
}

// ── Config ───────────────────────────────────────────────────────────────────

const COLUMNS = [
  { key: 'rank',         label: '#',        width: 40  },
  { key: 'platform',     label: 'Platform', width: 100 },
  { key: 'title',        label: 'Market',   width: null },
  { key: 'bestSide',     label: 'Side',     width: 60  },
  { key: 'currentPrice', label: 'Price',    width: 65  },
  { key: 'bestEV',       label: 'EV',       width: 70  },
  { key: 'confidence',   label: 'Conf.',    width: 70  },
  { key: 'riskScore',    label: 'Risk',     width: 70  },
  { key: 'finalScore',   label: 'Score',    width: 90  },
  { key: 'closes',       label: 'Closes',   width: 72  },
  { key: 'category',     label: 'Category', width: 90  },
];

const CATEGORIES = ['All','Politics','Economics','Crypto','Geopolitics','Sports','Tech','Energy','General'];
const RISK_OPTS  = ['All','Low','Medium','High'];
const SENT_OPTS  = ['All','Bullish','Bearish','Neutral'];
const SIDE_OPTS  = ['All','YES','NO'];
const DAYS_OPTS  = [
  { label: 'Any',       value: 0    },
  { label: '< 7 days',  value: 7    },
  { label: '< 30 days', value: 30   },
  { label: '< 90 days', value: 90   },
  { label: '< 1 year',  value: 365  },
];

const FILTER_DEFAULTS = {
  category: 'All', risk: 'All', sentiment: 'All', side: 'All',
  minEV: 0, topOnly: false, maxDays: 0,
};

// ── Component ────────────────────────────────────────────────────────────────

export default function AllPredictions({ predictions, loading, onSelect }) {
  const [sortKey, setSortKey]         = useState('closes');
  const [sortDir, setSortDir]         = useState('asc');
  const [page, setPage]               = useState(0);
  const [filters, setFilters]         = useState(FILTER_DEFAULTS);
  const [showFilters, setShowFilters] = useState(false);
  const PAGE_SIZE = 30;

  const setFilter = (key, val) => { setFilters(f => ({ ...f, [key]: val })); setPage(0); };
  const clearFilters = () => { setFilters(FILTER_DEFAULTS); setPage(0); };
  const activeFilterCount = Object.entries(filters).filter(([k, v]) => v !== FILTER_DEFAULTS[k]).length;

  const filtered = useMemo(() => {
    return predictions.filter(p => {
      if (filters.category  !== 'All' && p.category      !== filters.category)   return false;
      if (filters.risk      !== 'All' && p.riskLabel     !== filters.risk)        return false;
      if (filters.sentiment !== 'All' && p.sentimentLabel !== filters.sentiment)  return false;
      if (filters.side      !== 'All' && p.bestSide      !== filters.side)        return false;
      if (filters.topOnly   && !p.isTopPick)                                      return false;
      if (p.bestEV * 100 < filters.minEV)                                         return false;
      if (filters.maxDays > 0 && daysUntil(p.closes) > filters.maxDays)          return false;
      return true;
    });
  }, [predictions, filters]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      // Special case: sort 'closes' by actual date, not string
      if (sortKey === 'closes') {
        const da = a.closes ? new Date(a.closes).getTime() : Infinity;
        const db = b.closes ? new Date(b.closes).getTime() : Infinity;
        return sortDir === 'asc' ? da - db : db - da;
      }
      let va = a[sortKey], vb = b[sortKey];
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ?  1 : -1;
      return 0;
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  const paged     = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const pageCount = Math.ceil(sorted.length / PAGE_SIZE);

  const handleSort = key => {
    if (key === sortKey) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      // Default: 'closes' sorts ascending (soonest first), everything else desc
      setSortDir(key === 'closes' ? 'asc' : 'desc');
    }
    setPage(0);
  };

  // ── Closing-soon shortcut ─────────────────────────────────────────────────
  const closingSoonActive = filters.maxDays === 30;
  const toggleClosingSoon = () => {
    if (closingSoonActive) {
      setFilter('maxDays', 0);
    } else {
      setFilter('maxDays', 30);
      // Auto-sort by closes ascending when the chip is activated
      setSortKey('closes');
      setSortDir('asc');
      setPage(0);
    }
  };

  if (loading) {
    return (
      <div>
        <div style={{ height: 36, background: 'var(--bg-card)', borderRadius: 8, marginBottom: 8 }} className="skeleton" />
        <div className="table-wrap">
          <table>
            <thead><tr>{COLUMNS.map(c => <th key={c.key}>{c.label}</th>)}</tr></thead>
            <tbody>
              {Array.from({ length: 8 }).map((_, i) => (
                <tr key={i}>{COLUMNS.map(c => (
                  <td key={c.key}><div className="skeleton" style={{ height: 12, width: '80%' }} /></td>
                ))}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (predictions.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-3)' }}>
        No markets found. Run a refresh to load data.
      </div>
    );
  }

  return (
    <div>
      {/* ── Filter bar ────────────────────────────────────────────────── */}
      <div style={{ marginBottom: '.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', flexWrap: 'wrap' }}>
          <button
            onClick={() => setShowFilters(f => !f)}
            style={{
              background: showFilters ? 'var(--blue2)' : 'var(--bg-card)',
              color: showFilters ? '#fff' : 'var(--text-2)',
              border: '1px solid var(--border)', borderRadius: 6,
              padding: '.3rem .75rem', fontSize: '.75rem', fontWeight: 600, cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: '.4rem',
            }}
          >
            ⚙ Filters {activeFilterCount > 0 && (
              <span style={{ background: 'var(--blue)', color: '#fff', borderRadius: 99, padding: '0 .4rem', fontSize: '.65rem' }}>
                {activeFilterCount}
              </span>
            )}
          </button>

          {/* Quick-filter chips */}
          {[
            { label: '🔥 Top Picks',     fn: () => setFilter('topOnly', !filters.topOnly),                    active: filters.topOnly },
            { label: '📈 Positive EV',   fn: () => setFilter('minEV', filters.minEV > 0 ? 0 : 3),             active: filters.minEV > 0 },
            { label: '🟢 Low Risk',      fn: () => setFilter('risk', filters.risk === 'Low' ? 'All' : 'Low'),  active: filters.risk === 'Low' },
            { label: '↑ Bullish',        fn: () => setFilter('sentiment', filters.sentiment === 'Bullish' ? 'All' : 'Bullish'), active: filters.sentiment === 'Bullish' },
            { label: '⏰ Closing Soon',  fn: toggleClosingSoon, active: closingSoonActive },
          ].map(chip => (
            <button key={chip.label} onClick={chip.fn} style={{
              padding: '.28rem .65rem', borderRadius: 99, fontSize: '.72rem', fontWeight: 600,
              cursor: 'pointer',
              background: chip.active ? 'rgba(59,130,246,.2)'  : 'var(--bg-card)',
              color:      chip.active ? 'var(--blue)'          : 'var(--text-3)',
              border: `1px solid ${chip.active ? 'rgba(59,130,246,.4)' : 'var(--border)'}`,
            }}>{chip.label}</button>
          ))}

          <span style={{ marginLeft: 'auto', fontSize: '.73rem', color: 'var(--text-3)' }}>
            {filtered.length} of {predictions.length} markets
          </span>
          {activeFilterCount > 0 && (
            <button onClick={clearFilters} style={{
              fontSize: '.7rem', color: 'var(--text-3)', background: 'none',
              border: 'none', cursor: 'pointer', textDecoration: 'underline',
            }}>
              Clear
            </button>
          )}
        </div>

        {/* Expanded filter panel */}
        {showFilters && (
          <div style={{
            marginTop: '.6rem', padding: '.75rem 1rem',
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: 8, display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end',
          }}>
            <FilterSelect label="Category"  value={filters.category}  opts={CATEGORIES} onChange={v => setFilter('category', v)} />
            <FilterSelect label="Risk"      value={filters.risk}      opts={RISK_OPTS}  onChange={v => setFilter('risk', v)} />
            <FilterSelect label="Sentiment" value={filters.sentiment} opts={SENT_OPTS}  onChange={v => setFilter('sentiment', v)} />
            <FilterSelect label="Side"      value={filters.side}      opts={SIDE_OPTS}  onChange={v => setFilter('side', v)} />
            <div>
              <div style={{ fontSize: '.65rem', color: 'var(--text-3)', marginBottom: '.25rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>
                Closes within
              </div>
              <select
                value={filters.maxDays}
                onChange={e => setFilter('maxDays', Number(e.target.value))}
                style={{
                  background: 'var(--bg-surface)', border: '1px solid var(--border)',
                  color: 'var(--text-1)', borderRadius: 6, padding: '.3rem .5rem',
                  fontSize: '.78rem', cursor: 'pointer',
                }}
              >
                {DAYS_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize: '.65rem', color: 'var(--text-3)', marginBottom: '.25rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>
                Min EV (¢)
              </div>
              <input
                type="number" min={-20} max={30} step={1}
                value={filters.minEV}
                onChange={e => setFilter('minEV', Number(e.target.value))}
                style={{
                  background: 'var(--bg-surface)', border: '1px solid var(--border)',
                  color: 'var(--text-1)', borderRadius: 6, padding: '.3rem .5rem',
                  width: 70, fontSize: '.78rem',
                }}
              />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '.4rem', fontSize: '.78rem', color: 'var(--text-2)', cursor: 'pointer' }}>
              <input type="checkbox" checked={filters.topOnly} onChange={e => setFilter('topOnly', e.target.checked)} />
              Top picks only
            </label>
          </div>
        )}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {COLUMNS.map(col => (
                <th
                  key={col.key}
                  className={sortKey === col.key ? 'sorted' : ''}
                  style={col.width ? { width: col.width } : {}}
                  onClick={() => handleSort(col.key)}
                >
                  {col.label}
                  <span className="sort-icon">
                    {sortKey === col.key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕'}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paged.map(p => <PredRow key={p.id} p={p} onSelect={onSelect} />)}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pageCount > 1 && (
        <div style={{ display: 'flex', gap: '.4rem', justifyContent: 'center', marginTop: '.75rem', flexWrap: 'wrap' }}>
          {Array.from({ length: pageCount }).map((_, i) => (
            <button
              key={i}
              onClick={() => setPage(i)}
              style={{
                padding: '.25rem .6rem', borderRadius: 4,
                background: page === i ? 'var(--blue2)' : 'var(--bg-card)',
                color:      page === i ? '#fff'         : 'var(--text-2)',
                border: '1px solid var(--border)', fontSize: '.75rem', cursor: 'pointer',
              }}
            >
              {i + 1}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Filter select helper
// ─────────────────────────────────────────────────────────────────────────────
function FilterSelect({ label, value, opts, onChange }) {
  return (
    <div>
      <div style={{ fontSize: '.65rem', color: 'var(--text-3)', marginBottom: '.25rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>
        {label}
      </div>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          background: 'var(--bg-surface)', border: '1px solid var(--border)',
          color: 'var(--text-1)', borderRadius: 6, padding: '.3rem .5rem',
          fontSize: '.78rem', cursor: 'pointer',
        }}
      >
        {opts.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual table row
// ─────────────────────────────────────────────────────────────────────────────
function PredRow({ p, onSelect }) {
  const platformColors = {
    Kalshi:     '#60a5fa',
    Polymarket: '#c084fc',
    PredictIt:  '#fbbf24',
  };

  const scoreColor = p.finalScore >= 0.6 ? '#22c55e' : p.finalScore >= 0.4 ? '#f59e0b' : '#94a3b8';
  const evColor    = p.bestEV >= 0.05 ? '#22c55e' : p.bestEV > 0 ? '#f59e0b' : '#ef4444';
  const riskColor  = p.riskScore <= 0.35 ? '#22c55e' : p.riskScore <= 0.65 ? '#f59e0b' : '#ef4444';
  const confColor  = p.confidence >= 0.6 ? '#22c55e' : p.confidence >= 0.3 ? '#f59e0b' : '#94a3b8';

  return (
    <tr
      className={`clickable-row${p.isTopPick ? ' top-pick-row' : ''}`}
      onClick={() => onSelect && onSelect(p)}
      title="Click for full AI analysis"
    >
      {/* Rank */}
      <td style={{ color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
        {p.isTopPick ? '🔥' : p.rank}
      </td>

      {/* Platform */}
      <td>
        <span style={{ color: platformColors[p.platform] || 'var(--text-2)', fontWeight: 600, fontSize: '.74rem' }}>
          {p.platform}
        </span>
      </td>

      {/* Title */}
      <td className="td-title">
        <a href={p.url} target="_blank" rel="noopener noreferrer"
           style={{ color: 'var(--text-1)' }} title={p.title}>
          {p.title}
        </a>
      </td>

      {/* Side */}
      <td>
        <span style={{ fontWeight: 700, color: p.bestSide === 'YES' ? '#22c55e' : '#ef4444' }}>
          {p.bestSide}
        </span>
      </td>

      {/* Price */}
      <td style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-2)' }}>
        {(p.currentPrice * 100).toFixed(0)}¢
      </td>

      {/* EV */}
      <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: evColor }}>
        {p.bestEV >= 0 ? '+' : ''}{(p.bestEV * 100).toFixed(1)}¢
      </td>

      {/* Confidence */}
      <td style={{ color: confColor, fontFamily: 'var(--font-mono)' }}>
        {(p.confidence * 100).toFixed(0)}%
      </td>

      {/* Risk */}
      <td>
        <span style={{ color: riskColor, fontWeight: 600, fontSize: '.76rem' }}>
          {p.riskLabel}
        </span>
      </td>

      {/* Score bar */}
      <td>
        <div className="score-bar-inline">
          <div className="score-bar-track">
            <div
              className="score-bar-fill"
              style={{ width: `${(p.finalScore * 100).toFixed(0)}%`, background: scoreColor }}
            />
          </div>
          <span style={{ fontFamily: 'var(--font-mono)', color: scoreColor, fontSize: '.75rem', fontWeight: 700 }}>
            {(p.finalScore * 100).toFixed(0)}
          </span>
        </div>
      </td>

      {/* Closes */}
      <td style={{ fontFamily: 'var(--font-mono)', fontSize: '.73rem', color: expiryColor(p.closes), fontWeight: 600 }}
          title={p.closes ? new Date(p.closes).toLocaleDateString() : 'Unknown'}>
        {fmtExpiry(p.closes)}
      </td>

      {/* Category */}
      <td style={{ color: 'var(--text-3)', fontSize: '.73rem' }}>{p.category}</td>
    </tr>
  );
}
