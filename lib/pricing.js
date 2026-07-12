// Estimated USD pricing, used only for the AWS side (Gemini/Sarvam/Firebase costs arrive
// already computed in api_usage_events.cost_usd — see d:\Medical\backend\pricing.js, which
// these numbers should stay in sync with). List prices, not real invoices. Last verified 2026-07-12.
// https://aws.amazon.com/lambda/pricing/ (arm64/Graviton2, us-east-1)
// https://aws.amazon.com/api-gateway/pricing/ (HTTP API, us-east-1)
export const AWS_PRICING = {
  lambdaArm64PerGbSecond: 0.0000133334,
  lambdaPerMRequests: 0.20,
  lambdaFreeRequestsPerMonth: 1_000_000,
  lambdaFreeGbSecondsPerMonth: 400_000,
  httpApiPerMRequests: 1.00,
  httpApiFreeRequestsPerMonth: 1_000_000, // only for the account's first 12 months
};

export const FIREBASE_PHONE_AUTH = {
  freeVerificationsPerMonth: 10000,
};
