import path from "node:path";

import { discoverCases } from "./cases.js";
import { loadConfig, publicConfigSnapshot } from "./config.js";
import {
  buildDependencySnapshot,
  installRunAssets,
  prepareDependencies,
} from "./dependencies.js";
import { computeAggregateMetrics } from "./metrics.js";
import { runAttemptWithOpencode } from "./opencode-runner.js";
import { runCompileCheck, runStructuralChecks } from "./validation.js";
import {
  copyDirectory,
  ensureDir,
  movePath,
  pathExists,
  runProcess,
  timestampId,
  writeJson,
  writeText,
} from "./utils.js";

export async function runEvaluation({ projectRoot, configPath, overrides = {} }) {
  const config = await loadConfig({ projectRoot, configPath, overrides });
  const runId = timestampId();
  const startedAt = new Date().toISOString();

  await archivePreviousRunIfNeeded(config);
  await ensureDir(config.runDir);
  await ensureDir(config.historyDir);

  await writeJson(path.join(config.runDir, "config.snapshot.json"), publicConfigSnapshot(config));

  const dependencyRepos = await prepareDependencies(config);
  const dependencySnapshot = await buildDependencySnapshot(config);
  await installRunAssets({ config, runDir: config.runDir });

  const environment = await collectEnvironment(config, dependencyRepos);
  await writeJson(path.join(config.runDir, "environment.json"), environment);

  const cases = await discoverCases(config.casesPath);
  const caseResults = [];

  for (const caseInfo of cases) {
    const attempts = [];
    for (let attemptIndex = 1; attemptIndex <= config.attempts; attemptIndex += 1) {
      const attemptDir = path.join(
        config.runDir,
        "cases",
        caseInfo.id,
        `attempt-${String(attemptIndex).padStart(2, "0")}`,
      );
      const workspaceDir = path.join(attemptDir, "workspace");

      await ensureDir(workspaceDir);
      await writeText(path.join(attemptDir, "prompt.txt"), caseInfo.promptText);

      const opencodeResult = await runAttemptWithOpencode({
        runDir: config.runDir,
        workspaceDir,
        attemptDir,
        caseId: caseInfo.id,
        attemptIndex,
        promptText: caseInfo.promptText,
        config,
      });

      const structure = await runStructuralChecks(workspaceDir);
      const compile = await runCompileCheck({
        config,
        workspaceDir,
        attemptDir,
        structure,
      });

      const attemptResult = {
        attemptIndex,
        caseId: caseInfo.id,
        promptPath: caseInfo.promptPath,
        workspaceDir,
        opencode: {
          ok: opencodeResult.ok,
          sessionID: opencodeResult.session?.id ?? null,
          finalText: opencodeResult.finalText,
          error: opencodeResult.error,
          exportResult: opencodeResult.exportResult,
        },
        structure,
        compile,
        passed: compile.status === "passed",
        structurePassed: structure.status === "passed",
      };

      await writeJson(path.join(attemptDir, "result.json"), attemptResult);
      attempts.push(attemptResult);
    }

    caseResults.push({
      caseId: caseInfo.id,
      promptPath: caseInfo.promptPath,
      relativeCaseDir: caseInfo.relativeCaseDir,
      attempts,
    });
  }

  const metrics = computeAggregateMetrics(caseResults, config.metricKs);
  const summary = {
    runId,
    startedAt,
    config: publicConfigSnapshot(config),
    dependencies: dependencySnapshot,
    environment,
    cases: caseResults,
    metrics,
    totals: {
      cases: caseResults.length,
      attempts: caseResults.reduce((sum, item) => sum + item.attempts.length, 0),
      compilePassedAttempts: caseResults.reduce(
        (sum, item) => sum + item.attempts.filter((attempt) => attempt.passed).length,
        0,
      ),
      structurePassedAttempts: caseResults.reduce(
        (sum, item) => sum + item.attempts.filter((attempt) => attempt.structurePassed).length,
        0,
      ),
    },
    finishedAt: new Date().toISOString(),
  };

  await writeJson(path.join(config.runDir, "results.json"), summary);

  const historyRunDir = path.join(config.historyDir, "runs", runId);
  await ensureDir(historyRunDir);
  await writeJson(path.join(historyRunDir, "results.json"), summary);
  await writeJson(path.join(historyRunDir, "environment.json"), environment);
  await writeJson(path.join(historyRunDir, "config.snapshot.json"), publicConfigSnapshot(config));

  if (config.history.archiveCases && (await pathExists(path.join(config.runDir, "cases")))) {
    await copyDirectory(path.join(config.runDir, "cases"), path.join(historyRunDir, "cases"));
  }

  return summary;
}

async function archivePreviousRunIfNeeded(config) {
  if (!(await pathExists(config.runDir))) {
    return;
  }

  const recoveryDir = path.join(config.historyDir, "recovered", timestampId());
  await ensureDir(path.dirname(recoveryDir));
  await movePath(config.runDir, recoveryDir);
}

async function collectEnvironment(config, dependencyRepos) {
  const opencodeVersion = await commandStdout("opencode", ["--version"]);
  const gitVersion = await commandStdout("git", ["--version"]);

  return {
    nodeVersion: process.version,
    opencodeVersion: opencodeVersion.trim(),
    gitVersion: gitVersion.trim(),
    cwd: config.projectRoot,
    dependencyRepos,
  };
}

async function commandStdout(command, args) {
  const result = await runProcess({ command, args });
  if (result.code !== 0) {
    return `${command} failed`;
  }
  return result.stdout;
}
