/**
 * Process-level boot for the Heimdall CLI. Crashes here must exit 2 (GATE ERROR),
 * never Node's default 1 which agents read as red. Stdio is flushed before
 * exit so a piped `HEIMDALL SUMMARY` is not truncated (nodejs/node#6379).
 */
import { EXIT_GATE_ERROR, errorMessage, type ExitCode } from './types.js';
import type { CliIo } from './main.js';

type MainFn = (
  argv: readonly string[],
  defaultCwd: string,
  io: CliIo,
  abortSignal?: AbortSignal,
) => Promise<ExitCode>;

type CliRuntime = {
  argv: string[];
  cwd: () => string;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  exitCode: number | string | null | undefined;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  exit(code?: number): void;
};

type StartGateCliOptions = {
  readonly loadMain?: () => Promise<{ main: MainFn }>;
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly proc?: CliRuntime;
};

function writeGateError(stderr: NodeJS.WritableStream, message: string): void {
  try {
    stderr.write(`GATE ERROR: ${message}\n`);
  } catch {
    // stderr may already be closed (EPIPE)
  }
}

function setBlocking(stream: NodeJS.WritableStream): void {
  try {
    if (!('_handle' in stream)) {
      return;
    }
    const handle = stream._handle;
    if (typeof handle !== 'object' || handle === null || !('setBlocking' in handle)) {
      return;
    }
    const setBlockingFn = handle.setBlocking;
    if (typeof setBlockingFn === 'function') {
      setBlockingFn.call(handle, true);
    }
  } catch {
    // Best-effort; flushStdio still waits on write callbacks.
  }
}

function setBlockingStdio(proc: Pick<CliRuntime, 'stdout' | 'stderr'>): void {
  setBlocking(proc.stdout);
  setBlocking(proc.stderr);
}

function streamIsEnded(stream: NodeJS.WritableStream): boolean {
  if (!stream.writable) {
    return true;
  }
  if ('destroyed' in stream && stream.destroyed === true) {
    return true;
  }
  return 'writableEnded' in stream && stream.writableEnded === true;
}

function flushWritable(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve) => {
    if (streamIsEnded(stream)) {
      resolve();
      return;
    }
    const finish = (): void => resolve();
    try {
      if ('writableNeedDrain' in stream && stream.writableNeedDrain === true) {
        stream.once('drain', finish);
        stream.once('error', finish);
        return;
      }
      stream.write('', finish);
    } catch {
      finish();
    }
  });
}

function flushStdio(proc: Pick<CliRuntime, 'stdout' | 'stderr'>): Promise<void> {
  return Promise.all([flushWritable(proc.stdout), flushWritable(proc.stderr)]).then(() => undefined);
}

function isPipeClosed(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) {
    return false;
  }
  return cause.code === 'EPIPE';
}

function onStreamError(stream: NodeJS.WritableStream, handler: (cause: unknown) => void): void {
  if (typeof stream.on === 'function') {
    stream.on('error', handler);
  }
}

/**
 * Turn process-level crashes into GATE ERROR (exit 2) and flush before exit.
 * Without these handlers Node prints the exception and exits 1, which agents
 * treat as red app code.
 */
function installStopHandlers(proc: CliRuntime, abort: AbortController): () => void {
  const onSigint = (): void => {
    abort.abort('SIGINT');
  };
  const onSigterm = (): void => {
    abort.abort('SIGTERM');
  };
  proc.on('SIGINT', onSigint);
  proc.on('SIGTERM', onSigterm);
  return () => {
    proc.off?.('SIGINT', onSigint);
    proc.off?.('SIGTERM', onSigterm);
  };
}

function installCrashGuards(proc: CliRuntime): void {
  const fail = (kind: string, cause: unknown): void => {
    writeGateError(proc.stderr, `${kind}: ${errorMessage(cause)}`);
    proc.exitCode = EXIT_GATE_ERROR;
    const flushed = flushStdio(proc);
    flushed.finally(() => {
      proc.exit(EXIT_GATE_ERROR);
    });
  };
  proc.on('uncaughtException', (error) => fail('uncaught exception', error));
  proc.on('unhandledRejection', (reason) => fail('unhandled rejection', reason));
  onStreamError(proc.stdout, (cause) => {
    if (isPipeClosed(cause)) {
      fail('stdout closed (EPIPE)', cause);
    }
  });
}

export async function startGateCli(options: StartGateCliOptions = {}): Promise<void> {
  const proc = options.proc ?? process;
  setBlockingStdio(proc);
  installCrashGuards(proc);
  const abort = new AbortController();
  const uninstallStop = installStopHandlers(proc, abort);
  try {
    const loaded = await (options.loadMain ?? (() => import('./main.js')))();
    const argv = options.argv ?? proc.argv.slice(2);
    const cwd = options.cwd ?? proc.cwd();
    const code = await loaded.main(argv, cwd, proc, abort.signal);
    proc.exitCode = code;
    await flushStdio(proc);
  } catch (cause) {
    writeGateError(proc.stderr, `unexpected exception: ${errorMessage(cause)}`);
    proc.exitCode = EXIT_GATE_ERROR;
    await flushStdio(proc);
  } finally {
    uninstallStop();
  }
}
