import db from './db.js';

/**
 * Calculates customer-centric analytics including active users, churn rate, user journeys,
 * and power customer breakdowns.
 */
export async function calculateCustomerAnalytics(days = 30) {
  try {
    // 1. Combined User Account & Guest Device Customer Model
    const { rows: summaryRows } = await db.query(
      `
      WITH user_device_map AS (
        SELECT DISTINCT ON (e.device_id)
          e.device_id,
          u.email AS mapped_email,
          u.created_at AS user_created_at
        FROM api_usage_events e
        JOIN users u ON e.user_id = u.id
        WHERE e.device_id IS NOT NULL
        ORDER BY e.device_id, e.created_at DESC
      ),
      unified_events AS (
        SELECT 
          e.id,
          e.created_at,
          COALESCE(u.email, m.mapped_email, e.user_id::text, e.device_id::text, 'anonymous') AS customer_id,
          LEAST(COALESCE(u.created_at, m.user_created_at, d.created_at, e.created_at), e.created_at) AS event_created
        FROM api_usage_events e
        LEFT JOIN users u ON e.user_id = u.id
        LEFT JOIN user_device_map m ON e.device_id = m.device_id
        LEFT JOIN devices d ON e.device_id::text = d.device_id::text
      ),
      global_customer_first_seen AS (
        SELECT 
          customer_id,
          MIN(event_created) AS true_first_seen
        FROM unified_events
        GROUP BY 1
      ),
      window_active_customers AS (
        SELECT 
          customer_id
        FROM unified_events
        WHERE created_at > now() - ($1 || ' days')::interval
        GROUP BY 1
      )
      SELECT 
        COUNT(DISTINCT w.customer_id)::int AS active_customers,
        COUNT(DISTINCT CASE WHEN g.true_first_seen >= now() - ($1 || ' days')::interval THEN w.customer_id END)::int AS new_customers,
        COUNT(DISTINCT CASE WHEN g.true_first_seen < now() - ($1 || ' days')::interval THEN w.customer_id END)::int AS returning_customers
      FROM window_active_customers w
      JOIN global_customer_first_seen g ON w.customer_id = g.customer_id
      `,
      [days]
    );

    const activeCustomers = summaryRows[0]?.active_customers || 0;
    const newCustomers = summaryRows[0]?.new_customers || 0;
    const returningCustomers = summaryRows[0]?.returning_customers || 0;

    // 2. Churn Rate calculation comparing previous window vs current window
    const { rows: churnRows } = await db.query(
      `
      WITH prev_users AS (
        SELECT DISTINCT COALESCE(user_id::text, device_id::text, 'anonymous') AS customer_id
        FROM api_usage_events
        WHERE created_at >= now() - ($1 * 2 || ' days')::interval
          AND created_at < now() - ($1 || ' days')::interval
      ),
      curr_users AS (
        SELECT DISTINCT COALESCE(user_id::text, device_id::text, 'anonymous') AS customer_id
        FROM api_usage_events
        WHERE created_at >= now() - ($1 || ' days')::interval
      )
      SELECT 
        (SELECT COUNT(*)::int FROM prev_users) AS prev_total,
        (SELECT COUNT(*)::int FROM prev_users p WHERE p.customer_id IN (SELECT customer_id FROM curr_users)) AS retained_total,
        (SELECT COUNT(*)::int FROM prev_users p WHERE p.customer_id NOT IN (SELECT customer_id FROM curr_users)) AS churned_total
      `,
      [days]
    );

    const prevTotal = churnRows[0]?.prev_total || 0;
    const retainedTotal = churnRows[0]?.retained_total || 0;
    const churnedTotal = churnRows[0]?.churned_total || 0;
    const churnRatePct = prevTotal > 0 ? parseFloat(((churnedTotal / prevTotal) * 100).toFixed(2)) : 0;

    // 3. User Journey Transition Paths (e.g. otp-verify -> medicine-info -> scan)
    const { rows: journeyRows } = await db.query(
      `
      WITH user_ops AS (
        SELECT 
          COALESCE(user_id::text, device_id::text, 'anonymous') AS customer_id,
          operation,
          created_at,
          LAG(operation) OVER (
            PARTITION BY COALESCE(user_id::text, device_id::text, 'anonymous') 
            ORDER BY created_at
          ) AS prev_op
        FROM api_usage_events
        WHERE created_at > now() - ($1 || ' days')::interval
      )
      SELECT 
        prev_op, 
        operation AS next_op, 
        COUNT(*)::int AS count
      FROM user_ops
      WHERE prev_op IS NOT NULL
      GROUP BY prev_op, operation
      ORDER BY count DESC
      LIMIT 12
      `,
      [days]
    );

    const userJourneys = journeyRows.map((r) => ({
      from: r.prev_op,
      to: r.next_op,
      path: `${r.prev_op} ➔ ${r.next_op}`,
      count: r.count,
    }));

    // 4. Power Customers Breakdown (Top customers by spend & request volume)
    const { rows: customerRows } = await db.query(
      `
      SELECT 
        COALESCE(u.email, e.user_id::text, e.device_id::text, 'anonymous') AS customer_id,
        u.email AS user_email,
        COUNT(*)::int AS requests,
        SUM(e.cost_usd)::float AS total_cost,
        AVG(e.latency_ms)::float AS avg_latency_ms,
        SUM(CASE WHEN e.success THEN 0 ELSE 1 END)::int AS failures,
        MIN(e.created_at) AS first_seen,
        MAX(e.created_at) AS last_seen,
        ARRAY_AGG(DISTINCT e.operation) AS operations
      FROM api_usage_events e
      LEFT JOIN users u ON e.user_id = u.id
      WHERE e.created_at > now() - ($1 || ' days')::interval
      GROUP BY u.email, e.user_id, e.device_id
      ORDER BY total_cost DESC
      LIMIT 15
      `,
      [days]
    );

    const topCustomers = customerRows.map((c) => ({
      customerId: c.customer_id,
      userEmail: c.user_email,
      requests: c.requests,
      totalCost: c.total_cost,
      avgLatencyMs: c.avg_latency_ms ? Math.round(c.avg_latency_ms) : null,
      failures: c.failures,
      firstSeen: c.first_seen,
      lastSeen: c.last_seen,
      operations: c.operations || [],
    }));

    return {
      windowDays: days,
      summary: {
        activeCustomers,
        newCustomers,
        returningCustomers,
        prevPeriodTotalCustomers: prevTotal,
        retainedCustomers: retainedTotal,
        churnedCustomers: churnedTotal,
        churnRatePct,
      },
      userJourneys,
      topCustomers,
    };
  } catch (err) {
    console.error('Failed to calculate customer analytics:', err.message);
    return {
      windowDays: days,
      summary: {
        activeCustomers: 0,
        newCustomers: 0,
        returningCustomers: 0,
        guestDeviceSessions: 0,
        prevPeriodTotalCustomers: 0,
        retainedCustomers: 0,
        churnedCustomers: 0,
        churnRatePct: 0,
      },
      userJourneys: [],
      topCustomers: [],
    };
  }
}
