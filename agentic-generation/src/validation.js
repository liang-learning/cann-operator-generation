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
      structure,
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

async function runAutoDetectedCmakeBuild({ config, workspaceDir, attemptDir, structure, logPath }) {
  const buildDir = path.join(attemptDir, "compile", config.compileCheck.buildDirName);
  await ensureDir(buildDir);
  const toolchainEnv = await inferAscendToolchainEnvironment();
  const compileEnv = buildCompileEnv(toolchainEnv);

  const hasNinja = await hasCommand("ninja");
  const sourceDir = selectAutoDetectedCmakeSourceDir({ workspaceDir, structure });
  const configureArgs = ["-S", sourceDir, "-B", buildDir];
  if (hasNinja) {
    configureArgs.push("-G", "Ninja");
  }

  const configure = await runProcess({
    command: "cmake",
    args: configureArgs,
    cwd: sourceDir,
    timeoutMs: config.compileCheck.timeoutSec * 1000,
    env: compileEnv,
  });

  const build = configure.code === 0
    ? await runProcess({
        command: "cmake",
        args: ["--build", buildDir, "--verbose"],
        cwd: sourceDir,
        timeoutMs: config.compileCheck.timeoutSec * 1000,
        env: compileEnv,
      })
    : null;

  const log = [
    `cwd: ${sourceDir}`,
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
    command: `cmake -S ${sourceDir} -B ${buildDir}${hasNinja ? " -G Ninja" : ""} && cmake --build ${buildDir} --verbose`,
    exitCode: build?.code ?? configure.code,
    stdout: `${configure.stdout}\n${build?.stdout ?? ""}`.trim(),
    stderr: `${configure.stderr}\n${build?.stderr ?? ""}`.trim(),
  };
}

function buildCompileEnv(toolchainEnv) {
  const env = {};
  const includePaths = [];
  const libraryPaths = [];

  if (toolchainEnv.ASCEND_HOME_PATH) {
    env.ASCEND_HOME_PATH = toolchainEnv.ASCEND_HOME_PATH;
    includePaths.push(
      path.join(toolchainEnv.ASCEND_HOME_PATH, "x86_64-linux", "include"),
      path.join(toolchainEnv.ASCEND_HOME_PATH, "x86_64-linux", "asc", "include"),
      path.join(toolchainEnv.ASCEND_HOME_PATH, "x86_64-linux", "ascendc", "include"),
    );
    libraryPaths.push(
      path.join(toolchainEnv.ASCEND_HOME_PATH, "x86_64-linux", "lib64"),
      path.join(toolchainEnv.ASCEND_HOME_PATH, "x86_64-linux", "lib64", "device", "lib64"),
      path.join(toolchainEnv.ASCEND_HOME_PATH, "tools", "bisheng_compiler", "lib"),
      path.join(toolchainEnv.ASCEND_HOME_PATH, "tools", "bisheng_compiler", "lib64"),
      path.join(toolchainEnv.ASCEND_HOME_PATH, "x86_64-linux", "ccec_compiler", "lib64"),
      path.join(toolchainEnv.ASCEND_HOME_PATH, "x86_64-linux", "lib64", "plugin", "asc"),
    );
  }
  if (toolchainEnv.ASCENDC_CMAKE_PATH) {
    env.ASCENDC_CMAKE_PATH = toolchainEnv.ASCENDC_CMAKE_PATH;
    env.ASC_DIR = toolchainEnv.ASCENDC_CMAKE_PATH;
    env.CMAKE_PREFIX_PATH = [
      toolchainEnv.ASCENDC_CMAKE_PATH,
      process.env.CMAKE_PREFIX_PATH ?? "",
    ]
      .filter(Boolean)
      .join(":");
  }
  if (toolchainEnv.ASCENDC_DEVKIT_PATH) {
    env.ASCENDC_DEVKIT_PATH = toolchainEnv.ASCENDC_DEVKIT_PATH;
  }
  if (toolchainEnv.prependPath?.length) {
    const existingPathEntries = new Set((process.env.PATH ?? "").split(":").filter(Boolean));
    env.PATH = [
      ...toolchainEnv.prependPath.filter((entry) => !existingPathEntries.has(entry)),
      process.env.PATH ?? "",
    ]
      .filter(Boolean)
      .join(":");
  }

  const resolvedIncludePaths = includePaths.filter(Boolean);
  if (resolvedIncludePaths.length > 0) {
    env.CPLUS_INCLUDE_PATH = [
      ...resolvedIncludePaths,
      process.env.CPLUS_INCLUDE_PATH ?? "",
    ]
      .filter(Boolean)
      .join(":");
    env.C_INCLUDE_PATH = [
      ...resolvedIncludePaths,
      process.env.C_INCLUDE_PATH ?? "",
    ]
      .filter(Boolean)
      .join(":");
  }

  const resolvedLibraryPaths = libraryPaths.filter(Boolean);
  if (resolvedLibraryPaths.length > 0) {
    env.LD_LIBRARY_PATH = [
      ...resolvedLibraryPaths,
      process.env.LD_LIBRARY_PATH ?? "",
    ]
      .filter(Boolean)
      .join(":");
    env.LIBRARY_PATH = [
      ...resolvedLibraryPaths,
      process.env.LIBRARY_PATH ?? "",
    ]
      .filter(Boolean)
      .join(":");
  }
  return env;
}

function selectAutoDetectedCmakeSourceDir({ workspaceDir, structure }) {
  const candidateDirs = [...new Set(structure.cmakeFiles.map((filePath) => path.dirname(filePath)))];
  if (candidateDirs.length <= 1) {
    return candidateDirs[0] ?? workspaceDir;
  }

  const rankedCandidates = candidateDirs
    .map((candidateDir) => ({
      candidateDir,
      score: {
        mainExact: countDirectoryMatches(structure.mainSignatureFiles, candidateDir),
        mainContained: countContainedMatches(structure.mainSignatureFiles, candidateDir),
        ascExact: countDirectoryMatches(structure.ascFiles, candidateDir),
        ascContained: countContainedMatches(structure.ascFiles, candidateDir),
        headerExact: countDirectoryMatches(structure.headerFiles, candidateDir),
        headerContained: countContainedMatches(structure.headerFiles, candidateDir),
        depth: getDirectoryDepth(workspaceDir, candidateDir),
      },
    }))
    .sort((left, right) => compareCandidateScores(right.score, left.score));

  return rankedCandidates[0]?.candidateDir ?? workspaceDir;
}

function countDirectoryMatches(filePaths, candidateDir) {
  return filePaths.filter((filePath) => path.dirname(filePath) === candidateDir).length;
}

function countContainedMatches(filePaths, candidateDir) {
  return filePaths.filter((filePath) => isWithinDirectory(candidateDir, filePath)).length;
}

function isWithinDirectory(candidateDir, filePath) {
  const relative = path.relative(candidateDir, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function getDirectoryDepth(rootDir, candidateDir) {
  const relative = path.relative(rootDir, candidateDir);
  if (!relative || relative === ".") {
    return 0;
  }
  return relative.split(path.sep).length;
}

function compareCandidateScores(left, right) {
  return (
    left.mainExact - right.mainExact ||
    left.mainContained - right.mainContained ||
    left.ascExact - right.ascExact ||
    left.ascContained - right.ascContained ||
    left.headerExact - right.headerExact ||
    left.headerContained - right.headerContained ||
    left.depth - right.depth
  );
}

async function detectAscendToolchain() {
  const inferred = await inferAscendToolchainEnvironment();
  const existingPaths = [
    inferred.ASCEND_HOME_PATH,
    inferred.ASCENDC_CMAKE_PATH,
    inferred.ASCENDC_DEVKIT_PATH,
    ...inferred.prependPath,
  ].filter(Boolean);

  return {
    present: existingPaths.length > 0,
    details: {
      env: {
        ASCEND_HOME_PATH: inferred.ASCEND_HOME_PATH ?? null,
        ASCENDC_CMAKE_PATH: inferred.ASCENDC_CMAKE_PATH ?? null,
        ASCENDC_DEVKIT_PATH: inferred.ASCENDC_DEVKIT_PATH ?? null,
      },
      existingPaths,
    },
  };
}

async function inferAscendToolchainEnvironment() {
  const ascendHomeCandidates = [
    process.env.ASCEND_HOME_PATH,
    "/opt/miniconda/Ascend/cann-8.5.0",
    "/opt/miniconda/Ascend/ascend-toolkit",
    "/opt/miniconda3/Ascend/cann-8.5.0",
    "/opt/miniconda3/Ascend/ascend-toolkit",
    "/usr/local/Ascend/ascend-toolkit/latest",
  ].filter(Boolean);

  let ascendHomePath = null;
  for (const candidate of ascendHomeCandidates) {
    if (
      await pathExists(path.join(candidate, "x86_64-linux")) ||
      await pathExists(path.join(candidate, "aarch64-linux"))
    ) {
      ascendHomePath = candidate;
      break;
    }
  }

  const cmakeCandidates = ascendHomePath
    ? [
        path.join(ascendHomePath, "x86_64-linux", "tikcpp", "ascendc_kernel_cmake"),
        path.join(ascendHomePath, "x86_64-linux", "lib64", "cmake"),
        path.join(ascendHomePath, "aarch64-linux", "lib64", "cmake"),
        path.join(ascendHomePath, "aarch64-linux", "tikcpp", "ascendc_kernel_cmake"),
      ]
    : [];

  let ascendcCmakePath = null;
  for (const candidate of cmakeCandidates) {
    if (await pathExists(path.join(candidate, "ASCConfig.cmake"))) {
      ascendcCmakePath = candidate;
      break;
    }
  }

  const devkitCandidates = [
    process.env.ASCENDC_DEVKIT_PATH,
    path.join(process.cwd(), "agentic_run", "asc-devkit"),
    path.join(process.cwd(), "asc-devkit"),
  ].filter(Boolean);

  let ascendcDevkitPath = null;
  for (const candidate of devkitCandidates) {
    if (await pathExists(candidate)) {
      ascendcDevkitPath = candidate;
      break;
    }
  }

  const prependPath = [];
  if (ascendHomePath) {
    for (const candidate of [
      path.join(ascendHomePath, "x86_64-linux", "bin"),
      path.join(ascendHomePath, "aarch64-linux", "bin"),
      path.join(ascendHomePath, "tools", "bisheng_compiler", "bin"),
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
