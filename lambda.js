/**
 * Lambda entrypoint. serverless-http translates the Function URL's
 * API Gateway v2 payload into the req/res objects Express expects, so
 * server.js stays a plain Express app that also runs with `npm start`.
 */
import serverless from 'serverless-http';
import app from './server.js';

// binary: false — this app serves only HTML/JSON/CSS/JS.
export const handler = serverless(app);
