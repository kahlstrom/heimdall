/**
 * Shared domain types for the gate.
 *
 * Outcomes are a discriminated union so green / red / GATE ERROR cannot be mixed.
 * External data (config, tool output, git) is parsed into these types at the
 * boundary; internal code trusts them.
 */

export const EXIT_GREEN = 0;
export const EXIT_RED = 1;
export const EXIT_GATE_ERROR = 2;

/** Default per-step command timeout (5 minutes). Hung tools must not block the gate. */
export const DEFAULT_STEP_TIMEOUT_MS = 300_000;

/** Default cap on changed files versus the resolved base (including untracked). */
export const DEFAULT_MAX_CHANGED_FILES = 100;

/** Default repo-relative globs identifying test and config files. */
export const DEFAULT_TEST_GLOBS = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  '**/test/**',
  '**/tests/**',
  '**/e2e/**',
  '**/*.config.*',
] as const;

export type ExitCode = typeof EXIT_GREEN | typeof EXIT_RED | typeof EXIT_GATE_ERROR;

export const COMMAND_STEP_NAMES = [
  'typecheck',
  'tests',
  'eslint',
  'knip',
  'jscpd',
  'secrets',
  'architecture',
] as const;
export type CommandStepName = (typeof COMMAND_STEP_NAMES)[number];

export const STEP_NAMES = [...COMMAND_STEP_NAMES, 'line-checks'] as const;
export type StepName = (typeof STEP_NAMES)[number];

/** Source files the gate parses as JS/TS (line-checks, flake file ids). */
export const SOURCE_FILE_EXT_RE = /\.(?:tsx?|jsx?|mjs|cjs|mts|cts)$/i;

/** JS/TS files the no-silencing check scans. `.mts` / `.cts` are not included. */
export const NO_SILENCING_FILE_EXT_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/i;

/** Stringify an unknown catch value without leaking a non-Error object tree. */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Configurable steps plus synthetic config-change, config-uncommitted, and protected-path checks. */
type FindingStepName = StepName | 'config' | 'protected-path';

export type Finding = {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly message: string;
  readonly step: FindingStepName;
  /** Inclusive end of a range finding (jscpd clones). */
  readonly endLine?: number;
  /** ESLint `messageId` when the JSON includes one. Used only for matching. */
  readonly messageId?: string;
};

export type CommandStepConfig = {
  readonly enabled: boolean;
  readonly command: string;
  readonly timeoutMs: number;
};

/** ESLint step: `maxWarnings` is unset when the key is absent (warnings ignored). */
export type EslintStepConfig = CommandStepConfig & {
  readonly maxWarnings: number | undefined;
};

export type LineChecksConfig = {
  readonly enabled: boolean;
  readonly allowSilencing: readonly string[];
  readonly allowTestImports: readonly string[];
  readonly commentPatterns: readonly RegExp[];
  readonly testEnvNames: readonly string[];
};

export type GateConfig = {
  readonly configPath: string;
  readonly baseRef: string | undefined;
  /** When true, a silent fallback to main/origin/main (or no upstream) is a GATE ERROR. */
  readonly requireParentBase: boolean;
  /** Changed-file cap, including untracked files the gate counts. */
  readonly maxChangedFiles: number;
  readonly steps: {
    readonly typecheck: CommandStepConfig | undefined;
    readonly tests: CommandStepConfig | undefined;
    readonly eslint: EslintStepConfig | undefined;
    readonly knip: CommandStepConfig | undefined;
    readonly jscpd: CommandStepConfig | undefined;
    readonly secrets: CommandStepConfig | undefined;
    readonly architecture: CommandStepConfig | undefined;
    readonly 'line-checks': LineChecksConfig | undefined;
  };
  readonly flakes: readonly string[];
  readonly setup: readonly string[];
  readonly teardown: readonly string[];
  /** Repo-relative globs. Empty means the check is off. */
  readonly protectedPaths: readonly string[];
  /** Repo-relative globs for test files. Absent defaults to DEFAULT_TEST_GLOBS; empty matches nothing. */
  readonly testGlobs: readonly string[];
};

export type DiffScope = {
  readonly baseRef: string;
  readonly mergeBaseSha: string;
  readonly changedFiles: ReadonlySet<string>;
  readonly addedLines: ReadonlyMap<string, ReadonlySet<number>>;
  /** New repo-relative path → old path for git renames (`diff -M`). Copies are omitted. */
  readonly renamedFrom: ReadonlyMap<string, string>;
};

export function addedLineCount(scope: DiffScope): number {
  let count = 0;
  for (const lines of scope.addedLines.values()) {
    count += lines.size;
  }
  return count;
}

export type CommandResult = {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnError: string | undefined;
  readonly timedOut: boolean;
};

export type StepResult =
  | { readonly kind: 'pass'; readonly name: StepName; readonly excused?: readonly string[] }
  | { readonly kind: 'fail'; readonly name: FindingStepName; readonly findings: readonly Finding[] }
  | { readonly kind: 'error'; readonly name: StepName | 'setup' | 'teardown'; readonly reason: string }
  | { readonly kind: 'skipped'; readonly name: StepName; readonly reason: string };

type OutcomeScope = {
  readonly baseSha?: string;
  readonly changedFileCount?: number;
  readonly addedLineCount?: number;
  readonly configPath?: string;
  /** HEAD of the git repo that contains an outside-repo config directory. */
  readonly configCommit?: string;
};

export type GateOutcome =
  | ({
      readonly kind: 'green';
      readonly exitCode: typeof EXIT_GREEN;
      readonly baseRef: string;
      readonly mergeBaseSha: string;
      /** Full `git rev-parse HEAD` sha the gate ran on. */
      readonly headSha: string;
      readonly warnings: readonly string[];
      readonly steps: readonly StepResult[];
    } & OutcomeScope)
  | ({
      readonly kind: 'red';
      readonly exitCode: typeof EXIT_RED;
      readonly baseRef: string;
      readonly mergeBaseSha: string;
      /** Full `git rev-parse HEAD` sha the gate ran on. */
      readonly headSha: string;
      readonly warnings: readonly string[];
      readonly steps: readonly StepResult[];
    } & OutcomeScope)
  | ({
      readonly kind: 'error';
      readonly exitCode: typeof EXIT_GATE_ERROR;
      readonly reason: string;
      readonly baseRef: string | undefined;
      readonly mergeBaseSha: string | undefined;
      /** Present only when HEAD was already resolved; omitted on empty repos. */
      readonly headSha: string | undefined;
      readonly warnings: readonly string[];
      readonly steps: readonly StepResult[];
    } & OutcomeScope);

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err = { readonly ok: false; readonly error: string };
export type Result<T> = Ok<T> | Err;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err(error: string): Err {
  return { ok: false, error };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertNever(value: never, message: string): never {
  throw new Error(message);
}
