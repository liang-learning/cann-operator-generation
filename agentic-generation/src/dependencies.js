import path from "node:path";
import { promises as fs } from "node:fs";

import {
  copyDirectory,
  ensureDir,
  pathExists,
  readText,
  removePath,
  runProcess,
  writeJson,
  writeText,
} from "./utils.js";

export async function prepareDependencies(config) {
  const repoInfo = {};

  repoInfo.skills = await syncGitRepo({
    url: config.dependencies.skillsRepoUrl,
    directory: config.dependencies.skillsRepoDir,
    update: config.dependencies.updateRepos,
  });

  if (config.dependencies.installAscDevkit) {
    repoInfo.ascDevkit = await syncGitRepo({
      url: config.dependencies.ascDevkitRepoUrl,
      directory: config.dependencies.ascDevkitRepoDir,
      update: config.dependencies.updateRepos,
    });
  }

  return repoInfo;
}

export async function installRunAssets({ config, runDir }) {
  const skillsRoot = path.join(runDir, ".opencode", "skills");
  const agentsRoot = path.join(runDir, ".opencode", "agents");
  const skillsRepoDir = config.dependencies.skillsRepoDir;

  await ensureDir(skillsRoot);
  await ensureDir(agentsRoot);

  for (const skillName of config.dependencies.selectedSkills) {
    const sourceDir = path.join(skillsRepoDir, "skills", skillName);
    const targetDir = path.join(skillsRoot, skillName);
    if (!(await pathExists(sourceDir))) {
      throw new Error(`Skill not found in repo: ${skillName}`);
    }
    await copyDirectory(sourceDir, targetDir);
  }

  if (config.dependencies.installAgents) {
    for (const agentName of config.dependencies.selectedAgents) {
      const sourceDir = path.join(skillsRepoDir, "agents", agentName);
      const targetDir = path.join(agentsRoot, agentName);
      if (!(await pathExists(sourceDir))) {
        throw new Error(`Agent not found in repo: ${agentName}`);
      }
      await copyDirectory(sourceDir, targetDir);
    }
  }

  const teamAgentsPath = path.join(
    skillsRepoDir,
    "teams",
    "ascendc-kernel-dev-team",
    "AGENTS.md",
  );
  const baseAgents = await readText(teamAgentsPath);
  const extraAgents = buildEvaluatorAgentsAppendix();
  await writeText(path.join(runDir, "AGENTS.md"), `${baseAgents.trim()}\n\n${extraAgents}`);

  const opencodeConfig = {
    permission: "allow",
    instructions: ["AGENTS.md"],
  };
  await writeJson(path.join(runDir, "opencode.json"), opencodeConfig);

  if (config.dependencies.installAscDevkit) {
    const ascDevkitLink = path.join(runDir, "asc-devkit");
    await removePath(ascDevkitLink);

    if (config.dependencies.useSymlinkForAscDevkit) {
      const linkTarget = path.relative(runDir, config.dependencies.ascDevkitRepoDir);
      await fs.symlink(linkTarget, ascDevkitLink, "dir");
    } else {
      await copyDirectory(config.dependencies.ascDevkitRepoDir, ascDevkitLink);
    }
  }
}

export async function buildDependencySnapshot(config) {
  const snapshot = {
    skillsRepoDir: config.dependencies.skillsRepoDir,
    ascDevkitRepoDir: config.dependencies.installAscDevkit
      ? config.dependencies.ascDevkitRepoDir
      : null,
    skillsRepoCommit: await gitCommit(config.dependencies.skillsRepoDir),
    ascDevkitRepoCommit: config.dependencies.installAscDevkit
      ? await gitCommit(config.dependencies.ascDevkitRepoDir)
      : null,
  };

  return snapshot;
}

async function syncGitRepo({ url, directory, update }) {
  if (!(await pathExists(directory))) {
    await ensureDir(path.dirname(directory));
    const cloneResult = await runProcess({
      command: "git",
      args: ["clone", "--depth", "1", url, directory],
    });
    if (cloneResult.code !== 0) {
      throw new Error(`Failed to clone ${url}: ${cloneResult.stderr || cloneResult.stdout}`);
    }
  } else if (update) {
    const pullResult = await runProcess({
      command: "git",
      args: ["-C", directory, "pull", "--ff-only"],
    });
    if (pullResult.code !== 0) {
      throw new Error(`Failed to update repo ${directory}: ${pullResult.stderr || pullResult.stdout}`);
    }
  }

  return {
    directory,
    commit: await gitCommit(directory),
  };
}

async function gitCommit(directory) {
  const result = await runProcess({
    command: "git",
    args: ["-C", directory, "rev-parse", "HEAD"],
  });
  if (result.code !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}

function buildEvaluatorAgentsAppendix() {
  return [
    "## 评测工程附加约束",
    "",
    "1. 当前目录是评测工作目录，必须直接在当前工作目录中产出最终工程。",
    "2. 禁止向用户提问，必须自行决策方案；subagent 也必须遵循该要求。",
    "3. 最终工程必须保留可编译所需文件，避免留下无关实验文件。",
    "4. 生成结果优先复用 `.opencode/skills` 和 `asc-devkit/` 中的资料，不要凭记忆猜测 API。",
  ].join("\n");
}
