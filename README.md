# Health Decoder — Admin Cost Dashboard

Local-only dashboard showing estimated AWS, Gemini, Sarvam, and Firebase spend for the
[HealthDecoder backend](https://github.com/bhagwatshree/HealthDecoder). Kept in its own repo,
deliberately separate from the main app — it reads production data and AWS credentials.

Repo: [github.com/bhagwatshree/Health_Decoder_Admin](https://github.com/bhagwatshree/Health_Decoder_Admin)

## Setup

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL (same Neon DB the backend uses)
npm start              # http://localhost:4300
```

Requires AWS CLI credentials already configured on this machine (`aws configure`) with
CloudWatch read access to the `medical-scanner` stack's region — used to estimate Lambda/API
Gateway cost, since Gemini/Sarvam/Firebase have no billing API for personal API keys.

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
