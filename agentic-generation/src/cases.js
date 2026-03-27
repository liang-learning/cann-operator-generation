import path from "node:path";
import { promises as fs } from "node:fs";

import { findFilesByName, readText, sanitizeCaseId } from "./utils.js";

export async function discoverCases(casesPath) {
  const stats = await fs.stat(casesPath);

  if (stats.isFile()) {
    return [
      {
        id: "root",
        caseDir: path.dirname(casesPath),
        promptPath: casesPath,
        promptText: await readText(casesPath),
        relativeCaseDir: ".",
      },
    ];
  }

  if (!stats.isDirectory()) {
    throw new Error(`Unsupported cases path: ${casesPath}`);
  }

  const promptFiles = await findFilesByName(casesPath, "prompt.txt");
  if (promptFiles.length === 0) {
    throw new Error(`No prompt.txt found under ${casesPath}`);
  }

  return Promise.all(
    promptFiles.map(async (promptPath) => {
      const caseDir = path.dirname(promptPath);
      const relativeCaseDir = path.relative(casesPath, caseDir) || ".";
      return {
        id: sanitizeCaseId(relativeCaseDir),
        caseDir,
        promptPath,
        promptText: await readText(promptPath),
        relativeCaseDir,
      };
    }),
  );
}
