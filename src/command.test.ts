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
    const reason = classifyCommandFailure(
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
    expect(reason).toBe('tests timed out after 200ms');
  });

  it('names the interrupting signal', () => {
    const abort = new AbortController();
    abort.abort('SIGINT');
    const reason = classifyCommandFailure(
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
      abort.signal,
    );
    expect(reason).toMatch(/heimdall interrupted \(SIGINT\)/);
  });

  it('names the step and config key when the command is missing (exit 127)', () => {
    const reason = classifyCommandFailure(
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
    expect(reason).toBe(
      'knip: command not found (exit 127); install the tool or fix steps.knip.command',
    );
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

  it('reports a missing binary as a spawn or shell-not-found error', async () => {
    const command = 'gate-definitely-missing-binary-xyz';
    const result = await runCommand(command, process.cwd(), process.env);
    const reason = classifyCommandFailure('typecheck', command, result, 300_000);
    expect(reason).toMatch(/not found/i);
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
