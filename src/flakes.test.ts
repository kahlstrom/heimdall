import { describe, expect, it } from 'vitest';
import {
  classifyFailedTests,
  parseFlakeId,
  parseTestRun,
  testMatchesFlake,
  type TestFailure,
} from './flakes.js';

function reporterJson(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}

function namedResult(
  file: string,
  tests: ReadonlyArray<{ ancestorTitles: string[]; title: string; status: string }>,
  status = 'failed',
): Record<string, unknown> {
  return {
    name: file,
    status,
    message: '',
    assertionResults: tests,
  };
}

describe('parseFlakeId', () => {
  it('splits on the first file-plus-title separator', () => {
    expect(parseFlakeId('src/a.test.ts > suite > leaf')).toEqual({
      file: 'src/a.test.ts',
      title: 'suite > leaf',
    });
  });

  it('rejects a bare title or a whole file', () => {
    expect(parseFlakeId('times out talking to billing')).toBeUndefined();
    expect(parseFlakeId('src/a.test.ts')).toBeUndefined();
  });
});

describe('parseTestRun JSON reporter', () => {
  it('reads named failures from vitest/jest testResults', () => {
    const stdout = reporterJson({
      success: false,
      numFailedTests: 1,
      testResults: [
        namedResult('/repo/src/a.test.ts', [
          { ancestorTitles: ['suite'], title: 'does the thing', status: 'failed' },
          { ancestorTitles: ['suite'], title: 'ok', status: 'passed' },
        ]),
      ],
    });
    expect(parseTestRun(stdout, stdout)).toEqual([
      { kind: 'test', file: '/repo/src/a.test.ts', name: 'suite > does the thing' },
    ]);
  });

  it('treats a failed file with no assertions as a load failure', () => {
    const stdout = reporterJson({
      success: false,
      numFailedTests: 0,
      testResults: [
        {
          name: '/repo/src/load.test.ts',
          status: 'failed',
          message: 'cannot load this file',
          assertionResults: [],
        },
      ],
    });
    expect(parseTestRun(stdout, stdout)).toEqual([
      { kind: 'file-load', file: '/repo/src/load.test.ts', name: 'test file failed to load' },
    ]);
  });

  it('treats a failed file whose tests did not fail as a hook failure', () => {
    const stdout = reporterJson({
      success: false,
      numFailedTests: 0,
      testResults: [
        namedResult(
          '/repo/src/hook.test.ts',
          [{ ancestorTitles: ['hooks'], title: 'never runs', status: 'skipped' }],
          'failed',
        ),
      ],
    });
    expect(parseTestRun(stdout, stdout)).toEqual([
      { kind: 'hook', file: '/repo/src/hook.test.ts', name: 'failing hook' },
    ]);
  });

  it('prefers the JSON reporter over FAIL lines in mixed stdout', () => {
    const json = reporterJson({
      success: false,
      numFailedTests: 0,
      testResults: [
        {
          name: '/repo/src/load.test.ts',
          status: 'failed',
          message: 'cannot load',
          assertionResults: [],
        },
      ],
    });
    const mixed = `Expected { a: 1 }\n FAIL  src/flake.test.ts > suite > times out talking to billing\n${json}`;
    const parsed = parseTestRun(mixed, mixed);
    expect(parsed).toEqual([
      { kind: 'file-load', file: '/repo/src/load.test.ts', name: 'test file failed to load' },
    ]);
  });

  it('does not invent a failure for coverage-threshold JSON with no named tests', () => {
    const stdout = reporterJson({
      success: false,
      numFailedTests: 0,
      numFailedTestSuites: 0,
      testResults: [
        namedResult(
          '/repo/src/coverage.test.ts',
          [{ ancestorTitles: ['coverage'], title: 'stays green', status: 'passed' }],
          'passed',
        ),
      ],
    });
    expect(parseTestRun(stdout, `${stdout}\nJest: "global" coverage threshold for statements (80%) not met: 40%\n`)).toEqual(
      [],
    );
  });

  it('keeps unhandled errors from text even when JSON reports success', () => {
    const stdout = reporterJson({
      success: true,
      numFailedTests: 0,
      testResults: [
        namedResult(
          '/repo/src/unhandled.test.ts',
          [{ ancestorTitles: ['async'], title: 'passes but leaks', status: 'passed' }],
          'passed',
        ),
      ],
    });
    const combined = `${stdout}\n⎯ Unhandled Errors ⎯\n     Errors  1 error\n`;
    expect(parseTestRun(stdout, combined)).toEqual([
      { kind: 'unhandled', file: '', name: 'unhandled error' },
    ]);
  });
});

describe('parseTestRun text', () => {
  it('parses vitest verbose FAIL titles', () => {
    const output = `
 FAIL  src/a.test.ts > suite > does the thing
 FAIL  src/a.test.ts > suite > does the thing
 FAIL  src/b.test.ts > other > another case
`;
    expect(parseTestRun('', output)).toEqual([
      { kind: 'test', file: 'src/a.test.ts', name: 'suite > does the thing' },
      { kind: 'test', file: 'src/b.test.ts', name: 'other > another case' },
    ]);
  });

  it('parses a workspace-prefixed FAIL line', () => {
    const output = ' FAIL  |web| src/a.test.ts > suite > does the thing\n';
    expect(parseTestRun('', output)).toEqual([
      { kind: 'test', file: 'src/a.test.ts', name: 'suite > does the thing' },
    ]);
  });

  it('parses an ANSI-colored vitest FAIL line identically to plain text', () => {
    const plain = ' FAIL  src/a.test.ts > suite > does the thing\n';
    const colored = '\x1b[31m\x1b[1mFAIL\x1b[22m\x1b[39m  src/a.test.ts > suite > does the thing\n';
    expect(parseTestRun('', colored)).toEqual(parseTestRun('', plain));
    expect(parseTestRun('', colored)).toEqual([
      { kind: 'test', file: 'src/a.test.ts', name: 'suite > does the thing' },
    ]);
  });

  it('parses a file that failed to load', () => {
    const output = ' FAIL  src/load.test.ts [ src/load.test.ts ]\n';
    expect(parseTestRun('', output)).toEqual([
      { kind: 'file-load', file: 'src/load.test.ts', name: 'test file failed to load' },
    ]);
  });

  it('parses a failing hook under Failed Suites', () => {
    const output = `
⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  src/hook.test.ts > hooks
`;
    expect(parseTestRun('', output)).toEqual([
      { kind: 'hook', file: 'src/hook.test.ts', name: 'hooks' },
    ]);
  });

  it('parses jest bullet titles with the FAIL file', () => {
    const output = 'FAIL src/bill.test.ts\n  ● billing › times out talking to billing\n';
    expect(parseTestRun('', output)).toEqual([
      { kind: 'test', file: 'src/bill.test.ts', name: 'billing > times out talking to billing' },
    ]);
  });

  it('treats extra Tests-failed counts as unparsed failures', () => {
    const output = `
 FAIL  src/a.test.ts > suite > times out talking to billing
      Tests  2 failed | 1 passed (3)
`;
    expect(parseTestRun('', output)).toEqual([
      { kind: 'test', file: 'src/a.test.ts', name: 'suite > times out talking to billing' },
      { kind: 'unparsed', file: '', name: 'failure with no FAIL file > title line' },
    ]);
  });

  it('reconciles ANSI-colored summary counts and errors', () => {
    const output = [
      '\x1b[31m\x1b[1mFAIL\x1b[22m\x1b[39m  src/a.test.ts > suite > does the thing',
      '      \x1b[2mTests\x1b[22m  \x1b[1m\x1b[31m2 failed\x1b[39m\x1b[22m | \x1b[32m1 passed\x1b[39m (3)',
      '     \x1b[2mErrors\x1b[22m  \x1b[1m\x1b[31m1 error\x1b[39m\x1b[22m',
    ].join('\n');
    expect(parseTestRun('', output)).toEqual([
      { kind: 'test', file: 'src/a.test.ts', name: 'suite > does the thing' },
      { kind: 'unparsed', file: '', name: 'failure with no FAIL file > title line' },
      { kind: 'unhandled', file: '', name: 'unhandled error' },
    ]);
  });

  it('returns undefined when nothing is parseable', () => {
    expect(parseTestRun('Boom, no FAIL lines', 'Boom, no FAIL lines')).toBeUndefined();
  });
});

describe('classifyFailedTests', () => {
  const flake = 'src/bill.test.ts > suite > times out talking to billing';

  it('matches only the listed file plus full title', () => {
    const classified = classifyFailedTests(
      [{ kind: 'test', file: 'src/bill.test.ts', name: 'suite > times out talking to billing' }],
      [flake],
    );
    expect(classified.unknown).toEqual([]);
    expect(classified.matched).toHaveLength(1);
  });

  it('does not forgive the same title in another file', () => {
    const classified = classifyFailedTests(
      [{ kind: 'test', file: 'src/other.test.ts', name: 'suite > times out talking to billing' }],
      [flake],
    );
    expect(classified.unknown).toHaveLength(1);
  });

  it('does not forgive the same leaf in another suite', () => {
    const classified = classifyFailedTests(
      [{ kind: 'test', file: 'src/bill.test.ts', name: 'other suite > times out talking to billing' }],
      [flake],
    );
    expect(classified.unknown).toHaveLength(1);
  });

  it('never treats load, hook, or unhandled failures as flakes', () => {
    const failures: TestFailure[] = [
      { kind: 'file-load', file: 'src/load.test.ts', name: 'test file failed to load' },
      { kind: 'hook', file: 'src/hook.test.ts', name: 'failing hook' },
      { kind: 'unhandled', file: '', name: 'unhandled error' },
    ];
    const classified = classifyFailedTests(failures, [flake, 'src/load.test.ts > test file failed to load']);
    expect(classified.matched).toEqual([]);
    expect(classified.unknown).toHaveLength(3);
  });
});

describe('testMatchesFlake', () => {
  it('requires file and full title', () => {
    const test = { file: 'src/a.test.ts', name: 'suite > leaf' };
    expect(testMatchesFlake(test, 'src/a.test.ts > suite > leaf')).toBe(true);
    expect(testMatchesFlake(test, 'src/a.test.ts > leaf')).toBe(false);
    expect(testMatchesFlake(test, 'leaf')).toBe(false);
    expect(testMatchesFlake({ file: '/abs/src/a.test.ts', name: 'suite > leaf' }, 'src/a.test.ts > suite > leaf')).toBe(
      true,
    );
  });
});
