import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyFindingScope,
  configFileInDiff,
  eslintMetricValue,
  filterFindingsToScope,
  findingsNotInBase,
  identityMessage,
  loadDiffScope,
  mapArchitectureRenameMessage,
  matchFindingKey,
  noMetric,
  parseChangedNewLines,
  stableEslintMessage,
  toRepoPath,
} from './diff.js';
import { resolveBaseRef } from './git.js';
import type { DiffScope, Finding } from './types.js';
import { commitAll, git, withTempRepo, writeRepoFile } from '../test/helpers/temp-repo.js';

function addedLineNumbers(diff: string): number[] {
  const parsed = parseChangedNewLines(diff);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return [...parsed.value].sort((left, right) => left - right);
}

describe('parseChangedNewLines', () => {
  it.each([
    {
      name: 'collects added line numbers from a unified hunk',
      diff: ['@@ -1,0 +2,1 @@', '+const added = 1;'],
      expected: [2],
    },
    {
      name: 'ignores removed lines',
      diff: ['@@ -2,1 +2,0 @@', '-const gone = 1;'],
      expected: [],
    },
    {
      name: 'does not advance past a no-newline marker',
      diff: [
        '@@ -1 +1,2 @@',
        '-a',
        '\\ No newline at end of file',
        '+a',
        '+b',
      ],
      expected: [1, 2],
    },
    {
      name: 'counts an added line whose content begins with ++',
      diff: ['@@ -1 +1,2 @@', '-y', '+++x', '+z'],
      expected: [1, 2],
    },
    {
      name: 'handles multiple hunks',
      diff: ['@@ -1,0 +1,1 @@', '+first', '@@ -10,0 +12,2 @@', '+second', '+third'],
      expected: [1, 12, 13],
    },
    {
      name: 'treats an omitted count as 1',
      diff: ['@@ -5 +5 @@', '-old', '+new'],
      expected: [5],
    },
    {
      name: 'handles a zero-count new side (deletion hunk)',
      diff: ['@@ -1,1 +0,0 @@', '-gone'],
      expected: [],
    },
    {
      name: 'handles a zero-count old side (insertion hunk)',
      diff: ['@@ -0,0 +1,2 @@', '+a', '+b'],
      expected: [1, 2],
    },
    {
      name: 'maps the last line of a file exactly',
      diff: ['@@ -3 +3,2 @@', '-c', '+c', '+d'],
      expected: [3, 4],
    },
    {
      name: 'parses a hunk whose last line has no trailing newline',
      diff: '@@ -1 +1,1 @@\n+last',
      expected: [1],
    },
  ])('$name', ({ diff, expected }) => {
    const text = Array.isArray(diff) ? diff.join('\n') : diff;
    expect(addedLineNumbers(text)).toEqual(expected);
  });

  it('is an error when the hunk has fewer new-side lines than the header count', () => {
    const parsed = parseChangedNewLines(['@@ -1,0 +1,2 @@', '+only-one'].join('\n'));
    expect(parsed.ok).toBe(false);
  });
});

const SCOPE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-scope-'));
writeRepoFile(SCOPE_ROOT, 'src/new.ts', 'x\n'.repeat(24));
writeRepoFile(SCOPE_ROOT, 'src/legacy.ts', 'x\n'.repeat(24));
writeRepoFile(SCOPE_ROOT, 'pkg/src/new.ts', 'x\n'.repeat(24));
writeRepoFile(SCOPE_ROOT, 'blob.bin', 'binary');

describe('filterFindingsToScope', () => {
  const scope: DiffScope = {
    baseRef: 'main',
    mergeBaseSha: 'aaa',
    changedFiles: new Set(['src/new.ts']),
    addedLines: new Map([['src/new.ts', new Set([4, 5])]]),
    renamedFrom: new Map(),
  };

  function hit(file: string, line: number, endLine?: number): Finding {
    if (endLine === undefined) {
      return { step: 'eslint', file, line, rule: 'no-unused-vars', message: 'x' };
    }
    return { step: 'jscpd', file, line, endLine, rule: 'duplicate', message: 'dup' };
  }

  function kept(findings: Finding[]): Finding[] {
    const filtered = filterFindingsToScope(findings, scope, SCOPE_ROOT);
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) {
      throw new Error(filtered.error);
    }
    return filtered.value;
  }

  it('keeps a finding on an added line of a changed file', () => {
    expect(kept([hit('src/new.ts', 4)])).toHaveLength(1);
  });

  it('drops a finding on an unchanged line of a changed file', () => {
    expect(kept([hit('src/new.ts', 1)])).toHaveLength(0);
  });

  it('drops a finding in an unchanged file', () => {
    expect(kept([hit('src/legacy.ts', 4)])).toHaveLength(0);
  });

  it('keeps a file-level finding when the file changed', () => {
    expect(kept([hit('src/new.ts', 0)])).toHaveLength(1);
  });

  it('keeps a range finding that overlaps an added line', () => {
    expect(kept([hit('src/new.ts', 1, 6)])).toHaveLength(1);
  });

  it('drops a range finding that does not overlap added lines', () => {
    expect(kept([hit('src/new.ts', 10, 20)])).toHaveLength(0);
  });

  it('does not match a finding via a path suffix', () => {
    expect(kept([hit('pkg/src/new.ts', 4)])).toHaveLength(0);
    expect(classifyFindingScope(hit('pkg/src/new.ts', 4), scope, SCOPE_ROOT).kind).toBe('out');
  });

  it('is a GATE ERROR when the finding path is outside the repo', () => {
    const filtered = filterFindingsToScope([hit('/elsewhere/src/new.ts', 4)], scope, SCOPE_ROOT);
    expect(filtered.ok).toBe(false);
    if (!filtered.ok) {
      expect(filtered.error).toMatch(/cannot map finding to a file in the repo/);
    }
  });

  it('is a GATE ERROR when the finding path maps inside the repo but the file does not exist', () => {
    const filtered = filterFindingsToScope([hit('src/missing.ts', 4)], scope, SCOPE_ROOT);
    expect(filtered.ok).toBe(false);
    if (!filtered.ok) {
      expect(filtered.error).toMatch(/cannot map finding to a file in the repo/);
    }
  });

  it('keeps a line finding on a changed file with no line map (binary / unknown)', () => {
    const binaryScope: DiffScope = {
      ...scope,
      changedFiles: new Set(['blob.bin']),
      addedLines: new Map(),
    };
    const filtered = filterFindingsToScope([hit('blob.bin', 1)], binaryScope, SCOPE_ROOT);
    expect(filtered.ok).toBe(true);
    if (filtered.ok) {
      expect(filtered.value).toHaveLength(1);
    }
  });
});

describe('findingsNotInBase', () => {
  const hit = (file: string, rule: string, message: string, line: number): Finding => ({
    step: 'knip',
    file,
    line,
    rule,
    message,
  });
  const identityScope: DiffScope = {
    baseRef: 'main',
    mergeBaseSha: 'aaa',
    changedFiles: new Set(),
    addedLines: new Map(),
    renamedFrom: new Map(),
  };
  const keyOf = (finding: Finding): string =>
    matchFindingKey(finding, identityScope, SCOPE_ROOT, identityMessage);

  it('keeps a finding that is not in the base set, even on the same line', () => {
    const current = [hit('src/lib.ts', 'exports', 'helper', 4)];
    const base: Finding[] = [];
    expect(findingsNotInBase(current, base, keyOf, noMetric)).toEqual(current);
  });

  it('drops a finding that already existed at the base, ignoring line drift', () => {
    const current = [hit('src/legacy.ts', 'exports', 'leftover', 12)];
    const base = [hit('src/legacy.ts', 'exports', 'leftover', 1)];
    expect(findingsNotInBase(current, base, keyOf, noMetric)).toEqual([]);
  });

  it('keeps a second identical finding when the base only has one', () => {
    const current = [hit('src/a.ts', 'no-unused-vars', 'x', 4), hit('src/a.ts', 'no-unused-vars', 'x', 10)];
    const base = [hit('src/a.ts', 'no-unused-vars', 'x', 4)];
    expect(findingsNotInBase(current, base, keyOf, noMetric)).toEqual([current[1]]);
  });

  it('drops two identical findings when the base has both', () => {
    const current = [hit('src/a.ts', 'no-unused-vars', 'x', 4), hit('src/a.ts', 'no-unused-vars', 'x', 10)];
    const base = [hit('src/a.ts', 'no-unused-vars', 'x', 1), hit('src/a.ts', 'no-unused-vars', 'x', 2)];
    expect(findingsNotInBase(current, base, keyOf, noMetric)).toEqual([]);
  });

  const renamedScope: DiffScope = {
    baseRef: 'main',
    mergeBaseSha: 'aaa',
    changedFiles: new Set(['src/old.ts', 'src/new.ts']),
    addedLines: new Map([['src/new.ts', new Set()]]),
    renamedFrom: new Map([['src/new.ts', 'src/old.ts']]),
  };

  it('matches a finding in a renamed file under the old path', () => {
    const current = [hit('src/new.ts', 'exports', 'helper', 1)];
    const base = [hit('src/old.ts', 'exports', 'helper', 1)];
    const renamedKeyOf = (finding: Finding): string =>
      matchFindingKey(finding, renamedScope, SCOPE_ROOT, identityMessage);
    expect(findingsNotInBase(current, base, renamedKeyOf, noMetric)).toEqual([]);
  });

  function architectureHit(file: string, message: string): Finding {
    return { step: 'architecture', file, line: 0, rule: 'not-to-unallowed', message };
  }

  function architectureKeyOf(scope: DiffScope): (finding: Finding) => string {
    return (finding) =>
      matchFindingKey(finding, scope, SCOPE_ROOT, (message) =>
        mapArchitectureRenameMessage(message, scope.renamedFrom),
      );
  }

  it('maps architecture from -> to path segments through a git rename', () => {
    const current = [architectureHit('src/new.ts', 'src/new.ts -> src/forbidden.ts')];
    const base = [architectureHit('src/old.ts', 'src/old.ts -> src/forbidden.ts')];
    expect(findingsNotInBase(current, base, architectureKeyOf(renamedScope), noMetric)).toEqual([]);
  });

  const nestedRenameScope: DiffScope = {
    ...identityScope,
    changedFiles: new Set(['packages/core/src/x.ts', 'src/x.ts']),
    addedLines: new Map([['src/x.ts', new Set()]]),
    renamedFrom: new Map([['src/x.ts', 'packages/core/src/x.ts']]),
  };

  it('matches a nested-path rename whose old path contains the new path', () => {
    const current = [architectureHit('src/x.ts', 'src/x.ts -> src/forbidden.ts')];
    const base = [architectureHit('packages/core/src/x.ts', 'packages/core/src/x.ts -> src/forbidden.ts')];
    expect(findingsNotInBase(current, base, architectureKeyOf(nestedRenameScope), noMetric)).toEqual([]);
  });

  it('does not rewrite an architecture path that only contains the new path', () => {
    const current = [architectureHit('packages/app/src/x.ts', 'packages/app/src/x.ts -> src/forbidden.ts')];
    const base = [architectureHit('packages/app/src/x.ts', 'packages/app/src/x.ts -> src/forbidden.ts')];
    expect(findingsNotInBase(current, base, architectureKeyOf(nestedRenameScope), noMetric)).toEqual([]);
  });
});

describe('stableEslintMessage', () => {
  const scope: DiffScope = {
    baseRef: 'main',
    mergeBaseSha: 'aaa',
    changedFiles: new Set(['src/a.ts']),
    addedLines: new Map([['src/a.ts', new Set([1])]]),
    renamedFrom: new Map(),
  };
  const keyOf = (finding: Finding): string => matchFindingKey(finding, scope, SCOPE_ROOT, stableEslintMessage);
  const eslintHit = (
    message: string,
    extras: { line?: number; messageId?: string; file?: string; rule?: string } = {},
  ): Finding => {
    const finding: Finding = {
      step: 'eslint',
      file: extras.file ?? 'src/a.ts',
      line: extras.line ?? 1,
      rule: extras.rule ?? 'x',
      message,
    };
    if (extras.messageId === undefined) {
      return finding;
    }
    return { ...finding, messageId: extras.messageId };
  };

  const complexityHit = (measured: number, line = 1): Finding =>
    eslintHit(`Function has a complexity of ${measured}. Maximum allowed is 10.`, {
      rule: 'complexity',
      messageId: 'complex',
      line,
    });

  it('normalizes line and column numbers without touching identifier names', () => {
    expect(stableEslintMessage("'x' is already declared in the upper scope on line 4 column 10.")).toBe(
      "'x' is already declared in the upper scope on line # column #.",
    );
    expect(stableEslintMessage("'foo2' is defined but never used.")).toBe("'foo2' is defined but never used.");
  });

  it('normalizes measured complexity and max-* values', () => {
    expect(stableEslintMessage('Function has a complexity of 15. Maximum allowed is 10.')).toBe(
      'Function has a complexity of #. Maximum allowed is #.',
    );
  });

  it('treats a no-shadow finding as the same after line numbers drift', () => {
    const current = [
      eslintHit("'x' is already declared in the upper scope on line 8 column 2.", {
        line: 12,
        messageId: 'noShadow',
      }),
    ];
    const base = [
      eslintHit("'x' is already declared in the upper scope on line 4 column 10.", {
        line: 8,
        messageId: 'noShadow',
      }),
    ];
    expect(findingsNotInBase(current, base, keyOf, eslintMetricValue)).toEqual([]);
  });

  it("treats a no-shadow finding as the same when the message says 'on line 42' vs 'on line 43'", () => {
    const current = [
      eslintHit("'x' is already declared in the upper scope on line 43.", {
        rule: 'no-shadow',
        messageId: 'noShadow',
      }),
    ];
    const base = [
      eslintHit("'x' is already declared in the upper scope on line 42.", {
        rule: 'no-shadow',
        messageId: 'noShadow',
      }),
    ];
    expect(findingsNotInBase(current, base, keyOf, eslintMetricValue)).toEqual([]);
  });

  it('treats a complexity finding as new when the measured value increases', () => {
    const current = [complexityHit(20)];
    const base = [complexityHit(15)];
    expect(findingsNotInBase(current, base, keyOf, eslintMetricValue)).toEqual(current);
  });

  it('treats a complexity finding as the same when the measured value stays the same or drops', () => {
    const base = [complexityHit(15)];
    expect(findingsNotInBase([complexityHit(15)], base, keyOf, eslintMetricValue)).toEqual([]);
    expect(findingsNotInBase([complexityHit(12)], base, keyOf, eslintMetricValue)).toEqual([]);
  });

  it('pairs same-key metric findings as a multiset of measured values', () => {
    const base = [complexityHit(15, 1), complexityHit(30, 2)];
    const mixed = [complexityHit(29, 1), complexityHit(16, 2)];
    const reversed = [complexityHit(16, 1), complexityHit(29, 2)];
    const worse = [complexityHit(31, 1), complexityHit(15, 2)];
    expect(findingsNotInBase(mixed, base, keyOf, eslintMetricValue)).toEqual([mixed[1]]);
    expect(findingsNotInBase(reversed, base, keyOf, eslintMetricValue)).toEqual([reversed[0]]);
    expect(findingsNotInBase(worse, base, keyOf, eslintMetricValue)).toEqual([worse[0]]);
  });

  it('does not treat equal or lower same-key metrics as new when each has a base slot', () => {
    const base = [complexityHit(15, 1), complexityHit(30, 2)];
    expect(findingsNotInBase([complexityHit(15, 1), complexityHit(30, 2)], base, keyOf, eslintMetricValue)).toEqual(
      [],
    );
    expect(findingsNotInBase([complexityHit(12, 1), complexityHit(14, 2)], base, keyOf, eslintMetricValue)).toEqual(
      [],
    );
  });

  it('does not treat a mid-range metric as new when a higher base slot remains', () => {
    const current = [complexityHit(16)];
    const base = [complexityHit(15, 1), complexityHit(30, 2)];
    expect(findingsNotInBase(current, base, keyOf, eslintMetricValue)).toEqual([]);
  });

  it('still counts a second metric finding as new when the base only has one', () => {
    const current = [complexityHit(12, 1), complexityHit(12, 2)];
    const base = [complexityHit(15)];
    expect(findingsNotInBase(current, base, keyOf, eslintMetricValue)).toEqual([current[1]]);
  });

  it('does not spend a base slot on a metric finding that got worse', () => {
    const current = [complexityHit(31, 1), complexityHit(12, 2)];
    const base = [complexityHit(15)];
    expect(findingsNotInBase(current, base, keyOf, eslintMetricValue)).toEqual([current[0]]);
  });

  it('does not compare a plugin rule by measured value', () => {
    const current = [
      eslintHit('Function has a complexity of 20. Maximum allowed is 10.', { rule: '@foo/complexity' }),
    ];
    const base = [
      eslintHit('Function has a complexity of 15. Maximum allowed is 10.', { rule: '@foo/complexity' }),
    ];
    expect(findingsNotInBase(current, base, keyOf, eslintMetricValue)).toEqual([]);
  });

  it('treats a max-params finding as new when the measured value increases', () => {
    const current = [
      eslintHit("Function 'fn' has too many parameters (4). Maximum allowed is 3.", {
        rule: 'max-params',
      }),
    ];
    const base = [
      eslintHit("Function 'fn' has too many parameters (3). Maximum allowed is 3.", {
        rule: 'max-params',
      }),
    ];
    expect(findingsNotInBase(current, base, keyOf, eslintMetricValue)).toEqual(current);
  });

  it('keeps unused identifiers that differ only by digits distinct', () => {
    const current = [eslintHit("'foo3' is defined but never used.", { messageId: 'unusedVar' })];
    const base = [eslintHit("'foo2' is defined but never used.", { messageId: 'unusedVar' })];
    expect(findingsNotInBase(current, base, keyOf, eslintMetricValue)).toEqual(current);
  });

  it('still counts a second identical eslint finding as new', () => {
    const current = [
      eslintHit("'x' is already declared in the upper scope on line 8 column 2.", { line: 8, messageId: 'noShadow' }),
      eslintHit("'x' is already declared in the upper scope on line 20 column 1.", { line: 20, messageId: 'noShadow' }),
    ];
    const base = [
      eslintHit("'x' is already declared in the upper scope on line 4 column 10.", { line: 4, messageId: 'noShadow' }),
    ];
    expect(findingsNotInBase(current, base, keyOf, eslintMetricValue)).toEqual([current[1]]);
  });
});

describe('toRepoPath', () => {
  it('strips the repo root prefix', () => {
    expect(toRepoPath('/repo/src/a.ts', '/repo')).toBe('src/a.ts');
  });

  it('returns . for the repo root itself', () => {
    expect(toRepoPath('/repo', '/repo')).toBe('.');
  });

  it('resolves a relative path against the repo root, not process.cwd()', () => {
    const previous = process.cwd();
    try {
      process.chdir(os.tmpdir());
      expect(toRepoPath('src/a.ts', '/repo')).toBe('src/a.ts');
    } finally {
      process.chdir(previous);
    }
  });

  it('returns undefined for a path outside the repo', () => {
    expect(toRepoPath('/elsewhere/src/a.ts', '/repo')).toBeUndefined();
  });

  it('realpath-matches a symlinked repo root', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-path-'));
    try {
      const repo = path.join(parent, 'repo');
      fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'src/a.ts'), 'export const a = 1;\n');
      const link = path.join(parent, 'link');
      fs.symlinkSync(repo, link);
      expect(toRepoPath(path.join(link, 'src/a.ts'), repo)).toBe('src/a.ts');
      expect(toRepoPath(path.join(repo, 'src/a.ts'), link)).toBe('src/a.ts');
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe('configFileInDiff', () => {
  const scope: DiffScope = {
    baseRef: 'main',
    mergeBaseSha: 'aaa',
    changedFiles: new Set(['heimdall.config.json', 'src/new.ts']),
    addedLines: new Map(),
    renamedFrom: new Map(),
  };

  it('returns the repo-relative config path when the story changed it', () => {
    expect(configFileInDiff(scope, 'heimdall.config.json', '/repo')).toBe('heimdall.config.json');
    expect(configFileInDiff(scope, '/repo/heimdall.config.json', '/repo')).toBe('heimdall.config.json');
  });

  it('returns undefined when the config file is not in the diff', () => {
    expect(configFileInDiff(scope, 'custom.gate.json', '/repo')).toBeUndefined();
  });

  it('returns undefined for a config outside the repo even if heimdall.config.json is in the diff', () => {
    expect(configFileInDiff(scope, '/tmp/heimdall-home/my-app/heimdall.config.json', '/repo')).toBeUndefined();
  });
});

function resolveMainBase(repo: string) {
  const base = resolveBaseRef(repo, 'main');
  expect(base.ok).toBe(true);
  if (!base.ok) {
    throw new Error(base.error);
  }
  return base.value;
}

function mustLoadScope(repo: string): DiffScope {
  const scope = loadDiffScope(repo, resolveMainBase(repo));
  expect(scope.ok).toBe(true);
  if (!scope.ok) {
    throw new Error(scope.error);
  }
  return scope.value;
}

function startFeat(repo: string): void {
  writeRepoFile(repo, 'README.md', 'base\n');
  commitAll(repo, 'initial');
  git(repo, ['checkout', '-q', '-b', 'feat']);
}

describe('loadDiffScope', () => {
  it('is empty when HEAD matches the base and the tree is clean', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'README.md', 'base\n');
      commitAll(repo, 'initial');
      const base = resolveBaseRef(repo, 'main');
      expect(base.ok).toBe(true);
      if (!base.ok) {
        return;
      }
      const scope = loadDiffScope(repo, base.value);
      expect(scope.ok).toBe(true);
      if (scope.ok) {
        expect(scope.value.changedFiles.size).toBe(0);
      }
    });
  });

  it('maps added lines after appending to a file with no trailing newline', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'src/nonewline.ts', 'line1');
      commitAll(repo, 'initial');
      git(repo, ['checkout', '-q', '-b', 'feat']);
      writeRepoFile(repo, 'src/nonewline.ts', 'line1\nline2');
      const scope = mustLoadScope(repo);
      expect(scope.addedLines.get('src/nonewline.ts')).toEqual(new Set([1, 2]));
    });
  });

  it('maps the last line of a file exactly', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'src/end.ts', 'a\nb\nc\n');
      commitAll(repo, 'initial');
      git(repo, ['checkout', '-q', '-b', 'feat']);
      writeRepoFile(repo, 'src/end.ts', 'a\nb\nc\nd\n');
      const scope = mustLoadScope(repo);
      expect(scope.addedLines.get('src/end.ts')).toEqual(new Set([4]));
      const filtered = filterFindingsToScope(
        [
          { step: 'eslint', file: path.join(repo, 'src/end.ts'), line: 4, rule: 'x', message: 'last' },
          { step: 'eslint', file: path.join(repo, 'src/end.ts'), line: 3, rule: 'x', message: 'old' },
        ],
        scope,
        repo,
      );
      expect(filtered.ok).toBe(true);
      if (filtered.ok) {
        expect(filtered.value.map((finding) => finding.message)).toEqual(['last']);
      }
    });
  });

  it('includes a renamed file under its new path without treating old lines as added', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'src/old name.ts', 'export const renamed = 1;\n');
      commitAll(repo, 'initial');
      git(repo, ['checkout', '-q', '-b', 'feat']);
      git(repo, ['mv', 'src/old name.ts', 'src/new name.ts']);
      const scope = mustLoadScope(repo);
      expect(scope.changedFiles.has('src/new name.ts')).toBe(true);
      expect(scope.changedFiles.has('src/old name.ts')).toBe(true);
      expect(scope.renamedFrom.get('src/new name.ts')).toBe('src/old name.ts');
      expect(scope.addedLines.get('src/new name.ts')?.size).toBe(0);
      const filtered = filterFindingsToScope(
        [{ step: 'eslint', file: path.join(repo, 'src/new name.ts'), line: 1, rule: 'x', message: 'legacy' }],
        scope,
        repo,
      );
      expect(filtered.ok).toBe(true);
      if (filtered.ok) {
        expect(filtered.value).toHaveLength(0);
      }
    });
  });

  it('counts only newly added lines after a rename with an edit', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'src/old.ts', 'export const renamed = 1;\n');
      commitAll(repo, 'initial');
      git(repo, ['checkout', '-q', '-b', 'feat']);
      git(repo, ['mv', 'src/old.ts', 'src/new.ts']);
      writeRepoFile(repo, 'src/new.ts', 'export const renamed = 1;\nexport const extra = 2;\n');
      const scope = mustLoadScope(repo);
      expect(scope.addedLines.get('src/new.ts')).toEqual(new Set([2]));
    });
  });

  it('includes a deleted path with no added lines', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'src/gone.ts', 'export const gone = 1;\n');
      commitAll(repo, 'initial');
      git(repo, ['checkout', '-q', '-b', 'feat']);
      fs.unlinkSync(path.join(repo, 'src/gone.ts'));
      const scope = mustLoadScope(repo);
      expect(scope.changedFiles.has('src/gone.ts')).toBe(true);
      expect(scope.addedLines.get('src/gone.ts')?.size).toBe(0);
    });
  });

  it('keeps a binary file in the change set without a line map', async () => {
    await withTempRepo(async (repo) => {
      fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 255, 0]));
      commitAll(repo, 'initial');
      git(repo, ['checkout', '-q', '-b', 'feat']);
      fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0, 9, 9, 255, 0]));
      const scope = mustLoadScope(repo);
      expect(scope.changedFiles.has('blob.bin')).toBe(true);
      expect(scope.addedLines.has('blob.bin')).toBe(false);
      const filtered = filterFindingsToScope(
        [{ step: 'eslint', file: 'blob.bin', line: 1, rule: 'bin', message: 'binary' }],
        scope,
        repo,
      );
      expect(filtered.ok).toBe(true);
      if (filtered.ok) {
        expect(filtered.value).toHaveLength(1);
      }
    });
  });

  it('handles paths with spaces and unusual characters', async () => {
    await withTempRepo(async (repo) => {
      startFeat(repo);
      const odd = 'src/odd $file (1).ts';
      writeRepoFile(repo, odd, 'export const odd = 1;\n');
      const scope = mustLoadScope(repo);
      expect(scope.changedFiles.has(odd)).toBe(true);
      expect(scope.addedLines.get(odd)?.has(1)).toBe(true);
    });
  });

  it('counts every line of an untracked file, including the last without a trailing newline', async () => {
    await withTempRepo(async (repo) => {
      startFeat(repo);
      writeRepoFile(repo, 'src/untracked.ts', 'a\nb\nc');
      const scope = mustLoadScope(repo);
      expect(scope.addedLines.get('src/untracked.ts')).toEqual(new Set([1, 2, 3]));
    });
  });

  it('is a GATE ERROR when an untracked file cannot be read', async () => {
    await withTempRepo(async (repo) => {
      startFeat(repo);
      fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
      fs.symlinkSync('missing-target', path.join(repo, 'src/broken.ts'));
      const scope = loadDiffScope(repo, resolveMainBase(repo));
      expect(scope.ok).toBe(false);
      if (!scope.ok) {
        expect(scope.error).toMatch(/cannot read untracked file/);
      }
    });
  });

  it('still parses when the user git config would break a naive diff', async () => {
    await withTempRepo(async (repo) => {
      git(repo, ['config', 'color.ui', 'always']);
      git(repo, ['config', 'diff.noprefix', 'true']);
      git(repo, ['config', 'diff.mnemonicPrefix', 'true']);
      git(repo, ['config', 'core.quotePath', 'true']);
      git(repo, ['config', 'diff.external', 'echo']);
      startFeat(repo);
      const odd = 'src/quoted file.ts';
      writeRepoFile(repo, odd, 'export const quoted = 1;\n');
      const scope = mustLoadScope(repo);
      expect(scope.changedFiles.has(odd)).toBe(true);
      expect(scope.addedLines.get(odd)?.has(1)).toBe(true);
    });
  });

  it('is a GATE ERROR whose message includes git stderr when git fails', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'README.md', 'base\n');
      commitAll(repo, 'initial');
      const scope = loadDiffScope(repo, {
        spec: 'main',
        sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        mergeBaseSha: 'not-a-real-sha',
        source: 'config',
        headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      });
      expect(scope.ok).toBe(false);
      if (!scope.ok) {
        expect(scope.error).toMatch(/git /);
        expect(scope.error).toMatch(/failed:/);
        expect(scope.error.length).toBeGreaterThan('git diff failed:'.length);
      }
    });
  });
});

