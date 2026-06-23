import { useState } from 'react';
import type { FormEvent } from 'react';

const DEMOS = [
  { query: 'interstellar', sources: ['reddit', 'imdb', 'wikipedia'], label: '🎬 Interstellar' },
  { query: 'oppenheimer movie', sources: ['reddit', 'imdb', 'wikipedia'], label: '🎬 Oppenheimer' },
  { query: 'Kuta Bali tourist trap reviews', sources: ['reddit', 'wikipedia'], label: '⚠️ Kuta Bali' },
  { query: 'Kyoto Japan travel reviews', sources: ['reddit', 'wikipedia'], label: '🏯 Kyoto' },
  { query: 'Din Tai Fung restaurant reviews', sources: ['reddit', 'wikipedia'], label: '🍜 Din Tai Fung' },
];

type SourceRef = {
  title: string;
  url: string;
  source: string;
  snippet?: string;
};

type CitedItem = {
  text: string;
  source?: string;
  citeTitle?: string;
  citeUrl?: string;
};

type AnalysisResponse = {
  query: string;
  summary: {
    verdict: string;
    sentiment: string;
    shouldGo: boolean;
    why: string;
    highlights: CitedItem[];
    complaints: CitedItem[];
    watchOut: CitedItem[];
    alternatives: CitedItem[];
    queryType?: 'movie' | 'place' | 'general';
    confidence: number;
  };
  stats: Record<string, number>;
  totalSignals?: number;
  sourcesUsed?: string[];
  referenceCount?: number;
  references?: SourceRef[];
  sourceBreakdown?: { source: string; signals: number; links: SourceRef[] }[];
  provider?: string;
  model?: string;
};

function loadingLabel(selected: string[], yt: string) {
  const active = selected.filter((source) => source !== 'youtube' || yt.trim());
  const names: Record<string, string> = {
    youtube: 'YouTube',
    reddit: 'Reddit',
    wikipedia: 'Wikipedia',
    imdb: 'IMDb',
  };
  const labels = active.map((source) => names[source] || source);
  if (!labels.length) return 'Analyzing...';
  const joined = labels.length === 1 ? labels[0] : labels.join(' & ');
  return active.includes('reddit') ? `Searching ${joined} (10-30s)...` : `Searching ${joined}...`;
}

function App() {
  const [query, setQuery] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [sources, setSources] = useState<string[]>(['youtube', 'reddit', 'wikipedia', 'imdb']);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<AnalysisResponse | null>(null);

  const runAnalyze = async (q: string, selected: string[], yt = videoUrl) => {
    if (!selected.length) {
      setError('Select at least one source.');
      return;
    }
    if (selected.includes('youtube') && !yt.trim()) {
      setError('Paste a YouTube URL when YouTube is selected.');
      return;
    }
    setLoading(true);
    setError('');
    setResult(null);

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, videoUrl: yt, sources: selected }),
      });
      const raw = await response.text();
      let data: AnalysisResponse | { error?: string } = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error(
          response.status === 502 || response.status === 503
            ? 'Backend is not running. Run: npm run dev:all'
            : 'Server returned an invalid response.',
        );
      }
      if (!response.ok) {
        const err = 'error' in data ? data.error : undefined;
        throw new Error(err || 'Analysis failed. Check query and sources.');
      }
      setResult(data as AnalysisResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    runAnalyze(query, sources);
  };

  const loadDemo = (demo: (typeof DEMOS)[0]) => {
    setQuery(demo.query);
    setSources(demo.sources);
    setVideoUrl('');
    setResult(null);
    setError('');
  };

  return (
    <main className="page">
      <section className="card">
        <p className="eyebrow">ReviewLens</p>
        <h1>Multi-source review analyzer</h1>
        <p className="subtext">
        The crowd weighed in. Hype checked. Regret avoided.
        </p>

        <div className="demo-row">
          <span className="demo-label"></span>
          {DEMOS.map((demo) => (
            <button key={demo.label} type="button" className="demo-chip" onClick={() => loadDemo(demo)}>
              {demo.label}
            </button>
          ))}
        </div>

        <form onSubmit={onSubmit} className="form">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="e.g. Uluwatu temple reviews, Interstellar movie..."
            required
          />
          <input
            value={videoUrl}
            onChange={(event) => setVideoUrl(event.target.value)}
            placeholder="YouTube URL (required when YouTube is selected)"
          />
          <div className="source-pills">
            {['youtube', 'reddit', 'wikipedia', 'imdb'].map((source) => (
              <label key={source}>
                <input
                  type="checkbox"
                  checked={sources.includes(source)}
                  onChange={() =>
                    setSources((prev) =>
                      prev.includes(source) ? prev.filter((s) => s !== source) : [...prev, source],
                    )
                  }
                />
                {source}
              </label>
            ))}
          </div>
          <button type="submit" disabled={loading}>
            {loading ? loadingLabel(sources, videoUrl) : 'Analyze'}
          </button>
        </form>

        {error ? <p className="error">{error}</p> : null}
      </section>

      {result?.summary ? (
        <ResultPanel result={result} />
      ) : null}
    </main>
  );
}

function ResultPanel({ result }: { result: AnalysisResponse }) {
  const research = getResearchStats(result);
  const breakdown = getSourceBreakdown(result);
  const { summary } = result;

  return (
    <section className="card result">
      <div className="research-banner">
        <span className="research-icon">🔍</span>
        <div>
          <strong>Research complete</strong>
          <p>
            Read <b>{research.totalSignals}</b> data points (<em>signals</em>) from{' '}
            <b>{research.sourcesUsed.length}</b> platform{research.sourcesUsed.length === 1 ? '' : 's'} (<em>sources</em>)
            {research.referenceCount > 0 ? (
              <> · <b>{research.referenceCount}</b> citations below</>
            ) : null}
          </p>
          <p className="research-help">
            <b>Sources</b> = where we looked (Reddit, Wikipedia, IMDb, YouTube).{' '}
            <b>Signals</b> = individual pieces read (comments, posts, wiki text, metadata).
          </p>
        </div>
      </div>

      {breakdown.length ? (
        <div className="source-breakdown">
          <h3>Citations by source</h3>
          {breakdown.map((item) => (
            <article key={item.source} className="source-block">
              <div className="source-head">
                <span className={`ref-badge ref-${item.source}`}>{item.source}</span>
                <span className="signal-count">{item.signals} signals analyzed</span>
              </div>
              {item.links.length ? (
                <ul className="citation-list">
                  {item.links.map((link) => (
                    <li key={link.url + link.title}>
                      <a href={link.url} target="_blank" rel="noreferrer">{link.title}</a>
                      {link.snippet ? <span className="citation-snippet"> · {link.snippet}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="citation-snippet">Data fetched from {item.source}; no direct page link available.</p>
              )}
            </article>
          ))}
        </div>
      ) : null}

      <div className={`verdict-card verdict-${verdictClass(summary.verdict)}`}>
        <div>
          <p className="verdict-label">Final verdict</p>
          <h2>{summary.verdict}</h2>
          <p className="recommendation">
            {summary.shouldGo ? '✅ Recommended. Worth your time' : '⚠️ Proceed with caution'}
          </p>
        </div>
        <div className="verdict-stats">
          <div><span>Sentiment</span><b>{summary.sentiment}</b></div>
          <div><span>Confidence</span><b>{formatConfidence(summary.confidence)}%</b></div>
        </div>
      </div>

      <div className="executive-summary">
        <h3>Executive summary</h3>
        <p>{summary.why}</p>
      </div>

      <div className="grid">
        <CitedList title="✨ Highlights" items={summary.highlights} />
        <CitedList title="👎 Complaints" items={summary.complaints} />
        <CitedList title="🚩 Red flags" items={summary.watchOut} />
      </div>

      {summary.queryType === 'place' && summary.alternatives?.length ? (
        <div className="alternatives">
          <h3>🔄 Better places to try</h3>
          <p className="sources-note">Other spots people recommend instead of this one.</p>
          <CitedList title="" items={summary.alternatives} />
        </div>
      ) : null}
    </section>
  );
}

function getSourceBreakdown(result: AnalysisResponse) {
  if (result.sourceBreakdown?.length) {
    return result.sourceBreakdown.map((item) => ({
      ...item,
      links: item.links?.length ? item.links : (result.references || []).filter((ref) => ref.source === item.source),
    }));
  }

  return Object.entries(result.stats || {})
    .filter(([, count]) => count > 0)
    .map(([source, signals]) => ({
      source,
      signals,
      links: (result.references || []).filter((ref) => ref.source === source),
    }));
}

function getResearchStats(result: AnalysisResponse) {
  const totalSignals =
    result.totalSignals ??
    Object.values(result.stats || {}).reduce((sum, count) => sum + count, 0);

  const sourcesUsed =
    result.sourcesUsed?.length
      ? result.sourcesUsed
      : Object.entries(result.stats || {})
          .filter(([, count]) => count > 0)
          .map(([name]) => name);

  const referenceCount = result.referenceCount ?? result.references?.length ?? 0;

  return { totalSignals, sourcesUsed, referenceCount };
}

function verdictClass(verdict: string) {
  const v = verdict.toLowerCase();
  if (v.includes('go')) return 'go';
  if (v.includes('avoid')) return 'avoid';
  return 'mixed';
}

function formatConfidence(value: number) {
  if (value <= 1) return Math.round(value * 100);
  if (value <= 10) return Math.round(value * 10);
  return Math.round(value);
}

function CitedList({ title, items }: { title: string; items?: CitedItem[] }) {
  const list = Array.isArray(items) ? items : [];
  return (
    <article className={title ? '' : 'no-title'}>
      {title ? <h3>{title}</h3> : null}
      <ul className="cited-items">
        {list.length ? list.map((item, index) => (
          <li key={`${item.text}-${index}`}>
            <p className="cited-text">{item.text}</p>
            {item.citeUrl ? (
              <a className="cited-link" href={item.citeUrl} target="_blank" rel="noreferrer">
                {item.source ? <span className={`ref-badge ref-${item.source}`}>{item.source}</span> : null}
                {item.citeTitle || 'View source'}
              </a>
            ) : item.source ? (
              <span className={`ref-badge ref-${item.source}`}>{item.source}</span>
            ) : null}
          </li>
        )) : <li>No clear signal found.</li>}
      </ul>
    </article>
  );
}

export default App;
