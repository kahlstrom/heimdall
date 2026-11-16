import { describe, expect, it } from 'vitest';
import { extractJson, extractJsonWhere } from './json.js';

describe('extractJson', () => {
  it('parses a bare object', () => {
    const parsed = extractJson('{"ok":true}');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual({ ok: true });
    }
  });

  it('strips leading and trailing npm noise', () => {
    const parsed = extractJson('npm warn whatever\n[{"a":1}]\nDone.');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual([{ a: 1 }]);
    }
  });

  it('fails when there is no JSON', () => {
    const parsed = extractJson('nope');
    expect(parsed.ok).toBe(false);
  });

  it('does not let a trailing Node warning with brackets break the parse', () => {
    const parsed = extractJson(
      '[{"a":1}]\n(node:1234) [MODULE_TYPELESS_PACKAGE_JSON] Warning: [DEP0040]\n',
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual([{ a: 1 }]);
    }
  });

  it('parses nested objects and ignores braces inside strings', () => {
    const parsed = extractJson('{"msg":"use } please","arr":[1]}\ntrailing ]');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual({ msg: 'use } please', arr: [1] });
    }
  });
});

describe('extractJsonWhere', () => {
  it('skips a leading JSON value that is not the reporter', () => {
    const parsed = extractJsonWhere('{"a":1}\n{"testResults":[]}', (value) => {
      return typeof value === 'object' && value !== null && 'testResults' in value;
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual({ testResults: [] });
    }
  });
});
