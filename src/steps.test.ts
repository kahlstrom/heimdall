import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCommand } from './command.js';
import {
  architectureStep,
  eslintStep,
  findingsAtMergeBase,
  jscpdStep,
  knipStep,
  lineChecksStep,
  secretsStep,
  testsStep,
  typecheckStep,
  type StepContext,
} from './steps.js';
import { formatFinding } from './report.js';
import { err, ok, type DiffScope, type Finding, type GateConfig, type Result } from './types.js';
import { commandResult as result, parseTestConfig as cfg } from '../test/helpers/gate-test.js';
import { commitAll, git, withTempRepo, writeRepoFile } from '../test/helpers/temp-repo.js';

const GATE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KNIP_BIN = path.join(GATE_ROOT, 'node_modules', '.bin', 'knip');
const VITEST_BIN = path.join(GATE_ROOT, 'node_modules', '.bin', 'vitest');

const STEP_FILES = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-step-files-'));
fs.mkdirSync(path.join(STEP_FILES, 'src'), { recursive: true });
fs.writeFileSync(path.join(STEP_FILES, 'src/a.ts'), 'export const a = 1;\n');
fs.writeFileSync(path.join(STEP_FILES, 'src/old.ts'), 'export const old = 1;\n');
fs.writeFileSync(path.join(STEP_FILES, 'src/legacy.ts'), 'export const legacy = 1;\n');

const emptyScope: DiffScope = {
  baseRef: 'main',
  mergeBaseSha: 'a',
  changedFiles: new Set(['src/a.ts']),
  addedLines: new Map([['src/a.ts', new Set([1])]]),
};

function ctx(overrides: Partial<StepContext> & { config: GateConfig; runCommand: StepContext['runCommand'] }): StepContext {
  return {
    cwd: STEP_FILES,
    tmpDir: '/tmp/gate-run',
    scope: emptyScope,
    env: process.env,
    ...overrides,
  };
}

describe('typecheckStep', () => {
  it('is a GATE ERROR when tsc fails with no parseable errors', async () => {
    const step = await typecheckStep.run(
      ctx({
        config: cfg({ steps: { typecheck: { command: 'npx tsc --noEmit' } } }),
        runCommand: async () => result({ exitCode: 1, stdout: 'tsc: something broke' }),
      }),
    );
    expect(step.kind).toBe('error');
  });

  it('passes when tsc exits 0', async () => {
    const step = await typecheckStep.run(
      ctx({
        config: cfg({ steps: { typecheck: { command: 'npx tsc --noEmit' } } }),
        runCommand: async () => result({ exitCode: 0, stdout: '' }),
      }),
    );
    expect(step.kind).toBe('pass');
  });

  it('is red when tsc prints a type error', async () => {
    const step = await typecheckStep.run(
      ctx({
        config: cfg({ steps: { typecheck: { command: 'npx tsc --noEmit' } } }),
        runCommand: async () =>
          result({
            exitCode: 1,
            stdout: "src/a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
          }),
      }),
    );
    expect(step.kind).toBe('fail');
  });
});

const NODE_STDERR_WARNING =
  '(node:1234) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Treating eslint.config.js as ES module [DEP0040]\n';

describe('eslintStep', () => {
  it('is a GATE ERROR when eslint fails with unparseable output', async () => {
    const step = await eslintStep.run(
      ctx({
        config: cfg({ steps: { eslint: { command: 'npx eslint -f json' } } }),
        runCommand: async () => result({ exitCode: 2, stdout: 'eslint config is broken' }),
      }),
    );
    expect(step.kind).toBe('error');
  });

  it('is a GATE ERROR when eslint exits 0 with unparseable output', async () => {
    const step = await eslintStep.run(
      ctx({
        config: cfg({ steps: { eslint: { command: 'npx eslint -f json' } } }),
        runCommand: async () => result({ exitCode: 0, stdout: 'eslint ran with warnings' }),
      }),
    );
    expect(step.kind).toBe('error');
  });

  it('parses JSON from stdout when stderr has a Node warning', async () => {
    const step = await eslintStep.run(
      ctx({
        config: cfg({ steps: { eslint: { command: 'npx eslint -f json' } } }),
        runCommand: async () =>
          result({
            exitCode: 1,
            stdout: JSON.stringify([
              {
                filePath: path.join(STEP_FILES, 'src/a.ts'),
                messages: [{ line: 1, ruleId: 'eqeqeq', message: 'use ===', severity: 2 }],
              },
            ]),
            stderr: NODE_STDERR_WARNING,
          }),
      }),
    );
    expect(step.kind).toBe('fail');
  });

  it('does not parse eslint JSON that appears only on stderr', async () => {
    const step = await eslintStep.run(
      ctx({
        config: cfg({ steps: { eslint: { command: 'npx eslint -f json' } } }),
        runCommand: async () => result({ exitCode: 0, stdout: '', stderr: '[]' }),
      }),
    );
    expect(step.kind).toBe('error');
  });

  it('passes when eslint exits 0', async () => {
    const step = await eslintStep.run(
      ctx({
        config: cfg({ steps: { eslint: { command: 'npx eslint -f json' } } }),
        runCommand: async () => result({ exitCode: 0, stdout: '[]' }),
      }),
    );
    expect(step.kind).toBe('pass');
  });

  it('passes when the only findings are outside the diff', async () => {
    const step = await eslintStep.run(
      ctx({
        config: cfg({ steps: { eslint: { command: 'npx eslint -f json' } } }),
        runCommand: async () =>
          result({
            exitCode: 1,
            stdout: JSON.stringify([
              {
                filePath: path.join(STEP_FILES, 'src/old.ts'),
                messages: [{ line: 1, ruleId: 'eqeqeq', message: 'use ===', severity: 2 }],
              },
            ]),
          }),
      }),
    );
    expect(step.kind).toBe('pass');
  });

  it('does not pass when killed by a signal even if findings are out of scope', async () => {
    const step = await eslintStep.run(
      ctx({
        config: cfg({ steps: { eslint: { command: 'npx eslint -f json' } } }),
        runCommand: async () =>
          result({
            exitCode: null,
            signal: 'SIGTERM',
            stdout: JSON.stringify([
              {
                filePath: path.join(STEP_FILES, 'src/old.ts'),
                messages: [{ line: 1, ruleId: 'eqeqeq', message: 'use ===', severity: 2 }],
              },
            ]),
          }),
      }),
    );
    expect(step.kind).not.toBe('pass');
    if (step.kind === 'error') {
      expect(step.reason).toMatch(/SIGTERM/);
    }
  });

  it('is a GATE ERROR when a finding cannot be mapped to a repo file', async () => {
    const step = await eslintStep.run(
      ctx({
        config: cfg({ steps: { eslint: { command: 'npx eslint -f json' } } }),
        runCommand: async () =>
          result({
            exitCode: 1,
            stdout: JSON.stringify([
              {
                filePath: '/elsewhere/src/a.ts',
                messages: [{ line: 1, ruleId: 'eqeqeq', message: 'use ===', severity: 2 }],
              },
            ]),
          }),
      }),
    );
    expect(step.kind).toBe('error');
    if (step.kind === 'error') {
      expect(step.reason).toMatch(/cannot map finding to a file in the repo/);
    }
  });

  it('is a GATE ERROR when a finding path is inside the repo but the file does not exist', async () => {
    const step = await eslintStep.run(
      ctx({
        config: cfg({ steps: { eslint: { command: 'npx eslint -f json' } } }),
        runCommand: async () =>
          result({
            exitCode: 1,
            stdout: JSON.stringify([
              {
                filePath: 'src/does-not-exist.ts',
                messages: [{ line: 1, ruleId: 'eqeqeq', message: 'use ===', severity: 2 }],
              },
            ]),
          }),
      }),
    );
    expect(step.kind).toBe('error');
    if (step.kind === 'error') {
      expect(step.reason).toMatch(/cannot map finding to a file in the repo/);
    }
  });

  it('ignores warnings when maxWarnings is absent', async () => {
    const step = await eslintStep.run(
      ctx({
        config: cfg({ steps: { eslint: { command: 'npx eslint -f json' } } }),
        runCommand: async () =>
          result({
            exitCode: 0,
            stdout: JSON.stringify([
              {
                filePath: path.join(STEP_FILES, 'src/a.ts'),
                messages: [{ line: 1, ruleId: 'no-console', message: 'unexpected console', severity: 1 }],
              },
            ]),
          }),
      }),
    );
    expect(step.kind).toBe('pass');
  });

  it('is red when maxWarnings is 0 and there is one new warning', async () => {
    const file = path.join(STEP_FILES, 'src/a.ts');
    const step = await eslintStep.run(
      ctx({
        config: cfg({ steps: { eslint: { command: 'npx eslint -f json', maxWarnings: 0 } } }),
        runCommand: async () =>
          result({
            exitCode: 0,
            stdout: JSON.stringify([
              {
                filePath: file,
                messages: [{ line: 1, ruleId: 'no-console', message: 'unexpected console', severity: 1 }],
              },
            ]),
          }),
      }),
    );
    expect(step.kind).toBe('fail');
    if (step.kind === 'fail') {
      expect(step.findings.map(formatFinding)).toEqual([`${file}:1 [no-console] unexpected console`]);
    }
  });

  it('passes when new warnings do not exceed maxWarnings', async () => {
    const step = await eslintStep.run(
      ctx({
        config: cfg({ steps: { eslint: { command: 'npx eslint -f json', maxWarnings: 2 } } }),
        runCommand: async () =>
          result({
            exitCode: 0,
            stdout: JSON.stringify([
              {
                filePath: path.join(STEP_FILES, 'src/a.ts'),
                messages: [
                  { line: 1, ruleId: 'no-console', message: 'unexpected console', severity: 1 },
                  { line: 1, ruleId: 'no-debugger', message: 'unexpected debugger', severity: 1 },
                ],
              },
            ]),
          }),
      }),
    );
    expect(step.kind).toBe('pass');
  });

  it('ignores warnings on unchanged lines even when maxWarnings is set', async () => {
    const step = await eslintStep.run(
      ctx({
        config: cfg({ steps: { eslint: { command: 'npx eslint -f json', maxWarnings: 0 } } }),
        runCommand: async () =>
          result({
            exitCode: 0,
            stdout: JSON.stringify([
              {
                filePath: path.join(STEP_FILES, 'src/a.ts'),
                messages: [{ line: 2, ruleId: 'no-console', message: 'unexpected console', severity: 1 }],
              },
            ]),
          }),
      }),
    );
    expect(step.kind).toBe('pass');
  });

  it('still fails on new errors when maxWarnings is set', async () => {
    const step = await eslintStep.run(
      ctx({
        config: cfg({ steps: { eslint: { command: 'npx eslint -f json', maxWarnings: 5 } } }),
        runCommand: async () =>
          result({
            exitCode: 1,
            stdout: JSON.stringify([
              {
                filePath: path.join(STEP_FILES, 'src/a.ts'),
                messages: [{ line: 1, ruleId: 'eqeqeq', message: 'use ===', severity: 2 }],
              },
            ]),
          }),
      }),
    );
    expect(step.kind).toBe('fail');
  });
});

const SECRETS_LEAK = 'ghp_LEAKEDSECRETVALUE_doNotPrint';

function secretsJson(filePath: string, line: number, ruleId = '@secretlint/secretlint-rule-github'): string {
  return JSON.stringify([
    {
      filePath,
      messages: [
        {
          ruleId,
          message: `found GitHub Token: ${SECRETS_LEAK}`,
          data: { ID: SECRETS_LEAK },
          loc: { start: { line, column: 1 }, end: { line, column: 40 } },
        },
      ],
    },
  ]);
}

describe('secretsStep', () => {
  it('is off unless the repo config enables it with a command', () => {
    expect(secretsStep.isEnabled(cfg({ steps: { tests: { command: 't' } } }))).toBe(false);
    expect(
      secretsStep.isEnabled(cfg({ steps: { tests: { command: 't' }, secrets: { enabled: false } } })),
    ).toBe(false);
    expect(secretsStep.isEnabled(cfg({ steps: { secrets: { command: 'secretlint --format json "**/*"' } } }))).toBe(
      true,
    );
  });

  it('is a GATE ERROR with no tool text when secrets output is unparseable', async () => {
    const step = await secretsStep.run(
      ctx({
        config: cfg({ steps: { secrets: { command: 'secretlint --format json "**/*"' } } }),
        runCommand: async () =>
          result({
            exitCode: 1,
            stdout: `{ "found": "${SECRETS_LEAK}"`,
            stderr: `secretlint: matched ${SECRETS_LEAK}`,
          }),
      }),
    );
    expect(step.kind).toBe('error');
    if (step.kind === 'error') {
      expect(step.reason).toBe('secrets output is not JSON (exit 1)');
      expect(step.reason).not.toContain(SECRETS_LEAK);
      expect(JSON.stringify(step)).not.toContain(SECRETS_LEAK);
    }
  });

  it('surfaces parser not-JSON and wrong-shape reasons on the GATE ERROR', async () => {
    const config = cfg({ steps: { secrets: { command: 'secretlint --format json "**/*"' } } });
    const run = (stdout: string) =>
      secretsStep.run(
        ctx({
          config,
          runCommand: async () => result({ exitCode: 1, stdout }),
        }),
      );

    const notJson = await run('not-json');
    expect(notJson.kind).toBe('error');
    if (notJson.kind === 'error') {
      expect(notJson.reason).toBe('secrets output is not JSON (exit 1)');
    }

    const wrongShape = await run('{"filePath":"a.ts","messages":[]}');
    expect(wrongShape.kind).toBe('error');
    if (wrongShape.kind === 'error') {
      expect(wrongShape.reason).toBe('secrets JSON must be an array of file results (exit 1)');
    }
  });

  it('is a GATE ERROR with no tool text when secrets exits non-zero with empty findings', async () => {
    const step = await secretsStep.run(
      ctx({
        config: cfg({ steps: { secrets: { command: 'secretlint --format json "**/*"' } } }),
        runCommand: async () =>
          result({
            exitCode: 2,
            stdout: '[]',
            stderr: `matched ${SECRETS_LEAK}`,
          }),
      }),
    );
    expect(step.kind).toBe('error');
    if (step.kind === 'error') {
      expect(step.reason).toMatch(/without parseable findings/);
      expect(step.reason).not.toContain(SECRETS_LEAK);
      expect(JSON.stringify(step)).not.toContain(SECRETS_LEAK);
    }
  });

  it('is a GATE ERROR when the command is missing (exit 127)', async () => {
    const step = await secretsStep.run(
      ctx({
        config: cfg({ steps: { secrets: { command: 'secretlint --format json "**/*"' } } }),
        runCommand: async () => result({ exitCode: 127, stderr: 'secretlint: command not found' }),
      }),
    );
    expect(step.kind).toBe('error');
    if (step.kind === 'error') {
      expect(step.reason).toBe(
        'secrets: command not found (exit 127); install the tool or fix steps.secrets.command',
      );
    }
  });

  it('passes when the only findings are outside the diff', async () => {
    const step = await secretsStep.run(
      ctx({
        config: cfg({ steps: { secrets: { command: 'secretlint --format json "**/*"' } } }),
        runCommand: async () =>
          result({
            exitCode: 1,
            stdout: secretsJson(path.join(STEP_FILES, 'src/old.ts'), 1),
          }),
      }),
    );
    expect(step.kind).toBe('pass');
  });

  it('passes when a finding is in a changed file but not on an added line', async () => {
    const step = await secretsStep.run(
      ctx({
        config: cfg({ steps: { secrets: { command: 'secretlint --format json "**/*"' } } }),
        runCommand: async () =>
          result({
            exitCode: 1,
            stdout: secretsJson(path.join(STEP_FILES, 'src/a.ts'), 2),
          }),
      }),
    );
    expect(step.kind).toBe('pass');
  });

  it('is red for a finding on an added line and lists rule id plus file:line only', async () => {
    const file = path.join(STEP_FILES, 'src/a.ts');
    const step = await secretsStep.run(
      ctx({
        config: cfg({ steps: { secrets: { command: 'secretlint --format json "**/*"' } } }),
        runCommand: async () =>
          result({
            exitCode: 1,
            stdout: secretsJson(file, 1),
          }),
      }),
    );
    expect(step.kind).toBe('fail');
    if (step.kind === 'fail') {
      expect(step.findings).toHaveLength(1);
      expect(step.findings[0]?.rule).toBe('@secretlint/secretlint-rule-github');
      expect(step.findings[0]?.file).toBe(file);
      expect(step.findings[0]?.line).toBe(1);
      expect(step.findings[0]?.message).toBe('');
      expect(step.findings.map(formatFinding)).toEqual([`${file}:1 [@secretlint/secretlint-rule-github]`]);
      expect(JSON.stringify(step.findings)).not.toContain(SECRETS_LEAK);
      expect(step.findings.map(formatFinding).join('\n')).not.toContain(SECRETS_LEAK);
      expect(step.findings.map(formatFinding).join('\n')).not.toContain('found GitHub Token');
    }
  });
});

describe('testsStep', () => {
  it('is a GATE ERROR when tests fail with no parseable names', async () => {
    const step = await testsStep.run(
      ctx({
        config: cfg({ steps: { tests: { command: 'npx vitest run' } } }),
        runCommand: async () => result({ exitCode: 1, stdout: 'Boom' }),
      }),
    );
    expect(step.kind).toBe('error');
  });

  it('is a GATE ERROR when the runner finds no test files', async () => {
    const step = await testsStep.run(
      ctx({
        config: cfg({ steps: { tests: { command: 'npx vitest run' } } }),
        runCommand: async () => result({ exitCode: 1, stdout: 'No test files found, exiting with code 1' }),
      }),
    );
    expect(step.kind).toBe('error');
  });

  it('is a GATE ERROR when the runner prints a config error', async () => {
    const step = await testsStep.run(
      ctx({
        config: cfg({ steps: { tests: { command: 'npx vitest run' } } }),
        runCommand: async () => result({ exitCode: 1, stderr: 'Error: Vitest config not found' }),
      }),
    );
    expect(step.kind).toBe('error');
  });

  it('is a GATE ERROR when the runner is not executable (exit 126)', async () => {
    const step = await testsStep.run(
      ctx({
        config: cfg({ steps: { tests: { command: './tests.sh' } } }),
        runCommand: async () => result({ exitCode: 126, stdout: '' }),
      }),
    );
    expect(step.kind).toBe('error');
    if (step.kind === 'error') {
      expect(step.reason).toMatch(/not executable/);
    }
  });

  it('is a GATE ERROR when the runner is missing (exit 127)', async () => {
    const step = await testsStep.run(
      ctx({
        config: cfg({ steps: { tests: { command: 'missing-vitest' } } }),
        runCommand: async () => result({ exitCode: 127, stderr: 'command not found' }),
      }),
    );
    expect(step.kind).toBe('error');
    if (step.kind === 'error') {
      expect(step.reason).toBe(
        'tests: command not found (exit 127); install the tool or fix steps.tests.command',
      );
    }
  });

  it('is a GATE ERROR when a real command is killed by SIGTERM', async () => {
    const step = await testsStep.run(
      ctx({
        cwd: process.cwd(),
        config: cfg({ steps: { tests: { command: 'kill -s TERM $$' } } }),
        runCommand,
      }),
    );
    expect(step.kind).toBe('error');
    if (step.kind === 'error') {
      expect(step.reason).toMatch(/SIGTERM/);
    }
  });

  it('is a GATE ERROR when the runner is killed by a signal', async () => {
    const step = await testsStep.run(
      ctx({
        config: cfg({ steps: { tests: { command: 'npx vitest run' } } }),
        runCommand: async () => result({ exitCode: null, signal: 'SIGKILL', stdout: '' }),
      }),
    );
    expect(step.kind).toBe('error');
    if (step.kind === 'error') {
      expect(step.reason).toMatch(/SIGKILL/);
    }
  });

  it('is a GATE ERROR when the runner exits null without a signal', async () => {
    const step = await testsStep.run(
      ctx({
        config: cfg({ steps: { tests: { command: 'npx vitest run' } } }),
        runCommand: async () => result({ exitCode: null, signal: null, stdout: 'ok' }),
      }),
    );
    expect(step.kind).toBe('error');
    if (step.kind === 'error') {
      expect(step.reason).toMatch(/exited null/);
    }
  });

  it('is a GATE ERROR on timeout that names the step and budget', async () => {
    const step = await testsStep.run(
      ctx({
        config: cfg({ steps: { tests: { command: 'npx vitest run', timeoutMs: 250 } } }),
        runCommand: async () => result({ exitCode: null, signal: 'SIGKILL', timedOut: true }),
      }),
    );
    expect(step.kind).toBe('error');
    if (step.kind === 'error') {
      expect(step.reason).toBe('tests timed out after 250ms');
    }
  });

  it('is red when the runner reports a parseable failed test', async () => {
    const step = await testsStep.run(
      ctx({
        config: cfg({ steps: { tests: { command: 'npx vitest run' } } }),
        runCommand: async () =>
          result({ exitCode: 1, stdout: ' FAIL  src/a.test.ts > suite > real regression\n' }),
      }),
    );
    expect(step.kind).toBe('fail');
  });

  it('passes only when every named failure is the listed file plus full title', async () => {
    const step = await testsStep.run(
      ctx({
        config: cfg({
          steps: { tests: { command: 'npx vitest run' } },
          flakes: ['src/bill.test.ts > suite > times out talking to billing'],
        }),
        runCommand: async () =>
          result({
            exitCode: 1,
            stdout: ' FAIL  src/bill.test.ts > suite > times out talking to billing\n',
          }),
      }),
    );
    expect(step.kind).toBe('pass');
  });

  it('is red when a listed flake fails alongside a file that does not load', async () => {
    const stdout = JSON.stringify({
      success: false,
      numFailedTests: 1,
      testResults: [
        {
          name: '/repo/src/load.test.ts',
          status: 'failed',
          message: 'cannot load this file',
          assertionResults: [],
        },
        {
          name: '/repo/src/bill.test.ts',
          status: 'failed',
          message: '',
          assertionResults: [
            {
              ancestorTitles: ['suite'],
              title: 'times out talking to billing',
              status: 'failed',
            },
          ],
        },
      ],
    });
    const step = await testsStep.run(
      ctx({
        config: cfg({
          steps: { tests: { command: 'npx vitest run --reporter=json' } },
          flakes: ['src/bill.test.ts > suite > times out talking to billing'],
        }),
        runCommand: async () => result({ exitCode: 1, stdout }),
      }),
    );
    expect(step.kind).toBe('fail');
    if (step.kind === 'fail') {
      expect(step.findings.some((hit) => hit.message === 'test file failed to load')).toBe(true);
    }
  });

  it('is red when a listed flake fails alongside an unhandled error', async () => {
    const json = JSON.stringify({
      success: false,
      numFailedTests: 1,
      testResults: [
        {
          name: '/repo/src/bill.test.ts',
          status: 'failed',
          message: '',
          assertionResults: [
            {
              ancestorTitles: ['suite'],
              title: 'times out talking to billing',
              status: 'failed',
            },
          ],
        },
      ],
    });
    const step = await testsStep.run(
      ctx({
        config: cfg({
          steps: { tests: { command: 'npx vitest run --reporter=json' } },
          flakes: ['src/bill.test.ts > suite > times out talking to billing'],
        }),
        runCommand: async () =>
          result({
            exitCode: 1,
            stdout: json,
            stderr: '⎯ Unhandled Errors ⎯\n     Errors  1 error\n',
          }),
      }),
    );
    expect(step.kind).toBe('fail');
    if (step.kind === 'fail') {
      expect(step.findings.some((hit) => hit.message === 'unhandled error')).toBe(true);
    }
  });

  it('is a GATE ERROR when JSON success is false with no named failures', async () => {
    const stdout = JSON.stringify({
      success: false,
      numFailedTests: 0,
      numFailedTestSuites: 0,
      testResults: [
        {
          name: '/repo/src/coverage.test.ts',
          status: 'passed',
          message: '',
          assertionResults: [{ ancestorTitles: ['coverage'], title: 'stays green', status: 'passed' }],
        },
      ],
    });
    const step = await testsStep.run(
      ctx({
        config: cfg({ steps: { tests: { command: 'npx jest --coverage --json' } } }),
        runCommand: async () =>
          result({
            exitCode: 1,
            stdout,
            stderr: 'Jest: "global" coverage threshold for statements (80%) not met: 40%\n',
          }),
      }),
    );
    expect(step.kind).toBe('error');
    if (step.kind === 'error') {
      expect(step.reason).toMatch(/test runner exited 1 with no parseable failed tests/);
      expect(step.reason).toMatch(/coverage threshold/);
      expect(step.reason).not.toMatch(/failure with no FAIL file > title line/);
    }
  });

  it('is a GATE ERROR when JSON reports success but the runner still exits non-zero', async () => {
    const stdout = JSON.stringify({
      success: true,
      numFailedTests: 0,
      testResults: [
        {
          name: '/repo/src/unhandled.test.ts',
          status: 'passed',
          message: '',
          assertionResults: [{ ancestorTitles: ['async'], title: 'passes but leaks', status: 'passed' }],
        },
      ],
    });
    const step = await testsStep.run(
      ctx({
        config: cfg({
          steps: { tests: { command: 'npx vitest run --reporter=json' } },
          flakes: ['src/unhandled.test.ts > async > passes but leaks'],
        }),
        runCommand: async () => result({ exitCode: 1, stdout }),
      }),
    );
    expect(step.kind).toBe('error');
    if (step.kind === 'error') {
      expect(step.reason).toMatch(/test runner exited 1 with no parseable failed tests/);
    }
  });

  it('is red when a listed flake fails alongside a failing hook', async () => {
    const stdout = JSON.stringify({
      success: false,
      numFailedTests: 1,
      testResults: [
        {
          name: '/repo/src/hook.test.ts',
          status: 'failed',
          message: '',
          assertionResults: [{ ancestorTitles: ['hooks'], title: 'never runs', status: 'skipped' }],
        },
        {
          name: '/repo/src/bill.test.ts',
          status: 'failed',
          message: '',
          assertionResults: [
            {
              ancestorTitles: ['suite'],
              title: 'times out talking to billing',
              status: 'failed',
            },
          ],
        },
      ],
    });
    const step = await testsStep.run(
      ctx({
        config: cfg({
          steps: { tests: { command: 'npx vitest run --reporter=json' } },
          flakes: ['src/bill.test.ts > suite > times out talking to billing'],
        }),
        runCommand: async () => result({ exitCode: 1, stdout }),
      }),
    );
    expect(step.kind).toBe('fail');
    if (step.kind === 'fail') {
      expect(step.findings.some((hit) => hit.message === 'failing hook')).toBe(true);
    }
  });

  it('is red when a listed flake fails alongside a failure with no FAIL file > title line', async () => {
    const step = await testsStep.run(
      ctx({
        config: cfg({
          steps: { tests: { command: 'npx vitest run' } },
          flakes: ['src/bill.test.ts > suite > times out talking to billing'],
        }),
        runCommand: async () =>
          result({
            exitCode: 1,
            stdout: `
 FAIL  src/bill.test.ts > suite > times out talking to billing
      Tests  2 failed | 1 passed (3)
`,
          }),
      }),
    );
    expect(step.kind).toBe('fail');
    if (step.kind === 'fail') {
      expect(step.findings.some((hit) => hit.message === 'failure with no FAIL file > title line')).toBe(true);
    }
  });

  it('is red when the same title fails in a different file than the flake', async () => {
    const step = await testsStep.run(
      ctx({
        config: cfg({
          steps: { tests: { command: 'npx vitest run' } },
          flakes: ['src/bill.test.ts > suite > renders'],
        }),
        runCommand: async () =>
          result({
            exitCode: 1,
            stdout: ' FAIL  src/other.test.ts > suite > renders\n',
          }),
      }),
    );
    expect(step.kind).toBe('fail');
  });

  it('catches a load failure next to a listed flake with a real vitest run', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-vitest-step-'));
    try {
      writeRepoFile(dir, 'package.json', JSON.stringify({ name: 'fixture', type: 'module' }));
      fs.symlinkSync(path.join(GATE_ROOT, 'node_modules'), path.join(dir, 'node_modules'));
      writeRepoFile(
        dir,
        'src/named.test.ts',
        `import { describe, it, expect } from 'vitest';
describe('billing', () => {
  it('times out talking to billing', () => { expect(1).toBe(2); });
});
`,
      );
      writeRepoFile(dir, 'src/load.test.ts', "throw new Error('cannot load this file');\n");
      const step = await testsStep.run(
        ctx({
          cwd: dir,
          config: cfg({
            steps: {
              tests: {
                command: `${JSON.stringify(VITEST_BIN)} run --reporter=json`,
              },
            },
            flakes: ['src/named.test.ts > billing > times out talking to billing'],
          }),
          runCommand,
        }),
      );
      expect(step.kind).toBe('fail');
      if (step.kind === 'fail') {
        expect(step.findings.some((hit) => hit.message === 'test file failed to load')).toBe(true);
      }
    } finally {
      const linked = path.join(dir, 'node_modules');
      try {
        fs.unlinkSync(linked);
      } catch {
        // The symlink is removed first so recursive rm cannot walk the real install.
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips when disabled', () => {
    expect(testsStep.isEnabled(cfg({ steps: { 'line-checks': true, tests: { enabled: false, command: 't' } } }))).toBe(
      false,
    );
  });
});

function knipReport(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}

function knipTwoShot(current: string, base: string): StepContext['runCommand'] {
  return async (...args: Parameters<StepContext['runCommand']>) => {
    const cwd = args[1];
    if (cwd.includes('knip-base')) {
      return result({ exitCode: 1, stdout: base });
    }
    return result({ exitCode: 1, stdout: current });
  };
}

async function withKnipRepo(
  fn: (args: { repo: string; tmpDir: string; mergeBaseSha: string; scope: DiffScope }) => Promise<void>,
): Promise<void> {
  await withTempRepo(async (repo) => {
    writeRepoFile(repo, 'package.json', JSON.stringify({ name: 'app', type: 'module', dependencies: { leftover: '1.0.0' } }));
    writeRepoFile(
      repo,
      'knip.json',
      JSON.stringify({ entry: ['src/index.ts'], project: ['src/**/*.ts'] }),
    );
    writeRepoFile(
      repo,
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'Node16', moduleResolution: 'Node16', noEmit: true },
        include: ['src/**/*.ts'],
      }),
    );
    writeRepoFile(repo, 'src/lib.ts', 'export function helper() { return 1; }\nexport function used() { return 2; }\n');
    writeRepoFile(repo, 'src/index.ts', "import { helper, used } from './lib.js';\nexport const n = helper() + used();\n");
    writeRepoFile(repo, 'src/legacy.ts', 'export const leftover = 1;\n');
    commitAll(repo, 'base');
    const mergeBaseSha = git(repo, ['rev-parse', 'HEAD']).trim();
    git(repo, ['checkout', '-q', '-b', 'feat']);
    writeRepoFile(repo, 'src/index.ts', "import { used } from './lib.js';\nexport const n = used();\n");
    commitAll(repo, 'feat');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-knip-step-'));
    try {
      const scope: DiffScope = {
        baseRef: 'main',
        mergeBaseSha,
        changedFiles: new Set(['src/index.ts']),
        addedLines: new Map([['src/index.ts', new Set([1, 2])]]),
      };
      await fn({ repo, tmpDir, mergeBaseSha, scope });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
}

describe('knipStep', () => {
  it('is a GATE ERROR when knip exits 0 with unparseable output', async () => {
    const step = await knipStep.run(
      ctx({
        config: cfg({ steps: { knip: { command: 'npx knip --reporter json' } } }),
        runCommand: async () => result({ exitCode: 0, stdout: 'knip done' }),
      }),
    );
    expect(step.kind).toBe('error');
  });

  it('fails on a helper left unused after its last caller is deleted', async () => {
    await withKnipRepo(async ({ repo, tmpDir, scope }) => {
      const current = knipReport({
        files: [],
        issues: [
          { file: 'src/lib.ts', exports: [{ name: 'helper', line: 1 }] },
          { file: 'src/legacy.ts', exports: [{ name: 'leftover', line: 1 }] },
        ],
      });
      const base = knipReport({
        files: [],
        issues: [{ file: 'src/legacy.ts', exports: [{ name: 'leftover', line: 1 }] }],
      });
      const step = await knipStep.run(
        ctx({
          cwd: repo,
          tmpDir,
          scope,
          config: cfg({ steps: { knip: { command: 'npx knip --reporter json' } } }),
          runCommand: knipTwoShot(current, base),
        }),
      );
      expect(step.kind).toBe('fail');
      if (step.kind === 'fail') {
        expect(step.findings.some((hit) => hit.message === 'helper')).toBe(true);
        expect(step.findings.some((hit) => hit.message === 'leftover')).toBe(false);
      }
    });
  });

  it('passes when the only knip findings already existed at the merge-base', async () => {
    await withKnipRepo(async ({ repo, tmpDir, scope }) => {
      const report = knipReport({
        files: ['src/legacy.ts'],
        issues: [{ file: 'src/legacy.ts', exports: [{ name: 'leftover', line: 1 }] }],
      });
      const step = await knipStep.run(
        ctx({
          cwd: repo,
          tmpDir,
          scope,
          config: cfg({ steps: { knip: { command: 'npx knip --reporter json' } } }),
          runCommand: knipTwoShot(report, report),
        }),
      );
      expect(step.kind).toBe('pass');
    });
  });

  it('is a GATE ERROR with stderr when the merge-base tree cannot be materialized', async () => {
    await withKnipRepo(async ({ repo, tmpDir, scope }) => {
      const current = knipReport({
        files: [],
        issues: [{ file: 'src/lib.ts', exports: [{ name: 'helper', line: 1 }] }],
      });
      const step = await knipStep.run(
        ctx({
          cwd: repo,
          tmpDir,
          scope: { ...scope, mergeBaseSha: 'not-a-real-sha' },
          config: cfg({ steps: { knip: { command: 'npx knip --reporter json' } } }),
          runCommand: knipTwoShot(current, knipReport({ files: [], issues: [] })),
        }),
      );
      expect(step.kind).toBe('error');
      if (step.kind === 'error') {
        expect(step.reason).toMatch(/cannot compute knip baseline/);
        expect(step.reason).toMatch(/fatal:|not a valid object|unknown revision|ambiguous argument/i);
      }
    });
  });

  it('deletes the knip baseline tree after a materialize failure', async () => {
    await withKnipRepo(async ({ repo, tmpDir, scope }) => {
      const current = knipReport({
        files: [],
        issues: [{ file: 'src/lib.ts', exports: [{ name: 'helper', line: 1 }] }],
      });
      const dest = path.join(tmpDir, 'knip-base');
      const step = await knipStep.run(
        ctx({
          cwd: repo,
          tmpDir,
          scope: { ...scope, mergeBaseSha: 'not-a-real-sha' },
          config: cfg({ steps: { knip: { command: 'npx knip --reporter json' } } }),
          runCommand: knipTwoShot(current, knipReport({ files: [], issues: [] })),
        }),
      );
      expect(step.kind).toBe('error');
      expect(fs.existsSync(dest)).toBe(false);
    });
  });

  it('links workspace package node_modules into the knip baseline', async () => {
    await withKnipRepo(async ({ repo, tmpDir, scope }) => {
      writeRepoFile(repo, '.gitignore', 'node_modules\n');
      fs.mkdirSync(path.join(repo, 'node_modules', 'root-dep'), { recursive: true });
      fs.mkdirSync(path.join(repo, 'packages', 'app', 'node_modules', 'app-dep'), { recursive: true });
      writeRepoFile(repo, 'packages/app/package.json', JSON.stringify({ name: 'app' }));
      const current = knipReport({
        files: [],
        issues: [{ file: 'src/lib.ts', exports: [{ name: 'helper', line: 1 }] }],
      });
      const base = knipReport({ files: [], issues: [] });
      let sawLinks = false;
      const step = await knipStep.run(
        ctx({
          cwd: repo,
          tmpDir,
          scope,
          config: cfg({ steps: { knip: { command: 'npx knip --reporter json' } } }),
          runCommand: async (...args: Parameters<StepContext['runCommand']>) => {
            const cwd = args[1];
            if (cwd.includes('knip-base')) {
              const rootNm = path.join(cwd, 'node_modules');
              const pkgNm = path.join(cwd, 'packages', 'app', 'node_modules');
              expect(fs.lstatSync(rootNm).isSymbolicLink()).toBe(true);
              expect(fs.lstatSync(pkgNm).isSymbolicLink()).toBe(true);
              expect(fs.realpathSync(rootNm)).toBe(fs.realpathSync(path.join(repo, 'node_modules')));
              expect(fs.realpathSync(pkgNm)).toBe(
                fs.realpathSync(path.join(repo, 'packages', 'app', 'node_modules')),
              );
              sawLinks = true;
              return result({ exitCode: 1, stdout: base });
            }
            return result({ exitCode: 1, stdout: current });
          },
        }),
      );
      expect(sawLinks).toBe(true);
      expect(step.kind).toBe('fail');
    });
  });

  it('is a GATE ERROR when the knip baseline command is missing (exit 127)', async () => {
    await withKnipRepo(async ({ repo, tmpDir, scope }) => {
      const current = knipReport({
        files: [],
        issues: [{ file: 'src/lib.ts', exports: [{ name: 'helper', line: 1 }] }],
      });
      const step = await knipStep.run(
        ctx({
          cwd: repo,
          tmpDir,
          scope,
          config: cfg({ steps: { knip: { command: 'npx knip --reporter json' } } }),
          runCommand: async (...args: Parameters<StepContext['runCommand']>) => {
            const cwd = args[1];
            if (cwd.includes('knip-base')) {
              return result({ exitCode: 127, stderr: 'command not found' });
            }
            return result({ exitCode: 1, stdout: current });
          },
        }),
      );
      expect(step.kind).toBe('error');
      if (step.kind === 'error') {
        expect(step.reason).toMatch(
          /knip: command not found \(exit 127\); install the tool or fix steps\.knip\.command/,
        );
      }
    });
  });

  it('is a GATE ERROR when baseline knip output is unparseable', async () => {
    await withKnipRepo(async ({ repo, tmpDir, scope }) => {
      const current = knipReport({
        files: [],
        issues: [{ file: 'src/lib.ts', exports: [{ name: 'helper', line: 1 }] }],
      });
      const step = await knipStep.run(
        ctx({
          cwd: repo,
          tmpDir,
          scope,
          config: cfg({ steps: { knip: { command: 'npx knip --reporter json' } } }),
          runCommand: async (...args: Parameters<StepContext['runCommand']>) => {
            const cwd = args[1];
            if (cwd.includes('knip-base')) {
              return result({ exitCode: 0, stdout: 'knip baseline garbage' });
            }
            return result({ exitCode: 1, stdout: current });
          },
        }),
      );
      expect(step.kind).toBe('error');
      if (step.kind === 'error') {
        expect(step.reason).toMatch(/knip baseline/);
      }
    });
  });

  it('fails when a dependency becomes unused after its last importer is deleted', async () => {
    await withKnipRepo(async ({ repo, tmpDir, scope }) => {
      const current = knipReport({
        files: [],
        issues: [{ file: 'package.json', dependencies: [{ name: 'leftover', line: 10 }] }],
      });
      const base = knipReport({ files: [], issues: [] });
      const step = await knipStep.run(
        ctx({
          cwd: repo,
          tmpDir,
          scope,
          config: cfg({ steps: { knip: { command: 'npx knip --reporter json' } } }),
          runCommand: knipTwoShot(current, base),
        }),
      );
      expect(step.kind).toBe('fail');
      if (step.kind === 'fail') {
        expect(step.findings.some((hit) => hit.rule === 'dependencies' && hit.message === 'leftover')).toBe(true);
      }
    });
  });

  it('does not fail on a version bump of a pre-existing unused dependency', async () => {
    await withKnipRepo(async ({ repo, tmpDir, mergeBaseSha, scope }) => {
      writeRepoFile(
        repo,
        'package.json',
        JSON.stringify({ name: 'app', dependencies: { leftover: '2.0.0' } }),
      );
      const current = knipReport({
        files: [],
        issues: [{ file: 'package.json', dependencies: [{ name: 'leftover', line: 10 }] }],
      });
      const step = await knipStep.run(
        ctx({
          cwd: repo,
          tmpDir,
          scope: {
            ...scope,
            changedFiles: new Set(['package.json']),
            addedLines: new Map([['package.json', new Set([10])]]),
          },
          config: cfg({ steps: { knip: { command: 'npx knip --reporter json' } } }),
          runCommand: knipTwoShot(current, current),
        }),
      );
      expect(mergeBaseSha).toBeTruthy();
      expect(step.kind).toBe('pass');
    });
  });

  it('does not fail on a pre-existing unused dep in a touched workspace package.json', async () => {
    await withKnipRepo(async ({ repo, tmpDir, mergeBaseSha, scope }) => {
      writeRepoFile(
        repo,
        'packages/x/package.json',
        JSON.stringify({ name: 'x', dependencies: { leftover: '1.0.0' } }),
      );
      git(repo, ['add', 'packages/x/package.json']);
      const current = knipReport({
        files: [],
        issues: [{ file: 'packages/x/package.json', dependencies: [{ name: 'leftover', line: 8 }] }],
      });
      const step = await knipStep.run(
        ctx({
          cwd: repo,
          tmpDir,
          scope: {
            ...scope,
            mergeBaseSha,
            changedFiles: new Set(['packages/x/package.json']),
            addedLines: new Map([['packages/x/package.json', new Set([8])]]),
          },
          config: cfg({ steps: { knip: { command: 'npx knip --reporter json' } } }),
          runCommand: knipTwoShot(current, current),
        }),
      );
      expect(step.kind).toBe('pass');
    });
  });

  it('fails on a newly added unused dependency', async () => {
    await withKnipRepo(async ({ repo, tmpDir, mergeBaseSha, scope }) => {
      writeRepoFile(
        repo,
        'package.json',
        JSON.stringify({ name: 'app', dependencies: { leftover: '1.0.0', extra: '1.0.0' } }),
      );
      const current = knipReport({
        files: [],
        issues: [{ file: 'package.json', dependencies: [{ name: 'extra', line: 10 }] }],
      });
      const base = knipReport({ files: [], issues: [] });
      const step = await knipStep.run(
        ctx({
          cwd: repo,
          tmpDir,
          scope: {
            ...scope,
            mergeBaseSha,
            changedFiles: new Set(['package.json']),
            addedLines: new Map([['package.json', new Set([10])]]),
          },
          config: cfg({ steps: { knip: { command: 'npx knip --reporter json' } } }),
          runCommand: knipTwoShot(current, base),
        }),
      );
      expect(step.kind).toBe('fail');
      if (step.kind === 'fail') {
        expect(step.findings.some((hit) => hit.message === 'extra')).toBe(true);
      }
    });
  });

  it('catches a leftover unused helper with a real knip run', async () => {
    await withKnipRepo(async ({ repo, tmpDir, mergeBaseSha, scope }) => {
      const step = await knipStep.run(
        ctx({
          cwd: repo,
          tmpDir,
          scope: { ...scope, mergeBaseSha },
          config: cfg({
            steps: {
              knip: { command: `${JSON.stringify(KNIP_BIN)} --reporter json --no-progress` },
            },
          }),
          runCommand,
        }),
      );
      expect(step.kind).toBe('fail');
      if (step.kind === 'fail') {
        expect(
          step.findings.some((hit) => hit.rule === 'exports' && hit.message === 'helper' && hit.file.includes('lib')),
        ).toBe(true);
        expect(step.findings.some((hit) => hit.message === 'leftover')).toBe(false);
      }
    });
  });
});

const ARCHITECTURE_COMMAND = 'depcruise src --output-type json';

function architectureViolation(
  from: string,
  to: string,
  rule: string,
  severity: 'error' | 'warn' | 'info',
  cycle?: readonly unknown[],
): Record<string, unknown> {
  if (cycle === undefined) {
    return { from, to, rule: { name: rule, severity } };
  }
  return { from, to, rule: { name: rule, severity }, cycle };
}

function architectureReport(violations: readonly unknown[]): string {
  return JSON.stringify({ summary: { violations } });
}

function architectureTwoShot(current: string, base: string): StepContext['runCommand'] {
  return async (...args: Parameters<StepContext['runCommand']>) => {
    const cwd = args[1];
    if (cwd.includes('architecture-base')) {
      return result({ exitCode: 1, stdout: base });
    }
    return result({ exitCode: 1, stdout: current });
  };
}

async function withArchitectureRepo(
  fn: (args: { repo: string; tmpDir: string; mergeBaseSha: string; scope: DiffScope }) => Promise<void>,
): Promise<void> {
  await withTempRepo(async (repo) => {
    writeRepoFile(repo, 'src/a.ts', 'export const a = 1;\n');
    commitAll(repo, 'base');
    const mergeBaseSha = git(repo, ['rev-parse', 'HEAD']).trim();
    git(repo, ['checkout', '-q', '-b', 'feat']);
    writeRepoFile(repo, 'src/b.ts', "import { a } from './a.js';\nexport const b = a;\n");
    commitAll(repo, 'feat');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-architecture-step-'));
    try {
      const scope: DiffScope = {
        baseRef: 'main',
        mergeBaseSha,
        changedFiles: new Set(['src/b.ts']),
        addedLines: new Map([['src/b.ts', new Set([1, 2])]]),
      };
      await fn({ repo, tmpDir, mergeBaseSha, scope });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
}

describe('architectureStep', () => {
  it('is off unless the repo config enables it with a command', () => {
    expect(architectureStep.isEnabled(cfg({ steps: { tests: { command: 't' } } }))).toBe(false);
    expect(
      architectureStep.isEnabled(cfg({ steps: { tests: { command: 't' }, architecture: { enabled: false } } })),
    ).toBe(false);
    expect(
      architectureStep.isEnabled(cfg({ steps: { architecture: { command: ARCHITECTURE_COMMAND } } })),
    ).toBe(true);
  });

  it('is a GATE ERROR when output is not JSON', async () => {
    const step = await architectureStep.run(
      ctx({
        config: cfg({ steps: { architecture: { command: ARCHITECTURE_COMMAND } } }),
        runCommand: async () => result({ exitCode: 1, stdout: "ERROR: Can't open .dependency-cruiser.js" }),
      }),
    );
    expect(step.kind).toBe('error');
    if (step.kind === 'error') {
      expect(step.reason).toMatch(/not JSON/);
    }
  });

  it('is a GATE ERROR when the command is missing (exit 127)', async () => {
    const step = await architectureStep.run(
      ctx({
        config: cfg({ steps: { architecture: { command: ARCHITECTURE_COMMAND } } }),
        runCommand: async () => result({ exitCode: 127, stderr: 'command not found' }),
      }),
    );
    expect(step.kind).toBe('error');
    if (step.kind === 'error') {
      expect(step.reason).toBe(
        'architecture: command not found (exit 127); install the tool or fix steps.architecture.command',
      );
    }
  });

  it('is a GATE ERROR when dependency-cruiser errors out with no error violations', async () => {
    const step = await architectureStep.run(
      ctx({
        config: cfg({ steps: { architecture: { command: ARCHITECTURE_COMMAND } } }),
        runCommand: async () =>
          result({
            exitCode: 1,
            stdout: architectureReport([]),
            stderr: "ERROR: The rules file '.dependency-cruiser.js' is empty",
          }),
      }),
    );
    expect(step.kind).toBe('error');
    if (step.kind === 'error') {
      expect(step.reason).toMatch(/without parseable findings/);
    }
  });

  it('skips the baseline run when the branch has no error violations', async () => {
    let calls = 0;
    const step = await architectureStep.run(
      ctx({
        config: cfg({ steps: { architecture: { command: ARCHITECTURE_COMMAND } } }),
        runCommand: async () => {
          calls += 1;
          return result({
            exitCode: 0,
            stdout: architectureReport([
              architectureViolation('src/a.ts', 'src/legacy.ts', 'no-legacy', 'warn'),
            ]),
          });
        },
      }),
    );
    expect(step.kind).toBe('pass');
    expect(calls).toBe(1);
  });

  it('fails on a new error-severity violation', async () => {
    await withArchitectureRepo(async ({ repo, tmpDir, scope }) => {
      const current = architectureReport([
        architectureViolation('src/a.ts', 'src/forbidden.ts', 'not-to-unallowed', 'error'),
        architectureViolation('src/legacy.ts', 'src/old.ts', 'not-to-unallowed', 'error'),
      ]);
      const base = architectureReport([
        architectureViolation('src/legacy.ts', 'src/old.ts', 'not-to-unallowed', 'error'),
      ]);
      const step = await architectureStep.run(
        ctx({
          cwd: repo,
          tmpDir,
          scope,
          config: cfg({ steps: { architecture: { command: ARCHITECTURE_COMMAND } } }),
          runCommand: architectureTwoShot(current, base),
        }),
      );
      expect(step.kind).toBe('fail');
      if (step.kind === 'fail') {
        expect(step.findings.map(formatFinding)).toEqual([
          '[not-to-unallowed] src/a.ts -> src/forbidden.ts',
        ]);
      }
    });
  });

  it('passes when the only error violations already existed at the merge-base', async () => {
    await withArchitectureRepo(async ({ repo, tmpDir, scope }) => {
      const report = architectureReport([
        architectureViolation('src/legacy.ts', 'src/old.ts', 'not-to-unallowed', 'error'),
      ]);
      const step = await architectureStep.run(
        ctx({
          cwd: repo,
          tmpDir,
          scope,
          config: cfg({ steps: { architecture: { command: ARCHITECTURE_COMMAND } } }),
          runCommand: architectureTwoShot(report, report),
        }),
      );
      expect(step.kind).toBe('pass');
    });
  });

  it('fails on a new circular dependency and reports the cycle path', async () => {
    await withArchitectureRepo(async ({ repo, tmpDir, scope }) => {
      const current = architectureReport([
        architectureViolation('src/a.ts', 'src/b.ts', 'no-circular', 'error', [
          { name: 'src/b.ts', dependencyTypes: ['local'] },
          { name: 'src/a.ts', dependencyTypes: ['local'] },
        ]),
      ]);
      const base = architectureReport([]);
      const step = await architectureStep.run(
        ctx({
          cwd: repo,
          tmpDir,
          scope,
          config: cfg({ steps: { architecture: { command: ARCHITECTURE_COMMAND } } }),
          runCommand: architectureTwoShot(current, base),
        }),
      );
      expect(step.kind).toBe('fail');
      if (step.kind === 'fail') {
        expect(step.findings).toEqual([
          {
            step: 'architecture',
            file: 'src/a.ts',
            line: 0,
            rule: 'no-circular',
            message: 'src/a.ts -> src/b.ts -> src/a.ts',
          },
        ]);
        expect(step.findings.map(formatFinding)).toEqual([
          '[no-circular] src/a.ts -> src/b.ts -> src/a.ts',
        ]);
      }
    });
  });

  it('is a GATE ERROR when the architecture baseline command is missing (exit 127)', async () => {
    await withArchitectureRepo(async ({ repo, tmpDir, scope }) => {
      const current = architectureReport([
        architectureViolation('src/a.ts', 'src/forbidden.ts', 'not-to-unallowed', 'error'),
      ]);
      const step = await architectureStep.run(
        ctx({
          cwd: repo,
          tmpDir,
          scope,
          config: cfg({ steps: { architecture: { command: ARCHITECTURE_COMMAND } } }),
          runCommand: async (...args: Parameters<StepContext['runCommand']>) => {
            const cwd = args[1];
            if (cwd.includes('architecture-base')) {
              return result({ exitCode: 127, stderr: 'command not found' });
            }
            return result({ exitCode: 1, stdout: current });
          },
        }),
      );
      expect(step.kind).toBe('error');
      if (step.kind === 'error') {
        expect(step.reason).toMatch(
          /architecture: command not found \(exit 127\); install the tool or fix steps\.architecture\.command/,
        );
      }
    });
  });
});

function parseFakeTsv(output: string): Result<Finding[]> {
  const findings: Finding[] = [];
  for (const line of output.split('\n')) {
    if (line === '') {
      continue;
    }
    const parts = line.split('\t');
    if (parts.length !== 4) {
      return err('fake output is not file\\trule\\tmessage\\tline TSV');
    }
    const [file, rule, message, lineText] = parts;
    const lineNo = Number(lineText);
    if (file === undefined || rule === undefined || message === undefined || !Number.isInteger(lineNo)) {
      return err('fake output is not file\\trule\\tmessage\\tline TSV');
    }
    findings.push({ step: 'jscpd', file, line: lineNo, rule, message });
  }
  return ok(findings);
}

describe('findingsAtMergeBase', () => {
  it('runs the supplied command on a merge-base copy and parses with the caller parser', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'src/a.ts', 'export const a = 1;\n');
      commitAll(repo, 'base');
      const mergeBaseSha = git(repo, ['rev-parse', 'HEAD']).trim();
      git(repo, ['checkout', '-q', '-b', 'feat']);
      writeRepoFile(repo, 'src/a.ts', 'export const a = 2;\n');
      commitAll(repo, 'feat');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-base-findings-'));
      try {
        const dest = path.join(tmpDir, 'jscpd-base');
        const parsed = await findingsAtMergeBase(
          ctx({
            cwd: repo,
            tmpDir,
            scope: { ...emptyScope, mergeBaseSha },
            config: cfg({ steps: { jscpd: { command: 'fake-jscpd' } } }),
            runCommand: async (command, cwd) => {
              expect(command).toBe('fake-jscpd');
              expect(cwd).toBe(dest);
              expect(fs.readFileSync(path.join(cwd, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
              return result({ exitCode: 0, stdout: 'src/a.ts\tduplicate\tclone\t1\n' });
            },
          }),
          'jscpd',
          'fake-jscpd',
          parseFakeTsv,
        );
        expect(parsed).toEqual([{ step: 'jscpd', file: 'src/a.ts', line: 1, rule: 'duplicate', message: 'clone' }]);
        expect(fs.existsSync(dest)).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  it('is a GATE ERROR that names the step when the merge-base cannot be materialized', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'src/a.ts', 'export const a = 1;\n');
      commitAll(repo, 'base');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-base-findings-'));
      try {
        const dest = path.join(tmpDir, 'jscpd-base');
        const step = await findingsAtMergeBase(
          ctx({
            cwd: repo,
            tmpDir,
            scope: { ...emptyScope, mergeBaseSha: 'not-a-real-sha' },
            config: cfg({ steps: { jscpd: { command: 'fake-jscpd' } } }),
            runCommand: async () => result({ exitCode: 0, stdout: '' }),
          }),
          'jscpd',
          'fake-jscpd',
          parseFakeTsv,
        );
        expect(Array.isArray(step)).toBe(false);
        if (!Array.isArray(step)) {
          expect(step.kind).toBe('error');
          if (step.kind === 'error') {
            expect(step.reason).toMatch(/cannot compute jscpd baseline at not-a-real-sha/);
          }
        }
        expect(fs.existsSync(dest)).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  it('is a GATE ERROR when the baseline command is missing (exit 127)', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'src/a.ts', 'export const a = 1;\n');
      commitAll(repo, 'base');
      const mergeBaseSha = git(repo, ['rev-parse', 'HEAD']).trim();
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-base-findings-'));
      try {
        const step = await findingsAtMergeBase(
          ctx({
            cwd: repo,
            tmpDir,
            scope: { ...emptyScope, mergeBaseSha },
            config: cfg({ steps: { jscpd: { command: 'fake-jscpd' } } }),
            runCommand: async () => result({ exitCode: 127, stderr: 'command not found' }),
          }),
          'jscpd',
          'fake-jscpd',
          parseFakeTsv,
        );
        expect(Array.isArray(step)).toBe(false);
        if (!Array.isArray(step)) {
          expect(step.kind).toBe('error');
          if (step.kind === 'error') {
            expect(step.reason).toBe(
              'jscpd baseline: jscpd: command not found (exit 127); install the tool or fix steps.jscpd.command',
            );
          }
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});

describe('jscpdStep', () => {
  it('is a GATE ERROR when jscpd exits 0 with unparseable output', async () => {
    const step = await jscpdStep.run(
      ctx({
        config: cfg({ steps: { jscpd: { command: 'npx jscpd --reporters json' } } }),
        runCommand: async () => result({ exitCode: 0, stdout: 'jscpd finished' }),
      }),
    );
    expect(step.kind).toBe('error');
  });

  it('is red when jscpd reports duplicates even though it exits 0', async () => {
    const step = await jscpdStep.run(
      ctx({
        config: cfg({ steps: { jscpd: { command: 'npx jscpd --reporters json' } } }),
        runCommand: async () =>
          result({
            exitCode: 0,
            stdout: JSON.stringify({
              duplicates: [
                {
                  lines: 8,
                  firstFile: { name: 'src/a.ts', start: 1, end: 8 },
                  secondFile: { name: 'src/old.ts', start: 1, end: 8 },
                },
              ],
            }),
            stderr: NODE_STDERR_WARNING,
          }),
      }),
    );
    expect(step.kind).toBe('fail');
  });

  it('keeps a jscpd clone that overlaps added lines', async () => {
    const step = await jscpdStep.run(
      ctx({
        config: cfg({ steps: { jscpd: { command: 'npx jscpd --reporters json' } } }),
        runCommand: async () =>
          result({
            exitCode: 1,
            stdout: JSON.stringify({
              duplicates: [
                {
                  lines: 8,
                  firstFile: { name: 'src/a.ts', start: 1, end: 8 },
                  secondFile: { name: 'src/old.ts', start: 1, end: 8 },
                },
              ],
            }),
          }),
      }),
    );
    expect(step.kind).toBe('fail');
  });

  it('is a GATE ERROR when a clone path cannot be mapped to a repo file', async () => {
    const step = await jscpdStep.run(
      ctx({
        config: cfg({ steps: { jscpd: { command: 'npx jscpd --reporters json' } } }),
        runCommand: async () =>
          result({
            exitCode: 0,
            stdout: JSON.stringify({
              duplicates: [
                {
                  lines: 8,
                  firstFile: { name: '/elsewhere/src/a.ts', start: 1, end: 8 },
                  secondFile: { name: '/elsewhere/src/b.ts', start: 1, end: 8 },
                },
              ],
            }),
          }),
      }),
    );
    expect(step.kind).toBe('error');
    if (step.kind === 'error') {
      expect(step.reason).toMatch(/cannot map finding to a file in the repo/);
    }
  });

  it('passes jscpd when clones are only in unchanged files', async () => {
    const step = await jscpdStep.run(
      ctx({
        config: cfg({ steps: { jscpd: { command: 'npx jscpd --reporters json' } } }),
        runCommand: async () =>
          result({
            exitCode: 1,
            stdout: JSON.stringify({
              duplicates: [
                {
                  lines: 8,
                  firstFile: { name: 'src/old.ts', start: 1, end: 8 },
                  secondFile: { name: 'src/legacy.ts', start: 1, end: 8 },
                },
              ],
            }),
          }),
      }),
    );
    expect(step.kind).toBe('pass');
  });
});

describe('lineChecksStep', () => {
  it('is enabled from config', () => {
    expect(lineChecksStep.isEnabled(cfg({ steps: { 'line-checks': true } }))).toBe(true);
  });

  it('is enabled when omitted so no-silencing still runs', () => {
    expect(lineChecksStep.isEnabled(cfg({ steps: { tests: { command: 't' } } }))).toBe(true);
  });

  it('is disabled only when enabled is false', () => {
    expect(
      lineChecksStep.isEnabled(cfg({ steps: { tests: { command: 't' }, 'line-checks': false } })),
    ).toBe(false);
  });

  it('flags a new secretlint-disable only when secrets is enabled', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-lines-secrets-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src/a.ts'), "const token = 'leaked-value'; // secretlint-disable-line\n");
      const scope: DiffScope = {
        baseRef: 'main',
        mergeBaseSha: 'a',
        changedFiles: new Set(['src/a.ts']),
        addedLines: new Map([['src/a.ts', new Set([1])]]),
      };
      const secretsOn = await lineChecksStep.run(
        ctx({
          cwd: dir,
          config: cfg({ steps: { secrets: { command: 'secretlint --format json "**/*"' } } }),
          scope,
          runCommand: async () => result({ exitCode: 0 }),
        }),
      );
      expect(secretsOn.kind).toBe('fail');
      if (secretsOn.kind === 'fail') {
        expect(secretsOn.findings).toEqual([
          {
            step: 'line-checks',
            file: 'src/a.ts',
            line: 1,
            rule: 'no-silencing',
            message: 'secretlint-disable',
          },
        ]);
        const finding = secretsOn.findings[0];
        expect(finding).toBeDefined();
        if (finding !== undefined) {
          expect(formatFinding(finding)).toBe('src/a.ts:1 [no-silencing] secretlint-disable');
        }
      }
      const secretsOff = await lineChecksStep.run(
        ctx({
          cwd: dir,
          config: cfg({ steps: { tests: { command: 't' } } }),
          scope,
          runCommand: async () => result({ exitCode: 0 }),
        }),
      );
      expect(secretsOff.kind).toBe('pass');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a GATE ERROR when a changed source file cannot be read', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-lines-step-'));
    try {
      const step = await lineChecksStep.run(
        ctx({
          cwd: dir,
          config: cfg({ steps: { 'line-checks': true } }),
          scope: {
            baseRef: 'main',
            mergeBaseSha: 'a',
            changedFiles: new Set(['src/missing.ts']),
            addedLines: new Map([['src/missing.ts', new Set([1])]]),
          },
          runCommand: async () => result({ exitCode: 0 }),
        }),
      );
      expect(step.kind).toBe('error');
      if (step.kind === 'error') {
        expect(step.reason).toMatch(/cannot read src\/missing\.ts/);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

