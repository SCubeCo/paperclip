import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { resolveHomeAwarePath, resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";
import { instructionFilesRepo } from "./agent-instruction-files-repo.js";

const ENTRY_FILE_DEFAULT = "AGENTS.md";
const MODE_KEY = "instructionsBundleMode";
const ROOT_KEY = "instructionsRootPath";
const ENTRY_KEY = "instructionsEntryFile";
const FILE_KEY = "instructionsFilePath";
const PROMPT_KEY = "promptTemplate";
/** @deprecated Use the managed instructions bundle system instead. */
const BOOTSTRAP_PROMPT_KEY = "bootstrapPromptTemplate";
const LEGACY_PROMPT_TEMPLATE_PATH = "promptTemplate.legacy.md";
const IGNORED_INSTRUCTIONS_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "Desktop.ini"]);
const IGNORED_INSTRUCTIONS_DIRECTORY_NAMES = new Set([
  ".git",
  ".nox",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  "__pycache__",
  "node_modules",
  "venv",
]);

type BundleMode = "managed" | "external";

type AgentLike = {
  id: string;
  companyId: string;
  name: string;
  adapterConfig: unknown;
};

type AgentInstructionsFileSummary = {
  path: string;
  size: number;
  language: string;
  markdown: boolean;
  isEntryFile: boolean;
  editable: boolean;
  deprecated: boolean;
  virtual: boolean;
};

type AgentInstructionsFileDetail = AgentInstructionsFileSummary & {
  content: string;
  editable: boolean;
};

type AgentInstructionsBundle = {
  agentId: string;
  companyId: string;
  mode: BundleMode | null;
  rootPath: string | null;
  managedRootPath: string;
  entryFile: string;
  resolvedEntryPath: string | null;
  editable: boolean;
  warnings: string[];
  legacyPromptTemplateActive: boolean;
  legacyBootstrapPromptTemplateActive: boolean;
  files: AgentInstructionsFileSummary[];
};

type BundleState = {
  config: Record<string, unknown>;
  mode: BundleMode | null;
  rootPath: string | null;
  entryFile: string;
  resolvedEntryPath: string | null;
  warnings: string[];
  legacyPromptTemplateActive: boolean;
  legacyBootstrapPromptTemplateActive: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isBundleMode(value: unknown): value is BundleMode {
  return value === "managed" || value === "external";
}

function inferLanguage(relativePath: string): string {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return "javascript";
  }
  if (lower.endsWith(".sh")) return "bash";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".toml")) return "toml";
  if (lower.endsWith(".txt")) return "text";
  return "text";
}

function isMarkdown(relativePath: string) {
  return relativePath.toLowerCase().endsWith(".md");
}

function normalizeRelativeFilePath(candidatePath: string): string {
  const normalized = path.posix.normalize(candidatePath.replaceAll("\\", "/")).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw unprocessable("Instructions file path must stay within the bundle root");
  }
  return normalized;
}

function resolvePathWithinRoot(rootPath: string, relativePath: string): string {
  const normalizedRelativePath = normalizeRelativeFilePath(relativePath);
  const absoluteRoot = path.resolve(rootPath);
  const absolutePath = path.resolve(absoluteRoot, normalizedRelativePath);
  const relativeToRoot = path.relative(absoluteRoot, absolutePath);
  if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`)) {
    throw unprocessable("Instructions file path must stay within the bundle root");
  }
  return absolutePath;
}

function resolveManagedInstructionsRoot(agent: AgentLike): string {
  return path.resolve(
    resolvePaperclipInstanceRoot(),
    "companies",
    agent.companyId,
    "agents",
    agent.id,
    "instructions",
  );
}

function resolveLegacyInstructionsPath(candidatePath: string, config: Record<string, unknown>): string {
  if (path.isAbsolute(candidatePath)) return candidatePath;
  const cwd = asString(config.cwd);
  if (!cwd || !path.isAbsolute(cwd)) {
    throw unprocessable(
      "Legacy relative instructionsFilePath requires adapterConfig.cwd to be set to an absolute path",
    );
  }
  return path.resolve(cwd, candidatePath);
}

async function statIfExists(targetPath: string) {
  return fs.stat(targetPath).catch(() => null);
}

function shouldIgnoreInstructionsEntry(entry: { name: string; isDirectory(): boolean; isFile(): boolean }) {
  if (entry.name === "." || entry.name === "..") return true;
  if (entry.isDirectory()) {
    return IGNORED_INSTRUCTIONS_DIRECTORY_NAMES.has(entry.name);
  }
  if (!entry.isFile()) return false;
  return (
    IGNORED_INSTRUCTIONS_FILE_NAMES.has(entry.name)
    || entry.name.startsWith("._")
    || entry.name.endsWith(".pyc")
    || entry.name.endsWith(".pyo")
  );
}

async function listFilesRecursive(rootPath: string): Promise<string[]> {
  const output: string[] = [];

  async function walk(currentPath: string, relativeDir: string) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (shouldIgnoreInstructionsEntry(entry)) continue;
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = normalizeRelativeFilePath(
        relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name,
      );
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      output.push(relativePath);
    }
  }

  await walk(rootPath, "");
  return output.sort((left, right) => left.localeCompare(right));
}

async function readFileSummary(rootPath: string, relativePath: string, entryFile: string): Promise<AgentInstructionsFileSummary> {
  const absolutePath = resolvePathWithinRoot(rootPath, relativePath);
  const stat = await fs.stat(absolutePath);
  return {
    path: relativePath,
    size: stat.size,
    language: inferLanguage(relativePath),
    markdown: isMarkdown(relativePath),
    isEntryFile: relativePath === entryFile,
    editable: true,
    deprecated: false,
    virtual: false,
  };
}

async function readLegacyInstructions(agent: AgentLike, config: Record<string, unknown>): Promise<string> {
  const instructionsFilePath = asString(config[FILE_KEY]);
  if (instructionsFilePath) {
    try {
      const resolvedPath = resolveLegacyInstructionsPath(instructionsFilePath, config);
      return await fs.readFile(resolvedPath, "utf8");
    } catch {
      // Fall back to promptTemplate below.
    }
  }
  return asString(config[PROMPT_KEY]) ?? "";
}

function deriveBundleState(agent: AgentLike): BundleState {
  const config = asRecord(agent.adapterConfig);
  const warnings: string[] = [];
  const storedModeRaw = config[MODE_KEY];
  const storedRootRaw = asString(config[ROOT_KEY]);
  const legacyInstructionsPath = asString(config[FILE_KEY]);

  let mode: BundleMode | null = isBundleMode(storedModeRaw) ? storedModeRaw : null;
  let rootPath = storedRootRaw ? resolveHomeAwarePath(storedRootRaw) : null;
  let entryFile = ENTRY_FILE_DEFAULT;

  const storedEntryRaw = asString(config[ENTRY_KEY]);
  if (storedEntryRaw) {
    try {
      entryFile = normalizeRelativeFilePath(storedEntryRaw);
    } catch {
      warnings.push(`Ignored invalid instructions entry file "${storedEntryRaw}".`);
    }
  }

  if (!rootPath && legacyInstructionsPath) {
    try {
      const resolvedLegacyPath = resolveLegacyInstructionsPath(legacyInstructionsPath, config);
      rootPath = path.dirname(resolvedLegacyPath);
      entryFile = path.basename(resolvedLegacyPath);
      mode = resolvedLegacyPath.startsWith(`${resolveManagedInstructionsRoot(agent)}${path.sep}`)
        || resolvedLegacyPath === path.join(resolveManagedInstructionsRoot(agent), entryFile)
        ? "managed"
        : "external";
      if (!path.isAbsolute(legacyInstructionsPath)) {
        warnings.push("Using legacy relative instructionsFilePath; migrate this agent to a managed or absolute external bundle.");
      }
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err));
    }
  }

  const resolvedEntryPath = rootPath ? path.resolve(rootPath, entryFile) : null;

  return {
    config,
    mode,
    rootPath,
    entryFile,
    resolvedEntryPath,
    warnings,
    legacyPromptTemplateActive: Boolean(asString(config[PROMPT_KEY])),
    legacyBootstrapPromptTemplateActive: Boolean(asString(config[BOOTSTRAP_PROMPT_KEY])),
  };
}

async function migrateManagedFromFilesystem(agent: AgentLike, db: Db): Promise<boolean> {
  const managedRootPath = resolveManagedInstructionsRoot(agent);
  const dirStat = await statIfExists(managedRootPath);
  if (!dirStat?.isDirectory()) return false;

  const files = await listFilesRecursive(managedRootPath);
  if (files.length === 0) return false;

  let migratedCount = 0;
  for (const filePath of files) {
    try {
      const absolutePath = resolvePathWithinRoot(managedRootPath, filePath);
      const content = await fs.readFile(absolutePath, "utf8");
      const repo = instructionFilesRepo(db);
      await repo.upsert(agent.id, filePath, content);
      migratedCount++;
    } catch (err) {
      logger.warn({ agentId: agent.id, filePath, err }, "Failed to migrate instruction file from filesystem to database");
    }
  }

  if (migratedCount > 0) {
    logger.info({ agentId: agent.id, count: migratedCount }, "Agent instructions migration complete: filesystem to database");
  }
  return migratedCount > 0;
}

async function recoverManagedBundleState(agent: AgentLike, state: BundleState, db: Db): Promise<BundleState> {
  const managedRootPath = resolveManagedInstructionsRoot(agent);
  const repo = instructionFilesRepo(db);

  const fileCount = await repo.countByAgent(agent.id).catch((err) => {
    logger.error({ agentId: agent.id, err }, "Database read error: failed to count instruction files");
    return 0;
  });

  if (fileCount > 0) {
    const filePaths = await repo.filePathsByAgent(agent.id);
    if (filePaths.length === 0) return state;

    const recoveredEntryFile = filePaths.includes(state.entryFile)
      ? state.entryFile
      : filePaths.includes(ENTRY_FILE_DEFAULT)
        ? ENTRY_FILE_DEFAULT
        : filePaths[0]!;

    if (!state.rootPath) {
      return {
        ...state,
        mode: "managed",
        rootPath: managedRootPath,
        entryFile: recoveredEntryFile,
        resolvedEntryPath: path.resolve(managedRootPath, recoveredEntryFile),
      };
    }

    if (state.mode === "external") return state;

    const resolvedConfiguredRoot = path.resolve(state.rootPath);
    const configuredRootMatchesManaged = resolvedConfiguredRoot === managedRootPath;
    const hasEntryMismatch = recoveredEntryFile !== state.entryFile;

    if (configuredRootMatchesManaged && !hasEntryMismatch) {
      return state;
    }

    const warnings = [...state.warnings];
    if (!configuredRootMatchesManaged) {
      warnings.push(
        `Recovered managed instructions from database at ${managedRootPath}; ignoring stale configured root ${state.rootPath}.`,
      );
    }
    if (hasEntryMismatch) {
      warnings.push(
        `Recovered managed instructions entry file from database as ${recoveredEntryFile}; previous entry ${state.entryFile} was missing.`,
      );
    }

    return {
      ...state,
      mode: "managed",
      rootPath: managedRootPath,
      entryFile: recoveredEntryFile,
      resolvedEntryPath: path.resolve(managedRootPath, recoveredEntryFile),
      warnings,
    };
  }

  // No DB records - try filesystem fallback for migration
  const stat = await statIfExists(managedRootPath);
  if (!stat?.isDirectory()) return state;

  const files = await listFilesRecursive(managedRootPath);
  if (files.length === 0) return state;

  const migrated = await migrateManagedFromFilesystem(agent, db);
  if (!migrated) return state;

  logger.info({ agentId: agent.id }, "Agent instructions restored from filesystem to database");
  return recoverManagedBundleState(agent, state, db);
}

function toBundle(agent: AgentLike, state: BundleState, files: AgentInstructionsFileSummary[]): AgentInstructionsBundle {
  const nextFiles = [...files];
  if (state.legacyPromptTemplateActive && !nextFiles.some((file) => file.path === LEGACY_PROMPT_TEMPLATE_PATH)) {
    const legacyPromptTemplate = asString(state.config[PROMPT_KEY]) ?? "";
    nextFiles.push({
      path: LEGACY_PROMPT_TEMPLATE_PATH,
      size: legacyPromptTemplate.length,
      language: "markdown",
      markdown: true,
      isEntryFile: false,
      editable: true,
      deprecated: true,
      virtual: true,
    });
  }
  nextFiles.sort((left, right) => left.path.localeCompare(right.path));
  return {
    agentId: agent.id,
    companyId: agent.companyId,
    mode: state.mode,
    rootPath: state.rootPath,
    managedRootPath: resolveManagedInstructionsRoot(agent),
    entryFile: state.entryFile,
    resolvedEntryPath: state.resolvedEntryPath,
    editable: Boolean(state.rootPath),
    warnings: state.warnings,
    legacyPromptTemplateActive: state.legacyPromptTemplateActive,
    legacyBootstrapPromptTemplateActive: state.legacyBootstrapPromptTemplateActive,
    files: nextFiles,
  };
}

function applyBundleConfig(
  config: Record<string, unknown>,
  input: {
    mode: BundleMode;
    rootPath: string;
    entryFile: string;
    clearLegacyPromptTemplate?: boolean;
  },
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...config,
    [MODE_KEY]: input.mode,
    [ROOT_KEY]: input.rootPath,
    [ENTRY_KEY]: input.entryFile,
    [FILE_KEY]: path.resolve(input.rootPath, input.entryFile),
  };
  if (input.clearLegacyPromptTemplate) {
    delete next[PROMPT_KEY];
    delete next[BOOTSTRAP_PROMPT_KEY];
  }
  return next;
}

function buildPersistedBundleConfig(
  derived: BundleState,
  current: BundleState,
  options?: { clearLegacyPromptTemplate?: boolean },
): Record<string, unknown> {
  const currentRootPath = current.rootPath ? path.resolve(current.rootPath) : null;
  const derivedRootPath = derived.rootPath ? path.resolve(derived.rootPath) : null;
  const configMatchesRecoveredState =
    derived.mode === current.mode
    && derivedRootPath !== null
    && currentRootPath !== null
    && derivedRootPath === currentRootPath
    && derived.entryFile === current.entryFile;

  if (configMatchesRecoveredState && !options?.clearLegacyPromptTemplate) {
    return current.config;
  }

  if (!current.rootPath || !current.mode) {
    return current.config;
  }

  return applyBundleConfig(current.config, {
    mode: current.mode,
    rootPath: current.rootPath,
    entryFile: current.entryFile,
    clearLegacyPromptTemplate: options?.clearLegacyPromptTemplate,
  });
}

async function writeBundleFiles(
  rootPath: string,
  files: Record<string, string>,
  options?: { overwriteExisting?: boolean },
) {
  for (const [relativePath, content] of Object.entries(files)) {
    const normalizedPath = normalizeRelativeFilePath(relativePath);
    const absolutePath = resolvePathWithinRoot(rootPath, normalizedPath);
    const existingStat = await statIfExists(absolutePath);
    if (existingStat?.isFile() && !options?.overwriteExisting) continue;
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
  }
}

export function syncInstructionsBundleConfigFromFilePath(
  agent: AgentLike,
  adapterConfig: Record<string, unknown>,
): Record<string, unknown> {
  const instructionsFilePath = asString(adapterConfig[FILE_KEY]);
  const next = { ...adapterConfig };
  if (!instructionsFilePath) {
    delete next[MODE_KEY];
    delete next[ROOT_KEY];
    delete next[ENTRY_KEY];
    return next;
  }
  const resolvedPath = resolveLegacyInstructionsPath(instructionsFilePath, adapterConfig);
  const rootPath = path.dirname(resolvedPath);
  const entryFile = path.basename(resolvedPath);
  const mode: BundleMode = resolvedPath.startsWith(`${resolveManagedInstructionsRoot(agent)}${path.sep}`)
    || resolvedPath === path.join(resolveManagedInstructionsRoot(agent), entryFile)
    ? "managed"
    : "external";
  return applyBundleConfig(next, { mode, rootPath, entryFile });
}

export function agentInstructionsService(db: Db) {
  const repo = instructionFilesRepo(db);

  async function getBundle(agent: AgentLike): Promise<AgentInstructionsBundle> {
    const state = await recoverManagedBundleState(agent, deriveBundleState(agent), db);
    if (!state.rootPath) return toBundle(agent, state, []);

    if (state.mode === "managed") {
      const rows = await repo.findByAgent(agent.id).catch((err) => {
        logger.error({ agentId: agent.id, err }, "Database read error: failed to read instruction files for bundle");
        return [];
      });
      if (rows.length === 0) return toBundle(agent, state, []);
      const summaries: AgentInstructionsFileSummary[] = rows.map((row) => ({
        path: row.filePath,
        size: row.content.length,
        language: inferLanguage(row.filePath),
        markdown: isMarkdown(row.filePath),
        isEntryFile: row.filePath === state.entryFile,
        editable: true,
        deprecated: false,
        virtual: false,
      }));
      logger.info({ agentId: agent.id, fileCount: rows.length }, "Loaded instruction files from database");
      return toBundle(agent, state, summaries);
    }

    // External mode: use filesystem
    const stat = await statIfExists(state.rootPath);
    if (!stat?.isDirectory()) {
      return toBundle(agent, {
        ...state,
        warnings: [...state.warnings, `Instructions root does not exist: ${state.rootPath}`],
      }, []);
    }
    const files = await listFilesRecursive(state.rootPath);
    const summaries = await Promise.all(files.map((relativePath) => readFileSummary(state.rootPath!, relativePath, state.entryFile)));
    return toBundle(agent, state, summaries);
  }

  async function readFile(agent: AgentLike, relativePath: string): Promise<AgentInstructionsFileDetail> {
    const state = await recoverManagedBundleState(agent, deriveBundleState(agent), db);
    if (relativePath === LEGACY_PROMPT_TEMPLATE_PATH) {
      const content = asString(state.config[PROMPT_KEY]);
      if (content === null) throw notFound("Instructions file not found");
      return {
        path: LEGACY_PROMPT_TEMPLATE_PATH,
        size: content.length,
        language: "markdown",
        markdown: true,
        isEntryFile: false,
        editable: true,
        deprecated: true,
        virtual: true,
        content,
      };
    }
    if (!state.rootPath) throw notFound("Agent instructions bundle is not configured");

    const normalizedPath = normalizeRelativeFilePath(relativePath);

    if (state.mode === "managed") {
      const row = await repo.findOne(agent.id, normalizedPath).catch((err) => {
        logger.error({ agentId: agent.id, filePath: normalizedPath, err }, "Database read error: failed to read instruction file");
        return null;
      });
      if (!row) throw notFound("Instructions file not found");
      logger.info({ agentId: agent.id, filePath: normalizedPath }, "Loaded instruction file from database");
      return {
        path: normalizedPath,
        size: row.content.length,
        language: inferLanguage(normalizedPath),
        markdown: isMarkdown(normalizedPath),
        isEntryFile: normalizedPath === state.entryFile,
        editable: true,
        deprecated: false,
        virtual: false,
        content: row.content,
      };
    }

    // External mode: use filesystem
    const absolutePath = resolvePathWithinRoot(state.rootPath, relativePath);
    const [content, stat] = await Promise.all([
      fs.readFile(absolutePath, "utf8").catch(() => null),
      fs.stat(absolutePath).catch(() => null),
    ]);
    if (content === null || !stat?.isFile()) throw notFound("Instructions file not found");
    return {
      path: normalizedPath,
      size: stat.size,
      language: inferLanguage(normalizedPath),
      markdown: isMarkdown(normalizedPath),
      isEntryFile: normalizedPath === state.entryFile,
      editable: true,
      deprecated: false,
      virtual: false,
      content,
    };
  }

  async function ensureWritableBundle(
    agent: AgentLike,
    options?: { clearLegacyPromptTemplate?: boolean },
  ): Promise<{ adapterConfig: Record<string, unknown>; state: BundleState }> {
    const derived = deriveBundleState(agent);
    const current = await recoverManagedBundleState(agent, derived, db);
    if (current.rootPath && current.mode) {
      const adapterConfig = buildPersistedBundleConfig(derived, current, options);
      return {
        adapterConfig,
        state: deriveBundleState({ ...agent, adapterConfig }),
      };
    }

    const managedRoot = resolveManagedInstructionsRoot(agent);
    const entryFile = current.entryFile || ENTRY_FILE_DEFAULT;
    const nextConfig = applyBundleConfig(current.config, {
      mode: "managed",
      rootPath: managedRoot,
      entryFile,
      clearLegacyPromptTemplate: options?.clearLegacyPromptTemplate,
    });

    const hasDb = await repo.countByAgent(agent.id).catch(() => 0);
    if (hasDb === 0) {
      const entryRecord = await repo.findOne(agent.id, entryFile).catch(() => null);
      if (!entryRecord) {
        const legacyInstructions = await readLegacyInstructions(agent, current.config);
        if (legacyInstructions.trim().length > 0) {
          await repo.upsert(agent.id, entryFile, legacyInstructions).catch((err) => {
            logger.error({ agentId: agent.id, filePath: entryFile, err }, "Database write failure: failed to create entry instruction file");
          });
        }
      }
    }

    return {
      adapterConfig: nextConfig,
      state: deriveBundleState({ ...agent, adapterConfig: nextConfig }),
    };
  }

  async function updateBundle(
    agent: AgentLike,
    input: {
      mode?: BundleMode;
      rootPath?: string | null;
      entryFile?: string;
      clearLegacyPromptTemplate?: boolean;
    },
  ): Promise<{ bundle: AgentInstructionsBundle; adapterConfig: Record<string, unknown> }> {
    const state = await recoverManagedBundleState(agent, deriveBundleState(agent), db);
    const nextMode = input.mode ?? state.mode ?? "managed";
    const nextEntryFile = input.entryFile ? normalizeRelativeFilePath(input.entryFile) : state.entryFile;
    let nextRootPath: string;

    if (nextMode === "managed") {
      nextRootPath = resolveManagedInstructionsRoot(agent);
    } else {
      const rootPath = asString(input.rootPath) ?? state.rootPath;
      if (!rootPath) {
        throw unprocessable("External instructions bundles require an absolute rootPath");
      }
      const resolvedRoot = resolveHomeAwarePath(rootPath);
      if (!path.isAbsolute(resolvedRoot)) {
        throw unprocessable("External instructions bundles require an absolute rootPath");
      }
      nextRootPath = resolvedRoot;
    }

    if (nextMode === "managed") {
      const hasDb = await repo.countByAgent(agent.id).catch(() => 0);
      if (hasDb === 0) {
        const exported = await exportFiles(agent);
        for (const [filePath, content] of Object.entries(exported.files)) {
          await repo.upsert(agent.id, filePath, content).catch((err) => {
            logger.error({ agentId: agent.id, filePath, err }, "Database write failure: failed to write instruction file during bundle update");
          });
        }
      }
      const dbFiles = await repo.filePathsByAgent(agent.id);
      if (!dbFiles.includes(nextEntryFile)) {
        const exportedResult = await exportFiles(agent);
        const content = exportedResult.files[nextEntryFile] ?? exportedResult.files[exportedResult.entryFile] ?? "";
        await repo.upsert(agent.id, nextEntryFile, content);
      }
    } else {
      await fs.mkdir(nextRootPath, { recursive: true });
      const existingFiles = await listFilesRecursive(nextRootPath);
      const exported = await exportFiles(agent);
      if (existingFiles.length === 0) {
        await writeBundleFiles(nextRootPath, exported.files);
      }
      const refreshedFiles = existingFiles.length === 0 ? await listFilesRecursive(nextRootPath) : existingFiles;
      if (!refreshedFiles.includes(nextEntryFile)) {
        const nextEntryContent = exported.files[nextEntryFile] ?? exported.files[exported.entryFile] ?? "";
        await writeBundleFiles(nextRootPath, { [nextEntryFile]: nextEntryContent });
      }
    }

    const nextConfig = applyBundleConfig(state.config, {
      mode: nextMode,
      rootPath: nextRootPath,
      entryFile: nextEntryFile,
      clearLegacyPromptTemplate: input.clearLegacyPromptTemplate,
    });
    const nextBundle = await getBundle({ ...agent, adapterConfig: nextConfig });
    return { bundle: nextBundle, adapterConfig: nextConfig };
  }

  async function writeFile(
    agent: AgentLike,
    relativePath: string,
    content: string,
    options?: { clearLegacyPromptTemplate?: boolean },
  ): Promise<{
    bundle: AgentInstructionsBundle;
    file: AgentInstructionsFileDetail;
    adapterConfig: Record<string, unknown>;
  }> {
    const current = deriveBundleState(agent);
    if (relativePath === LEGACY_PROMPT_TEMPLATE_PATH) {
      const adapterConfig: Record<string, unknown> = {
        ...current.config,
        [PROMPT_KEY]: content,
      };
      const nextAgent = { ...agent, adapterConfig };
      const [bundle, file] = await Promise.all([
        getBundle(nextAgent),
        readFile(nextAgent, LEGACY_PROMPT_TEMPLATE_PATH),
      ]);
      return { bundle, file, adapterConfig };
    }

    const prepared = await ensureWritableBundle(agent, options);
    const normalizedPath = normalizeRelativeFilePath(relativePath);

    if (prepared.state.mode === "managed") {
      await repo.upsert(agent.id, normalizedPath, content).catch((err) => {
        logger.error({ agentId: agent.id, filePath: normalizedPath, err }, "Database write failure: failed to write instruction file");
        throw err;
      });
      logger.info({ agentId: agent.id, filePath: normalizedPath }, "Wrote instruction file to database");
    } else {
      const absolutePath = resolvePathWithinRoot(prepared.state.rootPath!, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, content, "utf8");
    }

    const nextAgent = { ...agent, adapterConfig: prepared.adapterConfig };
    const [bundle, file] = await Promise.all([
      getBundle(nextAgent),
      readFile(nextAgent, relativePath),
    ]);
    return { bundle, file, adapterConfig: prepared.adapterConfig };
  }

  async function deleteFile(agent: AgentLike, relativePath: string): Promise<{
    bundle: AgentInstructionsBundle;
    adapterConfig: Record<string, unknown>;
  }> {
    const derived = deriveBundleState(agent);
    const state = await recoverManagedBundleState(agent, derived, db);
    if (relativePath === LEGACY_PROMPT_TEMPLATE_PATH) {
      throw unprocessable("Cannot delete the legacy promptTemplate pseudo-file");
    }
    if (!state.rootPath) throw notFound("Agent instructions bundle is not configured");
    const normalizedPath = normalizeRelativeFilePath(relativePath);
    if (normalizedPath === state.entryFile) {
      throw unprocessable("Cannot delete the bundle entry file");
    }

    if (state.mode === "managed") {
      await repo.deleteOne(agent.id, normalizedPath);
      logger.info({ agentId: agent.id, filePath: normalizedPath }, "Deleted instruction file from database");
    } else {
      const absolutePath = resolvePathWithinRoot(state.rootPath, normalizedPath);
      await fs.rm(absolutePath, { force: true });
    }

    const adapterConfig = buildPersistedBundleConfig(derived, state);
    const bundle = await getBundle({ ...agent, adapterConfig });
    return { bundle, adapterConfig };
  }

  async function exportFiles(agent: AgentLike): Promise<{
    files: Record<string, string>;
    entryFile: string;
    warnings: string[];
  }> {
    const state = await recoverManagedBundleState(agent, deriveBundleState(agent), db);
    if (state.rootPath) {
      if (state.mode === "managed") {
        const rows = await repo.findByAgent(agent.id).catch((err) => {
          logger.error({ agentId: agent.id, err }, "Database read error: failed to read instruction files for export");
          return [];
        });
        if (rows.length > 0) {
          const files = Object.fromEntries(rows.map((row) => [row.filePath, row.content]));
          logger.info({ agentId: agent.id, fileCount: rows.length }, "Exported instruction files from database");
          return { files, entryFile: state.entryFile, warnings: state.warnings };
        }
      } else {
        const stat = await statIfExists(state.rootPath);
        if (stat?.isDirectory()) {
          const relativePaths = await listFilesRecursive(state.rootPath);
          const files = Object.fromEntries(await Promise.all(relativePaths.map(async (relativePath) => {
            const absolutePath = resolvePathWithinRoot(state.rootPath!, relativePath);
            const content = await fs.readFile(absolutePath, "utf8");
            return [relativePath, content] as const;
          })));
          if (Object.keys(files).length > 0) {
            return { files, entryFile: state.entryFile, warnings: state.warnings };
          }
        }
      }
    }

    const legacyBody = await readLegacyInstructions(agent, state.config);
    return {
      files: { [state.entryFile]: legacyBody || "_No AGENTS instructions were resolved from current agent config._" },
      entryFile: state.entryFile,
      warnings: state.warnings,
    };
  }

  async function materializeManagedBundle(
    agent: AgentLike,
    files: Record<string, string>,
    options?: {
      clearLegacyPromptTemplate?: boolean;
      replaceExisting?: boolean;
      entryFile?: string;
    },
  ): Promise<{ bundle: AgentInstructionsBundle; adapterConfig: Record<string, unknown> }> {
    const rootPath = resolveManagedInstructionsRoot(agent);
    const entryFile = options?.entryFile ? normalizeRelativeFilePath(options.entryFile) : ENTRY_FILE_DEFAULT;

    if (options?.replaceExisting) {
      await repo.deleteAllForAgent(agent.id).catch((err) => {
        logger.error({ agentId: agent.id, err }, "Database write failure: failed to clear existing instruction files");
      });
    }

    const normalizedEntries = Object.entries(files).map(([relativePath, content]) => [
      normalizeRelativeFilePath(relativePath),
      content,
    ] as const);

    for (const [relativePath, content] of normalizedEntries) {
      await repo.upsert(agent.id, relativePath, content).catch((err) => {
        logger.error({ agentId: agent.id, filePath: relativePath, err }, "Database write failure: failed to write instruction file");
      });
    }

    if (!normalizedEntries.some(([relativePath]) => relativePath === entryFile)) {
      await repo.upsert(agent.id, entryFile, "").catch((err) => {
        logger.error({ agentId: agent.id, filePath: entryFile, err }, "Database write failure: failed to write entry instruction file");
      });
    }

    const adapterConfig = applyBundleConfig(asRecord(agent.adapterConfig), {
      mode: "managed",
      rootPath,
      entryFile,
      clearLegacyPromptTemplate: options?.clearLegacyPromptTemplate,
    });
    const bundle = await getBundle({ ...agent, adapterConfig });
    await fs.mkdir(rootPath, { recursive: true }).catch(() => {});
    for (const [relativePath, content] of normalizedEntries) {
      const absolutePath = resolvePathWithinRoot(rootPath, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true }).catch(() => {});
      await fs.writeFile(absolutePath, content, "utf8").catch(() => {});
    }
    if (!normalizedEntries.some(([relativePath]) => relativePath === entryFile)) {
      const entryAbsPath = resolvePathWithinRoot(rootPath, entryFile);
      await fs.mkdir(path.dirname(entryAbsPath), { recursive: true }).catch(() => {});
      await fs.writeFile(entryAbsPath, "", "utf8").catch(() => {});
    }

    return { bundle, adapterConfig };
  }

  return {
    getBundle,
    readFile,
    updateBundle,
    writeFile,
    deleteFile,
    exportFiles,
    ensureManagedBundle: ensureWritableBundle,
    materializeManagedBundle,
  };
}
