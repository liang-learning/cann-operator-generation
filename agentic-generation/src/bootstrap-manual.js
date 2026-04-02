#!/usr/bin/env node

import path from "node:path";

import { loadConfig, publicConfigSnapshot } from "./config.js";
import { installRunAssets, prepareDependencies } from "./dependencies.js";
import { ensureDir, writeJson, writeText } from "./utils.js";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = process.cwd();
  const config = await loadConfig({
    projectRoot,
    configPath: args.config ?? "eval.config.json",
    overrides: {},
  });

  await prepareDependencies(config);
  await ensureDir(config.runDir);
  await installRunAssets({
    config,
    runDir: config.runDir,
  });

  await ensureDir(path.join(config.runDir, "manual_workspace"));
  await writeJson(
    path.join(config.runDir, "config.snapshot.json"),
    publicConfigSnapshot(config),
  );
  await writeText(
    path.join(config.runDir, "MANUAL_USE.md"),
    [
      "# Manual Use",
      "",
      "1. cd 到当前目录",
      "2. 运行 `opencode .`",
      "3. 直接粘贴你的 prompt",
      "4. 如需隔离手工实验，要求 agent 把代码写到 `manual_workspace/` 或 `ops/<operator>/`",
      "",
      "当前目录已经包含：",
      "- AGENTS.md",
      "- .opencode/skills",
      "- .opencode/agents",
      "- asc-devkit",
    ].join("\n"),
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        runDir: config.runDir,
        manualCommand: `cd ${config.runDir} && opencode .`,
      },
      null,
      2,
    )}\n`,
  );
}

function parseArgs(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--config") {
      output.config = argv[++index];
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      process.stdout.write("Usage: node src/bootstrap-manual.js [--config <path>]\n");
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return output;
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message ?? String(error)}\n`);
  process.exitCode = 1;
});
