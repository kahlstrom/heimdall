import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KNIP_JSON_REPORTER_FIXTURE,
  runKnipJsonReporter,
  writeKnipAllIssuesFixture,
} from '../test/helpers/knip-all-issues.js';
import { parseEslintOutput, parseJscpdJson, parseKnipJson, parseKnipOutput, parseTypecheckOutput } from './parsers.js';

describe('parseEslintOutput', () => {
  it('parses JSON formatter output', () => {
    const parsed = parseEslintOutput(
      JSON.stringify([
        {
          filePath: '/repo/src/a.ts',
          messages: [
            { line: 4, ruleId: 'no-unused-vars', message: "'x' is assigned a value but never used.", severity: 2 },
            { line: 8, ruleId: 'no-console', message: 'warning', severity: 1 },
          ],
        },
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.errors).toHaveLength(1);
      expect(parsed.value.errors[0]?.rule).toBe('no-unused-vars');
      expect(parsed.value.errors[0]?.line).toBe(4);
      expect(parsed.value.warnings).toHaveLength(1);
      expect(parsed.value.warnings[0]?.rule).toBe('no-console');
    }
  });

  it('parses JSON wrapped in yarn noise', () => {
    const parsed = parseEslintOutput('yarn run v1.22.22\n[{"filePath":"a.ts","messages":[{"line":1,"ruleId":"x","message":"m","severity":2}]}]\nDone in 0.1s.');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.errors[0]?.file).toBe('a.ts');
    }
  });

  it('does not treat unix formatter text as findings', () => {
    const parsed = parseEslintOutput("src/a.ts:4:1: error 'x' is unused [no-unused-vars]");
    expect(parsed.ok).toBe(false);
  });

  it('errors on empty unparseable output', () => {
    const parsed = parseEslintOutput('oh no eslint exploded');
    expect(parsed.ok).toBe(false);
  });

  it('skips malformed eslint JSON entries and keeps warning-only files as warnings', () => {
    const parsed = parseEslintOutput(
      JSON.stringify([
        null,
        { filePath: 'a.ts' },
        {
          filePath: 'b.ts',
          messages: [null, { line: 1, ruleId: 'x', message: 'warn', severity: 1 }],
        },
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.errors).toEqual([]);
      expect(parsed.value.warnings).toEqual([
        expect.objectContaining({ file: 'b.ts', line: 1, rule: 'x', message: 'warn' }),
      ]);
    }
  });

  it('rejects a JSON object that is not an eslint array', () => {
    expect(parseEslintOutput('{"filePath":"a.ts"}').ok).toBe(false);
  });
});

const REQUIRED_KNIP_RULES = [
  'files',
  'dependencies',
  'devDependencies',
  'unlisted',
  'unresolved',
  'binaries',
  'exports',
  'types',
  'enumMembers',
  'classMembers',
  'duplicates',
] as const;

function expectKnipAllIssueTypes(findings: readonly { rule: string; file: string; message: string; line: number }[]): void {
  const rules = new Set(findings.map((hit) => hit.rule));
  for (const rule of REQUIRED_KNIP_RULES) {
    expect(rules.has(rule), `missing knip issue type ${rule}`).toBe(true);
  }
  expect(findings.some((hit) => hit.rule === 'files' && hit.file === 'src/orphan.ts' && hit.line === 0)).toBe(true);
  expect(findings.some((hit) => hit.rule === 'dependencies' && hit.message === 'left-pad')).toBe(true);
  expect(findings.some((hit) => hit.rule === 'devDependencies' && hit.message === 'unused-dev-pkg')).toBe(true);
  expect(findings.some((hit) => hit.rule === 'unlisted' && hit.message === 'unlisted-pkg')).toBe(true);
  expect(findings.some((hit) => hit.rule === 'unresolved' && hit.message === './missing-file.js')).toBe(true);
  expect(findings.some((hit) => hit.rule === 'binaries' && hit.message === 'unlisted-bin')).toBe(true);
  expect(findings.some((hit) => hit.rule === 'exports' && hit.message === 'unusedExport')).toBe(true);
  expect(findings.some((hit) => hit.rule === 'types' && hit.message === 'UnusedType')).toBe(true);
  expect(findings.some((hit) => hit.rule === 'enumMembers' && hit.message === 'Color.Unused')).toBe(true);
  expect(findings.some((hit) => hit.rule === 'classMembers' && hit.message === 'Box.leftover')).toBe(true);
  expect(findings.some((hit) => hit.rule === 'duplicates' && hit.message === 'dup|default')).toBe(true);
}

describe('parseKnipJson', () => {
  it('parses the captured knip JSON reporter fixture, including unused files', () => {
    const raw: unknown = JSON.parse(fs.readFileSync(KNIP_JSON_REPORTER_FIXTURE, 'utf8'));
    const parsed = parseKnipJson(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expectKnipAllIssueTypes(parsed.value);
    }
  });

  it('parses a live knip --reporter json run of the same fixture', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-knip-live-'));
    try {
      writeKnipAllIssuesFixture(dir);
      const parsed = parseKnipOutput(runKnipJsonReporter(dir));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expectKnipAllIssueTypes(parsed.value);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses v6 unused files as {name} objects', () => {
    const parsed = parseKnipJson({ files: [{ name: 'src/orphan.ts' }], issues: [] });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value[0]?.file).toBe('src/orphan.ts');
      expect(parsed.value[0]?.line).toBe(0);
      expect(parsed.value[0]?.rule).toBe('files');
    }
  });

  it('reads top-level files even when issues is also present', () => {
    const parsed = parseKnipJson({
      files: ['src/orphan.ts'],
      issues: [{ file: 'src/a.ts', exports: [{ name: 'unusedExport', line: 4 }] }],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.some((hit) => hit.rule === 'files' && hit.file === 'src/orphan.ts')).toBe(true);
      expect(parsed.value.some((hit) => hit.rule === 'exports' && hit.message === 'unusedExport' && hit.line === 4)).toBe(
        true,
      );
    }
  });

  it('parses nsExports, nsTypes, catalog, and optionalPeerDependencies', () => {
    const parsed = parseKnipJson({
      files: [],
      issues: [
        {
          file: 'package.json',
          optionalPeerDependencies: [{ name: 'react', line: 8 }],
          catalog: [{ name: '@repo/pkg' }],
        },
        {
          file: 'src/ns.ts',
          nsExports: [{ name: 'hidden', line: 2 }],
          nsTypes: [{ name: 'HiddenType', line: 3 }],
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.some((hit) => hit.rule === 'optionalPeerDependencies' && hit.message === 'react')).toBe(true);
      expect(parsed.value.some((hit) => hit.rule === 'catalog' && hit.message === '@repo/pkg')).toBe(true);
      expect(parsed.value.some((hit) => hit.rule === 'nsExports' && hit.message === 'hidden')).toBe(true);
      expect(parsed.value.some((hit) => hit.rule === 'nsTypes' && hit.message === 'HiddenType')).toBe(true);
    }
  });

  it('rejects a non-object', () => {
    expect(parseKnipJson([]).ok).toBe(false);
  });

  it('is a GATE ERROR when knip adds an unknown non-empty issue type', () => {
    const parsed = parseKnipJson({
      files: [],
      issues: [{ file: 'src/a.ts', cycles: ['src/a.ts', 'src/b.ts'] }],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toMatch(/unknown issue type "cycles"/);
    }
  });

  it('skips junk issue rows and empty known keys', () => {
    const parsed = parseKnipJson({
      files: [],
      issues: [null, { file: '' }, { file: 'src/a.ts', exports: [], dependencies: [] }],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual([]);
    }
  });
});

describe('parseJscpdJson', () => {
  it('emits a finding per side of a clone', () => {
    const parsed = parseJscpdJson({
      duplicates: [
        {
          lines: 12,
          firstFile: { name: 'src/a.ts', start: 1, end: 12 },
          secondFile: { name: 'src/b.ts', start: 20, end: 31 },
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toHaveLength(2);
      expect(parsed.value[0]?.file).toBe('src/a.ts');
      expect(parsed.value[0]?.endLine).toBe(12);
      expect(parsed.value[1]?.file).toBe('src/b.ts');
    }
  });

  it('rejects a report without duplicates', () => {
    expect(parseJscpdJson({}).ok).toBe(false);
  });

  it('skips duplicates that lack file locations', () => {
    const parsed = parseJscpdJson({ duplicates: [null, { lines: 4, firstFile: {}, secondFile: {} }] });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual([]);
    }
  });
});

describe('parseTypecheckOutput', () => {
  it('parses tsc pretty format', () => {
    const parsed = parseTypecheckOutput("src/a.ts:10:5 - error TS2322: Type 'string' is not assignable to type 'number'.");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value[0]?.rule).toBe('TS2322');
      expect(parsed.value[0]?.line).toBe(10);
    }
  });

  it('parses tsc parenthesis format', () => {
    const parsed = parseTypecheckOutput("src/a.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value[0]?.file).toBe('src/a.ts');
    }
  });

  it('ignores warnings', () => {
    const parsed = parseTypecheckOutput('src/a.ts(1,1): warning TS9999: whatever');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual([]);
    }
  });
});
