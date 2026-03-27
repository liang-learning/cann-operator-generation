import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

export async function removePath(targetPath) {
  await fs.rm(targetPath, { recursive: true, force: true });
}

export async function movePath(sourcePath, targetPath) {
  try {
    await fs.rename(sourcePath, targetPath);
  } catch (error) {
    if (error?.code !== "EXDEV") {
      throw error;
    }
    await fs.cp(sourcePath, targetPath, { recursive: true });
    await removePath(sourcePath);
  }
}

export async function copyDirectory(sourcePath, targetPath) {
  await fs.cp(sourcePath, targetPath, { recursive: true });
}

export async function writeJson(targetPath, value) {
  await ensureDir(path.dirname(targetPath));
  await fs.writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readJson(targetPath) {
  return JSON.parse(await fs.readFile(targetPath, "utf8"));
}

export async function writeText(targetPath, value) {
  await ensureDir(path.dirname(targetPath));
  await fs.writeFile(targetPath, value, "utf8");
}

export async function appendText(targetPath, value) {
  await ensureDir(path.dirname(targetPath));
  await fs.appendFile(targetPath, value, "utf8");
}

export async function readText(targetPath) {
  return fs.readFile(targetPath, "utf8");
}

export async function listFilesRecursive(rootPath) {
  const results = [];

  async function visit(currentPath) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }

  if (await pathExists(rootPath)) {
    await visit(rootPath);
  }

  return results.sort();
}

export async function findFilesByName(rootPath, fileName) {
  const files = await listFilesRecursive(rootPath);
  return files.filter((filePath) => path.basename(filePath) === fileName);
}

export function timestampId(date = new Date()) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const millis = String(date.getMilliseconds()).padStart(3, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}-${millis}`;
}

export function sanitizeCaseId(input) {
  const normalized = input.replaceAll(path.sep, "__");
  const cleaned = normalized.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "root";
}

export function uniqueSortedNumbers(values) {
  return [...new Set(values.filter((value) => Number.isFinite(value) && value > 0))]
    .map((value) => Math.trunc(value))
    .sort((left, right) => left - right);
}

export function deepMerge(base, ...overrides) {
  let result = structuredClone(base);

  for (const override of overrides) {
    result = mergeInto(result, override);
  }

  return result;
}

function mergeInto(base, override) {
  if (override === undefined) {
    return base;
  }

  if (Array.isArray(override)) {
    return structuredClone(override);
  }

  if (override === null || typeof override !== "object") {
    return override;
  }

  const output = Array.isArray(base) ? [] : { ...(base ?? {}) };
  for (const [key, value] of Object.entries(override)) {
    output[key] = mergeInto(output[key], value);
  }
  return output;
}

export function renderTemplate(template, replacements) {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) => {
    if (!(key in replacements)) {
      return _match;
    }
    return String(replacements[key]);
  });
}

export async function runProcess({
  command,
  args = [],
  cwd,
  env,
  timeoutMs,
  shell = false,
  input,
}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...env,
      },
      shell,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 5000).unref();
        }, timeoutMs)
      : null;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve({
        code: null,
        signal: null,
        stdout,
        stderr,
        timedOut,
        error,
      });
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        error: null,
      });
    });

    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

export async function withTimeout(promiseFactory, timeoutMs, onTimeout) {
  let timer = null;

  return Promise.race([
    promiseFactory(),
    new Promise((_, reject) => {
      timer = setTimeout(async () => {
        try {
          await onTimeout?.();
        } catch {
          // Ignore timeout cleanup failures.
        }
        reject(new Error(`Operation timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

export function toPosixRelative(fromPath, toPath) {
  return path.relative(fromPath, toPath).split(path.sep).join(path.posix.sep);
}

export function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
