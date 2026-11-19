/**
 * Diff scoping: secrets/jscpd fail only on NEW problems in files and lines
 * changed versus the merge-base of the configured base ref (plus untracked files).
 * ESLint keeps those added-line hits and also uses findingsNotInBase for leftovers
 * on untouched lines. Knip and architecture run on the whole project and keep
 * findings that do not exist at the merge-base. Git renames (`-M`) are paired in
 * `renamedFrom` so a finding in the new path matches the merge-base under the old.
 */
import fs from 'node:fs';
import path from 'node:path';
import { listChangedPaths, listUntrackedPaths, unifiedDiffForPath, type ResolvedBaseRef } from './git.js';
import { err, errorMessage, ok, type DiffScope, type Finding, type Result } from './types.js';

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function isBinaryDiff(diffText: string): boolean {
  return /^(?:Binary files |GIT binary patch)/m.test(diffText);
}

/**
 * 1-based line count. A trailing newline does not create an extra line, so the
 * last line of a file (with or without a final newline) is numbered exactly.
 */
function lineCount(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

/**
 * Parse `git diff -U0` hunks into 1-based line numbers on the post-image side.
 * `\` markers are not lines. New-side lines are counted from the hunk header's
 * `+start,count` (omitted count = 1), not by sniffing `+++`/`---` prefixes.
 */
export function parseChangedNewLines(diffText: string): Result<Set<number>> {
  const lines = new Set<number>();
  let newLine = 0;
  let remainingNew = 0;
  let inHunk = false;

  const finishHunk = (): Result<void> => {
    if (inHunk && remainingNew !== 0) {
      return err(`unified diff hunk ended with ${remainingNew} new-side line(s) still expected`);
    }
    inHunk = false;
    remainingNew = 0;
    return ok(undefined);
  };

  for (const raw of diffText.split('\n')) {
    const hunk = HUNK_HEADER.exec(raw);
    if (hunk) {
      const done = finishHunk();
      if (!done.ok) {
        return err(done.error);
      }
      newLine = Number.parseInt(hunk[3] ?? '0', 10);
      remainingNew = hunk[4] === undefined ? 1 : Number.parseInt(hunk[4], 10);
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      continue;
    }
    if (raw.startsWith('\\')) {
      continue;
    }
    const prefix = raw.charAt(0);
    if (prefix === '-') {
      continue;
    }
    if (prefix === '+' || prefix === ' ') {
      if (remainingNew <= 0) {
        return err('unified diff hunk has more new-side lines than the header count');
      }
      if (prefix === '+') {
        lines.add(newLine);
      }
      newLine += 1;
      remainingNew -= 1;
      continue;
    }
    const done = finishHunk();
    if (!done.ok) {
      return err(done.error);
    }
  }
  const done = finishHunk();
  if (!done.ok) {
    return err(done.error);
  }
  return ok(lines);
}

/**
 * Destination path from a `+++ ` line, or undefined for `/dev/null` / missing.
 * A `+++` line that is not `b/`-prefixed is a GATE ERROR: user git config
 * (noprefix, mnemonicPrefix) leaked into the parse.
 */
function parsePlusPath(raw: string): Result<string | undefined> {
  const rest = raw.startsWith('+++ ') ? raw.slice('+++ '.length).trim() : raw.trim();
  if (rest === '/dev/null' || rest === '') {
    return ok(undefined);
  }
  if (!rest.startsWith('b/')) {
    return err(`git diff +++ line did not use dst prefix b/: ${raw}`);
  }
  return ok(rest.slice(2));
}

function sameExistingPath(left: string, right: string): boolean {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return false;
  }
}

function existingRealpath(abs: string): string | undefined {
  try {
    return fs.realpathSync(abs);
  } catch {
    return undefined;
  }
}

/**
 * Resolve a path through the first existing ancestor's realpath so `/var`
 * vs `/private/var` (and other symlinked roots) still match, even when the
 * leaf file does not exist yet.
 */
function normalizePath(filePath: string): string {
  const abs = path.resolve(filePath);
  const real = existingRealpath(abs);
  if (real) {
    return real;
  }
  const tail: string[] = [];
  let current = abs;
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) {
      return abs;
    }
    tail.push(path.basename(current));
    const parentReal = existingRealpath(parent);
    if (parentReal) {
      return path.join(parentReal, ...tail.reverse());
    }
    current = parent;
  }
}

function relativeToRoot(abs: string, root: string): string | undefined {
  if (abs === root) {
    return '.';
  }
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (abs.startsWith(prefix)) {
    return abs.slice(prefix.length).split(path.sep).join('/');
  }
  return undefined;
}

/**
 * Repo-relative path of the Heimdall config if this story's diff includes it.
 * Used to stop an agent loosening Heimdall from the story it is gating.
 * Realpath both sides so a `/var` vs `/private/var` cwd still matches.
 */
export function configFileInDiff(scope: DiffScope, configPath: string, repoRoot: string): string | undefined {
  const repoPath = toRepoPath(configPath, repoRoot);
  // A config outside the repo is never in the target git diff, so this guard
  // cannot treat `$HEIMDALL_HOME` or an external `--config` as a story change.
  // Uncommitted files in that outside directory are checked separately.
  if (repoPath === undefined) {
    return undefined;
  }
  if (scope.changedFiles.has(repoPath)) {
    return repoPath;
  }
  const configAbs = path.resolve(configPath);
  for (const changed of scope.changedFiles) {
    const changedAbs = path.resolve(repoRoot, changed);
    if (sameExistingPath(configAbs, changedAbs)) {
      return changed;
    }
  }
  return undefined;
}

function locatedRepoPath(
  filePath: string,
  repoRoot: string,
): { readonly abs: string; readonly repoPath: string } | undefined {
  const root = normalizePath(repoRoot);
  const abs = path.isAbsolute(filePath) ? normalizePath(filePath) : normalizePath(path.join(repoRoot, filePath));
  const repoPath = relativeToRoot(abs, root);
  if (repoPath === undefined) {
    return undefined;
  }
  return { abs, repoPath };
}

/**
 * Repo-relative POSIX path, or `undefined` when `filePath` is not under
 * `repoRoot`. Relative paths resolve against `repoRoot` (the step cwd), never
 * `process.cwd()`. Both sides are realpath'd so symlink/`/var` aliases match.
 */
export function toRepoPath(filePath: string, repoRoot: string): string | undefined {
  return locatedRepoPath(filePath, repoRoot)?.repoPath;
}

function allLineNumbers(filePath: string, repoRoot: string): Result<Set<number>> {
  const abs = path.join(repoRoot, filePath);
  try {
    const text = fs.readFileSync(abs, 'utf8');
    const count = lineCount(text);
    const lines = new Set<number>();
    for (let line = 1; line <= count; line += 1) {
      lines.add(line);
    }
    return ok(lines);
  } catch (cause) {
    return err(`cannot read untracked file ${JSON.stringify(filePath)}: ${errorMessage(cause)}`);
  }
}

function plusPathFromDiff(diffText: string): Result<string | undefined> {
  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('+++ ')) {
      return parsePlusPath(raw);
    }
  }
  return ok(undefined);
}

function addedLinesForChangedPath(
  repoRoot: string,
  mergeBaseSha: string,
  filePath: string,
  status: string,
  origPath: string | undefined,
): Result<Set<number> | undefined> {
  if (status === 'D') {
    return ok(new Set());
  }
  const diff = unifiedDiffForPath(repoRoot, mergeBaseSha, filePath, origPath);
  if (!diff.ok) {
    return err(`failed to diff ${JSON.stringify(filePath)}: ${diff.error}`);
  }
  if (isBinaryDiff(diff.value)) {
    // Unknown line map: omit from addedLines so findings on this file stay.
    return ok(undefined);
  }
  const plusPath = plusPathFromDiff(diff.value);
  if (!plusPath.ok) {
    return err(plusPath.error);
  }
  if (plusPath.value !== undefined && plusPath.value !== filePath) {
    return err(
      `git diff +++ path ${JSON.stringify(plusPath.value)} does not match ${JSON.stringify(filePath)}`,
    );
  }
  const added = parseChangedNewLines(diff.value);
  if (!added.ok) {
    return err(`failed to parse diff for ${JSON.stringify(filePath)}: ${added.error}`);
  }
  return ok(added.value);
}

export function loadDiffScope(repoRoot: string, base: ResolvedBaseRef): Result<DiffScope> {
  const changed = listChangedPaths(repoRoot, base.mergeBaseSha);
  if (!changed.ok) {
    return err(`failed to diff against ${base.spec}: ${changed.error}`);
  }

  const addedByFile = new Map<string, Set<number>>();
  const changedFiles = new Set<string>();
  const renamedFrom = new Map<string, string>();
  for (const entry of changed.value) {
    changedFiles.add(entry.path);
    if (entry.origPath !== undefined) {
      changedFiles.add(entry.origPath);
    }
    if (entry.status === 'R' && entry.origPath !== undefined && entry.origPath !== entry.path) {
      renamedFrom.set(entry.path, entry.origPath);
    }
    const added = addedLinesForChangedPath(
      repoRoot,
      base.mergeBaseSha,
      entry.path,
      entry.status,
      entry.origPath,
    );
    if (!added.ok) {
      return err(added.error);
    }
    if (added.value !== undefined) {
      addedByFile.set(entry.path, added.value);
    }
  }

  const untracked = listUntrackedPaths(repoRoot);
  if (!untracked.ok) {
    return err(`failed to list untracked files: ${untracked.error}`);
  }
  for (const filePath of untracked.value) {
    changedFiles.add(filePath);
    if (!addedByFile.has(filePath)) {
      const lines = allLineNumbers(filePath, repoRoot);
      if (!lines.ok) {
        return err(lines.error);
      }
      addedByFile.set(filePath, lines.value);
    }
  }

  return ok({
    baseRef: base.spec,
    mergeBaseSha: base.mergeBaseSha,
    changedFiles,
    addedLines: addedByFile,
    renamedFrom,
  });
}

type FindingScope =
  | { readonly kind: 'in'; readonly file: string }
  | { readonly kind: 'out' }
  | { readonly kind: 'unmapped'; readonly reason: string };

/**
 * Exact path match only. A suffix such as `index.ts` must not absorb
 * `src/index.ts`. Paths that do not sit under the repo are unmapped, never dropped.
 */
export function classifyFindingScope(finding: Finding, scope: DiffScope, repoRoot: string): FindingScope {
  if (finding.file.trim() === '') {
    return { kind: 'unmapped', reason: `finding has an empty file path [${finding.rule}] ${finding.message}` };
  }
  const located = locatedRepoPath(finding.file, repoRoot);
  if (located === undefined) {
    return {
      kind: 'unmapped',
      reason: `cannot map finding to a file in the repo: ${finding.file} [${finding.rule}] ${finding.message}`,
    };
  }
  if (!fs.existsSync(located.abs)) {
    return {
      kind: 'unmapped',
      reason: `cannot map finding to a file in the repo: ${finding.file} [${finding.rule}] ${finding.message}`,
    };
  }
  const repoPath = located.repoPath;
  if (!scope.changedFiles.has(repoPath)) {
    return { kind: 'out' };
  }
  if (!Number.isFinite(finding.line) || (finding.endLine !== undefined && !Number.isFinite(finding.endLine))) {
    return {
      kind: 'unmapped',
      reason: `cannot map finding to a line in ${repoPath}: ${finding.file} [${finding.rule}] ${finding.message}`,
    };
  }
  if (finding.line <= 0) {
    return { kind: 'in', file: repoPath };
  }
  const lines = scope.addedLines.get(repoPath);
  if (!lines) {
    // File changed (binary / unknown hunks): keep the finding rather than drop it.
    return { kind: 'in', file: repoPath };
  }
  const end = finding.endLine ?? finding.line;
  for (let line = finding.line; line <= end; line += 1) {
    if (lines.has(line)) {
      return { kind: 'in', file: repoPath };
    }
  }
  return { kind: 'out' };
}

export type PartitionedFindings = {
  readonly inScope: readonly Finding[];
  readonly outOfScope: readonly Finding[];
};

/**
 * Split findings into added-line hits versus everything else. Unmapped paths
 * are a GATE ERROR, never silently dropped or treated as out of scope.
 */
export function partitionFindingsByScope(
  findings: readonly Finding[],
  scope: DiffScope,
  repoRoot: string,
): Result<PartitionedFindings> {
  const inScope: Finding[] = [];
  const outOfScope: Finding[] = [];
  const unmapped: string[] = [];
  for (const finding of findings) {
    const classified = classifyFindingScope(finding, scope, repoRoot);
    if (classified.kind === 'in') {
      inScope.push(finding);
    } else if (classified.kind === 'out') {
      outOfScope.push(finding);
    } else {
      unmapped.push(classified.reason);
    }
  }
  if (unmapped.length > 0) {
    return err(unmapped.join('; '));
  }
  return ok({ inScope, outOfScope });
}

export function filterFindingsToScope(
  findings: readonly Finding[],
  scope: DiffScope,
  repoRoot: string,
): Result<Finding[]> {
  const partitioned = partitionFindingsByScope(findings, scope, repoRoot);
  if (!partitioned.ok) {
    return partitioned;
  }
  return ok([...partitioned.value.inScope]);
}

/**
 * Rewrite absolute paths under `root` to repo-relative paths. Relative paths
 * and paths outside `root` are left as reported. Call this while `root` still
 * exists (the merge-base copy).
 */
export function relativizeFindingFiles(findings: readonly Finding[], root: string): Finding[] {
  return findings.map((finding) => {
    const rel = toRepoPath(finding.file, root);
    if (rel === undefined || rel === finding.file) {
      return finding;
    }
    return { ...finding, file: rel };
  });
}

/**
 * Repo-relative path, then the pre-rename path when this file was moved
 * (`renamedFrom` is new → old). Base findings already sit on the old path.
 */
export function matchFindingFile(finding: Finding, scope: DiffScope, repoRoot: string): string {
  const rel = toRepoPath(finding.file, repoRoot) ?? finding.file;
  return scope.renamedFrom.get(rel) ?? rel;
}

/**
 * Longest new path first so `src/a2.ts` is not rewritten as a prefix of `src/a.ts`.
 */
function rewriteRenamedPaths(text: string, renamedFrom: ReadonlyMap<string, string>): string {
  if (renamedFrom.size === 0) {
    return text;
  }
  const pairs = [...renamedFrom.entries()].sort((left, right) => right[0].length - left[0].length);
  let result = text;
  for (const [from, to] of pairs) {
    result = result.split(from).join(to);
  }
  return result;
}

/**
 * Digit runs that are not part of an identifier, so `foo2` stays distinct from
 * `foo3` while `on line 4 column 10` and `complexity of 15` collapse.
 */
export function stableEslintMessage(message: string): string {
  return message.replace(/\b\d+\b/g, '#');
}

/**
 * Identity for new-vs-base comparison. Line is omitted so an unused helper
 * left on an unchanged line still matches the same symbol at HEAD. File is
 * repo-relative and mapped through git rename. `messageOf` stabilizes tool
 * wording (ESLint digit runs); paths inside the message follow the same rename
 * map so architecture `from -> to` edges still match.
 */
export function matchFindingKey(
  finding: Finding,
  scope: DiffScope,
  repoRoot: string,
  messageOf: (message: string) => string = (message) => message,
): string {
  const file = matchFindingFile(finding, scope, repoRoot);
  const message = messageOf(rewriteRenamedPaths(finding.message, scope.renamedFrom));
  return `${finding.step}\0${file}\0${finding.rule}\0${finding.messageId ?? ''}\0${message}`;
}

/**
 * Findings in `current` with no matching identity in `base`, compared as a
 * multiset: a second identical key is new.
 */
export function findingsNotInBase(
  current: readonly Finding[],
  base: readonly Finding[],
  keyOf: (finding: Finding) => string = (finding) =>
    `${finding.step}\0${finding.file}\0${finding.rule}\0${finding.message}`,
): Finding[] {
  const remaining = new Map<string, number>();
  for (const finding of base) {
    const id = keyOf(finding);
    remaining.set(id, (remaining.get(id) ?? 0) + 1);
  }
  const extra: Finding[] = [];
  for (const finding of current) {
    const id = keyOf(finding);
    const count = remaining.get(id) ?? 0;
    if (count > 0) {
      remaining.set(id, count - 1);
      continue;
    }
    extra.push(finding);
  }
  return extra;
}
