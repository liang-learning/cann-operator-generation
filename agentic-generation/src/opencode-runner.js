import path from "node:path";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";

import { createOpencodeClient } from "@opencode-ai/sdk";

import { ensureDir, listFilesRecursive, pathExists, runProcess, sleep, writeJson, writeText } from "./utils.js";

const activeServerClosers = new Set();
let cleanupHandlersInstalled = false;
let cleanupInFlight = null;

export async function runAttemptWithOpencode({
  runDir,
  workspaceDir,
  attemptDir,
  caseId,
  attemptIndex,
  promptText,
  config,
  onLog = async () => {},
}) {
  const originalCwd = process.cwd();
  let client = null;
  let server = null;
  let session = null;

  await ensureDir(path.join(attemptDir, "opencode"));

  let restoreEnvironment = null;

  try {
    process.chdir(runDir);
    restoreEnvironment = await applyOpencodeEnvironment({ runDir });
    const instance = await startOpencodeServer({
      port: 0,
      timeout: config.opencode.startupTimeoutSec * 1000,
    });
    server = instance.server;
    client = instance.client;

    session = unwrapSdkResult(
      await client.session.create({
        query: {
          directory: workspaceDir,
        },
        body: {
          title: `${caseId} attempt ${attemptIndex}`,
        },
      }),
      "session.create",
    );
    await onLog(`session created: ${session.id}`);

    unwrapSdkResult(
      await client.session.promptAsync({
        path: {
          id: session.id,
        },
        query: {
          directory: workspaceDir,
        },
        body: {
          model: config.opencode.model ?? undefined,
          agent: config.opencode.agent ?? undefined,
          system: config.opencode.systemPrompt ?? undefined,
          parts: [
            {
              type: "text",
              text: promptText,
            },
          ],
        },
      }),
      "session.promptAsync",
    );
    await onLog("prompt accepted by opencode");

    await waitForSessionIdle({
      client,
      sessionID: session.id,
      workspaceDir,
      diagnosticsDir: path.join(attemptDir, "opencode"),
      timeoutMs: config.opencode.promptTimeoutSec * 1000,
      stalledTimeoutMs: config.opencode.stalledTimeoutSec * 1000,
      onLog,
    });
    await onLog("session became idle");

    const messages = unwrapSdkResult(
      await client.session.messages({
        path: {
          id: session.id,
        },
        query: {
          directory: workspaceDir,
          limit: config.runtime.maxMessages,
        },
      }),
      "session.messages",
    );
    const childSessions = await collectChildSessionMessages({
      client,
      sessionID: session.id,
      workspaceDir,
      maxMessages: config.runtime.maxMessages,
    });
    const combinedMessages = buildCombinedSessionMessages({
      rootSession: session,
      rootMessages: messages,
      childSessions,
    });
    const usage = summarizeOpencodeUsage(combinedMessages);
    const promptResponse = findLastAssistantMessage(messages);

    await writeJson(path.join(attemptDir, "opencode", "session.json"), session);
    await writeJson(path.join(attemptDir, "opencode", "prompt-response.json"), promptResponse);
    await writeJson(path.join(attemptDir, "opencode", "messages.json"), messages);
    await writeJson(path.join(attemptDir, "opencode", "child-sessions.json"), childSessions);
    await writeJson(path.join(attemptDir, "opencode", "messages.all.json"), combinedMessages);
    await writeJson(path.join(attemptDir, "opencode", "usage.json"), usage);
    await writeText(
      path.join(attemptDir, "opencode", "assistant-final.txt"),
      `${extractText(promptResponse.parts)}\n`,
    );

    const exportResult = config.opencode.exportSessionJson
      ? await exportSessionJson({
          sessionID: session.id,
          workspaceDir,
          destinationPath: path.join(attemptDir, "opencode", "session-export.json"),
        })
      : null;

    return {
      ok: true,
      session,
      promptResponse,
      messages,
      childSessions,
      usage,
      exportResult,
      finalText: extractText(promptResponse?.parts ?? []),
      error: null,
    };
  } catch (error) {
    const serializedError = serializeError(error);
    await writeJson(path.join(attemptDir, "opencode", "error.json"), serializedError);
    await onLog(`session failed: ${serializedError.message}`);

    if (session?.id && config.opencode.exportSessionJson) {
      await exportSessionJson({
        sessionID: session.id,
        workspaceDir,
        destinationPath: path.join(attemptDir, "opencode", "session-export.partial.json"),
      });
    }

    return {
      ok: false,
      session,
      promptResponse: null,
      messages: null,
      childSessions: [],
      usage: emptyOpencodeUsage(),
      exportResult: null,
      finalText: "",
      error: serializedError,
    };
  } finally {
    try {
      if (client) {
        await disposeOpencodeInstance(client);
      }
    } finally {
      try {
        await server?.close?.();
      } finally {
        restoreEnvironment?.();
        process.chdir(originalCwd);
      }
    }
  }
}

async function exportSessionJson({ sessionID, workspaceDir, destinationPath }) {
  const result = await runProcess({
    command: "opencode",
    args: ["export", sessionID],
    cwd: workspaceDir,
    timeoutMs: 120000,
  });

  if (result.code === 0 && result.stdout.trim()) {
    try {
      JSON.parse(result.stdout);
      await writeText(destinationPath, result.stdout);
      return {
        ok: true,
        destinationPath,
      };
    } catch (error) {
      await writeText(destinationPath, result.stdout);
      await writeJson(`${destinationPath}.error.json`, {
        code: result.code,
        stdoutPreview: result.stdout.slice(0, 4000),
        stderr: result.stderr,
        timedOut: result.timedOut,
        parseError: error.message,
      });
      return {
        ok: false,
        destinationPath,
      };
    }
  }

  await writeJson(`${destinationPath}.error.json`, {
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
  });
  return {
    ok: false,
    destinationPath,
  };
}

async function applyOpencodeEnvironment({ runDir }) {
  const previousEnv = {
    ASCEND_HOME_PATH: process.env.ASCEND_HOME_PATH,
    ASCENDC_CMAKE_PATH: process.env.ASCENDC_CMAKE_PATH,
    ASCENDC_DEVKIT_PATH: process.env.ASCENDC_DEVKIT_PATH,
    PATH: process.env.PATH,
  };

  const inferred = await inferLocalAscendEnvironment(runDir);
  if (inferred.ASCEND_HOME_PATH && !process.env.ASCEND_HOME_PATH) {
    process.env.ASCEND_HOME_PATH = inferred.ASCEND_HOME_PATH;
  }
  if (inferred.ASCENDC_CMAKE_PATH && !process.env.ASCENDC_CMAKE_PATH) {
    process.env.ASCENDC_CMAKE_PATH = inferred.ASCENDC_CMAKE_PATH;
  }
  if (inferred.ASCENDC_DEVKIT_PATH && !process.env.ASCENDC_DEVKIT_PATH) {
    process.env.ASCENDC_DEVKIT_PATH = inferred.ASCENDC_DEVKIT_PATH;
  }
  if (inferred.prependPath.length > 0) {
    const existingPathEntries = new Set((process.env.PATH ?? '').split(':').filter(Boolean));
    const pathEntries = [...inferred.prependPath.filter((entry) => !existingPathEntries.has(entry)), process.env.PATH ?? ''];
    process.env.PATH = pathEntries.filter(Boolean).join(':');
  }

  return () => {
    restoreEnvValue('ASCEND_HOME_PATH', previousEnv.ASCEND_HOME_PATH);
    restoreEnvValue('ASCENDC_CMAKE_PATH', previousEnv.ASCENDC_CMAKE_PATH);
    restoreEnvValue('ASCENDC_DEVKIT_PATH', previousEnv.ASCENDC_DEVKIT_PATH);
    restoreEnvValue('PATH', previousEnv.PATH);
  };
}

async function inferLocalAscendEnvironment(runDir) {
  const ascendHomeCandidates = [
    process.env.ASCEND_HOME_PATH,
    '/opt/miniconda3/Ascend/cann-8.5.0',
    '/opt/miniconda3/Ascend/ascend-toolkit',
    '/usr/local/Ascend/ascend-toolkit/latest',
  ].filter(Boolean);

  let ascendHomePath = null;
  for (const candidate of ascendHomeCandidates) {
    if (await pathExists(path.join(candidate, 'x86_64-linux')) || await pathExists(path.join(candidate, 'aarch64-linux'))) {
      ascendHomePath = candidate;
      break;
    }
  }

  const cmakeCandidates = ascendHomePath
    ? [
        path.join(ascendHomePath, 'x86_64-linux', 'lib64', 'cmake'),
        path.join(ascendHomePath, 'x86_64-linux', 'tikcpp', 'ascendc_kernel_cmake'),
        path.join(ascendHomePath, 'aarch64-linux', 'lib64', 'cmake'),
        path.join(ascendHomePath, 'aarch64-linux', 'tikcpp', 'ascendc_kernel_cmake'),
      ]
    : [];

  let ascendcCmakePath = null;
  for (const candidate of cmakeCandidates) {
    if (await pathExists(path.join(candidate, 'ASCConfig.cmake'))) {
      ascendcCmakePath = candidate;
      break;
    }
  }

  const ascendcDevkitPath = await pathExists(path.join(runDir, 'asc-devkit'))
    ? path.join(runDir, 'asc-devkit')
    : null;

  const prependPath = [];
  if (ascendHomePath) {
    for (const candidate of [
      path.join(ascendHomePath, 'x86_64-linux', 'bin'),
      path.join(ascendHomePath, 'aarch64-linux', 'bin'),
      path.join(ascendHomePath, 'tools', 'bisheng_compiler', 'bin'),
    ]) {
      if (await pathExists(candidate)) {
        prependPath.push(candidate);
      }
    }
  }

  return {
    ASCEND_HOME_PATH: ascendHomePath,
    ASCENDC_CMAKE_PATH: ascendcCmakePath,
    ASCENDC_DEVKIT_PATH: ascendcDevkitPath,
    prependPath,
  };
}

function restoreEnvValue(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function disposeOpencodeInstance(client) {
  try {
    unwrapSdkResult(await client.instance.dispose({}), "instance.dispose");
  } catch {
    // Ignore shutdown errors because the instance may already be gone.
  }
}

async function startOpencodeServer({ port, timeout }) {
  installProcessCleanupHandlers();
  const hostname = "127.0.0.1";
  const child = spawn(
    "opencode",
    ["serve", `--hostname=${hostname}`, `--port=${port}`],
    {
      detached: true,
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  const exitPromise = new Promise((resolve, reject) => {
    child.on("exit", (code, signal) => {
      resolve({ code, signal });
    });
    child.on("error", (error) => {
      reject(error);
    });
  });

  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for server to start after ${timeout}ms`));
    }, timeout);

    function cleanup() {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExitBeforeReady);
    }

    function onData(chunk) {
      output += chunk.toString();
      const lines = output.split("\n");
      for (const line of lines) {
        if (!line.startsWith("opencode server listening")) {
          continue;
        }
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
        if (!match) {
          cleanup();
          reject(new Error(`Failed to parse server url from output: ${line}`));
          return;
        }
        cleanup();
        resolve(match[1]);
        return;
      }
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    function onExitBeforeReady(code) {
      cleanup();
      let message = `Server exited with code ${code}`;
      if (output.trim()) {
        message += `\nServer output: ${output}`;
      }
      reject(new Error(message));
    }

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", onError);
    child.on("exit", onExitBeforeReady);
  });

  return {
    server: {
      async close() {
        if (child.exitCode !== null || child.signalCode !== null) {
          activeServerClosers.delete(closeServer);
          return;
        }
        await closeServer();
      },
    },
    client: createOpencodeClient({
      baseUrl: url,
    }),
  };

  async function closeServer() {
    if (child.exitCode !== null || child.signalCode !== null) {
      activeServerClosers.delete(closeServer);
      return;
    }
    terminateProcessTree(child.pid, "SIGTERM");
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        terminateProcessTree(child.pid, "SIGKILL");
      }
    }, 5000);
    killTimer.unref();
    try {
      await exitPromise;
    } finally {
      clearTimeout(killTimer);
      activeServerClosers.delete(closeServer);
    }
  }

  activeServerClosers.add(closeServer);
}

function terminateProcessTree(pid, signal) {
  if (!pid) {
    return;
  }
  try {
    process.kill(-pid, signal);
    return;
  } catch (error) {
    if (error?.code !== "ESRCH") {
      // Fall through to direct pid kill when process group signaling is unavailable.
    } else {
      return;
    }
  }

  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
}

function installProcessCleanupHandlers() {
  if (cleanupHandlersInstalled) {
    return;
  }
  cleanupHandlersInstalled = true;

  const cleanup = () => {
    if (!cleanupInFlight) {
      const closers = [...activeServerClosers];
      cleanupInFlight = Promise.allSettled(closers.map((closeServer) => closeServer()))
        .finally(() => {
          cleanupInFlight = null;
        });
    }
    return cleanupInFlight;
  };

  const installSignalHandler = (signal, exitCode) => {
    process.on(signal, () => {
      cleanup()
        .catch(() => {})
        .finally(() => {
          process.exit(exitCode);
        });
    });
  };

  installSignalHandler("SIGINT", 130);
  installSignalHandler("SIGTERM", 143);
  installSignalHandler("SIGHUP", 129);
  process.on("uncaughtException", (error) => {
    cleanup()
      .catch(() => {})
      .finally(() => {
        throw error;
      });
  });
  process.on("unhandledRejection", (reason) => {
    cleanup()
      .catch(() => {})
      .finally(() => {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        throw error;
      });
  });
  process.on("beforeExit", () => {
    for (const closeServer of [...activeServerClosers]) {
      void closeServer();
    }
  });
  process.on("disconnect", () => {
    void cleanup();
  });
  process.on("exit", () => {
    for (const closeServer of [...activeServerClosers]) {
      void closeServer();
    }
  });
}

function extractText(parts = []) {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    stack: error?.stack ?? null,
    payload: error?.payload ?? null,
  };
}

function unwrapSdkResult(result, operation) {
  if (result?.error) {
    const error = new Error(`${operation} failed`);
    error.payload = result.error;
    throw error;
  }
  if (!("data" in result)) {
    return result;
  }
  return result.data;
}

function findLastAssistantMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.info?.role === "assistant") {
      return messages[index];
    }
  }
  return {
    info: null,
    parts: [],
  };
}

async function collectChildSessionMessages({ client, sessionID, workspaceDir, maxMessages }) {
  const output = [];
  const queue = [{ sessionID, parentSessionID: null, depth: 0 }];
  const visited = new Set([sessionID]);

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    let children;
    try {
      children = unwrapSdkResult(
        await client.session.children({
          path: {
            sessionID: current.sessionID,
          },
          query: {
            directory: workspaceDir,
          },
        }),
        "session.children",
      );
    } catch {
      continue;
    }

    for (const child of children) {
      if (!child?.id || visited.has(child.id)) {
        continue;
      }
      visited.add(child.id);

      let messages = [];
      try {
        messages = unwrapSdkResult(
          await client.session.messages({
            path: {
              id: child.id,
            },
            query: {
              directory: workspaceDir,
              limit: maxMessages,
            },
          }),
          "session.messages",
        );
      } catch {
        messages = [];
      }

      output.push({
        session: child,
        parentSessionID: current.sessionID,
        depth: current.depth + 1,
        messages,
      });

      queue.push({
        sessionID: child.id,
        parentSessionID: current.sessionID,
        depth: current.depth + 1,
      });
    }
  }

  return output;
}

function buildCombinedSessionMessages({ rootSession, rootMessages, childSessions }) {
  const output = [
    ...rootMessages.map((message) => ({
      sessionID: rootSession?.id ?? null,
      parentSessionID: null,
      sessionTitle: rootSession?.title ?? null,
      message,
    })),
  ];

  for (const child of childSessions) {
    for (const message of child.messages ?? []) {
      output.push({
        sessionID: child.session?.id ?? null,
        parentSessionID: child.parentSessionID ?? rootSession?.id ?? null,
        sessionTitle: child.session?.title ?? null,
        depth: child.depth ?? 1,
        message,
      });
    }
  }

  return output.sort((left, right) => {
    const leftTime = left.message?.info?.time?.created ?? 0;
    const rightTime = right.message?.info?.time?.created ?? 0;
    return leftTime - rightTime;
  });
}

function summarizeOpencodeUsage(combinedMessages) {
  const totals = emptyOpencodeUsage();
  const seenMessageIDs = new Set();

  for (const item of combinedMessages) {
    const info = item?.message?.info ?? {};
    const messageID = info.id ?? null;
    if (messageID && seenMessageIDs.has(messageID)) {
      continue;
    }
    if (messageID) {
      seenMessageIDs.add(messageID);
    }

    totals.messageCount += 1;
    if (info.role === "assistant") {
      totals.assistantMessageCount += 1;
    }

    const tokens = info.tokens ?? {};
    totals.total += Number(tokens.total ?? 0);
    totals.input += Number(tokens.input ?? 0);
    totals.output += Number(tokens.output ?? 0);
    totals.reasoning += Number(tokens.reasoning ?? 0);
    totals.cacheRead += Number(tokens.cache?.read ?? 0);
    totals.cacheWrite += Number(tokens.cache?.write ?? 0);
    totals.cost += Number(info.cost ?? 0);
  }

  return totals;
}

function emptyOpencodeUsage() {
  return {
    messageCount: 0,
    assistantMessageCount: 0,
    total: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
}

async function waitForSessionIdle({
  client,
  sessionID,
  workspaceDir,
  diagnosticsDir,
  timeoutMs,
  stalledTimeoutMs,
  onLog = async () => {},
}) {
  const deadline = Date.now() + timeoutMs;
  const progress = createSessionProgressTracker();
  const eventMonitor = startSessionEventMonitor({
    client,
    sessionID,
    workspaceDir,
    progress,
    onLog,
  });

  await onLog(
    `waiting for idle: sessionID=${sessionID} timeoutMs=${timeoutMs} stalledTimeoutMs=${stalledTimeoutMs}`,
  );

  try {
    while (Date.now() < deadline) {
      if (progress.blockingError) {
        throw progress.blockingError;
      }
      if (progress.idle) {
        return;
      }

      const session = unwrapSdkResult(
        await client.session.get({
          path: {
            id: sessionID,
          },
          query: {
            directory: workspaceDir,
          },
        }),
        "session.get",
      );
      const updatedAt = session?.time?.updated ?? null;
      if (updatedAt !== null && updatedAt !== progress.lastUpdatedAt) {
        progress.lastUpdatedAt = updatedAt;
        progress.markProgress("session.updated_at");
      }

      const activity = await inspectRecentSessionActivity({
        client,
        sessionID,
        workspaceDir,
      });
      if (activity.signature && activity.signature !== progress.lastActivitySignature) {
        progress.lastActivitySignature = activity.signature;
        progress.lastMessages = activity.messages;
        progress.markProgress(activity.signal);
        await logProgressSignal({ onLog, progress });
      }
      progress.lastMalformedToolCall = activity.malformedToolCall ?? null;

      if (activity.activeTaskSessionIDs.length > 0) {
        progress.markProgress(`task.active:${activity.activeTaskSessionIDs.join(",")}`);
        await logProgressSignal({ onLog, progress });
      }

      if (activity.activeTaskSessionIDs.length > 0) {
        const childActivity = await inspectChildTaskActivity({
          client,
          parentSessionID: sessionID,
          workspaceDir,
          taskSessionIDs: activity.activeTaskSessionIDs,
        });
        if (childActivity.signature && childActivity.signature !== progress.lastChildActivitySignature) {
          progress.lastChildActivitySignature = childActivity.signature;
          progress.markProgress(childActivity.signal);
          await logProgressSignal({ onLog, progress });
        }
      } else {
        progress.lastChildActivitySignature = null;
      }

      const workspaceSnapshot = await captureWorkspaceSnapshot(workspaceDir);
      if (workspaceSnapshot.signature && workspaceSnapshot.signature !== progress.lastWorkspaceSignature) {
        progress.lastWorkspaceSignature = workspaceSnapshot.signature;
        progress.lastWorkspaceSnapshot = workspaceSnapshot;
        progress.markProgress("workspace.files.changed");
        await logProgressSignal({ onLog, progress });
      }

      const statusMap = unwrapSdkResult(
        await client.session.status({
          query: {
            directory: workspaceDir,
          },
        }),
        "session.status",
      );
      const status = statusMap?.[sessionID];
      const previousStatusType = progress.lastStatusType;
      progress.lastStatusType = status?.type ?? null;
      if (status?.type === "idle") {
        return;
      }
      if (status?.type && status?.type !== previousStatusType) {
        progress.markProgress(`session.status:${status.type}`);
        await logProgressSignal({ onLog, progress });
      }

      if (Date.now() - progress.lastProgressAt > stalledTimeoutMs) {
        const stallDiagnosticsPath = diagnosticsDir
          ? path.join(diagnosticsDir, "stall-diagnostics.json")
          : null;
        if (stallDiagnosticsPath) {
          await writeJson(stallDiagnosticsPath, buildStallDiagnostics({
            sessionID,
            stalledTimeoutMs,
            progress,
            workspaceSnapshot: progress.lastWorkspaceSnapshot,
          }));
          await onLog(`stall diagnostics saved: ${stallDiagnosticsPath}`);
        }
        await onLog(
          `stall detected: lastStatus=${progress.lastStatusType ?? "unknown"} lastSignal=${progress.lastSignal ?? "none"}`,
        );
        throw new Error(buildStalledMessage({ sessionID, stalledTimeoutMs, progress }));
      }
      await logHeartbeatIfNeeded({ onLog, progress, sessionID, timeoutMs, deadline });
      await sleep(3000);
    }
  } finally {
    await eventMonitor.close();
  }

  throw new Error(`Session ${sessionID} did not become idle within ${timeoutMs} ms`);
}

function createSessionProgressTracker() {
  return {
    idle: false,
    blockingError: null,
    lastProgressAt: Date.now(),
    lastUpdatedAt: null,
    lastStatusType: null,
    lastActivitySignature: null,
    lastChildActivitySignature: null,
    lastWorkspaceSignature: null,
    lastWorkspaceSnapshot: null,
    lastMalformedToolCall: null,
    lastMessages: [],
    lastSignal: "startup",
    lastLoggedSignal: null,
    lastHeartbeatAt: 0,
    markProgress(signal) {
      this.lastProgressAt = Date.now();
      if (signal) {
        this.lastSignal = signal;
      }
    },
  };
}

function buildStalledMessage({ sessionID, stalledTimeoutMs, progress }) {
  const lastStatus = progress.lastStatusType ?? "unknown";
  const lastSignal = progress.lastSignal ?? "none";
  return `Session ${sessionID} stalled for more than ${stalledTimeoutMs} ms (lastStatus=${lastStatus}, lastSignal=${lastSignal})`;
}

async function logProgressSignal({ onLog, progress }) {
  if (!progress.lastSignal || progress.lastSignal === progress.lastLoggedSignal) {
    return;
  }
  progress.lastLoggedSignal = progress.lastSignal;
  await onLog(`progress: signal=${progress.lastSignal} status=${progress.lastStatusType ?? "unknown"}`);
}

async function logHeartbeatIfNeeded({ onLog, progress, sessionID, timeoutMs, deadline }) {
  const now = Date.now();
  if (now - progress.lastHeartbeatAt < 15000) {
    return;
  }
  progress.lastHeartbeatAt = now;
  await onLog(
    `heartbeat: sessionID=${sessionID} status=${progress.lastStatusType ?? "unknown"} lastSignal=${progress.lastSignal ?? "none"} remainingMs=${Math.max(0, deadline - now)}/${timeoutMs}`,
  );
}

async function inspectRecentSessionActivity({ client, sessionID, workspaceDir }) {
  try {
    const messages = unwrapSdkResult(
      await client.session.messages({
        path: {
          id: sessionID,
        },
        query: {
          directory: workspaceDir,
          limit: 12,
        },
      }),
      "session.messages",
    );

    const malformedToolCall = findMalformedPendingToolCall(messages, sessionID);

    const signature = buildMessageActivitySignature(messages);
    return {
      signature,
      signal: buildMessageActivitySignal(messages),
      activeTaskSessionIDs: extractActiveTaskSessionIDs(messages),
      messages,
      blockingError: null,
      malformedToolCall,
    };
  } catch {
    return {
      signature: null,
      signal: null,
      activeTaskSessionIDs: [],
      messages: [],
      blockingError: null,
      malformedToolCall: null,
    };
  }
}

async function captureWorkspaceSnapshot(workspaceDir) {
  try {
    const filePaths = (await listFilesRecursive(workspaceDir))
      .filter((filePath) => !filePath.includes(`${path.sep}.git${path.sep}`))
      .sort();

    const files = [];
    for (const filePath of filePaths.slice(0, 200)) {
      const stats = await fs.stat(filePath);
      files.push({
        path: path.relative(workspaceDir, filePath) || path.basename(filePath),
        size: stats.size,
        mtimeMs: Math.trunc(stats.mtimeMs),
      });
    }

    const latestFiles = [...files]
      .sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
      .slice(0, 20);

    return {
      fileCount: filePaths.length,
      latestFiles,
      signature: JSON.stringify({
        fileCount: filePaths.length,
        latestFiles,
      }),
    };
  } catch {
    return {
      fileCount: 0,
      latestFiles: [],
      signature: null,
    };
  }
}

function buildStallDiagnostics({ sessionID, stalledTimeoutMs, progress, workspaceSnapshot }) {
  const recentMessages = (progress.lastMessages ?? []).slice(-6);
  const latestToolPart = findLatestToolPart(recentMessages);
  const workspaceStillChanging =
    progress.lastSignal === "workspace.files.changed" ||
    progress.lastSignal === "file.watcher.updated" ||
    progress.lastSignal === "file.edited";

  return {
    sessionID,
    stalledTimeoutMs,
    capturedAt: new Date().toISOString(),
    assessment: workspaceStillChanging
      ? "workspace_was_still_changing_recently"
      : "no_recent_workspace_change_detected",
    progress: {
      lastStatusType: progress.lastStatusType ?? null,
      lastSignal: progress.lastSignal ?? null,
      lastProgressAt: new Date(progress.lastProgressAt).toISOString(),
      lastUpdatedAt: progress.lastUpdatedAt ?? null,
    },
    malformedToolCall: progress.lastMalformedToolCall ?? null,
    latestToolPart,
    recentMessages: recentMessages.map((message) => ({
      id: message?.info?.id ?? null,
      role: message?.info?.role ?? null,
      created: message?.info?.time?.created ?? null,
      parts: (message?.parts ?? []).slice(-8).map((part) => ({
        id: part?.id ?? null,
        type: part?.type ?? null,
        tool: part?.tool ?? null,
        status: part?.state?.status ?? null,
        callID: part?.callID ?? null,
        input: part?.state?.input ?? null,
        metadata: part?.state?.metadata ?? null,
        textPreview:
          typeof part?.text === "string"
            ? part.text.slice(0, 400)
            : null,
      })),
    })),
    workspaceSnapshot: workspaceSnapshot ?? {
      fileCount: 0,
      latestFiles: [],
    },
  };
}

function findLatestToolPart(messages) {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const parts = messages[messageIndex]?.parts ?? [];
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex];
      if (part?.type !== "tool") {
        continue;
      }
      return {
        messageID: messages[messageIndex]?.info?.id ?? null,
        tool: part.tool ?? null,
        status: part.state?.status ?? null,
        callID: part.callID ?? null,
        input: part.state?.input ?? null,
        metadata: part.state?.metadata ?? null,
        rawPreview:
          typeof part.state?.raw === "string"
            ? part.state.raw.slice(0, 1000)
            : null,
      };
    }
  }
  return null;
}

async function inspectChildTaskActivity({
  client,
  parentSessionID,
  workspaceDir,
  taskSessionIDs,
}) {
  try {
    const children = unwrapSdkResult(
      await client.session.children({
        path: {
          sessionID: parentSessionID,
        },
        query: {
          directory: workspaceDir,
        },
      }),
      "session.children",
    );

    const relevantChildren = children.filter((child) => taskSessionIDs.includes(child?.id));
    if (relevantChildren.length === 0) {
      return {
        signature: null,
        signal: null,
      };
    }

    const signature = JSON.stringify(
      relevantChildren.map((child) => ({
        id: child?.id ?? null,
        updated: child?.time?.updated ?? null,
        completed: child?.time?.completed ?? null,
      })),
    );

    return {
      signature,
      signal: `task.children:${relevantChildren.map((child) => child?.id).join(",")}`,
    };
  } catch {
    return {
      signature: null,
      signal: null,
    };
  }
}

function buildMessageActivitySignature(messages) {
  const recentMessages = messages.slice(-4);
  return JSON.stringify(
    recentMessages.map((message) => ({
      id: message?.info?.id ?? null,
      role: message?.info?.role ?? null,
      parts: (message?.parts ?? []).slice(-8).map((part) => ({
        id: part?.id ?? null,
        type: part?.type ?? null,
        tool: part?.tool ?? null,
        callID: part?.callID ?? null,
        status: part?.state?.status ?? null,
        start: part?.time?.start ?? null,
        end: part?.time?.end ?? null,
        textLength:
          part?.type === "text" || part?.type === "reasoning"
            ? part?.text?.length ?? 0
            : null,
      })),
    })),
  );
}

function buildMessageActivitySignal(messages) {
  const lastMessage = messages[messages.length - 1];
  const lastPart = lastMessage?.parts?.[lastMessage.parts.length - 1];
  if (!lastPart) {
    return "session.messages";
  }
  if (lastPart.type === "tool") {
    return `tool:${lastPart.tool ?? 'unknown'}:${lastPart.state?.status ?? 'unknown'}`;
  }
  return `message.${lastPart.type ?? 'unknown'}`;
}

function extractActiveTaskSessionIDs(messages) {
  const sessionIDs = [];
  for (const message of messages.slice(-6)) {
    for (const part of message?.parts ?? []) {
      if (part?.type !== "tool" || part.tool !== "task") {
        continue;
      }
      if (part.state?.status !== "running" && part.state?.status !== "pending") {
        continue;
      }
      const sessionID =
        part.state?.metadata?.sessionId ??
        part.state?.metadata?.sessionID ??
        null;
      if (sessionID) {
        sessionIDs.push(sessionID);
      }
    }
  }
  return [...new Set(sessionIDs)];
}

function findMalformedPendingToolCall(messages, sessionID) {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const parts = messages[messageIndex]?.parts ?? [];
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex];
      if (part?.type !== "tool" || part?.state?.status !== "pending") {
        continue;
      }
      if (
        part.tool === "apply_patch" &&
        !String(part.state?.raw ?? "").trim() &&
        Object.keys(part.state?.input ?? {}).length === 0
      ) {
        return new Error(
          `Session ${sessionID} is stuck on apply_patch with an empty patch payload`,
        );
      }
      return null;
    }
  }
  return null;
}

function startSessionEventMonitor({ client, sessionID, workspaceDir, progress, onLog }) {
  let closed = false;
  let stream = null;
  const controller = new AbortController();

  const worker = (async () => {
    try {
      const subscription = await client.event.subscribe({
        query: {
          directory: workspaceDir,
        },
        signal: controller.signal,
      });
      stream = subscription.stream;

      for await (const event of stream) {
        if (closed) {
          break;
        }
        handleSessionEvent({ event, sessionID, progress });
        if (shouldLogEvent(event, sessionID)) {
          onLog(`event: ${event.type}`);
        }
        if (progress.idle || progress.blockingError) {
          break;
        }
      }
    } catch (error) {
      if (closed || error?.name === "AbortError") {
        return;
      }
      // Polling remains the source of truth when SSE subscription is unavailable.
    }
  })();

  return {
    async close() {
      closed = true;
      controller.abort();
      try {
        await stream?.return?.();
      } catch {
        // Ignore stream shutdown failures.
      }
      try {
        await Promise.race([worker, sleep(1000)]);
      } catch {
        // Ignore monitor failures because polling already handles session state.
      }
    },
  };
}

function shouldLogEvent(event, sessionID) {
  if (event?.properties?.sessionID && event.properties.sessionID !== sessionID) {
    return false;
  }
  return new Set([
    "session.idle",
    "session.status",
    "session.error",
    "permission.asked",
    "question.asked",
    "todo.updated",
    "command.executed",
  ]).has(event?.type);
}

function handleSessionEvent({ event, sessionID, progress }) {
  switch (event?.type) {
    case "session.idle":
      if (event.properties?.sessionID === sessionID) {
        progress.idle = true;
        progress.markProgress("session.idle");
      }
      return;
    case "session.status":
      if (event.properties?.sessionID === sessionID) {
        progress.lastStatusType = event.properties?.status?.type ?? null;
        progress.markProgress(`session.status:${event.properties?.status?.type ?? 'unknown'}`);
        if (event.properties?.status?.type === "idle") {
          progress.idle = true;
        }
      }
      return;
    case "session.error":
      if (event.properties?.sessionID === sessionID) {
        progress.markProgress("session.error");
        progress.blockingError = new Error(
          `Session ${sessionID} reported an error: ${formatSessionEventError(event.properties?.error)}`,
        );
      }
      return;
    case "permission.asked":
      if (event.properties?.sessionID === sessionID) {
        progress.markProgress("permission.asked");
        progress.blockingError = new Error(
          `Session ${sessionID} is waiting for permission approval (${formatPermissionRequest(event.properties)})`,
        );
      }
      return;
    case "question.asked":
      if (event.properties?.sessionID === sessionID) {
        progress.markProgress("question.asked");
        progress.blockingError = new Error(
          `Session ${sessionID} is waiting for interactive answers (${formatQuestionRequest(event.properties)})`,
        );
      }
      return;
    case "message.updated":
    case "message.removed":
    case "message.part.delta":
    case "message.part.updated":
    case "message.part.removed":
    case "todo.updated":
    case "permission.replied":
    case "question.replied":
    case "question.rejected":
    case "session.compacted":
    case "session.diff":
    case "command.executed":
    case "session.created":
    case "session.updated":
    case "session.deleted":
      if (event.properties?.sessionID === sessionID) {
        progress.markProgress(event.type);
      }
      return;
    case "pty.created":
    case "pty.updated":
    case "pty.exited":
    case "pty.deleted":
    case "file.edited":
    case "file.watcher.updated":
    case "workspace.ready":
    case "workspace.failed":
    case "worktree.ready":
    case "worktree.failed":
      progress.markProgress(event.type);
      return;
    default:
      return;
  }
}

function formatSessionEventError(error) {
  if (!error) {
    return "unknown session error";
  }

  const name = error.name ?? "SessionError";
  const message = error.data?.message ?? error.message ?? JSON.stringify(error);
  return `${name}: ${message}`;
}

function formatPermissionRequest(request) {
  const permission = request?.permission ?? "unknown-permission";
  const patterns = Array.isArray(request?.patterns) && request.patterns.length > 0
    ? request.patterns.join(", ")
    : "*";
  return `${permission} on ${patterns}`;
}

function formatQuestionRequest(request) {
  const firstQuestion = request?.questions?.[0]?.question;
  return firstQuestion ?? `request ${request?.id ?? 'unknown'}`;
}
