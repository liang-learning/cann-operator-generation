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

  return {
    compilePassAt,
    structurePassAt,
  };
}
