import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KNIP_JSON_REPORTER_FIXTURE,
  runKnipJsonReporter,
  writeKnipAllIssuesFixture,
} from '../test/helpers/knip-all-issues.js';
import {
  parseArchitectureJson,
  parseArchitectureOutput,
  parseEslintOutput,
  parseJscpdJson,
  parseKnipJson,
  parseKnipOutput,
  parseSecretsOutput,
  parseTypecheckOutput,
} from './parsers.js';

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

const LEAKED_SECRET = 'ghp_LEAKEDSECRETVALUE_doNotPrint';

describe('parseSecretsOutput', () => {
  it('parses secretlint 14 JSON using loc.start.line and never copies message text', () => {
    const parsed = parseSecretsOutput(
      JSON.stringify([
        {
          filePath: 'src/a.ts',
          sourceContentType: 'text',
          messages: [
            {
              message: `found GitHub Token: ${LEAKED_SECRET}`,
              range: [0, 40],
              ruleId: '@secretlint/secretlint-rule-github',
              loc: { start: { line: 4, column: 1 }, end: { line: 4, column: 40 } },
              severity: 'error',
              messageId: 'GITHUB_TOKEN',
              data: { ID: LEAKED_SECRET },
            },
          ],
        },
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual([
        {
          step: 'secrets',
          file: 'src/a.ts',
          line: 4,
          rule: '@secretlint/secretlint-rule-github',
          message: '',
        },
      ]);
      expect(JSON.stringify(parsed.value)).not.toContain(LEAKED_SECRET);
      expect(JSON.stringify(parsed.value)).not.toContain('found GitHub Token');
    }
  });

  it('reads an ESLint-shaped line field when loc is absent', () => {
    const parsed = parseSecretsOutput(
      JSON.stringify([
        {
          filePath: 'src/b.ts',
          messages: [{ line: 12, ruleId: '@secretlint/secretlint-rule-aws', message: `found secret: ${LEAKED_SECRET}` }],
        },
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value[0]?.file).toBe('src/b.ts');
      expect(parsed.value[0]?.line).toBe(12);
      expect(parsed.value[0]?.rule).toBe('@secretlint/secretlint-rule-aws');
      expect(parsed.value[0]?.message).toBe('');
    }
  });

  it('parses JSON wrapped in yarn noise', () => {
    const parsed = parseSecretsOutput(
      'yarn run v1.22.22\n[{"filePath":"a.ts","messages":[{"loc":{"start":{"line":1}},"ruleId":"x","message":"found secret"}]}]\nDone in 0.1s.',
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value[0]?.file).toBe('a.ts');
      expect(parsed.value[0]?.line).toBe(1);
      expect(parsed.value[0]?.rule).toBe('x');
    }
  });

  it('does not embed unparseable output in the error', () => {
    for (const output of [`found secret: ${LEAKED_SECRET}`, `{ "token": "${LEAKED_SECRET}"`]) {
      const parsed = parseSecretsOutput(output);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error).toBe('secrets output is not JSON');
        expect(parsed.error).not.toContain(LEAKED_SECRET);
      }
    }
  });

  it('rejects a JSON object that is not a secretlint array', () => {
    expect(parseSecretsOutput('{"filePath":"a.ts","messages":[]}').ok).toBe(false);
  });

  it('skips malformed entries and keeps valid findings', () => {
    const parsed = parseSecretsOutput(
      JSON.stringify([
        null,
        { filePath: 'a.ts' },
        {
          filePath: 'b.ts',
          messages: [null, { loc: { start: { line: 2 } }, ruleId: 'keep-me', message: LEAKED_SECRET }],
        },
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual([
        { step: 'secrets', file: 'b.ts', line: 2, rule: 'keep-me', message: '' },
      ]);
    }
  });
});

function architectureHit(from: string, rule: string, message: string) {
  return { step: 'architecture' as const, file: from, line: 0, rule, message };
}

function architectureCruise(violations: readonly unknown[]): unknown {
  return { summary: { violations } };
}

describe('parseArchitectureOutput', () => {
  it('parses error-severity edges as rule plus from -> to and ignores warnings', () => {
    const parsed = parseArchitectureOutput(
      JSON.stringify(
        architectureCruise([
          {
            type: 'dependency',
            from: 'src/a.ts',
            to: 'src/forbidden.ts',
            rule: { name: 'not-to-unallowed', severity: 'error' },
          },
          {
            type: 'dependency',
            from: 'src/a.ts',
            to: 'src/legacy.ts',
            rule: { name: 'no-legacy', severity: 'warn' },
          },
          {
            type: 'module',
            from: 'src/orphan.ts',
            to: 'src/orphan.ts',
            rule: { name: 'no-orphans', severity: 'info' },
          },
        ]),
      ),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual([
        architectureHit('src/a.ts', 'not-to-unallowed', 'src/a.ts -> src/forbidden.ts'),
      ]);
    }
  });

  it('reports a cycle path from 18.x IMiniDependency entries', () => {
    const parsed = parseArchitectureJson(
      architectureCruise([
        {
          type: 'cycle',
          from: 'src/a.ts',
          to: 'src/b.ts',
          rule: { name: 'no-circular', severity: 'error' },
          cycle: [
            { name: 'src/b.ts', dependencyTypes: ['local'] },
            { name: 'src/a.ts', dependencyTypes: ['local'] },
          ],
        },
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual([
        architectureHit('src/a.ts', 'no-circular', 'src/a.ts -> src/b.ts -> src/a.ts'),
      ]);
    }
  });

  it('parses JSON wrapped in yarn noise', () => {
    const parsed = parseArchitectureOutput(
      'yarn run v1.22.22\n{"summary":{"violations":[{"from":"a.ts","to":"b.ts","rule":{"name":"x","severity":"error"}}]}}\nDone in 0.1s.',
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value[0]?.message).toBe('a.ts -> b.ts');
      expect(parsed.value[0]?.rule).toBe('x');
    }
  });

  it('errors on malformed non-JSON output', () => {
    const parsed = parseArchitectureOutput('ERROR: Can\'t open .dependency-cruiser.js');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toMatch(/not JSON/);
    }
  });

  it('rejects JSON that is not a cruise result with summary.violations[]', () => {
    expect(parseArchitectureOutput('{"modules":[]}').ok).toBe(false);
    expect(parseArchitectureOutput('[]').ok).toBe(false);
    expect(parseArchitectureJson({ summary: {} }).ok).toBe(false);
  });

  it('skips malformed violation rows and keeps valid error findings', () => {
    const parsed = parseArchitectureJson(
      architectureCruise([
        null,
        { from: 'src/a.ts' },
        { from: 'src/a.ts', to: 'src/b.ts', rule: { name: 'keep-me', severity: 'error' } },
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual([architectureHit('src/a.ts', 'keep-me', 'src/a.ts -> src/b.ts')]);
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
