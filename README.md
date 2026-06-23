# ReviewLens MVP

Multi-source review analyzer (YouTube, Reddit, Wikipedia, IMDb) with pluggable AI.

## AI providers (pick one)

| Provider | Best for | Free key |
|----------|----------|----------|
| **Groq** (recommended) | Fast responses, reliable JSON | [console.groq.com](https://console.groq.com) |
| **Gemini** | Best summaries, generous quota | [aistudio.google.com](https://aistudio.google.com/apikey) |
| **OpenRouter** | Many model options | [openrouter.ai](https://openrouter.ai/keys) |

Cloud AI only. At least one API key is required (no local Ollama).

Auto-priority if `DEMO_AI_PROVIDER` is not set: Groq, then Gemini, then OpenRouter.

## Local setup

```bash
cp .env.example .env
# Add ONE key to .env, e.g.:
# DEMO_GROQ_API_KEY=gsk_...

npm install
npm run dev:all
```

Open `http://localhost:5173`.

## Env vars

```bash
DEMO_AI_PROVIDER=groq          # optional: groq | gemini | openrouter
DEMO_GROQ_API_KEY=...
DEMO_GEMINI_API_KEY=...
DEMO_OPENROUTER_API_KEY=...
```

Non-prefixed names (`GROQ_API_KEY`, etc.) still work as fallback.

## Deploy for $0 (Render free tier)

**Railway is not fully free** (trial credits, then paid). For zero spend, use **Render**:

| | Render free | Railway |
|--|-------------|---------|
| Cost | **$0**, no credit card | Trial credits, then ~$5/mo |
| Catch | Sleeps after 15 min idle, first load ~30-60s | More reliable when paid |

### Steps

1. Push this repo to GitHub (never commit `.env`).
2. Sign up at [render.com](https://render.com) with GitHub (no card needed for free tier).
3. **New > Blueprint** and connect the repo (uses `render.yaml`), **or** **New Web Service**:
   - **Build command:** `npm install && npm run build`
   - **Start command:** `npm start`
4. In Render **Environment**, add:
   - `DEMO_GROQ_API_KEY` = your Groq key
   - `DEMO_AI_PROVIDER` = `groq`
5. Deploy. Open the `*.onrender.com` URL.

**Before recording a demo:** open the URL once and wait ~60s for the cold start, then run your search.

### Production note

`npm start` runs Express and serves the built React app from `dist/` on one URL. API routes stay at `/api/*`.
