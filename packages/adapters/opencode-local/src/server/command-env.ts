import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const OPENCODE_DEFAULT_COMMANDS = new Set(["opencode", "opencode.exe", "opencode.cmd", "opencode.bat"]);

function commandLooksPathLike(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function shouldInjectOpenCodePath(command: string): boolean {
  const trimmed = command.trim().toLowerCase();
  if (!trimmed || commandLooksPathLike(trimmed)) return false;
  return OPENCODE_DEFAULT_COMMANDS.has(trimmed);
}

async function openCodeBinaryExists(binDir: string): Promise<boolean> {
  const candidates = process.platform === "win32"
    ? ["opencode.exe", "opencode.cmd", "opencode.bat", "opencode"]
    : ["opencode"];
  for (const candidate of candidates) {
    try {
      await fs.access(path.join(binDir, candidate));
      return true;
    } catch {
      // Ignore and try the next candidate.
    }
  }
  return false;
}

function pathAlreadyContains(pathValue: string, candidateDir: string): boolean {
  const delimiter = process.platform === "win32" ? ";" : ":";
  const entries = pathValue.split(delimiter).filter(Boolean);
  if (process.platform === "win32") {
    const normalizedCandidate = path.normalize(candidateDir).toLowerCase();
    return entries.some((entry) => path.normalize(entry).toLowerCase() === normalizedCandidate);
  }
  return entries.some((entry) => entry === candidateDir);
}

function normalizePathEntries(pathValue: string): string {
  const delimiter = process.platform === "win32" ? ";" : ":";
  const cleaned = pathValue
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      if (entry.startsWith('"') && entry.endsWith('"') && entry.length > 1) {
        return entry.slice(1, -1);
      }
      return entry;
    });
  return cleaned.join(delimiter);
}

export async function withOpenCodePathFallback(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  if (!shouldInjectOpenCodePath(command)) return env;

  const openCodeBinDir = path.join(os.homedir(), ".opencode", "bin");
  if (!(await openCodeBinaryExists(openCodeBinDir))) return env;

  const delimiter = process.platform === "win32" ? ";" : ":";
  const pathKey = typeof env.PATH === "string" ? "PATH" : "Path";
  const currentPath = (env[pathKey] ?? "").trim();
  const normalizedCurrentPath = normalizePathEntries(currentPath);
  const nextEnv: NodeJS.ProcessEnv =
    normalizedCurrentPath !== currentPath
      ? {
        ...env,
        [pathKey]: normalizedCurrentPath,
      }
      : env;
  if (normalizedCurrentPath.length > 0 && pathAlreadyContains(normalizedCurrentPath, openCodeBinDir)) {
    return nextEnv;
  }

  const nextPath = normalizedCurrentPath.length > 0
    ? `${openCodeBinDir}${delimiter}${normalizedCurrentPath}`
    : openCodeBinDir;
  return {
    ...nextEnv,
    [pathKey]: nextPath,
  };
}