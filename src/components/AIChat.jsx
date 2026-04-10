/**
 * AIChat.jsx — Floating chat panel, bottom-right corner
 *
 * Stateless — each question is independent. No conversation history.
 */

import { useState, useRef, useEffect } from 'react';

export default function AIChat() {
  const [open,     setOpen]     = useState(false);
  const [messages, setMessages] = useState([]);
  const [input,    setInput]    = useState('');
  const [loading,  setLoading]  = useState(false);
  const bottomRef = useRef(null);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, open]);

  const handleSend = async () => {
    const q = input.trim();
    if (!q || loading) return;

    setMessages(prev => [...prev, { role: 'user', text: q }]);
    setInput('');
    setLoading(true);

    try {
      const res  = await fetch('/api/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ question: q }),
      });
      const data = await res.json();
      const answer = data.answer || data.error || 'No response.';
      setMessages(prev => [...prev, { role: 'ai', text: answer }]);
    } catch {
      setMessages(prev => [...prev, { role: 'ai', text: 'Request failed. Is the server running?', error: true }]);
    } finally {
      setLoading(false);
    }
  };

  const handleKey = e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  return (
    <>
      {/* Floating toggle button */}
      <button
        onClick={() => setOpen(o => !o)}
        title="Ask the AI"
        style={{
          position:     'fixed',
          bottom:       '1.5rem',
          right:        '1.5rem',
          zIndex:       1000,
          width:        48,
          height:       48,
          borderRadius: '50%',
          background:   'linear-gradient(135deg, #6366f1, #a855f7)',
          border:       'none',
          cursor:       'pointer',
          fontSize:     '1.2rem',
          boxShadow:    '0 4px 20px rgba(99,102,241,.45)',
          display:      'flex',
          alignItems:   'center',
          justifyContent: 'center',
          transition:   'transform .15s',
        }}
        onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.08)'}
        onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
      >
        {open ? '✕' : '🤖'}
      </button>

      {/* Chat panel */}
      {open && (
        <div style={{
          position:     'fixed',
          bottom:       '5rem',
          right:        '1.5rem',
          zIndex:       999,
          width:        340,
          maxHeight:    460,
          background:   'var(--bg-card)',
          border:       '1px solid rgba(139,92,246,.35)',
          borderRadius: 14,
          boxShadow:    '0 8px 40px rgba(0,0,0,.5)',
          display:      'flex',
          flexDirection: 'column',
          overflow:     'hidden',
        }}>
          {/* Panel header */}
          <div style={{
            padding:       '.75rem 1rem',
            borderBottom:  '1px solid var(--border)',
            background:    'linear-gradient(135deg, rgba(99,102,241,.15), rgba(168,85,247,.1))',
            display:       'flex',
            alignItems:    'center',
            gap:           '.5rem',
          }}>
            <span style={{ fontSize: '.8rem', fontWeight: 700, color: '#a78bfa' }}>🤖 Ask AI</span>
            <span style={{ fontSize: '.67rem', color: 'var(--text-3)', marginLeft: 'auto' }}>Powered by Claude</span>
          </div>

          {/* Messages */}
          <div style={{
            flex:       1,
            overflowY:  'auto',
            padding:    '.75rem',
            display:    'flex',
            flexDirection: 'column',
            gap:        '.6rem',
          }}>
            {messages.length === 0 && (
              <div style={{ textAlign: 'center', padding: '1.5rem .5rem' }}>
                <div style={{ fontSize: '1.5rem', marginBottom: '.4rem' }}>🔮</div>
                <div style={{ fontSize: '.75rem', color: 'var(--text-3)', lineHeight: 1.5 }}>
                  Ask about today's top picks, market trends, or specific opportunities.
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} style={{
                alignSelf:   m.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth:    '85%',
                padding:     '.5rem .75rem',
                borderRadius: m.role === 'user' ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
                background:  m.role === 'user'
                  ? 'linear-gradient(135deg, #6366f1, #a855f7)'
                  : m.error
                  ? 'rgba(239,68,68,.12)'
                  : 'var(--bg-surface)',
                border:      m.role === 'ai' ? '1px solid var(--border)' : 'none',
                fontSize:    '.78rem',
                color:       m.role === 'user' ? '#fff' : m.error ? '#fca5a5' : 'var(--text-1)',
                lineHeight:  1.55,
              }}>
                {m.text}
              </div>
            ))}

            {loading && (
              <div style={{
                alignSelf:   'flex-start',
                padding:     '.5rem .75rem',
                borderRadius: '12px 12px 12px 4px',
                background:  'var(--bg-surface)',
                border:      '1px solid var(--border)',
                fontSize:    '.78rem',
                color:       'var(--text-3)',
              }}>
                Thinking…
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div style={{
            padding:       '.6rem .75rem',
            borderTop:     '1px solid var(--border)',
            display:       'flex',
            gap:           '.4rem',
            alignItems:    'flex-end',
          }}>
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Ask about markets, trends…"
              rows={1}
              disabled={loading}
              style={{
                flex:        1,
                resize:      'none',
                background:  'var(--bg-surface)',
                border:      '1px solid var(--border)',
                borderRadius: 8,
                padding:     '.45rem .65rem',
                color:       'var(--text-1)',
                fontSize:    '.78rem',
                fontFamily:  'inherit',
                lineHeight:  1.4,
                outline:     'none',
              }}
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || loading}
              style={{
                background:   loading || !input.trim() ? 'rgba(99,102,241,.3)' : 'linear-gradient(135deg, #6366f1, #a855f7)',
                border:       'none',
                borderRadius: 8,
                color:        '#fff',
                padding:      '.45rem .65rem',
                cursor:       loading || !input.trim() ? 'not-allowed' : 'pointer',
                fontSize:     '.78rem',
                fontWeight:   700,
                flexShrink:   0,
              }}
            >
              {loading ? '…' : '↑'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
