import { describe, expect, it } from 'vitest';
import { stripAnsi } from './ansi.js';

describe('stripAnsi', () => {
  it('removes CSI color and cursor escape sequences', () => {
    const colored = '\x1b[2K\x1b[1G\x1b[31m\x1b[1mFAIL\x1b[22m\x1b[39m  src/a.test.ts > suite > case';
    expect(stripAnsi(colored)).toBe('FAIL  src/a.test.ts > suite > case');
  });

  it('removes OSC hyperlink escapes', () => {
    const linked = '\x1b]8;;https://example.com\x07src/a.ts\x1b]8;;\x07';
    expect(stripAnsi(linked)).toBe('src/a.ts');
  });

  it('leaves plain text, whitespace, and unicode symbols unchanged', () => {
    const plain = '  ● billing › times out\n⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯\r\n';
    expect(stripAnsi(plain)).toBe(plain);
  });
});
