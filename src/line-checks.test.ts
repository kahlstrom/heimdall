import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { commentTextOfLine, runLineChecks, scanAddedSource } from './line-checks.js';
import { lineChecksStep } from './steps.js';
import type { DiffScope } from './types.js';
import { commandResult, parseTestConfig } from '../test/helpers/gate-test.js';

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

describe('commentPatterns', () => {
  it('flags a new matching comment naming the matched pattern and trimmed comment', () => {
    const pattern = new RegExp('FIXME:\\s*\\w+');
    const hits = scanAddedSource(
      'src/a.ts',
      'const x = 1; // FIXME: clean up   \n',
      new Set([1]),
      { extras: false, commentPatterns: [pattern] },
    );
    expect(hits).toEqual([
      {
        step: 'line-checks',
        file: 'src/a.ts',
        line: 1,
        rule: 'comment-pattern',
        message: 'matches /FIXME:\\s*\\w+/: // FIXME: clean up',
      },
    ]);
  });

  it('does not flag a matching comment on an unchanged pre-existing line', () => {
    const source = '// FIXME: old note\nconst ok = 1;\n';
    const hits = scanAddedSource('src/a.ts', source, new Set([2]), {
      extras: false,
      commentPatterns: [new RegExp('FIXME')],
    });
    expect(hits).toEqual([]);
  });

  it('does not flag a string literal containing matching text', () => {
    const source = "const msg = '// FIXME: inside string';\nconst plain = 'FIXME';\n";
    const hits = scanAddedSource('src/a.ts', source, new Set([1, 2]), {
      extras: false,
      commentPatterns: [new RegExp('FIXME')],
    });
    expect(hits).toEqual([]);
  });

  it('does nothing when commentPatterns is empty', () => {
    const hits = scanAddedSource('src/a.ts', '// FIXME: ignored when empty\n', new Set([1]), {
      extras: false,
      commentPatterns: [],
    });
    expect(hits).toEqual([]);
  });

  it('runs on test files and .mts files even when extras and silencing checks are off', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-comment-patterns-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src/foo.test.ts'), '// WORKAROUND: temporary\n');
      fs.writeFileSync(path.join(dir, 'src/helper.mts'), '// WORKAROUND: temporary\n');
      fs.writeFileSync(path.join(dir, 'README.md'), '// WORKAROUND: doc example\n');
      const scope: DiffScope = {
        baseRef: 'main',
        mergeBaseSha: 'a',
        changedFiles: new Set(['src/foo.test.ts', 'src/helper.mts', 'README.md']),
        addedLines: new Map([
          ['src/foo.test.ts', new Set([1])],
          ['src/helper.mts', new Set([1])],
          ['README.md', new Set([1])],
        ]),
        renamedFrom: new Map(),
      };
      const result = runLineChecks(dir, scope, {
        extras: false,
        allowSilencing: ['**/*.test.ts'],
        commentPatterns: [new RegExp('WORKAROUND')],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([
          {
            step: 'line-checks',
            file: 'src/foo.test.ts',
            line: 1,
            rule: 'comment-pattern',
            message: 'matches /WORKAROUND/: // WORKAROUND: temporary',
          },
          {
            step: 'line-checks',
            file: 'src/helper.mts',
            line: 1,
            rule: 'comment-pattern',
            message: 'matches /WORKAROUND/: // WORKAROUND: temporary',
          },
        ]);
      }
      const empty = runLineChecks(dir, addedFileScope('src/missing.test.mts'), {
        extras: false,
        commentPatterns: [],
      });
      expect(empty).toEqual({ ok: true, value: [] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function ruleHits(
  rule: string,
  filePath: string,
  sourceText: string,
  addedLines: ReadonlySet<number>,
  options: Parameters<typeof scanAddedSource>[3] = {},
) {
  return scanAddedSource(filePath, sourceText, addedLines, {
    extras: false,
    noSilencing: false,
    ...options,
  }).filter((hit) => hit.rule === rule);
}

async function withTempFiles(
  prefix: string,
  files: Readonly<Record<string, string>>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const fullPath = path.join(dir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
    }
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function stepFindings(result: Awaited<ReturnType<typeof lineChecksStep.run>>) {
  return result.kind === 'fail' ? result.findings : [];
}

function runLineChecksStep(
  dir: string,
  config: ReturnType<typeof parseTestConfig>,
  file: string,
) {
  return lineChecksStep.run({
    cwd: dir,
    tmpDir: dir,
    config,
    scope: addedFileScope(file),
    runCommand: async () => commandResult(),
    env: {},
  });
}

function testImportHits(
  filePath: string,
  sourceText: string,
  addedLines: ReadonlySet<number>,
  options: Parameters<typeof scanAddedSource>[3] = {},
) {
  return ruleHits('test-import', filePath, sourceText, addedLines, options);
}

describe('test-import', () => {
  it('flags added static imports, re-exports, require, and dynamic import of test frameworks', () => {
    const cases: ReadonlyArray<{ label: string; source: string; expected: string }> = [
      { label: 'named import', source: "import { describe } from 'vitest';\n", expected: '"vitest"' },
      { label: 'subpath import', source: "import { defineConfig } from 'vitest/config';\n", expected: '"vitest/config"' },
      { label: 'type import', source: "import type { Mock } from 'vitest';\n", expected: '"vitest"' },
      { label: 'import equals require', source: "import v = require('vitest');\n", expected: '"vitest"' },
      { label: 'import type node', source: "type M = import('vitest').Mock;\n", expected: '"vitest"' },
      { label: 'export from', source: "export { expect } from 'chai';\n", expected: '"chai"' },
      { label: 'export star', source: "export * from 'sinon';\n", expected: '"sinon"' },
      { label: 'require', source: "const j = require('jest');\n", expected: '"jest"' },
      { label: 'dynamic import', source: "const m = await import('mocha');\n", expected: '"mocha"' },
      { label: 'template literal require', source: 'const t = require(`node:test`);\n', expected: '"node:test"' },
      { label: '@jest scope', source: "import { jest } from '@jest/globals';\n", expected: '"@jest/globals"' },
      { label: '@testing-library scope', source: "import { render } from '@testing-library/react';\n", expected: '"@testing-library/react"' },
      { label: 'jasmine', source: "import 'jasmine';\n", expected: '"jasmine"' },
      { label: 'ava', source: "import test from 'ava';\n", expected: '"ava"' },
      { label: 'msw/node', source: "import { setupServer } from 'msw/node';\n", expected: '"msw/node"' },
      { label: '@playwright/test', source: "import { test } from '@playwright/test';\n", expected: '"@playwright/test"' },
      { label: 'cypress', source: "import 'cypress';\n", expected: '"cypress"' },
    ];
    for (const item of cases) {
      const hits = testImportHits('src/a.ts', item.source, new Set([1]));
      expect(hits, item.label).toHaveLength(1);
      expect(hits[0]?.line, item.label).toBe(1);
      expect(hits[0]?.message, item.label).toContain(item.expected);
    }
  });

  it('does not flag non-test packages, aliases, dynamic specifiers, or strings', () => {
    const lines = [
      "import { http } from 'msw';",
      "import { setupWorker } from 'msw/browser';",
      "import { chromium } from 'playwright';",
      "import avatar from 'avatar';",
      "import chain from 'chain';",
      "import { helper } from '@/test/helper';",
      "const mod = require(dynamicName);",
      'const lazy = import(`./${name}.test`);',
      "const res = loader.require('vitest');",
      "const text = \"import { describe } from 'vitest'\";",
      "// import { describe } from 'vitest'",
    ];
    const added = new Set([...lines.keys()].map((index) => index + 1));
    expect(testImportHits('src/a.ts', `${lines.join('\n')}\n`, added)).toEqual([]);
  });

  it('does not flag an unchanged pre-existing import line', () => {
    const source = "import { vi } from 'vitest';\nexport const x = 1;\n";
    expect(testImportHits('src/a.ts', source, new Set([2]))).toEqual([]);
    const multiline = "import {\n  describe,\n  it,\n} from 'vitest';\n";
    expect(testImportHits('src/a.ts', multiline, new Set([3]))).toEqual([]);
    expect(testImportHits('src/a.ts', multiline, new Set([4]))).toHaveLength(1);
  });

  it('skips test files matching default or custom testGlobs', () => {
    const source = "import { describe } from 'vitest';\n";
    expect(testImportHits('src/a.test.ts', source, new Set([1]))).toEqual([]);
    expect(testImportHits('src/__tests__/x.ts', source, new Set([1]))).toEqual([]);
    expect(testImportHits('vitest.config.ts', source, new Set([1]))).toEqual([]);
    expect(
      testImportHits('src/fixtures/seed.ts', source, new Set([1]), {
        testGlobs: ['src/fixtures/**'],
      }),
    ).toEqual([]);
    expect(
      testImportHits('src/a.test.ts', source, new Set([1]), {
        testGlobs: ['src/fixtures/**'],
      }),
    ).toHaveLength(1);
    expect(testImportHits('src/a.test.ts', source, new Set([1]), { testGlobs: [] })).toHaveLength(1);
  });

  it('resolves relative paths via extensions, .js->.ts, and /index against testGlobs without false positives', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-test-imports-'));
    try {
      fs.mkdirSync(path.join(dir, 'src/__tests__'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src/a.test.ts'), 'export const helper = 1;\n');
      fs.writeFileSync(path.join(dir, 'src/__tests__/index.ts'), 'export const idx = 1;\n');
      fs.writeFileSync(path.join(dir, 'test/index.ts'), 'export const t = 1;\n');
      fs.writeFileSync(path.join(dir, 'src/test.ts'), 'export const prod = 1;\n');
      fs.writeFileSync(
        path.join(dir, 'src/a.ts'),
        [
          "import { helper } from './a.test';",
          "export { helper as h2 } from './a.test.js';",
          "import { idx } from './__tests__';",
          "const t = require('../test');",
          "import { prod } from './test';",
        ].join('\n') + '\n',
      );
      const scope: DiffScope = {
        baseRef: 'main',
        mergeBaseSha: 'a',
        changedFiles: new Set(['src/a.ts']),
        addedLines: new Map([['src/a.ts', new Set([1, 2, 3, 4, 5])]]),
        renamedFrom: new Map(),
      };
      const result = runLineChecks(dir, scope, { extras: false });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const hits = result.value.filter((hit) => hit.rule === 'test-import');
        expect(hits.map((hit) => hit.line)).toEqual([1, 2, 3, 4]);
        expect(hits[0]?.message).toContain('src/a.test.ts');
        expect(hits[1]?.message).toContain('src/a.test.ts');
        expect(hits[2]?.message).toContain('src/__tests__/index.ts');
        expect(hits[3]?.message).toContain('test/index.ts');
      }
      // Custom glob matching only .ts still catches .js -> .ts ESM imports.
      const tsOnly = runLineChecks(dir, {
        ...scope,
        addedLines: new Map([['src/a.ts', new Set([2])]]),
      }, {
        extras: false,
        testGlobs: ['**/*.test.ts'],
      });
      expect(tsOnly.ok).toBe(true);
      if (tsOnly.ok) {
        expect(tsOnly.value.filter((hit) => hit.rule === 'test-import')).toHaveLength(1);
      }
      // Empty testGlobs means no file is considered a test file.
      const noGlobs = runLineChecks(dir, scope, { extras: false, testGlobs: [] });
      expect(noGlobs.ok).toBe(true);
      if (noGlobs.ok) {
        expect(noGlobs.value.filter((hit) => hit.rule === 'test-import')).toEqual([]);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors allowTestImports globs and lineChecksStep default-on / enabled:false behavior', async () => {
    await withTempFiles(
      'gate-allow-test-imports-',
      {
        'src/a.ts': "import { describe } from 'vitest';\n",
        'src/test-utils/render.ts': "import { render } from '@testing-library/react';\n",
      },
      async (dir) => {
        const omittedConfig = parseTestConfig({ steps: { tests: { command: 't' } } });
        expect(lineChecksStep.isEnabled(omittedConfig)).toBe(true);
        const omittedResult = await runLineChecksStep(dir, omittedConfig, 'src/a.ts');
        expect(stepFindings(omittedResult).map((finding) => finding.rule)).toEqual(['test-import']);

        const exemptConfig = parseTestConfig({
          steps: { 'line-checks': { allowTestImports: ['src/test-utils/**'] } },
        });
        expect((await runLineChecksStep(dir, exemptConfig, 'src/test-utils/render.ts')).kind).toBe('pass');

        const disabled = parseTestConfig({
          steps: { tests: { command: 't' }, 'line-checks': { enabled: false } },
        });
        expect(lineChecksStep.isEnabled(disabled)).toBe(false);
      },
    );
  });
});

function testEnvHits(
  filePath: string,
  sourceText: string,
  addedLines: ReadonlySet<number>,
  options: Parameters<typeof scanAddedSource>[3] = {},
) {
  return ruleHits('test-env', filePath, sourceText, addedLines, { testImports: false, ...options });
}

describe('test-env', () => {
  it('flags direct test-runner env expressions in dot and bracket forms', () => {
    const cases: ReadonlyArray<{ label: string; source: string; expected: string }> = [
      { label: 'process.env.VITEST', source: 'if (process.env.VITEST) {}\n', expected: 'process.env.VITEST' },
      { label: "process.env['VITEST']", source: "if (process.env['VITEST']) {}\n", expected: "process.env['VITEST']" },
      { label: "process['env']['VITEST']", source: "if (process['env']['VITEST']) {}\n", expected: "process['env']['VITEST']" },
      { label: 'process.env.JEST_WORKER_ID', source: 'const inJest = Boolean(process.env.JEST_WORKER_ID);\n', expected: 'process.env.JEST_WORKER_ID' },
      { label: "process.env['JEST_WORKER_ID']", source: "const inJest = Boolean(process.env['JEST_WORKER_ID']);\n", expected: "process.env['JEST_WORKER_ID']" },
      { label: 'import.meta.env.VITEST', source: 'if (import.meta.env.VITEST) {}\n', expected: 'import.meta.env.VITEST' },
      { label: "import.meta.env['VITEST']", source: "if (import.meta.env['VITEST']) {}\n", expected: "import.meta.env['VITEST']" },
      { label: "import.meta['env']['VITEST']", source: "if (import.meta['env']['VITEST']) {}\n", expected: "import.meta['env']['VITEST']" },
      { label: 'import.meta.vitest', source: 'if (import.meta.vitest) {}\n', expected: 'import.meta.vitest' },
      { label: "import.meta['vitest']", source: "if (import.meta['vitest']) {}\n", expected: "import.meta['vitest']" },
    ];
    for (const item of cases) {
      const hits = testEnvHits('src/a.ts', item.source, new Set([1]));
      expect(hits, item.label).toEqual([
        { step: 'line-checks', file: 'src/a.ts', line: 1, rule: 'test-env', message: item.expected },
      ]);
    }
  });

  it('flags NODE_ENV and import.meta.env.MODE comparisons to test with any equality operator or operand order', () => {
    const cases: ReadonlyArray<string> = [
      "process.env.NODE_ENV === 'test'",
      "process.env.NODE_ENV !== 'test'",
      "process.env.NODE_ENV == 'test'",
      "process.env.NODE_ENV != 'test'",
      "'test' === process.env.NODE_ENV",
      "'test' !== process.env.NODE_ENV",
      "'test' == process.env.NODE_ENV",
      "'test' != process.env.NODE_ENV",
      "process.env['NODE_ENV'] === 'test'",
      "process['env']['NODE_ENV'] !== 'test'",
      '"test" === process.env["NODE_ENV"]',
      'process.env.NODE_ENV === `test`',
      "import.meta.env.MODE === 'test'",
      "import.meta.env.MODE !== 'test'",
      "import.meta.env.MODE == 'test'",
      "import.meta.env.MODE != 'test'",
      "'test' === import.meta.env.MODE",
      "import.meta.env['MODE'] === 'test'",
      "import.meta['env']['MODE'] !== 'test'",
    ];
    for (const expr of cases) {
      const hits = testEnvHits('src/a.ts', `const x = ${expr};\n`, new Set([1]));
      expect(hits, expr).toEqual([
        { step: 'line-checks', file: 'src/a.ts', line: 1, rule: 'test-env', message: expr },
      ]);
    }
  });

  it('does not flag production/development comparisons, unrelated env names, comments, or strings', () => {
    const lines = [
      "const a = process.env.NODE_ENV === 'production';",
      "const b = process.env.NODE_ENV !== 'production';",
      "const c = process.env.NODE_ENV === 'development';",
      "const d = 'development' === process.env['NODE_ENV'];",
      "const e = import.meta.env.MODE === 'production';",
      "const f = import.meta.env.MODE === 'development';",
      'const g = process.env.NODE_ENV;',
      'const h = import.meta.env.MODE;',
      "const i = process.env.APP_ENV === 'test';",
      'const j = process.env.API_URL;',
      'const k = import.meta.env.VITE_API_URL;',
      'const l = obj.process.env.VITEST;',
      "const m = 'process.env.VITEST';",
      "// if (process.env.NODE_ENV === 'test')",
    ];
    const added = new Set([...lines.keys()].map((index) => index + 1));
    expect(testEnvHits('src/a.ts', `${lines.join('\n')}\n`, added)).toEqual([]);
  });

  it('does not flag unchanged pre-existing lines or multi-line edits where the expression start line is old', () => {
    const singleLine = 'if (process.env.VITEST) {\n  doWork();\n}\n';
    expect(testEnvHits('src/a.ts', singleLine, new Set([2]))).toEqual([]);

    const multiLineComparison = "const isTest =\n  process.env.NODE_ENV ===\n  'test';\n";
    expect(testEnvHits('src/a.ts', multiLineComparison, new Set([3]))).toEqual([]);
    expect(testEnvHits('src/a.ts', multiLineComparison, new Set([2]))).toEqual([
      {
        step: 'line-checks',
        file: 'src/a.ts',
        line: 2,
        rule: 'test-env',
        message: "process.env.NODE_ENV ===\n  'test'",
      },
    ]);
  });

  it('skips test files matching default or custom testGlobs', () => {
    const source = "if (process.env.VITEST || process.env.NODE_ENV === 'test') {}\n";
    expect(testEnvHits('src/a.test.ts', source, new Set([1]))).toEqual([]);
    expect(testEnvHits('src/__tests__/x.ts', source, new Set([1]))).toEqual([]);
    expect(testEnvHits('vitest.config.ts', source, new Set([1]))).toEqual([]);
    expect(
      testEnvHits('src/fixtures/seed.ts', source, new Set([1]), {
        testGlobs: ['src/fixtures/**'],
      }),
    ).toEqual([]);
    expect(
      testEnvHits('src/a.test.ts', source, new Set([1]), {
        testGlobs: ['src/fixtures/**'],
      }),
    ).toHaveLength(2);
    expect(testEnvHits('src/a.test.ts', source, new Set([1]), { testGlobs: [] })).toHaveLength(2);
  });

  it('flags custom testEnvNames on process.env and import.meta.env in dot and bracket forms', () => {
    const lines = [
      'const a = process.env.MY_TEST_FLAG;',
      "const b = process.env['MY_TEST_FLAG'];",
      'const c = import.meta.env.MY_TEST_FLAG;',
      "const d = import.meta.env['MY_TEST_FLAG'];",
      'const e = process.env.OTHER_FLAG;',
    ];
    const added = new Set([1, 2, 3, 4, 5]);
    const hits = testEnvHits('src/a.ts', `${lines.join('\n')}\n`, added, {
      testEnvNames: ['MY_TEST_FLAG'],
    });
    expect(hits).toEqual([
      { step: 'line-checks', file: 'src/a.ts', line: 1, rule: 'test-env', message: 'process.env.MY_TEST_FLAG' },
      { step: 'line-checks', file: 'src/a.ts', line: 2, rule: 'test-env', message: "process.env['MY_TEST_FLAG']" },
      { step: 'line-checks', file: 'src/a.ts', line: 3, rule: 'test-env', message: 'import.meta.env.MY_TEST_FLAG' },
      { step: 'line-checks', file: 'src/a.ts', line: 4, rule: 'test-env', message: "import.meta.env['MY_TEST_FLAG']" },
    ]);
  });

  it('runs by default in lineChecksStep, honors testEnvNames, and stops when enabled is false', async () => {
    await withTempFiles(
      'gate-test-env-',
      {
        'src/a.ts': 'export const flag = Boolean(process.env.VITEST);\n',
        'src/custom.ts': 'export const flag = Boolean(process.env.E2E_MODE);\n',
      },
      async (dir) => {
        const omitted = parseTestConfig({ steps: { tests: { command: 't' } } });
        expect(lineChecksStep.isEnabled(omitted)).toBe(true);
        expect(stepFindings(await runLineChecksStep(dir, omitted, 'src/a.ts'))).toEqual([
          { step: 'line-checks', file: 'src/a.ts', line: 1, rule: 'test-env', message: 'process.env.VITEST' },
        ]);

        const withCustom = parseTestConfig({ steps: { 'line-checks': { testEnvNames: ['E2E_MODE'] } } });
        expect(stepFindings(await runLineChecksStep(dir, withCustom, 'src/custom.ts'))).toEqual([
          { step: 'line-checks', file: 'src/custom.ts', line: 1, rule: 'test-env', message: 'process.env.E2E_MODE' },
        ]);

        expect(
          lineChecksStep.isEnabled(
            parseTestConfig({ steps: { tests: { command: 't' }, 'line-checks': { enabled: false } } }),
          ),
        ).toBe(false);
      },
    );
  });
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
