import db from './db.js';

/**
 * Evaluates real-time fraud, rate-limit flooding, and anomaly rules across
 * api_usage_events in PostgreSQL.
 */
export async function evaluateFraudAlerts(days = 1) {
  try {
    const alerts = [];

    // 1. SMS / OTP Flooding Rule
    // Detects repeated OTP requests (otp-send, otp-verify) from same device_id, IP, or user
    const { rows: otpRows } = await db.query(
      `
      SELECT 
        COALESCE(u.email, e.user_id::text, e.device_id::text, 'anonymous') AS entity_id,
        e.device_id,
        u.email AS user_email,
        COUNT(*)::int AS otp_count,
        MIN(e.created_at) AS first_otp_at,
        MAX(e.created_at) AS last_otp_at,
        COUNT(DISTINCT e.operation)::int AS distinct_ops
      FROM api_usage_events e
      LEFT JOIN users u ON e.user_id = u.id
      WHERE e.created_at >= now() - interval '15 minutes'
        AND (LOWER(e.operation) LIKE '%otp%' OR LOWER(e.operation) LIKE '%sms%' OR LOWER(e.operation) LIKE '%auth%')
      GROUP BY u.email, e.user_id, e.device_id
      HAVING COUNT(*) >= 5
      ORDER BY otp_count DESC
      `
    );

    otpRows.forEach((r) => {
      alerts.push({
        id: `otp-flood-${r.entity_id}`,
        category: 'SMS / OTP Flooding',
        severity: r.otp_count >= 15 ? 'HIGH' : 'MEDIUM',
        entityId: r.entity_id,
        userEmail: r.user_email || 'Guest Device',
        count: r.otp_count,
        windowMinutes: 15,
        title: `SMS OTP Surge Detected`,
        description: `Entity attempted ${r.otp_count} SMS/OTP verifications in 15 minutes.`,
        recommendation: `Enforce IP/Device captcha and rate limit to max 3 OTP attempts per 10 mins.`,
        lastDetected: r.last_otp_at,
      });
    });

    // 2. Gemini API Direct Abuse Rule
    // Detects excessive direct Gemini API requests from a single user or device
    const { rows: geminiRows } = await db.query(
      `
      SELECT 
        COALESCE(u.email, e.user_id::text, e.device_id::text, 'anonymous') AS entity_id,
        e.device_id,
        u.email AS user_email,
        COUNT(*)::int AS gemini_count,
        SUM(e.cost_usd)::float AS cost_usd,
        MIN(e.created_at) AS first_seen,
        MAX(e.created_at) AS last_seen
      FROM api_usage_events e
      LEFT JOIN users u ON e.user_id = u.id
      WHERE e.created_at >= now() - interval '15 minutes'
        AND LOWER(e.provider) = 'gemini'
      GROUP BY u.email, e.user_id, e.device_id
      HAVING COUNT(*) >= 20
      ORDER BY gemini_count DESC
      `
    );

    geminiRows.forEach((r) => {
      alerts.push({
        id: `gemini-abuse-${r.entity_id}`,
        category: 'Gemini API Direct Abuse',
        severity: r.gemini_count >= 50 ? 'HIGH' : 'MEDIUM',
        entityId: r.entity_id,
        userEmail: r.user_email || 'Guest Device',
        count: r.gemini_count,
        windowMinutes: 15,
        title: `Gemini API Direct Abuse / Scraping`,
        description: `Entity issued ${r.gemini_count} Gemini API requests ($${r.cost_usd.toFixed(4)}) in 15 minutes.`,
        recommendation: `Check client application token verification; temporarily throttle or ban entity_id ${r.entity_id}.`,
        lastDetected: r.last_seen,
      });
    });

    // 3. Sarvam AI Audio Processing Surge Rule
    const { rows: sarvamRows } = await db.query(
      `
      SELECT 
        COALESCE(u.email, e.user_id::text, e.device_id::text, 'anonymous') AS entity_id,
        u.email AS user_email,
        COUNT(*)::int AS sarvam_count,
        SUM(e.cost_usd)::float AS cost_usd,
        MAX(e.created_at) AS last_seen
      FROM api_usage_events e
      LEFT JOIN users u ON e.user_id = u.id
      WHERE e.created_at >= now() - interval '15 minutes'
        AND LOWER(e.provider) = 'sarvam'
      GROUP BY u.email, e.user_id, e.device_id
      HAVING COUNT(*) >= 15
      ORDER BY sarvam_count DESC
      `
    );

    sarvamRows.forEach((r) => {
      alerts.push({
        id: `sarvam-surge-${r.entity_id}`,
        category: 'Sarvam AI Audio Surge',
        severity: r.sarvam_count >= 30 ? 'HIGH' : 'MEDIUM',
        entityId: r.entity_id,
        userEmail: r.user_email || 'Guest Device',
        count: r.sarvam_count,
        windowMinutes: 15,
        title: `Sarvam AI Audio Processing Burst`,
        description: `Entity executed ${r.sarvam_count} Sarvam AI translation/audio requests in 15 minutes.`,
        recommendation: `Review audio payload size limits and enforce concurrency limit per user.`,
        lastDetected: r.last_seen,
      });
    });

    // 4. High Error / Failure Surge Rule
    const { rows: errorRows } = await db.query(
      `
      SELECT 
        COALESCE(u.email, e.user_id::text, e.device_id::text, 'anonymous') AS entity_id,
        u.email AS user_email,
        COUNT(*)::int AS total_requests,
        SUM(CASE WHEN e.success THEN 0 ELSE 1 END)::int AS failure_count,
        MAX(e.created_at) AS last_seen
      FROM api_usage_events e
      LEFT JOIN users u ON e.user_id = u.id
      WHERE e.created_at >= now() - interval '30 minutes'
      GROUP BY u.email, e.user_id, e.device_id
      HAVING SUM(CASE WHEN e.success THEN 0 ELSE 1 END) >= 10
      ORDER BY failure_count DESC
      `
    );

    errorRows.forEach((r) => {
      const failRate = Math.round((r.failure_count / r.total_requests) * 100);
      alerts.push({
        id: `error-surge-${r.entity_id}`,
        category: 'Failure & Error Surge',
        severity: failRate >= 50 ? 'HIGH' : 'LOW',
        entityId: r.entity_id,
        userEmail: r.user_email || 'Guest Device',
        count: r.failure_count,
        windowMinutes: 30,
        title: `High Error / Failure Rate`,
        description: `Entity logged ${r.failure_count} failures (${failRate}% error rate) out of ${r.total_requests} requests.`,
        recommendation: `Inspect error logs for invalid auth credentials, malformed request payloads, or API key exhaustion.`,
        lastDetected: r.last_seen,
      });
    });

    // Compute Overall Threat Level & Risk Score (0 - 100)
    const highAlerts = alerts.filter((a) => a.severity === 'HIGH').length;
    const medAlerts = alerts.filter((a) => a.severity === 'MEDIUM').length;
    const lowAlerts = alerts.filter((a) => a.severity === 'LOW').length;

    let riskScore = Math.min(100, highAlerts * 30 + medAlerts * 15 + lowAlerts * 5);
    let threatLevel = 'NORMAL';
    if (riskScore >= 80) threatLevel = 'CRITICAL';
    else if (riskScore >= 50) threatLevel = 'SEVERE';
    else if (riskScore >= 20) threatLevel = 'ELEVATED';

    return {
      threatLevel,
      riskScore,
      totalActiveAlerts: alerts.length,
      alerts,
      evaluatedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error('Failed to evaluate fraud alerts:', err.message);
    return {
      threatLevel: 'UNKNOWN',
      riskScore: 0,
      totalActiveAlerts: 0,
      alerts: [],
      evaluatedAt: new Date().toISOString(),
      error: err.message,
    };
  }
}
