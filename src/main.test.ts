import { describe, expect, it } from 'vitest';
import { HELP, main, parseArgs } from './main.js';
import { commitAll, withTempRepo, writeRepoFile } from '../test/helpers/temp-repo.js';

describe('parseArgs', () => {
  it('returns run with no args', () => {
    expect(parseArgs([])).toEqual({ kind: 'run' });
  });

  it('parses --config and --cwd', () => {
    expect(parseArgs(['--cwd', '/tmp/repo', '--config', 'heimdall.config.json'])).toEqual({
      kind: 'run',
      cwd: '/tmp/repo',
      configPath: 'heimdall.config.json',
    });
    expect(parseArgs(['--cwd=/tmp/repo', '--config=heimdall.config.json'])).toEqual({
      kind: 'run',
      cwd: '/tmp/repo',
      configPath: 'heimdall.config.json',
    });
  });

  it('parses --allow-wide', () => {
    expect(parseArgs(['--allow-wide'])).toEqual({ kind: 'run', allowWide: true });
    expect(parseArgs(['--cwd', '/tmp/repo', '--allow-wide'])).toEqual({
      kind: 'run',
      cwd: '/tmp/repo',
      allowWide: true,
    });
  });

  it('parses --base and --base=', () => {
    expect(parseArgs(['--base', 'feat/x'])).toEqual({ kind: 'run', baseRef: 'feat/x' });
    expect(parseArgs(['--base=origin/main'])).toEqual({ kind: 'run', baseRef: 'origin/main' });
  });

  it('requires a value for --base', () => {
    expect(parseArgs(['--base'])).toEqual({ kind: 'error', reason: '--base requires a ref' });
    expect(parseArgs(['--base='])).toEqual({ kind: 'error', reason: '--base requires a ref' });
    expect(parseArgs(['--base', '--allow-wide'])).toEqual({
      kind: 'error',
      reason: '--base requires a ref',
    });
  });

  it('returns help', () => {
    expect(parseArgs(['--help']).kind).toBe('help');
  });

  it('unknown arguments are a GATE ERROR payload', () => {
    const parsed = parseArgs(['--banana']);
    expect(parsed).toEqual({ kind: 'error', reason: 'unknown argument: --banana' });
  });

  it('requires a value for --config', () => {
    const parsed = parseArgs(['--config']);
    expect(parsed.kind).toBe('error');
  });

  it('requires a value for --cwd', () => {
    expect(parseArgs(['--cwd']).kind).toBe('error');
  });

  it('rejects an empty --cwd=', () => {
    const parsed = parseArgs(['--cwd=']);
    expect(parsed).toEqual({ kind: 'error', reason: '--cwd requires a path' });
  });

  it('rejects --cwd when the next token is another flag', () => {
    const parsed = parseArgs(['--cwd', '--config', 'x.json']);
    expect(parsed).toEqual({ kind: 'error', reason: '--cwd requires a path' });
  });
});

describe('main', () => {
  it('prints help and exits 0', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(['--help'], '/tmp', {
      stdout: { write(text) { stdout.push(text); } },
      stderr: { write(text) { stderr.push(text); } },
    });
    expect(code).toBe(0);
    expect(stdout.join('')).toBe(HELP);
    expect(stderr).toEqual([]);
  });

  it('runs the gate in a temp repo and prints GREEN', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'src/a.ts', 'export const a = 1;\n');
      writeRepoFile(
        repo,
        'heimdall.config.json',
        JSON.stringify({
          steps: { tests: { command: `${process.execPath} -e "process.exit(0)"` } },
        }),
      );
      commitAll(repo, 'init');
      const stdout: string[] = [];
      const code = await main(['--base', 'main'], repo, {
        stdout: { write(text) { stdout.push(text); } },
        stderr: { write() {} },
      });
      expect(code).toBe(0);
      const text = stdout.join('');
      expect(text.indexOf('base:')).toBeGreaterThan(-1);
      expect(text.indexOf('base:')).toBeLessThan(text.indexOf('HEIMDALL SUMMARY'));
      expect(text.indexOf('merge-base:')).toBeLessThan(text.indexOf('HEIMDALL SUMMARY'));
      expect(text.indexOf('changed files:')).toBeLessThan(text.indexOf('HEIMDALL SUMMARY'));
      expect(text).toMatch(/base:\s+main \(from --base\)/);
      expect(text).toMatch(/GREEN/);
    });
  });

  it('unknown flags exit 2 as GATE ERROR', async () => {
    const stderr: string[] = [];
    const code = await main(['--nope'], '/tmp', {
      stdout: { write() {} },
      stderr: { write(text) { stderr.push(text); } },
    });
    expect(code).toBe(2);
    expect(stderr.join('')).toMatch(/^GATE ERROR:/);
  });
});
