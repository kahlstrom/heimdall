# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Opt-in `--node-heap <mb>` CLI flag and `HEIMDALL_NODE_HEAP_MB` environment
  variable (positive integer in MB; off by default; flag wins over env) to
  append `--max-old-space-size=<mb>` to `NODE_OPTIONS` for `setup`, steps,
  `teardown`, and merge-base reruns. Leaves an existing `NODE_OPTIONS`
  `--max-old-space-size` unchanged with a warning, treats missing, empty,
  non-integer, or non-positive values as a GATE ERROR (exit 2), and prints the
  active `node-heap:` limit in `HEIMDALL SUMMARY`.

## [0.3.1] - 2026-11-28

### Fixed

- Strip ANSI/CSI escape sequences before parsing test-runner and typecheck
  output so colored `FAIL`, summary-count, and `tsc` lines parse identically
  to plain text, and default `NO_COLOR=1` in the environment passed to
  `setup`, step, and `teardown` commands (preserving any existing `NO_COLOR`
  value).
- Attach the trailing 400 characters (prefixed with `...` when truncated)
  instead of the leading 400 characters when GATE ERROR messages include a
  command-output snippet (parse-failure `stderr`, non-zero tool exit without
  parseable findings, and test-runner exit with no parseable failed tests),
  leaving short output unchanged.
- Detect `HEAD` commit or branch changes made during a run (covering `setup`,
  steps, and `teardown`): when another process moves `HEAD` while Heimdall is
  running, exit 2 (`GATE ERROR`) with both commit shas and a rerun message
  while keeping the starting sha in `outcome.headSha` and the summary's
  `head:` line.
- Strip ANSI/VT escape sequences from all captured command `stdout` and
  `stderr` in `runCommand` so color forced by `FORCE_COLOR` or tools that
  ignore `NO_COLOR` never reaches JSON parsers, GATE ERROR snippets, or the
  final report.

## [0.3.0] - 2026-11-27

### Added

- `steps.line-checks.commentPatterns` (default `[]`): array of regex strings
  compiled with no flags (an invalid regex is a GATE ERROR). Flags added
  comment lines (`//`, `/*`, or leading `*`) in JS/TS files (`.ts`, `.tsx`,
  `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts`), including test files, as
  `file:line [comment-pattern] matches /<pattern>/: <trimmed comment>` for the
  first matching pattern. String literals are ignored.
- Top-level `testGlobs` (default `["**/*.test.*", "**/*.spec.*",
  "**/__tests__/**", "**/test/**", "**/tests/**", "**/e2e/**", "**/*.config.*"]`;
  an explicit array replaces the defaults, and `[]` matches nothing) and the
  built-in `test-import` check in `line-checks` (on by default unless
  `line-checks` is disabled). Flags added static `import` / `export ... from`,
  `import = require(...)`, `import('...').Type`, dynamic `import('...')`, and
  `require('...')` specifiers in non-test JS/TS files that target known test
  frameworks (`vitest`, `jest`, `mocha`, `jasmine`, `ava`, `node:test`, `sinon`,
  `chai`, `msw/node`, `@playwright/test`, `cypress`, `@jest/*`,
  `@testing-library/*`, including subpaths) or relative paths resolving to
  files matching `testGlobs`. Opt shared helpers out with
  `steps.line-checks.allowTestImports`.
- Built-in `test-env` check in `line-checks` (on by default unless
  `line-checks` is disabled) and `steps.line-checks.testEnvNames` (default
  `[]`). Flags added test-runner environment checks in non-test JS/TS files
  (dot or string-literal bracket access): `process.env.VITEST`,
  `process.env.JEST_WORKER_ID`, `import.meta.env.VITEST`, `import.meta.vitest`,
  equality/inequality checks (`===`, `!==`, `==`, `!=`) of
  `process.env.NODE_ENV` or `import.meta.env.MODE` against `'test'`, and any
  extra names in `testEnvNames` on `process.env` or `import.meta.env`.
  Comparisons to `'production'` or `'development'` and bare `NODE_ENV` / `MODE`
  reads are not flagged.
- Optional `steps.knip-production` command step (off unless configured). Runs a
  second knip command (for example `knip --production --reporter json
  --no-progress` with `!`-marked production patterns in `knip.json`), parses
  stdout with the knip JSON parser, and fails only on findings new versus the
  merge-base (materialized in `$HEIMDALL_TMP/knip-production-base`, skipped
  when the branch has no findings). `SETUP-WITH-AN-AGENT.md` adds a step for
  `!` production markers, central-binary and in-repo commands, the no-change
  GREEN check, and report fields.

### Fixed

- A `line-checks` suppression finding on a line that also carries a
  secret-scanner comment (`gitleaks:allow` or any `secretlint-disable`
  form) prints only the suppression kind, never the line text, even when
  `steps.secrets` is off. Previously, with secrets off, such a line could
  print in full.

### Upgrading

`test-import` and `test-env` are on by default whenever `line-checks` is
enabled. They flag only added lines in non-test files, so existing code
does not turn RED, but a new branch that imports test code or checks for
a test runner from production code will. Adjust `testGlobs`, or use
`steps.line-checks.allowTestImports` for shared test helpers.

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
