// ──────────────────────────────────────────────────────────────────────────────
//  SRI Labs PR Intelligence Dashboard — Server  v2.0
// ──────────────────────────────────────────────────────────────────────────────

const express  = require('express');
const axios    = require('axios');
const xml2js   = require('xml2js');
const cheerio  = require('cheerio');
const path     = require('path');
const fs       = require('fs');

try { require('dotenv').config(); } catch (_) {}

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CONFIGURATION ──────────────────────────────────────────────────────────────
const CONFIG = {
  NEWS_API_KEY: process.env.NEWS_API_KEY || '',

  BRAND: 'SRI Labs',

  KEYWORDS: [
    'SRI Labs',
    'DryQ',
    'StyleQ',
    'CurlQ',
    'RenewGlow',
    'KeeWee Shampoo',
    'StyleWrap Pro',
    'skin research institute',
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

// ── SENTIMENT ENGINE ───────────────────────────────────────────────────────────
const POSITIVE_WORDS = [
  'great','excellent','amazing','love','best','perfect','wonderful','outstanding',
  'fantastic','recommend','impressive','innovative','breakthrough','effective',
  'results','award','launch','growth','expansion','success','leading','quality',
  'popular','trusted','favorite','clinical','proven','featured','top','praised',
  'wins','partnership','deal','achievement','recognized','honored','celebrates',
];
const NEGATIVE_WORDS = [
  'bad','terrible','awful','hate','worst','poor','damage','complaint','problem',
  'issue','fail','failure','recall','lawsuit','defect','harmful','toxic','concern',
  'warning','danger','fake','scam','fraud','misleading','disappointed','avoid',
  'refund','broken','investigation','penalty','fine','ban','accused','scandal',
];

function analyzeSentiment(text) {
  const lower = (text || '').toLowerCase();
  let pos = 0, neg = 0;
  POSITIVE_WORDS.forEach(w => { if (lower.includes(w)) pos++; });
  NEGATIVE_WORDS.forEach(w => { if (lower.includes(w)) neg++; });
  if (pos > neg) return 'positive';
  if (neg > pos) return 'negative';
  return 'neutral';
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
    res.json(articles);
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
      return items;
    });
    console.log(`[Alerts] ${all.length} items`);
    res.json(all);
  } catch (err) {
    console.error('[Alerts] Error:', err.message);
    res.json([]);
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
    const { data: tokenData } = await axios.get(`${base}/oauth/access_token`, {
      params: {
        client_id: CONFIG.META_APP_ID, client_secret: CONFIG.META_APP_SECRET,
        redirect_uri: CONFIG.META_REDIRECT, code,
      },
    });
    const shortToken = tokenData.access_token;

    // Exchange → long-lived token (60 days)
    const { data: longData } = await axios.get(`${base}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: CONFIG.META_APP_ID, client_secret: CONFIG.META_APP_SECRET,
        fb_exchange_token: shortToken,
      },
    });
    const longToken = longData.access_token;

    // Get Facebook Pages
    const { data: pagesData } = await axios.get(`${base}/me/accounts`, {
      params: { access_token: longToken },
    });
    const pages = pagesData.data || [];
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

      // Page feed (own posts)
      let posts = [];
      try {
        const { data } = await axios.get(`${base}/${pageId}/feed`, {
          params: {
            fields: 'message,created_time,permalink_url,shares,full_picture,reactions.summary(true),comments.summary(true)',
            limit: 25,
            access_token: pageToken,
          },
        });
        posts = (data.data || []).filter(p => p.message).map((p, i) => ({
          id:          `fb-post-${p.id || i}`,
          type:        'social',
          platform:    'facebook',
          sourceName:  pageInfo.name || 'Facebook Page',
          title:       (p.message || '').slice(0, 120),
          description: p.message || '',
          url:         p.permalink_url || '',
          date:        p.created_time || new Date().toISOString(),
          sentiment:   analyzeSentiment(p.message || ''),
          image:       p.full_picture || null,
          engagement:  (p.reactions?.summary?.total_count || 0) + (p.comments?.summary?.total_count || 0) + (p.shares?.count || 0),
        }));
      } catch (e) {
        console.warn('[Facebook] Feed error:', e.response?.data?.error?.message || e.message);
      }

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
        mentions = (data.data || []).filter(p => p.message).map((p, i) => ({
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
      };
    });

    console.log(`[Facebook] ${fbData.posts?.length || 0} posts, ${fbData.mentions?.length || 0} mentions`);
    res.json(fbData);
  } catch (err) {
    console.error('[Facebook] Error:', err.message);
    res.json({ status: 'error', message: err.message });
  }
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
  console.log(`  Instagram  → @${CONFIG.INSTAGRAM_HANDLE} (${tokens?.igAccountId ? 'connected' : 'pending → visit /auth/meta'})`);
  console.log(`  Facebook   → ${tokens?.pageId ? 'connected (' + (tokens.pageName || tokens.pageId) + ')' : 'pending → visit /auth/meta'}`);
  console.log();
});
