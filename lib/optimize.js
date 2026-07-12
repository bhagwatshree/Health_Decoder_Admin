/** Rule-based cost suggestions from aggregated usage. Each rule only fires when the numbers
 *  actually support it — thresholds are noted inline so they're easy to retune later. */
export function generateOptimizations({ totals, costByOperation, costByModel, firebaseThisMonth, awsFreeTier }) {
  const suggestions = [];

  if (totals.totalCost < 0.05) {
    suggestions.push({
      severity: 'info',
      title: 'Usage is minimal',
      detail: `Estimated spend in this window is $${totals.totalCost.toFixed(4)} — too low to optimize meaningfully yet.`,
    });
    return suggestions;
  }

  // Gemini TTS is ~4-20x the price per token of gemini-2.5-flash text calls (output audio
  // tokens are priced at $10/M vs $2.50/M text) — flag it if it's a real share of spend.
  const ttsModel = costByModel.find((m) => m.model === 'gemini-2.5-flash-preview-tts');
  if (ttsModel && ttsModel.total_cost / totals.totalCost > 0.2) {
    suggestions.push({
      severity: 'warning',
      title: 'Gemini TTS is a large share of spend',
      detail: `gemini-2.5-flash-preview-tts is ${((ttsModel.total_cost / totals.totalCost) * 100).toFixed(0)}% of total cost ` +
        `($${ttsModel.total_cost.toFixed(4)} over ${ttsModel.requests} calls). Sarvam TTS (₹15-30/10k chars) is usually ` +
        `cheaper for Indic voices — consider defaulting the "gemini" TTS engine option to "sarvam" unless multilingual ` +
        `auto-detection is specifically needed.`,
    });
  }

  // Firebase phone-auth free tier: 10k verifications/month, then $0.01 each.
  if (firebaseThisMonth.verifications > 0) {
    const pctUsed = (firebaseThisMonth.verifications / firebaseThisMonth.freeAllowance) * 100;
    if (firebaseThisMonth.overFreeAllowance > 0) {
      suggestions.push({
        severity: 'critical',
        title: 'Firebase phone-auth free tier exceeded this month',
        detail: `${firebaseThisMonth.verifications} verifications so far (free allowance is ${firebaseThisMonth.freeAllowance}/month) — ` +
          `${firebaseThisMonth.overFreeAllowance} are billed at ~$0.01 each. If this is from repeated OTP resends during testing, ` +
          `add client-side resend cooldown/rate-limiting.`,
      });
    } else if (pctUsed > 50) {
      suggestions.push({
        severity: 'info',
        title: 'Firebase phone-auth approaching free tier limit',
        detail: `${firebaseThisMonth.verifications}/${firebaseThisMonth.freeAllowance} free verifications used this month (${pctUsed.toFixed(0)}%).`,
      });
    }
  }

  // AWS Lambda free tier: 1M requests + 400k GB-seconds/month.
  if (awsFreeTier && (awsFreeTier.requestsPctUsed > 50 || awsFreeTier.gbSecondsPctUsed > 50)) {
    suggestions.push({
      severity: 'info',
      title: 'AWS Lambda free tier usage climbing',
      detail: `Month-to-date: ${awsFreeTier.invocations.toFixed(0)} invocations (${awsFreeTier.requestsPctUsed.toFixed(0)}% of ` +
        `1M free) and ~${awsFreeTier.gbSeconds.toFixed(0)} GB-seconds (${awsFreeTier.gbSecondsPctUsed.toFixed(0)}% of 400k free).`,
    });
  } else if (awsFreeTier) {
    suggestions.push({
      severity: 'good',
      title: 'AWS Lambda is fully within the free tier',
      detail: `Month-to-date: ${awsFreeTier.invocations.toFixed(0)} invocations (${awsFreeTier.requestsPctUsed.toFixed(1)}% of free ` +
        `tier), ~${awsFreeTier.gbSeconds.toFixed(0)} GB-seconds (${awsFreeTier.gbSecondsPctUsed.toFixed(1)}%). AWS cost is $0 right now.`,
    });
  }

  // Output-token-heavy operations cost more per call (output tokens are ~8x input price on
  // gemini-2.5-flash) — flag the worst offender if it dominates spend.
  const topOp = costByOperation[0];
  if (topOp && topOp.total_cost / totals.totalCost > 0.4) {
    suggestions.push({
      severity: 'info',
      title: `"${topOp.operation}" is the largest single cost driver`,
      detail: `$${topOp.total_cost.toFixed(4)} across ${topOp.requests} ${topOp.provider} calls ` +
        `(${((topOp.total_cost / totals.totalCost) * 100).toFixed(0)}% of total). If responses are verbose, trimming ` +
        `prompt length or capping output tokens will cut this roughly proportionally.`,
    });
  }

  // General best-practice note — not data-driven, always shown as a low-priority reminder.
  suggestions.push({
    severity: 'info',
    title: 'Lambda memory sizing',
    detail: 'The function is fixed at 512MB (see template.yaml). AWS Lambda Power Tuning ' +
      '(a standalone open-source tool) can find the memory size that minimizes cost x duration ' +
      'for this specific workload — worth a one-time run if traffic grows.',
  });

  return suggestions;
}
