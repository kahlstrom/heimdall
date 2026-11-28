import { describe, expect, it } from 'vitest';
import { emptyDiffWarning, exitCodeLabel, formatFinding, formatReport, formatRunPrelude, unversionedConfigWarning } from './report.js';
import { EXIT_GATE_ERROR, EXIT_GREEN, EXIT_RED, type GateOutcome } from './types.js';

const HEAD_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const MERGE_BASE_SHA = 'abc123def';
const FULL_MERGE_BASE_SHA = '0123456789abcdef0123456789abcdef01234567';

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

  it('prints architecture findings as rule plus from -> to without a line number', () => {
    expect(
      formatFinding({
        step: 'architecture',
        file: 'src/a.ts',
        line: 0,
        rule: 'not-to-unallowed',
        message: 'src/a.ts -> src/forbidden.ts',
      }),
    ).toBe('[not-to-unallowed] src/a.ts -> src/forbidden.ts');
  });

  it('prints secrets findings as file:line [rule] with no message text', () => {
    expect(
      formatFinding({
        step: 'secrets',
        file: 'src/a.ts',
        line: 4,
        rule: '@secretlint/secretlint-rule-github',
        message: 'found GitHub Token: ghp_LEAKEDSECRETVALUE_doNotPrint',
      }),
    ).toBe('src/a.ts:4 [@secretlint/secretlint-rule-github]');
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
      mergeBaseSha: MERGE_BASE_SHA,
      headSha: HEAD_SHA,
      warnings: [],
      steps: [{ kind: 'pass', name: 'tests' }],
    };
    const text = formatReport(outcome);
    expect(text).toMatch(/result:\s+GREEN/);
    expect(text).toMatch(/exit:\s+0/);
    expect(text).toMatch(/tests\s+pass/);
    expect(text).toMatch(/HEIMDALL SUMMARY/);
    expect(text).toContain(`head:     ${HEAD_SHA}`);
  });

  it('prints the config file that was used', () => {
    const outcome: GateOutcome = {
      kind: 'green',
      exitCode: EXIT_GREEN,
      baseRef: 'main',
      mergeBaseSha: MERGE_BASE_SHA,
      headSha: HEAD_SHA,
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
      mergeBaseSha: MERGE_BASE_SHA,
      headSha: HEAD_SHA,
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
      mergeBaseSha: MERGE_BASE_SHA,
      headSha: HEAD_SHA,
      configPath: `${configDir}/heimdall.config.json`,
      warnings: [unversionedConfigWarning(configDir)],
      steps: [{ kind: 'pass', name: 'tests' }],
    };
    const text = formatReport(outcome);
    expect(text).toMatch(/WARNING:\s+config is not version-controlled \(\/Users\/me\/\.heimdall\/my-app\)/);
  });

  it('prints the resolved base branch, HEAD, and commit', () => {
    const outcome: GateOutcome = {
      kind: 'green',
      exitCode: EXIT_GREEN,
      baseRef: 'feat/gate-v1',
      mergeBaseSha: FULL_MERGE_BASE_SHA,
      headSha: HEAD_SHA,
      baseSha: 'aaaabbbbccccddddeeeeffff0000111122223333',
      warnings: [],
      steps: [{ kind: 'pass', name: 'tests' }],
    };
    const text = formatReport(outcome);
    expect(text).toMatch(/base:\s+feat\/gate-v1/);
    expect(text).toContain(`head:     ${HEAD_SHA}`);
    expect(text).toMatch(/commit:\s+0123456789abcdef0123456789abcdef01234567/);
    expect(text).toMatch(/resolved:\s+aaaabbbbccccddddeeeeffff0000111122223333/);
    expect(text.indexOf('base:')).toBeLessThan(text.indexOf('head:'));
    expect(text.indexOf('head:')).toBeLessThan(text.indexOf('commit:'));
    expect(text.indexOf('commit:')).toBeLessThan(text.indexOf('resolved:'));
  });

  it('prints a loud empty-diff warning naming the base', () => {
    const base = 'feat/gate-v1';
    const sha = FULL_MERGE_BASE_SHA;
    const outcome: GateOutcome = {
      kind: 'green',
      exitCode: EXIT_GREEN,
      baseRef: base,
      mergeBaseSha: sha,
      headSha: HEAD_SHA,
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
      mergeBaseSha: MERGE_BASE_SHA,
      headSha: HEAD_SHA,
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
    expect(text).toContain(`head:     ${HEAD_SHA}`);
  });

  it('prints secrets findings as rule id plus file:line and never the secretlint message', () => {
    const leaked = 'ghp_LEAKEDSECRETVALUE_doNotPrint';
    const outcome: GateOutcome = {
      kind: 'red',
      exitCode: EXIT_RED,
      baseRef: 'main',
      mergeBaseSha: MERGE_BASE_SHA,
      headSha: HEAD_SHA,
      warnings: [],
      steps: [
        {
          kind: 'fail',
          name: 'secrets',
          findings: [
            {
              step: 'secrets',
              file: 'src/a.ts',
              line: 4,
              rule: '@secretlint/secretlint-rule-github',
              message: `found GitHub Token: ${leaked}`,
            },
          ],
        },
      ],
    };
    const text = formatReport(outcome);
    expect(text).toMatch(/^src\/a\.ts:4 \[@secretlint\/secretlint-rule-github\]$/m);
    expect(text).not.toContain(leaked);
    expect(text).not.toContain('found GitHub Token');
  });

  it('labels GATE ERROR distinctly and never as RED', () => {
    const outcome: GateOutcome = {
      kind: 'error',
      exitCode: EXIT_GATE_ERROR,
      reason: 'invalid heimdall.config.json: steps.eslint.command must be a non-empty string',
      baseRef: undefined,
      mergeBaseSha: undefined,
      headSha: undefined,
      warnings: [],
      steps: [],
    };
    const text = formatReport(outcome);
    expect(text).toMatch(/GATE ERROR: invalid heimdall.config.json/);
    expect(text).toMatch(/result:\s+GATE ERROR/);
    expect(text).toMatch(/exit:\s+2/);
    expect(text).not.toMatch(/result:\s+RED/);
    expect(text).not.toMatch(/^head:/m);
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
      headSha: HEAD_SHA,
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
    expect(text).toContain(`head:     ${HEAD_SHA}`);
    expect(text).toMatch(/resolved:\s+def/);
    expect(text).toMatch(/findings:\s+1/);
  });

  it('prints excused flakes on a passing tests step', () => {
    const outcome: GateOutcome = {
      kind: 'green',
      exitCode: EXIT_GREEN,
      baseRef: 'main',
      mergeBaseSha: 'abc',
      headSha: HEAD_SHA,
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

  it('aligns step status columns including knip-production', () => {
    const outcome: GateOutcome = {
      kind: 'red',
      exitCode: EXIT_RED,
      baseRef: 'main',
      mergeBaseSha: MERGE_BASE_SHA,
      headSha: HEAD_SHA,
      warnings: [],
      steps: [
        { kind: 'pass', name: 'knip' },
        {
          kind: 'fail',
          name: 'knip-production',
          findings: [
            {
              step: 'knip-production',
              file: 'src/lib.ts',
              line: 3,
              rule: 'exports',
              message: 'onlyUsedInTests',
            },
          ],
        },
        { kind: 'pass', name: 'architecture' },
      ],
    };
    const text = formatReport(outcome);
    expect(text).toContain('src/lib.ts:3 [exports] onlyUsedInTests');
    expect(text).toContain('knip            pass');
    expect(text).toContain('knip-production FAIL  (1)');
    expect(text).toContain('architecture    pass');
  });

  it('prints node-heap summary lines for default, CLI, env, and NODE_OPTIONS', () => {
    const baseOutcome: GateOutcome = {
      kind: 'green',
      exitCode: EXIT_GREEN,
      baseRef: 'main',
      mergeBaseSha: MERGE_BASE_SHA,
      headSha: HEAD_SHA,
      warnings: [],
      steps: [{ kind: 'pass', name: 'tests' }],
    };
    expect(formatReport({ ...baseOutcome, nodeHeap: { kind: 'default' } })).toContain('node-heap: default');
    expect(
      formatReport({ ...baseOutcome, nodeHeap: { kind: 'configured', mb: 8192, source: 'cli' } }),
    ).toContain('node-heap: 8192 MB (from --node-heap)');
    expect(
      formatReport({ ...baseOutcome, nodeHeap: { kind: 'configured', mb: 8192, source: 'env' } }),
    ).toContain('node-heap: 8192 MB (from HEIMDALL_NODE_HEAP_MB)');
    expect(
      formatReport({ ...baseOutcome, nodeHeap: { kind: 'node-options', mb: 4096 } }),
    ).toContain('node-heap: 4096 MB (from NODE_OPTIONS)');
    expect(
      formatReport({ ...baseOutcome, nodeHeap: { kind: 'node-options' } }),
    ).toContain('node-heap: from NODE_OPTIONS');
  });
});
