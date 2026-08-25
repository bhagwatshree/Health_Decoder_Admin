import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is not set (see .env.example).');

// On a scale-to-zero host every warm container opens its own pool, so the real
// connection count is PG_POOL_MAX x containers. Point DATABASE_URL at Neon's
// pooled endpoint (the "-pooler" host) and keep this small — Neon's free tier
// caps direct connections.
const pool = new pg.Pool({
  connectionString,
  max: parseInt(process.env.PG_POOL_MAX, 10) || 2,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
});

if (!/-pooler\./.test(connectionString)) {
  console.warn('WARNING: DATABASE_URL is not using Neon\'s pooled endpoint (-pooler host). Expect connection-limit errors under concurrency.');
}

// A pooled client erroring while idle must not take the process down with it.
pool.on('error', (err) => console.error('Postgres pool error:', err.message));

export default pool;
