/**
 * Contract tests: run the pinned eslint, knip, jscpd, and vitest binaries on
 * tiny fixtures and assert the gate parsers read that real output.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseTestRun } from '../src/flakes.js';
import { parseEslintOutput, parseJscpdOutput, parseKnipOutput } from '../src/parsers.js';

const GATE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function bin(name: string): string {
  return path.join(GATE_ROOT, 'node_modules', '.bin', name);
}

function isExecFailure(
  cause: unknown,
): cause is { status: number | null; stdout?: string; stderr?: string } {
  return typeof cause === 'object' && cause !== null && 'status' in cause;
}

function writeFile(dir: string, rel: string, contents: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

function runTool(
  name: string,
  args: readonly string[],
  cwd: string,
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(bin(name), [...args], {
      cwd,
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (cause) {
    if (isExecFailure(cause)) {
      return {
        status: cause.status ?? 1,
        stdout: typeof cause.stdout === 'string' ? cause.stdout : '',
        stderr: typeof cause.stderr === 'string' ? cause.stderr : '',
      };
    }
    throw cause;
  }
}

async function withFixture(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-tool-'));
  try {
    await fn(dir);
  } finally {
    const linked = path.join(dir, 'node_modules');
    try {
      fs.lstatSync(linked);
      fs.unlinkSync(linked);
    } catch {
      // no symlink
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function linkNodeModules(dir: string): void {
  fs.symlinkSync(path.join(GATE_ROOT, 'node_modules'), path.join(dir, 'node_modules'));
}

const ESLINT_CONFIG = `export default [
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    rules: { 'no-unused-vars': 'error' },
  },
];
`;

function functionBody(name: string): string {
  const lines = [`export function ${name}() {`];
  for (let index = 0; index < 24; index += 1) {
    lines.push(`  const ${name}${index} = ${index};`);
  }
  lines.push('  return 1;', '}', '');
  return lines.join('\n');
}

describe('real eslint JSON', () => {
  it('parses a clean run as no findings', async () => {
    await withFixture((dir) => {
      writeFile(dir, 'package.json', JSON.stringify({ name: 'eslint-pass', type: 'module' }));
      writeFile(dir, 'eslint.config.js', ESLINT_CONFIG);
      writeFile(dir, 'src/ok.js', 'export const n = 1;\n');
      const ran = runTool('eslint', ['src', '-f', 'json'], dir);
      expect(ran.status).toBe(0);
      const parsed = parseEslintOutput(ran.stdout);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value.errors).toEqual([]);
        expect(parsed.value.warnings).toEqual([]);
      }
    });
  });

  it('parses an unused-var finding from a failing run', async () => {
    await withFixture((dir) => {
      writeFile(dir, 'package.json', JSON.stringify({ name: 'eslint-fail', type: 'module' }));
      writeFile(dir, 'eslint.config.js', ESLINT_CONFIG);
      writeFile(dir, 'src/bad.js', 'const leftover = 1;\nexport const n = leftover;\nconst unused = 2;\n');
      const ran = runTool('eslint', ['src', '-f', 'json'], dir);
      expect(ran.status).not.toBe(0);
      const parsed = parseEslintOutput(ran.stdout);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(
          parsed.value.errors.some((hit) => hit.rule === 'no-unused-vars' && hit.message.includes('unused')),
        ).toBe(true);
      }
    });
  });
});

describe('real knip JSON', () => {
  it('parses a clean project as no findings', async () => {
    await withFixture((dir) => {
      writeFile(dir, 'package.json', JSON.stringify({ name: 'knip-pass', type: 'module' }));
      writeFile(dir, 'knip.json', JSON.stringify({ entry: ['src/index.js'], project: ['src/**/*.js'] }));
      writeFile(dir, 'src/index.js', 'export const n = 1;\n');
      const ran = runTool('knip', ['--reporter', 'json', '--no-progress'], dir);
      expect(ran.status).toBe(0);
      const parsed = parseKnipOutput(ran.stdout);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value).toEqual([]);
      }
    });
  });

  it('parses an unused file from a failing run', async () => {
    await withFixture((dir) => {
      writeFile(dir, 'package.json', JSON.stringify({ name: 'knip-fail', type: 'module' }));
      writeFile(dir, 'knip.json', JSON.stringify({ entry: ['src/index.js'], project: ['src/**/*.js'] }));
      writeFile(dir, 'src/index.js', 'export const n = 1;\n');
      writeFile(dir, 'src/orphan.js', 'export const leftover = 1;\n');
      const ran = runTool('knip', ['--reporter', 'json', '--no-progress'], dir);
      expect(ran.status).not.toBe(0);
      const parsed = parseKnipOutput(ran.stdout);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value.some((hit) => hit.rule === 'files' && hit.file.includes('orphan'))).toBe(true);
      }
    });
  });
});

const JSCPD_ARGS = ['src', '--reporters', 'json', '--silent', '--min-lines', '5', '--min-tokens', '10'] as const;

function jscpdReport(dir: string): string {
  const output = path.join(dir, 'out');
  fs.mkdirSync(output, { recursive: true });
  runTool('jscpd', [...JSCPD_ARGS, '--output', output], dir);
  return fs.readFileSync(path.join(output, 'jscpd-report.json'), 'utf8');
}

describe('real jscpd JSON', () => {
  it('parses a project without clones as no findings', async () => {
    await withFixture((dir) => {
      writeFile(dir, 'src/a.js', functionBody('alpha'));
      writeFile(dir, 'src/b.js', functionBody('beta'));
      const parsed = parseJscpdOutput(jscpdReport(dir));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value).toEqual([]);
      }
    });
  });

  it('parses clone sides from a failing run', async () => {
    await withFixture((dir) => {
      const clone = functionBody('repeated');
      writeFile(dir, 'src/a.js', clone);
      writeFile(dir, 'src/b.js', clone);
      const parsed = parseJscpdOutput(jscpdReport(dir));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value.length).toBeGreaterThanOrEqual(2);
        expect(parsed.value.some((hit) => hit.rule === 'duplicate' && hit.file.includes('a.js'))).toBe(true);
        expect(parsed.value.some((hit) => hit.rule === 'duplicate' && hit.file.includes('b.js'))).toBe(true);
      }
    });
  });
});

describe('real vitest JSON', () => {
  it('parses a passing run as no failures', async () => {
    await withFixture((dir) => {
      writeFile(dir, 'package.json', JSON.stringify({ name: 'vitest-pass', type: 'module' }));
      linkNodeModules(dir);
      writeFile(
        dir,
        'src/ok.test.js',
        `import { describe, it, expect } from 'vitest';
describe('math', () => {
  it('adds', () => { expect(1 + 1).toBe(2); });
});
`,
      );
      const ran = runTool('vitest', ['run', '--reporter=json'], dir);
      expect(ran.status).toBe(0);
      const parsed = parseTestRun(ran.stdout, `${ran.stdout}\n${ran.stderr}`);
      expect(parsed ?? []).toEqual([]);
    });
  });

  it('parses a failing test name from a failing run', async () => {
    await withFixture((dir) => {
      writeFile(dir, 'package.json', JSON.stringify({ name: 'vitest-fail', type: 'module' }));
      linkNodeModules(dir);
      writeFile(
        dir,
        'src/bad.test.js',
        `import { describe, it, expect } from 'vitest';
describe('math', () => {
  it('adds', () => { expect(1 + 1).toBe(3); });
});
`,
      );
      const ran = runTool('vitest', ['run', '--reporter=json'], dir);
      expect(ran.status).not.toBe(0);
      const parsed = parseTestRun(ran.stdout, `${ran.stdout}\n${ran.stderr}`);
      expect(parsed).toBeDefined();
      expect(parsed?.some((hit) => hit.name === 'math > adds' && hit.file.includes('bad.test.js'))).toBe(true);
    });
  });
});
