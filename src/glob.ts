/**
 * Match a repo-relative POSIX path against a glob.
 * Supports `*`, `**`, and `?`. No brace expansion or character classes.
 */
function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+.]/g, '\\$&');
}

function globToRegExp(glob: string): RegExp {
  let index = 0;
  let source = '^';
  while (index < glob.length) {
    const ch = glob.charAt(index);
    if (ch === '*') {
      if (glob.charAt(index + 1) === '*') {
        const after = glob.charAt(index + 2);
        if (after === '/') {
          source += '(?:.*/)?';
          index += 3;
          continue;
        }
        source += '.*';
        index += 2;
        continue;
      }
      source += '[^/]*';
      index += 1;
      continue;
    }
    if (ch === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }
    source += escapeRegex(ch);
    index += 1;
  }
  source += '$';
  return new RegExp(source);
}

function posixPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.startsWith('./')) {
    return normalized.slice(2);
  }
  if (normalized.startsWith('/')) {
    return normalized.slice(1);
  }
  return normalized;
}

/**
 * True when `filePath` matches `glob`. Paths are compared as POSIX
 * repo-relative strings (`src/a.ts`), not filesystem walks.
 */
export function matchGlob(filePath: string, glob: string): boolean {
  const path = posixPath(filePath);
  const pattern = posixPath(glob);
  if (pattern === '') {
    return false;
  }
  return globToRegExp(pattern).test(path);
}

export function matchesAnyGlob(filePath: string, globs: readonly string[]): boolean {
  for (const glob of globs) {
    if (matchGlob(filePath, glob)) {
      return true;
    }
  }
  return false;
}
