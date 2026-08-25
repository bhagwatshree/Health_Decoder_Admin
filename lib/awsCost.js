import { CloudFormationClient, DescribeStackResourcesCommand, DescribeStackEventsCommand } from '@aws-sdk/client-cloudformation';
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import dotenv from 'dotenv';
import { AWS_PRICING } from './pricing.js';

dotenv.config();

const region = process.env.AWS_REGION || 'us-east-1';
const stackName = process.env.STACK_NAME || 'medical-scanner';
const cfn = new CloudFormationClient({ region });
const cw = new CloudWatchClient({ region });

// The Lambda's configured memory (see backend/template.yaml Globals.Function.MemorySize).
// CloudWatch's standard Duration/Invocations metrics don't report memory actually used, so
// GB-seconds here are estimated at the configured size — a ceiling, not the real number if
// the function typically uses less.
const LAMBDA_MEMORY_MB = 512;

let cachedResourceIds = null;

async function resolveStackResources() {
  if (cachedResourceIds) return cachedResourceIds;
  try {
    const { StackResources } = await cfn.send(new DescribeStackResourcesCommand({ StackName: stackName }));
    const fn = StackResources.find((r) => r.ResourceType === 'AWS::Lambda::Function');
    const api = StackResources.find((r) => r.ResourceType === 'AWS::ApiGatewayV2::Api');
    cachedResourceIds = {
      functionName: fn?.PhysicalResourceId || null,
      httpApiId: api?.PhysicalResourceId || null,
    };
  } catch (err) {
    console.error('Failed to resolve CloudFormation stack resources:', err.message);
    cachedResourceIds = { functionName: null, httpApiId: null };
  }
  return cachedResourceIds;
}

/** Fetch CloudFormation stack events for deployment frequency calculation. */
export async function getCloudFormationStackEvents() {
  try {
    const { StackEvents } = await cfn.send(new DescribeStackEventsCommand({ StackName: stackName }));
    return StackEvents || [];
  } catch (err) {
    console.error('CloudFormation DescribeStackEvents failed:', err.message);
    return [];
  }
}

function dayBuckets(days) {
  const buckets = [];
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    buckets.push(d);
  }
  return buckets;
}

/** Daily estimated AWS cost + invocations, errors, and duration for the last `days` days. */
export async function dailyAwsCost(days) {
  const { functionName, httpApiId } = await resolveStackResources();
  const buckets = dayBuckets(days);
  const startTime = buckets[0];
  const endTime = new Date();

  if (!functionName) {
    return {
      days: buckets.map((d) => d.toISOString().slice(0, 10)),
      cost: buckets.map(() => 0),
      totalInvocations: 0,
      totalErrors: 0,
      totalDurationMs: 0,
      avgLatencyMs: 0,
      unavailable: true,
    };
  }

  const metricQueries = [
    {
      Id: 'invocations',
      MetricStat: {
        Metric: { Namespace: 'AWS/Lambda', MetricName: 'Invocations', Dimensions: [{ Name: 'FunctionName', Value: functionName }] },
        Period: 86400,
        Stat: 'Sum',
      },
    },
    {
      Id: 'durationSum',
      MetricStat: {
        Metric: { Namespace: 'AWS/Lambda', MetricName: 'Duration', Dimensions: [{ Name: 'FunctionName', Value: functionName }] },
        Period: 86400,
        Stat: 'Sum',
      },
    },
    {
      Id: 'errors',
      MetricStat: {
        Metric: { Namespace: 'AWS/Lambda', MetricName: 'Errors', Dimensions: [{ Name: 'FunctionName', Value: functionName }] },
        Period: 86400,
        Stat: 'Sum',
      },
    },
  ];

  if (httpApiId) {
    metricQueries.push({
      Id: 'apiRequests',
      MetricStat: {
        Metric: { Namespace: 'AWS/ApiGateway', MetricName: 'Count', Dimensions: [{ Name: 'ApiId', Value: httpApiId }] },
        Period: 86400,
        Stat: 'SampleCount',
      },
    });
  }

  const { MetricDataResults } = await cw.send(
    new GetMetricDataCommand({
      StartTime: startTime,
      EndTime: endTime,
      MetricDataQueries: metricQueries,
    })
  );

  const byId = Object.fromEntries(MetricDataResults.map((r) => [r.Id, r]));
  const dayKeys = buckets.map((d) => d.toISOString().slice(0, 10));
  const cost = dayKeys.map(() => 0);

  function valueForDay(series, dayKey) {
    if (!series) return 0;
    const idx = series.Timestamps.findIndex((t) => new Date(t).toISOString().slice(0, 10) === dayKey);
    return idx === -1 ? 0 : series.Values[idx];
  }

  let totalInvocations = 0;
  let totalErrors = 0;
  let totalDurationMs = 0;

  dayKeys.forEach((dayKey, i) => {
    const invocations = valueForDay(byId.invocations, dayKey);
    const durationMsSum = valueForDay(byId.durationSum, dayKey);
    const errors = valueForDay(byId.errors, dayKey);
    const apiRequests = valueForDay(byId.apiRequests, dayKey);

    totalInvocations += invocations || apiRequests;
    totalErrors += errors;
    totalDurationMs += durationMsSum;

    const gbSeconds = (durationMsSum / 1000) * (LAMBDA_MEMORY_MB / 1024);
    const lambdaCost = invocations * (AWS_PRICING.lambdaPerMRequests / 1_000_000) + gbSeconds * AWS_PRICING.lambdaArm64PerGbSecond;
    const apiCost = apiRequests * (AWS_PRICING.httpApiPerMRequests / 1_000_000);
    cost[i] = lambdaCost + apiCost;
  });

  const avgLatencyMs = totalInvocations > 0 ? Math.round(totalDurationMs / totalInvocations) : 0;

  return {
    days: dayKeys,
    cost,
    totalInvocations,
    totalErrors,
    totalDurationMs,
    avgLatencyMs,
    unavailable: false,
  };
}

/** Month-to-date Lambda/API Gateway usage vs. the AWS free tier. */
export async function monthToDateFreeTier() {
  const { functionName } = await resolveStackResources();
  if (!functionName) return null;

  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date();
  const periodSeconds = Math.max(3600, Math.ceil((end - start) / 1000 / 60) * 60);

  const metricQueries = [
    {
      Id: 'invocations',
      MetricStat: {
        Metric: { Namespace: 'AWS/Lambda', MetricName: 'Invocations', Dimensions: [{ Name: 'FunctionName', Value: functionName }] },
        Period: periodSeconds,
        Stat: 'Sum',
      },
    },
    {
      Id: 'durationSum',
      MetricStat: {
        Metric: { Namespace: 'AWS/Lambda', MetricName: 'Duration', Dimensions: [{ Name: 'FunctionName', Value: functionName }] },
        Period: periodSeconds,
        Stat: 'Sum',
      },
    },
    {
      Id: 'errors',
      MetricStat: {
        Metric: { Namespace: 'AWS/Lambda', MetricName: 'Errors', Dimensions: [{ Name: 'FunctionName', Value: functionName }] },
        Period: periodSeconds,
        Stat: 'Sum',
      },
    },
  ];

  const { MetricDataResults } = await cw.send(
    new GetMetricDataCommand({
      StartTime: start,
      EndTime: end,
      MetricDataQueries: metricQueries,
    })
  );
  const byId = Object.fromEntries(MetricDataResults.map((r) => [r.Id, r]));
  const invocations = byId.invocations?.Values?.[0] || 0;
  const durationMsSum = byId.durationSum?.Values?.[0] || 0;
  const errors = byId.errors?.Values?.[0] || 0;
  const gbSeconds = (durationMsSum / 1000) * (LAMBDA_MEMORY_MB / 1024);

  return {
    invocations,
    errors,
    gbSeconds,
    freeRequests: AWS_PRICING.lambdaFreeRequestsPerMonth,
    freeGbSeconds: AWS_PRICING.lambdaFreeGbSecondsPerMonth,
    requestsPctUsed: (invocations / AWS_PRICING.lambdaFreeRequestsPerMonth) * 100,
    gbSecondsPctUsed: (gbSeconds / AWS_PRICING.lambdaFreeGbSecondsPerMonth) * 100,
  };
}
