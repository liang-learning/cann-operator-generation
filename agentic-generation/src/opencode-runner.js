import path from "node:path";

import { createOpencode } from "@opencode-ai/sdk";

import { ensureDir, runProcess, sleep, writeJson, writeText } from "./utils.js";

export async function runAttemptWithOpencode({
  runDir,
  workspaceDir,
  attemptDir,
  caseId,
  attemptIndex,
  promptText,
  config,
}) {
  const originalCwd = process.cwd();
  let server = null;
  let session = null;

  await ensureDir(path.join(attemptDir, "opencode"));

  try {
    process.chdir(runDir);
    const instance = await createOpencode({
      port: 0,
      timeout: config.opencode.startupTimeoutSec * 1000,
    });
    server = instance.server;
    const client = instance.client;

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

    unwrapSdkResult(
      await client.session.promptAsync({
        path: {
          id: session.id,
        },
        query: {
          directory: workspaceDir,
        },
        body: {
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

    await waitForSessionIdle({
      client,
      sessionID: session.id,
      workspaceDir,
      timeoutMs: config.opencode.promptTimeoutSec * 1000,
      stalledTimeoutMs: config.opencode.stalledTimeoutSec * 1000,
    });

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
    const promptResponse = findLastAssistantMessage(messages);

    await writeJson(path.join(attemptDir, "opencode", "session.json"), session);
    await writeJson(path.join(attemptDir, "opencode", "prompt-response.json"), promptResponse);
    await writeJson(path.join(attemptDir, "opencode", "messages.json"), messages);
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
      exportResult,
      finalText: extractText(promptResponse?.parts ?? []),
      error: null,
    };
  } catch (error) {
    const serializedError = serializeError(error);
    await writeJson(path.join(attemptDir, "opencode", "error.json"), serializedError);

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
      exportResult: null,
      finalText: "",
      error: serializedError,
    };
  } finally {
    try {
      server?.close();
    } finally {
      process.chdir(originalCwd);
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
    await writeText(destinationPath, result.stdout);
    return {
      ok: true,
      destinationPath,
    };
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

async function waitForSessionIdle({
  client,
  sessionID,
  workspaceDir,
  timeoutMs,
  stalledTimeoutMs,
}) {
  const deadline = Date.now() + timeoutMs;
  let lastUpdatedAt = null;
  let lastProgressAt = Date.now();

  while (Date.now() < deadline) {
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
    if (updatedAt !== null && updatedAt !== lastUpdatedAt) {
      lastUpdatedAt = updatedAt;
      lastProgressAt = Date.now();
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
    if (status?.type === "idle") {
      return;
    }
    if (Date.now() - lastProgressAt > stalledTimeoutMs) {
      throw new Error(`Session ${sessionID} stalled for more than ${stalledTimeoutMs} ms`);
    }
    await sleep(3000);
  }

  throw new Error(`Session ${sessionID} did not become idle within ${timeoutMs} ms`);
}
