import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchTranscript } from 'youtube-transcript';
import { Innertube } from 'youtubei.js';
import { z } from 'zod';
import { getActiveProvider, normalizeSummary, summarize } from './ai.js';

const app = express();
const port = process.env.PORT || 8787;

const requestSchema = z.object({
  query: z.string().min(2),
  videoUrl: z.string().optional().default(''),
  sources: z.array(z.enum(['youtube', 'reddit', 'wikipedia', 'imdb'])).min(1),
});

app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  try {
    const provider = getActiveProvider();
    res.json({ ok: true, provider: provider.id, model: provider.model, cloud: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI not configured';
    res.status(503).json({ ok: false, error: message });
  }
});

app.post('/api/analyze', async (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Please provide a valid query and at least one source.' });
  }

  try {
    const { query, videoUrl, sources } = parsed.data;
    const collected = { youtube: [], reddit: [], wikipedia: [], imdb: [] };
    const references = [];
    const sourceErrors = {};

    const tasks = [];

    if (sources.includes('youtube') && videoUrl.trim()) {
      tasks.push(
        readYouTube(videoUrl)
          .then((data) => ({ source: 'youtube', data }))
          .catch((err) => {
            sourceErrors.youtube = err instanceof Error ? err.message : 'YouTube fetch failed';
            return { source: 'youtube', data: { texts: [], links: [] } };
          }),
      );
    }
    if (sources.includes('reddit')) {
      tasks.push(
        readReddit(query)
          .then((data) => ({ source: 'reddit', data }))
          .catch((err) => {
            sourceErrors.reddit = err instanceof Error ? err.message : 'Reddit fetch failed';
            return { source: 'reddit', data: { texts: [], links: [] } };
          }),
      );
    }
    if (sources.includes('wikipedia')) {
      tasks.push(
        readWikipedia(query)
          .then((data) => ({ source: 'wikipedia', data }))
          .catch((err) => {
            sourceErrors.wikipedia = err instanceof Error ? err.message : 'Wikipedia fetch failed';
            return { source: 'wikipedia', data: { texts: [], links: [] } };
          }),
      );
    }
    if (sources.includes('imdb')) {
      tasks.push(
        readImdb(query)
          .then((data) => ({ source: 'imdb', data }))
          .catch((err) => {
            sourceErrors.imdb = err instanceof Error ? err.message : 'IMDb fetch failed';
            return { source: 'imdb', data: { texts: [], links: [] } };
          }),
      );
    }

    const settled = await Promise.all(tasks);
    for (const { source, data } of settled) {
      collected[source] = data.texts;
      references.push(...data.links);
    }

    const totalItems = Object.values(collected).reduce((sum, items) => sum + items.length, 0);
    if (totalItems === 0) {
      const tried = sources.join(', ');
      const empty = sources.filter((s) => !(collected[s]?.length)).join(', ');
      return res.status(400).json({
        error: `No data found from selected sources (${tried}). Reddit can take 10-30s. Retry, or try fewer keywords (e.g. "Seminyak Bali"). Empty: ${empty}.`,
        sourceErrors,
        stats: Object.fromEntries(sources.map((s) => [s, collected[s]?.length || 0])),
      });
    }

    const { summary: raw, provider, model } = await summarize({ query, collected, references });
    const summary = normalizeSummary(raw, references, collected, query);

    const counts = Object.fromEntries(
      Object.entries(collected).map(([key, value]) => [key, value.length]),
    );

    const sourcesUsed = Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([name]) => name);

    const sourceBreakdown = sourcesUsed.map((source) => ({
      source,
      signals: counts[source] || 0,
      links: references.filter((ref) => ref.source === source),
    }));

    return res.json({
      query,
      summary,
      provider,
      model,
      stats: counts,
      totalSignals: totalItems,
      sourcesUsed,
      referenceCount: references.length,
      references,
      sourceBreakdown,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected server error';
    return res.status(500).json({ error: message });
  }
});

function extractVideoId(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const parts = parsed.pathname.split('/').filter(Boolean);

    if (host.includes('youtu.be')) return parts[0] || null;
    if (parsed.searchParams.get('v')) return parsed.searchParams.get('v');

    const shortsIndex = parts.indexOf('shorts');
    if (shortsIndex >= 0 && parts[shortsIndex + 1]) return parts[shortsIndex + 1];

    const embedIndex = parts.indexOf('embed');
    if (embedIndex >= 0 && parts[embedIndex + 1]) return parts[embedIndex + 1];

    return parts[0] || null;
  } catch {
    return null;
  }
}

async function readComments(info) {
  try {
    const commentsPage = await info.getComments();
    const items = commentsPage?.contents || [];
    return items
      .map((item) => item?.content?.toString?.() || '')
      .filter(Boolean)
      .slice(0, 120);
  } catch {
    return [];
  }
}

async function readTranscript(videoId) {
  try {
    const lines = await fetchTranscript(videoId);
    return lines.map((entry) => entry.text).filter(Boolean).slice(0, 200);
  } catch {
    return [];
  }
}

async function readYouTube(videoUrl) {
  const videoId = extractVideoId(videoUrl);
  if (!videoId) throw new Error('Could not read video ID from URL.');

  const yt = await Innertube.create();
  const info = await yt.getInfo(videoId);
  const basic = info.basic_info;
  let comments = await readComments(info);
  if (!comments.length) comments = await readYouTubeCommentsApi(videoId);
  const transcript = await readTranscript(videoId);

  const texts = [
    ...comments.map((c) => `[YT comment] ${c}`),
    ...transcript.slice(0, 80).map((t) => `[YT transcript] ${t}`),
  ];

  return {
    texts: texts.slice(0, 200),
    links: [{
      title: basic?.title || 'YouTube video',
      url: `https://www.youtube.com/watch?v=${videoId}`,
      source: 'youtube',
      snippet: `${comments.length} comments · ${transcript.length} transcript lines`,
    }],
    meta: { comments: comments.length, transcript: transcript.length },
  };
}

async function readYouTubeCommentsApi(videoId) {
  const key = process.env.DEMO_YOUTUBE_API_KEY || process.env.YOUTUBE_API_KEY;
  if (!key) return [];
  try {
    const url = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${videoId}&maxResults=50&order=relevance&textFormat=plainText&key=${key}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.items || [])
      .map((item) => item?.snippet?.topLevelComment?.snippet?.textDisplay)
      .filter(Boolean)
      .slice(0, 80);
  } catch {
    return [];
  }
}

function fetchWithTimeout(url, ms = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function readReddit(query) {
  const searches = [query];
  if (isTravelQuery(query)) {
    const core = stripSearchFiller(query);
    if (core) searches.push(core);
    if (core && core !== query) searches.push(`${core} alternative better`);
  }

  const posts = [];
  const seen = new Set();

  const batches = await Promise.allSettled(
    [...new Set(searches)].map(async (q) => {
      const url = `https://api.pullpush.io/reddit/search/submission/?q=${encodeURIComponent(q)}&size=12&sort=desc&sort_type=score`;
      const result = await fetchWithTimeout(url, 35000);
      if (!result.ok) return [];
      const data = await result.json();
      return data?.data || [];
    }),
  );

  for (const batch of batches) {
    if (batch.status !== 'fulfilled') continue;
    for (const post of batch.value) {
      const key = post.permalink || post.url || post.title;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      posts.push(post);
    }
  }

  if (!posts.length) throw new Error('Reddit returned no posts (PullPush may be slow. Retry in a moment).');

  try {
    const texts = posts
      .flatMap((post) => {
        const parts = [];
        if (post.title) parts.push(`[Reddit title] ${post.title}`);
        if (post.selftext) parts.push(`[Reddit body] ${post.selftext.slice(0, 500)}`);
        return parts;
      })
      .slice(0, 100);
    const links = [
      {
        title: `Reddit discussions for "${query}"`,
        url: `https://www.reddit.com/search/?q=${encodeURIComponent(query)}`,
        source: 'reddit',
      },
      ...posts.slice(0, 6).map((post) => ({
        title: post.title || 'Reddit post',
        url: post.permalink ? `https://www.reddit.com${post.permalink}` : post.url,
        source: 'reddit',
        snippet: (post.selftext || '').slice(0, 100),
      })).filter((l) => l.url),
    ];
    return { texts, links };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Reddit fetch failed';
    throw new Error(message);
  }
}

function isTravelQuery(query) {
  return /visit|worth|spot|place|temple|beach|itinerary|travel|tourist|reviews?|destination/i.test(query);
}

function stripSearchFiller(query) {
  return query
    .replace(/\b(worth visiting|worth it|reviews?|travel experience|tourist reviews?|is it good|should i visit|better alternative)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function wikiSearchTerms(query) {
  const stripped = stripSearchFiller(query);
  const terms = new Set([query, stripped].filter(Boolean));
  const words = stripped.split(/\s+/).filter((w) => w.length > 2);
  if (words.length >= 2) terms.add(words.slice(0, 2).join(' '));
  if (words[0]?.length >= 4) terms.add(words[0]);
  return [...terms];
}

function refineWikiQuery(query) {
  const stripped = stripSearchFiller(query);
  return stripped || query;
}

function pickBestWikiResult(query, results) {
  const blocked = /disambiguation|list of /i;
  const filtered = results.filter((r) => r.title && !blocked.test(r.title));
  if (!filtered.length) return results[0];

  const stripped = stripSearchFiller(query);
  const words = stripped.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const primary = words[0] || '';
  const q = stripped.toLowerCase().trim();

  const scored = filtered.map((r) => {
    const title = r.title.toLowerCase();
    let score = 0;
    if (title === q) score += 12;
    if (primary && title === primary) score += 10;
    if (primary && title.includes(primary)) score += 6;
    for (const term of words) {
      if (title.includes(term)) score += 2;
    }
    if (r.snippet) {
      const snippet = r.snippet.toLowerCase();
      for (const term of words) {
        if (snippet.includes(term)) score += 1;
      }
    }
    return { r, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.r || filtered[0];
}

async function readWikipedia(query) {
  try {
    const searchTerms = wikiSearchTerms(query);
    const results = [];

    for (const term of searchTerms) {
      const searchRes = await fetchWithTimeout(
        `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(term)}&format=json&origin=*`,
        15000,
      );
      if (!searchRes.ok) continue;
      const searchData = await searchRes.json();
      results.push(...(searchData?.query?.search || []));
    }

    const unique = [...new Map(results.map((r) => [r.title, r])).values()];
    const first = pickBestWikiResult(query, unique);
    if (!first?.title) throw new Error('Wikipedia returned no matching page.');

    const summaryRes = await fetchWithTimeout(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(first.title)}`,
      15000,
    );
    const title = first.title;
    const pageUrl = `https://en.wikipedia.org/wiki/${title.replace(/ /g, '_')}`;
    const links = [{ title, url: pageUrl, source: 'wikipedia' }];

    if (!summaryRes.ok) {
      return {
        texts: [`[Wikipedia title] ${title}`],
        links,
      };
    }

    const summary = await summaryRes.json();
    const resolvedUrl = summary?.content_urls?.desktop?.page || pageUrl;
    links[0] = {
      title: summary?.title || title,
      url: resolvedUrl,
      source: 'wikipedia',
      snippet: (summary?.extract || '').slice(0, 120),
    };

    return {
      texts: [
        `[Wikipedia title] ${summary?.title || title}`,
        `[Wikipedia extract] ${summary?.extract || ''}`,
      ].filter(Boolean),
      links,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Wikipedia fetch failed';
    throw new Error(message);
  }
}

async function readImdb(query) {
  try {
    const firstChar = query.trim().charAt(0).toLowerCase() || 'a';
    const suggestUrl = `https://v3.sg.media-imdb.com/suggestion/${firstChar}/${encodeURIComponent(query)}.json`;
    const suggestRes = await fetch(suggestUrl);
    if (!suggestRes.ok) return { texts: [], links: [] };
    const suggestData = await suggestRes.json();
    const items = suggestData?.d || [];
    const q = query.toLowerCase();
    const top =
      items.find((item) => item.qid === 'movie' && item.l?.toLowerCase().includes(q.split(' ')[0])) ||
      items.find((item) => item.qid === 'movie') ||
      items[0];
    if (!top) return { texts: [], links: [] };

    const texts = [
      `[IMDb title] ${top.l || ''}`,
      `[IMDb year/type] ${top.y || ''} ${top.q || ''}`.trim(),
      `[IMDb cast] ${(top.s || '').toString()}`,
    ].filter(Boolean);

    const imdbUrl = top.id?.startsWith('tt')
      ? `https://www.imdb.com/title/${top.id}/`
      : `https://www.imdb.com/find/?q=${encodeURIComponent(query)}`;

    return {
      texts,
      links: [{
        title: `${top.l || query} on IMDb`,
        url: imdbUrl,
        source: 'imdb',
        snippet: `${top.y || ''} · ${top.q || ''}`.trim(),
      }],
    };
  } catch {
    return { texts: [], links: [] };
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.join(__dirname, '..', 'dist');

if (existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

app.listen(port, () => {
  const provider = getActiveProvider();
  console.log(`Review AI server on http://localhost:${port} [${provider.name} / ${provider.model}]`);
});
