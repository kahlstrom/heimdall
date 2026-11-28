/**
 * Orchestrate setup, enabled steps, teardown, and the final outcome.
 * Unexpected throws become GATE ERROR so the gate never dies without a verdict.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parentBaseError, wideDiffDecision } from './base-guard.js';
import {
  classifyCommandFailure,
  gateInterruptReason,
  runCommand as defaultRunCommand,
  type RunCommandFn,
} from './command.js';
import {
  ALLOW_CONFIG_CHANGE_ENV,
  ALLOW_WIDE_ENV,
  CONFIG_DIR_ENV,
  DEPRECATED_CONFIG_WARNING,
  LEGACY_ALLOW_CONFIG_CHANGE_ENV,
  LEGACY_ALLOW_WIDE_ENV,
  LEGACY_CONFIG_DIR_ENV,
  LEGACY_TMP_ENV,
  TMP_ENV,
  deprecatedEnvWarnings,
  envFlag,
  isLegacyConfigPath,
  loadGateConfigFile,
  resolveConfigPath,
} from './config.js';
import { configFileInDiff, loadDiffScope, toRepoPath } from './diff.js';
import { matchesAnyGlob } from './glob.js';
import {
  currentBranchName,
  enclosingGitRoot,
  gitConfigLookupName,
  gitHeadSha,
  gitRepoRoot,
  hasConfiguredUpstream,
  listUncommittedPaths,
  resolveBaseRef,
  type ResolvedBaseRef,
} from './git.js';
import { emptyDiffWarning, formatRunPrelude, unversionedConfigWarning } from './report.js';
import { STEPS, type StepContext } from './steps.js';
import {
  DEFAULT_STEP_TIMEOUT_MS,
  EXIT_GATE_ERROR,
  EXIT_GREEN,
  EXIT_RED,
  NODE_HEAP_MB_ENV,
  addedLineCount,
  err,
  errorMessage,
  ok,
  type DiffScope,
  type Finding,
  type GateConfig,
  type GateOutcome,
  type NodeHeap,
  type Result,
  type StepResult,
} from './types.js';

export type RunGateOptions = {
  readonly cwd: string;
  readonly configPath?: string;
  readonly runCommand?: RunCommandFn;
  readonly abortSignal?: AbortSignal;
  /** CLI `--allow-wide`: skip the maxChangedFiles GATE ERROR. */
  readonly allowWide?: boolean;
  /** CLI `--base`: comparison base, wins over config `baseRef`. */
  readonly baseRef?: string;
  /** CLI `--node-heap`: positive integer in MB, wins over `HEIMDALL_NODE_HEAP_MB`. */
  readonly nodeHeapMb?: number;
  /** Start-of-run lines. The CLI writes these to stdout before steps run. */
  readonly log?: (text: string) => void;
};

const MAX_OLD_SPACE_SIZE_FLAG_RE = /^--max[-_]old[-_]space[-_]size(?:=(.*))?$/;

type ExistingNodeHeap = {
  readonly mb?: number;
};

type ResolvedNodeHeap = {
  readonly state: NodeHeap;
  readonly nodeOptions: string | undefined;
  readonly warning: string | undefined;
};

export function parseNodeHeapMb(raw: string, source: string): Result<number> {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return err(`${source} must be a positive integer (MB)`);
  }
  if (!/^\d+$/.test(trimmed)) {
    return err(`${source} must be a positive integer (MB), got ${JSON.stringify(raw)}`);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return err(`${source} must be a positive integer (MB), got ${JSON.stringify(raw)}`);
  }
  return ok(value);
}

function tokenizeNodeOptions(raw: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let inQuotes = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === undefined) {
      continue;
    }
    if (inQuotes && ch === '\\' && i + 1 < raw.length && (raw[i + 1] === '"' || raw[i + 1] === '\\')) {
      current += raw[i + 1];
      i += 1;
      inToken = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      inToken = true;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (inToken) {
    tokens.push(current);
  }
  return tokens;
}

function findExistingMaxOldSpaceSize(nodeOptions: string | undefined): ExistingNodeHeap | undefined {
  if (nodeOptions === undefined || nodeOptions.trim() === '') {
    return undefined;
  }
  const tokens = tokenizeNodeOptions(nodeOptions);
  let found: ExistingNodeHeap | undefined;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) {
      continue;
    }
    const match = MAX_OLD_SPACE_SIZE_FLAG_RE.exec(token);
    if (!match) {
      continue;
    }
    let rawValue = match[1];
    if (rawValue === undefined) {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        rawValue = next;
        i += 1;
      }
    }
    const parsed = rawValue !== undefined ? parseNodeHeapMb(rawValue, 'NODE_OPTIONS') : undefined;
    found = parsed?.ok ? { mb: parsed.value } : {};
  }
  return found;
}

function resolveNodeHeap(cliNodeHeapMb: number | undefined, env: NodeJS.ProcessEnv): Result<ResolvedNodeHeap> {
  let requested: { readonly mb: number; readonly source: 'cli' | 'env' } | undefined;
  if (cliNodeHeapMb !== undefined) {
    if (!Number.isSafeInteger(cliNodeHeapMb) || cliNodeHeapMb <= 0) {
      return err(`--node-heap must be a positive integer (MB), got ${String(cliNodeHeapMb)}`);
    }
    requested = { mb: cliNodeHeapMb, source: 'cli' };
  } else if (env[NODE_HEAP_MB_ENV] !== undefined) {
    const parsed = parseNodeHeapMb(env[NODE_HEAP_MB_ENV], NODE_HEAP_MB_ENV);
    if (!parsed.ok) {
      return parsed;
    }
    requested = { mb: parsed.value, source: 'env' };
  }

  const existing = findExistingMaxOldSpaceSize(env.NODE_OPTIONS);
  if (existing !== undefined) {
    const state: NodeHeap =
      existing.mb !== undefined ? { kind: 'node-options', mb: existing.mb } : { kind: 'node-options' };
    const ignored =
      requested === undefined
        ? undefined
        : requested.source === 'cli'
          ? `--node-heap ${requested.mb}`
          : `${NODE_HEAP_MB_ENV}=${requested.mb}`;
    const warning =
      ignored !== undefined
        ? `NODE_OPTIONS already sets --max-old-space-size; leaving it unchanged (ignoring ${ignored})`
        : undefined;
    return ok({ state, nodeOptions: undefined, warning });
  }

  if (requested === undefined) {
    return ok({ state: { kind: 'default' }, nodeOptions: undefined, warning: undefined });
  }

  const current = env.NODE_OPTIONS?.trim() ?? '';
  const flag = `--max-old-space-size=${requested.mb}`;
  const nodeOptions = current === '' ? flag : `${current} ${flag}`;
  return ok({
    state: { kind: 'configured', mb: requested.mb, source: requested.source },
    nodeOptions,
    warning: undefined,
  });
}

async function runShellList(
  commands: readonly string[],
  label: 'setup' | 'teardown',
  cwd: string,
  env: NodeJS.ProcessEnv,
  runCommand: RunCommandFn,
  abortSignal: AbortSignal | undefined,
): Promise<StepResult | undefined> {
  for (const [index, command] of commands.entries()) {
    const result = await runCommand(command, cwd, env, {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      ...(abortSignal !== undefined ? { signal: abortSignal } : {}),
    });
    const crash = classifyCommandFailure(
      label,
      command,
      result,
      DEFAULT_STEP_TIMEOUT_MS,
      abortSignal,
      `${label}[${index}] ${JSON.stringify(command)}`,
    );
    if (crash) {
      return { kind: 'error', name: label, reason: crash };
    }
    if (result.exitCode !== 0) {
      return {
        kind: 'error',
        name: label,
        reason: `${label} command ${JSON.stringify(command)} exited ${result.exitCode ?? 'null'}`,
      };
    }
  }
  return undefined;
}

function gateError(
  reason: string,
  baseRef: string | undefined,
  steps: readonly StepResult[] = [],
  mergeBaseSha?: string,
  warnings: readonly string[] = [],
  scope?: DiffScope,
  baseSha?: string,
  headSha?: string,
): GateOutcome {
  const outcome: GateOutcome = {
    kind: 'error',
    exitCode: EXIT_GATE_ERROR,
    reason,
    baseRef,
    mergeBaseSha,
    headSha,
    warnings,
    steps,
  };
  return withScope(outcome, scope, baseSha);
}

function withScope(outcome: GateOutcome, scope: DiffScope | undefined, baseSha: string | undefined): GateOutcome {
  if (!scope && !baseSha) {
    return outcome;
  }
  return {
    ...outcome,
    ...(baseSha !== undefined ? { baseSha } : {}),
    ...(scope !== undefined
      ? { changedFileCount: scope.changedFiles.size, addedLineCount: addedLineCount(scope) }
      : {}),
  };
}

function withConfigPath(outcome: GateOutcome, configPath: string, configCommit?: string): GateOutcome {
  if (configCommit === undefined) {
    return { ...outcome, configPath };
  }
  return { ...outcome, configPath, configCommit };
}

function outcomeFromSteps(
  base: ResolvedBaseRef,
  steps: readonly StepResult[],
  warnings: readonly string[],
  scope: DiffScope,
  configPath: string,
  configCommit?: string,
): GateOutcome {
  const error = steps.find((step) => step.kind === 'error');
  if (error && error.kind === 'error') {
    return withConfigPath(
      gateError(error.reason, base.spec, steps, base.mergeBaseSha, warnings, scope, base.sha, base.headSha),
      configPath,
      configCommit,
    );
  }
  const findings: Finding[] = [];
  for (const step of steps) {
    if (step.kind === 'fail') {
      findings.push(...step.findings);
    }
  }
  if (findings.length > 0) {
    return withConfigPath(
      withScope(
        {
          kind: 'red',
          exitCode: EXIT_RED,
          baseRef: base.spec,
          mergeBaseSha: base.mergeBaseSha,
          headSha: base.headSha,
          warnings,
          steps,
        },
        scope,
        base.sha,
      ),
      configPath,
      configCommit,
    );
  }
  return withConfigPath(
    withScope(
      {
        kind: 'green',
        exitCode: EXIT_GREEN,
        baseRef: base.spec,
        mergeBaseSha: base.mergeBaseSha,
        headSha: base.headSha,
        warnings,
        steps,
      },
      scope,
      base.sha,
    ),
    configPath,
    configCommit,
  );
}

function configChangeFinding(
  config: GateConfig,
  scope: DiffScope,
  repoRoot: string,
  env: NodeJS.ProcessEnv,
): Finding | undefined {
  if (envFlag(env, ALLOW_CONFIG_CHANGE_ENV, LEGACY_ALLOW_CONFIG_CHANGE_ENV)) {
    return undefined;
  }
  const changed = configFileInDiff(scope, config.configPath, repoRoot);
  if (!changed) {
    return undefined;
  }
  return {
    step: 'config',
    file: changed,
    line: 0,
    rule: 'config-change',
    message:
      `this story changes ${changed}; an agent cannot loosen Heimdall. ` +
      `Revert the change or set ${ALLOW_CONFIG_CHANGE_ENV}=1 if a human is editing the config on purpose.`,
  };
}

type ExternalConfigLock = {
  readonly warnings: readonly string[];
  readonly commitSha: string | undefined;
  readonly findings: readonly Finding[];
};

function configUncommittedFinding(file: string): Finding {
  return {
    step: 'config',
    file,
    line: 0,
    rule: 'config-uncommitted',
    message: 'commit this config change first',
  };
}

/**
 * When the resolved config lives outside the target repo, require that its
 * directory is committed if it sits in a git work tree. A loose directory
 * such as `~/.heimdall` only warns. `HEIMDALL_ALLOW_CONFIG_CHANGE=1` skips the RED
 * findings, same as the in-repo config-change guard. `GATE_ALLOW_CONFIG_CHANGE=1`
 * is still honoured as a deprecated alias.
 */
function lockExternalConfig(
  configPath: string,
  repoRoot: string,
  env: NodeJS.ProcessEnv,
): Result<ExternalConfigLock> {
  if (toRepoPath(configPath, repoRoot) !== undefined) {
    return ok({ warnings: [], commitSha: undefined, findings: [] });
  }
  const configDir = path.dirname(configPath);
  const rooted = enclosingGitRoot(configDir);
  if (!rooted.ok) {
    return err(rooted.error);
  }
  if (rooted.value === undefined) {
    return ok({
      warnings: [unversionedConfigWarning(configDir)],
      commitSha: undefined,
      findings: [],
    });
  }
  const configGitRoot = rooted.value;
  const head = gitHeadSha(configGitRoot);
  const commitSha = head.ok ? head.value : undefined;
  if (envFlag(env, ALLOW_CONFIG_CHANGE_ENV, LEGACY_ALLOW_CONFIG_CHANGE_ENV)) {
    return ok({ warnings: [], commitSha, findings: [] });
  }
  const relDir = toRepoPath(configDir, configGitRoot);
  if (relDir === undefined) {
    return err(`config directory ${configDir} is not inside git root ${configGitRoot}`);
  }
  const dirty = listUncommittedPaths(configGitRoot, relDir);
  if (!dirty.ok) {
    return err(`failed to check config directory ${configDir}: ${dirty.error}`);
  }
  return ok({
    warnings: [],
    commitSha,
    findings: dirty.value.map((file) => configUncommittedFinding(file)),
  });
}

function protectedPathFindings(config: GateConfig, scope: DiffScope): Finding[] {
  if (config.protectedPaths.length === 0) {
    return [];
  }
  const hits: Finding[] = [];
  for (const filePath of scope.changedFiles) {
    if (!matchesAnyGlob(filePath, config.protectedPaths)) {
      continue;
    }
    hits.push({
      step: 'protected-path',
      file: filePath,
      line: 0,
      rule: 'protected-path',
      message: 'this path is off-limits',
    });
  }
  return hits;
}

function withSyntheticSteps(steps: readonly StepResult[], findings: readonly Finding[]): StepResult[] {
  if (findings.length === 0) {
    return [...steps];
  }
  const extra: StepResult[] = [];
  const configHits = findings.filter((finding) => finding.step === 'config');
  const protectedHits = findings.filter((finding) => finding.step === 'protected-path');
  if (configHits.length > 0) {
    extra.push({ kind: 'fail', name: 'config', findings: configHits });
  }
  if (protectedHits.length > 0) {
    extra.push({ kind: 'fail', name: 'protected-path', findings: protectedHits });
  }
  return [...extra, ...steps];
}

type HeadSnapshot = {
  readonly sha: string;
  readonly branch: string;
};

function headChangeReason(start: HeadSnapshot, repoRoot: string): string | undefined {
  const endHead = gitHeadSha(repoRoot);
  if (!endHead.ok) {
    return `cannot re-read HEAD after run (started at ${start.sha}): ${endHead.error}; rerun heimdall`;
  }
  const endBranch = currentBranchName(repoRoot);
  const branchMoved = start.branch !== '' && endBranch !== '' && endBranch !== start.branch;
  if (endHead.value !== start.sha) {
    const branchNote = branchMoved ? ` (branch ${start.branch} -> ${endBranch})` : '';
    return `the repo's HEAD moved from ${start.sha} to ${endHead.value}${branchNote} during this run (another process changed the checkout); rerun heimdall`;
  }
  if (branchMoved) {
    return `the repo's HEAD branch moved from ${start.branch} to ${endBranch} during this run (another process changed the checkout); rerun heimdall`;
  }
  return undefined;
}

export async function runGate(options: RunGateOptions): Promise<GateOutcome> {
  const processEnv = process.env;
  const resolvedHeap = resolveNodeHeap(options.nodeHeapMb, processEnv);
  if (!resolvedHeap.ok) {
    return gateError(resolvedHeap.error, undefined);
  }
  const outcome = await runGateWithHeap(options, processEnv, resolvedHeap.value);
  return { ...outcome, nodeHeap: resolvedHeap.value.state };
}

async function runGateWithHeap(
  options: RunGateOptions,
  processEnv: NodeJS.ProcessEnv,
  nodeHeap: ResolvedNodeHeap,
): Promise<GateOutcome> {
  const runCommand = options.runCommand ?? defaultRunCommand;
  const abortSignal = options.abortSignal;
  const heapWarnings: readonly string[] = nodeHeap.warning !== undefined ? [nodeHeap.warning] : [];
  const started = gitRepoRoot(options.cwd);
  if (!started.ok) {
    return gateError(started.error, undefined, [], undefined, heapWarnings);
  }
  const repoRoot = started.value;
  const lookedUp = resolveConfigPath(
    options.cwd,
    repoRoot,
    () => gitConfigLookupName(repoRoot),
    options.configPath,
    processEnv,
  );
  if (!lookedUp.ok) {
    return gateError(lookedUp.error, undefined, [], undefined, heapWarnings);
  }
  const configPath = lookedUp.value;
  const initialWarnings: string[] = [...deprecatedEnvWarnings(processEnv), ...heapWarnings];
  if (isLegacyConfigPath(configPath)) {
    initialWarnings.push(DEPRECATED_CONFIG_WARNING);
  }
  const loaded = loadGateConfigFile(configPath);
  if (!loaded.ok) {
    return withConfigPath(gateError(loaded.error, undefined, [], undefined, initialWarnings), configPath);
  }
  const config = loaded.value;

  const base = resolveBaseRef(repoRoot, config.baseRef, options.baseRef);
  if (!base.ok) {
    return withConfigPath(
      gateError(base.error, options.baseRef ?? config.baseRef, [], undefined, initialWarnings),
      configPath,
    );
  }
  const startHead: HeadSnapshot = {
    sha: base.value.headSha,
    branch: currentBranchName(repoRoot),
  };

  const scope = loadDiffScope(repoRoot, base.value);
  if (!scope.ok) {
    return withConfigPath(
      gateError(
        scope.error,
        base.value.spec,
        [],
        base.value.mergeBaseSha,
        initialWarnings,
        undefined,
        undefined,
        base.value.headSha,
      ),
      configPath,
    );
  }

  const log = options.log ?? (() => undefined);
  log(formatRunPrelude(base.value.spec, base.value.mergeBaseSha, scope.value.changedFiles.size, base.value.source));

  const parentError = parentBaseError({
    requireParentBase: config.requireParentBase,
    configuredBaseRef: options.baseRef ?? config.baseRef,
    resolvedSpec: base.value.spec,
    hasUpstream: hasConfiguredUpstream(repoRoot),
  });
  if (parentError) {
    return withConfigPath(
      gateError(
        parentError,
        base.value.spec,
        [],
        base.value.mergeBaseSha,
        initialWarnings,
        scope.value,
        base.value.sha,
        base.value.headSha,
      ),
      configPath,
    );
  }

  const warnings: string[] = [...initialWarnings];
  const wide = wideDiffDecision({
    changedFileCount: scope.value.changedFiles.size,
    maxChangedFiles: config.maxChangedFiles,
    baseRef: base.value.spec,
    allowWide: options.allowWide === true || envFlag(processEnv, ALLOW_WIDE_ENV, LEGACY_ALLOW_WIDE_ENV),
  });
  if (wide.kind === 'error') {
    return withConfigPath(
      gateError(
        wide.reason,
        base.value.spec,
        [],
        base.value.mergeBaseSha,
        warnings,
        scope.value,
        base.value.sha,
        base.value.headSha,
      ),
      configPath,
    );
  }
  if (wide.kind === 'warn') {
    log(`WARNING: ${wide.warning}\n`);
    warnings.push(wide.warning);
  }
  if (scope.value.changedFiles.size === 0) {
    warnings.push(emptyDiffWarning(base.value.spec, base.value.mergeBaseSha));
  }
  const syntheticFindings: Finding[] = [];
  const configFinding = configChangeFinding(config, scope.value, repoRoot, processEnv);
  if (configFinding) {
    syntheticFindings.push(configFinding);
  }
  const locked = lockExternalConfig(configPath, repoRoot, processEnv);
  if (!locked.ok) {
    return withConfigPath(
      gateError(
        locked.error,
        base.value.spec,
        [],
        base.value.mergeBaseSha,
        warnings,
        scope.value,
        base.value.sha,
        base.value.headSha,
      ),
      configPath,
    );
  }
  warnings.push(...locked.value.warnings);
  syntheticFindings.push(...locked.value.findings);
  syntheticFindings.push(...protectedPathFindings(config, scope.value));
  const configCommit = locked.value.commitSha;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-run-'));
  // Sibling files next to the used config (knip.json, eslint config, …) are
  // referenced as `$HEIMDALL_CONFIG_DIR/...`. Knip's merge-base run uses this same env.
  // GATE_* names are still set so older configs keep working.
  const configDir = path.dirname(configPath);
  const env: NodeJS.ProcessEnv = {
    ...processEnv,
    ...(processEnv.NO_COLOR === undefined ? { NO_COLOR: '1' } : {}),
    ...(nodeHeap.nodeOptions !== undefined ? { NODE_OPTIONS: nodeHeap.nodeOptions } : {}),
    [TMP_ENV]: tmpDir,
    [LEGACY_TMP_ENV]: tmpDir,
    [CONFIG_DIR_ENV]: configDir,
    [LEGACY_CONFIG_DIR_ENV]: configDir,
  };
  const steps: StepResult[] = [];
  // Teardown still runs after SIGINT/SIGTERM so setup resources are not left up.
  const finish = async (): Promise<GateOutcome> => {
    const teardownError = await runShellList(config.teardown, 'teardown', repoRoot, env, runCommand, undefined);
    if (teardownError) {
      steps.push(teardownError);
    }
    const finalSteps = withSyntheticSteps(steps, syntheticFindings);
    const moved = headChangeReason(startHead, repoRoot);
    if (moved !== undefined) {
      return withConfigPath(
        gateError(
          moved,
          base.value.spec,
          finalSteps,
          base.value.mergeBaseSha,
          warnings,
          scope.value,
          base.value.sha,
          startHead.sha,
        ),
        configPath,
        configCommit,
      );
    }
    return outcomeFromSteps(
      base.value,
      finalSteps,
      warnings,
      scope.value,
      configPath,
      configCommit,
    );
  };

  try {
    const setupError = await runShellList(config.setup, 'setup', repoRoot, env, runCommand, abortSignal);
    if (setupError) {
      steps.push(setupError);
      return finish();
    }

    const ctx: StepContext = {
      cwd: repoRoot,
      tmpDir,
      config,
      scope: scope.value,
      runCommand,
      env,
      ...(abortSignal !== undefined ? { abortSignal } : {}),
    };

    for (const step of STEPS) {
      if (abortSignal?.aborted) {
        break;
      }
      if (!step.isEnabled(config)) {
        continue;
      }
      try {
        steps.push(await step.run(ctx));
      } catch (cause) {
        steps.push({
          kind: 'error',
          name: step.name,
          reason: `${step.name} crashed: ${errorMessage(cause)}`,
        });
      }
    }

    if (abortSignal?.aborted && !steps.some((step) => step.kind === 'error')) {
      const done = new Set(steps.map((step) => step.name));
      const pending = STEPS.find((step) => step.isEnabled(config) && !done.has(step.name));
      const named = pending ?? STEPS.find((step) => step.isEnabled(config));
      steps.push({
        kind: 'error',
        name: named?.name ?? 'setup',
        reason: gateInterruptReason(abortSignal),
      });
    }

    return finish();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
