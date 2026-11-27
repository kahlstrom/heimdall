/**
 * Parse and validate heimdall.config.json at the repo boundary.
 * A bad config is always a GATE ERROR, never a red app failure.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlakeId } from './flakes.js';
import {
  COMMAND_STEP_NAMES,
  DEFAULT_MAX_CHANGED_FILES,
  DEFAULT_STEP_TIMEOUT_MS,
  SOURCE_FILE_EXT_RE,
  STEP_NAMES,
  err,
  errorMessage,
  isRecord,
  ok,
  type CommandStepConfig,
  type CommandStepName,
  type EslintStepConfig,
  type GateConfig,
  type LineChecksConfig,
  type Result,
  type StepName,
} from './types.js';

const TOP_LEVEL_KEYS = new Set([
  'baseRef',
  'requireParentBase',
  'maxChangedFiles',
  'steps',
  'flakes',
  'setup',
  'teardown',
  'protectedPaths',
]);
const STEP_KEYS = new Set<StepName>(STEP_NAMES);
const COMMAND_STEP_FIELD_KEYS = new Set(['enabled', 'command', 'timeoutMs']);
const ESLINT_STEP_FIELD_KEYS = new Set(['enabled', 'command', 'timeoutMs', 'maxWarnings']);
const LINE_CHECKS_FIELD_KEYS = new Set(['enabled', 'allowSilencing', 'commentPatterns']);

export const DEFAULT_CONFIG_NAME = 'heimdall.config.json';
export const LEGACY_CONFIG_NAME = 'gate.config.json';
export const CONFIG_DIR_ENV = 'HEIMDALL_CONFIG_DIR';
export const LEGACY_CONFIG_DIR_ENV = 'GATE_CONFIG_DIR';
export const HOME_ENV = 'HEIMDALL_HOME';
export const LEGACY_HOME_ENV = 'GATE_HOME';
export const ALLOW_CONFIG_CHANGE_ENV = 'HEIMDALL_ALLOW_CONFIG_CHANGE';
export const LEGACY_ALLOW_CONFIG_CHANGE_ENV = 'GATE_ALLOW_CONFIG_CHANGE';
export const ALLOW_WIDE_ENV = 'HEIMDALL_ALLOW_WIDE';
export const LEGACY_ALLOW_WIDE_ENV = 'GATE_ALLOW_WIDE';
export const TMP_ENV = 'HEIMDALL_TMP';
export const LEGACY_TMP_ENV = 'GATE_TMP';
export const DEPRECATED_CONFIG_WARNING =
  'gate.config.json is deprecated; rename to heimdall.config.json';

const DEFAULT_HOME_DIR = '.heimdall';
const LEGACY_HOME_DIR = '.gate';
const CONFIG_FILE_NAMES = [DEFAULT_CONFIG_NAME, LEGACY_CONFIG_NAME] as const;

/**
 * In-repo `configs/` next to the CLI install (`dist/` or `src/`), never cwd.
 * `src/config.ts` and `dist/config.js` both sit one directory below the package root.
 */
export function packageConfigsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'configs');
}

/** `~/.heimdall` tried after `$HEIMDALL_HOME` (which defaults to this package's `configs/`). */
export function heimdallFallbackHome(): string {
  return path.join(os.homedir(), DEFAULT_HOME_DIR);
}

/** `~/.gate` kept as a compatibility fallback after `~/.heimdall`. */
export function compatibilityGateHome(): string {
  return path.join(os.homedir(), LEGACY_HOME_DIR);
}

function trimmedEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (typeof raw === 'string' && raw.trim() !== '') {
    return raw;
  }
  return undefined;
}

/**
 * `$HEIMDALL_HOME`, else deprecated `$GATE_HOME`, else this package's `configs/`
 * folder. Resolved so a relative override is not cwd-dependent later in the lookup.
 */
function resolveHeimdallHome(env: NodeJS.ProcessEnv): string {
  const raw = trimmedEnv(env, HOME_ENV) ?? trimmedEnv(env, LEGACY_HOME_ENV);
  if (raw !== undefined) {
    return path.resolve(raw);
  }
  return packageConfigsDir();
}

export function envFlag(env: NodeJS.ProcessEnv, primary: string, legacy: string): boolean {
  return env[primary] === '1' || env[legacy] === '1';
}

export function isLegacyConfigPath(configPath: string): boolean {
  return path.basename(configPath) === LEGACY_CONFIG_NAME;
}

/**
 * One-line warnings when a deprecated GATE_* env var is set and the HEIMDALL_*
 * replacement is not. GATE_CONFIG_DIR / GATE_TMP are injected by the runner
 * as aliases, so they are not warned here.
 */
export function deprecatedEnvWarnings(env: NodeJS.ProcessEnv): readonly string[] {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    [HOME_ENV, LEGACY_HOME_ENV],
    [ALLOW_CONFIG_CHANGE_ENV, LEGACY_ALLOW_CONFIG_CHANGE_ENV],
    [ALLOW_WIDE_ENV, LEGACY_ALLOW_WIDE_ENV],
  ];
  const warnings: string[] = [];
  for (const [primary, legacy] of pairs) {
    if (trimmedEnv(env, legacy) !== undefined && trimmedEnv(env, primary) === undefined) {
      warnings.push(`${legacy} is deprecated; use ${primary}`);
    }
  }
  return warnings;
}

/**
 * `existsSync` is case-insensitive on macOS, so `$HEIMDALL_HOME/MyApp` would match
 * a folder stored as `my-app` and skip the documented lowercase fallback.
 * Directory listings keep the name as it was created.
 */
function hasExactEntry(parent: string, name: string): boolean {
  try {
    return fs.readdirSync(parent).includes(name);
  } catch {
    return false;
  }
}

function homeConfigExists(home: string, folderName: string, fileName: string): boolean {
  if (!hasExactEntry(home, folderName)) {
    return false;
  }
  try {
    return fs.statSync(path.join(home, folderName, fileName)).isFile();
  } catch {
    return false;
  }
}

type ConfigCandidate = {
  readonly path: string;
  exists(): boolean;
};

function pushCandidate(candidates: ConfigCandidate[], candidate: ConfigCandidate): void {
  if (candidates.some((existing) => existing.path === candidate.path)) {
    return;
  }
  candidates.push(candidate);
}

function pushHomeCandidates(
  candidates: ConfigCandidate[],
  home: string,
  folderName: string,
): void {
  for (const fileName of CONFIG_FILE_NAMES) {
    const filePath = path.join(home, folderName, fileName);
    pushCandidate(candidates, {
      path: filePath,
      exists: () => homeConfigExists(home, folderName, fileName),
    });
  }
}

function addNamedHomeCandidates(
  candidates: ConfigCandidate[],
  home: string,
  name: string,
): void {
  pushHomeCandidates(candidates, home, name);
  const lowerName = name.toLowerCase();
  if (lowerName !== name) {
    pushHomeCandidates(candidates, home, lowerName);
  }
}

function addHomeIfDistinct(
  candidates: ConfigCandidate[],
  home: string,
  already: readonly string[],
  name: string,
): void {
  const resolved = path.resolve(home);
  if (already.some((entry) => path.resolve(entry) === resolved)) {
    return;
  }
  addNamedHomeCandidates(candidates, home, name);
}

/**
 * In-repo files at the git root, in order: `heimdall.config.json`, then
 * deprecated `gate.config.json`.
 */
function inRepoConfigCandidates(gitRoot: string): readonly ConfigCandidate[] {
  const candidates: ConfigCandidate[] = [];
  for (const fileName of CONFIG_FILE_NAMES) {
    const filePath = path.join(gitRoot, fileName);
    pushCandidate(candidates, { path: filePath, exists: () => fs.existsSync(filePath) });
  }
  return candidates;
}

/**
 * Appends home-config paths onto `candidates`, skipping paths already present
 * (`$HEIMDALL_HOME/<name>` can be the git root itself). Home lookup uses one
 * repo name from the git common dir, then lowercased when that differs
 * (`~/Projects/MyApp` finds `$HEIMDALL_HOME/myapp`). The work-tree folder
 * basename is not a separate candidate. `$HEIMDALL_HOME` defaults to this
 * package's `configs/` (from the CLI install location). `~/.heimdall/<name>/`
 * is then tried, then `~/.gate/<name>/` for compatibility. A config outside the
 * git root is not in the story diff, so the in-repo config-change guard ignores
 * it; uncommitted files in that config directory are a separate RED check.
 */
function homeConfigCandidates(
  candidates: ConfigCandidate[],
  lookupName: string,
  env: NodeJS.ProcessEnv,
): void {
  const home = resolveHeimdallHome(env);
  const heimdallHome = heimdallFallbackHome();
  const compatHome = compatibilityGateHome();
  addNamedHomeCandidates(candidates, home, lookupName);
  addHomeIfDistinct(candidates, heimdallHome, [home], lookupName);
  addHomeIfDistinct(candidates, compatHome, [home, heimdallHome], lookupName);
}

function missingConfigError(tried: readonly string[]): string {
  return `no heimdall.config.json found. Tried:\n${tried.map((candidate) => `  ${candidate}`).join('\n')}`;
}

/**
 * Flakes identify one test as `file > full title`. A bare path is a whole-file
 * ignore; a bare title would match the same leaf in every suite and file.
 */
export function flakeLooksLikeFile(name: string): boolean {
  if (name.includes('/') || name.includes('\\')) {
    return true;
  }
  return SOURCE_FILE_EXT_RE.test(name);
}

function flakeEntryError(index: number, name: string): string | undefined {
  const parsed = parseFlakeId(name);
  if (!parsed) {
    if (flakeLooksLikeFile(name)) {
      return `flakes[${index}] must identify a test by file plus full title, not a whole file (got ${JSON.stringify(name)})`;
    }
    return `flakes[${index}] must identify a test by file plus full title (got ${JSON.stringify(name)})`;
  }
  if (!flakeLooksLikeFile(parsed.file)) {
    return `flakes[${index}] must identify a test by file plus full title (got ${JSON.stringify(name)})`;
  }
  return undefined;
}

function unknownKeysMessage(pathPrefix: string, keys: string[], allowed: Set<string>): string | undefined {
  const extra = keys.filter((key) => !allowed.has(key));
  if (extra.length === 0) {
    return undefined;
  }
  const where = pathPrefix || 'config';
  return `${where}: unknown key(s) ${extra.map((key) => JSON.stringify(key)).join(', ')}`;
}

function parseStringArray(value: unknown, pathPrefix: string): Result<readonly string[]> {
  if (value === undefined) {
    return ok([]);
  }
  if (!Array.isArray(value)) {
    return err(`${pathPrefix} must be an array of strings`);
  }
  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== 'string' || item.trim() === '') {
      return err(`${pathPrefix}[${index}] must be a non-empty string`);
    }
    items.push(item);
  }
  return ok(items);
}

function parseTimeoutMs(value: unknown, pathPrefix: string): Result<number> {
  if (value === undefined) {
    return ok(DEFAULT_STEP_TIMEOUT_MS);
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return err(`${pathPrefix} must be a positive integer`);
  }
  return ok(value);
}

function parseMaxWarnings(value: unknown): Result<number> {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return err('steps.eslint.maxWarnings must be a non-negative integer');
  }
  return ok(value);
}

function parseMaxChangedFiles(value: unknown): Result<number> {
  if (value === undefined) {
    return ok(DEFAULT_MAX_CHANGED_FILES);
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return err('maxChangedFiles must be a positive integer');
  }
  return ok(value);
}

function parseCommandStep(
  value: unknown,
  stepName: CommandStepName,
  allowedKeys: Set<string> = COMMAND_STEP_FIELD_KEYS,
): Result<CommandStepConfig | undefined> {
  if (value === undefined) {
    return ok(undefined);
  }
  if (!isRecord(value)) {
    return err(`steps.${stepName} must be an object`);
  }
  const extra = unknownKeysMessage(`steps.${stepName}`, Object.keys(value), allowedKeys);
  if (extra) {
    return err(extra);
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    return err(`steps.${stepName}.enabled must be a boolean`);
  }
  const timeoutMs = parseTimeoutMs(value.timeoutMs, `steps.${stepName}.timeoutMs`);
  if (!timeoutMs.ok) {
    return timeoutMs;
  }
  const enabled = value.enabled !== false;
  if (!enabled) {
    if (value.command !== undefined && typeof value.command !== 'string') {
      return err(`steps.${stepName}.command must be a string`);
    }
    return ok({
      enabled: false,
      command: typeof value.command === 'string' ? value.command : '',
      timeoutMs: timeoutMs.value,
    });
  }
  if (typeof value.command !== 'string' || value.command.trim() === '') {
    return err(`steps.${stepName}.command must be a non-empty string when the step is enabled`);
  }
  return ok({ enabled: true, command: value.command, timeoutMs: timeoutMs.value });
}

function parseEslintStep(value: unknown): Result<EslintStepConfig | undefined> {
  const base = parseCommandStep(value, 'eslint', ESLINT_STEP_FIELD_KEYS);
  if (!base.ok) {
    return base;
  }
  if (base.value === undefined) {
    return ok(undefined);
  }
  if (!isRecord(value) || value.maxWarnings === undefined) {
    return ok({ ...base.value, maxWarnings: undefined });
  }
  const maxWarnings = parseMaxWarnings(value.maxWarnings);
  if (!maxWarnings.ok) {
    return maxWarnings;
  }
  return ok({ ...base.value, maxWarnings: maxWarnings.value });
}

function parseRegexArray(value: unknown, pathPrefix: string): Result<readonly RegExp[]> {
  const patterns = parseStringArray(value, pathPrefix);
  if (!patterns.ok) {
    return patterns;
  }
  const compiled: RegExp[] = [];
  for (let index = 0; index < patterns.value.length; index += 1) {
    const source = patterns.value[index];
    if (source === undefined) {
      continue;
    }
    try {
      compiled.push(new RegExp(source));
    } catch (cause) {
      return err(`${pathPrefix}[${index}] is not a valid regex: ${errorMessage(cause)}`);
    }
  }
  return ok(compiled);
}

function defaultLineChecksConfig(enabled: boolean): LineChecksConfig {
  return {
    enabled,
    allowSilencing: [],
    commentPatterns: [],
  };
}

function parseLineChecks(value: unknown): Result<LineChecksConfig | undefined> {
  if (value === undefined) {
    return ok(undefined);
  }
  if (value === true) {
    return ok(defaultLineChecksConfig(true));
  }
  if (value === false) {
    return ok(defaultLineChecksConfig(false));
  }
  if (!isRecord(value)) {
    return err('steps.line-checks must be an object or boolean');
  }
  const extra = unknownKeysMessage('steps.line-checks', Object.keys(value), LINE_CHECKS_FIELD_KEYS);
  if (extra) {
    return err(extra);
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    return err('steps.line-checks.enabled must be a boolean');
  }
  const allowSilencing = parseStringArray(value.allowSilencing, 'steps.line-checks.allowSilencing');
  if (!allowSilencing.ok) {
    return allowSilencing;
  }
  const commentPatterns = parseRegexArray(value.commentPatterns, 'steps.line-checks.commentPatterns');
  if (!commentPatterns.ok) {
    return commentPatterns;
  }
  return ok({
    enabled: value.enabled !== false,
    allowSilencing: allowSilencing.value,
    commentPatterns: commentPatterns.value,
  });
}

/**
 * Turn unknown JSON into a GateConfig or a precise GATE ERROR reason.
 */
export function parseGateConfig(raw: unknown, configPath: string): Result<GateConfig> {
  if (!isRecord(raw)) {
    return err('heimdall config must be a JSON object');
  }
  const extra = unknownKeysMessage('', Object.keys(raw), TOP_LEVEL_KEYS);
  if (extra) {
    return err(extra);
  }
  if (raw.baseRef !== undefined && (typeof raw.baseRef !== 'string' || raw.baseRef.trim() === '')) {
    return err('baseRef must be a non-empty string when set');
  }
  if (raw.requireParentBase !== undefined && typeof raw.requireParentBase !== 'boolean') {
    return err('requireParentBase must be a boolean');
  }
  const maxChangedFiles = parseMaxChangedFiles(raw.maxChangedFiles);
  if (!maxChangedFiles.ok) {
    return maxChangedFiles;
  }
  let stepsRaw: Record<string, unknown>;
  if (raw.steps === undefined) {
    stepsRaw = {};
  } else if (!isRecord(raw.steps)) {
    return err('steps must be an object');
  } else {
    stepsRaw = raw.steps;
  }
  const stepExtra = unknownKeysMessage('steps', Object.keys(stepsRaw), STEP_KEYS);
  if (stepExtra) {
    return err(stepExtra);
  }

  const commandSteps: {
    typecheck: CommandStepConfig | undefined;
    tests: CommandStepConfig | undefined;
    eslint: EslintStepConfig | undefined;
    knip: CommandStepConfig | undefined;
    jscpd: CommandStepConfig | undefined;
    secrets: CommandStepConfig | undefined;
    architecture: CommandStepConfig | undefined;
  } = {
    typecheck: undefined,
    tests: undefined,
    eslint: undefined,
    knip: undefined,
    jscpd: undefined,
    secrets: undefined,
    architecture: undefined,
  };

  for (const name of COMMAND_STEP_NAMES) {
    if (name === 'eslint') {
      const parsed = parseEslintStep(stepsRaw.eslint);
      if (!parsed.ok) {
        return parsed;
      }
      commandSteps.eslint = parsed.value;
      continue;
    }
    const parsed = parseCommandStep(stepsRaw[name], name);
    if (!parsed.ok) {
      return parsed;
    }
    commandSteps[name] = parsed.value;
  }
  const lineChecks = parseLineChecks(stepsRaw['line-checks']);
  if (!lineChecks.ok) {
    return lineChecks;
  }

  const flakes = parseStringArray(raw.flakes, 'flakes');
  if (!flakes.ok) {
    return flakes;
  }
  for (let index = 0; index < flakes.value.length; index += 1) {
    const name = flakes.value[index];
    if (name === undefined) {
      continue;
    }
    const flakeError = flakeEntryError(index, name);
    if (flakeError) {
      return err(flakeError);
    }
  }

  const setup = parseStringArray(raw.setup, 'setup');
  if (!setup.ok) {
    return setup;
  }
  const teardown = parseStringArray(raw.teardown, 'teardown');
  if (!teardown.ok) {
    return teardown;
  }
  const protectedPaths = parseStringArray(raw.protectedPaths, 'protectedPaths');
  if (!protectedPaths.ok) {
    return protectedPaths;
  }

  const enabledCount =
    COMMAND_STEP_NAMES.filter((name) => commandSteps[name]?.enabled).length +
    (lineChecks.value?.enabled ? 1 : 0);
  if (enabledCount === 0) {
    return err('at least one step must be enabled');
  }

  return ok({
    configPath,
    baseRef: typeof raw.baseRef === 'string' ? raw.baseRef.trim() : undefined,
    requireParentBase: raw.requireParentBase === true,
    maxChangedFiles: maxChangedFiles.value,
    steps: {
      ...commandSteps,
      'line-checks': lineChecks.value,
    },
    flakes: flakes.value,
    setup: setup.value,
    teardown: teardown.value,
    protectedPaths: protectedPaths.value,
  });
}

export function loadGateConfigFile(configPath: string): Result<GateConfig> {
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (cause) {
    return err(`cannot read ${configPath}: ${errorMessage(cause)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    return err(`${configPath} is not valid JSON: ${errorMessage(cause)}`);
  }
  return parseGateConfig(raw, configPath);
}

/**
 * First existing path from the documented lookup order. A package-level file
 * in a subdirectory is ignored so it cannot silently drive root-cwd commands.
 * `--config` is exclusive: `lookupName` is not called, and the git root and
 * `$HEIMDALL_HOME` are not consulted. An in-repo config is returned without
 * calling `lookupName`. Missing means GATE ERROR listing every path that was
 * tried, each once, in order. `gate.config.json` is accepted as a deprecated
 * fallback after `heimdall.config.json`.
 */
export function resolveConfigPath(
  cwd: string,
  gitRoot: string,
  lookupName: () => Result<string>,
  explicitPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): Result<string> {
  if (explicitPath) {
    const filePath = path.resolve(cwd, explicitPath);
    if (fs.existsSync(filePath)) {
      return ok(filePath);
    }
    return err(missingConfigError([filePath]));
  }
  const candidates = [...inRepoConfigCandidates(gitRoot)];
  for (const candidate of candidates) {
    if (candidate.exists()) {
      return ok(candidate.path);
    }
  }
  const name = lookupName();
  if (!name.ok) {
    return name;
  }
  const inRepoCount = candidates.length;
  homeConfigCandidates(candidates, name.value, env);
  for (const candidate of candidates.slice(inRepoCount)) {
    if (candidate.exists()) {
      return ok(candidate.path);
    }
  }
  return err(missingConfigError(candidates.map((candidate) => candidate.path)));
}
