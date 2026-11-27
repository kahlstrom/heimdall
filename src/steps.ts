/**
 * Modular gate steps share this interface so later stories can add more.
 */
import fs from 'node:fs';
import path from 'node:path';
import { classifyCommandFailure, combinedOutput, type RunCommandFn } from './command.js';
import {
  eslintMetricValue,
  filterFindingsToScope,
  findingsNotInBase,
  identityMessage,
  mapArchitectureRenameMessage,
  matchFindingKey,
  noMetric,
  partitionFindingsByScope,
  relativizeFindingFiles,
  stableEslintMessage,
} from './diff.js';
import { materializeCommit } from './git.js';
import { classifyFailedTests, parseTestRun } from './flakes.js';
import { extractJson } from './json.js';
import { runLineChecks } from './line-checks.js';
import {
  parseArchitectureOutput,
  parseEslintOutput,
  parseJscpdOutput,
  parseKnipOutput,
  parseSecretsOutput,
  parseTypecheckOutput,
  type EslintParsed,
} from './parsers.js';
import {
  DEFAULT_STEP_TIMEOUT_MS,
  err,
  errorMessage,
  isRecord,
  ok,
  type CommandResult,
  type CommandStepName,
  type DiffScope,
  type Finding,
  type GateConfig,
  type Result,
  type StepName,
  type StepResult,
} from './types.js';

export type StepContext = {
  readonly cwd: string;
  readonly tmpDir: string;
  readonly config: GateConfig;
  readonly scope: DiffScope;
  readonly runCommand: RunCommandFn;
  readonly env: NodeJS.ProcessEnv;
  readonly abortSignal?: AbortSignal;
};

export type GateStep = {
  readonly name: StepName;
  readonly scopeToDiff: boolean;
  isEnabled(config: GateConfig): boolean;
  run(ctx: StepContext): Promise<StepResult>;
};

function commandFor(config: GateConfig, name: Exclude<StepName, 'line-checks'>): string | undefined {
  const step = config.steps[name];
  if (!step || !step.enabled) {
    return undefined;
  }
  return step.command;
}

function stepTimeoutMs(config: GateConfig, name: Exclude<StepName, 'line-checks'>): number {
  return config.steps[name]?.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
}

function runCommandOptions(ctx: StepContext, timeoutMs: number): { timeoutMs: number; signal?: AbortSignal } {
  if (ctx.abortSignal !== undefined) {
    return { timeoutMs, signal: ctx.abortSignal };
  }
  return { timeoutMs };
}

async function runConfigured(
  ctx: StepContext,
  name: Exclude<StepName, 'line-checks'>,
): Promise<{ command: string; result: CommandResult } | StepResult> {
  const command = commandFor(ctx.config, name);
  if (!command) {
    return { kind: 'skipped', name, reason: 'disabled' };
  }
  const timeoutMs = stepTimeoutMs(ctx.config, name);
  const result = await ctx.runCommand(command, ctx.cwd, ctx.env, runCommandOptions(ctx, timeoutMs));
  const crash = classifyCommandFailure(name, command, result, timeoutMs, ctx.abortSignal);
  if (crash) {
    return { kind: 'error', name, reason: crash };
  }
  return { command, result };
}

type ParseFailureFn = (error: string, result: CommandResult) => string;

/**
 * Parse a tool's findings. Stderr (Node deprecation lines, `[DEP0040]`) is
 * attached to GATE ERROR messages by default, never to the parse. Unparseable
 * output is always GATE ERROR, including when the tool exits 0. Pass
 * `parseFailure` to choose the GATE ERROR text (for example to omit stderr).
 */
function parseOrError<T>(
  name: StepName,
  parsed: Result<T>,
  result: CommandResult,
  parseFailure: ParseFailureFn = parseFailureWithStderr,
): T | StepResult {
  if (!parsed.ok) {
    return { kind: 'error', name, reason: parseFailure(parsed.error, result) };
  }
  return parsed.value;
}

const STEP_RESULT_KINDS = new Set(['pass', 'fail', 'error', 'skipped']);

function isStepResult(value: unknown): value is StepResult {
  return (
    isRecord(value) &&
    typeof value.kind === 'string' &&
    STEP_RESULT_KINDS.has(value.kind) &&
    typeof value.name === 'string'
  );
}

function parseFailureWithStderr(error: string, result: CommandResult): string {
  const stderr = result.stderr.trim();
  return stderr ? `${error} (stderr: ${stderr.slice(0, 400)})` : error;
}

function jsonStdout(result: CommandResult, reportFile: string | undefined): string {
  if (extractJson(result.stdout).ok) {
    return result.stdout;
  }
  if (reportFile !== undefined && fs.existsSync(reportFile)) {
    return fs.readFileSync(reportFile, 'utf8');
  }
  return result.stdout;
}

function scopedOrPass(step: GateStep, findings: readonly Finding[], ctx: StepContext): StepResult {
  if (!step.scopeToDiff) {
    if (findings.length === 0) {
      return { kind: 'pass', name: step.name };
    }
    return { kind: 'fail', name: step.name, findings: [...findings] };
  }
  const kept = filterFindingsToScope(findings, ctx.scope, ctx.cwd);
  if (!kept.ok) {
    return { kind: 'error', name: step.name, reason: kept.error };
  }
  if (kept.value.length === 0) {
    return { kind: 'pass', name: step.name };
  }
  return { kind: 'fail', name: step.name, findings: kept.value };
}

function toolFailedWithoutFindings(
  name: StepName,
  command: string,
  result: CommandResult,
): StepResult {
  const output = combinedOutput(result).trim();
  const snippet = output.slice(0, 400);
  return {
    kind: 'error',
    name,
    reason: `${name} command ${JSON.stringify(command)} exited ${result.exitCode ?? 'null'} without parseable findings${
      snippet ? `: ${snippet}` : ''
    }`,
  };
}

/**
 * Run a configured command and parse findings. Callers decide how to read
 * stdout (knip uses stdout; jscpd may fall back to a report file) and how
 * to format a parse failure.
 */
async function runAndParseFindings(
  ctx: StepContext,
  name: CommandStepName,
  parse: (output: string) => Result<Finding[]>,
  options: {
    readonly stdoutOf?: (result: CommandResult) => string;
    readonly parseFailure?: ParseFailureFn;
  } = {},
): Promise<{ command: string; result: CommandResult; findings: Finding[] } | StepResult> {
  const stdoutOf = options.stdoutOf ?? ((result: CommandResult) => result.stdout);
  const ran = await runConfigured(ctx, name);
  if (!('result' in ran)) {
    return ran;
  }
  const parsed = parseOrError(name, parse(stdoutOf(ran.result)), ran.result, options.parseFailure);
  if (!Array.isArray(parsed)) {
    return parsed;
  }
  return { command: ran.command, result: ran.result, findings: parsed };
}

function jsonToolStep(
  name: Extract<CommandStepName, 'jscpd'>,
  parse: (output: string) => Result<Finding[]>,
  reportFileName?: string,
): GateStep {
  const step: GateStep = {
    name,
    scopeToDiff: true,
    isEnabled: (config) => config.steps[name]?.enabled === true,
    async run(ctx) {
      const reportFile = reportFileName === undefined ? undefined : path.join(ctx.tmpDir, reportFileName);
      const ran = await runAndParseFindings(ctx, name, parse, {
        stdoutOf: (result) => jsonStdout(result, reportFile),
      });
      if (!('command' in ran)) {
        return ran;
      }
      const scoped = scopedOrPass(step, ran.findings, ctx);
      if (scoped.kind !== 'pass') {
        return scoped;
      }
      if (ran.result.exitCode === 0 || ran.findings.length > 0) {
        return { kind: 'pass', name };
      }
      return toolFailedWithoutFindings(name, ran.command, ran.result);
    },
  };
  return step;
}

export const typecheckStep: GateStep = {
  name: 'typecheck',
  scopeToDiff: false,
  isEnabled(config) {
    return config.steps.typecheck?.enabled === true;
  },
  async run(ctx) {
    const ran = await runConfigured(ctx, 'typecheck');
    if (!('result' in ran)) {
      return ran;
    }
    const parsed = parseOrError('typecheck', parseTypecheckOutput(combinedOutput(ran.result)), ran.result);
    if (!Array.isArray(parsed)) {
      return parsed;
    }
    if (parsed.length > 0) {
      return scopedOrPass(typecheckStep, parsed, ctx);
    }
    if (ran.result.exitCode === 0) {
      return { kind: 'pass', name: 'typecheck' };
    }
    return toolFailedWithoutFindings('typecheck', ran.command, ran.result);
  },
};

export const testsStep: GateStep = {
  name: 'tests',
  scopeToDiff: false,
  isEnabled(config) {
    return config.steps.tests?.enabled === true;
  },
  async run(ctx) {
    const ran = await runConfigured(ctx, 'tests');
    if (!('result' in ran)) {
      return ran;
    }
    if (ran.result.exitCode === 0) {
      return { kind: 'pass', name: 'tests' };
    }
    const failures = parseTestRun(ran.result.stdout, combinedOutput(ran.result));
    if (!failures || failures.length === 0) {
      const output = combinedOutput(ran.result).trim();
      const snippet = output.slice(0, 400);
      return {
        kind: 'error',
        name: 'tests',
        reason: `test runner exited ${ran.result.exitCode ?? 'null'} with no parseable failed tests${
          snippet ? `: ${snippet}` : ''
        }`,
      };
    }
    const classified = classifyFailedTests(failures, ctx.config.flakes);
    if (classified.unknown.length === 0) {
      if (classified.matched.length === 0) {
        return { kind: 'pass', name: 'tests' };
      }
      return {
        kind: 'pass',
        name: 'tests',
        excused: classified.matched.map((test) => `${test.file} > ${test.name}`),
      };
    }
    return {
      kind: 'fail',
      name: 'tests',
      findings: classified.unknown.map((test) => ({
        step: 'tests',
        file: test.file || 'tests',
        line: 0,
        rule: 'tests',
        message: test.name,
      })),
    };
  },
};

function relativizeEslintParsed(parsed: EslintParsed, baseRoot: string): EslintParsed {
  return {
    errors: relativizeFindingFiles(parsed.errors, baseRoot),
    warnings: relativizeFindingFiles(parsed.warnings, baseRoot),
  };
}

function eslintMatchKey(ctx: StepContext): (finding: Finding) => string {
  return (finding) => matchFindingKey(finding, ctx.scope, ctx.cwd, stableEslintMessage);
}

/**
 * Added-line hits always count. Findings on untouched lines count only when
 * they are new versus the merge-base. Skips that second run when every
 * finding is already on an added line.
 */
async function inScopeOrNewVersusBase(
  ctx: StepContext,
  command: string,
  parsed: EslintParsed,
): Promise<{ errors: Finding[]; warnings: Finding[] } | StepResult> {
  const errors = partitionFindingsByScope(parsed.errors, ctx.scope, ctx.cwd);
  if (!errors.ok) {
    return { kind: 'error', name: 'eslint', reason: errors.error };
  }
  const includeWarnings = ctx.config.steps.eslint?.maxWarnings !== undefined;
  let warningIn: readonly Finding[] = [];
  let warningOut: readonly Finding[] = [];
  if (includeWarnings) {
    const warnings = partitionFindingsByScope(parsed.warnings, ctx.scope, ctx.cwd);
    if (!warnings.ok) {
      return { kind: 'error', name: 'eslint', reason: warnings.error };
    }
    warningIn = warnings.value.inScope;
    warningOut = warnings.value.outOfScope;
  }
  if (errors.value.outOfScope.length === 0 && warningOut.length === 0) {
    return { errors: [...errors.value.inScope], warnings: [...warningIn] };
  }

  const base = await findingsAtMergeBase(ctx, 'eslint', command, parseEslintOutput, relativizeEslintParsed);
  if (isStepResult(base)) {
    return base;
  }
  const keyOf = eslintMatchKey(ctx);
  return {
    errors: [
      ...errors.value.inScope,
      ...findingsNotInBase(errors.value.outOfScope, base.errors, keyOf, eslintMetricValue),
    ],
    warnings: [...warningIn, ...findingsNotInBase(warningOut, base.warnings, keyOf, eslintMetricValue)],
  };
}

/**
 * Errors (severity 2+) fail the step when they are on an added line or new
 * versus the merge-base. Warnings (severity 1) are ignored unless
 * `maxWarnings` is set; then the same added-line-or-new rule applies, and
 * more than that cap is RED.
 */
export const eslintStep: GateStep = {
  name: 'eslint',
  scopeToDiff: true,
  isEnabled(config) {
    return config.steps.eslint?.enabled === true;
  },
  async run(ctx) {
    const ran = await runConfigured(ctx, 'eslint');
    if (!('result' in ran)) {
      return ran;
    }
    const parsed = parseOrError('eslint', parseEslintOutput(jsonStdout(ran.result, undefined)), ran.result);
    if (isStepResult(parsed)) {
      return parsed;
    }
    const scoped = await inScopeOrNewVersusBase(ctx, ran.command, parsed);
    if (isStepResult(scoped)) {
      return scoped;
    }
    const findings: Finding[] = [...scoped.errors];
    const maxWarnings = ctx.config.steps.eslint?.maxWarnings;
    if (maxWarnings !== undefined && scoped.warnings.length > maxWarnings) {
      findings.push(...scoped.warnings);
    }
    if (findings.length > 0) {
      return { kind: 'fail', name: 'eslint', findings };
    }
    const parsedAnything =
      parsed.errors.length > 0 || (maxWarnings !== undefined && parsed.warnings.length > 0);
    if (ran.result.exitCode === 0 || parsedAnything) {
      return { kind: 'pass', name: 'eslint' };
    }
    return toolFailedWithoutFindings('eslint', ran.command, ran.result);
  },
};

/**
 * Whole-project JSON tools that fail only on findings new versus the merge-base.
 * Skip the baseline run when the branch result is empty (knip, architecture).
 */
function newVsBaseCommandStep(
  name: CommandStepName,
  parse: (output: string) => Result<Finding[]>,
  messageOf: (message: string, renamedFrom: ReadonlyMap<string, string>) => string,
  metricOf: (finding: Finding) => number | undefined,
): GateStep {
  return {
    name,
    scopeToDiff: false,
    isEnabled: (config) => config.steps[name]?.enabled === true,
    async run(ctx) {
      const ran = await runAndParseFindings(ctx, name, parse);
      if (!('command' in ran)) {
        return ran;
      }
      if (ran.findings.length === 0) {
        if (ran.result.exitCode === 0) {
          return { kind: 'pass', name };
        }
        return toolFailedWithoutFindings(name, ran.command, ran.result);
      }

      const baseFindings = await findingsAtMergeBase(ctx, name, ran.command, parse, relativizeFindingFiles);
      if (isStepResult(baseFindings)) {
        return baseFindings;
      }
      const currentFindings = new Set(ran.findings);
      const keyOf = (finding: Finding): string =>
        matchFindingKey(finding, ctx.scope, ctx.cwd, (message) =>
          currentFindings.has(finding) ? messageOf(message, ctx.scope.renamedFrom) : message,
        );
      const findings = findingsNotInBase(ran.findings, baseFindings, keyOf, metricOf);
      if (findings.length === 0) {
        return { kind: 'pass', name };
      }
      return { kind: 'fail', name, findings };
    },
  };
}

export const knipStep: GateStep = newVsBaseCommandStep('knip', parseKnipOutput, identityMessage, noMetric);

/**
 * Materialize the merge-base under HEIMDALL_TMP (itself under os.tmpdir), run
 * `command` there, and parse findings. The copy is removed afterwards; the
 * runner's teardown still deletes HEIMDALL_TMP on abort, timeout, or crash.
 *
 * Step-agnostic on purpose: knip, architecture, and eslint pass their name
 * and parser. Pair with findingsNotInBase to keep only findings that are new
 * versus base. `mapParsed` runs while the copy still exists so absolute tool
 * paths can be rewritten against that single `baseRoot`; the copy is then
 * deleted and callers must not look it up again.
 */
export async function findingsAtMergeBase<T>(
  ctx: StepContext,
  stepName: CommandStepName,
  command: string,
  parse: (output: string) => Result<T>,
  mapParsed: (value: T, baseRoot: string) => T,
): Promise<T | StepResult> {
  const dest = path.join(ctx.tmpDir, `${stepName}-base`);
  try {
    const timeoutMs = stepTimeoutMs(ctx.config, stepName);
    const materialized = await materializeCommit(ctx.cwd, ctx.scope.mergeBaseSha, dest, {
      timeoutMs,
      ...(ctx.abortSignal !== undefined ? { abortSignal: ctx.abortSignal } : {}),
    });
    if (!materialized.ok) {
      return {
        kind: 'error',
        name: stepName,
        reason: `cannot compute ${stepName} baseline at ${ctx.scope.mergeBaseSha}: ${materialized.error}`,
      };
    }
    const linked = shareNodeModules(ctx.cwd, dest);
    if (!linked.ok) {
      return { kind: 'error', name: stepName, reason: linked.error };
    }
    const baseRan = await ctx.runCommand(command, dest, ctx.env, runCommandOptions(ctx, timeoutMs));
    const crash = classifyCommandFailure(stepName, command, baseRan, timeoutMs, ctx.abortSignal);
    if (crash) {
      return { kind: 'error', name: stepName, reason: `${stepName} baseline: ${crash}` };
    }
    const parsed = parseOrError(stepName, parse(baseRan.stdout), baseRan);
    if (isStepResult(parsed)) {
      if (parsed.kind === 'error') {
        return { kind: 'error', name: stepName, reason: `${stepName} baseline: ${parsed.reason}` };
      }
      return parsed;
    }
    return mapParsed(parsed, dest);
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
}

function isDirectoryLike(entry: fs.Dirent, full: string): boolean {
  if (entry.isDirectory()) {
    return true;
  }
  if (!entry.isSymbolicLink()) {
    return false;
  }
  try {
    return fs.statSync(full).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every node_modules in the live checkout, including workspace packages.
 * Contents of node_modules and .git are not walked.
 */
function checkoutNodeModulesDirs(fromRepo: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git') {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.name === 'node_modules') {
        if (isDirectoryLike(entry, full)) {
          found.push(full);
        }
        continue;
      }
      if (entry.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(fromRepo);
  return found;
}

function realpathOrResolve(abs: string): string {
  try {
    return fs.realpathSync(abs);
  } catch {
    return path.resolve(abs);
  }
}

/** Relative path from `parent` to `target` when `target` is inside `parent` (including `parent` itself). */
function pathInside(parent: string, target: string): string | undefined {
  const rel = path.relative(parent, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return undefined;
  }
  return rel;
}

function shareNodeModulesError(cause: unknown): Result<never> {
  return err(`cannot share node_modules with the baseline copy: ${errorMessage(cause)}`);
}

/**
 * Repo-relative source of a workspace package: the entry's real path is inside
 * the live checkout but not under a node_modules directory. Third-party
 * installs resolve inside node_modules (or outside the repo) and return
 * undefined so they can be shared as-is.
 */
function workspaceSourceRel(fromRoot: string, entryPath: string): string | undefined {
  let real: string;
  try {
    real = fs.realpathSync(entryPath);
  } catch {
    return undefined;
  }
  const rel = pathInside(fromRoot, real);
  if (rel === undefined || rel.split(path.sep).includes('node_modules')) {
    return undefined;
  }
  return rel;
}

/**
 * Overlay each live node_modules onto the materialized copy. Third-party
 * entries stay symlinks into the live install (not copied). Workspace
 * packages whose real target is inside the live checkout are retargeted at
 * the matching path in `dest`, so tools in the copy see merge-base source.
 * Live node_modules is never written.
 */
function shareNodeModules(fromRepo: string, dest: string): Result<void> {
  const fromRoot = realpathOrResolve(fromRepo);
  const destRoot = realpathOrResolve(dest);

  const populate = (srcDir: string, destDir: string): Result<void> => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(srcDir, { withFileTypes: true });
      fs.mkdirSync(destDir, { recursive: true });
    } catch (cause) {
      return shareNodeModulesError(cause);
    }
    for (const entry of entries) {
      const srcEntry = path.join(srcDir, entry.name);
      const destEntry = path.join(destDir, entry.name);
      if (fs.existsSync(destEntry)) {
        continue;
      }
      const workspaceRel = workspaceSourceRel(fromRoot, srcEntry);
      if (workspaceRel !== undefined) {
        const destTarget = path.join(destRoot, workspaceRel);
        if (!fs.existsSync(destTarget)) {
          continue;
        }
        try {
          fs.symlinkSync(destTarget, destEntry);
        } catch (cause) {
          return shareNodeModulesError(cause);
        }
        continue;
      }
      if (entry.name.startsWith('@') && isDirectoryLike(entry, srcEntry)) {
        const nested = populate(srcEntry, destEntry);
        if (!nested.ok) {
          return nested;
        }
        continue;
      }
      try {
        fs.symlinkSync(srcEntry, destEntry);
      } catch (cause) {
        return shareNodeModulesError(cause);
      }
    }
    return ok(undefined);
  };

  for (const src of checkoutNodeModulesDirs(fromRoot)) {
    const rel = pathInside(fromRoot, src);
    if (rel === undefined) {
      continue;
    }
    const destNm = path.join(destRoot, rel);
    if (fs.existsSync(destNm)) {
      continue;
    }
    if (!fs.existsSync(path.dirname(destNm))) {
      continue;
    }
    const populated = populate(src, destNm);
    if (!populated.ok) {
      return populated;
    }
  }
  return ok(undefined);
}

export const jscpdStep: GateStep = jsonToolStep('jscpd', parseJscpdOutput, 'jscpd-report.json');

/**
 * dependency-cruiser JSON (`--output-type json`, 18.x). Fails only on
 * error-severity violations that are new versus the merge-base. Off unless a
 * repo enables it with a command — no default command, rules file, or tool
 * path. Skip the baseline run when the branch has no error violations.
 */
export const architectureStep: GateStep = newVsBaseCommandStep(
  'architecture',
  parseArchitectureOutput,
  mapArchitectureRenameMessage,
  noMetric,
);

/** Parser message plus exit code; never tool stdout or stderr. */
function secretsParseFailure(error: string, result: CommandResult): string {
  return `${error} (exit ${result.exitCode ?? 'null'})`;
}

/**
 * secretlint JSON, scoped to added lines the same way eslint is. Findings
 * carry rule id, file, and line only — never secretlint's message text.
 */
export const secretsStep: GateStep = {
  name: 'secrets',
  scopeToDiff: true,
  isEnabled(config) {
    return config.steps.secrets?.enabled === true;
  },
  async run(ctx) {
    const ran = await runAndParseFindings(ctx, 'secrets', parseSecretsOutput, {
      parseFailure: secretsParseFailure,
    });
    if (!('command' in ran)) {
      return ran;
    }
    const scoped = scopedOrPass(secretsStep, ran.findings, ctx);
    if (scoped.kind !== 'pass') {
      return scoped;
    }
    if (ran.result.exitCode === 0 || ran.findings.length > 0) {
      return { kind: 'pass', name: 'secrets' };
    }
    // Do not attach stdout/stderr: they may contain secretlint message text or matched secrets.
    return {
      kind: 'error',
      name: 'secrets',
      reason: `secrets command ${JSON.stringify(ran.command)} exited ${ran.result.exitCode ?? 'null'} without parseable findings`,
    };
  },
};

export const lineChecksStep: GateStep = {
  name: 'line-checks',
  scopeToDiff: true,
  isEnabled(config) {
    // Omitted means no-silencing, test-import, and test-env still run; `"enabled": false` turns the step off.
    return config.steps['line-checks']?.enabled !== false;
  },
  async run(ctx) {
    try {
      const lineChecks = ctx.config.steps['line-checks'];
      const findings = runLineChecks(ctx.cwd, ctx.scope, {
        extras: lineChecks?.enabled === true,
        allowSilencing: lineChecks?.allowSilencing ?? [],
        allowTestImports: lineChecks?.allowTestImports ?? [],
        testEnvNames: lineChecks?.testEnvNames ?? [],
        testGlobs: ctx.config.testGlobs,
        secrets: ctx.config.steps.secrets?.enabled === true,
        commentPatterns: lineChecks?.commentPatterns ?? [],
      });
      if (!findings.ok) {
        return { kind: 'error', name: 'line-checks', reason: findings.error };
      }
      return scopedOrPass(lineChecksStep, findings.value, ctx);
    } catch (cause) {
      return { kind: 'error', name: 'line-checks', reason: `line-checks crashed: ${errorMessage(cause)}` };
    }
  },
};

export const STEPS: readonly GateStep[] = [
  typecheckStep,
  testsStep,
  eslintStep,
  knipStep,
  jscpdStep,
  secretsStep,
  architectureStep,
  lineChecksStep,
];
