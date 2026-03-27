import path from "node:path";
import { promises as fs } from "node:fs";

import {
  ensureDir,
  listFilesRecursive,
  pathExists,
  readText,
  renderTemplate,
  runProcess,
  writeText,
} from "./utils.js";

const MAIN_SIGNATURE_RE =
  /int\s+main\s*\(\s*int\s+argc\s*,\s*char\s*\*\s*argv\s*\[\s*]\s*\)/m;

const IGNORED_PATH_SEGMENTS = new Set([
  ".git",
  ".eval-build",
  "build",
  "build_cpu",
  "node_modules",
]);

export async function runStructuralChecks(workspaceDir) {
  const allFiles = (await listFilesRecursive(workspaceDir)).filter((filePath) =>
    shouldInspectPath(workspaceDir, filePath),
  );

  const ascFiles = allFiles.filter((filePath) => filePath.endsWith(".asc"));
  const headerFiles = allFiles.filter((filePath) => filePath.endsWith(".h"));
  const cmakeFiles = allFiles.filter((filePath) => path.basename(filePath) === "CMakeLists.txt");

  const mainSignatureFiles = [];
  for (const ascFile of ascFiles) {
    const source = await readText(ascFile);
    if (MAIN_SIGNATURE_RE.test(source)) {
      mainSignatureFiles.push(ascFile);
    }
  }

  const findings = [];
  if (ascFiles.length === 0) {
    findings.push("missing .asc source file");
  }
  if (headerFiles.length === 0) {
    findings.push("missing .h header file");
  }
  if (mainSignatureFiles.length === 0) {
    findings.push("missing required main(argc, argv) signature in .asc file");
  }

  return {
    status: findings.length === 0 ? "passed" : "failed",
    ascFiles,
    headerFiles,
    cmakeFiles,
    mainSignatureFiles,
    findings,
  };
}

export async function runCompileCheck({
  config,
  workspaceDir,
  attemptDir,
  structure,
}) {
  const compileDir = path.join(attemptDir, "compile");
  const logPath = path.join(compileDir, "compile.log");
  await ensureDir(compileDir);

  const toolchain = await detectAscendToolchain();

  if (!config.compileCheck.enabled) {
    await writeText(logPath, "compile check disabled by config\n");
    return {
      status: "skipped",
      reason: "disabled",
      logPath,
      command: null,
      toolchain,
    };
  }

  if (config.compileCheck.command) {
    const commandResult = await runConfiguredCompileCommand({
      config,
      workspaceDir,
      attemptDir,
      logPath,
    });
    return {
      ...commandResult,
      toolchain,
    };
  }

  if (!config.compileCheck.autoDetectCmake) {
    await writeText(logPath, "compile check skipped: no explicit command and auto-detect disabled\n");
    return {
      status: "unverified",
      reason: "no_command",
      logPath,
      command: null,
      toolchain,
    };
  }

  if (structure.cmakeFiles.length === 0) {
    await writeText(logPath, "compile check skipped: no CMakeLists.txt found\n");
    return {
      status: "unverified",
      reason: "missing_cmakelists",
      logPath,
      command: null,
      toolchain,
    };
  }

  if (structure.ascFiles.length > 0 && !toolchain.present) {
    await writeText(
      logPath,
      [
        "compile check skipped: Ascend toolchain not detected",
        `details: ${JSON.stringify(toolchain.details)}`,
        "",
      ].join("\n"),
    );
    return {
      status: "unverified",
      reason: "ascend_toolchain_missing",
      logPath,
      command: null,
      toolchain,
    };
  }

  return {
    ...(await runAutoDetectedCmakeBuild({
      config,
      workspaceDir,
      attemptDir,
      logPath,
    })),
    toolchain,
  };
}

async function runConfiguredCompileCommand({ config, workspaceDir, attemptDir, logPath }) {
  const buildDir = path.join(attemptDir, "compile", config.compileCheck.buildDirName);
  await ensureDir(buildDir);

  const command = renderTemplate(config.compileCheck.command, {
    workspace: workspaceDir,
    attempt_dir: attemptDir,
    build_dir: buildDir,
    run_dir: config.runDir,
    project_root: config.projectRoot,
  });

  const cwd = resolveCompileCwd(config.compileCheck.cwd, {
    workspaceDir,
    attemptDir,
    runDir: config.runDir,
  });

  const result = await runProcess({
    command,
    cwd,
    shell: true,
    timeoutMs: config.compileCheck.timeoutSec * 1000,
    env: {
      EVAL_WORKSPACE: workspaceDir,
      EVAL_ATTEMPT_DIR: attemptDir,
      EVAL_BUILD_DIR: buildDir,
      EVAL_RUN_DIR: config.runDir,
      EVAL_PROJECT_ROOT: config.projectRoot,
    },
  });

  const log = [
    `cwd: ${cwd}`,
    `command: ${command}`,
    "",
    "stdout:",
    result.stdout,
    "",
    "stderr:",
    result.stderr,
  ].join("\n");
  await writeText(logPath, log);

  return {
    status: result.code === 0 ? "passed" : result.timedOut ? "failed" : "failed",
    reason: result.code === 0 ? "command_succeeded" : result.timedOut ? "timeout" : "command_failed",
    logPath,
    command,
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function runAutoDetectedCmakeBuild({ config, workspaceDir, attemptDir, logPath }) {
  const buildDir = path.join(attemptDir, "compile", config.compileCheck.buildDirName);
  await ensureDir(buildDir);

  const hasNinja = await hasCommand("ninja");
  const configureArgs = ["-S", workspaceDir, "-B", buildDir];
  if (hasNinja) {
    configureArgs.push("-G", "Ninja");
  }

  const configure = await runProcess({
    command: "cmake",
    args: configureArgs,
    cwd: workspaceDir,
    timeoutMs: config.compileCheck.timeoutSec * 1000,
  });

  const build = configure.code === 0
    ? await runProcess({
        command: "cmake",
        args: ["--build", buildDir, "--verbose"],
        cwd: workspaceDir,
        timeoutMs: config.compileCheck.timeoutSec * 1000,
      })
    : null;

  const log = [
    `cwd: ${workspaceDir}`,
    `configure: cmake ${configureArgs.join(" ")}`,
    "",
    "configure stdout:",
    configure.stdout,
    "",
    "configure stderr:",
    configure.stderr,
    "",
    build
      ? [
          `build: cmake --build ${buildDir} --verbose`,
          "",
          "build stdout:",
          build.stdout,
          "",
          "build stderr:",
          build.stderr,
        ].join("\n")
      : "build skipped because configure failed",
  ].join("\n");
  await writeText(logPath, log);

  const passed = configure.code === 0 && build?.code === 0;
  return {
    status: passed ? "passed" : "failed",
    reason: passed ? "cmake_succeeded" : "cmake_failed",
    logPath,
    command: `cmake -S ${workspaceDir} -B ${buildDir}${hasNinja ? " -G Ninja" : ""} && cmake --build ${buildDir} --verbose`,
    exitCode: build?.code ?? configure.code,
    stdout: `${configure.stdout}\n${build?.stdout ?? ""}`.trim(),
    stderr: `${configure.stderr}\n${build?.stderr ?? ""}`.trim(),
  };
}

async function detectAscendToolchain() {
  const candidates = [
    process.env.ASCEND_HOME_PATH,
    process.env.ASCENDC_CMAKE_PATH,
    process.env.ASCENDC_DEVKIT_PATH,
    "/usr/local/Ascend",
    "/opt/miniconda3/Ascend",
  ].filter(Boolean);

  const existingPaths = [];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      existingPaths.push(candidate);
    }
  }

  return {
    present: existingPaths.length > 0,
    details: {
      env: {
        ASCEND_HOME_PATH: process.env.ASCEND_HOME_PATH ?? null,
        ASCENDC_CMAKE_PATH: process.env.ASCENDC_CMAKE_PATH ?? null,
        ASCENDC_DEVKIT_PATH: process.env.ASCENDC_DEVKIT_PATH ?? null,
      },
      existingPaths,
    },
  };
}

async function hasCommand(command) {
  const result = await runProcess({
    command: "bash",
    args: ["-lc", `command -v ${command}`],
  });
  return result.code === 0;
}

function resolveCompileCwd(cwdSetting, paths) {
  if (cwdSetting === "workspace") {
    return paths.workspaceDir;
  }
  if (cwdSetting === "attempt") {
    return paths.attemptDir;
  }
  if (cwdSetting === "run") {
    return paths.runDir;
  }
  return renderTemplate(cwdSetting, {
    workspace: paths.workspaceDir,
    attempt_dir: paths.attemptDir,
    run_dir: paths.runDir,
  });
}

function shouldInspectPath(rootPath, filePath) {
  const relative = path.relative(rootPath, filePath);
  const segments = relative.split(path.sep);
  return !segments.some((segment) => IGNORED_PATH_SEGMENTS.has(segment));
}
