// ──────────────────────────────────────────────────────────────────────────────
//  SRI Labs PR Intelligence Dashboard — Server  v2.0
// ──────────────────────────────────────────────────────────────────────────────

const express   = require('express');
const axios     = require('axios');
const xml2js    = require('xml2js');
const cheerio   = require('cheerio');
const Sentiment = require('sentiment');
const path      = require('path');
const fs        = require('fs');

const sentiment = new Sentiment();

try { require('dotenv').config(); } catch (_) {}

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CONFIGURATION ──────────────────────────────────────────────────────────────
const CONFIG = {
  NEWS_API_KEY: process.env.NEWS_API_KEY || '',

  BRAND: 'SRI Labs',

  KEYWORDS: [
    'SRI Labs',
    'SRI DryQ',
    'DryQ hair dryer',
    'Dry Q hair dryer',
    'StyleQ flat iron',
    'SRI StyleQ',
    'CurlQ curling iron',
    'SRI CurlQ',
    'StyleWrap Pro',
    'RenewGlow',
    'KeeWee Shampoo',
    'Skin Research Institute skincare',
    'skinresearchinstitute.com',
  ],

  GOOGLE_ALERT_FEEDS: [
    'https://www.google.com/alerts/feeds/01888235712276631613/15128063951730738916',
    'https://www.google.com/alerts/feeds/01888235712276631613/589300702970365574',
    'https://www.google.com/alerts/feeds/01888235712276631613/15128063951730739809',
    'https://www.google.com/alerts/feeds/01888235712276631613/5880636424142970100',
    'https://www.google.com/alerts/feeds/01888235712276631613/589300702970366585',
    'https://www.google.com/alerts/feeds/01888235712276631613/589300702970366378',
    'https://www.google.com/alerts/feeds/01888235712276631613/589300702970366363',
  ],

  // ── Additional search APIs ──
  BING_API_KEY:       process.env.BING_API_KEY || '',
  GOOGLE_CSE_KEY:     process.env.GOOGLE_CSE_KEY || '',
  GOOGLE_CSE_ID:      process.env.GOOGLE_CSE_ID || '',

  // ── Meta / Instagram / Facebook ──
  INSTAGRAM_HANDLE:   'sri_labs_',
  META_APP_ID:        process.env.META_APP_ID || '',
  META_APP_SECRET:    process.env.META_APP_SECRET || '',
  META_REDIRECT:      process.env.META_REDIRECT_URI || 'http://localhost:3000/auth/meta/callback',
  META_API_VERSION:   'v19.0',
  TOKEN_FILE:         path.join(__dirname, 'meta_tokens.json'),

  // ── Websites to scrape ──
  WEBSITES: [
    {
      name: 'SRI Labs',
      baseUrl: 'https://srilabs.com',
      paths: ['/', '/blog', '/news', '/press', '/blogs/news', '/pages/press'],
    },
    {
      name: 'Skin Research Institute',
      baseUrl: 'https://skinresearchinstitute.com',
      paths: ['/', '/blog', '/news', '/research', '/press', '/blogs/news'],
    },
  ],
};

// ── SIMPLE IN-MEMORY CACHE ────────────────────────────────────────────────────
const _cache = new Map();

function cached(key, ttlMs, fetchFn) {
  const entry = _cache.get(key);
  if (entry && Date.now() - entry.ts < ttlMs) {
    return Promise.resolve(entry.data);
  }
  return fetchFn().then(data => {
    _cache.set(key, { data, ts: Date.now() });
    return data;
  });
}

// ── SENTIMENT ENGINE (AFINN-165 NLP) ──────────────────────────────────────────
// Returns { sentiment, sentimentScore } — sentiment is the label, sentimentScore is normalized
function analyzeSentimentFull(text) {
  const result = sentiment.analyze(text || '');
  const score = Math.round(result.comparative * 100) / 100;
  // Wider neutral band — beauty/product articles often contain cautionary language
  return {
    sentiment: score > 0.1 ? 'positive' : score < -0.15 ? 'negative' : 'neutral',
    sentimentScore: score,
  };
}
// Compat wrapper — returns just the label string for existing call sites
function analyzeSentiment(text) {
  return analyzeSentimentFull(text).sentiment;
}

// Enrich mentions with sentiment scores and persist
function enrichAndPersist(items) {
  items.forEach(m => {
    if (m.sentimentScore == null) {
      const full = analyzeSentimentFull((m.title || '') + ' ' + (m.description || ''));
      m.sentiment = full.sentiment;
      m.sentimentScore = full.sentimentScore;
    }
  });
  persistMentions(items);
  return items;
}

// ── PERSISTENT STORAGE ────────────────────────────────────────────────────────
const DB_FILE = path.join(__dirname, 'mentions.db.json');

function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (_) {}
  return { mentions: {} }; // keyed by URL for dedup
}

function saveDb(db) {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (_) {}
}

function persistMentions(items) {
  const db = loadDb();
  let added = 0;
  items.forEach(m => {
    const key = m.url || m.id;
    if (key && !db.mentions[key]) {
      db.mentions[key] = { ...m, storedAt: new Date().toISOString() };
      added++;
    }
  });
  if (added > 0) saveDb(db);
  return added;
}

function getHistoricalMentions(days) {
  const db = loadDb();
  const all = Object.values(db.mentions);
  if (!days) return all;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return all.filter(m => new Date(m.date || m.storedAt) >= cutoff);
}

function stripHtml(str) {
  return (str || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function absUrl(href, base) {
  if (!href) return '';
  try { return new URL(href, base).href; } catch (_) { return href; }
}

// ── TOKEN HELPERS (Meta — covers both IG + FB) ───────────────────────────────
function loadTokens() {
  try {
    if (fs.existsSync(CONFIG.TOKEN_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG.TOKEN_FILE, 'utf8'));
    }
  } catch (_) {}
  return null;
}

function saveTokens(data) {
  fs.writeFileSync(CONFIG.TOKEN_FILE, JSON.stringify(data, null, 2));
  console.log('[Meta] Tokens saved');
}

function clearTokens() {
  try { fs.unlinkSync(CONFIG.TOKEN_FILE); } catch (_) {}
}

// Also support legacy instagram_token.json if meta_tokens.json doesn't exist
function loadTokensCompat() {
  let tokens = loadTokens();
  if (tokens) return tokens;
  try {
    const legacy = path.join(__dirname, 'instagram_token.json');
    if (fs.existsSync(legacy)) {
      const data = JSON.parse(fs.readFileSync(legacy, 'utf8'));
      return {
        accessToken:  data.accessToken,
        igAccountId:  data.igAccountId,
        pageId:       null,
        pageToken:    data.accessToken,
        connectedAt:  data.connectedAt,
      };
    }
  } catch (_) {}
  return null;
}

// ── WEBSITE SCRAPING ───────────────────────────────────────────────────────────

// Try to find and parse an RSS/Atom feed at common paths
async function tryRssFeeds(baseUrl) {
  const feedPaths = ['/feed', '/rss', '/blog/feed', '/feed.xml', '/rss.xml',
                     '/atom.xml', '/blogs/news.atom', '/blog.rss'];
  const parser = new xml2js.Parser({ explicitArray: false, trim: true });

  for (const fp of feedPaths) {
    try {
      const { data } = await axios.get(baseUrl + fp, {
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SRILabsMonitor/2.0)' },
        maxRedirects: 3,
      });
      const result = await parser.parseStringPromise(data);

      // RSS 2.0
      const rssItems = result?.rss?.channel?.item;
      if (rssItems) {
        const list = Array.isArray(rssItems) ? rssItems : [rssItems];
        return list.map(item => ({
          title:       stripHtml(item.title || ''),
          description: stripHtml(item.description || item['content:encoded'] || ''),
          url:         item.link || '',
          date:        item.pubDate || item['dc:date'] || '',
        })).filter(i => i.title);
      }

      // Atom
      const atomEntries = result?.feed?.entry;
      if (atomEntries) {
        const list = Array.isArray(atomEntries) ? atomEntries : [atomEntries];
        return list.map(entry => ({
          title:       stripHtml(entry.title?._ || entry.title || ''),
          description: stripHtml(entry.content?._ || entry.summary?._ || entry.content || entry.summary || ''),
          url:         entry.link?.$?.href || (typeof entry.link === 'string' ? entry.link : ''),
          date:        entry.updated || entry.published || '',
        })).filter(i => i.title);
      }
    } catch (_) { /* try next */ }
  }
  return [];
}

// Discover RSS feed links from the HTML <head>
async function discoverRssFromHtml(html, baseUrl) {
  const $ = cheerio.load(html);
  const feedLink = $('link[type="application/rss+xml"], link[type="application/atom+xml"]').attr('href');
  if (!feedLink) return [];

  const feedUrl = absUrl(feedLink, baseUrl);
  try {
    const parser = new xml2js.Parser({ explicitArray: false, trim: true });
    const { data } = await axios.get(feedUrl, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SRILabsMonitor/2.0)' },
    });
    const result = await parser.parseStringPromise(data);
    const items = result?.rss?.channel?.item || result?.feed?.entry;
    if (!items) return [];
    const list = Array.isArray(items) ? items : [items];
    return list.map(item => ({
      title:       stripHtml(item.title?._ || item.title || ''),
      description: stripHtml(item.description || item['content:encoded'] || item.content?._ || item.summary?._ || ''),
      url:         item.link?.$?.href || item.link || '',
      date:        item.pubDate || item['dc:date'] || item.updated || item.published || '',
    })).filter(i => i.title);
  } catch (_) { return []; }
}

// Scrape HTML page for article/blog content
async function scrapeHtmlPage(url, siteName) {
  try {
    const { data: html } = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      maxRedirects: 5,
    });

    const $ = cheerio.load(html);
    const items = [];

    // Strategy 1: Look for structured article/post elements
    const articleSelectors = [
      'article', '.post', '.blog-post', '.blog-item', '.news-item',
      '.press-release', '.entry', '[class*="article"]', '[class*="blog"]',
      '[class*="post-card"]', '[class*="news-card"]', '.card',
    ];

    for (const sel of articleSelectors) {
      $(sel).each((_, el) => {
        const $el = $(el);
        const title = $el.find('h1, h2, h3, h4, .title, [class*="title"], [class*="heading"]').first().text().trim();
        const link  = $el.find('a').first().attr('href');
        const desc  = $el.find('p, .excerpt, .summary, [class*="excerpt"], [class*="desc"]').first().text().trim();
        const date  = $el.find('time').attr('datetime')
                   || $el.find('time, .date, [class*="date"], [class*="time"]').first().text().trim();

        if (title && title.length > 10) {
          items.push({
            title,
            description: desc.slice(0, 300),
            url: absUrl(link, url),
            date: date || '',
          });
        }
      });
      if (items.length >= 3) break; // Got enough from this selector
    }

    // Strategy 2: If no articles found, scrape headings with links
    if (items.length === 0) {
      $('h1 a, h2 a, h3 a').each((_, el) => {
        const $a = $(el);
        const title = $a.text().trim();
        const href  = $a.attr('href');
        if (title && title.length > 10 && href) {
          const parent = $a.closest('div, section, li, article');
          const desc = parent.find('p').first().text().trim();
          items.push({
            title,
            description: desc.slice(0, 300),
            url: absUrl(href, url),
            date: '',
          });
        }
      });
    }

    // Strategy 3: Look for JSON-LD structured data
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const ld = JSON.parse($(el).html());
        const entries = Array.isArray(ld) ? ld : [ld];
        for (const entry of entries) {
          if (entry['@type'] === 'BlogPosting' || entry['@type'] === 'Article' || entry['@type'] === 'NewsArticle') {
            items.push({
              title:       entry.headline || entry.name || '',
              description: stripHtml(entry.description || '').slice(0, 300),
              url:         entry.url || url,
              date:        entry.datePublished || entry.dateModified || '',
            });
          }
          // Handle ItemList of blog posts
          if (entry['@type'] === 'ItemList' && entry.itemListElement) {
            for (const li of entry.itemListElement) {
              if (li.item?.name) {
                items.push({
                  title: li.item.name,
                  description: stripHtml(li.item.description || '').slice(0, 300),
                  url: li.item.url || url,
                  date: li.item.datePublished || '',
                });
              }
            }
          }
        }
      } catch (_) {}
    });

    // Also try to discover RSS from this page's HTML
    if (items.length === 0) {
      const rssItems = await discoverRssFromHtml(html, url);
      items.push(...rssItems);
    }

    // Deduplicate by title
    const seen = new Set();
    return items.filter(i => {
      const key = i.title.toLowerCase().slice(0, 60);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch (err) {
    console.warn(`[Website] Scrape error (${url}):`, err.message);
    return [];
  }
}

// Scrape a full website (RSS first, then HTML pages)
async function scrapeWebsite(site) {
  // Try RSS feeds first (most reliable)
  const rssItems = await tryRssFeeds(site.baseUrl);
  if (rssItems.length > 0) {
    console.log(`[Website] ${site.name}: Found ${rssItems.length} items via RSS`);
    return rssItems.map((item, i) => ({
      id:          `web-rss-${site.name.replace(/\s/g, '')}-${i}-${Date.now()}`,
      type:        'website',
      sourceName:  site.name,
      title:       item.title,
      description: item.description,
      url:         absUrl(item.url, site.baseUrl),
      date:        item.date ? new Date(item.date).toISOString() : new Date().toISOString(),
      sentiment:   analyzeSentiment(item.title + ' ' + item.description),
    }));
  }

  // Fall back to HTML scraping of each configured path
  const allItems = [];
  for (const pagePath of site.paths) {
    const url = site.baseUrl + pagePath;
    const items = await scrapeHtmlPage(url, site.name);
    allItems.push(...items);
  }

  // Deduplicate
  const seen = new Set();
  const unique = allItems.filter(i => {
    const key = i.title.toLowerCase().slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`[Website] ${site.name}: Found ${unique.length} items via HTML scraping`);
  return unique.map((item, i) => ({
    id:          `web-html-${site.name.replace(/\s/g, '')}-${i}-${Date.now()}`,
    type:        'website',
    sourceName:  site.name,
    title:       item.title,
    description: item.description,
    url:         absUrl(item.url, site.baseUrl),
    date:        item.date ? new Date(item.date).toISOString() : new Date().toISOString(),
    sentiment:   analyzeSentiment(item.title + ' ' + item.description),
  }));
}

// ── STATIC FILES ───────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── API: CONFIG ────────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    brand:           CONFIG.BRAND,
    keywords:        CONFIG.KEYWORDS,
    instagramHandle: CONFIG.INSTAGRAM_HANDLE,
    websites:        CONFIG.WEBSITES.map(w => ({ name: w.name, url: w.baseUrl })),
  });
});

// ── API: NEWS ──────────────────────────────────────────────────────────────────
app.get('/api/news', async (req, res) => {
  try {
    const articles = await cached('news', 10 * 60 * 1000, async () => {
      if (!CONFIG.NEWS_API_KEY) return [];
      const query = CONFIG.KEYWORDS.map(k => `"${k}"`).join(' OR ');
      const { data } = await axios.get('https://newsapi.org/v2/everything', {
        params: { q: query, apiKey: CONFIG.NEWS_API_KEY, sortBy: 'publishedAt', pageSize: 100, language: 'en' },
        timeout: 12000,
      });
      return (data.articles || [])
        .filter(a => a.title && !a.title.includes('[Removed]') && a.url)
        .map((a, i) => ({
          id:          `news-${i}-${Date.now()}`,
          type:        'news',
          sourceName:  a.source?.name || 'Unknown',
          title:       a.title,
          description: a.description || '',
          url:         a.url,
          date:        a.publishedAt,
          sentiment:   analyzeSentiment((a.title || '') + ' ' + (a.description || '')),
          image:       a.urlToImage || null,
        }));
    });
    console.log(`[News API] ${articles.length} articles`);
    res.json(enrichAndPersist(articles));
  } catch (err) {
    console.error('[News API] Error:', err.message);
    res.json([]);
  }
});

// ── API: GOOGLE ALERTS ─────────────────────────────────────────────────────────
app.get('/api/alerts', async (req, res) => {
  try {
    const all = await cached('alerts', 10 * 60 * 1000, async () => {
      const parser = new xml2js.Parser({ explicitArray: false, trim: true });
      const items  = [];

      await Promise.allSettled(
        CONFIG.GOOGLE_ALERT_FEEDS.map(async (feedUrl) => {
          try {
            const { data } = await axios.get(feedUrl, {
              timeout: 10000,
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PRMonitor/2.0)' },
            });
            const result  = await parser.parseStringPromise(data);
            const entries = result?.feed?.entry;
            if (!entries) return;
            const list = Array.isArray(entries) ? entries : [entries];
            list.forEach((entry, i) => {
              const title   = stripHtml(entry?.title?._ || entry?.title || '');
              const content = stripHtml(entry?.content?._ || entry?.content || entry?.summary?._ || entry?.summary || '');
              const rawLink = entry?.link;
              const link    = rawLink?.$?.href || (typeof rawLink === 'string' ? rawLink : '');
              const date    = entry?.updated || entry?.published || new Date().toISOString();
              if (title) {
                items.push({
                  id:          `alert-${i}-${feedUrl.slice(-8)}-${Date.now()}`,
                  type:        'alerts',
                  sourceName:  'Google Alerts',
                  title, description: content, url: link, date,
                  sentiment:   analyzeSentiment(title + ' ' + content),
                });
              }
            });
          } catch (e) {
            console.warn(`[Alerts] Feed error:`, e.message);
          }
        })
      );
      // Filter out false positives
      const ALERT_EXCLUDE = ['singapore', 'sri lanka', 'sri lankan', 'colombo',
        'dupilumab', 'autoimmune', 'atopic dermatitis', 'psoriasis'];
      return items.filter(r => {
        const text = (r.title + ' ' + r.description).toLowerCase();
        if (['dryq','styleq','curlq','renewglow','keewee','stylewrap','srilabs','sri labs']
            .some(k => text.includes(k))) return true;
        return !ALERT_EXCLUDE.some(ex => text.includes(ex));
      });
    });
    console.log(`[Alerts] ${all.length} items`);
    res.json(enrichAndPersist(all));
  } catch (err) {
    console.error('[Alerts] Error:', err.message);
    res.json([]);
  }
});


// ── API: REDDIT ────────────────────────────────────────────────────────────────
// Free, no API key needed — uses Reddit's public JSON endpoints
app.get('/api/reddit', async (req, res) => {
  try {
    const items = await cached('reddit', 30 * 60 * 1000, async () => {
      const results = [];
      // Search top 4 keywords to stay within rate limits
      const keywords = CONFIG.KEYWORDS.slice(0, 4);

      for (const kw of keywords) {
        try {
          const { data } = await axios.get('https://www.reddit.com/search.json', {
            params: { q: `"${kw}"`, sort: 'relevance', limit: 50, t: 'year' },
            headers: { 'User-Agent': 'SRILabsBrandMonitor/2.0 (brand monitoring dashboard)' },
            timeout: 10000,
          });

          const kwLower = kw.toLowerCase();
          const posts = data?.data?.children || [];
          posts.forEach(({ data: post }) => {
            if (!post || post.over_18) return;
            // Only keep posts that genuinely mention the keyword
            const text = ((post.title || '') + ' ' + (post.selftext || '')).toLowerCase();
            if (!text.includes(kwLower)) return;

            results.push({
              id:          `reddit-${post.id}`,
              type:        'reddit',
              sourceName:  `r/${post.subreddit}`,
              title:       post.title || '',
              description: (post.selftext || '').slice(0, 300),
              url:         `https://reddit.com${post.permalink}`,
              date:        new Date(post.created_utc * 1000).toISOString(),
              sentiment:   analyzeSentiment((post.title || '') + ' ' + (post.selftext || '')),
              engagement:  (post.score || 0) + (post.num_comments || 0),
              matchedKeyword: kw,
            });
          });

          // Respect Reddit rate limits
          await new Promise(r => setTimeout(r, 1200));
        } catch (e) {
          console.warn(`[Reddit] Search error for "${kw}":`, e.message);
        }
      }

      // Deduplicate by post ID
      const seen = new Set();
      return results.filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true; });
    });

    console.log(`[Reddit] ${items.length} posts`);
    res.json(enrichAndPersist(items));
  } catch (err) {
    console.error('[Reddit] Error:', err.message);
    res.json([]);
  }
});

// ── API: BING NEWS ─────────────────────────────────────────────────────────────
// Free tier: 1000 calls/month — sign up at https://portal.azure.com
app.get('/api/bing', async (req, res) => {
  if (!CONFIG.BING_API_KEY) return res.json([]);

  try {
    const items = await cached('bing', 15 * 60 * 1000, async () => {
      const query = CONFIG.KEYWORDS.map(k => `"${k}"`).join(' OR ');
      const { data } = await axios.get('https://api.bing.microsoft.com/v7.0/news/search', {
        params: { q: query, count: 50, freshness: 'Month', mkt: 'en-US', sortBy: 'Date' },
        headers: { 'Ocp-Apim-Subscription-Key': CONFIG.BING_API_KEY },
        timeout: 10000,
      });

      return (data.value || []).map((article, i) => ({
        id:          `bing-${i}-${Date.now()}`,
        type:        'news',
        sourceName:  article.provider?.[0]?.name || 'Bing News',
        title:       article.name || '',
        description: article.description || '',
        url:         article.url || '',
        date:        article.datePublished || new Date().toISOString(),
        sentiment:   analyzeSentiment((article.name || '') + ' ' + (article.description || '')),
        image:       article.image?.thumbnail?.contentUrl || null,
      }));
    });

    console.log(`[Bing News] ${items.length} articles`);
    res.json(enrichAndPersist(items));
  } catch (err) {
    console.error('[Bing News] Error:', err.message);
    res.json([]);
  }
});

// ── API: GOOGLE NEWS ───────────────────────────────────────────────────────────
// Free, no API key — uses Google News RSS feeds
app.get('/api/google', async (req, res) => {
  try {
    const items = await cached('google_news', 15 * 60 * 1000, async () => {
      const parser = new xml2js.Parser({ explicitArray: false, trim: true });
      const results = [];

      for (const kw of CONFIG.KEYWORDS) {
        try {
          const url = `https://news.google.com/rss/search?q=%22${encodeURIComponent(kw)}%22&hl=en-US&gl=US&ceid=US:en`;
          const { data } = await axios.get(url, {
            timeout: 8000,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SRILabsMonitor/2.0)' },
          });
          const result = await parser.parseStringPromise(data);
          const entries = result?.rss?.channel?.item;
          if (!entries) continue;
          const list = Array.isArray(entries) ? entries : [entries];

          list.forEach((item, i) => {
            const title = stripHtml(item.title || '');
            const source = item.source?._ || item.source || '';
            const desc = stripHtml(item.description || '');
            const link = item.link || '';
            const date = item.pubDate || '';

            if (title) {
              results.push({
                id:          `gnews-${kw.replace(/\s/g,'')}-${i}-${Date.now()}`,
                type:        'news',
                sourceName:  typeof source === 'string' ? source : (source.toString() || 'Google News'),
                title,
                description: desc.slice(0, 300),
                url:         link,
                date:        date ? new Date(date).toISOString() : new Date().toISOString(),
                sentiment:   analyzeSentiment(title + ' ' + desc),
                matchedKeyword: kw,
              });
            }
          });
        } catch (e) {
          console.warn(`[Google News] Error for "${kw}":`, e.message);
        }
      }

      // Only keep articles that are genuinely about SRI Labs brands
      const BRAND_TERMS = ['sri labs','srilabs','dryq','dry q','dry-q','styleq flat iron',
        'styleq hair','stylewrap','style wrap','curlq','curl q','renewglow','renew glow',
        'keewee shampoo','skin research institute','skinresearchinstitute',
        'sri dryq','sri styleq','sri curlq','coanda multitool'];
      const EXCLUDE = ['singapore','sri lanka','sri lankan','colombo','mountain hardwear',
        'ukclimbing','waterproof fabric','plasmic jacket','rain jacket','stanford research',
        'sri international','invented siri','harry styles'];
      const filtered = results.filter(r => {
        const text = (r.title + ' ' + (r.description || '') + ' ' + (r.matchedKeyword || '')).toLowerCase();
        // Exclude known false positives first
        if (EXCLUDE.some(ex => text.includes(ex))) return false;
        // Articles that matched specific product keywords (DryQ, StyleWrap, etc.) are likely real
        const kw = (r.matchedKeyword || '').toLowerCase();
        if (['dryq','styleq','curlq','renewglow','keewee shampoo','stylewrap pro'].some(p => kw.includes(p))) return true;
        // For broader keywords (SRI Labs, skin research institute), verify brand is in text
        if (BRAND_TERMS.some(k => (r.title + ' ' + (r.description || '')).toLowerCase().includes(k))) return true;
        return false;
      });

      // Deduplicate by title
      const seen = new Set();
      return filtered.filter(r => {
        const key = r.title.slice(0, 60).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    });

    console.log(`[Google News] ${items.length} articles`);
    res.json(enrichAndPersist(items));
  } catch (err) {
    console.error('[Google News] Error:', err.message);
    res.json([]);
  }
});

// ── API: YOUTUBE ───────────────────────────────────────────────────────────────
// Free, no API key — scrapes YouTube search results
app.get('/api/youtube', async (req, res) => {
  try {
    const items = await cached('youtube', 30 * 60 * 1000, async () => {
      const results = [];
      const keywords = CONFIG.KEYWORDS.slice(0, 4);

      for (const kw of keywords) {
        try {
          const { data: html } = await axios.get(
            'https://www.youtube.com/results?search_query=' + encodeURIComponent(kw),
            { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' }, timeout: 10000 }
          );

          // Extract video data from the page's initial data
          const dataMatch = html.match(/var ytInitialData = ({.+?});<\/script>/);
          if (!dataMatch) continue;

          try {
            const ytData = JSON.parse(dataMatch[1]);
            const contents = ytData?.contents?.twoColumnSearchResultsRenderer?.primaryContents
              ?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];

            contents.forEach((item, i) => {
              const video = item.videoRenderer;
              if (!video) return;
              const title = video.title?.runs?.[0]?.text || '';
              const channel = video.ownerText?.runs?.[0]?.text || '';
              const videoId = video.videoId || '';
              const viewText = video.viewCountText?.simpleText || '';
              const dateText = video.publishedTimeText?.simpleText || '';
              const desc = video.detailedMetadataSnippets?.[0]?.snippetText?.runs?.map(r => r.text).join('') || '';

              if (title && videoId) {
                // Convert relative date ("2 months ago") to ISO
                let isoDate = new Date().toISOString();
                if (dateText) {
                  const m = dateText.match(/(\d+)\s+(second|minute|hour|day|week|month|year)/i);
                  if (m) {
                    const n = parseInt(m[1]);
                    const unit = m[2].toLowerCase();
                    const d = new Date();
                    if (unit.startsWith('second')) d.setSeconds(d.getSeconds() - n);
                    else if (unit.startsWith('minute')) d.setMinutes(d.getMinutes() - n);
                    else if (unit.startsWith('hour')) d.setHours(d.getHours() - n);
                    else if (unit.startsWith('day')) d.setDate(d.getDate() - n);
                    else if (unit.startsWith('week')) d.setDate(d.getDate() - n * 7);
                    else if (unit.startsWith('month')) d.setMonth(d.getMonth() - n);
                    else if (unit.startsWith('year')) d.setFullYear(d.getFullYear() - n);
                    isoDate = d.toISOString();
                  }
                }

                results.push({
                  id:          `yt-${videoId}`,
                  type:        'youtube',
                  sourceName:  channel,
                  title:       title,
                  description: desc.slice(0, 300),
                  url:         `https://youtube.com/watch?v=${videoId}`,
                  date:        isoDate,
                  relativeDate: dateText || '',
                  ...analyzeSentimentFull(title + ' ' + desc),
                  views:       viewText,
                  matchedKeyword: kw,
                });
              }
            });
          } catch (_) {}

          await new Promise(r => setTimeout(r, 1000));
        } catch (e) {
          console.warn(`[YouTube] Error for "${kw}":`, e.message);
        }
      }

      // Filter: remove own channel, require brand context, deduplicate
      const OWN_CHANNELS = ['sri labs', 'skin research institute', 'sri_labs', 'srilabs'];
      const YT_BRAND = ['sri labs','sri dry','sri style','srilabs','dryq','dry q','dry-q',
        'stylewrap pro','style wrap pro','styleq flat','styleq hair','curlq','curl q',
        'renewglow','keewee','skin research institute','skinresearch'];
      const YT_EXCLUDE = ['mountain hardwear','harry styles','gaming','minecraft'];
      const seen = new Set();
      return results.filter(r => {
        if (seen.has(r.id)) return false;
        seen.add(r.id);
        // Exclude own channel
        const ch = (r.sourceName || '').toLowerCase().trim();
        if (OWN_CHANNELS.some(own => ch === own || ch.includes(own))) return false;
        // Must mention brand in title or description
        const text = (r.title + ' ' + r.description).toLowerCase();
        if (YT_EXCLUDE.some(ex => text.includes(ex))) return false;
        if (!YT_BRAND.some(k => text.includes(k))) return false;
        return true;
      });
    });

    console.log(`[YouTube] ${items.length} videos (own channel excluded)`);
    res.json(enrichAndPersist(items));
  } catch (err) {
    console.error('[YouTube] Error:', err.message);
    res.json([]);
  }
});

// ── API: TIKTOK (via Google index) ─────────────────────────────────────────────
app.get('/api/tiktok', async (req, res) => {
  try {
    const items = await cached('tiktok', 30 * 60 * 1000, async () => {
      const parser = new xml2js.Parser({ explicitArray: false, trim: true });
      const results = [];
      // Search for brand terms on TikTok via Google
      const tiktokKeywords = ['SRI Labs', 'DryQ', 'StyleQ', 'CurlQ', 'StyleWrap Pro', 'Skin Research Institute'];

      for (const kw of tiktokKeywords) {
        try {
          const url = `https://news.google.com/rss/search?q=${encodeURIComponent(kw + ' site:tiktok.com')}&hl=en-US&gl=US&ceid=US:en`;
          const { data } = await axios.get(url, {
            timeout: 8000,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SRILabsMonitor/2.0)' },
          });
          const result = await parser.parseStringPromise(data);
          const entries = result?.rss?.channel?.item;
          if (!entries) continue;
          const list = Array.isArray(entries) ? entries : [entries];

          list.forEach((item, i) => {
            const title = stripHtml(item.title || '');
            const link = item.link || '';
            const date = item.pubDate || '';

            if (title) {
              results.push({
                id:          `tiktok-${kw.replace(/\s/g,'')}-${i}-${Date.now()}`,
                type:        'tiktok',
                sourceName:  'TikTok',
                title,
                description: '',
                url:         link,
                date:        date ? new Date(date).toISOString() : new Date().toISOString(),
                ...analyzeSentimentFull(title),
                matchedKeyword: kw,
              });
            }
          });
        } catch (e) {
          console.warn(`[TikTok] Error for "${kw}":`, e.message);
        }
      }

      // Brand verification + deduplicate
      // Use specific product names — "style wrap" alone matches food/clothing wraps
      const TT_BRAND = ['sri labs','srilabs','sri dryq','sri dry q','dryq hair','dryq blow',
        'dry q hair','dry q blow','styleq flat','styleq hair','style q flat',
        'stylewrap pro','style wrap pro','curlq','curl q curling',
        'renewglow','keewee shampoo','skin research institute','skinresearchinstitute',
        '#sridryq','#stylewrappro','#skinresearchinstitute','#curlq',
        '@skinresearchinstitute','@sri_labs'];
      const seen = new Set();
      return results.filter(r => {
        const key = r.title.slice(0, 60).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        const text = r.title.toLowerCase();
        if (!TT_BRAND.some(k => text.includes(k))) return false;
        return true;
      });
    });

    console.log(`[TikTok] ${items.length} videos`);
    res.json(enrichAndPersist(items));
  } catch (err) {
    console.error('[TikTok] Error:', err.message);
    res.json([]);
  }
});

// ── AUTH: MANUAL TOKEN SETUP (bypasses OAuth redirect) ────────────────────────
app.get('/auth/setup', async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.send(`
      <html><body style="font-family:Inter,sans-serif;max-width:500px;margin:60px auto;padding:20px">
        <h2>Connect Instagram + Facebook</h2>
        <p style="color:#666;margin:12px 0">Paste your access token from the <a href="https://developers.facebook.com/tools/explorer/" target="_blank">Graph API Explorer</a></p>
        <form action="/auth/setup" method="get">
          <textarea name="token" rows="4" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px" placeholder="Paste token here..."></textarea>
          <button type="submit" style="margin-top:8px;background:#4F46E5;color:#fff;border:none;padding:10px 20px;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer">Connect</button>
        </form>
      </body></html>
    `);
  }

  const base = `https://graph.facebook.com/${CONFIG.META_API_VERSION}`;

  try {
    // Exchange for long-lived token
    let longToken = token;
    try {
      const { data } = await axios.get(`${base}/oauth/access_token`, {
        params: {
          grant_type: 'fb_exchange_token',
          client_id: CONFIG.META_APP_ID,
          client_secret: CONFIG.META_APP_SECRET,
          fb_exchange_token: token,
        },
      });
      longToken = data.access_token || token;
    } catch (_) {
      console.log('[Setup] Could not exchange for long-lived token, using as-is');
    }

    // Get Pages
    const { data: pagesData } = await axios.get(`${base}/me/accounts`, {
      params: { access_token: longToken },
    });
    const pages = pagesData.data || [];

    if (!pages.length) {
      return res.send('<html><body style="font-family:sans-serif;padding:40px"><h3>No Facebook Pages found</h3><p>Make sure your account manages a Facebook Page linked to an Instagram Business account.</p><a href="/auth/setup">Try again</a></body></html>');
    }

    // Find Instagram Business Account
    let igAccountId = null;
    let bestPage = pages[0];

    for (const page of pages) {
      try {
        const { data: pageData } = await axios.get(`${base}/${page.id}`, {
          params: { fields: 'instagram_business_account,name,fan_count', access_token: page.access_token },
        });
        if (pageData.instagram_business_account?.id) {
          igAccountId = pageData.instagram_business_account.id;
          bestPage = { ...page, name: pageData.name, fanCount: pageData.fan_count };
          break;
        }
      } catch (_) {}
    }

    saveTokens({
      accessToken: bestPage.access_token,
      igAccountId: igAccountId || null,
      pageId: bestPage.id,
      pageName: bestPage.name || 'Facebook Page',
      pageToken: bestPage.access_token,
      connectedAt: new Date().toISOString(),
    });

    console.log(`[Setup] Connected! Page: ${bestPage.name}, IG: ${igAccountId || 'none'}`);
    res.redirect('/?meta_connected=1');

  } catch (err) {
    console.error('[Setup] Error:', err.response?.data || err.message);
    res.send(`<html><body style="font-family:sans-serif;padding:40px"><h3>Error</h3><p>${err.response?.data?.error?.message || err.message}</p><a href="/auth/setup">Try again</a></body></html>`);
  }
});

// ── AUTH: META OAUTH — Step 1: redirect ────────────────────────────────────────
app.get('/auth/meta', (req, res) => {
  if (!CONFIG.META_APP_ID) {
    return res.status(500).send('META_APP_ID not configured. Set it in .env');
  }
  const scopes = [
    'instagram_basic',
    'instagram_manage_insights',
    'pages_show_list',
    'pages_read_engagement',
    'pages_read_user_content',
  ].join(',');

  const authUrl = `https://www.facebook.com/${CONFIG.META_API_VERSION}/dialog/oauth`
    + `?client_id=${CONFIG.META_APP_ID}`
    + `&redirect_uri=${encodeURIComponent(CONFIG.META_REDIRECT)}`
    + `&scope=${scopes}`
    + `&response_type=code`;

  console.log('[Meta] Redirecting to OAuth…');
  res.redirect(authUrl);
});

// Keep legacy /auth/instagram route working
app.get('/auth/instagram', (req, res) => res.redirect('/auth/meta'));

// ── AUTH: META OAUTH — Step 2: callback ────────────────────────────────────────
app.get('/auth/meta/callback', async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error || !code) {
    console.error('[Meta OAuth] Error:', error, error_description);
    return res.redirect('/?meta_error=' + encodeURIComponent(error_description || error || 'unknown'));
  }

  const base = `https://graph.facebook.com/${CONFIG.META_API_VERSION}`;

  try {
    // Exchange code → short-lived token
    console.log('[Meta OAuth] Exchanging code for token...');
    const { data: tokenData } = await axios.get(`${base}/oauth/access_token`, {
      params: {
        client_id: CONFIG.META_APP_ID, client_secret: CONFIG.META_APP_SECRET,
        redirect_uri: CONFIG.META_REDIRECT, code,
      },
    });
    const shortToken = tokenData.access_token;
    console.log('[Meta OAuth] Got short token');

    // Exchange → long-lived token (60 days)
    const { data: longData } = await axios.get(`${base}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: CONFIG.META_APP_ID, client_secret: CONFIG.META_APP_SECRET,
        fb_exchange_token: shortToken,
      },
    });
    const longToken = longData.access_token;
    console.log('[Meta OAuth] Got long-lived token');

    // Check permissions
    try {
      const { data: perms } = await axios.get(`${base}/me/permissions`, { params: { access_token: longToken } });
      console.log('[Meta OAuth] Permissions:', (perms.data||[]).map(p => p.permission + ':' + p.status).join(', '));
    } catch (_) {}

    // Get Facebook Pages
    const { data: pagesData } = await axios.get(`${base}/me/accounts`, {
      params: { access_token: longToken },
    });
    const pages = pagesData.data || [];
    console.log('[Meta OAuth] Found', pages.length, 'pages:', pages.map(p => p.name || p.id).join(', '));
    if (!pages.length) {
      return res.redirect('/?meta_error=no_facebook_page');
    }

    // Find Instagram Business Account + save Facebook page info
    let igAccountId = null;
    let bestPage = pages[0]; // default to first page

    for (const page of pages) {
      try {
        const { data: pageData } = await axios.get(`${base}/${page.id}`, {
          params: { fields: 'instagram_business_account,name,fan_count', access_token: page.access_token },
        });
        if (pageData.instagram_business_account?.id) {
          igAccountId = pageData.instagram_business_account.id;
          bestPage = { ...page, name: pageData.name, fanCount: pageData.fan_count };
          break;
        }
      } catch (_) {}
    }

    saveTokens({
      accessToken:  bestPage.access_token,
      igAccountId:  igAccountId || null,
      pageId:       bestPage.id,
      pageName:     bestPage.name || 'Facebook Page',
      pageToken:    bestPage.access_token,
      connectedAt:  new Date().toISOString(),
    });

    console.log(`[Meta] Connected! Page: ${bestPage.name}, IG: ${igAccountId || 'none'}`);
    res.redirect('/?meta_connected=1');

  } catch (err) {
    console.error('[Meta OAuth] Failed:', err.response?.data || err.message);
    res.redirect('/?meta_error=' + encodeURIComponent(err.message));
  }
});

// ── API: INSTAGRAM PROFILE + METRICS ──────────────────────────────────────────
app.get('/api/instagram', async (req, res) => {
  const tokens = loadTokensCompat();
  if (!tokens || !tokens.igAccountId) {
    return res.json({ status: 'pending', handle: CONFIG.INSTAGRAM_HANDLE });
  }

  const { accessToken, igAccountId } = tokens;
  const base = `https://graph.facebook.com/${CONFIG.META_API_VERSION}`;

  try {
    const [profileRes, mediaRes] = await Promise.all([
      axios.get(`${base}/${igAccountId}`, {
        params: { fields: 'username,followers_count,follows_count,media_count,biography', access_token: accessToken },
      }),
      axios.get(`${base}/${igAccountId}/media`, {
        params: { fields: 'id,caption,media_type,timestamp,like_count,comments_count,permalink,media_url,thumbnail_url', limit: 12, access_token: accessToken },
      }),
    ]);

    const profile = profileRes.data;
    const media = mediaRes.data.data || [];

    // Insights (best-effort)
    let insights = [];
    try {
      const since = Math.floor((Date.now() - 30 * 24 * 3600 * 1000) / 1000);
      const until = Math.floor(Date.now() / 1000);
      const { data: insightData } = await axios.get(`${base}/${igAccountId}/insights`, {
        params: { metric: 'reach,impressions,profile_views', period: 'day', since, until, access_token: accessToken },
      });
      insights = insightData.data || [];
    } catch (_) {}

    const totalEngagement = media.reduce((s, m) => s + (m.like_count || 0) + (m.comments_count || 0), 0);
    const avgEngagement = media.length ? Math.round(totalEngagement / media.length) : 0;
    const engagementRate = profile.followers_count
      ? ((avgEngagement / profile.followers_count) * 100).toFixed(2) : '0';

    res.json({
      status: 'connected', handle: profile.username,
      followers: profile.followers_count, following: profile.follows_count,
      mediaCount: profile.media_count, biography: profile.biography,
      avgEngagement, engagementRate, recentMedia: media, insights,
      connectedAt: tokens.connectedAt,
    });
  } catch (err) {
    const code = err.response?.data?.error?.code;
    console.error('[Instagram API] Error:', err.response?.data?.error || err.message);
    if (code === 190 || code === 102 || err.response?.status === 401) {
      clearTokens();
      return res.json({ status: 'pending', handle: CONFIG.INSTAGRAM_HANDLE, tokenExpired: true });
    }
    res.json({ status: 'error', message: err.response?.data?.error?.message || err.message });
  }
});

// ── API: INSTAGRAM MENTIONS (hashtags + tagged media) ─────────────────────────
app.get('/api/instagram/mentions', async (req, res) => {
  const tokens = loadTokensCompat();
  if (!tokens || !tokens.igAccountId) {
    return res.json([]);
  }

  try {
    const mentions = await cached('ig_mentions', 30 * 60 * 1000, async () => {
      const { accessToken, igAccountId } = tokens;
      const base = `https://graph.facebook.com/${CONFIG.META_API_VERSION}`;
      const items = [];

      // 1. Tagged media (media where the IG account is tagged)
      try {
        const { data } = await axios.get(`${base}/${igAccountId}/tags`, {
          params: {
            fields: 'id,caption,media_type,timestamp,permalink,like_count,comments_count,username',
            access_token: accessToken,
          },
        });
        (data.data || []).forEach((m, i) => {
          items.push({
            id:          `ig-tag-${m.id}`,
            type:        'social',
            platform:    'instagram',
            sourceName:  `@${m.username || 'instagram'}`,
            title:       (m.caption || 'Tagged in a post').slice(0, 120),
            description: m.caption || '',
            url:         m.permalink || '',
            date:        m.timestamp || new Date().toISOString(),
            sentiment:   analyzeSentiment(m.caption || ''),
            engagement:  (m.like_count || 0) + (m.comments_count || 0),
          });
        });
      } catch (e) {
        console.warn('[IG Mentions] Tags error:', e.response?.data?.error?.message || e.message);
      }

      // 2. Hashtag search for brand keywords (rate-limited: 30 per 7 days)
      const hashtagKeywords = CONFIG.KEYWORDS.slice(0, 3).map(k => k.replace(/\s+/g, '').toLowerCase());
      for (const keyword of hashtagKeywords) {
        try {
          const { data: searchData } = await axios.get(`${base}/ig_hashtag_search`, {
            params: { q: keyword, user_id: igAccountId, access_token: accessToken },
          });
          const hashtagId = searchData.data?.[0]?.id;
          if (!hashtagId) continue;

          const { data: mediaData } = await axios.get(`${base}/${hashtagId}/recent_media`, {
            params: {
              user_id: igAccountId,
              fields: 'id,caption,media_type,timestamp,permalink,like_count,comments_count',
              access_token: accessToken,
            },
          });
          (mediaData.data || []).forEach(m => {
            items.push({
              id:          `ig-hash-${m.id}`,
              type:        'social',
              platform:    'instagram',
              sourceName:  `#${keyword}`,
              title:       (m.caption || `#${keyword} post`).slice(0, 120),
              description: m.caption || '',
              url:         m.permalink || '',
              date:        m.timestamp || new Date().toISOString(),
              sentiment:   analyzeSentiment(m.caption || ''),
              engagement:  (m.like_count || 0) + (m.comments_count || 0),
            });
          });
        } catch (e) {
          console.warn(`[IG Mentions] Hashtag #${keyword} error:`, e.response?.data?.error?.message || e.message);
        }
      }

      // 3. Mentioned media (posts that @mention the account)
      try {
        const { data } = await axios.get(`${base}/${igAccountId}/mentioned_media`, {
          params: {
            fields: 'id,caption,timestamp,permalink,like_count,comments_count',
            access_token: accessToken,
          },
        });
        (data.data || []).forEach(m => {
          items.push({
            id:          `ig-mention-${m.id}`,
            type:        'social',
            platform:    'instagram',
            sourceName:  'Instagram @mention',
            title:       (m.caption || 'Mentioned in a post').slice(0, 120),
            description: m.caption || '',
            url:         m.permalink || '',
            date:        m.timestamp || new Date().toISOString(),
            sentiment:   analyzeSentiment(m.caption || ''),
            engagement:  (m.like_count || 0) + (m.comments_count || 0),
          });
        });
      } catch (e) {
        console.warn('[IG Mentions] @mentions error:', e.response?.data?.error?.message || e.message);
      }

      // Deduplicate by id
      const seen = new Set();
      return items.filter(i => {
        if (seen.has(i.id)) return false;
        seen.add(i.id);
        return true;
      });
    });

    console.log(`[IG Mentions] ${mentions.length} items`);
    res.json(mentions);
  } catch (err) {
    console.error('[IG Mentions] Error:', err.message);
    res.json([]);
  }
});

// ── API: FACEBOOK PAGE DATA + MENTIONS ────────────────────────────────────────
app.get('/api/facebook', async (req, res) => {
  const tokens = loadTokensCompat();
  if (!tokens || !tokens.pageId) {
    return res.json({ status: 'pending' });
  }

  try {
    const fbData = await cached('facebook', 15 * 60 * 1000, async () => {
      const { pageToken, pageId } = tokens;
      const base = `https://graph.facebook.com/${CONFIG.META_API_VERSION}`;

      // Page info
      let pageInfo = {};
      try {
        const { data } = await axios.get(`${base}/${pageId}`, {
          params: { fields: 'name,fan_count,about,link,followers_count,new_like_count', access_token: pageToken },
        });
        pageInfo = data;
      } catch (e) {
        console.warn('[Facebook] Page info error:', e.response?.data?.error?.message || e.message);
      }

      // Skip own page posts — only external mentions matter
      let posts = [];

      // Tagged posts (posts by others that tag the page)
      let mentions = [];
      try {
        const { data } = await axios.get(`${base}/${pageId}/tagged`, {
          params: {
            fields: 'message,created_time,permalink_url,from',
            limit: 25,
            access_token: pageToken,
          },
        });
        // Filter out spam, phishing, empty reshares, non-English, scientific papers
        const FB_SPAM = ['unusual activity','final warning','detected a lot','enable advanced security',
          'your profile will be','account will be disabled','verify your account','click here to verify',
          '𝖥𝖨𝖭𝖠𝖫','𝖣𝖤𝖳𝖤𝖢𝖳','𝖾𝗅 𝖽𝖾𝗉𝖺𝗋𝗍','𝗇𝗈𝗍𝗂𝖿𝗂𝖼𝖺',
          'polyamine','epidermal function','controlled changes'];
        mentions = (data.data || [])
          .filter(p => {
            if (!p.message || p.message.length < 15) return false;
            const msg = p.message;
            const lower = msg.toLowerCase();
            // Filter spam
            if (FB_SPAM.some(s => lower.includes(s) || msg.includes(s))) return false;
            // Filter empty reshares (just the brand name, nothing else)
            if (lower.trim() === 'skin research institute') return false;
            // Filter non-English (Spanish, etc.)
            if (lower.includes('¿') || lower.includes('¡') || lower.includes('también')) return false;
            return true;
          })
          .map((p, i) => ({
            id:          `fb-tag-${p.id || i}`,
            type:        'social',
            platform:    'facebook',
            sourceName:  p.from?.name || 'Facebook User',
            title:       (p.message || 'Tagged in a post').slice(0, 120),
            description: p.message || '',
            url:         p.permalink_url || '',
            date:        p.created_time || new Date().toISOString(),
            sentiment:   analyzeSentiment(p.message || ''),
          }));
      } catch (e) {
        console.warn('[Facebook] Tagged error:', e.response?.data?.error?.message || e.message);
      }

      // Page reviews/ratings
      let reviews = [];
      try {
        const { data } = await axios.get(`${base}/${pageId}/ratings`, {
          params: {
            fields: 'review_text,rating,reviewer,created_time',
            limit: 50,
            access_token: pageToken,
          },
        });
        reviews = (data.data || [])
          .filter(r => r.review_text && r.review_text.length > 15)
          .map((r, i) => ({
            id:          `fb-review-${i}-${Date.now()}`,
            type:        'social',
            platform:    'facebook',
            sourceName:  r.reviewer?.name || 'Facebook Review',
            title:       (r.review_text || '').slice(0, 120),
            description: r.review_text || '',
            url:         '',
            date:        r.created_time || new Date().toISOString(),
            sentiment:   analyzeSentiment(r.review_text || ''),
            rating:      r.rating,
          }));
        console.log(`[Facebook] ${reviews.length} reviews`);
      } catch (e) {
        console.warn('[Facebook] Reviews error:', e.response?.data?.error?.message || e.message);
      }

      return {
        status: 'connected',
        page: {
          name:      pageInfo.name || '',
          fans:      pageInfo.fan_count || 0,
          followers: pageInfo.followers_count || 0,
          about:     pageInfo.about || '',
          link:      pageInfo.link || '',
        },
        posts,
        mentions,
        reviews,
      };
    });

    console.log(`[Facebook] ${fbData.mentions?.length || 0} mentions, ${fbData.reviews?.length || 0} reviews`);
    res.json(fbData);
  } catch (err) {
    console.error('[Facebook] Error:', err.message);
    res.json({ status: 'error', message: err.message });
  }
});

// ── API: HISTORY (persistent stored mentions) ─────────────────────────────────
app.get('/api/history', (req, res) => {
  const days = req.query.days ? parseInt(req.query.days) : null;
  const mentions = getHistoricalMentions(days);
  console.log(`[History] ${mentions.length} stored mentions (${days ? days + 'd' : 'all'})`);
  res.json(mentions);
});

// ── START ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   SRI Labs PR Intelligence Dashboard  v2.0              ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`\n  Server     → http://localhost:${PORT}`);
  console.log(`  Keywords   → ${CONFIG.KEYWORDS.join(', ')}`);
  console.log(`  Alerts     → ${CONFIG.GOOGLE_ALERT_FEEDS.length} Google Alert feeds`);
  console.log(`  Websites   → ${CONFIG.WEBSITES.map(w => w.baseUrl).join(', ')}`);
  const tokens = loadTokensCompat();
  console.log(`  Reddit     → free (no key needed)`);
  console.log(`  Google News→ free (RSS feeds)`);
  console.log(`  Bing News  → ${CONFIG.BING_API_KEY ? 'configured' : 'add BING_API_KEY to .env (optional)'}`);
  console.log(`  Instagram  → @${CONFIG.INSTAGRAM_HANDLE} (${tokens?.igAccountId ? 'connected' : 'pending → visit /auth/meta'})`);
  console.log(`  Facebook   → ${tokens?.pageId ? 'connected (' + (tokens.pageName || tokens.pageId) + ')' : 'pending → visit /auth/meta'}`);
  console.log();
});
