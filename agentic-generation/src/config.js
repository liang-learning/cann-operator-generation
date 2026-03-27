import path from "node:path";

import { deepMerge, pathExists, readJson, uniqueSortedNumbers } from "./utils.js";

const DEFAULT_SKILLS = [
  "ascendc-kernel-develop-workflow",
  "ascendc-docs-search",
  "ascendc-api-best-practices",
  "ascendc-npu-arch",
  "ascendc-precision-debug",
  "ascendc-runtime-debug",
  "ascendc-env-check",
  "ascendc-task-focus",
];

const DEFAULT_AGENTS = [
  "ascendc-ops-architect",
  "ascendc-ops-reviewer",
];

const DEFAULT_CONFIG = {
  casesPath: "./cases",
  attempts: 1,
  metricKs: [],
  runDir: "./agentic_run",
  historyDir: "./history",
  cacheDir: "./.cache",
  opencode: {
    agent: null,
    systemPrompt: null,
    startupTimeoutSec: 60,
    promptTimeoutSec: 3600,
    stalledTimeoutSec: 120,
    exportSessionJson: true,
  },
  dependencies: {
    updateRepos: true,
    skillsRepoUrl: "https://gitcode.com/cann/skills.git",
    skillsRepoDir: "./.cache/cann-skills-src",
    ascDevkitRepoUrl: "https://gitcode.com/cann/asc-devkit.git",
    ascDevkitRepoDir: "./.cache/asc-devkit-src",
    selectedSkills: DEFAULT_SKILLS,
    selectedAgents: DEFAULT_AGENTS,
    installAgents: true,
    installAscDevkit: true,
    useSymlinkForAscDevkit: true,
  },
  compileCheck: {
    enabled: true,
    command: null,
    cwd: "workspace",
    timeoutSec: 900,
    autoDetectCmake: true,
    buildDirName: ".eval-build",
  },
  scoring: {
    passCriterion: "compile",
  },
  history: {
    archiveCases: true,
  },
  runtime: {
    maxMessages: 2000,
  },
};

export async function loadConfig({ projectRoot, configPath, overrides = {} }) {
  const resolvedConfigPath = path.resolve(projectRoot, configPath);
  if (!(await pathExists(resolvedConfigPath))) {
    throw new Error(`Config file not found: ${resolvedConfigPath}`);
  }

  const fileConfig = await readJson(resolvedConfigPath);
  const merged = deepMerge(DEFAULT_CONFIG, fileConfig, buildOverrideConfig(overrides));

  const resolved = {
    ...merged,
    configPath: resolvedConfigPath,
    projectRoot,
    casesPath: path.resolve(projectRoot, merged.casesPath),
    runDir: path.resolve(projectRoot, merged.runDir),
    historyDir: path.resolve(projectRoot, merged.historyDir),
    cacheDir: path.resolve(projectRoot, merged.cacheDir),
    dependencies: {
      ...merged.dependencies,
      skillsRepoDir: path.resolve(projectRoot, merged.dependencies.skillsRepoDir),
      ascDevkitRepoDir: path.resolve(projectRoot, merged.dependencies.ascDevkitRepoDir),
    },
  };

  resolved.metricKs = uniqueSortedNumbers(
    resolved.metricKs.length > 0 ? resolved.metricKs : [1, resolved.attempts],
  );

  return resolved;
}

function buildOverrideConfig(overrides) {
  const output = {};

  if (overrides.casesPath) {
    output.casesPath = overrides.casesPath;
  }

  if (overrides.attempts) {
    output.attempts = Number(overrides.attempts);
  }

  if (overrides.metricKs?.length) {
    output.metricKs = overrides.metricKs.map((value) => Number(value));
  }

  if (overrides.runDir) {
    output.runDir = overrides.runDir;
  }

  if (overrides.historyDir) {
    output.historyDir = overrides.historyDir;
  }

  return output;
}

export function publicConfigSnapshot(config) {
  return {
    casesPath: config.casesPath,
    attempts: config.attempts,
    metricKs: config.metricKs,
    runDir: config.runDir,
    historyDir: config.historyDir,
    cacheDir: config.cacheDir,
    opencode: config.opencode,
    dependencies: config.dependencies,
    compileCheck: config.compileCheck,
    scoring: config.scoring,
    history: config.history,
    runtime: config.runtime,
  };
}
