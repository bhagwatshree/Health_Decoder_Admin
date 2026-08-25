# Health Decoder — Admin Cost Dashboard

Local-only dashboard showing estimated AWS, Gemini, Sarvam, and Firebase spend for the
[HealthDecoder backend](https://github.com/bhagwatshree/HealthDecoder). Kept in its own repo,
deliberately separate from the main app — it reads production data and AWS credentials.

Repo: [github.com/bhagwatshree/Health_Decoder_Admin](https://github.com/bhagwatshree/Health_Decoder_Admin)

## Setup

```bash
npm install
cp .env.example .env
openssl rand -base64 24   # paste into DASHBOARD_PASSWORD
npm start                 # http://localhost:4300
```

Fill in `DATABASE_URL` (the same Neon DB the backend uses — prefer the **pooled**
`-pooler` endpoint) and `DASHBOARD_USER` / `DASHBOARD_PASSWORD`. The server refuses to
start without credentials; set `DASHBOARD_AUTH_DISABLED=true` to skip auth on localhost.

Requires AWS CLI credentials already configured on this machine (`aws configure`) with
CloudWatch read access to the `medical-scanner` stack's region — used to estimate Lambda/API
Gateway cost, since Gemini/Sarvam/Firebase have no billing API for personal API keys.

## Access control

Every route — the API and the static frontend — sits behind HTTP Basic Auth
(`lib/auth.js`). This dashboard exposes production cost, customer, and fraud data, so
auth fails closed rather than defaulting to open. Before putting it on any public host,
also confirm the summary cache TTL is sane and that `.env` is not committed.

## Caching

`/api/summary` is cached in memory per `days` value (`SUMMARY_CACHE_TTL_MS`, default 5
minutes), with concurrent misses deduped into a single upstream fetch. Each miss costs
~15 Postgres queries plus CloudWatch `GetMetricData` calls, which are billed per metric
($0.01/1,000) and **excluded from the CloudWatch free tier** — so the cache is a cost
control, not just a latency win. Responses carry `cached` and `cachedAt` fields.

The cache is per-process: on a scale-to-zero host each container keeps its own copy.

## What it shows

- Daily cost by provider (stacked chart)
- Cost by operation (ocr, chat, tts, compare, detailed-analysis, ...) and by model
- AWS Lambda free-tier usage this month
- Firebase phone-auth free-tier usage this month
- Rule-based optimization suggestions (see `lib/optimize.js`)

## Caveats

All costs are **estimates**, not real invoices:
- Gemini/Sarvam/Firebase costs are computed at request time from published list prices
  (`backend/pricing.js` in the [HealthDecoder](https://github.com/bhagwatshree/HealthDecoder)
  repo) — there's no billing API for personal API keys to cross-check against.
- AWS cost is derived from CloudWatch Lambda/API Gateway metrics, assuming the function's
  configured memory (512MB) for every invocation — CloudWatch doesn't report actual memory
  used without Lambda Insights enabled.

See `lib/pricing.js` for the AWS rate assumptions and when they were last verified.
