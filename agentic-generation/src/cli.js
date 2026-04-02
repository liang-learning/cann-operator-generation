#!/usr/bin/env node

import path from "node:path";

import { runEvaluation } from "./evaluator.js";

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    await writeStream(
      process.stdout,
      [
        "Usage: node src/cli.js [options]",
        "",
        "Options:",
        "  --config <path>       Path to eval config JSON",
        "  --cases-path <path>   Path to a prompt.txt file or a directory containing prompt.txt cases",
        "  --attempts <n>        Override number of attempts per case",
        "  --metric-k <n>        Add a pass@k metric to compute; can be repeated",
        "  --run-dir <path>      Override agentic_run directory",
        "  --history-dir <path>  Override history directory",
        "  -h, --help            Show this help text",
      ].join("\n"),
    );
    return;
  }

  const projectRoot = process.cwd();
  const summary = await runEvaluation({
    projectRoot,
    configPath: args.config ?? "eval.config.json",
    overrides: {
      casesPath: args.casesPath,
      attempts: args.attempts,
      metricKs: args.metricK,
      runDir: args.runDir,
      historyDir: args.historyDir,
    },
  });

  await writeStream(
    process.stdout,
    `${JSON.stringify(
      {
        runId: summary.runId,
        resultsPath: path.join(summary.config.runDir, "results.json"),
        metrics: summary.metrics,
      },
      null,
      2,
    )}\n`,
  );
}

function parseArgs(argv) {
  const output = {
    metricK: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      output.help = true;
      continue;
    }
    if (argument === "--config") {
      output.config = argv[++index];
      continue;
    }
    if (argument === "--cases-path") {
      output.casesPath = argv[++index];
      continue;
    }
    if (argument === "--attempts") {
      output.attempts = Number(argv[++index]);
      continue;
    }
    if (argument === "--metric-k") {
      output.metricK.push(Number(argv[++index]));
      continue;
    }
    if (argument === "--run-dir") {
      output.runDir = argv[++index];
      continue;
    }
    if (argument === "--history-dir") {
      output.historyDir = argv[++index];
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return output;
}

function writeStream(stream, text) {
  return new Promise((resolve, reject) => {
    stream.write(text, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) =>
    writeStream(process.stderr, `${error.stack ?? error.message ?? String(error)}\n`)
      .catch(() => {})
      .finally(() => {
        process.exit(1);
      }),
  );
