import path from "node:path";
import { promises as fs } from "node:fs";

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
  appendText,
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

  const runLogPath = path.join(config.runDir, "logs", "run.log");
  const logRun = createEvaluationLogger({ runLogPath });

  await writeJson(path.join(config.runDir, "config.snapshot.json"), publicConfigSnapshot(config));
  await logRun(`run started: runId=${runId}`);
  await logRun(`config: casesPath=${config.casesPath} attempts=${config.attempts} metricKs=${config.metricKs.join(",")}`);

  const dependencyRepos = await prepareDependencies(config);
  const dependencySnapshot = await buildDependencySnapshot(config);
  await installRunAssets({ config, runDir: config.runDir });
  await logRun("dependencies prepared and run assets installed");

  const environment = await collectEnvironment(config, dependencyRepos);
  await writeJson(path.join(config.runDir, "environment.json"), environment);
  await logRun(`environment: node=${environment.nodeVersion} opencode=${environment.opencodeVersion} git=${environment.gitVersion}`);

  const cases = await discoverCases(config.casesPath);
  await logRun(`discovered ${cases.length} case(s)`);
  const caseResults = [];

  for (const caseInfo of cases) {
    await logRun(`case started: ${caseInfo.id} (${caseInfo.promptPath})`);
    const attempts = [];
    for (let attemptIndex = 1; attemptIndex <= config.attempts; attemptIndex += 1) {
      const attemptDir = path.join(
        config.runDir,
        "cases",
        caseInfo.id,
        `attempt-${String(attemptIndex).padStart(2, "0")}`,
      );
      const workspaceDir = path.join(attemptDir, "workspace");
      const attemptLogPath = path.join(attemptDir, "logs", "attempt.log");
      const logAttempt = createEvaluationLogger({
        runLogPath,
        attemptLogPath,
        prefix: `${caseInfo.id}#${attemptIndex}`,
      });

      await ensureDir(workspaceDir);
      await prepareAttemptWorkspace({
        runDir: config.runDir,
        workspaceDir,
      });
      await writeText(path.join(attemptDir, "prompt.txt"), caseInfo.promptText);
      await logAttempt("attempt started");

      const opencodeResult = await runAttemptWithOpencode({
        runDir: config.runDir,
        workspaceDir,
        attemptDir,
        caseId: caseInfo.id,
        attemptIndex,
        promptText: caseInfo.promptText,
        config,
        onLog: logAttempt,
      });
      await logAttempt(
        `opencode finished: ok=${opencodeResult.ok} sessionID=${opencodeResult.session?.id ?? "none"}`,
      );

      const structure = await runStructuralChecks(workspaceDir);
      await logAttempt(
        `structure check: status=${structure.status} asc=${structure.ascFiles.length} headers=${structure.headerFiles.length} cmake=${structure.cmakeFiles.length}`,
      );
      const compile = await runCompileCheck({
        config,
        workspaceDir,
        attemptDir,
        structure,
      });
      await logAttempt(`compile check: status=${compile.status} reason=${compile.reason ?? "n/a"}`);

      const attemptResult = {
        attemptIndex,
        caseId: caseInfo.id,
        promptPath: caseInfo.promptPath,
        workspaceDir,
        opencode: {
          ok: opencodeResult.ok,
          sessionID: opencodeResult.session?.id ?? null,
          finalText: opencodeResult.finalText,
          usage: opencodeResult.usage,
          error: opencodeResult.error,
          exportResult: opencodeResult.exportResult,
        },
        structure,
        compile,
        passed: compile.status === "passed",
        structurePassed: structure.status === "passed",
      };

      await writeJson(path.join(attemptDir, "result.json"), attemptResult);
      await logAttempt(
        `attempt finished: passed=${attemptResult.passed} structurePassed=${attemptResult.structurePassed} tokens=${attemptResult.opencode.usage.total}`,
      );
      attempts.push(attemptResult);
    }

    caseResults.push({
      caseId: caseInfo.id,
      promptPath: caseInfo.promptPath,
      relativeCaseDir: caseInfo.relativeCaseDir,
      attempts,
    });
    await logRun(
      `case finished: ${caseInfo.id} passedAttempts=${attempts.filter((attempt) => attempt.passed).length}/${attempts.length}`,
    );
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
      opencodeUsage: summarizeTotalOpencodeUsage(caseResults),
    },
    finishedAt: new Date().toISOString(),
  };

  await writeJson(path.join(config.runDir, "results.json"), summary);
  await logRun(
    `run finished: totalCases=${summary.totals.cases} totalAttempts=${summary.totals.attempts} compilePassed=${summary.totals.compilePassedAttempts} structurePassed=${summary.totals.structurePassedAttempts}`,
  );

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

function createEvaluationLogger({ runLogPath, attemptLogPath = null, prefix = null }) {
  return async (message) => {
    const line = `[${new Date().toISOString()}]${prefix ? ` [${prefix}]` : ""} ${message}\n`;
    await appendText(runLogPath, line);
    if (attemptLogPath) {
      await appendText(attemptLogPath, line);
    }
    const consoleLine = formatConsoleLogLine({ prefix, message });
    if (consoleLine) {
      process.stderr.write(consoleLine);
    }
  };
}

function formatConsoleLogLine({ prefix, message }) {
  if (message.startsWith("heartbeat:")) {
    return null;
  }
  if (message === "dependencies prepared and run assets installed") {
    return renderConsoleLine(prefix, "setup ready");
  }
  if (message.startsWith("environment:")) {
    return renderConsoleLine(prefix, message);
  }
  if (message.startsWith("discovered ")) {
    return renderConsoleLine(prefix, message);
  }
  if (message.startsWith("run started:")) {
    return renderConsoleLine(prefix, message);
  }
  if (message.startsWith("run finished:")) {
    return renderConsoleLine(prefix, message);
  }
  if (message.startsWith("config:")) {
    return renderConsoleLine(prefix, message);
  }
  if (message.startsWith("case started:")) {
    return renderConsoleLine(prefix, simplifyCaseStarted(message));
  }
  if (message.startsWith("case finished:")) {
    return renderConsoleLine(prefix, simplifyCaseFinished(message));
  }
  if (message === "attempt started") {
    return renderConsoleLine(prefix, "attempt started");
  }
  if (message.startsWith("session created:")) {
    return renderConsoleLine(prefix, `opencode session created ${message.slice("session created:".length).trim()}`);
  }
  if (message === "prompt accepted by opencode") {
    return renderConsoleLine(prefix, "opencode prompt accepted");
  }
  if (message.startsWith("waiting for idle:")) {
    return renderConsoleLine(prefix, "opencode running");
  }
  if (message.startsWith("progress:")) {
    return renderConsoleProgress(prefix, message);
  }
  if (message.startsWith("event:")) {
    return renderConsoleEvent(prefix, message);
  }
  if (message.startsWith("stall diagnostics saved:")) {
    return renderConsoleLine(prefix, `diagnostics saved: ${message.slice("stall diagnostics saved:".length).trim()}`);
  }
  if (message.startsWith("stall detected:")) {
    return renderConsoleLine(prefix, `opencode stalled: ${message.slice("stall detected:".length).trim()}`);
  }
  if (message.startsWith("session failed:")) {
    return renderConsoleLine(prefix, `opencode failed: ${message.slice("session failed:".length).trim()}`);
  }
  if (message.startsWith("opencode finished:")) {
    return renderConsoleLine(prefix, message);
  }
  if (message.startsWith("structure check:")) {
    return renderConsoleLine(prefix, `validation ${message.slice("structure check:".length).trim()}`);
  }
  if (message.startsWith("compile check:")) {
    return renderConsoleLine(prefix, `compile ${message.slice("compile check:".length).trim()}`);
  }
  if (message.startsWith("attempt finished:")) {
    return renderConsoleLine(prefix, message);
  }
  return renderConsoleLine(prefix, message);
}

function renderConsoleProgress(prefix, message) {
  const match = message.match(/^progress:\s+signal=([^\s]+)\s+status=([^\s]+)/);
  if (!match) {
    return renderConsoleLine(prefix, message);
  }

  const signal = match[1];
  const status = match[2];
  if (signal === "session.messages") {
    return renderConsoleLine(prefix, `opencode syncing messages (${status})`);
  }
  if (signal === "message.reasoning") {
    return renderConsoleLine(prefix, `opencode reasoning (${status})`);
  }
  if (signal === "message.text") {
    return renderConsoleLine(prefix, `opencode outputting (${status})`);
  }
  if (signal === "workspace.files.changed") {
    return renderConsoleLine(prefix, `workspace files updating (${status})`);
  }
  if (signal.startsWith("tool:")) {
    const [, toolName = "unknown", toolStatus = status] = signal.split(":");
    return renderConsoleLine(prefix, `opencode tool ${toolName} ${toolStatus}`);
  }
  if (signal.startsWith("task.active:")) {
    return renderConsoleLine(prefix, "opencode subtask running");
  }
  if (signal.startsWith("task.children:")) {
    return renderConsoleLine(prefix, "opencode subtask updated");
  }
  if (signal.startsWith("session.status:")) {
    return null;
  }
  if (signal.startsWith("message.")) {
    return renderConsoleLine(prefix, `opencode ${signal.replace("message.", "")} (${status})`);
  }
  return renderConsoleLine(prefix, `opencode ${signal} (${status})`);
}

function renderConsoleEvent(prefix, message) {
  const eventType = message.slice("event:".length).trim();
  if (eventType === "session.status") {
    return null;
  }
  if (eventType === "todo.updated") {
    return renderConsoleLine(prefix, "todo updated");
  }
  if (eventType === "session.error") {
    return renderConsoleLine(prefix, "opencode reported session error");
  }
  if (eventType === "question.asked") {
    return renderConsoleLine(prefix, "opencode is waiting for a question response");
  }
  if (eventType === "permission.asked") {
    return renderConsoleLine(prefix, "opencode is waiting for permission");
  }
  return renderConsoleLine(prefix, `event ${eventType}`);
}

function simplifyCaseStarted(message) {
  const match = message.match(/^case started:\s+(.+?)\s+\((.+)\)$/);
  if (!match) {
    return message;
  }
  const caseId = match[1];
  return `case started: ${caseId}`;
}

function simplifyCaseFinished(message) {
  const match = message.match(/^case finished:\s+(.+?)\s+passedAttempts=(.+)$/);
  if (!match) {
    return message;
  }
  return `case finished: ${match[1]} pass=${match[2]}`;
}

function renderConsoleLine(prefix, text) {
  return `[${new Date().toISOString()}]${prefix ? ` [${prefix}]` : ""} ${text}\n`;
}

async function prepareAttemptWorkspace({ runDir, workspaceDir }) {
  const ascDevkitSource = path.join(runDir, "asc-devkit");
  if (!(await pathExists(ascDevkitSource))) {
    return;
  }

  const ascDevkitTarget = path.join(workspaceDir, "asc-devkit");
  if (await pathExists(ascDevkitTarget)) {
    return;
  }

  const relativeTarget = path.relative(workspaceDir, ascDevkitSource);
  await fs.symlink(relativeTarget, ascDevkitTarget, "dir");
}

async function archivePreviousRunIfNeeded(config) {
  if (!(await pathExists(config.runDir))) {
    return;
  }

  const recoveryDir = path.join(config.historyDir, "recovered", timestampId());
  await ensureDir(path.dirname(recoveryDir));
  await movePath(config.runDir, recoveryDir);
}

function summarizeTotalOpencodeUsage(caseResults) {
  const totals = {
    total: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };

  for (const caseResult of caseResults) {
    for (const attempt of caseResult.attempts) {
      const usage = attempt?.opencode?.usage ?? {};
      totals.total += Number(usage.total ?? 0);
      totals.input += Number(usage.input ?? 0);
      totals.output += Number(usage.output ?? 0);
      totals.reasoning += Number(usage.reasoning ?? 0);
      totals.cacheRead += Number(usage.cacheRead ?? 0);
      totals.cacheWrite += Number(usage.cacheWrite ?? 0);
      totals.cost += Number(usage.cost ?? 0);
    }
  }

  return totals;
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
