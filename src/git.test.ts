import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  enclosingGitRoot,
  gitHeadSha,
  listUncommittedPaths,
  materializeCommit,
  resolveBaseRef,
  runGit,
  splitNul,
} from './git.js';
import { withProcessEnv } from '../test/helpers/gate-test.js';
import { commitAll, git, withTempRepo, writeRepoFile } from '../test/helpers/temp-repo.js';

async function withArchiveDest(fn: (dest: string) => Promise<void>): Promise<void> {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-archive-'));
  try {
    await fn(dest);
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
}

describe('splitNul', () => {
  it('returns an empty list for empty output', () => {
    expect(splitNul('')).toEqual([]);
  });

  it('drops a trailing NUL without dropping interior empty fields', () => {
    expect(splitNul('a\0b\0')).toEqual(['a', 'b']);
    expect(splitNul('A\0path with space.ts\0')).toEqual(['A', 'path with space.ts']);
  });
});

describe('resolveBaseRef', () => {
  it('falls back to main when there is no upstream', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'README.md', 'base\n');
      commitAll(repo, 'initial');
      git(repo, ['checkout', '-q', '-b', 'feat']);
      writeRepoFile(repo, 'src/a.ts', 'export const a = 1;\n');
      commitAll(repo, 'feat');
      const resolved = resolveBaseRef(repo, undefined);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.value.spec).toBe('main');
      }
    });
  });

  it('uses a tracked upstream when it is a different branch', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'README.md', 'base\n');
      commitAll(repo, 'initial');
      git(repo, ['checkout', '-q', '-b', 'feat']);
      git(repo, ['branch', '--set-upstream-to=main']);
      writeRepoFile(repo, 'src/a.ts', 'export const a = 1;\n');
      commitAll(repo, 'feat');
      const resolved = resolveBaseRef(repo, undefined);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.value.spec).toBe('main');
      }
    });
  });

  it('uses a story branch parent (gate/s3 tracking feat) not main', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'README.md', 'base\n');
      commitAll(repo, 'initial');
      const mainSha = git(repo, ['rev-parse', 'HEAD']).trim();
      git(repo, ['checkout', '-q', '-b', 'feat']);
      writeRepoFile(repo, 'src/feat.ts', 'export const f = 1;\n');
      commitAll(repo, 'feat work');
      const featSha = git(repo, ['rev-parse', 'HEAD']).trim();
      git(repo, ['checkout', '-q', '-b', 'gate/s3']);
      writeRepoFile(repo, 'src/story.ts', 'export const s = 1;\n');
      commitAll(repo, 'story');
      git(repo, ['branch', '--set-upstream-to=feat']);
      const resolved = resolveBaseRef(repo, undefined);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.value.spec).toBe('feat');
        expect(resolved.value.mergeBaseSha).toBe(featSha);
        expect(resolved.value.mergeBaseSha).not.toBe(mainSha);
      }
    });
  });

  it('does not use origin/<same name> as the base after a push', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'README.md', 'base\n');
      commitAll(repo, 'initial');
      const mainSha = git(repo, ['rev-parse', 'HEAD']).trim();
      git(repo, ['checkout', '-q', '-b', 'feat']);
      writeRepoFile(repo, 'src/a.ts', 'export const a = 1;\n');
      commitAll(repo, 'feat');
      const featSha = git(repo, ['rev-parse', 'HEAD']).trim();
      git(repo, ['remote', 'add', 'origin', 'https://example.invalid/gate.git']);
      git(repo, ['update-ref', 'refs/remotes/origin/feat', featSha]);
      git(repo, ['branch', '--set-upstream-to=origin/feat']);
      const resolved = resolveBaseRef(repo, undefined);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.value.spec).toBe('main');
        expect(resolved.value.mergeBaseSha).toBe(mainSha);
        expect(resolved.value.mergeBaseSha).not.toBe(featSha);
      }
    });
  });

  it('uses origin/<parent> when the story tracks a different remote branch', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'README.md', 'base\n');
      commitAll(repo, 'initial');
      git(repo, ['checkout', '-q', '-b', 'feat']);
      writeRepoFile(repo, 'src/feat.ts', 'export const f = 1;\n');
      commitAll(repo, 'feat work');
      const featSha = git(repo, ['rev-parse', 'HEAD']).trim();
      git(repo, ['remote', 'add', 'origin', 'https://example.invalid/gate.git']);
      git(repo, ['update-ref', 'refs/remotes/origin/feat', featSha]);
      git(repo, ['checkout', '-q', '-b', 'gate/s3']);
      writeRepoFile(repo, 'src/story.ts', 'export const s = 1;\n');
      commitAll(repo, 'story');
      git(repo, ['branch', '--set-upstream-to=origin/feat']);
      const resolved = resolveBaseRef(repo, undefined);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.value.spec).toBe('origin/feat');
        expect(resolved.value.mergeBaseSha).toBe(featSha);
      }
    });
  });

  it('falls back to origin/main when main is missing', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'README.md', 'base\n');
      commitAll(repo, 'initial');
      git(repo, ['branch', '-m', 'trunk']);
      git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
      git(repo, ['checkout', '-q', '-b', 'feat']);
      writeRepoFile(repo, 'src/a.ts', 'export const a = 1;\n');
      commitAll(repo, 'feat');
      const resolved = resolveBaseRef(repo, undefined);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.value.spec).toBe('origin/main');
      }
    });
  });

  it('resolves the main branch, not a tag named main', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'README.md', 'base\n');
      commitAll(repo, 'initial');
      const branchSha = git(repo, ['rev-parse', 'HEAD']).trim();
      git(repo, ['checkout', '-q', '-b', 'feat']);
      writeRepoFile(repo, 'src/a.ts', 'export const a = 1;\n');
      commitAll(repo, 'feat');
      git(repo, ['tag', 'main']);
      const resolved = resolveBaseRef(repo, undefined);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.value.spec).toBe('main');
        expect(resolved.value.mergeBaseSha).toBe(branchSha);
      }
    });
  });

  it('uses an explicit configured baseRef', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'README.md', 'base\n');
      commitAll(repo, 'initial');
      git(repo, ['checkout', '-q', '-b', 'feat']);
      writeRepoFile(repo, 'src/a.ts', 'export const a = 1;\n');
      commitAll(repo, 'feat');
      const resolved = resolveBaseRef(repo, 'main');
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.value.spec).toBe('main');
      }
    });
  });

  it('errors when a configured baseRef does not exist', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'README.md', 'base\n');
      commitAll(repo, 'initial');
      const resolved = resolveBaseRef(repo, 'does-not-exist');
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) {
        expect(resolved.error).toMatch(/baseRef/);
      }
    });
  });
});

describe('enclosingGitRoot', () => {
  it('returns the git root from a subdirectory', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'src/a.ts', 'export const a = 1;\n');
      commitAll(repo, 'initial');
      const nested = path.join(repo, 'src');
      const rooted = enclosingGitRoot(nested);
      expect(rooted).toEqual({ ok: true, value: git(repo, ['rev-parse', '--show-toplevel']).trim() });
    });
  });

  it('returns undefined for a directory that is not a git work tree', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-nogit-root-'));
    try {
      const rooted = enclosingGitRoot(dir);
      expect(rooted).toEqual({ ok: true, value: undefined });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('gitHeadSha', () => {
  it('returns HEAD', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'README.md', 'base\n');
      commitAll(repo, 'initial');
      const expected = git(repo, ['rev-parse', 'HEAD']).trim();
      expect(gitHeadSha(repo)).toEqual({ ok: true, value: expected });
    });
  });

  it('errors when the repo has no commits', async () => {
    await withTempRepo(async (repo) => {
      const sha = gitHeadSha(repo);
      expect(sha.ok).toBe(false);
    });
  });
});

describe('listUncommittedPaths', () => {
  it('lists unstaged, staged, and untracked files under a pathspec only', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'keep/tracked.ts', 'export const a = 1;\n');
      writeRepoFile(repo, 'keep/staged.ts', 'export const s = 1;\n');
      writeRepoFile(repo, 'other/leave.ts', 'export const o = 1;\n');
      commitAll(repo, 'base');
      writeRepoFile(repo, 'keep/tracked.ts', 'export const a = 2;\n');
      writeRepoFile(repo, 'keep/staged.ts', 'export const s = 2;\n');
      git(repo, ['add', 'keep/staged.ts']);
      writeRepoFile(repo, 'keep/untracked.ts', 'export const u = 1;\n');
      writeRepoFile(repo, 'other/leave.ts', 'export const o = 2;\n');
      writeRepoFile(repo, 'other/new.ts', 'export const n = 1;\n');
      const listed = listUncommittedPaths(repo, 'keep');
      expect(listed.ok).toBe(true);
      if (listed.ok) {
        expect(listed.value).toEqual(['keep/staged.ts', 'keep/tracked.ts', 'keep/untracked.ts']);
      }
    });
  });

  it('lists a file with a space in the name', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'cfg/heimdall.config.json', '{}\n');
      commitAll(repo, 'base');
      writeRepoFile(repo, 'cfg/helper script.js', 'export {}\n');
      const listed = listUncommittedPaths(repo, 'cfg');
      expect(listed).toEqual({ ok: true, value: ['cfg/helper script.js'] });
    });
  });

  it('lists both sides of a rename under the pathspec', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'cfg/knip.json', '{}\n');
      commitAll(repo, 'base');
      git(repo, ['mv', 'cfg/knip.json', 'cfg/knip.next.json']);
      const listed = listUncommittedPaths(repo, 'cfg');
      expect(listed.ok).toBe(true);
      if (listed.ok) {
        expect(listed.value).toEqual(['cfg/knip.json', 'cfg/knip.next.json']);
      }
    });
  });

  it('returns an empty list when the pathspec is clean', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'cfg/heimdall.config.json', '{}\n');
      writeRepoFile(repo, 'other/dirty.ts', 'export const o = 1;\n');
      commitAll(repo, 'base');
      writeRepoFile(repo, 'other/dirty.ts', 'export const o = 2;\n');
      expect(listUncommittedPaths(repo, 'cfg')).toEqual({ ok: true, value: [] });
    });
  });

  it('lists index and untracked files when the repo has no HEAD', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'cfg/heimdall.config.json', '{}\n');
      git(repo, ['add', 'cfg/heimdall.config.json']);
      writeRepoFile(repo, 'cfg/knip.json', '{}\n');
      const listed = listUncommittedPaths(repo, 'cfg');
      expect(listed.ok).toBe(true);
      if (listed.ok) {
        expect(listed.value).toEqual(['cfg/heimdall.config.json', 'cfg/knip.json']);
      }
    });
  });
});

describe('runGit', () => {
  it('includes stderr on a failed git command', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'README.md', 'base\n');
      commitAll(repo, 'initial');
      const result = runGit(['rev-parse', '--verify', 'no-such-ref-for-gate'], repo);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/git rev-parse --verify no-such-ref-for-gate failed:/);
        expect(result.error).toMatch(/Needed a single revision|unknown revision|ambiguous argument/i);
      }
    });
  });
});

async function withFakeTarOnPath(script: string, fn: () => Promise<void>): Promise<void> {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-fake-tar-'));
  fs.writeFileSync(path.join(bin, 'tar'), script, { mode: 0o755 });
  try {
    await withProcessEnv({ PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` }, fn);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

function expectTarExtractFailed(archived: Awaited<ReturnType<typeof materializeCommit>>): asserts archived is { ok: false; error: string } {
  expect(archived.ok).toBe(false);
  if (!archived.ok) {
    expect(archived.error).toMatch(/tar extract of .* failed:/);
    expect(archived.error).toMatch(/tar boom/);
    expect(archived.error).not.toMatch(/git archive/);
  }
}

describe('materializeCommit', () => {
  it('extracts the commit without touching the working tree', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'src/a.ts', 'export const a = 1;\n');
      commitAll(repo, 'base');
      const sha = git(repo, ['rev-parse', 'HEAD']).trim();
      writeRepoFile(repo, 'src/a.ts', 'export const a = 2;\n');
      await withArchiveDest(async (dest) => {
        const archived = await materializeCommit(repo, sha, dest);
        expect(archived.ok).toBe(true);
        expect(fs.readFileSync(path.join(dest, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
        expect(fs.readFileSync(path.join(repo, 'src/a.ts'), 'utf8')).toBe('export const a = 2;\n');
      });
    });
  });

  it('extracts a commit larger than the git spawnSync buffer', async () => {
    await withTempRepo(async (repo) => {
      const bytes = 33 * 1024 * 1024;
      fs.writeFileSync(path.join(repo, 'big.bin'), Buffer.alloc(bytes));
      commitAll(repo, 'big');
      const sha = git(repo, ['rev-parse', 'HEAD']).trim();
      await withArchiveDest(async (dest) => {
        const archived = await materializeCommit(repo, sha, dest);
        expect(archived.ok).toBe(true);
        if (!archived.ok) {
          return;
        }
        expect(fs.statSync(path.join(dest, 'big.bin')).size).toBe(bytes);
      });
    });
  });

  it('is an error with stderr when the sha cannot be archived', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'README.md', 'base\n');
      commitAll(repo, 'initial');
      await withArchiveDest(async (dest) => {
        const archived = await materializeCommit(repo, 'not-a-sha', dest);
        expect(archived.ok).toBe(false);
        if (!archived.ok) {
          expect(archived.error).toMatch(/git archive --format=tar not-a-sha failed:/);
          expect(archived.error).toMatch(/fatal:|not a valid object|unknown revision|ambiguous argument/i);
        }
      });
    });
  });

  it('is an error with stderr when tar extract fails', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'README.md', 'base\n');
      commitAll(repo, 'initial');
      const sha = git(repo, ['rev-parse', 'HEAD']).trim();
      await withFakeTarOnPath('#!/bin/sh\ncat >/dev/null\necho "tar boom" >&2\nexit 1\n', async () => {
        await withArchiveDest(async (dest) => {
          const archived = await materializeCommit(repo, sha, dest);
          expectTarExtractFailed(archived);
        });
      });
    });
  });

  it('errors on tar without hanging when tar exits before reading the archive', async () => {
    await withTempRepo(async (repo) => {
      fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.alloc(128 * 1024));
      commitAll(repo, 'blob');
      const sha = git(repo, ['rev-parse', 'HEAD']).trim();
      await withFakeTarOnPath('#!/bin/sh\necho "tar boom" >&2\nexit 1\n', async () => {
        await withArchiveDest(async (dest) => {
          const started = Date.now();
          const archived = await materializeCommit(repo, sha, dest, { timeoutMs: 2000 });
          expect(Date.now() - started).toBeLessThan(1500);
          expectTarExtractFailed(archived);
          expect(archived.error).not.toMatch(/timed out/);
        });
      });
    });
  });
});
