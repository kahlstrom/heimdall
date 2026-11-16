import { errorMessage } from './types.js';

/**
 * Extract a JSON value from tool stdout. Diagnostics belong on stderr;
 * this still ignores leading npm/yarn noise and stops at the first complete
 * value so a leaked Node warning like `[DEP0040]` cannot shift the parse.
 */
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  return extractJsonWhere(text, () => true);
}

/**
 * Walk complete JSON values in `text` and return the first that `match` accepts.
 * Needed when verbose reporter output contains a `{` (assertion diffs) before
 * a trailing `--reporter=json` object.
 */
export function extractJsonWhere(
  text: string,
  match: (value: unknown) => boolean,
): { ok: true; value: unknown } | { ok: false; error: string } {
  let from = 0;
  let lastError = 'no JSON object or array in output';
  while (from < text.length) {
    const start = indexOfJsonStart(text, from);
    if (start === undefined) {
      return { ok: false, error: lastError };
    }
    const end = indexOfMatchingJsonEnd(text, start);
    if (end === undefined) {
      from = start + 1;
      continue;
    }
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      if (match(value)) {
        return { ok: true, value };
      }
      from = end + 1;
    } catch (cause) {
      lastError = errorMessage(cause);
      from = start + 1;
    }
  }
  return { ok: false, error: lastError };
}

function indexOfJsonStart(text: string, from = 0): number | undefined {
  for (let index = from; index < text.length; index += 1) {
    const ch = text.charAt(index);
    if (ch === '{' || ch === '[') {
      return index;
    }
  }
  return undefined;
}

/**
 * Walk from the opening `{`/`[` to its matching closer, ignoring brackets
 * inside strings. lastIndexOf would land inside a trailing `[DEP0040]` warning.
 */
function indexOfMatchingJsonEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < text.length; index += 1) {
    const ch = text.charAt(index);
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth += 1;
      continue;
    }
    if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
      if (depth < 0) {
        return undefined;
      }
    }
  }
  return undefined;
}
