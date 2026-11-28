import { describe, expect, it } from 'vitest';
import { HELP, main, parseArgs } from './main.js';
import { withProcessEnv } from '../test/helpers/gate-test.js';
import { commitAll, git, withTempRepo, writeRepoFile } from '../test/helpers/temp-repo.js';

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

  it('parses --node-heap in space and = forms', () => {
    expect(parseArgs(['--node-heap', '8192'])).toEqual({ kind: 'run', nodeHeapMb: 8192 });
    expect(parseArgs(['--node-heap=8192'])).toEqual({ kind: 'run', nodeHeapMb: 8192 });
  });

  it('rejects missing, empty, non-integer, or non-positive --node-heap values', () => {
    for (const argv of [
      ['--node-heap'],
      ['--node-heap='],
      ['--node-heap', ''],
      ['--node-heap', '   '],
      ['--node-heap', '--allow-wide'],
      ['--node-heap', '0'],
      ['--node-heap=0'],
      ['--node-heap', '-1'],
      ['--node-heap=-1'],
      ['--node-heap', '4.5'],
      ['--node-heap=4.5'],
      ['--node-heap', 'abc'],
      ['--node-heap=8192mb'],
      ['--node-heap=1e4'],
    ]) {
      expect(parseArgs(argv).kind).toBe('error');
    }
  });

  it('documents --node-heap in HELP', () => {
    expect(HELP).toContain('--node-heap <mb>');
    expect(HELP).toContain('HEIMDALL_NODE_HEAP_MB');
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
      expect(text).toContain(`head:     ${git(repo, ['rev-parse', 'HEAD']).trim()}`);
      expect(text).toMatch(/GREEN/);
    });
  });

  const runCli = async (argv: readonly string[], cwd = '/tmp') => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(argv, cwd, {
      stdout: { write(text) { stdout.push(text); } },
      stderr: { write(text) { stderr.push(text); } },
    });
    return { code, stdout: stdout.join(''), stderr: stderr.join('') };
  };

  it('unknown flags exit 2 as GATE ERROR', async () => {
    const ran = await runCli(['--nope']);
    expect(ran.code).toBe(2);
    expect(ran.stderr).toMatch(/^GATE ERROR:/);
  });

  it('invalid --node-heap exits 2 as GATE ERROR', async () => {
    const ran = await runCli(['--node-heap', '0']);
    expect(ran.code).toBe(2);
    expect(ran.stderr).toMatch(/^GATE ERROR:.*--node-heap/);
  });

  it('passes --node-heap to child commands and reports the active limit in the summary', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'src/a.ts', 'export const a = 1;\n');
      writeRepoFile(
        repo,
        'heimdall.config.json',
        JSON.stringify({
          steps: {
            tests: {
              command: `${process.execPath} -e "if ((process.env.NODE_OPTIONS || '').includes('--max-old-space-size=8192')) process.exit(0); process.exit(1);"`,
            },
          },
        }),
      );
      commitAll(repo, 'init');
      await withProcessEnv({}, async () => {
        const stdout: string[] = [];
        const code = await main(['--base', 'main', '--node-heap=8192'], repo, {
          stdout: { write(text) { stdout.push(text); } },
          stderr: { write() {} },
        });
        expect(code).toBe(0);
        expect(stdout.join('')).toContain('node-heap: 8192 MB (from --node-heap)');
      }, ['NODE_OPTIONS', 'HEIMDALL_NODE_HEAP_MB']);
    });
  });
});
