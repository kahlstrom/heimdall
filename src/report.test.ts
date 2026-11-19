import { describe, expect, it } from 'vitest';
import { emptyDiffWarning, exitCodeLabel, formatFinding, formatReport, formatRunPrelude, unversionedConfigWarning } from './report.js';
import { EXIT_GATE_ERROR, EXIT_GREEN, EXIT_RED, type GateOutcome } from './types.js';

describe('formatFinding', () => {
  it('prints file:line [rule] message', () => {
    expect(
      formatFinding({
        step: 'eslint',
        file: 'src/a.ts',
        line: 4,
        rule: 'no-unused-vars',
        message: "'x' is unused",
      }),
    ).toBe("src/a.ts:4 [no-unused-vars] 'x' is unused");
  });

  it('prints protected-path without a line number', () => {
    expect(
      formatFinding({
        step: 'protected-path',
        file: 'src/secret.ts',
        line: 0,
        rule: 'protected-path',
        message: 'this path is off-limits',
      }),
    ).toBe('src/secret.ts [protected-path] this path is off-limits');
  });

  it('prints config-uncommitted without a line number', () => {
    expect(
      formatFinding({
        step: 'config',
        file: 'configs/my-app/knip.json',
        line: 0,
        rule: 'config-uncommitted',
        message: 'commit this config change first',
      }),
    ).toBe('configs/my-app/knip.json [config-uncommitted] commit this config change first');
  });
});

describe('formatRunPrelude', () => {
  it('prints base, source, short merge-base, and changed-file count on separate lines', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    expect(formatRunPrelude('feat/x', sha, 12, 'cli')).toBe(
      'base: feat/x (from --base)\nmerge-base: 0123456\nchanged files: 12\n',
    );
    expect(formatRunPrelude('main', sha, 3, 'config')).toBe(
      'base: main (from config)\nmerge-base: 0123456\nchanged files: 3\n',
    );
    expect(formatRunPrelude('feat/gate-v1', sha, 12, 'upstream')).toBe(
      'base: feat/gate-v1 (from upstream)\nmerge-base: 0123456\nchanged files: 12\n',
    );
    expect(formatRunPrelude('origin/main', sha, 0, 'fallback')).toBe(
      'base: origin/main (fallback)\nmerge-base: 0123456\nchanged files: 0\n',
    );
  });
});

describe('formatReport', () => {
  it('prints GREEN with a summary block', () => {
    const outcome: GateOutcome = {
      kind: 'green',
      exitCode: EXIT_GREEN,
      baseRef: 'main',
      mergeBaseSha: 'abc123def',
      warnings: [],
      steps: [{ kind: 'pass', name: 'tests' }],
    };
    const text = formatReport(outcome);
    expect(text).toMatch(/result:\s+GREEN/);
    expect(text).toMatch(/exit:\s+0/);
    expect(text).toMatch(/tests\s+pass/);
    expect(text).toMatch(/HEIMDALL SUMMARY/);
  });

  it('prints the config file that was used', () => {
    const outcome: GateOutcome = {
      kind: 'green',
      exitCode: EXIT_GREEN,
      baseRef: 'main',
      mergeBaseSha: 'abc123def',
      configPath: '/Users/me/.heimdall/my-app/heimdall.config.json',
      warnings: [],
      steps: [{ kind: 'pass', name: 'tests' }],
    };
    const text = formatReport(outcome);
    expect(text).toMatch(/config:\s+\/Users\/me\/\.heimdall\/my-app\/heimdall.config.json/);
    expect(text.indexOf('config:')).toBeGreaterThan(text.indexOf('HEIMDALL SUMMARY'));
  });

  it('prints the outside-repo config commit hash next to the config path', () => {
    const outcome: GateOutcome = {
      kind: 'green',
      exitCode: EXIT_GREEN,
      baseRef: 'main',
      mergeBaseSha: 'abc123def',
      configPath: '/tmp/heimdall-home/my-app/heimdall.config.json',
      configCommit: '0123456789abcdef0123456789abcdef01234567',
      warnings: [],
      steps: [{ kind: 'pass', name: 'tests' }],
    };
    const text = formatReport(outcome);
    expect(text).toContain(
      'config:   /tmp/heimdall-home/my-app/heimdall.config.json  commit 0123456789abcdef0123456789abcdef01234567',
    );
  });

  it('prints a warning when the outside-repo config is not version-controlled', () => {
    const configDir = '/Users/me/.heimdall/my-app';
    const outcome: GateOutcome = {
      kind: 'green',
      exitCode: EXIT_GREEN,
      baseRef: 'main',
      mergeBaseSha: 'abc123def',
      configPath: `${configDir}/heimdall.config.json`,
      warnings: [unversionedConfigWarning(configDir)],
      steps: [{ kind: 'pass', name: 'tests' }],
    };
    const text = formatReport(outcome);
    expect(text).toMatch(/WARNING:\s+config is not version-controlled \(\/Users\/me\/\.heimdall\/my-app\)/);
  });

  it('prints the resolved base branch and commit', () => {
    const outcome: GateOutcome = {
      kind: 'green',
      exitCode: EXIT_GREEN,
      baseRef: 'feat/gate-v1',
      mergeBaseSha: '0123456789abcdef0123456789abcdef01234567',
      warnings: [],
      steps: [{ kind: 'pass', name: 'tests' }],
    };
    const text = formatReport(outcome);
    expect(text).toMatch(/base:\s+feat\/gate-v1/);
    expect(text).toMatch(/commit:\s+0123456789abcdef0123456789abcdef01234567/);
  });

  it('prints a loud empty-diff warning naming the base', () => {
    const base = 'feat/gate-v1';
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const outcome: GateOutcome = {
      kind: 'green',
      exitCode: EXIT_GREEN,
      baseRef: base,
      mergeBaseSha: sha,
      warnings: [emptyDiffWarning(base, sha)],
      steps: [{ kind: 'pass', name: 'tests' }],
    };
    const text = formatReport(outcome);
    expect(text).toMatch(/WARNING:\s+EMPTY DIFF against base feat\/gate-v1 \(0123456789abcdef0123456789abcdef01234567\)/);
    expect(text.indexOf('WARNING:')).toBeGreaterThan(text.indexOf('HEIMDALL SUMMARY'));
    expect(text.indexOf('WARNING:')).toBeLessThan(text.indexOf('result:'));
  });

  it('prints RED findings before the summary', () => {
    const outcome: GateOutcome = {
      kind: 'red',
      exitCode: EXIT_RED,
      baseRef: 'main',
      mergeBaseSha: 'abc123def',
      warnings: [],
      steps: [
        {
          kind: 'fail',
          name: 'eslint',
          findings: [{ step: 'eslint', file: 'src/a.ts', line: 2, rule: 'eqeqeq', message: 'use ===' }],
        },
      ],
    };
    const text = formatReport(outcome);
    expect(text.indexOf('src/a.ts:2')).toBeLessThan(text.indexOf('HEIMDALL SUMMARY'));
    expect(text).toMatch(/result:\s+RED/);
    expect(text).toMatch(/exit:\s+1/);
  });

  it('labels GATE ERROR distinctly and never as RED', () => {
    const outcome: GateOutcome = {
      kind: 'error',
      exitCode: EXIT_GATE_ERROR,
      reason: 'invalid heimdall.config.json: steps.eslint.command must be a non-empty string',
      baseRef: undefined,
      mergeBaseSha: undefined,
      warnings: [],
      steps: [],
    };
    const text = formatReport(outcome);
    expect(text).toMatch(/GATE ERROR: invalid heimdall.config.json/);
    expect(text).toMatch(/result:\s+GATE ERROR/);
    expect(text).toMatch(/exit:\s+2/);
    expect(text).not.toMatch(/result:\s+RED/);
  });
});

describe('exitCodeLabel', () => {
  it('maps the three gate exits', () => {
    expect(exitCodeLabel(0)).toBe('GREEN');
    expect(exitCodeLabel(1)).toBe('RED');
    expect(exitCodeLabel(2)).toBe('GATE ERROR');
    expect(exitCodeLabel(99)).toBe('unknown (99)');
  });
});

describe('formatReport completeness', () => {
  it('prints findings from a failed step even when the overall verdict is GATE ERROR', () => {
    const outcome: GateOutcome = {
      kind: 'error',
      exitCode: EXIT_GATE_ERROR,
      reason: 'knip output is not JSON',
      baseRef: 'main',
      mergeBaseSha: 'abc',
      baseSha: 'def',
      changedFileCount: 2,
      addedLineCount: 4,
      warnings: [],
      steps: [
        {
          kind: 'fail',
          name: 'eslint',
          findings: [{ step: 'eslint', file: 'src/a.ts', line: 2, rule: 'eqeqeq', message: 'use ===' }],
        },
        { kind: 'error', name: 'knip', reason: 'knip output is not JSON' },
      ],
    };
    const text = formatReport(outcome);
    expect(text.indexOf('src/a.ts:2')).toBeLessThan(text.indexOf('HEIMDALL SUMMARY'));
    expect(text).toMatch(/knip\s+GATE ERROR\s+\(knip output is not JSON\)/);
    expect(text).toMatch(/scope:\s+2 files, 4 added lines/);
    expect(text).toMatch(/resolved:\s+def/);
    expect(text).toMatch(/findings:\s+1/);
  });

  it('prints excused flakes on a passing tests step', () => {
    const outcome: GateOutcome = {
      kind: 'green',
      exitCode: EXIT_GREEN,
      baseRef: 'main',
      mergeBaseSha: 'abc',
      warnings: [],
      steps: [
        {
          kind: 'pass',
          name: 'tests',
          excused: ['src/bill.test.ts > suite > times out talking to billing'],
        },
      ],
    };
    const text = formatReport(outcome);
    expect(text).toMatch(/tests\s+pass\s+\(excused 1: src\/bill\.test\.ts > suite > times out talking to billing\)/);
  });
});
