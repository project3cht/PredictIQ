/**
 * sentiment.js — Keyword-based news sentiment & relevance scoring
 *
 * v2 enhancements:
 *   • Source credibility weighting  — Reuters headline counts more than a Reddit post
 *   • Recency time-decay            — 6-hour half-life; yesterday's news matters less
 *   • Expanded sentiment lexicon    — 40+ additional domain-specific words
 *   • Expanded topic keyword map    — 8 new topics (Harris, Modi, housing, tariffs…)
 */

// ─────────────────────────────────────────────────────────────────────────────
// Sentiment lexicons
// ─────────────────────────────────────────────────────────────────────────────
const BULLISH_WORDS = new Set([
  // General positive
  'wins', 'win', 'winning', 'won', 'victory', 'victorious', 'beats', 'beat',
  'passes', 'pass', 'passed', 'approves', 'approved', 'approval',
  'rises', 'rise', 'rose', 'gains', 'gain', 'gained', 'surges', 'surge', 'surged',
  'increases', 'increase', 'increased', 'climbs', 'climb', 'climbed',
  'confirms', 'confirmed', 'supports', 'support',
  'likely', 'probable', 'expected', 'exceeds', 'exceed', 'exceeded',
  'outperforms', 'strong', 'stronger', 'strongest', 'record', 'high', 'growth',
  'agrees', 'deal', 'breakthrough', 'success', 'successful',
  'advances', 'advance', 'advanced', 'promotes', 'endorses', 'backed',
  'boosts', 'boost', 'rallies', 'rally', 'rallied', 'positive',
  'optimistic', 'confident', 'reaffirms', 'upholds',
  'clears', 'certifies', 'validates', 'achieves', 'reaches', 'hits',
  // Economic/market positive
  'hawkish', 'tightening', 'holds', 'stabilizes', 'recovers', 'rebound',
  'accelerates', 'expands', 'expansion', 'surplus', 'profit', 'profitable',
  'earnings', 'beat', 'bullish', 'outperform', 'upgrade', 'upgrades',
  // Political positive (for YES side)
  'leads', 'leading', 'ahead', 'frontrunner', 'dominant', 'landslide',
  'signed', 'enacted', 'ratified', 'certified', 'inaugurated',
]);

const BEARISH_WORDS = new Set([
  // General negative
  'loses', 'lose', 'lost', 'defeat', 'defeated', 'fails', 'fail', 'failed',
  'rejects', 'reject', 'rejected', 'falls', 'fall', 'fell', 'drops', 'drop', 'dropped',
  'decreases', 'decrease', 'decreased', 'plunges', 'plunge', 'plunged',
  'denies', 'deny', 'denied', 'opposes', 'oppose', 'opposed',
  'unlikely', 'improbable', 'unexpected', 'misses', 'miss', 'missed',
  'underperforms', 'weak', 'weaker', 'weakest', 'low', 'decline', 'declines', 'declined',
  'disagrees', 'disagreement', 'crisis', 'collapse', 'collapses', 'crashed',
  'setback', 'trouble', 'concern', 'worried', 'fear', 'fears', 'alarming',
  'blocks', 'block', 'blocked', 'vetoes', 'veto', 'vetoed',
  'stalls', 'stall', 'stalled', 'delays', 'delay', 'delayed',
  'withdraws', 'withdraw', 'withdrawn', 'cancels', 'cancel', 'cancelled',
  'tanks', 'tank', 'tanked', 'crashes', 'crash', 'negative',
  'pessimistic', 'doubtful', 'uncertain', 'fraud', 'scandal', 'arrested',
  // Economic/market negative
  'dovish', 'easing', 'deficit', 'loss', 'losses', 'bearish', 'downgrade',
  'downgrades', 'contraction', 'shrinks', 'shrink', 'defaulted', 'bankrupt',
  'recession', 'stagflation', 'layoffs', 'layoff', 'furlough',
  // Political negative
  'trailing', 'behind', 'third', 'concedes', 'concede', 'suspended',
  'indicted', 'convicted', 'impeached', 'resigned', 'removed',
]);

const AMPLIFIERS = new Set([
  'very', 'extremely', 'significantly', 'massively', 'clearly', 'strongly',
  'heavily', 'sharply', 'dramatically', 'overwhelmingly', 'decisively',
  'substantially', 'considerably', 'markedly',
]);

const NEGATORS = new Set([
  'not', 'no', "don't", "doesn't", "won't", "can't", 'never', 'neither',
  'nor', 'barely', 'hardly', 'without', 'despite', 'against', 'unlike',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Topic keyword expansion map (30 topics)
// ─────────────────────────────────────────────────────────────────────────────
const TOPIC_KEYWORDS = {
  election:    ['election', 'vote', 'votes', 'voter', 'voters', 'poll', 'polling', 'ballot', 'candidate', 'presidency', 'senate', 'congressional', 'primary', 'runoff', 'incumbent'],
  trump:       ['trump', 'donald trump', 'gop', 'republican', 'maga', 'white house', 'president trump', 'mar-a-lago'],
  harris:      ['harris', 'kamala', 'vice president', 'democrat', 'democratic'],
  biden:       ['biden', 'joe biden', 'democrat', 'democratic', 'administration'],
  inflation:   ['inflation', 'cpi', 'consumer price', 'federal reserve', 'interest rate', 'fed', 'price index', 'core inflation', 'pce', 'fomc'],
  ukraine:     ['ukraine', 'ukrainian', 'russia', 'russian', 'nato', 'war', 'ceasefire', 'zelensky', 'putin', 'kyiv', 'moscow', 'troops', 'sanctions'],
  bitcoin:     ['bitcoin', 'btc', 'cryptocurrency', 'blockchain', 'satoshi', 'halving', 'spot etf'],
  ethereum:    ['ethereum', 'eth', 'defi', 'nft', 'smart contract', 'layer 2'],
  solana:      ['solana', 'sol', 'crypto'],
  recession:   ['recession', 'gdp', 'economic contraction', 'downturn', 'layoffs', 'unemployment', 'jobless', 'negative growth'],
  oil:         ['oil', 'crude', 'opec', 'petroleum', 'barrel', 'natural gas', 'energy price', 'brent'],
  nfl:         ['nfl', 'football', 'super bowl', 'playoff', 'quarterback', 'touchdown', 'nfc', 'afc'],
  nba:         ['nba', 'basketball', 'finals', 'playoffs', 'championship', 'draft'],
  mlb:         ['mlb', 'baseball', 'world series', 'playoffs', 'pitcher'],
  ai:          ['artificial intelligence', 'ai', 'openai', 'chatgpt', 'gpt', 'llm', 'machine learning', 'nvidia', 'anthropic'],
  climate:     ['climate', 'climate change', 'global warming', 'carbon', 'emissions', 'renewable', 'paris agreement', 'epa'],
  china:       ['china', 'chinese', 'beijing', 'xi jinping', 'taiwan', 'hong kong', 'prc', 'ccp'],
  fed:         ['federal reserve', 'fed', 'fomc', 'interest rate', 'rate hike', 'rate cut', 'powell', 'quantitative easing', 'basis points'],
  housing:     ['housing', 'real estate', 'mortgage', 'home prices', 'zillow', 'case-shiller', 'hud'],
  tariffs:     ['tariff', 'tariffs', 'trade war', 'trade deal', 'wto', 'customs', 'import tax', 'export'],
  congress:    ['congress', 'senate', 'house', 'legislation', 'bill', 'amendment', 'filibuster', 'reconciliation'],
  supreme_court: ['supreme court', 'scotus', 'justice', 'ruling', 'opinion', 'constitutional', 'overturns'],
  iran:        ['iran', 'iranian', 'nuclear', 'tehran', 'sanctions', 'iaea'],
  israel:      ['israel', 'israeli', 'gaza', 'hamas', 'netanyahu', 'idf', 'ceasefire', 'middle east'],
  india:       ['india', 'modi', 'bjp', 'rupee', 'brics', 'new delhi'],
  mexico:      ['mexico', 'peso', 'cartel', 'border', 'sheinbaum', 'amlo'],
  doge:        ['doge', 'dogecoin', 'meme coin', 'elon musk crypto'],
  elon:        ['elon musk', 'tesla', 'spacex', 'x.com', 'neuralink', 'doge department'],
  stocks:      ['s&p', 'nasdaq', 'dow jones', 'stock market', 'equity', 'earnings', 'ipo'],
  dollar:      ['dollar', 'usd', 'dxy', 'currency', 'forex', 'exchange rate'],
};

// ─────────────────────────────────────────────────────────────────────────────
// Recency decay — half-life scales with market close date
// Same-day markets: 6h half-life. Long-dated markets: 2-week half-life.
// ─────────────────────────────────────────────────────────────────────────────

// Half-life scales with how far out the market closes.
// Same-day markets decay aggressively; long-dated markets weight older news more.
function getHalfLifeHours(closesAt) {
  if (!closesAt) return 6;
  const daysOut = (new Date(closesAt) - Date.now()) / 86_400_000;
  if (daysOut < 1)   return 6;    // same-day: 6h half-life
  if (daysOut < 7)   return 24;   // this week: 1-day half-life
  if (daysOut < 30)  return 72;   // this month: 3-day half-life
  if (daysOut < 180) return 168;  // ~6 months: 1-week half-life
  return 336;                      // long-dated: 2-week half-life
}

function recencyWeight(publishedAt, halfLifeHours) {
  if (!publishedAt) return 0.5;
  const ageHours   = (Date.now() - new Date(publishedAt)) / 3_600_000;
  if (ageHours < 0) return 1.0;
  const decayConst = Math.LN2 / halfLifeHours;
  return Math.exp(-decayConst * ageHours);
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract keywords from a market title
// ─────────────────────────────────────────────────────────────────────────────
const STOP_WORDS = new Set([
  'will', 'the', 'a', 'an', 'be', 'is', 'are', 'was', 'were', 'in', 'on',
  'at', 'to', 'for', 'of', 'and', 'or', 'by', 'with', 'this', 'that', 'it',
  'its', 'over', 'under', 'than', 'more', 'less', 'most', 'least', 'before',
  'after', 'between', 'through', 'into', 'from', 'have', 'has', 'had',
]);

function extractKeywords(title) {
  const lower = title.toLowerCase();
  const keywords = new Set();

  // Add individual words
  for (const word of lower.split(/\W+/)) {
    if (word.length >= 3 && !STOP_WORDS.has(word)) keywords.add(word);
  }

  // Expand from topic map
  for (const terms of Object.values(TOPIC_KEYWORDS)) {
    for (const term of terms) {
      if (lower.includes(term)) {
        terms.forEach(t => keywords.add(t.split(' ')[0]));  // add first token of multi-word phrases
        break;
      }
    }
  }

  return Array.from(keywords);
}

// ─────────────────────────────────────────────────────────────────────────────
// Score a single text for sentiment (-1 to +1)
// ─────────────────────────────────────────────────────────────────────────────
function scoreSentiment(text) {
  if (!text) return 0;
  const words = text.toLowerCase().split(/\W+/);
  let score = 0, total = 0;

  for (let i = 0; i < words.length; i++) {
    const word  = words[i];
    const prev  = words[i - 1] || '';
    const prev2 = words[i - 2] || '';
    const isBullish = BULLISH_WORDS.has(word);
    const isBearish = BEARISH_WORDS.has(word);
    if (!isBullish && !isBearish) continue;

    let delta = isBullish ? 1 : -1;
    if (NEGATORS.has(prev)   || NEGATORS.has(prev2))   delta *= -1;
    if (AMPLIFIERS.has(prev) || AMPLIFIERS.has(prev2)) delta *= 1.5;

    score += delta;
    total++;
  }

  return total === 0 ? 0 : Math.max(-1, Math.min(1, score / total));
}

// ─────────────────────────────────────────────────────────────────────────────
// Analyze all articles for a market — returns weighted aggregate sentiment
// now incorporating credibility and recency
// ─────────────────────────────────────────────────────────────────────────────
function analyzeMarketSentiment(market, articles) {
  const keywords = extractKeywords(market.title);

  const halfLifeHours = getHalfLifeHours(market.closes);

  const scored = articles.map(article => {
    const text = `${article.title} ${article.summary}`.toLowerCase();
    const matchCount = keywords.filter(kw => text.includes(kw)).length;
    const relevance  = matchCount / Math.max(keywords.length, 1);

    const cred    = article.credibility || 1.0;
    const recency = recencyWeight(article.publishedAt, halfLifeHours);
    const weight  = relevance * cred * recency;

    return {
      ...article,
      relevance,
      weight,
      sentiment: scoreSentiment(`${article.title} ${article.summary}`),
    };
  });

  // Keep articles with meaningful relevance
  const relevant = scored
    .filter(a => a.relevance >= 0.1)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 20);

  if (relevant.length === 0) {
    return { sentimentScore: 0, sentimentLabel: 'Neutral', confidence: 0.1, relevantCount: 0, topArticles: [] };
  }

  // Weighted sentiment (weights already incorporate credibility + recency)
  const totalWeight      = relevant.reduce((s, a) => s + a.weight, 0);
  const weightedSentiment = totalWeight > 0
    ? relevant.reduce((s, a) => s + a.sentiment * a.weight, 0) / totalWeight
    : 0;

  // Confidence:
  //   countFactor       — more articles = more confident
  //   consistencyFactor — articles agreeing = more confident
  //   credibilityFactor — high-credibility sources boost confidence
  const sentimentStdDev  = stdDev(relevant.map(a => a.sentiment));
  const avgCredibility   = relevant.reduce((s, a) => s + (a.credibility || 1), 0) / relevant.length;
  const countFactor       = Math.min(relevant.length / 8, 1);
  const consistencyFactor = Math.max(0, 1 - sentimentStdDev);
  const credibilityFactor = Math.min((avgCredibility - 0.7) / 0.8, 1); // 0.7 baseline → 1.5 max
  const confidence = (countFactor * 0.50 + consistencyFactor * 0.30 + credibilityFactor * 0.20);

  return {
    sentimentScore:  weightedSentiment,
    sentimentLabel:  weightedSentiment > 0.15 ? 'Bullish' : weightedSentiment < -0.15 ? 'Bearish' : 'Neutral',
    confidence:      Math.max(0.1, Math.min(1, confidence)),
    relevantCount:   relevant.length,
    topArticles: relevant.slice(0, 5).map(a => ({
      title:       a.title,
      source:      a.source,
      url:         a.url,
      sentiment:   a.sentiment,
      credibility: a.credibility || 1.0,
      publishedAt: a.publishedAt,
    })),
  };
}

function stdDev(arr) {
  if (arr.length < 2) return 0;
  const mean     = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

module.exports = { analyzeMarketSentiment, extractKeywords, scoreSentiment };
