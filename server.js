import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { dailyCostByProvider, costByOperation, costByModel, costByGeminiKeyIndex, totals, firebaseThisMonth, topUsersByCost, rawUsageEvents, recentRequests, tokenUsageByCustomer } from './lib/aggregate.js';
import { dailyAwsCost, monthToDateFreeTier, getCloudFormationStackEvents, getCloudWatchAlarmStatuses } from './lib/awsCost.js';
import { generateOptimizations } from './lib/optimize.js';
import { calculateDoraMetrics } from './lib/dora.js';
import { calculateCustomerAnalytics } from './lib/customer.js';
import { evaluateFraudAlerts } from './lib/fraud.js';
import { installAuth } from './lib/auth.js';
import { createTtlCache } from './lib/cache.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
const PORT = process.env.PORT || 4300;
const SUMMARY_CACHE_TTL_MS = parseInt(process.env.SUMMARY_CACHE_TTL_MS, 10) || 5 * 60 * 1000;

const summaryCache = createTtlCache(SUMMARY_CACHE_TTL_MS);

// Auth guards everything, including the static frontend — mounted first so no
// route below it can be reached unauthenticated. Also mounts /login and /logout.
installAuth(app, express);
app.use(express.static(path.join(__dirname, 'public')));

async function buildSummary(days) {
  const [daily, ops, models, keyIndexRows, tot, fbMonth, users, awsDaily, awsFreeTier, rawEvents, stackEvents, customerAnalytics, recent, fraudAlerts, cwAlarms, tokenUsage] = await Promise.all([
    dailyCostByProvider(days),
    costByOperation(days),
    costByModel(days),
    costByGeminiKeyIndex(days).catch((e) => {
      console.error('Gemini key-index breakdown failed:', e.message);
      return [];
    }),
    totals(days),
    firebaseThisMonth(),
    topUsersByCost(days),
    dailyAwsCost(days).catch((e) => {
      console.error('AWS cost estimate failed:', e.message);
      return null;
    }),
    monthToDateFreeTier().catch((e) => {
      console.error('AWS free-tier lookup failed:', e.message);
      return null;
    }),
    rawUsageEvents(days).catch((e) => {
      console.error('Raw usage events query failed:', e.message);
      return [];
    }),
    getCloudFormationStackEvents().catch((e) => {
      console.error('Stack events query failed:', e.message);
      return [];
    }),
    calculateCustomerAnalytics(days).catch((e) => {
      console.error('Customer analytics calculation failed:', e.message);
      return null;
    }),
    recentRequests(30).catch((e) => {
      console.error('Recent requests query failed:', e.message);
      return [];
    }),
    evaluateFraudAlerts(days).catch((e) => {
      console.error('Fraud evaluation failed:', e.message);
      return { threatLevel: 'UNKNOWN', riskScore: 0, totalActiveAlerts: 0, alerts: [] };
    }),
    getCloudWatchAlarmStatuses().catch((e) => {
      console.error('CloudWatch alarm query failed:', e.message);
      return [];
    }),
    tokenUsageByCustomer(days).catch((e) => {
      console.error('Token usage query failed:', e.message);
      return null;
    }),
  ]);

  // Merge AWS CloudWatch metrics into provider series and totals so all 4 providers
  // (Firebase, Gemini, Sarvam, AWS) share unified request counts, costs, and failure rates.
  if (awsDaily && !awsDaily.unavailable) {
    daily.costByProvider.aws = awsDaily.cost;
    const awsTotalCost = awsDaily.cost.reduce((s, c) => s + c, 0);
    const awsRequests = awsDaily.totalInvocations || 0;
    const awsFailures = awsDaily.totalErrors || 0;

    const existingAwsIdx = tot.byProvider.findIndex((r) => r.provider === 'aws');
    const awsRow = {
      provider: 'aws',
      requests: awsRequests,
      total_cost: awsTotalCost,
      failures: awsFailures,
      avg_latency_ms: awsDaily.avgLatencyMs || null,
    };

    if (existingAwsIdx !== -1) {
      tot.byProvider[existingAwsIdx] = awsRow;
    } else {
      tot.byProvider.push(awsRow);
    }

    tot.totalCost += awsTotalCost;
    tot.totalRequests += awsRequests;
  }

  // Re-calculate combined metrics accurately across all providers
  tot.avgCostPerRequest = tot.totalRequests ? tot.totalCost / tot.totalRequests : 0;
  tot.totalFailures = tot.byProvider.reduce((sum, r) => sum + (r.failures || 0), 0);
  tot.overallFailureRate = tot.totalRequests ? parseFloat(((tot.totalFailures / tot.totalRequests) * 100).toFixed(2)) : 0;

  // Calculate complete DORA metrics across Firebase, Gemini, Sarvam, and AWS Lambda APIs
  const dora = calculateDoraMetrics(days, {
    usageEvents: rawEvents,
    awsMetrics: awsDaily,
    stackEvents,
  });

  const optimizations = generateOptimizations({
    totals: tot,
    costByOperation: ops,
    costByModel: models,
    firebaseThisMonth: fbMonth,
    awsFreeTier,
  });

  return {
    days,
    daily,
    costByOperation: ops,
    costByModel: models,
    costByGeminiKeyIndex: keyIndexRows,
    totals: tot,
    dora,
    customerAnalytics,
    recentRequests: recent,
    tokenUsage,
    fraudAlerts,
    cloudwatchAlarms: cwAlarms,
    firebaseThisMonth: fbMonth,
    topUsers: users,
    awsFreeTier,
    awsMetricsAvailable: !!(awsDaily && !awsDaily.unavailable),
    optimizations,
    generatedAt: new Date().toISOString(),
  };
}

app.get('/api/summary', async (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
  try {
    const { value, cached, cachedAt } = await summaryCache.get(String(days), () => buildSummary(days));
    res.json({ ...value, cached, cachedAt });
  } catch (error) {
    console.error('Failed to build summary:', error);
    res.status(500).json({ error: error.message });
  }
});

// On Lambda the runtime owns the socket, so only bind a port when run directly.
if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  app.listen(PORT, () => {
    console.log(`Medical Admin Dashboard running at http://localhost:${PORT}`);
    console.log(`Summary cache TTL: ${Math.round(SUMMARY_CACHE_TTL_MS / 1000)}s`);
  });
}

export default app;
