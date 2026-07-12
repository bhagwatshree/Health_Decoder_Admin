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

/** Cost/requests grouped by Gemini/Sarvam model (the `model` column), most expensive first. */
export async function costByModel(days) {
  const { rows } = await db.query(
    `SELECT provider, model, COUNT(*)::int AS requests, SUM(cost_usd)::float AS total_cost,
            AVG(cost_usd)::float AS avg_cost,
            SUM(COALESCE(input_tokens, 0))::bigint AS total_input_tokens,
            SUM(COALESCE(output_tokens, 0))::bigint AS total_output_tokens
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

/** Top users by total cost in the window (nulls collapsed to "anonymous"). */
export async function topUsersByCost(days, limit = 10) {
  const { rows } = await db.query(
    `SELECT COALESCE(user_id::text, 'anonymous') AS user_id, COUNT(*)::int AS requests,
            SUM(cost_usd)::float AS total_cost
     FROM api_usage_events
     WHERE created_at > now() - ($1 || ' days')::interval
     GROUP BY 1
     ORDER BY total_cost DESC
     LIMIT $2`,
    [days, limit]
  );
  return rows;
}
