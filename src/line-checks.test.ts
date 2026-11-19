import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { commentTextOfLine, runLineChecks, scanAddedSource } from './line-checks.js';
import type { DiffScope } from './types.js';

function addedFileScope(file: string): DiffScope {
  return {
    baseRef: 'main',
    mergeBaseSha: 'a',
    changedFiles: new Set([file]),
    addedLines: new Map([[file, new Set([1])]]),
    renamedFrom: new Map(),
  };
}

describe('scanAddedSource', () => {
  it('flags a type assertion on an added line', () => {
    const hits = scanAddedSource('src/a.ts', 'const value = input as number;\n', new Set([1]));
    expect(hits.some((hit) => hit.rule === 'as-cast')).toBe(true);
  });

  it('does not flag a const assertion', () => {
    const hits = scanAddedSource('src/a.ts', 'const value = { ok: true } as const;\n', new Set([1]));
    expect(hits.filter((hit) => hit.rule === 'as-cast')).toEqual([]);
  });

  it('does not flag an import rename', () => {
    const hits = scanAddedSource('src/a.ts', "import { foo as bar } from 'mod';\n", new Set([1]));
    expect(hits.filter((hit) => hit.rule === 'as-cast')).toEqual([]);
  });

  it('flags a postfix non-null assertion', () => {
    const hits = scanAddedSource('src/a.ts', 'const value = input!.name;\n', new Set([1]));
    expect(hits.some((hit) => hit.rule === 'non-null')).toBe(true);
  });

  it('does not flag inequality or logical not', () => {
    const hits = scanAddedSource(
      'src/a.ts',
      'const a = input !== other;\nconst b = input != other;\nconst c = !input;\n',
      new Set([1, 2, 3]),
    );
    expect(hits.filter((hit) => hit.rule === 'non-null')).toEqual([]);
  });

  it('flags a suppression comment on an added line', () => {
    const hits = scanAddedSource('src/a.ts', '// eslint-disable-next-line no-console\nconsole.log(1);\n', new Set([1]));
    expect(hits.some((hit) => hit.rule === 'suppression')).toBe(true);
  });

  it('does not flag a suppression token inside a string', () => {
    const hits = scanAddedSource(
      'src/a.ts',
      "const source = '// eslint-disable-next-line no-console';\n",
      new Set([1]),
    );
    expect(hits.filter((hit) => hit.rule === 'suppression')).toEqual([]);
  });

  it('flags a void statement', () => {
    const hits = scanAddedSource('src/a.ts', 'void unused;\n', new Set([1]));
    expect(hits.some((hit) => hit.rule === 'void-statement')).toBe(true);
  });

  it('does not flag void 0 in an expression', () => {
    const hits = scanAddedSource('src/a.ts', 'const x = void 0;\n', new Set([1]));
    expect(hits.filter((hit) => hit.rule === 'void-statement')).toEqual([]);
  });

  it('flags an underscore param', () => {
    const hits = scanAddedSource('src/a.ts', 'function take(_unused: number) { return 1; }\n', new Set([1]));
    expect(hits.some((hit) => hit.rule === 'underscore-param')).toBe(true);
  });

  it('flags ts-ignore in a comment and an angle-bracket assertion', () => {
    const ignoreHits = scanAddedSource('src/a.ts', '// @ts-ignore\nconst n = 1;\n', new Set([1]));
    expect(ignoreHits.some((hit) => hit.rule === 'suppression')).toBe(true);
    const angle = scanAddedSource('src/a.ts', 'const value = <number>input;\n', new Set([1]));
    expect(angle.some((hit) => hit.rule === 'as-cast')).toBe(true);
  });

  it('does not flag findings on lines that were not added', () => {
    const source = 'const value = input as number;\nconst ok = 1;\n';
    const hits = scanAddedSource('src/a.ts', source, new Set([2]));
    expect(hits.filter((hit) => hit.rule === 'as-cast')).toEqual([]);
  });

  it('does not flag a pre-existing multi-line as-cast when only an inner line was added', () => {
    const source = 'const value = {\n  extra: 1,\n} as Config;\n';
    const hits = scanAddedSource('src/a.ts', source, new Set([2]));
    expect(hits.filter((hit) => hit.rule === 'as-cast')).toEqual([]);
  });

  it('flags a multi-line as-cast only on the added type line', () => {
    const source = 'const value = {\n  extra: 1,\n} as Config;\n';
    const hits = scanAddedSource('src/a.ts', source, new Set([3]));
    expect(hits.some((hit) => hit.rule === 'as-cast' && hit.line === 3)).toBe(true);
  });

  it('flags an angle-bracket assertion in a .cts file', () => {
    const hits = scanAddedSource('src/a.cts', 'const value = <number>input;\n', new Set([1]));
    expect(hits.some((hit) => hit.rule === 'as-cast')).toBe(true);
  });
});

describe('runLineChecks', () => {
  it('scans files from a diff scope', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-lines-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const n = (x: unknown) => x as number;\n');
      const scope = addedFileScope('src/a.ts');
      const hits = runLineChecks(dir, scope);
      expect(hits.ok).toBe(true);
      if (hits.ok) {
        expect(hits.value.some((hit) => hit.rule === 'as-cast')).toBe(true);
      }
      const missing: DiffScope = {
        ...scope,
        changedFiles: new Set(['src/missing.ts']),
        addedLines: new Map([['src/missing.ts', new Set([1])]]),
      };
      const unread = runLineChecks(dir, missing);
      expect(unread.ok).toBe(false);
      if (!unread.ok) {
        expect(unread.error).toMatch(/cannot read src\/missing\.ts/);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('commentTextOfLine', () => {
  it('returns empty for a string that only looks like a comment', () => {
    expect(commentTextOfLine("const s = '// eslint-disable';")).toBe('');
  });

  it('returns the trailing line comment', () => {
    expect(commentTextOfLine('const x = 1; // note')).toContain('// note');
  });
});

describe('no-silencing', () => {
  it('flags a bare void-identifier statement and not a void call', () => {
    const ident = scanAddedSource('src/a.ts', 'void unused;\n', new Set([1]), { extras: false });
    expect(ident.some((hit) => hit.rule === 'no-silencing')).toBe(true);
    const call = scanAddedSource('src/a.ts', 'void load();\n', new Set([1]), { extras: false });
    expect(call.filter((hit) => hit.rule === 'no-silencing')).toEqual([]);
  });

  it('flags new eslint-disable and ts-ignore comments', () => {
    const disable = scanAddedSource(
      'src/a.ts',
      '// eslint-disable-next-line no-console\nconsole.log(1);\n',
      new Set([1]),
      { extras: false },
    );
    expect(disable.some((hit) => hit.rule === 'no-silencing' && hit.line === 1)).toBe(true);
    const ignore = scanAddedSource('src/a.ts', '// @ts-expect-error leftover\nconst n = 1;\n', new Set([1]), {
      extras: false,
    });
    expect(ignore.some((hit) => hit.rule === 'no-silencing')).toBe(true);
  });

  it('flags underscore parameters and const declarations, not object shorthand', () => {
    const param = scanAddedSource('src/a.ts', 'function take(_unused: number) { return 1; }\n', new Set([1]), {
      extras: false,
    });
    expect(param.some((hit) => hit.rule === 'no-silencing' && hit.message === '_unused')).toBe(true);
    const decl = scanAddedSource('src/a.ts', 'const _ignored = 1;\n', new Set([1]), { extras: false });
    expect(decl.some((hit) => hit.rule === 'no-silencing' && hit.message === '_ignored')).toBe(true);
    const shorthand = scanAddedSource('src/a.ts', 'const { _id } = row;\n', new Set([1]), { extras: false });
    expect(shorthand.filter((hit) => hit.rule === 'no-silencing')).toEqual([]);
    const rename = scanAddedSource('src/a.ts', 'const { used: _unused } = row;\n', new Set([1]), { extras: false });
    expect(rename.some((hit) => hit.rule === 'no-silencing' && hit.message === '_unused')).toBe(true);
    const method = scanAddedSource('src/a.ts', 'class C { _priv() { return 1; } }\n', new Set([1]), { extras: false });
    expect(method.filter((hit) => hit.rule === 'no-silencing')).toEqual([]);
    const lodash = scanAddedSource('src/a.ts', "import _ from 'lodash';\n", new Set([1]), { extras: false });
    expect(lodash.filter((hit) => hit.rule === 'no-silencing')).toEqual([]);
  });

  it('does not scan .mts files and honors allowSilencing globs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-nosilence-'));
    try {
      fs.mkdirSync(path.join(dir, 'src/generated'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src/a.mts'), 'void unused;\n');
      fs.writeFileSync(path.join(dir, 'src/generated/a.ts'), 'void unused;\n');
      const mtsScope = addedFileScope('src/a.mts');
      const mtsHits = runLineChecks(dir, mtsScope, { extras: false });
      expect(mtsHits.ok).toBe(true);
      if (mtsHits.ok) {
        expect(mtsHits.value).toEqual([]);
      }
      const genScope = addedFileScope('src/generated/a.ts');
      const skipped = runLineChecks(dir, genScope, {
        extras: false,
        allowSilencing: ['src/generated/**'],
      });
      expect(skipped.ok).toBe(true);
      if (skipped.ok) {
        expect(skipped.value).toEqual([]);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('secret-scanner suppressions', () => {
  const forms: ReadonlyArray<{ name: string; kind: string; source: string }> = [
    { name: 'secretlint-disable', kind: 'secretlint-disable', source: '// secretlint-disable\nconst x = 1;\n' },
    {
      name: 'secretlint-disable-line',
      kind: 'secretlint-disable',
      source: "const token = 'leaked-value'; // secretlint-disable-line\n",
    },
    {
      name: 'secretlint-disable-next-line',
      kind: 'secretlint-disable',
      source: '// secretlint-disable-next-line\nconst x = 1;\n',
    },
    {
      name: 'gitleaks:allow',
      kind: 'gitleaks:allow',
      source: "const token = 'leaked-value'; // gitleaks:allow\n",
    },
  ];

  function suppressionHits(hits: ReturnType<typeof scanAddedSource>) {
    return hits.filter((hit) => hit.rule === 'suppression' || hit.rule === 'no-silencing');
  }

  for (const form of forms) {
    it(`flags added ${form.name} when secrets is on, naming only the kind`, () => {
      const hits = suppressionHits(scanAddedSource('src/a.ts', form.source, new Set([1]), { secrets: true }));
      expect(hits).toEqual([
        { step: 'line-checks', file: 'src/a.ts', line: 1, rule: 'suppression', message: form.kind },
        { step: 'line-checks', file: 'src/a.ts', line: 1, rule: 'no-silencing', message: form.kind },
      ]);
    });

    it(`does not flag added ${form.name} when secrets is off`, () => {
      const hits = suppressionHits(scanAddedSource('src/a.ts', form.source, new Set([1])));
      expect(hits).toEqual([]);
    });
  }

  it('does not flag a secretlint-disable comment on an unchanged line', () => {
    const source = '// secretlint-disable\nconst x = 1;\n';
    const hits = suppressionHits(scanAddedSource('src/a.ts', source, new Set([2]), { secrets: true }));
    expect(hits).toEqual([]);
  });

  it('still flags eslint-disable when secrets is on', () => {
    const hits = scanAddedSource('src/a.ts', '// eslint-disable-next-line no-console\nconsole.log(1);\n', new Set([1]), {
      secrets: true,
    });
    expect(hits.some((hit) => hit.rule === 'suppression')).toBe(true);
  });

  const mixedOrders: ReadonlyArray<{ name: string; source: string }> = [
    {
      name: 'gitleaks:allow before eslint-disable',
      source: "const token = 'leaked-value'; // gitleaks:allow eslint-disable-line x\n",
    },
    {
      name: 'eslint-disable before gitleaks:allow',
      source: "const token = 'leaked-value'; // eslint-disable-line x gitleaks:allow\n",
    },
  ];

  for (const form of mixedOrders) {
    it(`names only the secret kind for ${form.name} when secrets is on`, () => {
      const hits = suppressionHits(scanAddedSource('src/a.ts', form.source, new Set([1]), { secrets: true }));
      expect(hits).toEqual([
        { step: 'line-checks', file: 'src/a.ts', line: 1, rule: 'suppression', message: 'gitleaks:allow' },
        { step: 'line-checks', file: 'src/a.ts', line: 1, rule: 'no-silencing', message: 'gitleaks:allow' },
      ]);
      expect(hits.every((hit) => !hit.message.includes('leaked-value'))).toBe(true);
      expect(hits.every((hit) => hit.message !== form.source.trim())).toBe(true);
    });

    it(`still flags eslint-disable for ${form.name} when secrets is off`, () => {
      const hits = suppressionHits(scanAddedSource('src/a.ts', form.source, new Set([1])));
      expect(hits).toEqual([
        { step: 'line-checks', file: 'src/a.ts', line: 1, rule: 'suppression', message: form.source.trim() },
        { step: 'line-checks', file: 'src/a.ts', line: 1, rule: 'no-silencing', message: form.source.trim() },
      ]);
      expect(hits.every((hit) => hit.message.includes('eslint-disable'))).toBe(true);
    });
  }
});

describe('docs are not scanned as source', () => {
  it('does not flag a markdown bullet that mentions eslint-disable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-lines-md-'));
    try {
      fs.writeFileSync(path.join(dir, 'README.md'), '* never add eslint-disable\n');
      const scope = addedFileScope('README.md');
      const hits = runLineChecks(dir, scope);
      expect(hits.ok).toBe(true);
      if (hits.ok) {
        expect(hits.value).toEqual([]);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
