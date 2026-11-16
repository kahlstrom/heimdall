import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { startGateCli } from './cli-start.js';
import { EXIT_GATE_ERROR, EXIT_GREEN } from './types.js';
import { isProcessAlive, waitForFile } from '../test/helpers/process.js';
import { commitAll, withTempRepo, writeRepoFile } from '../test/helpers/temp-repo.js';

class DelayedWritable extends Writable {
  flushed = false;

  override _write(chunk: Buffer, encoding: string, callback: (error?: Error | null) => void): void {
    setTimeout(() => {
      this.flushed = true;
      callback();
    }, 20);
  }
}

class FakeRuntime extends EventEmitter {
  argv = ['node', 'cli.js'];
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  exitCode: number | string | null | undefined;
  readonly exitCodes: number[] = [];
  readonly stderrChunks: Buffer[] = [];
  cwd = (): string => '/tmp';

  constructor(streams?: { stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream }) {
    super();
    this.stdout = streams?.stdout ?? this.capturingStream(this.stderrChunks);
    this.stderr = streams?.stderr ?? this.capturingStream(this.stderrChunks);
  }

  private capturingStream(chunks: Buffer[]): NodeJS.WritableStream {
    const stream = new Writable({
      write(chunk, encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    return stream;
  }

  exit(code?: number): void {
    this.exitCode = code ?? this.exitCode;
    if (typeof code === 'number') {
      this.exitCodes.push(code);
    }
  }

  stderrText(): string {
    return Buffer.concat(this.stderrChunks).toString('utf8');
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('timed out waiting for CLI crash handling');
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('startGateCli', () => {
  it('treats a missing main module as GATE ERROR exit 2', async () => {
    const runtime = new FakeRuntime();
    await startGateCli({
      proc: runtime,
      argv: [],
      cwd: '/tmp',
      loadMain: async () => {
        throw Object.assign(new Error("Cannot find module './main.js'"), { code: 'ERR_MODULE_NOT_FOUND' });
      },
    });
    expect(runtime.exitCode).toBe(EXIT_GATE_ERROR);
    expect(runtime.stderrText()).toMatch(/GATE ERROR: unexpected exception/);
    expect(runtime.stderrText()).toMatch(/Cannot find module/);
    expect(runtime.stderrText()).not.toMatch(/result:\s+RED/);
  });

  it('treats an uncaught exception as GATE ERROR exit 2, not red', async () => {
    const runtime = new FakeRuntime();
    await startGateCli({
      proc: runtime,
      argv: [],
      cwd: '/tmp',
      loadMain: async () => ({ main: async () => EXIT_GREEN }),
    });
    runtime.emit('uncaughtException', new Error('listener threw'));
    await waitFor(() => runtime.exitCodes.includes(EXIT_GATE_ERROR));
    expect(runtime.exitCode).toBe(EXIT_GATE_ERROR);
    expect(runtime.stderrText()).toMatch(/GATE ERROR: uncaught exception: listener threw/);
    expect(runtime.stderrText()).not.toMatch(/result:\s+RED/);
  });

  it('treats stdout EPIPE as GATE ERROR exit 2', async () => {
    const runtime = new FakeRuntime();
    await startGateCli({
      proc: runtime,
      argv: [],
      cwd: '/tmp',
      loadMain: async () => ({ main: async () => EXIT_GREEN }),
    });
    runtime.stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    await waitFor(() => runtime.exitCodes.includes(EXIT_GATE_ERROR));
    expect(runtime.exitCode).toBe(EXIT_GATE_ERROR);
    expect(runtime.stderrText()).toMatch(/GATE ERROR: stdout closed \(EPIPE\)/);
  });

  it('flushes stdio before returning so the summary is not truncated', async () => {
    const stdout = new DelayedWritable();
    const stderr = new DelayedWritable();
    const runtime = new FakeRuntime({ stdout, stderr });
    await startGateCli({
      proc: runtime,
      argv: [],
      cwd: '/tmp',
      loadMain: async () => ({ main: async () => EXIT_GREEN }),
    });
    expect(stdout.flushed).toBe(true);
    expect(stderr.flushed).toBe(true);
    expect(runtime.exitCode).toBe(EXIT_GREEN);
  });

  async function expectStopSignalKillsStepTree(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
    await withTempRepo(async (repo) => {
      const pidFile = path.join(repo, 'hang.pid');
      writeRepoFile(
        repo,
        'heimdall.config.json',
        JSON.stringify({
          steps: {
            tests: {
              command: `${process.execPath} -e ${JSON.stringify(
                `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
              )}`,
              timeoutMs: 5000,
            },
          },
        }),
      );
      commitAll(repo, 'init');
      const runtime = new FakeRuntime();
      const done = startGateCli({
        proc: runtime,
        argv: [],
        cwd: repo,
      });
      const pid = Number(await waitForFile(pidFile, 1000));
      runtime.emit(signal);
      await done;
      expect(runtime.exitCode).not.toBe(0);
      expect(runtime.exitCode).toBe(EXIT_GATE_ERROR);
      expect(isProcessAlive(pid)).toBe(false);
    });
  }

  it('SIGINT kills the running step tree and exits non-zero', async () => {
    await expectStopSignalKillsStepTree('SIGINT');
  });

  it('SIGTERM kills the running step tree and exits non-zero', async () => {
    await expectStopSignalKillsStepTree('SIGTERM');
  });

  it('treats an unhandled rejection as GATE ERROR exit 2', async () => {
    const runtime = new FakeRuntime();
    await startGateCli({
      proc: runtime,
      argv: [],
      cwd: '/tmp',
      loadMain: async () => ({ main: async () => EXIT_GREEN }),
    });
    runtime.emit('unhandledRejection', new Error('promise rejected'));
    await waitFor(() => runtime.exitCodes.includes(EXIT_GATE_ERROR));
    expect(runtime.stderrText()).toMatch(/GATE ERROR: unhandled rejection: promise rejected/);
  });
});

describe('cli.ts boot', () => {
  it('a missing dist module from the bin entry exits 2 as GATE ERROR', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-cli-boot-'));
    try {
      const cliSource = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.ts'), 'utf8');
      const transpiled = ts.transpileModule(cliSource, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
        fileName: 'cli.ts',
      });
      const cliPath = path.join(dir, 'cli.mjs');
      fs.writeFileSync(cliPath, transpiled.outputText);
      const child = spawnSync(process.execPath, [cliPath], { encoding: 'utf8' });
      expect(child.status).toBe(EXIT_GATE_ERROR);
      expect(child.stderr).toMatch(/GATE ERROR: unexpected exception/);
      expect(child.status).not.toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
