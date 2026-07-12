import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { dailyCostByProvider, costByOperation, costByModel, totals, firebaseThisMonth, topUsersByCost } from './lib/aggregate.js';
import { dailyAwsCost, monthToDateFreeTier } from './lib/awsCost.js';
import { generateOptimizations } from './lib/optimize.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4300;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/summary', async (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
  try {
    const [daily, ops, models, tot, fbMonth, users, awsDaily, awsFreeTier] = await Promise.all([
      dailyCostByProvider(days),
      costByOperation(days),
      costByModel(days),
      totals(days),
      firebaseThisMonth(),
      topUsersByCost(days),
      dailyAwsCost(days).catch((e) => { console.error('AWS cost estimate failed:', e.message); return null; }),
      monthToDateFreeTier().catch((e) => { console.error('AWS free-tier lookup failed:', e.message); return null; }),
    ]);

    // Merge the AWS CloudWatch-derived estimate into the same daily series as the DB-tracked
    // providers, and fold it into the totals so the dashboard has one consistent cost picture.
    if (awsDaily && !awsDaily.unavailable) {
      daily.costByProvider.aws = awsDaily.cost;
      const awsTotalCost = awsDaily.cost.reduce((s, c) => s + c, 0);
      tot.byProvider.push({ provider: 'aws', requests: null, total_cost: awsTotalCost, failures: null });
      tot.totalCost += awsTotalCost;
    }

    const optimizations = generateOptimizations({ totals: tot, costByOperation: ops, costByModel: models, firebaseThisMonth: fbMonth, awsFreeTier });

    res.json({
      days,
      daily,
      costByOperation: ops,
      costByModel: models,
      totals: tot,
      firebaseThisMonth: fbMonth,
      topUsers: users,
      awsFreeTier,
      awsMetricsAvailable: !!(awsDaily && !awsDaily.unavailable),
      optimizations,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Failed to build summary:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Medical Admin Dashboard running at http://localhost:${PORT}`);
});
