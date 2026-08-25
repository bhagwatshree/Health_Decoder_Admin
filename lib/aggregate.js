import db from './db.js';
import { FIREBASE_PHONE_AUTH } from './pricing.js';

/** Daily cost + request count per provider, for the last `days` days (oldest first, zero-filled). */
export async function dailyCostByProvider(days) {
  const { rows } = await db.query(
    `SELECT date_trunc('day', created_at) AS day, provider,
            SUM(cost_usd)::float AS cost, COUNT(*)::int AS requests
     FROM api_usage_events
     WHERE created_at > now() - ($1 || ' days')::interval
     GROUP BY 1, 2
     ORDER BY 1`,
    [days]
  );

  const dayKeys = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - i);
    dayKeys.push(d.toISOString().slice(0, 10));
  }

  const providers = ['gemini', 'sarvam', 'firebase', 'aws'];
  const series = Object.fromEntries(providers.map((p) => [p, dayKeys.map(() => 0)]));
  const requestSeries = Object.fromEntries(providers.map((p) => [p, dayKeys.map(() => 0)]));

  for (const row of rows) {
    const key = row.day.toISOString().slice(0, 10);
    const idx = dayKeys.indexOf(key);
    if (idx === -1 || !series[row.provider]) continue;
    series[row.provider][idx] = row.cost;
    requestSeries[row.provider][idx] = row.requests;
  }

  return { days: dayKeys, costByProvider: series, requestsByProvider: requestSeries };
}

/** Cost/requests grouped by (operation, provider), for the last `days` days, most expensive first. */
export async function costByOperation(days) {
  const { rows } = await db.query(
    `SELECT operation, provider, COUNT(*)::int AS requests, SUM(cost_usd)::float AS total_cost,
            AVG(cost_usd)::float AS avg_cost,
            SUM(CASE WHEN success THEN 0 ELSE 1 END)::int AS failures,
            AVG(latency_ms)::float AS avg_latency_ms
     FROM api_usage_events
     WHERE created_at > now() - ($1 || ' days')::interval
     GROUP BY operation, provider
     ORDER BY total_cost DESC`,
    [days]
  );
  return rows;
}

export async function costByGeminiKeyIndex(days, totalKeys = 8) {
  const { rows } = await db.query(
    `
    WITH pool_keys AS (
      SELECT generate_series(0, $2 - 1) AS key_idx
    ),
    usage_summary AS (
      SELECT 
        gemini_key_index,
        COUNT(*)::int AS requests,
        SUM(cost_usd)::float AS total_cost,
        AVG(cost_usd)::float AS avg_cost,
        SUM(CASE WHEN success THEN 0 ELSE 1 END)::int AS failures
      FROM api_usage_events
      WHERE provider = 'gemini' AND gemini_key_index IS NOT NULL
        AND created_at > now() - ($1 || ' days')::interval
      GROUP BY gemini_key_index
    ),
    byok_summary AS (
      SELECT 
        COUNT(*)::int AS requests,
        SUM(cost_usd)::float AS total_cost,
        AVG(cost_usd)::float AS avg_cost,
        SUM(CASE WHEN success THEN 0 ELSE 1 END)::int AS failures
      FROM api_usage_events
      WHERE provider = 'gemini' AND gemini_key_index IS NULL
        AND created_at > now() - ($1 || ' days')::interval
    )
    SELECT 
      k.key_idx AS gemini_key_index,
      'Key #' || k.key_idx AS gemini_key_index_label,
      COALESCE(u.requests, 0) AS requests,
      COALESCE(u.total_cost, 0) AS total_cost,
      COALESCE(u.avg_cost, 0) AS avg_cost,
      COALESCE(u.failures, 0) AS failures,
      'Your Google AI Studio Account' AS billing_owner,
      CASE WHEN COALESCE(u.requests, 0) > 0 THEN 'Active' ELSE 'Standby' END AS key_status
    FROM pool_keys k
    LEFT JOIN usage_summary u ON k.key_idx = u.gemini_key_index
    UNION ALL
    SELECT 
      NULL AS gemini_key_index,
      'BYOK / Caller Key' AS gemini_key_index_label,
      COALESCE(b.requests, 0) AS requests,
      COALESCE(b.total_cost, 0) AS total_cost,
      COALESCE(b.avg_cost, 0) AS avg_cost,
      COALESCE(b.failures, 0) AS failures,
      'Caller Key / Free Tier' AS billing_owner,
      'External' AS key_status
    FROM byok_summary b
    ORDER BY gemini_key_index ASC NULLS LAST
    `,
    [days, totalKeys]
  );
  return rows;
}

/** Cost/requests grouped by Gemini/Sarvam model (the `model` column), most expensive first. */
export async function costByModel(days) {
  const { rows } = await db.query(
    `SELECT provider, model, COUNT(*)::int AS requests, SUM(cost_usd)::float AS total_cost,
            AVG(cost_usd)::float AS avg_cost,
            SUM(COALESCE(input_tokens, 0))::bigint AS total_input_tokens,
            SUM(COALESCE(output_tokens, 0))::bigint AS total_output_tokens,
            -- Reasoning tokens. Billed at the OUTPUT rate, but a separate column from
            -- output_tokens, so cost_usd above already includes them while total_output_tokens
            -- does not. Surfaced separately so the two reconcile instead of appearing to disagree.
            SUM(COALESCE(thinking_tokens, 0))::bigint AS total_thinking_tokens
     FROM api_usage_events
     WHERE created_at > now() - ($1 || ' days')::interval AND model IS NOT NULL
     GROUP BY provider, model
     ORDER BY total_cost DESC`,
    [days]
  );
  return rows;
}

export async function totals(days) {
  const { rows } = await db.query(
    `SELECT provider, COUNT(*)::int AS requests, SUM(cost_usd)::float AS total_cost,
            SUM(CASE WHEN success THEN 0 ELSE 1 END)::int AS failures
     FROM api_usage_events
     WHERE created_at > now() - ($1 || ' days')::interval
     GROUP BY provider`,
    [days]
  );
  const totalCost = rows.reduce((s, r) => s + r.total_cost, 0);
  const totalRequests = rows.reduce((s, r) => s + r.requests, 0);
  return { byProvider: rows, totalCost, totalRequests, avgCostPerRequest: totalRequests ? totalCost / totalRequests : 0 };
}

/** Firebase verifications since the start of the current calendar month, for free-tier tracking. */
export async function firebaseThisMonth() {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS verifications, SUM(CASE WHEN success THEN 0 ELSE 1 END)::int AS failures
     FROM api_usage_events
     WHERE provider = 'firebase' AND created_at >= date_trunc('month', now())`
  );
  const verifications = rows[0]?.verifications || 0;
  return {
    verifications,
    freeAllowance: FIREBASE_PHONE_AUTH.freeVerificationsPerMonth,
    overFreeAllowance: Math.max(0, verifications - FIREBASE_PHONE_AUTH.freeVerificationsPerMonth),
  };
}

/** Top users by total cost in the window (nulls collapsed to email, user_id, or "anonymous"). */
export async function topUsersByCost(days, limit = 10) {
  const { rows } = await db.query(
    `SELECT COALESCE(u.email, e.user_id::text, 'anonymous') AS user_id,
            u.email AS user_email,
            COUNT(*)::int AS requests,
            SUM(e.cost_usd)::float AS total_cost
     FROM api_usage_events e
     LEFT JOIN users u ON e.user_id = u.id
     WHERE e.created_at > now() - ($1 || ' days')::interval
     GROUP BY u.email, e.user_id
     ORDER BY total_cost DESC
     LIMIT $2`,
    [days, limit]
  );
  return rows;
}

/** Fetch raw usage events within window for granular DORA calculations. */
export async function rawUsageEvents(days) {
  const { rows } = await db.query(
    `SELECT id, created_at, provider, operation, model, latency_ms, cost_usd, success
     FROM api_usage_events
     WHERE created_at > now() - ($1 || ' days')::interval
     ORDER BY created_at ASC`,
    [days]
  );
  return rows;
}

/** Fetch most recent live requests for today's real-time inspection, including customer email and Gemini key index when available. */
export async function recentRequests(limit = 25) {
  const { rows } = await db.query(
    `SELECT e.id, e.created_at, e.provider, e.operation, e.model, e.latency_ms, e.cost_usd, e.success,
            e.gemini_key_index, e.input_tokens, e.output_tokens, e.thinking_tokens, e.units,
            COALESCE(u.email, e.user_id::text, e.device_id::text, 'anonymous') AS customer_id,
            u.email AS user_email,
            u.first_name,
            u.last_name
     FROM api_usage_events e
     LEFT JOIN users u ON e.user_id = u.id
     ORDER BY e.created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}




/**
 * Per-customer AI usage, split by provider (Gemini / Sarvam) and model.
 *
 * Firebase is excluded: phone-auth verifications are neither token- nor
 * character-billed, so they'd inflate request counts with no usage to show.
 *
 * Both `units` and tokens are reported because the two providers meter
 * differently — Gemini bills on promptTokenCount/candidatesTokenCount, while
 * several Sarvam operations (translate, tts, doc-digitization) bill on
 * characters or pages and legitimately carry zero tokens. Reporting only tokens
 * would make Sarvam look free.
 *
 * The ratio worth reading is input:output — a high one means large prompts
 * relative to the answers they produce, which is where trimming context or
 * enabling prompt caching pays off.
 */
export async function tokenUsageByCustomer(days, limit = 20) {
  const { rows } = await db.query(
    `SELECT COALESCE(u.email, e.user_id::text, e.device_id::text, 'anonymous') AS customer_id,
            u.email AS user_email,
            e.provider,
            e.model,
            COUNT(*)::int AS requests,
            SUM(COALESCE(e.input_tokens, 0))::bigint  AS input_tokens,
            SUM(COALESCE(e.output_tokens, 0))::bigint AS output_tokens,
            SUM(COALESCE(e.thinking_tokens, 0))::bigint AS thinking_tokens,
            SUM(COALESCE(e.units, 0))::bigint         AS units,
            SUM(e.cost_usd)::float AS total_cost
     FROM api_usage_events e
     LEFT JOIN users u ON e.user_id = u.id
     WHERE e.created_at > now() - ($1 || ' days')::interval
       AND e.provider IN ('gemini', 'sarvam')
     GROUP BY 1, 2, e.provider, e.model
     ORDER BY 1`,
    [days]
  );

  const n = (v) => Number(v || 0);
  const per = (total, count) => (count ? Math.round(total / count) : 0);

  function blank(extra) {
    return { requests: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, units: 0, totalCost: 0, ...extra };
  }
  function accumulate(target, r, inTok, outTok, units, thinkTok = 0) {
    target.requests += r.requests;
    target.inputTokens += inTok;
    target.outputTokens += outTok;
    target.thinkingTokens += thinkTok;
    target.units += units;
    target.totalCost += r.total_cost || 0;
  }
  /** Per-request averages and the input:output ratio, once sums are final. */
  function derive(o) {
    // What the provider actually charges output rates for: the answer PLUS the reasoning tokens.
    // Keeping these separate in the columns but combined here is the whole point -- cost_usd is
    // computed from billed output, so any ratio built on o.outputTokens alone disagrees with it.
    o.thinkingTokens = o.thinkingTokens || 0;
    o.billedOutputTokens = o.outputTokens + o.thinkingTokens;
    o.totalTokens = o.inputTokens + o.billedOutputTokens;
    o.avgInputPerRequest = per(o.inputTokens, o.requests);
    o.avgOutputPerRequest = per(o.outputTokens, o.requests);
    o.avgThinkingPerRequest = per(o.thinkingTokens, o.requests);
    o.avgBilledOutputPerRequest = per(o.billedOutputTokens, o.requests);
    o.avgTokensPerRequest = per(o.totalTokens, o.requests);
    o.avgUnitsPerRequest = per(o.units, o.requests);
    o.avgCostPerRequest = o.requests ? o.totalCost / o.requests : 0;
    // Share of billed output that went on reasoning rather than answer -- the number to look at
    // before deciding whether to cap thinkingBudget.
    o.thinkingShareOfOutput = o.billedOutputTokens > 0 ? o.thinkingTokens / o.billedOutputTokens : null;
    // Against BILLED output, so "input is 3x output" cannot be an artefact of excluding thinking.
    // null rather than Infinity when a provider returned no output tokens at all.
    o.ioRatio = o.billedOutputTokens > 0 ? o.inputTokens / o.billedOutputTokens : null;
    o.costPer1kTokens = o.totalTokens > 0 ? (o.totalCost / o.totalTokens) * 1000 : 0;
    // Flash-tier pricing makes the per-1K figure round to $0.00; per-1M is the
    // unit model pricing is actually quoted in.
    o.costPer1mTokens = o.totalTokens > 0 ? (o.totalCost / o.totalTokens) * 1_000_000 : 0;
    return o;
  }

  const byCustomer = new Map();
  const providerTotals = new Map();
  const overall = blank({});

  for (const r of rows) {
    const inTok = n(r.input_tokens);
    const outTok = n(r.output_tokens);
    const thinkTok = n(r.thinking_tokens);
    const units = n(r.units);

    let c = byCustomer.get(r.customer_id);
    if (!c) {
      c = blank({ customerId: r.customer_id, userEmail: r.user_email, byProvider: new Map(), byModel: [] });
      byCustomer.set(r.customer_id, c);
    }
    accumulate(c, r, inTok, outTok, units, thinkTok);

    if (!c.byProvider.has(r.provider)) c.byProvider.set(r.provider, blank({ provider: r.provider }));
    accumulate(c.byProvider.get(r.provider), r, inTok, outTok, units, thinkTok);

    c.byModel.push(derive({
      provider: r.provider, model: r.model, requests: r.requests,
      inputTokens: inTok, outputTokens: outTok, thinkingTokens: thinkTok, units, totalCost: r.total_cost || 0,
    }));

    if (!providerTotals.has(r.provider)) providerTotals.set(r.provider, blank({ provider: r.provider }));
    accumulate(providerTotals.get(r.provider), r, inTok, outTok, units, thinkTok);
    accumulate(overall, r, inTok, outTok, units, thinkTok);
  }

  const customers = [...byCustomer.values()].map((c) => {
    c.byProvider = [...c.byProvider.values()].map(derive).sort((a, b) => b.totalCost - a.totalCost);
    c.byModel.sort((a, b) => b.totalTokens - a.totalTokens);
    return derive(c);
  }).sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests);

  return {
    totals: derive(overall),
    byProvider: [...providerTotals.values()].map(derive).sort((a, b) => b.totalCost - a.totalCost),
    customersWithUsage: customers.length,
    customers: customers.slice(0, limit),
  };
}

