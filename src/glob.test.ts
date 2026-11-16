import { describe, expect, it } from 'vitest';
import { matchGlob, matchesAnyGlob } from './glob.js';

describe('matchGlob', () => {
  it('matches an exact path', () => {
    expect(matchGlob('src/secret.ts', 'src/secret.ts')).toBe(true);
    expect(matchGlob('src/other.ts', 'src/secret.ts')).toBe(false);
  });

  it('treats * as a single path segment', () => {
    expect(matchGlob('src/a.ts', 'src/*.ts')).toBe(true);
    expect(matchGlob('src/nested/a.ts', 'src/*.ts')).toBe(false);
  });

  it('treats ** as any number of segments, including none', () => {
    expect(matchGlob('src/generated/a.ts', 'src/generated/**')).toBe(true);
    expect(matchGlob('src/generated/deep/a.ts', 'src/generated/**')).toBe(true);
    expect(matchGlob('src/generated', 'src/generated/**')).toBe(false);
    expect(matchGlob('src/other.ts', 'src/generated/**')).toBe(false);
    expect(matchGlob('foo.gen.ts', '**/*.gen.ts')).toBe(true);
    expect(matchGlob('src/foo.gen.ts', '**/*.gen.ts')).toBe(true);
  });

  it('treats ? as one non-slash character', () => {
    expect(matchGlob('src/a.ts', 'src/?.ts')).toBe(true);
    expect(matchGlob('src/ab.ts', 'src/?.ts')).toBe(false);
  });

  it('strips a leading ./ or / on either side', () => {
    expect(matchGlob('./src/a.ts', 'src/a.ts')).toBe(true);
    expect(matchGlob('src/a.ts', './src/a.ts')).toBe(true);
    expect(matchGlob('/src/a.ts', 'src/a.ts')).toBe(true);
  });
});

describe('matchesAnyGlob', () => {
  it('is true when any glob matches', () => {
    expect(matchesAnyGlob('vendor/lib.ts', ['src/**', 'vendor/**'])).toBe(true);
    expect(matchesAnyGlob('README.md', ['src/**', 'vendor/**'])).toBe(false);
    expect(matchesAnyGlob('src/a.ts', [])).toBe(false);
  });
});
