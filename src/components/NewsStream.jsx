import { useState, useMemo } from 'react';

const CATEGORIES = ['All', 'Politics', 'Economics', 'Crypto', 'Geopolitics', 'Sports', 'Tech', 'Markets', 'General'];

function timeAgo(isoStr) {
  const diff = Date.now() - new Date(isoStr);
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function sentimentIcon(score) {
  if (score >  0.1) return { icon: '↑', cls: 'sentiment-bull' };
  if (score < -0.1) return { icon: '↓', cls: 'sentiment-bear' };
  return { icon: '→', cls: 'sentiment-neut' };
}

export default function NewsStream({ articles }) {
  const [activeFilter, setActiveFilter] = useState('All');
  const [searchTerm, setSearchTerm]     = useState('');

  const filtered = useMemo(() => {
    let list = articles;
    if (activeFilter !== 'All') list = list.filter(a => a.category === activeFilter);
    if (searchTerm.trim()) {
      const q = searchTerm.toLowerCase();
      list = list.filter(a =>
        a.title.toLowerCase().includes(q) ||
        a.source.toLowerCase().includes(q)
      );
    }
    return list.slice(0, 200);
  }, [articles, activeFilter, searchTerm]);

  const categoryCounts = useMemo(() => {
    const counts = {};
    for (const a of articles) counts[a.category] = (counts[a.category] || 0) + 1;
    return counts;
  }, [articles]);

  return (
    <aside className="news-sidebar">
      {/* Header */}
      <div className="news-sidebar-header">
        <span>📰 Live News Feed</span>
        <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>{articles.length} articles</span>
      </div>

      {/* Search */}
      <div style={{ padding: '.5rem .9rem', borderBottom: '1px solid var(--border)' }}>
        <input
          type="text"
          placeholder="Search news…"
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          style={{
            width: '100%',
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '.35rem .7rem',
            color: 'var(--text-1)',
            fontSize: '.78rem',
            outline: 'none',
          }}
        />
      </div>

      {/* Category filters */}
      <div className="news-filter-row">
        {CATEGORIES.filter(c => c === 'All' || categoryCounts[c]).map(cat => (
          <button
            key={cat}
            className={`filter-chip ${activeFilter === cat ? 'active' : ''}`}
            onClick={() => setActiveFilter(cat)}
          >
            {cat}
            {cat !== 'All' && categoryCounts[cat] && (
              <span style={{ marginLeft: '.25rem', opacity: .6 }}>({categoryCounts[cat]})</span>
            )}
          </button>
        ))}
      </div>

      {/* Article list */}
      <div className="news-list">
        {filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-3)', fontSize: '.8rem' }}>
            {articles.length === 0 ? 'Loading news…' : 'No articles match your filter.'}
          </div>
        ) : (
          filtered.map((article, i) => {
            const { icon, cls } = sentimentIcon(article.sentiment || 0);
            return (
              <div key={article.id || i} className="news-item">
                <div className="news-item-source">
                  <span>{article.source}</span>
                  <span>{timeAgo(article.publishedAt)}</span>
                </div>
                <div className="news-item-title">
                  <a href={article.url} target="_blank" rel="noopener noreferrer"
                     style={{ color: 'inherit', textDecoration: 'none' }}>
                    {article.title}
                  </a>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}>
                  <span className={`news-item-sentiment ${cls}`}>{icon}</span>
                  <span style={{ fontSize: '.63rem', color: 'var(--text-3)' }}>
                    {article.category}
                    {article.type === 'reddit' && ' · Reddit'}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
