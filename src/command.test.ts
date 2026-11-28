import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyCommandFailure,
  combinedOutput,
  commandFailureReason,
  runCommand,
} from './command.js';
import { isProcessAlive, nodeCommand, waitForFile } from '../test/helpers/process.js';

describe('commandFailureReason', () => {
  it('maps spawn ENOENT to a missing cwd or shell, not a missing tool', () => {
    const reason = commandFailureReason('missing-bin', {
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      spawnError: 'spawn /bin/sh ENOENT',
      timedOut: false,
    });
    expect(reason).toMatch(/missing cwd or shell/);
    expect(reason).not.toMatch(/^command not found:/);
  });

  it('maps a non-ENOENT spawn failure', () => {
    const reason = commandFailureReason('npx knip', {
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      spawnError: 'EACCES: permission denied',
      timedOut: false,
    });
    expect(reason).toMatch(/failed to start/);
  });

  it('maps signals to a crash GATE ERROR', () => {
    const reason = commandFailureReason('npx knip', {
      exitCode: null,
      signal: 'SIGSEGV',
      stdout: '',
      stderr: '',
      spawnError: undefined,
      timedOut: false,
    });
    expect(reason).toMatch(/SIGSEGV/);
  });

  it('maps shell exit 126 to a not-executable GATE ERROR', () => {
    const reason = commandFailureReason('./tests.sh', {
      exitCode: 126,
      signal: null,
      stdout: '',
      stderr: 'Permission denied',
      spawnError: undefined,
      timedOut: false,
    });
    expect(reason).toMatch(/not executable/);
  });

  it('returns undefined for a normal non-zero exit', () => {
    const reason = commandFailureReason('npm test', {
      exitCode: 1,
      signal: null,
      stdout: 'FAIL',
      stderr: '',
      spawnError: undefined,
      timedOut: false,
    });
    expect(reason).toBeUndefined();
  });

  it('maps a null exit code without a signal to a GATE ERROR', () => {
    const reason = commandFailureReason('npx vitest run', {
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      spawnError: undefined,
      timedOut: false,
    });
    expect(reason).toMatch(/exited null/);
  });
});

describe('classifyCommandFailure', () => {
  it('names the step and timeout budget when timedOut', () => {
    const failure = classifyCommandFailure(
      'tests',
      'sleep 10',
      {
        exitCode: null,
        signal: 'SIGKILL',
        stdout: '',
        stderr: '',
        spawnError: undefined,
        timedOut: true,
      },
      200,
    );
    expect(failure).toEqual({ kind: 'error', reason: 'tests timed out after 200ms' });
  });

  it('names the interrupting signal', () => {
    const abort = new AbortController();
    abort.abort('SIGINT');
    const failure = classifyCommandFailure(
      'tests',
      'sleep 10',
      {
        exitCode: null,
        signal: 'SIGTERM',
        stdout: '',
        stderr: '',
        spawnError: undefined,
        timedOut: false,
      },
      300_000,
      { abortSignal: abort.signal },
    );
    expect(failure?.kind).toBe('error');
    expect(failure?.reason).toMatch(/heimdall interrupted \(SIGINT\)/);
  });

  it('names the step and config key when the command is missing (exit 127)', () => {
    const failure = classifyCommandFailure(
      'knip',
      'missing-bin',
      {
        exitCode: 127,
        signal: null,
        stdout: '',
        stderr: 'missing-bin: command not found',
        spawnError: undefined,
        timedOut: false,
      },
      300_000,
    );
    expect(failure).toEqual({
      kind: 'error',
      reason: 'knip: command not found (exit 127); install the tool or fix steps.knip.command',
    });
  });

  it('names the top-level setup key and failing command, not steps.setup.command', () => {
    const failure = classifyCommandFailure(
      'setup',
      'missing-setup-bin',
      {
        exitCode: 127,
        signal: null,
        stdout: '',
        stderr: 'missing-setup-bin: command not found',
        spawnError: undefined,
        timedOut: false,
      },
      300_000,
      { commandKey: 'setup[0] "missing-setup-bin"' },
    );
    expect(failure).toEqual({
      kind: 'error',
      reason: 'setup: command not found (exit 127); install the tool or fix setup[0] "missing-setup-bin"',
    });
    expect(failure?.reason).not.toMatch(/steps\.setup/);
  });

  it('classifies native crash signals with structured crash details and default heap hint', () => {
    for (const signal of ['SIGABRT', 'SIGSEGV', 'SIGBUS', 'SIGILL', 'SIGTRAP'] as const) {
      const failure = classifyCommandFailure(
        'eslint',
        'npx eslint -f json',
        {
          exitCode: null,
          signal,
          stdout: '',
          stderr: '',
          spawnError: undefined,
          timedOut: false,
        },
        300_000,
        { cwd: '/tmp/my-repo', nodeHeap: { kind: 'default' } },
      );
      expect(failure).toEqual({
        kind: 'crash',
        reason: `eslint crashed (${signal}); try --node-heap 8192`,
        crash: {
          signal,
          exitCode: null,
          heapMb: null,
          nodeVersion: process.version,
          repo: 'my-repo',
        },
      });
    }
  });

  it('classifies shell crash exit codes 134, 139, and 133 with structured crash details', () => {
    const cases: ReadonlyArray<readonly [number, NodeJS.Signals]> = [
      [134, 'SIGABRT'],
      [139, 'SIGSEGV'],
      [133, 'SIGTRAP'],
    ];
    for (const [exitCode, expectedSignal] of cases) {
      const failure = classifyCommandFailure(
        'eslint',
        'npx eslint -f json',
        {
          exitCode,
          signal: null,
          stdout: '',
          stderr: '',
          spawnError: undefined,
          timedOut: false,
        },
        300_000,
        { cwd: '/tmp/sample-app', nodeHeap: { kind: 'default' } },
      );
      expect(failure).toEqual({
        kind: 'crash',
        reason: `eslint crashed (exit ${exitCode} / ${expectedSignal}); try --node-heap 8192`,
        crash: {
          signal: null,
          exitCode,
          heapMb: null,
          nodeVersion: process.version,
          repo: 'sample-app',
        },
      });
    }
  });

  it('classifies V8 OOM stderr markers on non-zero exit as a crash, but not on exit 0', () => {
    for (const marker of [
      'JavaScript heap out of memory',
      'FATAL ERROR: Reached heap limit',
      'Allocation failed',
    ]) {
      const failure = classifyCommandFailure(
        'typecheck',
        'npx tsc --noEmit',
        {
          exitCode: 1,
          signal: null,
          stdout: '',
          stderr: `... ${marker} ...`,
          spawnError: undefined,
          timedOut: false,
        },
        300_000,
        { cwd: '/tmp/sample-app', nodeHeap: { kind: 'default' } },
      );
      expect(failure).toEqual({
        kind: 'crash',
        reason: 'typecheck crashed (OOM, exit 1); try --node-heap 8192',
        crash: {
          signal: null,
          exitCode: 1,
          heapMb: null,
          nodeVersion: process.version,
          repo: 'sample-app',
        },
      });

      const okRun = classifyCommandFailure(
        'tests',
        'npx vitest run',
        {
          exitCode: 0,
          signal: null,
          stdout: '',
          stderr: marker,
          spawnError: undefined,
          timedOut: false,
        },
        300_000,
      );
      expect(okRun).toBeUndefined();
    }
  });

  it('does not treat SIGKILL or exit 137 as a crash', () => {
    const killed = classifyCommandFailure(
      'eslint',
      'npx eslint -f json',
      {
        exitCode: null,
        signal: 'SIGKILL',
        stdout: '',
        stderr: 'JavaScript heap out of memory',
        spawnError: undefined,
        timedOut: false,
      },
      300_000,
    );
    expect(killed?.kind).toBe('error');
    expect(killed?.reason).toMatch(/SIGKILL/);

    const exit137 = classifyCommandFailure(
      'eslint',
      'npx eslint -f json',
      {
        exitCode: 137,
        signal: null,
        stdout: '',
        stderr: 'JavaScript heap out of memory',
        spawnError: undefined,
        timedOut: false,
      },
      300_000,
    );
    expect(exit137).toBeUndefined();
  });

  it('lets timeout and abort win over crash signals, exit 134, and OOM stderr', () => {
    const timedOut = classifyCommandFailure(
      'eslint',
      'npx eslint -f json',
      {
        exitCode: null,
        signal: 'SIGABRT',
        stdout: '',
        stderr: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
        spawnError: undefined,
        timedOut: true,
      },
      500,
    );
    expect(timedOut).toEqual({ kind: 'error', reason: 'eslint timed out after 500ms' });

    const abort = new AbortController();
    abort.abort('SIGTERM');
    const aborted = classifyCommandFailure(
      'eslint',
      'npx eslint -f json',
      {
        exitCode: 134,
        signal: null,
        stdout: '',
        stderr: 'JavaScript heap out of memory',
        spawnError: undefined,
        timedOut: false,
      },
      300_000,
      { abortSignal: abort.signal },
    );
    expect(aborted).toEqual({ kind: 'error', reason: 'heimdall interrupted (SIGTERM)' });
  });

  it('reports the active heap instead of suggesting --node-heap 8192 when heap is already configured', () => {
    const baseResult = {
      exitCode: 134,
      signal: null,
      stdout: '',
      stderr: 'FATAL ERROR: Reached heap limit',
      spawnError: undefined,
      timedOut: false,
    } as const;

    const fromCli = classifyCommandFailure('eslint', 'npx eslint -f json', baseResult, 300_000, {
      cwd: '/tmp/app',
      nodeHeap: { kind: 'configured', mb: 8192, source: 'cli' },
    });
    expect(fromCli?.kind).toBe('crash');
    if (fromCli?.kind === 'crash') {
      expect(fromCli.reason).toBe('eslint crashed (OOM, exit 134 / SIGABRT); node-heap was 8192 MB (from --node-heap)');
      expect(fromCli.reason).not.toContain('try --node-heap');
      expect(fromCli.crash.heapMb).toBe(8192);
    }

    const fromEnv = classifyCommandFailure('eslint', 'npx eslint -f json', baseResult, 300_000, {
      cwd: '/tmp/app',
      nodeHeap: { kind: 'configured', mb: 4096, source: 'env' },
    });
    expect(fromEnv?.kind).toBe('crash');
    if (fromEnv?.kind === 'crash') {
      expect(fromEnv.reason).toBe(
        'eslint crashed (OOM, exit 134 / SIGABRT); node-heap was 4096 MB (from HEIMDALL_NODE_HEAP_MB)',
      );
      expect(fromEnv.reason).not.toContain('try --node-heap');
      expect(fromEnv.crash.heapMb).toBe(4096);
    }

    const fromNodeOptions = classifyCommandFailure('eslint', 'npx eslint -f json', baseResult, 300_000, {
      cwd: '/tmp/app',
      nodeHeap: { kind: 'node-options', mb: 6144 },
    });
    expect(fromNodeOptions?.kind).toBe('crash');
    if (fromNodeOptions?.kind === 'crash') {
      expect(fromNodeOptions.reason).toBe(
        'eslint crashed (OOM, exit 134 / SIGABRT); node-heap was 6144 MB (from NODE_OPTIONS)',
      );
      expect(fromNodeOptions.reason).not.toContain('try --node-heap');
      expect(fromNodeOptions.crash.heapMb).toBe(6144);
    }

    const fromOpaqueNodeOptions = classifyCommandFailure('eslint', 'npx eslint -f json', baseResult, 300_000, {
      cwd: '/tmp/app',
      nodeHeap: { kind: 'node-options' },
    });
    expect(fromOpaqueNodeOptions?.kind).toBe('crash');
    if (fromOpaqueNodeOptions?.kind === 'crash') {
      expect(fromOpaqueNodeOptions.reason).toBe(
        'eslint crashed (OOM, exit 134 / SIGABRT); node-heap was set in NODE_OPTIONS',
      );
      expect(fromOpaqueNodeOptions.reason).not.toContain('try --node-heap');
      expect(fromOpaqueNodeOptions.crash.heapMb).toBeNull();
    }
  });
});

describe('combinedOutput', () => {
  it('joins stdout and stderr', () => {
    expect(
      combinedOutput({
        exitCode: 1,
        signal: null,
        stdout: 'out',
        stderr: 'err',
        spawnError: undefined,
        timedOut: false,
      }),
    ).toBe('out\nerr');
  });
});

describe('runCommand', () => {
  it('captures a successful node one-liner', async () => {
    const result = await runCommand(`${process.execPath} -e "process.stdout.write('ok')"`, process.cwd(), process.env);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok');
    expect(result.spawnError).toBeUndefined();
  });

  it('strips ANSI and OSC escape sequences from captured stdout and stderr even with FORCE_COLOR set', async () => {
    const command = nodeCommand(
      "const e = String.fromCharCode(27); const bel = String.fromCharCode(7); process.stdout.write(e + '[31m' + e + '[1mFAIL' + e + '[22m' + e + '[39m ' + e + ']8;;https://example.com' + bel + 'src/a.ts' + e + ']8;;' + bel); process.stderr.write(e + '[33mwarn' + e + '[0m: bad config');",
    );
    const result = await runCommand(command, process.cwd(), { ...process.env, FORCE_COLOR: '1' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('FAIL src/a.ts');
    expect(result.stderr).toBe('warn: bad config');
    expect(result.stdout).not.toContain('\x1b');
    expect(result.stderr).not.toContain('\x1b');
  });

  it('reports a missing binary as a spawn or shell-not-found error', async () => {
    const command = 'gate-definitely-missing-binary-xyz';
    const result = await runCommand(command, process.cwd(), process.env);
    const failure = classifyCommandFailure('typecheck', command, result, 300_000);
    expect(failure?.reason).toMatch(/not found/i);
  });

  it('never treats a signal-killed command as success', async () => {
    const result = await runCommand('kill -s TERM $$', process.cwd(), process.env, { timeoutMs: 1000 });
    expect(result.exitCode === 0).toBe(false);
    const reason = commandFailureReason('kill -s TERM $$', result);
    expect(reason).toBeDefined();
    expect(reason).toMatch(/SIGTERM/);
  });

  it('times out a hung command without sleeping the full command', async () => {
    const started = Date.now();
    const result = await runCommand(nodeCommand('setInterval(() => {}, 1000)'), process.cwd(), process.env, {
      timeoutMs: 200,
    });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode === null || result.signal !== null).toBe(true);
  });

  it('kills the whole process tree on timeout, including SIGTERM-ignoring children', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-tree-'));
    const parentPidFile = path.join(dir, 'parent.pid');
    const childPidFile = path.join(dir, 'child.pid');
    const childSrc = path.join(dir, 'child.js');
    const parentSrc = path.join(dir, 'parent.js');
    fs.writeFileSync(
      childSrc,
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n",
    );
    fs.writeFileSync(
      parentSrc,
      `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const child = spawn(process.execPath, ${JSON.stringify([childSrc])}, { stdio: 'ignore' });
fs.writeFileSync(process.env.GATE_PARENT_PID, String(process.pid));
fs.writeFileSync(process.env.GATE_CHILD_PID, String(child.pid));
setInterval(() => {}, 1000);
`,
    );
    const pending = runCommand(`${process.execPath} ${JSON.stringify(parentSrc)}`, dir, {
      ...process.env,
      GATE_PARENT_PID: parentPidFile,
      GATE_CHILD_PID: childPidFile,
    }, { timeoutMs: 500 });
    try {
      const parentPid = Number(await waitForFile(parentPidFile, 800));
      const childPid = Number(await waitForFile(childPidFile, 800));
      const result = await pending;
      expect(result.timedOut).toBe(true);
      expect(isProcessAlive(parentPid)).toBe(false);
      expect(isProcessAlive(childPid)).toBe(false);
    } finally {
      await pending;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('kills the process tree when the abort signal fires', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-abort-'));
    const pidFile = path.join(dir, 'hang.pid');
    const abort = new AbortController();
    const pending = runCommand(
      nodeCommand(`require('node:fs').writeFileSync(process.env.GATE_PID_FILE, String(process.pid)); setInterval(() => {}, 1000);`),
      dir,
      { ...process.env, GATE_PID_FILE: pidFile },
      { timeoutMs: 5000, signal: abort.signal },
    );
    try {
      const pid = Number(await waitForFile(pidFile, 800));
      abort.abort('SIGTERM');
      const result = await pending;
      expect(result.timedOut).toBe(false);
      expect(isProcessAlive(pid)).toBe(false);
      expect(result.exitCode === 0).toBe(false);
    } finally {
      await pending;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
