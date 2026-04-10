/**
 * PredictionDetail.jsx — slide-in drawer showing full AI analysis for a prediction.
 *
 * Sections:
 *   1. Header         — market title, platform, close button
 *   2. Verdict        — the agent's clear recommendation + EV
 *   3. Why Take It    — plain-English case for the bet
 *   4. Signal Fusion  — visual breakdown of all probability sources
 *   5. Evidence       — news articles the agent used, with sentiment arrows
 *   6. Live Data      — economic indicators (BTC price, CPI, etc.)
 *   7. Cross-Ref      — Metaculus / Manifold community forecast
 *   8. Risk Factors   — what could go wrong
 *   9. Full Reasoning — raw agent reasoning text
 */

import { useEffect, useState } from 'react';

// ── helpers ──────────────────────────────────────────────────────────────────
function bold(text) {
  if (!text) return null;
  const parts = text.split(/\*\*(.*?)\*\*/g);
  return parts.map((p, i) => i % 2 === 1 ? <strong key={i}>{p}</strong> : p);
}

function timeAgo(iso) {
  if (!iso) return '';
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const PLATFORM_COLOR = { Kalshi: '#60a5fa', Polymarket: '#c084fc', PredictIt: '#fbbf24' };
const SIGNAL_COLOR   = label => {
  if (label === 'Market price')      return '#5a7a99';
  if (label === 'Sentiment-adjusted') return '#3b82f6';
  if (label === 'Metaculus' || label === 'Manifold') return '#a855f7';
  if (label === 'Economic data')     return '#f59e0b';
  return '#5a7a99';
};

// ── Why-take-it generator ─────────────────────────────────────────────────────
function generateWhyTakeIt(p) {
  const pct   = Math.round(p.currentPrice * 100);
  const est   = Math.round(p.estimatedProbability * 100);
  const ev    = Math.round(p.bestEV * 100);
  const edge  = Math.abs(est - pct);
  const side  = p.bestSide;
  const lines = [];

  // EV angle
  if (p.bestEV >= 0.05) {
    lines.push(`The market is pricing ${side} at ${pct}¢, but the agent's multi-source model estimates the true probability at ~${est}%. That ${edge}-point gap translates to **+${ev}¢ of expected value per $1 wagered** — a meaningful edge if the signal holds.`);
  } else {
    lines.push(`The agent sees a small ${edge}-point gap between the market price (${pct}¢) and its estimated probability (~${est}%). The expected value is thin (+${ev}¢), so position size should be modest.`);
  }

  // Source quality angle
  if (p.signalCount >= 3) {
    const crossName = p.crossRef?.source || 'a second market';
    lines.push(`This pick is supported by **${p.signalCount} independent signals** — market price, news sentiment, and ${crossName} community forecast — which all point in the same direction. Multi-source agreement is the strongest quality signal in the model.`);
  } else if (p.relevantCount >= 5) {
    lines.push(`News coverage is strong with **${p.relevantCount} relevant articles** found. High coverage means the sentiment score is reliable rather than noise.`);
  }

  // Cross-ref angle
  if (p.crossRef) {
    const xPct = Math.round(p.crossRef.probability * 100);
    const gap  = Math.abs(xPct - pct);
    if (gap >= 8) {
      lines.push(`**${p.crossRef.source}** — which aggregates expert forecasters — has this at ${xPct}%, a **${gap}% divergence from the market**. When superforecaster consensus diverges from a market price, it historically indicates mispricing.`);
    }
  }

  // Economic data angle
  if (p.economicContext?.length) {
    const d = p.economicContext[0];
    lines.push(`Live economic data (${d.indicator} = ${d.value}, trending ${d.trend}) directly informs this market's subject, giving the model a factual anchor beyond news sentiment alone.`);
  }

  // Risk caveat
  if (p.riskScore > 0.6) {
    lines.push(`⚠️ **Risk is elevated** (${Math.round(p.riskScore * 100)}/100) — likely due to low liquidity, a wide spread, or a fast-approaching close date. Keep position size small.`);
  } else if (p.riskScore < 0.35) {
    lines.push(`✅ **Risk is low** — this market has strong liquidity, a tight spread, and sufficient time to resolution.`);
  }

  return lines;
}

// ── Risk breakdown ────────────────────────────────────────────────────────────
function RiskItem({ label, value, invert = false }) {
  // invert = high value is GOOD (e.g. liquidity)
  const pct   = Math.round(value * 100);
  const color = invert
    ? (value > 0.6 ? '#22c55e' : value > 0.3 ? '#f59e0b' : '#ef4444')
    : (value < 0.35 ? '#22c55e' : value < 0.60 ? '#f59e0b' : '#ef4444');
  return (
    <div style={{ marginBottom: '.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.73rem', marginBottom: '.2rem' }}>
        <span style={{ color: 'var(--text-2)' }}>{label}</span>
        <span style={{ color, fontWeight: 700 }}>{invert ? (value > 0.6 ? 'High' : value > 0.3 ? 'Medium' : 'Low') : (value < 0.35 ? 'Low' : value < 0.60 ? 'Medium' : 'High')}</span>
      </div>
      <div style={{ height: 5, background: 'var(--bg-surface)', borderRadius: 99, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 99 }} />
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function PredictionDetail({ prediction: p, onClose }) {
  // Close on Escape key
  useEffect(() => {
    const handler = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  if (!p) return null;

  const platColor  = PLATFORM_COLOR[p.platform] || '#94a3b8';
  const sideColor  = p.bestSide === 'YES' ? '#22c55e' : '#ef4444';
  const evPositive = p.bestEV >= 0;
  const whyLines   = generateWhyTakeIt(p);

  return (
    <>
      {/* Backdrop */}
      <div className="drawer-backdrop" onClick={onClose} />

      {/* Drawer panel */}
      <div className="drawer-panel">
        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="drawer-header">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', marginBottom: '.35rem' }}>
              <span style={{ color: platColor, fontWeight: 700, fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>
                {p.platform}
              </span>
              <span style={{ color: 'var(--text-3)', fontSize: '.7rem' }}>·</span>
              <span style={{ color: 'var(--text-3)', fontSize: '.7rem' }}>{p.category}</span>
              {p.closes && (
                <>
                  <span style={{ color: 'var(--text-3)', fontSize: '.7rem' }}>·</span>
                  <span style={{ color: 'var(--text-3)', fontSize: '.7rem' }}>Closes {fmtDate(p.closes)}</span>
                </>
              )}
            </div>
            <h2 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-1)', lineHeight: 1.35 }}>
              {p.title}
            </h2>
          </div>
          <button className="drawer-close" onClick={onClose} title="Close (Esc)">✕</button>
        </div>

        <div className="drawer-body">
          {/* ── Verdict card ─────────────────────────────────────────────── */}
          <div className="drawer-verdict">
            <div className="verdict-side">
              <div style={{ fontSize: '.68rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: '.2rem' }}>Agent Recommendation</div>
              <div style={{ fontSize: '1.6rem', fontWeight: 900, color: sideColor, letterSpacing: '.05em' }}>
                BET {p.bestSide}
              </div>
              <div style={{ fontSize: '.78rem', color: 'var(--text-2)', marginTop: '.15rem' }}>
                at <strong style={{ color: 'var(--text-1)' }}>{Math.round(p.currentPrice * 100)}¢</strong>
              </div>
            </div>

            <div className="verdict-divider" />

            <div className="verdict-stats">
              <StatBox label="Est. Probability" value={`${Math.round(p.estimatedProbability * 100)}%`} color="var(--text-1)" />
              <StatBox label="Expected Value" value={`${p.bestEV >= 0 ? '+' : ''}${Math.round(p.bestEV * 100)}¢`} color={evPositive ? '#22c55e' : '#ef4444'} />
              <StatBox label="Confidence" value={`${Math.round(p.confidence * 100)}%`} color={p.confidence >= 0.6 ? '#22c55e' : p.confidence >= 0.3 ? '#f59e0b' : '#94a3b8'} />
              <StatBox label="Risk" value={p.riskLabel} color={p.riskScore < 0.35 ? '#22c55e' : p.riskScore < 0.60 ? '#f59e0b' : '#ef4444'} />
            </div>

            <div className="verdict-divider" />

            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '.3rem', minWidth: 80, textAlign: 'center' }}>
              <div style={{ fontSize: '.65rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em' }}>Agent Score</div>
              <div style={{ fontSize: '2rem', fontWeight: 900, color: p.finalScore >= 0.6 ? '#22c55e' : p.finalScore >= 0.4 ? '#f59e0b' : '#94a3b8', lineHeight: 1 }}>
                {Math.round(p.finalScore * 100)}
              </div>
              <div style={{ fontSize: '.62rem', color: 'var(--text-3)' }}>/ 100</div>
            </div>
          </div>

          {/* ── Why take it ──────────────────────────────────────────────── */}
          <Section title="🎯 Why Take This Bet">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '.65rem' }}>
              {whyLines.map((line, i) => (
                <p key={i} style={{ fontSize: '.82rem', color: 'var(--text-2)', lineHeight: 1.6, margin: 0 }}>
                  {bold(line)}
                </p>
              ))}
            </div>
          </Section>

          {/* ── Signal fusion ─────────────────────────────────────────────── */}
          {p.signals && p.signals.length > 0 && (
            <Section title="📡 Probability Signal Fusion">
              <p style={{ fontSize: '.76rem', color: 'var(--text-3)', marginBottom: '.75rem', lineHeight: 1.5 }}>
                The agent combines up to 4 independent probability sources. When multiple sources agree, confidence rises. The weighted average becomes the estimated probability used for EV calculation.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '.5rem' }}>
                {p.signals.map((s, i) => {
                  const prob = Math.round(s.prob * 100);
                  const col  = SIGNAL_COLOR(s.label);
                  return (
                    <div key={i} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '.6rem .8rem' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '.3rem' }}>
                        <span style={{ fontSize: '.75rem', fontWeight: 700, color: col }}>{s.label}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
                          <span style={{ fontSize: '.7rem', color: 'var(--text-3)' }}>weight {Math.round(s.weight * 100)}%</span>
                          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: col, fontSize: '.85rem' }}>{prob}%</span>
                        </div>
                      </div>
                      <div style={{ height: 6, background: 'var(--bg-card)', borderRadius: 99, overflow: 'hidden' }}>
                        <div style={{ width: `${prob}%`, height: '100%', background: col, borderRadius: 99, transition: 'width .4s ease' }} />
                      </div>
                    </div>
                  );
                })}
              </div>
              <div style={{ marginTop: '.75rem', padding: '.5rem .75rem', background: 'rgba(34,197,94,.07)', border: '1px solid rgba(34,197,94,.2)', borderRadius: 7, fontSize: '.75rem', color: 'var(--text-2)' }}>
                → Weighted estimate: <strong style={{ color: '#22c55e' }}>{Math.round(p.estimatedProbability * 100)}%</strong>
                {' '}vs market price of <strong style={{ color: 'var(--text-1)' }}>{Math.round(p.currentPrice * 100)}¢</strong>
                {' '}= <strong style={{ color: p.bestEV >= 0 ? '#22c55e' : '#ef4444' }}>{p.bestEV >= 0 ? '+' : ''}{Math.round(p.bestEV * 100)}¢ EV</strong>
              </div>
            </Section>
          )}

          {/* ── Claude AI analysis ───────────────────────────────────────── */}
          {p.aiAnalysis && (
            <Section title="🤖 Claude AI Analysis">
              {/* Confidence bar */}
              <div style={{ marginBottom: '.75rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.72rem', marginBottom: '.25rem' }}>
                  <span style={{ color: 'var(--text-3)' }}>AI Confidence</span>
                  <span style={{ fontWeight: 700, color: p.aiAnalysis.confidence >= 0.65 ? '#22c55e' : p.aiAnalysis.confidence >= 0.4 ? '#f59e0b' : '#94a3b8', fontFamily: 'var(--font-mono)' }}>
                    {Math.round(p.aiAnalysis.confidence * 100)}%
                  </span>
                </div>
                <div style={{ height: 6, background: 'var(--bg-surface)', borderRadius: 99, overflow: 'hidden' }}>
                  <div style={{
                    width:      `${Math.round(p.aiAnalysis.confidence * 100)}%`,
                    height:     '100%',
                    background: p.aiAnalysis.confidence >= 0.65 ? '#22c55e' : p.aiAnalysis.confidence >= 0.4 ? '#f59e0b' : '#94a3b8',
                    borderRadius: 99,
                    transition: 'width .4s ease',
                  }} />
                </div>
              </div>

              {/* Key factors */}
              {p.aiAnalysis.keyFactors && p.aiAnalysis.keyFactors.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '.35rem', marginBottom: '.75rem' }}>
                  {p.aiAnalysis.keyFactors.map((f, i) => {
                    const col  = f.direction === 'up' ? '#22c55e' : f.direction === 'down' ? '#ef4444' : '#f59e0b';
                    const icon = f.direction === 'up' ? '↑' : f.direction === 'down' ? '↓' : '⚠';
                    return (
                      <div key={i} style={{ display: 'flex', gap: '.5rem', alignItems: 'flex-start', background: `${col}0d`, border: `1px solid ${col}25`, borderRadius: 7, padding: '.45rem .65rem' }}>
                        <span style={{ color: col, fontWeight: 700, flexShrink: 0, fontSize: '.8rem' }}>{icon}</span>
                        <span style={{ fontSize: '.78rem', color: 'var(--text-2)', lineHeight: 1.45 }}>{f.text}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Reasoning */}
              {p.aiAnalysis.reasoning && (
                <div style={{ fontSize: '.8rem', color: 'var(--text-2)', lineHeight: 1.65, background: 'rgba(99,102,241,.07)', border: '1px solid rgba(99,102,241,.2)', borderRadius: 8, padding: '.75rem .9rem', marginBottom: '.6rem' }}>
                  {p.aiAnalysis.reasoning}
                </div>
              )}

              {/* Flags */}
              {p.aiAnalysis.flags && p.aiAnalysis.flags.length > 0 && (
                <div style={{ display: 'flex', gap: '.35rem', flexWrap: 'wrap' }}>
                  {p.aiAnalysis.flags.map((flag, i) => (
                    <span key={i} style={{ fontSize: '.65rem', padding: '.15rem .5rem', borderRadius: 99, background: 'rgba(245,158,11,.1)', color: '#f59e0b', border: '1px solid rgba(245,158,11,.3)', fontWeight: 600 }}>
                      ⚠ {flag.replace(/_/g, ' ')}
                    </span>
                  ))}
                </div>
              )}

              <div style={{ marginTop: '.5rem', fontSize: '.67rem', color: 'var(--text-3)' }}>
                AI estimate: {Math.round(p.aiAnalysis.estimatedProbability * 100)}% · Model: claude-sonnet-4-6
              </div>
            </Section>
          )}

          {/* ── Price history chart ──────────────────────────────────────── */}
          <PriceChart marketId={p.id} bestSide={p.bestSide} />

          {/* ── Metaculus / Manifold cross-ref ───────────────────────────── */}
          {p.crossRef && (
            <Section title={`🔮 ${p.crossRef.source} Community Forecast`}>
              <div style={{ background: 'rgba(168,85,247,.07)', border: '1px solid rgba(168,85,247,.25)', borderRadius: 8, padding: '.75rem 1rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', marginBottom: '.6rem' }}>
                  <div>
                    <div style={{ fontSize: '.72rem', color: '#a855f7', fontWeight: 700, marginBottom: '.2rem' }}>Matched Question</div>
                    <a href={p.crossRef.url} target="_blank" rel="noopener noreferrer"
                       style={{ fontSize: '.8rem', color: 'var(--text-1)', lineHeight: 1.4, display: 'block' }}>
                      {p.crossRef.title}
                    </a>
                  </div>
                  <div style={{ textAlign: 'center', flexShrink: 0 }}>
                    <div style={{ fontSize: '1.5rem', fontWeight: 900, color: '#a855f7' }}>
                      {Math.round(p.crossRef.probability * 100)}%
                    </div>
                    <div style={{ fontSize: '.62rem', color: 'var(--text-3)' }}>community</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                  {p.crossRef.forecasters && (
                    <Tag color="#a855f7">{p.crossRef.forecasters} forecasters</Tag>
                  )}
                  <Tag color="#5a7a99">Match score: {Math.round((p.crossRef.matchScore || 0) * 100)}%</Tag>
                  {Math.abs(Math.round(p.crossRef.probability * 100) - Math.round(p.currentPrice * 100)) >= 5 && (
                    <Tag color="#f59e0b">
                      ⚠ {Math.abs(Math.round(p.crossRef.probability * 100) - Math.round(p.currentPrice * 100))}pt gap vs market
                    </Tag>
                  )}
                </div>
              </div>
            </Section>
          )}

          {/* ── Economic / live data ─────────────────────────────────────── */}
          {p.economicContext && p.economicContext.length > 0 && (
            <Section title="📊 Live Economic Data Used">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '.45rem' }}>
                {p.economicContext.map((d, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 7, padding: '.55rem .8rem' }}>
                    <div>
                      <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: '.1rem' }}>{d.indicator}</div>
                      <div style={{ fontSize: '.85rem', fontWeight: 700, color: 'var(--text-1)', fontFamily: 'var(--font-mono)' }}>{d.value}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '.75rem', fontWeight: 700, color: d.trend === 'rising' ? '#22c55e' : d.trend === 'falling' ? '#ef4444' : '#94a3b8' }}>
                        {d.trend === 'rising' ? '↑ Rising' : d.trend === 'falling' ? '↓ Falling' : '→ Stable'}
                      </div>
                      {d.source && <div style={{ fontSize: '.62rem', color: 'var(--text-3)', marginTop: '.1rem' }}>{d.source}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* ── Evidence: news articles ───────────────────────────────────── */}
          {p.topArticles && p.topArticles.length > 0 && (
            <Section title={`📰 Evidence (${p.relevantCount} relevant article${p.relevantCount !== 1 ? 's' : ''} found)`}>
              <p style={{ fontSize: '.74rem', color: 'var(--text-3)', marginBottom: '.65rem', lineHeight: 1.5 }}>
                Articles are ranked by relevance × source credibility × recency. Tier-1 sources (Reuters, BBC, AP) are weighted up to 1.5×. Articles older than 6 hours decay exponentially.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '.4rem' }}>
                {p.topArticles.map((a, i) => {
                  const sent = a.sentiment || 0;
                  const sentColor = sent > 0.1 ? '#22c55e' : sent < -0.1 ? '#ef4444' : '#94a3b8';
                  const sentLabel = sent > 0.1 ? '↑ Bullish signal' : sent < -0.1 ? '↓ Bearish signal' : '→ Neutral';
                  return (
                    <div key={i} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 7, padding: '.6rem .8rem' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '.75rem' }}>
                        <a href={a.url} target="_blank" rel="noopener noreferrer"
                           style={{ fontSize: '.8rem', color: 'var(--text-1)', lineHeight: 1.4, flex: 1 }}>
                          {a.title}
                        </a>
                        <span style={{ fontSize: '.7rem', fontWeight: 700, color: sentColor, flexShrink: 0, paddingTop: '.1rem' }}>
                          {sentLabel}
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: '.75rem', marginTop: '.3rem', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '.65rem', color: '#a855f7', fontWeight: 600 }}>{a.source}</span>
                        <span style={{ fontSize: '.65rem', color: 'var(--text-3)' }}>{timeAgo(a.publishedAt)}</span>
                        {a.credibility && a.credibility >= 1.3 && (
                          <span style={{ fontSize: '.62rem', color: '#22c55e', background: 'rgba(34,197,94,.1)', padding: '.05rem .35rem', borderRadius: 99 }}>
                            Tier-1 source
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Section>
          )}

          {/* ── Risk factors ─────────────────────────────────────────────── */}
          <Section title="⚠️ Risk Assessment">
            <RiskItem label="Spread risk (house take)"    value={calcSpreadRisk(p.currentPrice, p.bestSide === 'YES' ? 1 - p.currentPrice - 0.05 : p.currentPrice)} />
            <RiskItem label="Liquidity risk"              value={calcLiquidityRisk(p.volume)} />
            <RiskItem label="Time-to-resolution risk"     value={calcTimeRisk(p.closes)} />
            <RiskItem label="Data coverage risk"          value={p.relevantCount < 2 ? 0.8 : Math.max(0.1, 0.6 - p.relevantCount / 20)} />
            <div style={{ marginTop: '.75rem', padding: '.5rem .75rem', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 7, fontSize: '.74rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
              <strong style={{ color: 'var(--text-1)' }}>Overall risk: {p.riskLabel} ({Math.round(p.riskScore * 100)}/100).</strong>
              {' '}{p.riskScore >= 0.65
                ? ' Position size should be kept small. Only bet what you can afford to lose on this pick.'
                : p.riskScore <= 0.35
                ? ' This is a well-structured market with strong liquidity. Standard position sizing applies.'
                : ' Use moderate caution. Consider splitting into a smaller initial position.'}
            </div>
          </Section>

          {/* ── Full agent reasoning ─────────────────────────────────────── */}
          <Section title="🤖 Full Agent Reasoning">
            <div style={{ fontSize: '.8rem', color: 'var(--text-2)', lineHeight: 1.65, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '.85rem 1rem' }}>
              {bold(p.reasoning)}
            </div>
            <div style={{ marginTop: '.6rem', fontSize: '.68rem', color: 'var(--text-3)', lineHeight: 1.5 }}>
              Analysis generated: {p.analyzedAt ? new Date(p.analyzedAt).toLocaleString() : '—'} ·
              Signal count: {p.signalCount || 1} ·
              Market rank: #{p.rank} of all markets
            </div>
          </Section>

          {/* ── Market link ──────────────────────────────────────────────── */}
          <div style={{ marginTop: '1rem' }}>
            <a
              href={p.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '.5rem',
                padding: '.7rem 1rem', borderRadius: 8, fontWeight: 700, fontSize: '.82rem',
                background: sideColor === '#22c55e' ? 'rgba(34,197,94,.15)' : 'rgba(239,68,68,.15)',
                border: `1px solid ${sideColor}55`, color: sideColor,
                textDecoration: 'none', transition: 'all .15s',
              }}
            >
              View this market on {p.platform} ↗
            </a>
          </div>

          <div style={{ height: '2rem' }} />
        </div>
      </div>
    </>
  );
}

// ── Price History Chart ───────────────────────────────────────────────────────
function PriceChart({ marketId, bestSide }) {
  const [history,  setHistory]  = useState([]);
  const [source,   setSource]   = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);

  useEffect(() => {
    if (!marketId) return;
    setLoading(true);
    setError(null);
    fetch(`/api/price-history/${encodeURIComponent(marketId)}`)
      .then(r => r.json())
      .then(data => {
        setSource(data.source);
        // Normalise to [{t, p}] where p is 0-1
        const raw = data.history || [];
        const pts = raw
          .map(d => ({ t: d.t || d.time || d.timestamp, p: d.p != null ? d.p : d.price }))
          .filter(d => d.t && d.p != null && !isNaN(d.p))
          .map(d => ({ t: new Date(typeof d.t === 'number' ? d.t * 1000 : d.t), p: Number(d.p) }))
          .filter(d => !isNaN(d.t.getTime()) && d.p >= 0 && d.p <= 1)
          .sort((a, b) => a.t - b.t);
        setHistory(pts);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [marketId]);

  // Only show for supported platforms
  const supported = marketId?.startsWith('polymarket_') || marketId?.startsWith('predictit_');
  if (!supported) return null;

  if (loading) {
    return (
      <Section title="📈 Price History (7 days)">
        <div style={{ height: 80, background: 'var(--bg-surface)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ color: 'var(--text-3)', fontSize: '.75rem' }}>Loading chart…</span>
        </div>
      </Section>
    );
  }

  if (error || history.length < 2) {
    return (
      <Section title="📈 Price History (7 days)">
        <div style={{ padding: '.6rem .8rem', background: 'var(--bg-surface)', borderRadius: 8, fontSize: '.73rem', color: 'var(--text-3)' }}>
          {history.length < 2 ? 'Not enough price history available for this market.' : `Could not load price history.`}
        </div>
      </Section>
    );
  }

  // SVG sparkline
  const W = 520, H = 90, PAD = { t: 10, r: 12, b: 20, l: 36 };
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;

  const prices = history.map(d => d.p);
  const minP   = Math.max(0,   Math.min(...prices) - 0.03);
  const maxP   = Math.min(1,   Math.max(...prices) + 0.03);
  const range  = maxP - minP || 0.1;
  const minT   = history[0].t.getTime();
  const maxT   = history[history.length - 1].t.getTime();
  const timeRange = maxT - minT || 1;

  const toX = t  => PAD.l + ((t - minT) / timeRange) * innerW;
  const toY = p  => PAD.t + (1 - (p - minP) / range) * innerH;

  const pts = history.map(d => `${toX(d.t.getTime()).toFixed(1)},${toY(d.p).toFixed(1)}`).join(' ');

  const lineColor  = bestSide === 'YES' ? '#22c55e' : '#ef4444';
  const areaColor  = bestSide === 'YES' ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)';
  const first = history[0], last = history[history.length - 1];
  const change = last.p - first.p;
  const changePct = (change * 100).toFixed(1);
  const changeColor = change >= 0 ? '#22c55e' : '#ef4444';
  const changeSign  = change >= 0 ? '+' : '';

  // Y-axis labels
  const yLabels = [minP, (minP + maxP) / 2, maxP].map(v => ({
    y: toY(v).toFixed(1), label: `${Math.round(v * 100)}¢`,
  }));

  // X-axis date labels (first & last)
  const fmtDay = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  // Area path: go to bottom-right, then bottom-left
  const lastPt = history[history.length - 1];
  const firstPt = history[0];
  const areaPath = `M ${toX(firstPt.t.getTime()).toFixed(1)},${toY(firstPt.p).toFixed(1)} L ${pts.replace(/^\S+/, '')} L ${toX(lastPt.t.getTime()).toFixed(1)},${(PAD.t + innerH).toFixed(1)} L ${PAD.l},${(PAD.t + innerH).toFixed(1)} Z`;

  return (
    <Section title="📈 Price History (7 days)">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '.5rem' }}>
        <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
          {source} · {history.length} data points
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '.78rem', fontWeight: 700, color: changeColor }}>
          {changeSign}{changePct}¢ this period
        </div>
      </div>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', padding: '.5rem .25rem .25rem' }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
          {/* Area fill */}
          <path d={areaPath} fill={areaColor} />
          {/* Line */}
          <polyline points={pts} fill="none" stroke={lineColor} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          {/* Last price dot */}
          <circle cx={toX(lastPt.t.getTime())} cy={toY(lastPt.p)} r="4" fill={lineColor} />
          {/* Y-axis labels */}
          {yLabels.map((l, i) => (
            <text key={i} x={PAD.l - 4} y={Number(l.y) + 4} textAnchor="end"
              style={{ fontSize: 9, fill: 'var(--text-3)', fontFamily: 'monospace' }}>
              {l.label}
            </text>
          ))}
          {/* X-axis labels */}
          <text x={PAD.l} y={H - 3} textAnchor="start"
            style={{ fontSize: 9, fill: 'var(--text-3)', fontFamily: 'monospace' }}>
            {fmtDay(firstPt.t)}
          </text>
          <text x={W - PAD.r} y={H - 3} textAnchor="end"
            style={{ fontSize: 9, fill: 'var(--text-3)', fontFamily: 'monospace' }}>
            {fmtDay(lastPt.t)}
          </text>
        </svg>
      </div>
    </Section>
  );
}

// ── Small shared sub-components ───────────────────────────────────────────────
function Section({ title, children }) {
  return (
    <div className="drawer-section">
      <h3 className="drawer-section-title">{title}</h3>
      {children}
    </div>
  );
}

function StatBox({ label, value, color }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: '.62rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: '.2rem' }}>{label}</div>
      <div style={{ fontSize: '1.05rem', fontWeight: 800, color, fontFamily: 'var(--font-mono)' }}>{value}</div>
    </div>
  );
}

function Tag({ color, children }) {
  return (
    <span style={{ fontSize: '.65rem', padding: '.15rem .5rem', borderRadius: 99, background: `${color}18`, color, border: `1px solid ${color}40`, fontWeight: 600 }}>
      {children}
    </span>
  );
}

// Mirror the risk helpers from analyzer.js for client-side display
function calcSpreadRisk(price, noPrice) {
  const spread = Math.max(0, 1 - price - (noPrice || 1 - price));
  return Math.min(spread / 0.30, 1);
}
function calcLiquidityRisk(volume) {
  if (!volume || volume <= 0) return 0.9;
  if (volume > 100000) return 0.05;
  if (volume > 10000)  return 0.2;
  if (volume > 1000)   return 0.45;
  if (volume > 100)    return 0.65;
  return 0.85;
}
function calcTimeRisk(closesAt) {
  if (!closesAt) return 0.5;
  const d = (new Date(closesAt) - Date.now()) / 86400000;
  if (d < 0) return 0.95; if (d < 1) return 0.8; if (d < 7) return 0.5; if (d < 30) return 0.3;
  return 0.15;
}
