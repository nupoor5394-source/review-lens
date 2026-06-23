const providers = {
  groq: {
    name: 'Groq',
    model: env('GROQ_MODEL') || 'llama-3.3-70b-versatile',
    keyName: 'GROQ_API_KEY',
  },
  gemini: {
    name: 'Gemini',
    model: env('GEMINI_MODEL') || 'gemini-2.0-flash',
    keyName: 'GEMINI_API_KEY',
  },
  openrouter: {
    name: 'OpenRouter',
    model: env('OPENROUTER_MODEL') || 'meta-llama/llama-3.1-8b-instruct:free',
    keyName: 'OPENROUTER_API_KEY',
  },
};

function env(name) {
  return process.env[`DEMO_${name}`] || process.env[name];
}

export function getActiveProvider() {
  const forced = env('AI_PROVIDER')?.toLowerCase();
  if (forced === 'ollama') {
    throw new Error(
      'Local Ollama is disabled. Set DEMO_GROQ_API_KEY (recommended), DEMO_GEMINI_API_KEY, or DEMO_OPENROUTER_API_KEY in .env.',
    );
  }

  if (forced) {
    const provider = providers[forced];
    if (!provider) {
      throw new Error(`Unknown AI provider "${forced}". Use groq, gemini, or openrouter.`);
    }
    if (provider.keyName && !env(provider.keyName)) {
      throw new Error(`Set DEMO_${provider.keyName} in .env to use ${provider.name}.`);
    }
    return { id: forced, ...provider };
  }

  if (env('GROQ_API_KEY')) return { id: 'groq', ...providers.groq };
  if (env('GEMINI_API_KEY')) return { id: 'gemini', ...providers.gemini };
  if (env('OPENROUTER_API_KEY')) return { id: 'openrouter', ...providers.openrouter };

  throw new Error(
    'No cloud AI key configured. Add DEMO_GROQ_API_KEY to .env (free at https://console.groq.com).',
  );
}

export function classifyQuery(query, collected = {}) {
  const q = query.toLowerCase();
  const imdbEvidence = (collected.imdb || []).length > 0;
  const wikiText = (collected.wikipedia || []).join(' ').toLowerCase();
  const wikiFilm = /\b(film|movie|directed by|box office)\b/.test(wikiText);

  const movieSignals =
    /\b(movie|film|cinema|series|show|imdb)\b/i.test(q) || imdbEvidence || wikiFilm;
  const placeSignals =
    /visit|worth|spot|place|temple|beach|itinerary|travel|tourist|destination|restaurant|hotel|resort|nightlife|city|country|island|town|village/i.test(
      q,
    );

  if (movieSignals && !placeSignals) return 'movie';
  if (placeSignals) return 'place';
  return 'general';
}

function buildPrompt(query, collected, references = []) {
  const sourceText = Object.entries(collected)
    .map(([source, items]) => `SOURCE ${source.toUpperCase()}:\n${items.slice(0, 80).join('\n') || 'No data'}`)
    .join('\n\n')
    .slice(0, 24000);

  const citeCatalog = references
    .slice(0, 20)
    .map((ref, i) => `[${i + 1}] ${ref.source} | ${ref.title} | ${ref.url}`)
    .join('\n');

  const queryType = classifyQuery(query, collected);
  const isPlaceQuery = queryType === 'place';

  const alternativeRules = isPlaceQuery
    ? `- For travel/place queries with verdict Mixed or Avoid only: include 1-2 alternatives that name other specific places from the evidence.
- If verdict is Go for it, return "alternatives": [].
- Each alternative must name a real place (city, beach, temple, neighborhood, etc.), not a vague quote.`
    : `- For movie or general queries: always return "alternatives": [].`;

  const summaryGoal = isPlaceQuery
    ? 'should user visit this place? what do others say?'
    : 'should user watch or skip this? what do others say?';

  return `
You are an unbiased review analyst for movies and travel destinations.
Analyze multi-source feedback and return strict JSON only.
Every highlight, complaint, and red flag MUST cite a real URL from the citation catalog when possible.

User query: ${query}
Query type: ${queryType}

Citation catalog (use citeUrl exactly from here):
${citeCatalog || 'No citation URLs available — set source only.'}

Collected evidence:
${sourceText}

Return JSON with this schema:
{
  "verdict": "Go for it" | "Mixed" | "Avoid",
  "sentiment": "Positive" | "Neutral" | "Negative",
  "shouldGo": boolean,
  "why": "3-4 sentence executive summary: ${summaryGoal}",
  "highlights": [{ "text": "specific positive", "source": "reddit|wikipedia|imdb|youtube", "citeUrl": "url from catalog", "citeTitle": "title from catalog" }],
  "complaints": [{ "text": "specific negative", "source": "reddit|wikipedia|imdb|youtube", "citeUrl": "url from catalog", "citeTitle": "title from catalog" }],
  "watchOut": [{ "text": "caveat or risk", "source": "reddit|wikipedia|imdb|youtube", "citeUrl": "url from catalog", "citeTitle": "title from catalog" }],
  "alternatives": [{ "text": "other specific place to visit instead and why", "source": "reddit|wikipedia", "citeUrl": "url from catalog", "citeTitle": "title from catalog" }],
  "confidence": number
}
Rules:
- Never return empty highlights and complaints together if evidence exists.
- Include at least 2 highlights and 1 complaint when evidence supports it.
${alternativeRules}
- Each item must be grounded in evidence, not generic.`.trim();
}

function cleanJsonText(content) {
  return content
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function parseJson(content) {
  if (!content) throw new Error('AI returned an empty response.');

  const cleaned = cleanJsonText(content);
  const candidates = [
    cleaned,
    cleaned.match(/\{[\s\S]*\}/)?.[0],
    cleaned.replace(/,\s*([}\]])/g, '$1'),
    cleaned.replace(/'/g, '"'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try next cleanup strategy
    }
  }

  throw new Error('AI response was not valid JSON. Try again or switch provider.');
}

function buildSimplePrompt(query, collected, references = []) {
  const sourceText = Object.entries(collected)
    .map(([source, items]) => `${source.toUpperCase()}:\n${items.slice(0, 40).join('\n')}`)
    .join('\n\n')
    .slice(0, 12000);

  return `Return JSON only for query "${query}".
Evidence:
${sourceText}

Schema:
{"verdict":"Go for it|Mixed|Avoid","sentiment":"Positive|Neutral|Negative","shouldGo":true,"why":"summary","highlights":["..."],"complaints":["..."],"watchOut":["..."],"alternatives":["..."],"confidence":7}`;
}

async function callGroq(prompt) {
  const key = env('GROQ_API_KEY');
  if (!key) throw new Error('Set DEMO_GROQ_API_KEY in .env (free at console.groq.com).');

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: providers.groq.model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Return valid JSON only.' },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Groq error: ${await res.text()}`);
  const data = await res.json();
  return parseJson(data.choices?.[0]?.message?.content);
}

async function callGemini(prompt) {
  const key = env('GEMINI_API_KEY');
  if (!key) throw new Error('Set DEMO_GEMINI_API_KEY in .env (free at aistudio.google.com).');

  const model = providers.gemini.model;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini error: ${await res.text()}`);
  const data = await res.json();
  return parseJson(data.candidates?.[0]?.content?.parts?.[0]?.text);
}

async function callOpenRouter(prompt) {
  const key = env('OPENROUTER_API_KEY');
  if (!key) throw new Error('Set DEMO_OPENROUTER_API_KEY in .env (free at openrouter.ai).');

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:5173',
      'X-Title': 'ReviewLens',
    },
    body: JSON.stringify({
      model: providers.openrouter.model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'Return valid JSON only.' },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter error: ${await res.text()}`);
  const data = await res.json();
  return parseJson(data.choices?.[0]?.message?.content);
}

const callers = { groq: callGroq, gemini: callGemini, openrouter: callOpenRouter };

export async function summarize({ query, collected, references = [] }) {
  const provider = getActiveProvider();
  const prompt = buildPrompt(query, collected, references);

  try {
    const raw = await callers[provider.id](prompt);
    return { summary: raw, provider: provider.id, model: provider.model };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (!message.includes('JSON') && !message.includes('empty')) throw error;

    const fallback = buildSimplePrompt(query, collected, references);
    const raw = await callers[provider.id](fallback);
    return { summary: raw, provider: provider.id, model: provider.model };
  }
}

function normalizeCitedItems(items, references) {
  const rawList = Array.isArray(items) ? items : toList(items);
  const usedRefs = new Set();

  return rawList
    .map((item, index) => {
      if (typeof item === 'string') {
        const ref = references.find((r) => !usedRefs.has(r.url) && r.source === 'reddit')
          || references.find((r) => !usedRefs.has(r.url))
          || references[index % Math.max(references.length, 1)];
        if (ref) usedRefs.add(ref.url);
        return {
          text: item,
          source: ref?.source || '',
          citeTitle: ref?.title || '',
          citeUrl: ref?.url || '',
        };
      }

      const text = item.text || item.point || item.claim || '';
      let source = item.source || '';
      let citeUrl = item.citeUrl || item.url || '';
      let citeTitle = item.citeTitle || item.title || '';

      const byUrl = references.find((ref) => ref.url === citeUrl);
      const bySource = references.find((ref) => ref.source === source && !usedRefs.has(ref.url));
      const fallback = references.find((ref) => !usedRefs.has(ref.url));
      const match = byUrl || bySource || fallback;

      if (match) {
        usedRefs.add(match.url);
        source = source || match.source;
        citeUrl = citeUrl || match.url;
        citeTitle = citeTitle || match.title;
      }

      return { text, source, citeTitle, citeUrl };
    })
    .filter((item) => item.text);
}

export function toList(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

export function normalizeSummary(raw, references = [], collected = {}, query = '') {
  const totalEvidence = Object.values(collected).flat().length;
  let confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence) || confidence <= 0) confidence = totalEvidence > 5 ? 6 : 4;

  const queryType = classifyQuery(query, collected);
  const verdict = raw.verdict || 'Mixed';

  let highlights = normalizeCitedItems(raw.highlights || raw.pros, references);
  let complaints = normalizeCitedItems(raw.complaints || raw.cons, references);
  let watchOut = normalizeCitedItems(raw.watchOut, references);
  let alternatives = normalizeCitedItems(raw.alternatives, references);

  if (!highlights.length) highlights = fallbackFromEvidence(collected, references, 'positive');
  if (!complaints.length) complaints = fallbackFromEvidence(collected, references, 'negative');
  if (!highlights.length && raw.why) highlights = citedFromWhy(raw.why, references, 0, 2);
  if (!complaints.length && raw.why) complaints = citedFromWhy(raw.why, references, 1, 2);
  if (!watchOut.length) {
    watchOut = citedFromWhy(raw.why || 'Cross-check with more sources before deciding.', references, 0, 1);
  }

  if (queryType === 'place' && (verdict === 'Mixed' || verdict === 'Avoid')) {
    alternatives = alternatives.filter(looksLikePlaceAlternative);
    if (!alternatives.length) {
      alternatives = alternativesFromEvidence(collected, references);
    }
  } else {
    alternatives = [];
  }

  return {
    verdict,
    sentiment: raw.sentiment || 'Neutral',
    shouldGo: Boolean(raw.shouldGo),
    why: raw.why || 'No summary available.',
    highlights,
    complaints,
    watchOut,
    alternatives,
    queryType,
    confidence,
  };
}

function looksLikePlaceAlternative(item) {
  const text = item?.text || '';
  return /\b(beach|temple|island|village|town|city|region|area|spot|place|resort|neighborhood|district|peninsula|valley|coast)\b/i.test(
    text,
  );
}

function alternativesFromEvidence(collected, references) {
  const placeCue =
    /\b(go to|visit|try|skip|instead|rather|alternative|overrated|crowded)\b/i;
  const locationCue =
    /\b(beach|temple|island|village|town|city|region|area|spot|place|resort|neighborhood|district|peninsula|valley|coast)\b/i;

  const snippets = Object.values(collected)
    .flat()
    .filter((line) => placeCue.test(line) && locationCue.test(line))
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, '').trim())
    .filter((line) => line.length > 25)
    .slice(0, 2);

  if (!snippets.length) return [];

  return snippets.map((text, index) => ({
    text: text.slice(0, 220),
    source: references[index]?.source || references[0]?.source || '',
    citeTitle: references[index]?.title || references[0]?.title || '',
    citeUrl: references[index]?.url || references[0]?.url || '',
  }));
}

function citedFromWhy(why, references, start, count) {
  const sentences = why.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 15);
  return sentences.slice(start, start + count).map((text, index) => ({
    text: text.trim(),
    source: references[index]?.source || references[0]?.source || '',
    citeTitle: references[index]?.title || references[0]?.title || '',
    citeUrl: references[index]?.url || references[0]?.url || '',
  }));
}

function fallbackFromEvidence(collected, references, tone) {
  const snippets = Object.values(collected).flat().slice(0, 6);
  const ref = references[0];
  if (!snippets.length) return [];

  const picks = snippets
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, '').trim())
    .filter((line) => line.length > 20)
    .slice(0, tone === 'positive' ? 2 : 1);

  return picks.map((text, index) => ({
    text: text.slice(0, 180),
    source: ref?.source || '',
    citeTitle: ref?.title || '',
    citeUrl: ref?.url || references[index % references.length]?.url || '',
  }));
}
