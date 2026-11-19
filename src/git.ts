/**
 * Git helpers. Failures here are GATE ERRORs: the gate cannot blame app code
 * for a missing repo, missing ref, or git crash. Commands run as argv (never
 * a shell) so paths with spaces or unusual characters are not quoted.
 */
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { terminateChild } from './command.js';
import { DEFAULT_STEP_TIMEOUT_MS, err, errorMessage, ok, type Result } from './types.js';

const MAX_GIT_BUFFER = 32 * 1024 * 1024;

/**
 * Isolate porcelain from the user's git config: quoted paths, color, and
 * prefix/mnemonic settings that would break path and hunk parsing.
 */
const GIT_ISOLATION = [
  '-c',
  'core.quotePath=false',
  '-c',
  'color.ui=never',
  '-c',
  'diff.noprefix=false',
  '-c',
  'diff.mnemonicPrefix=false',
] as const;

const DIFF_HARDENING = ['--no-color', '--no-ext-diff', '--no-textconv'] as const;

const NAME_STATUS_CODES = new Set(['A', 'C', 'D', 'M', 'R', 'T']);

type DiffPathEntry = {
  readonly status: string;
  readonly path: string;
  readonly origPath?: string;
};

function spawnText(value: string | Buffer | null | undefined): string {
  if (value == null) {
    return '';
  }
  return Buffer.isBuffer(value) ? value.toString('utf8') : value;
}

function spawnStartError(bin: string, args: readonly string[], cause: Error): string {
  const detail = cause.message;
  if (detail.includes('ENOENT')) {
    return `${bin} is not installed or not on PATH (${detail})`;
  }
  return `${bin} ${args.join(' ')} failed to start: ${detail}`;
}

function spawnExitError(label: string, status: number | null, stderr: string, stdout = ''): string {
  const detail = stderr || stdout;
  if (detail) {
    return `${label} failed: ${detail}`;
  }
  return `${label} failed with exit ${status ?? 'null'}`;
}

/**
 * Turn a spawnSync git result into a Result. Non-zero always includes stderr
 * so a GATE ERROR can show what git said.
 */
function fromGitSpawn(args: readonly string[], result: SpawnSyncReturns<string | Buffer>): Result<string> {
  if (result.error) {
    return err(spawnStartError('git', args, result.error));
  }
  if (result.status !== 0) {
    return err(
      spawnExitError(
        `git ${args.join(' ')}`,
        result.status,
        spawnText(result.stderr).trim(),
        spawnText(result.stdout).trim(),
      ),
    );
  }
  return ok(spawnText(result.stdout));
}

export function runGit(args: readonly string[], cwd: string): Result<string> {
  const result = spawnSync('git', [...GIT_ISOLATION, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_GIT_BUFFER,
  });
  return fromGitSpawn(args, result);
}

/**
 * Split NUL-terminated git porcelain. A trailing NUL does not yield an extra
 * empty path; interior empty fields are kept so name-status records stay aligned.
 */
export function splitNul(raw: string): string[] {
  if (raw.length === 0) {
    return [];
  }
  const parts = raw.split('\0');
  if (parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts;
}

export function gitRepoRoot(cwd: string): Result<string> {
  const result = runGit(['rev-parse', '--show-toplevel'], cwd);
  if (!result.ok) {
    return err(`not a git repository (${cwd}): ${result.error}`);
  }
  return ok(result.value.trim());
}

const GIT_DIR_SUFFIX = '.git';

/**
 * One folder name for `$HEIMDALL_HOME/<name>` (and `~/.heimdall`, `~/.gate`).
 * Taken from the git common dir so a linked worktree shares the main repo's
 * config instead of using the worktree folder's basename.
 */
export function repoNameFromGitCommonDir(commonDir: string, toplevel: string): string {
  const resolvedCommon = path.resolve(commonDir);
  const base = path.basename(resolvedCommon);
  if (base === GIT_DIR_SUFFIX) {
    return path.basename(path.dirname(resolvedCommon));
  }
  if (base.endsWith(GIT_DIR_SUFFIX)) {
    return base.slice(0, -GIT_DIR_SUFFIX.length);
  }
  return path.basename(path.resolve(toplevel));
}

/**
 * Resolve the config-lookup repo name from `git rev-parse --git-common-dir`.
 * Failures here are GATE ERRORs: without a common dir the home-config name
 * cannot be chosen.
 */
export function gitConfigLookupName(gitRoot: string): Result<string> {
  const result = runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], gitRoot);
  if (!result.ok) {
    return err(`cannot resolve git common dir (${gitRoot}): ${result.error}`);
  }
  const commonDir = result.value.trim();
  if (commonDir === '') {
    return err(`git rev-parse --git-common-dir returned an empty path in ${gitRoot}`);
  }
  return ok(repoNameFromGitCommonDir(path.resolve(gitRoot, commonDir), gitRoot));
}

/**
 * Git root containing `cwd`, or `undefined` when that path is not inside a
 * work tree. Other git failures stay errors so a missing binary is not
 * treated as "not version-controlled".
 */
export function enclosingGitRoot(cwd: string): Result<string | undefined> {
  const result = runGit(['rev-parse', '--show-toplevel'], cwd);
  if (result.ok) {
    return ok(result.value.trim());
  }
  if (/not a git repository/i.test(result.error)) {
    return ok(undefined);
  }
  return err(result.error);
}

export function gitHeadSha(cwd: string): Result<string> {
  const result = runGit(['rev-parse', 'HEAD'], cwd);
  if (!result.ok) {
    return result;
  }
  const sha = result.value.trim();
  if (sha === '') {
    return err(`git rev-parse HEAD returned an empty sha in ${cwd}`);
  }
  return ok(sha);
}

function parseNameStatusZ(raw: string): Result<readonly DiffPathEntry[]> {
  const fields = splitNul(raw);
  const entries: DiffPathEntry[] = [];
  let index = 0;
  while (index < fields.length) {
    const statusField = fields[index];
    if (statusField === undefined || statusField === '') {
      index += 1;
      continue;
    }
    const status = statusField.charAt(0);
    if (!NAME_STATUS_CODES.has(status)) {
      return err(`unexpected git name-status ${JSON.stringify(statusField)}`);
    }
    if (status === 'R' || status === 'C') {
      const origPath = fields[index + 1];
      const path = fields[index + 2];
      if (!origPath || !path) {
        return err(`truncated git name-status record ${JSON.stringify(statusField)}`);
      }
      entries.push({ status, path, origPath });
      index += 3;
      continue;
    }
    const path = fields[index + 1];
    if (!path) {
      return err(`truncated git name-status record ${JSON.stringify(statusField)}`);
    }
    entries.push({ status, path });
    index += 2;
  }
  return ok(entries);
}

/**
 * Changed paths versus `mergeBaseSha`, including renames, copies, type changes,
 * and deletions. Paths come from NUL-separated name-status so quoting and
 * spaces cannot split a name.
 */
export function listChangedPaths(cwd: string, mergeBaseSha: string): Result<readonly DiffPathEntry[]> {
  const listed = runGit(
    ['diff', '--name-status', '-z', '-M', ...DIFF_HARDENING, mergeBaseSha],
    cwd,
  );
  if (!listed.ok) {
    return err(listed.error);
  }
  return parseNameStatusZ(listed.value);
}

/**
 * Untracked, not-ignored paths as NUL-separated `ls-files` records.
 */
export function listUntrackedPaths(cwd: string): Result<readonly string[]> {
  const listed = runGit(['ls-files', '-z', '--others', '--exclude-standard'], cwd);
  if (!listed.ok) {
    return err(listed.error);
  }
  return ok(splitNul(listed.value).filter((filePath) => filePath !== ''));
}

/**
 * Staged, unstaged, and untracked (not ignored) paths under `pathspec`.
 * `git status --porcelain` is used so a repo with no HEAD still lists
 * untracked and index-only files. Paths are relative to `cwd`.
 */
export function listUncommittedPaths(cwd: string, pathspec: string): Result<readonly string[]> {
  const listed = runGit(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', pathspec],
    cwd,
  );
  if (!listed.ok) {
    return err(listed.error);
  }
  const parsed = parseStatusPorcelainZ(listed.value);
  if (!parsed.ok) {
    return parsed;
  }
  const unique = [...new Set(parsed.value.filter((filePath) => filePath !== ''))];
  unique.sort();
  return ok(unique);
}

/**
 * Porcelain v1 `-z` records: `XY path\0`, or `XY orig\0dest\0` for rename/copy.
 * XY is the two-letter index/worktree status; a space then starts the path.
 */
function parseStatusPorcelainZ(raw: string): Result<readonly string[]> {
  const fields = splitNul(raw);
  const paths: string[] = [];
  let index = 0;
  while (index < fields.length) {
    const record = fields[index];
    if (record === undefined || record === '') {
      index += 1;
      continue;
    }
    if (record.length < 4 || record.charAt(2) !== ' ') {
      return err(`unexpected git status porcelain ${JSON.stringify(record)}`);
    }
    const xy = record.slice(0, 2);
    const firstPath = record.slice(3);
    const renamed = xy.includes('R') || xy.includes('C');
    if (renamed) {
      const secondPath = fields[index + 1];
      if (!secondPath) {
        return err(`truncated git status porcelain rename ${JSON.stringify(record)}`);
      }
      paths.push(firstPath, secondPath);
      index += 2;
      continue;
    }
    paths.push(firstPath);
    index += 1;
  }
  return ok(paths);
}

/**
 * Unified `-U0` diff of one path versus the merge-base. Rename/copy entries
 * pass the old path too so git does not treat the new path as entirely added.
 * Paths are argv elements after `--`, never interpolated into a shell string.
 */
export function unifiedDiffForPath(
  cwd: string,
  mergeBaseSha: string,
  repoPath: string,
  origPath?: string,
): Result<string> {
  const paths = origPath !== undefined ? [origPath, repoPath] : [repoPath];
  return runGit(
    [
      'diff',
      '-U0',
      '-M',
      ...DIFF_HARDENING,
      '--src-prefix=a/',
      '--dst-prefix=b/',
      mergeBaseSha,
      '--',
      ...paths,
    ],
    cwd,
  );
}

function attachStderr(child: ChildProcess): () => string {
  const chunks: Buffer[] = [];
  child.stderr?.on('data', (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  return () => Buffer.concat(chunks).toString('utf8').trim();
}

function waitForChild(child: ChildProcess): Promise<{
  error: Error | undefined;
  status: number | null;
}> {
  return new Promise((resolve) => {
    let error: Error | undefined;
    child.once('error', (cause) => {
      error = cause instanceof Error ? cause : new Error(String(cause));
    });
    child.once('close', (status) => {
      resolve({ error, status });
    });
  });
}

function ignorePipeErrors(stream: NodeJS.ReadableStream | NodeJS.WritableStream | null): void {
  stream?.on('error', () => {
    // EPIPE when the other side of git archive | tar exits first.
  });
}

function isChildRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

type MaterializeCommitOptions = {
  readonly abortSignal?: AbortSignal;
  readonly timeoutMs?: number;
};

/**
 * Materialize `sha` into `dest` by streaming `git archive` into `tar -x`.
 * The archive never sits in one Node buffer, so a tree larger than
 * MAX_GIT_BUFFER is still extractable. The caller's working tree is untouched.
 *
 * If tar exits before draining the archive, git is stopped so it cannot block
 * forever on a full pipe. The stream is also bounded by timeoutMs.
 */
export async function materializeCommit(
  cwd: string,
  sha: string,
  dest: string,
  options: MaterializeCommitOptions = {},
): Promise<Result<void>> {
  const abortSignal = options.abortSignal;
  const timeoutMs = options.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  try {
    fs.mkdirSync(dest, { recursive: true });
  } catch (cause) {
    return err(`cannot create checkout directory ${dest}: ${errorMessage(cause)}`);
  }
  if (abortSignal?.aborted) {
    return err(`git archive ${sha} interrupted`);
  }

  const archiveArgs = ['archive', '--format=tar', sha];
  const tarArgs = ['-xf', '-', '-C', dest];
  let git: ChildProcess;
  try {
    git = spawn('git', [...GIT_ISOLATION, ...archiveArgs], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (cause) {
    return err(spawnStartError('git', archiveArgs, cause instanceof Error ? cause : new Error(String(cause))));
  }

  let tar: ChildProcess;
  try {
    tar = spawn('tar', tarArgs, {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
  } catch (cause) {
    terminateChild(git);
    const started = cause instanceof Error ? cause : new Error(String(cause));
    return err(spawnStartError('tar', tarArgs, started));
  }

  if (git.stdout === null || tar.stdin === null) {
    terminateChild(git);
    terminateChild(tar);
    return err('stdio pipes were not created for git archive | tar');
  }
  ignorePipeErrors(git.stdout);
  ignorePipeErrors(tar.stdin);

  const gitStderr = attachStderr(git);
  const tarStderr = attachStderr(tar);

  const stopArchive = (): void => {
    git.stdout?.destroy();
    tar.stdin?.destroy();
    terminateChild(git);
    terminateChild(tar);
  };

  abortSignal?.addEventListener('abort', stopArchive);
  let timedOut = false;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    stopArchive();
  }, timeoutMs);

  const gitClosed = waitForChild(git);
  const tarClosed = waitForChild(tar);
  // Node, not tar, reads git.stdout. If tar stops early the pipe pauses and
  // git archive blocks once the OS buffer fills unless we stop git here.
  tar.once('close', (status) => {
    if (status !== 0 && isChildRunning(git)) {
      git.stdout?.destroy();
      terminateChild(git);
    }
  });

  try {
    await pipeline(git.stdout, tar.stdin).catch(() => {
      // Premature tar close is reported from the child exit statuses below.
    });
    const [gitClose, tarClose] = await Promise.all([gitClosed, tarClosed]);
    if (abortSignal?.aborted) {
      return err(`git archive ${sha} interrupted`);
    }
    if (timedOut) {
      return err(`git archive | tar timed out after ${timeoutMs}ms`);
    }
    if (tarClose.error) {
      return err(spawnStartError('tar', tarArgs, tarClose.error));
    }
    if (tarClose.status !== 0) {
      return err(spawnExitError(`tar extract of ${sha}`, tarClose.status, tarStderr()));
    }
    if (gitClose.error) {
      return err(spawnStartError('git', archiveArgs, gitClose.error));
    }
    if (gitClose.status !== 0) {
      return err(spawnExitError(`git ${archiveArgs.join(' ')}`, gitClose.status, gitStderr()));
    }
    return ok(undefined);
  } finally {
    clearTimeout(timeoutTimer);
    abortSignal?.removeEventListener('abort', stopArchive);
  }
}

/** Why the comparison base was chosen. Printed on the opening `base:` line. */
export type BaseRefSource = 'cli' | 'config' | 'upstream' | 'fallback';

export type ResolvedBaseRef = {
  readonly spec: string;
  readonly sha: string;
  readonly mergeBaseSha: string;
  readonly source: BaseRefSource;
};

function verifyRef(cwd: string, spec: string): Result<string> {
  const result = runGit(['rev-parse', '--verify', spec], cwd);
  if (!result.ok) {
    return err(result.error);
  }
  return ok(result.value.trim());
}

function currentBranchName(cwd: string): string {
  const result = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (!result.ok) {
    return '';
  }
  return result.value.trim();
}

/**
 * Short ref we can pass to git and print in the summary.
 * `refs/heads/feat` → `feat`; `refs/remotes/origin/feat` → `origin/feat`.
 */
function specFromUpstreamFullName(fullName: string): string | undefined {
  if (fullName.startsWith('refs/heads/')) {
    const spec = fullName.slice('refs/heads/'.length);
    return spec === '' ? undefined : spec;
  }
  if (fullName.startsWith('refs/remotes/')) {
    const spec = fullName.slice('refs/remotes/'.length);
    return spec === '' ? undefined : spec;
  }
  return fullName === '' ? undefined : fullName;
}

/**
 * True when @{u} is this branch's own remote-tracking copy
 * (`refs/remotes/<remote>/<same-name>`) or the branch itself. Diffing that
 * would collapse the scope to unpushed commits after `git push -u`.
 */
function isOwnRemoteTrackingRef(currentBranch: string, upstreamFullName: string): boolean {
  if (currentBranch === '' || currentBranch === 'HEAD') {
    return false;
  }
  if (upstreamFullName === `refs/heads/${currentBranch}`) {
    return true;
  }
  if (upstreamFullName.startsWith('refs/remotes/')) {
    const afterRemotes = upstreamFullName.slice('refs/remotes/'.length);
    const slash = afterRemotes.indexOf('/');
    if (slash === -1) {
      return false;
    }
    const branchOnRemote = afterRemotes.slice(slash + 1);
    return branchOnRemote === currentBranch;
  }
  return false;
}

/**
 * True when `@{u}` is configured, including this branch's own remote copy.
 * Distinct from a usable parent: `origin/<same-name>` is an upstream but is
 * not used as the comparison base.
 */
export function hasConfiguredUpstream(cwd: string): boolean {
  return runGit(['rev-parse', '--symbolic-full-name', '@{u}'], cwd).ok;
}

/**
 * Tracked upstream only when it names a different branch (the story's parent).
 * `origin/<same name>` is skipped so a push cannot shrink the diff.
 */
function parentFromUpstream(cwd: string, currentBranch: string): { spec: string; sha: string } | undefined {
  const upstreamFull = runGit(['rev-parse', '--symbolic-full-name', '@{u}'], cwd);
  if (!upstreamFull.ok) {
    return undefined;
  }
  const fullName = upstreamFull.value.trim();
  if (isOwnRemoteTrackingRef(currentBranch, fullName)) {
    return undefined;
  }
  const spec = specFromUpstreamFullName(fullName);
  if (!spec) {
    return undefined;
  }
  const verified = verifyRef(cwd, spec);
  if (!verified.ok) {
    return undefined;
  }
  return { spec, sha: verified.value };
}

function fallbackMain(cwd: string): Result<{ spec: string; sha: string }> {
  const main = verifyRef(cwd, 'refs/heads/main');
  if (main.ok) {
    return ok({ spec: 'main', sha: main.value });
  }
  const originMain = verifyRef(cwd, 'refs/remotes/origin/main');
  if (originMain.ok) {
    return ok({ spec: 'origin/main', sha: originMain.value });
  }
  return err(
    'could not resolve a base ref: no parent branch, no main, and no origin/main. Set baseRef in heimdall.config.json.',
  );
}

function explicitBase(
  cwd: string,
  spec: string,
  unresolvedLabel: string,
): Result<{ spec: string; sha: string }> {
  const verified = verifyRef(cwd, spec);
  if (!verified.ok) {
    return err(`${unresolvedLabel} ${JSON.stringify(spec)} could not be resolved: ${verified.error}`);
  }
  return ok({ spec, sha: verified.value });
}

/**
 * Resolve the comparison base: CLI `--base`, else explicit config, else this
 * branch's tracked parent when that parent is a different branch, else main,
 * else origin/main. Tracking origin/<same-name> is ignored so a push cannot
 * shrink the diff to unpushed commits. An explicit `--base` or baseRef that
 * does not resolve is a GATE ERROR.
 */
export function resolveBaseRef(
  cwd: string,
  configured: string | undefined,
  cliBase?: string,
): Result<ResolvedBaseRef> {
  const head = verifyRef(cwd, 'HEAD');
  if (!head.ok) {
    return err(`cannot resolve HEAD: ${head.error}`);
  }

  let spec: string;
  let sha: string;
  let source: BaseRefSource;
  if (cliBase) {
    const resolved = explicitBase(cwd, cliBase, '--base');
    if (!resolved.ok) {
      return err(resolved.error);
    }
    spec = resolved.value.spec;
    sha = resolved.value.sha;
    source = 'cli';
  } else if (configured) {
    const resolved = explicitBase(cwd, configured, 'configured baseRef');
    if (!resolved.ok) {
      return err(resolved.error);
    }
    spec = resolved.value.spec;
    sha = resolved.value.sha;
    source = 'config';
  } else {
    const parent = parentFromUpstream(cwd, currentBranchName(cwd));
    const resolved = parent ? ok(parent) : fallbackMain(cwd);
    if (!resolved.ok) {
      return err(resolved.error);
    }
    spec = resolved.value.spec;
    sha = resolved.value.sha;
    source = parent ? 'upstream' : 'fallback';
  }

  const mergeBase = runGit(['merge-base', sha, head.value], cwd);
  if (!mergeBase.ok) {
    return err(`git merge-base ${spec} HEAD failed: ${mergeBase.error}`);
  }
  return ok({
    spec,
    sha,
    mergeBaseSha: mergeBase.value.trim(),
    source,
  });
}
