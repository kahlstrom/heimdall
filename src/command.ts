/**
 * Run a configured shell command. Spawn failures, signals, timeouts, and
 * missing binaries are GATE ERRORs — they are not app-code red.
 *
 * Each spawn is a process-group leader (`detached: true`). Timeout, abort, and
 * output-cap all SIGTERM the group, then SIGKILL after a short grace, so
 * grandchildren cannot outlive the step.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { stripAnsi } from './ansi.js';
import {
  DEFAULT_STEP_TIMEOUT_MS,
  NODE_HEAP_MB_ENV,
  assertNever,
  errorMessage,
  type CommandResult,
  type NodeHeap,
  type StepCrash,
  type StepName,
  type StepResult,
} from './types.js';

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const KILL_GRACE_MS = 200;

export type RunCommandOptions = {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
};

export type RunCommandFn = (
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  options?: RunCommandOptions,
) => Promise<CommandResult>;

function collectStream(
  stream: NodeJS.ReadableStream,
  chunks: Buffer[],
  cap: { bytes: number; exceeded: boolean },
  onExceed: () => void,
): void {
  stream.on('data', (chunk: Buffer | string) => {
    if (cap.exceeded) {
      return;
    }
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (cap.bytes + buf.length > MAX_OUTPUT_BYTES) {
      cap.exceeded = true;
      onExceed();
      return;
    }
    cap.bytes += buf.length;
    chunks.push(buf);
  });
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

/**
 * Darwin returns ESRCH for `kill(-pgid)` once the group leader has exited,
 * even when grandchildren are still in that group. Snapshot the tree and
 * signal those pids directly as well as the group.
 */
function pidsInTree(rootPid: number): number[] {
  const listed = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid='], {
    encoding: 'utf8',
    timeout: 1000,
    env: process.env,
  });
  if (listed.status !== 0 || typeof listed.stdout !== 'string') {
    return [];
  }
  const rows: Array<{ pid: number; ppid: number; pgid: number }> = [];
  for (const line of listed.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
      continue;
    }
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]) });
  }
  const childrenOf = new Map<number, number[]>();
  for (const row of rows) {
    const siblings = childrenOf.get(row.ppid) ?? [];
    siblings.push(row.pid);
    childrenOf.set(row.ppid, siblings);
  }
  const found = new Set<number>();
  const walk = (pid: number): void => {
    for (const child of childrenOf.get(pid) ?? []) {
      if (!found.has(child)) {
        found.add(child);
        walk(child);
      }
    }
  };
  walk(rootPid);
  for (const row of rows) {
    if (row.pgid === rootPid) {
      found.add(row.pid);
    }
  }
  found.delete(rootPid);
  return [...found];
}

function killProcessGroup(pid: number, signal: NodeJS.Signals, extraPids: readonly number[]): void {
  try {
    process.kill(-pid, signal);
  } catch {
    signalPid(pid, signal);
  }
  for (const extra of extraPids) {
    signalPid(extra, signal);
  }
}

function killChildTree(child: ChildProcess, extraPids: readonly number[], signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid !== undefined) {
    killProcessGroup(pid, signal, extraPids);
    return;
  }
  child.kill(signal);
}

/**
 * SIGTERM the child and its tree, then SIGKILL after a short grace so
 * grandchildren that ignore SIGTERM cannot outlive the gate.
 */
export function terminateChild(child: ChildProcess): void {
  const extra = child.pid !== undefined ? pidsInTree(child.pid) : [];
  killChildTree(child, extra, 'SIGTERM');
  // Wait the grace period even if the leader already closed, so SIGKILL
  // still reaches children that ignored SIGTERM (and Darwin group-kill
  // after the leader is gone).
  setTimeout(() => {
    const later = child.pid !== undefined ? pidsInTree(child.pid) : [];
    const all = [...new Set([...extra, ...later])];
    killChildTree(child, all, 'SIGKILL');
  }, KILL_GRACE_MS);
}

function emptyResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    spawnError: undefined,
    timedOut: false,
    ...overrides,
  };
}

export const runCommand: RunCommandFn = (command, cwd, env, options) => {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const abortSignal = options?.signal;

  return new Promise((resolve) => {
    if (abortSignal?.aborted) {
      resolve(emptyResult());
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const cap = { bytes: 0, exceeded: false };
    let child: ChildProcess;
    try {
      child = spawn(command, {
        cwd,
        env,
        shell: true,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (cause) {
      resolve(emptyResult({ spawnError: errorMessage(cause) }));
      return;
    }

    let settled = false;
    let timedOut = false;
    let terminating = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let closePayload: { code: number | null; signal: NodeJS.Signals | null } | undefined;

    const resultFrom = (
      code: number | null,
      signal: NodeJS.Signals | null,
      spawnError: string | undefined,
    ): CommandResult => ({
      exitCode: code,
      signal,
      stdout: stripAnsi(Buffer.concat(stdoutChunks).toString('utf8')),
      stderr: stripAnsi(Buffer.concat(stderrChunks).toString('utf8')),
      spawnError,
      timedOut,
    });

    const finish = (result: CommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }
      if (abortSignal !== undefined) {
        abortSignal.removeEventListener('abort', handleAbort);
      }
      resolve(result);
    };

    const finishFromClose = (): void => {
      const code = closePayload?.code ?? null;
      const signal = closePayload?.signal ?? null;
      if (cap.exceeded) {
        finish(resultFrom(code, signal, `command output exceeded ${MAX_OUTPUT_BYTES} bytes`));
        return;
      }
      finish(resultFrom(code, signal, undefined));
    };

    const terminate = (kind: 'timeout' | 'cap' | 'abort'): void => {
      if (terminating || settled) {
        return;
      }
      terminating = true;
      if (kind === 'timeout') {
        timedOut = true;
      }
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      terminateChild(child);
      setTimeout(() => {
        if (closePayload !== undefined) {
          finishFromClose();
          return;
        }
        setTimeout(() => finishFromClose(), KILL_GRACE_MS);
      }, KILL_GRACE_MS);
    };

    function handleAbort(): void {
      terminate('abort');
    }

    if (child.stdout === null || child.stderr === null) {
      terminate('abort');
      finish(emptyResult({ spawnError: 'stdio pipes were not created', timedOut }));
      return;
    }

    collectStream(child.stdout, stdoutChunks, cap, () => terminate('cap'));
    collectStream(child.stderr, stderrChunks, cap, () => terminate('cap'));

    timeoutTimer = setTimeout(() => terminate('timeout'), timeoutMs);

    if (abortSignal !== undefined) {
      abortSignal.addEventListener('abort', handleAbort);
    }

    child.on('error', (cause) => {
      finish(resultFrom(null, null, errorMessage(cause)));
    });

    child.on('close', (code, signal) => {
      closePayload = { code, signal };
      if (!terminating) {
        finishFromClose();
      }
    });
  });
};

/** Join streams for text tools (tsc, test runners). JSON tools must use stdout only. */
export function combinedOutput(result: CommandResult): string {
  if (result.stdout && result.stderr) {
    return `${result.stdout}\n${result.stderr}`;
  }
  return result.stdout || result.stderr;
}

export function gateInterruptReason(signal: AbortSignal): string {
  const name = typeof signal.reason === 'string' && signal.reason.trim() !== '' ? signal.reason : 'signal';
  return `heimdall interrupted (${name})`;
}

const CRASH_SIGNALS: ReadonlySet<NodeJS.Signals> = new Set([
  'SIGABRT',
  'SIGSEGV',
  'SIGBUS',
  'SIGILL',
  'SIGTRAP',
]);

const CRASH_EXIT_SIGNALS: ReadonlyMap<number, NodeJS.Signals> = new Map([
  [134, 'SIGABRT'],
  [139, 'SIGSEGV'],
  [133, 'SIGTRAP'],
]);

const OOM_STDERR_MARKERS = [
  'JavaScript heap out of memory',
  'FATAL ERROR: Reached heap limit',
  'Allocation failed',
] as const;

const DEFAULT_NODE_HEAP_HINT = 'try --node-heap 8192';

export type ClassifyCommandOptions = {
  readonly abortSignal?: AbortSignal;
  readonly commandKey?: string;
  readonly nodeHeap?: NodeHeap;
  readonly cwd?: string;
};

export type CommandFailure =
  | { readonly kind: 'error'; readonly reason: string }
  | { readonly kind: 'crash'; readonly reason: string; readonly crash: StepCrash };

function hasOomMarker(stderr: string): boolean {
  return OOM_STDERR_MARKERS.some((marker) => stderr.includes(marker));
}

function crashHeapMb(heap: NodeHeap): number | null {
  switch (heap.kind) {
    case 'default':
      return null;
    case 'configured':
      return heap.mb;
    case 'node-options':
      return heap.mb ?? null;
    default:
      return assertNever(heap, 'unhandled node-heap state');
  }
}

function crashHeapNote(heap: NodeHeap): string {
  switch (heap.kind) {
    case 'default':
      return DEFAULT_NODE_HEAP_HINT;
    case 'configured': {
      const source = heap.source === 'cli' ? '--node-heap' : NODE_HEAP_MB_ENV;
      return `node-heap was ${heap.mb} MB (from ${source})`;
    }
    case 'node-options':
      return heap.mb !== undefined
        ? `node-heap was ${heap.mb} MB (from NODE_OPTIONS)`
        : 'node-heap was set in NODE_OPTIONS';
    default:
      return assertNever(heap, 'unhandled node-heap state');
  }
}

function crashDetail(result: CommandResult, oom: boolean): string {
  let cause: string;
  if (result.signal !== null) {
    cause = result.signal;
  } else if (result.exitCode === null) {
    cause = 'exit null';
  } else {
    const mappedSignal = CRASH_EXIT_SIGNALS.get(result.exitCode);
    cause = mappedSignal !== undefined ? `exit ${result.exitCode} / ${mappedSignal}` : `exit ${result.exitCode}`;
  }
  return oom ? `OOM, ${cause}` : cause;
}

function detectCrash(
  label: string,
  result: CommandResult,
  nodeHeap: NodeHeap,
  cwd: string,
): Extract<CommandFailure, { readonly kind: 'crash' }> | undefined {
  // SIGKILL and exit 137 are external kills, not classified as native/OOM crashes.
  if (result.signal === 'SIGKILL' || result.exitCode === 137) {
    return undefined;
  }
  const signalCrash = result.signal !== null && CRASH_SIGNALS.has(result.signal);
  const exitCrash = result.signal === null && result.exitCode !== null && CRASH_EXIT_SIGNALS.has(result.exitCode);
  const oom = result.exitCode !== 0 && hasOomMarker(result.stderr);
  const oomCrash = result.signal === null && oom;
  if (!signalCrash && !exitCrash && !oomCrash) {
    return undefined;
  }
  const detail = crashDetail(result, oom);
  const heapNote = crashHeapNote(nodeHeap);
  return {
    kind: 'crash',
    reason: `${label} crashed (${detail}); ${heapNote}`,
    crash: {
      signal: result.signal,
      exitCode: result.exitCode,
      heapMb: crashHeapMb(nodeHeap),
      nodeVersion: process.version,
      repo: path.basename(path.resolve(cwd)),
    },
  };
}

/**
 * Classify a finished command as a GATE ERROR failure, or undefined if the
 * step should interpret the exit itself (pass/fail).
 *
 * Timeout and abort take precedence over everything. Shell exit 127 (command
 * not found) names the label and `commandKey` so the user can install the tool
 * or fix the command. OOM and native crashes return structured crash details
 * alongside a clear reason naming the active heap or suggesting `--node-heap`.
 * Shared by every command step, setup/teardown, and merge-base baseline runs.
 */
export function classifyCommandFailure(
  label: string,
  command: string,
  result: CommandResult,
  timeoutMs: number,
  options?: ClassifyCommandOptions,
): CommandFailure | undefined {
  if (result.timedOut) {
    return { kind: 'error', reason: `${label} timed out after ${timeoutMs}ms` };
  }
  if (options?.abortSignal?.aborted) {
    return { kind: 'error', reason: gateInterruptReason(options.abortSignal) };
  }
  if (result.spawnError || result.exitCode === 126) {
    const reason = commandFailureReason(command, result);
    return reason !== undefined ? { kind: 'error', reason } : undefined;
  }
  if (result.exitCode === 127) {
    const commandKey = options?.commandKey ?? `steps.${label}.command`;
    return {
      kind: 'error',
      reason: `${label}: command not found (exit 127); install the tool or fix ${commandKey}`,
    };
  }
  const crash = detectCrash(
    label,
    result,
    options?.nodeHeap ?? { kind: 'default' },
    options?.cwd ?? process.cwd(),
  );
  if (crash !== undefined) {
    return crash;
  }
  const reason = commandFailureReason(command, result);
  return reason !== undefined ? { kind: 'error', reason } : undefined;
}

export function commandFailureStep(
  name: StepName | 'setup' | 'teardown',
  failure: CommandFailure,
  prefix?: string,
): Extract<StepResult, { readonly kind: 'error' }> {
  const reason = prefix !== undefined ? `${prefix}: ${failure.reason}` : failure.reason;
  if (failure.kind === 'crash') {
    return { kind: 'error', name, reason, crash: failure.crash };
  }
  return { kind: 'error', name, reason };
}

export function commandFailureReason(command: string, result: CommandResult): string | undefined {
  if (result.spawnError) {
    // With shell:true, spawn ENOENT is a missing cwd or /bin/sh, not a missing tool.
    if (/ENOENT/i.test(result.spawnError)) {
      return `failed to start ${JSON.stringify(command)}: ${result.spawnError} (missing cwd or shell)`;
    }
    if (/not found/i.test(result.spawnError)) {
      return `command not found: ${command} (${result.spawnError})`;
    }
    return `failed to start ${JSON.stringify(command)}: ${result.spawnError}`;
  }
  if (result.signal) {
    return `command ${JSON.stringify(command)} killed by signal ${result.signal}`;
  }
  if (result.exitCode === null) {
    return `command ${JSON.stringify(command)} exited null`;
  }
  if (result.exitCode === 126) {
    return `command ${JSON.stringify(command)} is not executable (exit 126)`;
  }
  return undefined;
}
