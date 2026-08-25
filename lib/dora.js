/**
 * DORA Metrics Calculator for Health Decoder Admin Dashboard
 * Computes Deployment Frequency, Lead Time for Changes, Change Failure Rate, and Mean Time to Restore
 * across Firebase, Gemini, Sarvam, and AWS Lambda APIs.
 */

// Rating threshold helpers based on industry DORA benchmarks adapted for service/API architectures
export function getDoraRating(metric, value) {
  switch (metric) {
    case 'deploymentFrequency': {
      // value = deployments per month
      if (value >= 30) return { label: 'Elite', class: 'rating-elite' };
      if (value >= 4) return { label: 'High', class: 'rating-high' };
      if (value >= 1) return { label: 'Medium', class: 'rating-medium' };
      return { label: 'Low', class: 'rating-low' };
    }
    case 'leadTime': {
      // value = avg latency in ms
      if (value <= 1000) return { label: 'Elite', class: 'rating-elite' };
      if (value <= 5000) return { label: 'High', class: 'rating-high' };
      if (value <= 15000) return { label: 'Medium', class: 'rating-medium' };
      return { label: 'Low', class: 'rating-low' };
    }
    case 'failureRate': {
      // value = percentage (0 - 100)
      if (value <= 5) return { label: 'Elite', class: 'rating-elite' };
      if (value <= 15) return { label: 'High', class: 'rating-high' };
      if (value <= 30) return { label: 'Medium', class: 'rating-medium' };
      return { label: 'Low', class: 'rating-low' };
    }
    case 'mttr': {
      // value = minutes to restore
      if (value <= 60) return { label: 'Elite', class: 'rating-elite' };
      if (value <= 1440) return { label: 'High', class: 'rating-high' };
      if (value <= 10080) return { label: 'Medium', class: 'rating-medium' };
      return { label: 'Low', class: 'rating-low' };
    }
    default:
      return { label: 'N/A', class: 'rating-low' };
  }
}

/**
 * Calculates DORA metrics for a given window (days)
 * @param {number} days - Time window in days
 * @param {Object} data - Inputs including usageEvents, awsMetrics, stackEvents
 */
export function calculateDoraMetrics(days, { usageEvents = [], awsMetrics = null, stackEvents = [] }) {
  const providers = ['firebase', 'gemini', 'sarvam', 'aws'];
  const providerStats = {};

  providers.forEach((p) => {
    providerStats[p] = {
      provider: p,
      requests: 0,
      failures: 0,
      totalLatencyMs: 0,
      latencyCount: 0,
      deployments: 0,
      mttrMinutes: null,
      lastFailureTime: null,
      recoveryDurations: [],
    };
  });

  // 1. Process DB usage events (Gemini, Sarvam, Firebase, etc.)
  // Sort events chronologically to compute restoration time after failure
  const sortedEvents = [...usageEvents].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  sortedEvents.forEach((ev) => {
    const p = ev.provider;
    if (!providerStats[p]) {
      providerStats[p] = {
        provider: p,
        requests: 0,
        failures: 0,
        totalLatencyMs: 0,
        latencyCount: 0,
        deployments: 0,
        mttrMinutes: null,
        lastFailureTime: null,
        recoveryDurations: [],
      };
    }

    const stats = providerStats[p];
    stats.requests += 1;

    if (ev.latency_ms !== null && ev.latency_ms !== undefined) {
      stats.totalLatencyMs += Number(ev.latency_ms);
      stats.latencyCount += 1;
    }

    if (!ev.success) {
      stats.failures += 1;
      stats.lastFailureTime = new Date(ev.created_at);
    } else if (stats.lastFailureTime) {
      // System recovered after a failure
      const recoveryMs = new Date(ev.created_at) - stats.lastFailureTime;
      const recoveryMins = Math.max(1, Math.round(recoveryMs / 60000));
      stats.recoveryDurations.push(recoveryMins);
      stats.lastFailureTime = null;
    }
  });

  // Estimate DB-backed deployments based on operational active windows & model updates
  const dbDeploymentsByProvider = {};
  sortedEvents.forEach((ev) => {
    const p = ev.provider;
    dbDeploymentsByProvider[p] = dbDeploymentsByProvider[p] || new Set();
    // Group active operational updates by day
    const day = new Date(ev.created_at).toISOString().slice(0, 10);
    dbDeploymentsByProvider[p].add(day);
  });

  // 2. Process AWS CloudWatch & CloudFormation metrics
  if (awsMetrics) {
    const aws = providerStats.aws;
    aws.requests = awsMetrics.totalInvocations || awsMetrics.invocations || 0;
    aws.failures = awsMetrics.totalErrors || awsMetrics.errors || 0;
    if (awsMetrics.totalDurationMs && aws.requests > 0) {
      aws.totalLatencyMs = awsMetrics.totalDurationMs;
      aws.latencyCount = aws.requests;
    } else if (awsMetrics.avgLatencyMs && aws.requests > 0) {
      aws.totalLatencyMs = awsMetrics.avgLatencyMs * aws.requests;
      aws.latencyCount = aws.requests;
    }
  }


  // AWS CloudFormation Stack Events for Deployment Frequency
  if (Array.isArray(stackEvents) && stackEvents.length > 0) {
    const windowStart = new Date(Date.now() - days * 86400 * 1000);
    const validStackUpdates = stackEvents.filter((e) => {
      const isComplete = e.ResourceStatus === 'UPDATE_COMPLETE' || e.ResourceStatus === 'CREATE_COMPLETE';
      const inWindow = new Date(e.Timestamp) >= windowStart;
      return isComplete && inWindow;
    });
    providerStats.aws.deployments = validStackUpdates.length;
  } else {
    providerStats.aws.deployments = (dbDeploymentsByProvider.aws?.size || 0);
  }

  // Set deployments for DB providers
  ['firebase', 'gemini', 'sarvam'].forEach((p) => {
    providerStats[p].deployments = dbDeploymentsByProvider[p]?.size || (providerStats[p].requests > 0 ? 1 : 0);
  });

  // 3. Compute DORA metrics per provider
  const perProvider = {};
  let totalRequestsAll = 0;
  let totalFailuresAll = 0;
  let totalLatencyAll = 0;
  let latencyCountAll = 0;
  let totalDeploymentsAll = 0;
  const allRecoveryDurations = [];

  Object.keys(providerStats).forEach((p) => {
    const st = providerStats[p];
    const avgLatency = st.latencyCount > 0 ? Math.round(st.totalLatencyMs / st.latencyCount) : null;
    const failureRate = st.requests > 0 ? parseFloat(((st.failures / st.requests) * 100).toFixed(2)) : 0;
    const avgMttr =
      st.recoveryDurations.length > 0
        ? Math.round(st.recoveryDurations.reduce((a, b) => a + b, 0) / st.recoveryDurations.length)
        : st.failures > 0
        ? 15 // Default 15 min restoration estimate if no recovery pair
        : 0;

    perProvider[p] = {
      provider: p,
      requests: st.requests,
      failures: st.failures,
      avgLatencyMs: avgLatency,
      deployments: st.deployments,
      deploymentsPerMonth: parseFloat(((st.deployments / days) * 30).toFixed(1)),
      failureRatePct: failureRate,
      mttrMinutes: avgMttr,
      ratings: {
        deploymentFrequency: getDoraRating('deploymentFrequency', (st.deployments / days) * 30),
        leadTime: getDoraRating('leadTime', avgLatency || 1500),
        failureRate: getDoraRating('failureRate', failureRate),
        mttr: getDoraRating('mttr', avgMttr),
      },
    };

    totalRequestsAll += st.requests;
    totalFailuresAll += st.failures;
    if (st.latencyCount > 0) {
      totalLatencyAll += st.totalLatencyMs;
      latencyCountAll += st.latencyCount;
    }
    totalDeploymentsAll += st.deployments;
    allRecoveryDurations.push(...st.recoveryDurations);
  });

  // 4. Compute Summary / Overall DORA Metrics across all providers
  const overallAvgLatency = latencyCountAll > 0 ? Math.round(totalLatencyAll / latencyCountAll) : 0;
  const overallFailureRate = totalRequestsAll > 0 ? parseFloat(((totalFailuresAll / totalRequestsAll) * 100).toFixed(2)) : 0;
  const overallDeploymentsPerMonth = parseFloat(((totalDeploymentsAll / days) * 30).toFixed(1));
  const overallMttr =
    allRecoveryDurations.length > 0
      ? Math.round(allRecoveryDurations.reduce((a, b) => a + b, 0) / allRecoveryDurations.length)
      : totalFailuresAll > 0
      ? 15
      : 0;

  return {
    windowDays: days,
    overall: {
      totalRequests: totalRequestsAll,
      totalFailures: totalFailuresAll,
      deploymentFrequencyPerMonth: overallDeploymentsPerMonth,
      leadTimeMs: overallAvgLatency,
      changeFailureRatePct: overallFailureRate,
      mttrMinutes: overallMttr,
      ratings: {
        deploymentFrequency: getDoraRating('deploymentFrequency', overallDeploymentsPerMonth),
        leadTime: getDoraRating('leadTime', overallAvgLatency),
        failureRate: getDoraRating('failureRate', overallFailureRate),
        mttr: getDoraRating('mttr', overallMttr),
      },
    },
    byProvider: perProvider,
  };
}
