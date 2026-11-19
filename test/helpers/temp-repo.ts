/**
 * Temp git repos for gate tests. Always cleaned up, even on failure.
 * Linked worktrees are created next to the main checkout so the helper's
 * `finally` still deletes them with the temp parent. Submodules are created
 * inside the superproject (for example `vendor/lib`).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

export function writeRepoFile(repo: string, rel: string, contents: string): void {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

export function commitAll(repo: string, message: string): void {
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'commit.gpgsign=false', 'commit', '-m', message]);
}

/**
 * Create a throwaway repo. `folderName` nests it under the temp parent so
 * siblings (worktrees, a separate git dir) share that cleanup. `initArgs`
 * are extra `git init` flags after `-b main` (for example
 * `--separate-git-dir` with a path under the temp parent).
 */
export async function withTempRepo(
  fn: (repo: string) => Promise<void>,
  options?: { readonly folderName?: string; readonly initArgs?: readonly string[] },
): Promise<void> {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-test-'));
  const repo = options?.folderName ? path.join(parent, options.folderName) : parent;
  if (options?.folderName) {
    fs.mkdirSync(repo, { recursive: true });
  }
  try {
    git(repo, ['init', '-b', 'main', ...(options?.initArgs ?? [])]);
    git(repo, ['config', 'user.email', 'gate-test@example.com']);
    git(repo, ['config', 'user.name', 'Gate Test']);
    git(repo, ['config', 'commit.gpgsign', 'false']);
    await fn(repo);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

/**
 * Add a linked worktree as a sibling of `repo`. `withTempRepo({ folderName })`
 * must have been used so both folders share the temp parent.
 */
export function addWorktree(repo: string, folderName: string, ref?: string): string {
  const dest = path.join(path.dirname(repo), folderName);
  if (ref === undefined) {
    git(repo, ['worktree', 'add', dest]);
  } else {
    git(repo, ['worktree', 'add', dest, ref]);
  }
  return dest;
}
