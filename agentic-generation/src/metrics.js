export function estimatePassAtK(totalSamples, correctSamples, k) {
  if (totalSamples <= 0 || k <= 0) {
    return 0;
  }

  const cappedK = Math.min(k, totalSamples);
  const incorrectSamples = totalSamples - correctSamples;

  if (incorrectSamples < cappedK) {
    return 1;
  }

  let product = 1;
  for (let index = incorrectSamples + 1; index <= totalSamples; index += 1) {
    product *= 1 - cappedK / index;
  }
  return 1 - product;
}

export function computeAggregateMetrics(caseResults, metricKs) {
  const compilePassAt = {};
  const structurePassAt = {};
  const tokenTotals = {
    total: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
  let attemptCount = 0;

  for (const metricK of metricKs) {
    let compileTotal = 0;
    let structureTotal = 0;

    for (const caseResult of caseResults) {
      const attempts = caseResult.attempts.length;
      const compilePassed = caseResult.attempts.filter((attempt) => attempt.passed).length;
      const structurePassed = caseResult.attempts.filter((attempt) => attempt.structurePassed).length;

      compileTotal += estimatePassAtK(attempts, compilePassed, metricK);
      structureTotal += estimatePassAtK(attempts, structurePassed, metricK);
    }

    compilePassAt[String(metricK)] = caseResults.length > 0 ? compileTotal / caseResults.length : 0;
    structurePassAt[String(metricK)] = caseResults.length > 0 ? structureTotal / caseResults.length : 0;
  }

  for (const caseResult of caseResults) {
    for (const attempt of caseResult.attempts) {
      attemptCount += 1;
      const usage = attempt?.opencode?.usage ?? {};
      tokenTotals.total += Number(usage.total ?? 0);
      tokenTotals.input += Number(usage.input ?? 0);
      tokenTotals.output += Number(usage.output ?? 0);
      tokenTotals.reasoning += Number(usage.reasoning ?? 0);
      tokenTotals.cacheRead += Number(usage.cacheRead ?? 0);
      tokenTotals.cacheWrite += Number(usage.cacheWrite ?? 0);
      tokenTotals.cost += Number(usage.cost ?? 0);
    }
  }

  return {
    compilePassAt,
    structurePassAt,
    opencodeUsage: {
      total: tokenTotals,
      averagePerAttempt: {
        total: attemptCount > 0 ? tokenTotals.total / attemptCount : 0,
        input: attemptCount > 0 ? tokenTotals.input / attemptCount : 0,
        output: attemptCount > 0 ? tokenTotals.output / attemptCount : 0,
        reasoning: attemptCount > 0 ? tokenTotals.reasoning / attemptCount : 0,
        cacheRead: attemptCount > 0 ? tokenTotals.cacheRead / attemptCount : 0,
        cacheWrite: attemptCount > 0 ? tokenTotals.cacheWrite / attemptCount : 0,
        cost: attemptCount > 0 ? tokenTotals.cost / attemptCount : 0,
      },
    },
  };
}
