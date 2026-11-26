# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-26

### Added

- `--base <ref>` to pick the comparison base. Resolution order is `--base`,
  then config `baseRef`, then this branch's tracked upstream when that
  upstream is a different branch, then `main`, then `origin/main`. An
  unresolvable `--base` or `baseRef` is a GATE ERROR (no silent fallback).
  Each run prints where the base came from (`--base`, config, upstream, or
  fallback).
- Optional `steps.secrets` (secretlint). Off unless configured; there is no
  default command. Findings are scoped to added lines. The report prints
  rule id and `file:line` only, never the matched secret. When this step is
  enabled, `line-checks` also flags new `secretlint-disable` comments (any
  form, including `-line` and `-next-line`) and `gitleaks:allow`, naming
  the suppression kind only.
- Optional `steps.architecture` (dependency-cruiser). Off unless configured;
  there is no default command, rules file, or tool path. Fails only on new
  error-severity violations versus the merge-base; warnings are ignored.
  A git rename (`diff -M`) matches the finding in the new path against the
  merge-base under the old path, and architecture messages map each ` -> `
  path segment exactly onto the old path.
- The `HEIMDALL SUMMARY` includes a `head:` line with the full
  `git rev-parse HEAD` sha the gate ran on.
- The agent knip setup guide in
  [SETUP-WITH-AN-AGENT.md](./SETUP-WITH-AN-AGENT.md): a central pinned
  install of knip 5.88.1 and jscpd 4.3.0 in the config home, a `knip.json`
  generation and tuning loop, a no-change GREEN proof run, and a finish
  report. New example files:
  [`configs/example/knip.json`](./configs/example/knip.json),
  [`configs/example/.secretlintrc.json`](./configs/example/.secretlintrc.json),
  and
  [`configs/example/.dependency-cruiser.cjs`](./configs/example/.dependency-cruiser.cjs).

### Changed

- ESLint is compared against the merge-base. A finding counts if it is on
  an added line, or if it is new versus the merge-base anywhere. Matching
  uses rule, optional `messageId`, and the message with digit runs
  normalized (identifier names stay distinct). A git rename matches the
  merge-base under the old path. For `complexity`, `max-depth`,
  `max-lines`, `max-lines-per-function`, `max-nested-callbacks`,
  `max-params`, and `max-statements`, the first number is the measured
  value; same-key leftovers pair against remaining merge-base values
  (highest first). The baseline run happens only when the branch has
  findings off added lines; a baseline failure is a GATE ERROR. The
  merge-base copy resolves the repo's own workspace packages to the base
  copy's source.
- Home-config lookup uses the git common directory, so a worktree of `foo`
  at `foo-feature` still loads `$HEIMDALL_HOME/foo/`.
- A missing step command (shell exit 127) is a GATE ERROR that names the
  step and the config key: `install the tool or fix steps.<name>.command`.
  Merge-base baseline runs use the same message. Setup and teardown use
  the same exit-127 GATE ERROR but name the top-level `setup` /
  `teardown` key and both the failing command and its index.

### Upgrading

A repo that was GREEN on 0.1.0 can go RED under the new ESLint comparison:
errors (and, when `maxWarnings` is set, warnings) on untouched lines now
fail if they are new versus the merge-base. Run `heimdall` after upgrading
to see whether that applies.

## [0.1.0] - 2026-11-18

Initial public release. A shared quality gate that compares the current
tree to a merge-base and fails only on new problems. Built-in steps for
typecheck, tests, ESLint (scoped to added lines), knip, jscpd, and
line-checks (no-silencing). Three verdicts: GREEN (0), RED (1), and
GATE ERROR (2).
