/**
 * Modular gate steps share this interface so later stories can add more.
 */
import fs from 'node:fs';
import path from 'node:path';
import { classifyCommandFailure, combinedOutput, type RunCommandFn } from './command.js';
import { filterFindingsToScope, findingsNotInBase } from './diff.js';
import { materializeCommit } from './git.js';
import { classifyFailedTests, parseTestRun } from './flakes.js';
import { extractJson } from './json.js';
import { runLineChecks } from './line-checks.js';
import { parseEslintOutput, parseJscpdOutput, parseKnipOutput, parseTypecheckOutput } from './parsers.js';
import {
  DEFAULT_STEP_TIMEOUT_MS,
  err,
  errorMessage,
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

/**
 * Parse a tool's findings. Stderr (Node deprecation lines, `[DEP0040]`) is
 * attached to GATE ERROR messages, never to the parse. Unparseable output is
 * always GATE ERROR, including when the tool exits 0.
 */
function parseOrError<T>(
  name: StepName,
  parsed: Result<T>,
  result: CommandResult,
): T | StepResult {
  if (!parsed.ok) {
    const stderr = result.stderr.trim();
    const reason = stderr ? `${parsed.error} (stderr: ${stderr.slice(0, 400)})` : parsed.error;
    return { kind: 'error', name, reason };
  }
  return parsed.value;
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

function jsonToolStep(
  name: Extract<CommandStepName, 'jscpd'>,
  parse: (output: string) => Result<Finding[]>,
  reportFileName?: string,
): GateStep {
  const step: GateStep = {
    name,
    scopeToDiff: true,
    isEnabled(config) {
      return config.steps[name]?.enabled === true;
    },
    async run(ctx) {
      const ran = await runConfigured(ctx, name);
      if (!('result' in ran)) {
        return ran;
      }
      const reportFile = reportFileName === undefined ? undefined : path.join(ctx.tmpDir, reportFileName);
      const parsed = parseOrError(name, parse(jsonStdout(ran.result, reportFile)), ran.result);
      if (!Array.isArray(parsed)) {
        return parsed;
      }
      const scoped = scopedOrPass(step, parsed, ctx);
      if (scoped.kind !== 'pass') {
        return scoped;
      }
      if (ran.result.exitCode === 0 || parsed.length > 0) {
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

/**
 * Errors (severity 2+) always fail the step, scoped to the diff. Warnings
 * (severity 1) are ignored unless `maxWarnings` is set; then new warnings on
 * changed files and lines are counted, and more than that cap is RED.
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
    if ('kind' in parsed) {
      return parsed;
    }
    const errorScoped = scopedOrPass(eslintStep, parsed.errors, ctx);
    if (errorScoped.kind === 'error') {
      return errorScoped;
    }
    const findings: Finding[] = errorScoped.kind === 'fail' ? [...errorScoped.findings] : [];
    const maxWarnings = ctx.config.steps.eslint?.maxWarnings;
    if (maxWarnings !== undefined) {
      const warningScoped = scopedOrPass(eslintStep, parsed.warnings, ctx);
      if (warningScoped.kind === 'error') {
        return warningScoped;
      }
      const warningFindings = warningScoped.kind === 'fail' ? warningScoped.findings : [];
      if (warningFindings.length > maxWarnings) {
        findings.push(...warningFindings);
      }
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

export const knipStep: GateStep = {
  name: 'knip',
  scopeToDiff: false,
  isEnabled(config) {
    return config.steps.knip?.enabled === true;
  },
  async run(ctx) {
    const ran = await runConfigured(ctx, 'knip');
    if (!('result' in ran)) {
      return ran;
    }
    const parsed = parseOrError('knip', parseKnipOutput(ran.result.stdout), ran.result);
    if (!Array.isArray(parsed)) {
      return parsed;
    }
    if (parsed.length === 0) {
      if (ran.result.exitCode === 0) {
        return { kind: 'pass', name: 'knip' };
      }
      return toolFailedWithoutFindings('knip', ran.command, ran.result);
    }

    const baseFindings = await findingsAtMergeBase(ctx, 'knip', ran.command, parseKnipOutput);
    if (!Array.isArray(baseFindings)) {
      return baseFindings;
    }
    const findings = findingsNotInBase(parsed, baseFindings);
    if (findings.length === 0) {
      return { kind: 'pass', name: 'knip' };
    }
    return { kind: 'fail', name: 'knip', findings };
  },
};

/**
 * Materialize the merge-base under HEIMDALL_TMP (itself under os.tmpdir), run
 * `command` there, and parse findings. The copy is removed afterwards; the
 * runner's teardown still deletes HEIMDALL_TMP on abort, timeout, or crash.
 *
 * Step-agnostic on purpose: knip (and later steps) pass their name and parser.
 * Pair with findingsNotInBase to keep only findings that are new versus base.
 */
export async function findingsAtMergeBase(
  ctx: StepContext,
  stepName: CommandStepName,
  command: string,
  parse: (output: string) => Result<Finding[]>,
): Promise<Finding[] | StepResult> {
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
    if (!Array.isArray(parsed)) {
      if (parsed.kind === 'error') {
        return { kind: 'error', name: stepName, reason: `${stepName} baseline: ${parsed.reason}` };
      }
      return parsed;
    }
    return parsed;
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

function shareNodeModules(fromRepo: string, dest: string): Result<void> {
  for (const src of checkoutNodeModulesDirs(fromRepo)) {
    const rel = path.relative(fromRepo, src);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      continue;
    }
    const destNm = path.join(dest, rel);
    if (fs.existsSync(destNm)) {
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(destNm), { recursive: true });
      fs.symlinkSync(src, destNm);
    } catch (cause) {
      return err(`cannot share node_modules with knip baseline: ${errorMessage(cause)}`);
    }
  }
  return ok(undefined);
}

export const jscpdStep: GateStep = jsonToolStep('jscpd', parseJscpdOutput, 'jscpd-report.json');

export const lineChecksStep: GateStep = {
  name: 'line-checks',
  scopeToDiff: true,
  isEnabled(config) {
    // Omitted means no-silencing still runs; `"enabled": false` turns the step off.
    return config.steps['line-checks']?.enabled !== false;
  },
  async run(ctx) {
    try {
      const lineChecks = ctx.config.steps['line-checks'];
      const findings = runLineChecks(ctx.cwd, ctx.scope, {
        extras: lineChecks?.enabled === true,
        allowSilencing: lineChecks?.allowSilencing ?? [],
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
  lineChecksStep,
];
