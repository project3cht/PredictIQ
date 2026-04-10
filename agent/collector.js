/**
 * collector.js — News & social data collection
 *
 * Sources: 28 RSS feeds + 12 subreddits + Hacker News API = 41 total
 *
 * Enhancements vs v1:
 *   • Source credibility tiers (Reuters/AP > Reddit posts)
 *   • Recency timestamp on every article (used for time-decay in sentiment)
 *   • More feeds: Congress.gov, Fed press releases, White House, Reuters, FT, WaPo
 *   • Hacker News top 30 stories via Firebase API
 *   • More Reddit communities: r/neutralnews, r/investing, r/dataisbeautiful
 */
const axios     = require('axios');
const RSSParser = require('rss-parser');

const parser = new RSSParser({ timeout: 8000 });

// ─────────────────────────────────────────────────────────────────────────────
// Source credibility weights
//   1.5 = tier-1 wire / official source  (Reuters, AP, BBC, Fed, Gov)
//   1.2 = tier-2 established outlet      (CNBC, Politico, MarketWatch…)
//   1.0 = standard outlet                (default)
//   0.8 = community / aggregator         (Reddit, HN)
// ─────────────────────────────────────────────────────────────────────────────
const CREDIBILITY = {
  'Reuters':            1.5,
  'AP News':            1.5,
  'BBC World':          1.4,
  'BBC Politics':       1.4,
  'Federal Reserve':    1.5,
  'White House':        1.5,
  'Congress.gov':       1.5,
  'NPR News':           1.3,
  'The Guardian':       1.2,
  'CNBC Top News':      1.2,
  'MarketWatch':        1.2,
  'Politico':           1.2,
  'Financial Times':    1.3,
  'Washington Post':    1.2,
  'CoinDesk':           1.1,
  'CoinTelegraph':      1.0,
  'Decrypt':            1.0,
  'The Hill':           1.1,
  'RealClearPolitics':  1.1,
  'Yahoo Finance':      1.0,
  'Investing.com':      1.0,
  'TechCrunch':         1.1,
  'The Verge':          1.0,
  'Hacker News':        0.9,
  'ESPN Headlines':     1.1,
  'default':            1.0,
  // Reddit — lower credibility but high volume and timeliness
  'r/worldnews':        0.8,
  'r/politics':         0.75,
  'r/Economics':        0.8,
  'r/finance':          0.8,
  'r/investing':        0.8,
  'r/CryptoCurrency':   0.8,
  'r/Kalshi':           0.9,    // market-focused = more signal
  'r/PredictIt':        0.9,
  'r/geopolitics':      0.8,
  'r/technology':       0.75,
  'r/sports':           0.75,
  'r/neutralnews':      0.9,    // curated neutral news
};

function getCredibility(sourceName) {
  return CREDIBILITY[sourceName] || CREDIBILITY['default'];
}

// ─────────────────────────────────────────────────────────────────────────────
// RSS Feed Sources (28 feeds)
// ─────────────────────────────────────────────────────────────────────────────
const RSS_SOURCES = [
  // ── Tier 1: Wire services & official sources ──────────────────────────────
  { name: 'Reuters',          url: 'https://feeds.reuters.com/reuters/topNews',                       category: 'General'    },
  { name: 'AP News',          url: 'https://rsshub.app/apnews/topics/apf-topnews',                   category: 'General'    },
  { name: 'Federal Reserve',  url: 'https://www.federalreserve.gov/feeds/press_all.xml',             category: 'Economics'  },
  { name: 'White House',      url: 'https://www.whitehouse.gov/feed/',                               category: 'Politics'   },
  { name: 'Congress.gov',     url: 'https://www.congress.gov/rss/most-viewed-bills.xml',             category: 'Politics'   },

  // ── Tier 2: Established outlets ───────────────────────────────────────────
  { name: 'BBC World',        url: 'http://feeds.bbci.co.uk/news/world/rss.xml',                     category: 'General'    },
  { name: 'BBC Politics',     url: 'http://feeds.bbci.co.uk/news/politics/rss.xml',                  category: 'Politics'   },
  { name: 'NPR News',         url: 'https://feeds.npr.org/1001/rss.xml',                             category: 'General'    },
  { name: 'The Guardian',     url: 'https://www.theguardian.com/world/rss',                          category: 'General'    },
  { name: 'Washington Post',  url: 'https://feeds.washingtonpost.com/rss/politics',                  category: 'Politics'   },
  { name: 'The Hill',         url: 'https://thehill.com/news/feed',                                  category: 'Politics'   },
  { name: 'Politico',         url: 'https://rss.politico.com/politics-news.xml',                    category: 'Politics'   },
  { name: 'RealClearPolitics',url: 'https://www.realclearpolitics.com/index.xml',                   category: 'Politics'   },

  // ── Financial & Economic ──────────────────────────────────────────────────
  { name: 'Yahoo Finance',    url: 'https://finance.yahoo.com/news/rssindex',                        category: 'Economics'  },
  { name: 'CNBC Top News',    url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',         category: 'Economics'  },
  { name: 'MarketWatch',      url: 'https://feeds.marketwatch.com/marketwatch/topstories/',          category: 'Economics'  },
  { name: 'Investing.com',    url: 'https://www.investing.com/rss/news.rss',                        category: 'Economics'  },
  { name: 'Seeking Alpha',    url: 'https://seekingalpha.com/market_currents.xml',                  category: 'Economics'  },

  // ── Crypto ────────────────────────────────────────────────────────────────
  { name: 'CoinDesk',         url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',               category: 'Crypto'     },
  { name: 'CoinTelegraph',    url: 'https://cointelegraph.com/rss',                                 category: 'Crypto'     },
  { name: 'Decrypt',          url: 'https://decrypt.co/feed',                                       category: 'Crypto'     },
  { name: 'The Block',        url: 'https://www.theblock.co/rss.xml',                               category: 'Crypto'     },

  // ── Tech ──────────────────────────────────────────────────────────────────
  { name: 'TechCrunch',       url: 'https://techcrunch.com/feed/',                                  category: 'Tech'       },
  { name: 'The Verge',        url: 'https://www.theverge.com/rss/index.xml',                        category: 'Tech'       },
  { name: 'Ars Technica',     url: 'https://feeds.arstechnica.com/arstechnica/index',               category: 'Tech'       },

  // ── Geopolitics ───────────────────────────────────────────────────────────
  { name: 'Foreign Policy',   url: 'https://foreignpolicy.com/feed/',                               category: 'Geopolitics'},
  { name: 'Defense One',      url: 'https://www.defenseone.com/rss/',                               category: 'Geopolitics'},

  // ── Sports ────────────────────────────────────────────────────────────────
  { name: 'ESPN Headlines',   url: 'https://www.espn.com/espn/rss/news',                            category: 'Sports'     },
];

// ─────────────────────────────────────────────────────────────────────────────
// Reddit Sources (12 subreddits)
// ─────────────────────────────────────────────────────────────────────────────
const REDDIT_SOURCES = [
  { subreddit: 'worldnews',     category: 'General'    },
  { subreddit: 'politics',      category: 'Politics'   },
  { subreddit: 'neutralnews',   category: 'General'    },
  { subreddit: 'Economics',     category: 'Economics'  },
  { subreddit: 'finance',       category: 'Economics'  },
  { subreddit: 'investing',     category: 'Economics'  },
  { subreddit: 'CryptoCurrency',category: 'Crypto'     },
  { subreddit: 'Kalshi',        category: 'Markets'    },
  { subreddit: 'PredictIt',     category: 'Markets'    },
  { subreddit: 'geopolitics',   category: 'Geopolitics'},
  { subreddit: 'technology',    category: 'Tech'       },
  { subreddit: 'sports',        category: 'Sports'     },
];

// ─────────────────────────────────────────────────────────────────────────────
// Hacker News top stories (Firebase API, no key needed)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchHackerNews() {
  try {
    const { data: ids } = await axios.get(
      'https://hacker-news.firebaseio.com/v0/topstories.json',
      { timeout: 6000 }
    );

    const top30 = ids.slice(0, 30);
    const stories = await Promise.allSettled(
      top30.map(id =>
        axios.get(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { timeout: 4000 })
      )
    );

    return stories
      .filter(r => r.status === 'fulfilled' && r.value.data?.type === 'story')
      .map(r => r.value.data)
      .filter(s => s.title && s.score > 10)
      .map(s => ({
        id: `hn_${s.id}`,
        source: 'Hacker News',
        category: 'Tech',
        title: s.title || '',
        summary: s.text ? s.text.replace(/<[^>]*>/g, '').slice(0, 300) : `Score: ${s.score} | Comments: ${s.descendants || 0}`,
        url: s.url || `https://news.ycombinator.com/item?id=${s.id}`,
        publishedAt: new Date(s.time * 1000).toISOString(),
        type: 'hn',
        score: s.score,
        credibility: getCredibility('Hacker News'),
      }));
  } catch (err) {
    console.error('[Collector] Hacker News error:', err.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch one RSS feed safely
// ─────────────────────────────────────────────────────────────────────────────
async function fetchRSS(source) {
  try {
    const feed = await parser.parseURL(source.url);
    const credibility = getCredibility(source.name);
    return (feed.items || []).slice(0, 20).map(item => ({
      id: item.guid || item.link,
      source: source.name,
      category: source.category,
      title: item.title || '',
      summary: stripHTML(item.contentSnippet || item.content || item.summary || ''),
      url: item.link || '',
      publishedAt: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
      type: 'rss',
      credibility,
    }));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch one subreddit safely
// ─────────────────────────────────────────────────────────────────────────────
async function fetchReddit(source) {
  try {
    const { data } = await axios.get(
      `https://www.reddit.com/r/${source.subreddit}/hot.json?limit=25`,
      {
        timeout: 8000,
        headers: {
          'User-Agent': 'PredictIQ-Dashboard/1.0 (prediction market research)',
          'Accept': 'application/json',
        },
      }
    );

    const credibility = getCredibility(`r/${source.subreddit}`);
    const posts = data?.data?.children || [];
    return posts
      .filter(p => !p.data.stickied && p.data.score > 5)
      .slice(0, 15)
      .map(p => ({
        id: `reddit_${p.data.id}`,
        source: `r/${source.subreddit}`,
        category: source.category,
        title: p.data.title || '',
        summary: p.data.selftext
          ? p.data.selftext.slice(0, 300)
          : `Score: ${p.data.score} | Comments: ${p.data.num_comments}`,
        url: `https://reddit.com${p.data.permalink}`,
        publishedAt: new Date(p.data.created_utc * 1000).toISOString(),
        type: 'reddit',
        score: p.data.score,
        credibility,
      }));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Collect all news sources in parallel (batched)
// ─────────────────────────────────────────────────────────────────────────────
async function collectAllNews() {
  console.log(`[Collector] Starting: ${RSS_SOURCES.length} RSS + ${REDDIT_SOURCES.length} subreddits + Hacker News...`);

  let sourcesSucceeded = 0;

  // RSS in batches of 6
  const rssBatches = chunkArray(RSS_SOURCES, 6);
  let allRSS = [];
  for (const batch of rssBatches) {
    const results = await Promise.allSettled(batch.map(fetchRSS));
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.length > 0) {
        allRSS = allRSS.concat(r.value);
        sourcesSucceeded++;
      }
    }
  }

  // Reddit in batches of 3
  const redditBatches = chunkArray(REDDIT_SOURCES, 3);
  let allReddit = [];
  for (const batch of redditBatches) {
    const results = await Promise.allSettled(batch.map(fetchReddit));
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.length > 0) {
        allReddit = allReddit.concat(r.value);
        sourcesSucceeded++;
      }
    }
    await delay(400);
  }

  // Hacker News
  const hn = await fetchHackerNews();
  if (hn.length > 0) sourcesSucceeded++;

  const all = [...allRSS, ...allReddit, ...hn];

  // Deduplicate by title (first 60 chars)
  const seen   = new Set();
  const deduped = all.filter(item => {
    const key = item.title.toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  deduped.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  const totalSources = RSS_SOURCES.length + REDDIT_SOURCES.length + 1;
  console.log(`[Collector] ✓ ${deduped.length} unique articles — ${sourcesSucceeded}/${totalSources} sources responded`);

  return { articles: deduped, sourcesChecked: totalSources, sourcesSucceeded };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function stripHTML(html) {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

module.exports = { collectAllNews };
