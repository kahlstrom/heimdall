/**
 * Shared fixtures for step and runner tests so config/result builders live once.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseGateConfig } from '../../src/config.js';
import type { CommandResult, Finding, GateConfig, GateOutcome } from '../../src/types.js';

export function parseTestConfig(raw: unknown, configPath = 'heimdall.config.json'): GateConfig {
  const parsed = parseGateConfig(raw, configPath);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return parsed.value;
}

/**
 * Point `$HEIMDALL_HOME` at a fresh temp directory for the duration of `fn`, then
 * delete it. Never use the real `~/.heimdall` or `~/.gate` in tests.
 */
export async function withTempGateHome(fn: (gateHome: string) => Promise<void>): Promise<void> {
  const gateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-home-'));
  try {
    await withProcessEnv({ HEIMDALL_HOME: gateHome }, () => fn(gateHome), ['GATE_HOME']);
  } finally {
    fs.rmSync(gateHome, { recursive: true, force: true });
  }
}

export function writeHomeGateConfig(
  gateHome: string,
  repoName: string,
  raw: unknown,
  fileName = 'heimdall.config.json',
): string {
  const dir = path.join(gateHome, repoName);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, `${JSON.stringify(raw)}\n`);
  return filePath;
}

/**
 * Run `fn` with temporary process.env changes, then restore the previous
 * values. Missing keys in `unset` are deleted for the duration of `fn`.
 */
export async function withProcessEnv(
  overrides: NodeJS.ProcessEnv,
  fn: () => Promise<void>,
  unset: readonly string[] = [],
): Promise<void> {
  const keys = [...new Set([...Object.keys(overrides), ...unset])];
  const previous = new Map<string, string | undefined>();
  for (const key of keys) {
    previous.set(key, process.env[key]);
  }
  try {
    for (const key of unset) {
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

export function failFindings(outcome: GateOutcome): Finding[] {
  return outcome.steps.flatMap((step) => (step.kind === 'fail' ? [...step.findings] : []));
}

export function commandResult(partial: Partial<CommandResult> = {}): CommandResult {
  return {
    exitCode: partial.exitCode === undefined ? 0 : partial.exitCode,
    signal: partial.signal === undefined ? null : partial.signal,
    stdout: partial.stdout ?? '',
    stderr: partial.stderr ?? '',
    spawnError: partial.spawnError,
    timedOut: partial.timedOut ?? false,
  };
}
