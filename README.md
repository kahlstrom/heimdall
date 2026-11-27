# Heimdall

Heimdall is a shared quality gate. One command, the same three verdicts, every
time a coding agent or a developer is about to call the work done.

It does not re-lint the whole history. It compares the current tree — including
uncommitted and untracked files — to the merge-base of a resolved `baseRef`,
and fails only on **new** problems. Agents cannot silently weaken tests, raise
lint budgets, or park `eslint-disable` comments to make the gate green.

```text
heimdall
```

- **GREEN (exit 0)** — every enabled step passed. The story is done.
- **RED (exit 1)** — new problems in app code. Findings print as
  `file:line [rule] message`. Go fix those; do not edit the gate.
- **GATE ERROR (exit 2)** — Heimdall itself broke (bad config, missing tool,
  crash, timeout, unparseable output). Do **not** blame the app. Fix the
  setup.

Every path ends in one of those three verdicts and a short `HEIMDALL SUMMARY`
block. There is no unlabeled exception and no silent pass.

## Why Heimdall

**Deterministic, not supervised.** A program runs the checks, so an AI agent
can't skip a step, talk its way past one, or declare its own work passing. The
verdict comes from exit codes and parsed tool output, not from what the agent
says. The built-in checks target known shortcuts: silencing lint or type
warnings (no-silencing), editing folders that are off-limits (protected paths),
loosening Heimdall's own config (config lock), comparing against the wrong
base (base guard), and test failures slipping through unnoticed.

**Fewer tokens.** Instead of running each tool and reading pages of output to
judge it, an agent runs one command and reads a short summary. RED findings
come back as `file:line [rule] message` lines. Reviewers, human or AI, don't
need to re-run the tests, so review time goes to design and code quality.

**Honest limits.** Heimdall makes cheating harder, not impossible. It can't
tell whether your tests are meaningful in the first place. An agent could also
skip running it and claim it passed, so ask agents to paste the
`HEIMDALL SUMMARY` block exactly as printed, or have your orchestrator run
`heimdall` itself. It complements code review; it doesn't replace it.

## Set up with your AI agent

The quickest setup is to let your coding agent (Grok Bot, Claude Code, Cursor,
Codex, or similar) do it. Send it this:

```text
Set up Heimdall for my repos by following https://github.com/kahlstrom/heimdall/blob/main/SETUP-WITH-AN-AGENT.md
```

[`SETUP-WITH-AN-AGENT.md`](./SETUP-WITH-AN-AGENT.md) walks the agent through
installing Heimdall, choosing where your configs live, writing a config for
each repo from the commands it really has, a first run, and adding the agent
rule. It asks before changing anything in your project repos.

## Why the name

In Norse myth, Heimdall watches the Bifröst and never sleeps. This tool watches
the quality gate with the same job: nothing crosses into “done” without being
seen.

## Requirements

- **Node.js 20+**
- **git** (Heimdall runs inside a git repo and diffs against a merge-base)

Optional tools are invoked only when the matching step is enabled in config.
typecheck, tests, eslint, secrets, and architecture must already be installed
locally; example commands use `npx --no-install` so a missing binary is a
GATE ERROR instead of a download. knip and jscpd may instead be one pinned
install in the Heimdall config home (`$HEIMDALL_HOME` or `~/.heimdall`), so
project repos do not need those dependencies:

| Tool | Used for |
| --- | --- |
| TypeScript (`tsc`) | `steps.typecheck` |
| Vitest (or Jest) | `steps.tests` |
| ESLint | `steps.eslint` |
| knip | `steps.knip` (unused files, exports, deps), `steps.knip-production` (optional; production-only unused code) |
| jscpd | `steps.jscpd` (copy-paste) |
| secretlint | `steps.secrets` (optional; off unless configured) |
| dependency-cruiser | `steps.architecture` (optional; off unless configured) |

`line-checks` is built in and needs no extra binary.

## Install

Heimdall installs once, globally, as a standalone `heimdall` command on your
PATH. Every repo you check calls that same command. It is **not** a library
and is never added as a dependency of your project repos, so always use `-g`
(or the clone-and-link route below), and do not run either inside a project
repo.

```bash
npm install -g @kahlstrom/heimdall
```

Or from a clone:

```bash
git clone https://github.com/kahlstrom/heimdall.git
cd heimdall
npm install
npm run build
npm link
```

`prepare` also runs `tsc`, so `npm install` in this repo produces `dist/`.
After `npm link`, `heimdall` is on your PATH. To unlink later:
`npm unlink -g @kahlstrom/heimdall`.

## Upgrading from 0.1.0

**ESLint can turn a previously GREEN repo RED.** In 0.1.0, only findings on
added lines counted. In 0.2.0, a finding on an untouched line also fails the
step if it is new versus the merge-base (for example an import left unused
after its last use is deleted). Errors always count this way; warnings do
when `maxWarnings` is set. Run `heimdall` once after upgrading to see whether
that applies.

Full notes for 0.2.0 are in [CHANGELOG.md](./CHANGELOG.md).

## Getting started

1. Copy [`configs/example/heimdall.config.json`](./configs/example/heimdall.config.json)
   to one of:
   - `<git root>/heimdall.config.json` (in the repo you are checking), or
   - `$HEIMDALL_HOME/<name>/heimdall.config.json` (default `$HEIMDALL_HOME`
     is this CLI's `configs/` folder; `<name>` is the git common-dir repo
     name, so a worktree uses the main checkout's config), or
   - a folder in a **private** git repo, with `HEIMDALL_HOME` pointing at that
     clone (recommended so the config lock works; see
     [`configs/README.md`](./configs/README.md)).
2. Fill in the commands that repo actually uses. Disable steps with
   `"enabled": false`. Reference sibling files as `$HEIMDALL_CONFIG_DIR/...`.
3. From inside the target git repo:

```bash
heimdall
```

Red means fix the listed `file:line [rule] message` findings. Green means the
story is done.

## Config lookup order

With no `--config`:

1. `<git root>/heimdall.config.json`
2. `<git root>/gate.config.json` (deprecated; one-line warning)
3. `$HEIMDALL_HOME/<name>/heimdall.config.json`, then
   `$HEIMDALL_HOME/<name>/gate.config.json`
4. `~/.heimdall/<name>/` (same two filenames)
5. `~/.gate/<name>/` (deprecated home folder; same two filenames)

`$HEIMDALL_HOME` defaults to this CLI's `configs/` folder, resolved from the
install location (`dist/` or `src/`), not from cwd. `$GATE_HOME` is still
honoured as a deprecated alias. `<name>` is one repo name from the git
common directory (`git rev-parse --path-format=absolute --git-common-dir`),
tried as-is and then lowercased (`~/Projects/MyApp` finds
`$HEIMDALL_HOME/myapp`):

- basename `.git` → parent folder name (normal checkout or linked worktree)
- basename ends in `.git` → that suffix is dropped (bare repo)
- anything else (submodule `.git/modules/<x>`, custom `GIT_DIR`) → the
  work-tree folder name (`--show-toplevel`)

The work-tree folder basename is not a separate lookup candidate, so
`heimdall` inside a worktree of `foo` at `foo-feature` still loads
`$HEIMDALL_HOME/foo/`.

`--config` is exclusive: only that path is used. A missing, invalid, or
unknown-key config is a **GATE ERROR**, not red. The summary prints which
config file was used.

## Config reference

A config file is required. Unknown keys anywhere are a GATE ERROR. Types and
defaults below are exactly what `src/config.ts` accepts.

### Top-level keys

| Key | Type | Default | Example |
| --- | --- | --- | --- |
| `baseRef` | string (non-empty when set) | `--base` if given, else this value if set, else this branch's tracked upstream **only when that upstream is a different branch**, otherwise `main`, then `origin/main`. A branch that tracks its own remote (`origin/<same name>`) is never used as the base, so a push cannot shrink the diff to unpushed commits. An explicit `--base` or `baseRef` that does not resolve is a GATE ERROR (no silent fallback). | `"origin/main"` |
| `requireParentBase` | boolean | `false` | `true` |
| `maxChangedFiles` | positive integer | `100` | `50` |
| `steps` | object | `{}` | see below |
| `flakes` | array of non-empty strings | `[]` | `["src/bill.test.ts > billing > times out talking to billing"]` |
| `setup` | array of non-empty strings | `[]` | `["docker compose up -d db"]` |
| `teardown` | array of non-empty strings | `[]` | `["docker compose down"]` |
| `protectedPaths` | array of non-empty glob strings | `[]` (check off) | `["src/generated/**", "vendor/**"]` |
| `testGlobs` | array of non-empty glob strings | `["**/*.test.*", "**/*.spec.*", "**/__tests__/**", "**/test/**", "**/tests/**", "**/e2e/**", "**/*.config.*"]` | `["**/*.test.*", "src/fixtures/**"]` |

`requireParentBase`: when `true` and neither `--base` nor `baseRef` is set, a
resolved base of `main` or `origin/main`, or no upstream at all, is a **GATE
ERROR** (exit 2) before setup or steps. The message says the base resolved to
main (or that no upstream is set) and tells you to point the branch at its
feature parent, for example `git branch --set-upstream-to=origin/FEATURE`.
Repos that branch off main on purpose leave this off.

`maxChangedFiles`: after the diff is computed (including untracked files
Heimdall counts), a count above this limit is a **GATE ERROR** naming the
count, the limit, and the base. `--allow-wide` or `HEIMDALL_ALLOW_WIDE=1`
prints a warning and continues. `GATE_ALLOW_WIDE=1` is a deprecated alias.

`flakes`: each entry is `file > full title` (suite path included), never a
whole file and never a bare leaf name. Only that exact test in that file is
ignored.

`setup` / `teardown`: command lists (for example start/stop a disposable
database). Setup failure is a GATE ERROR. Teardown always runs after setup is
attempted. Setup/teardown use the same default timeout as steps (`300000` ms).
A missing setup/teardown command (shell exit 127) names the top-level key and
the failing command and its index, not `steps.setup.command`.

`testGlobs`: repo-relative globs that identify test and config files for the
built-in `test-import` and `test-env` checks. When omitted, Heimdall uses the
default list above. An explicit array replaces the defaults; `[]` matches no
files.

At least one step must be enabled.

Every run prints the resolved **base** and where it came from (`--base`,
config, upstream, or fallback), the merge-base **short sha**, and the
**changed-file count** before setup and steps. The final `HEIMDALL SUMMARY`
still includes the `base:` line and a `head:` line with the full sha the gate
ran on.

### `steps.<name>` command steps

Allowed names: `typecheck`, `tests`, `eslint`, `knip`, `knip-production`,
`jscpd`, `secrets`, `architecture`. A missing step is off. A present step is on
unless `"enabled": false`.

| Key | Type | Default | Example |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` when the step object is present | `false` |
| `command` | non-empty string | required when enabled | `"npx --no-install vitest run --reporter=json"` |
| `timeoutMs` | positive integer | `300000` (5 minutes) | `120000` |

A timeout is a GATE ERROR that names the step and the budget. A missing
command (shell exit 127) is a GATE ERROR that names the step and the config
key: `install the tool or fix steps.<name>.command`. Merge-base baseline runs
use the same message. Setup and teardown use the same exit-127 GATE ERROR but
name the top-level `setup` / `teardown` key and both the failing command and
its index.

| Step | Command notes |
| --- | --- |
| `tests` | Always runs in full. Prefer a JSON reporter (`vitest --reporter=json`, `jest --json`) so failures are not scraped from text. |
| `typecheck` | Full typecheck (`tsc --noEmit` or equivalent). |
| `eslint` | Prefer `-f json` so findings can be scoped. Extra key: `maxWarnings`. A finding counts if it is on an added line, or if it is new versus the merge-base anywhere. Matching uses rule, optional `messageId`, and the message with digit runs normalized (identifier names stay distinct). A renamed file matches the merge-base under the old path. The baseline run happens only when the branch has findings off added lines; a baseline failure is a GATE ERROR. |
| `knip` | Prefer `--reporter json`. For a home config with no knip, use the central command in [`configs/example/heimdall.config.json`](./configs/example/heimdall.config.json). For an in-repo config, see [SETUP-WITH-AN-AGENT.md](./SETUP-WITH-AN-AGENT.md#step-3-write-a-config-for-each-repo) Step 3. |
| `knip-production` | Optional (off unless configured). Prefer `--production --reporter json --no-progress` with `!` production markers in `knip.json` to catch code reachable only from tests. Uses the same knip JSON parser and merge-base comparison as `knip`. See [`configs/example/heimdall.config.json`](./configs/example/heimdall.config.json) and [SETUP-WITH-AN-AGENT.md](./SETUP-WITH-AN-AGENT.md#step-3-write-a-config-for-each-repo) Step 3. |
| `jscpd` | Must print JSON on stdout. `$HEIMDALL_TMP` is a per-run temp dir. For a home config with no jscpd, use the central command in that same example. For an in-repo config, see that same SETUP Step 3. |
| `secrets` | Prefer secretlint 14.x `--format json`. No default command. Findings are scoped to added lines; the report prints rule id and `file:line` only, never the matched secret. |
| `architecture` | Prefer dependency-cruiser 18.x `--output-type json`. No default command, rules file, or tool path. Fails only on new error-severity violations versus the merge-base; warnings are ignored. |

#### `steps.eslint.maxWarnings`

| Key | Type | Default | Example |
| --- | --- | --- | --- |
| `maxWarnings` | non-negative integer | unset (warnings ignored) | `0` |

When set, ESLint warnings (severity 1) count if they are on an added line, or
if they are new versus the merge-base anywhere; more than this many is **RED**
(`file:line [rule] message`). The baseline run happens only when the branch
has findings off added lines; a baseline failure is a GATE ERROR. Errors still
fail the step. An invalid value is a GATE ERROR.

### `steps.line-checks`

Built-in. No command.

| Form | Meaning |
| --- | --- |
| omitted | **no-silencing**, **test-import**, and **test-env** still run (on by default) |
| `true` | extras on (as-cast, non-null, …) plus the default checks (`no-silencing`, `test-import`, `test-env`) |
| `false` / `{ "enabled": false }` | whole step off |
| `{ "enabled": true, "allowSilencing": ["src/generated/**"] }` | extras on; matching globs skip no-silencing |

| Key | Type | Default | Example |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` if the object is present without `enabled: false` | `true` |
| `allowSilencing` | array of non-empty glob strings | `[]` | `["src/generated/**"]` |
| `allowTestImports` | array of non-empty glob strings | `[]` | `["src/test-utils/**"]` |
| `commentPatterns` | array of non-empty regex strings (compiled with no flags; invalid regex is a GATE ERROR) | `[]` (check off) | `["\\bPhase \\d+\\b", "\\b(?:JIRA|ABC)-\\d+\\b"]` |
| `testEnvNames` | array of non-empty strings | `[]` | `["PLAYWRIGHT_TEST", "E2E_MODE"]` |

### New problems only

Secrets and jscpd findings are limited to **files and lines changed versus the
merge-base of `baseRef`**, including uncommitted and untracked files. An ESLint
finding counts if it is on an added line, or if it is **new versus the
merge-base** anywhere (an import left unused after its last use is deleted is
caught; a pre-existing error in untouched code is not). That baseline run
happens only when the branch has eslint findings that are not on added lines,
so ESLint may run twice and a repo with a slow ESLint step pays that time. A
baseline failure is a GATE ERROR, not a pass. Knip (`knip` and
`knip-production`) and architecture run on the **whole project** and fail only
on findings that are **not present at the merge-base** (a helper left unused
after its last caller is deleted is caught; old dead code in untouched areas is
not). If the merge-base knip or architecture result cannot be computed, that is
a GATE ERROR, not a pass. New-versus-base matching for knip, architecture, and
eslint uses **file, rule, and message** (not line) and counts duplicates: a
second identical finding is new if the merge-base only has one. A git rename
(`diff -M`) matches the finding in the new path against the merge-base under the old path. Architecture
messages map each ` -> ` path segment exactly onto the old path. ESLint messages
drop standalone digit runs so `no-shadow` line/column text still matches after
line drift; identifier names such as `foo2` stay distinct. For `complexity`,
`max-depth`, `max-lines`, `max-lines-per-function`, `max-nested-callbacks`,
`max-params`, and `max-statements` the first number is the measured value.
Same-key leftovers pair against remaining merge-base values (highest first):
a leftover is new when it has no distinct base finding whose value is at
least as high. Other rules, including remaining core `max-*` rules and plugin
rules such as `@typescript-eslint/max-params`, match by digit-stripped message
only, so a worse value there is not caught. Tests and
typecheck run in full. `line-checks` only looks at added lines. An empty
diff against the resolved base prints a **WARNING** in the summary naming
that base.

## Built-in checks

### no-silencing

On by default for added lines in `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, and
`.cjs` files (not `.mts` / `.cts`). Each hit prints
`file:line [no-silencing] message`. It flags:

- Bare `void identifier;` statements used to silence unused warnings. Not
  `void foo()`, `void promise.then(...)`, or `const x = void 0`.
- New `eslint-disable`, `eslint-disable-next-line`, `@ts-ignore`,
  `@ts-expect-error`, or `@ts-nocheck` comments.
- When `steps.secrets` is enabled, new `secretlint-disable` comments (any
  form, including `-line` and `-next-line`) and `gitleaks:allow`. The finding
  names the suppression kind only — never the rest of the line, which may
  hold a secret.
- Newly added names that start with `_` to dodge unused warnings, specifically:
  function / method / arrow / constructor **parameters**; `const` / `let` /
  `var` identifiers; `function _name` declarations; `catch (_e)`; array
  destructuring bindings; object destructuring *renames* (`{ used: _unused }`).
  Not flagged: object shorthand (`{ _id }`, a real property), class members
  (`_private` convention), import bindings (`import _ from 'lodash'`), object
  literal keys, or type parameters.

Opt a generated path out with `steps.line-checks.allowSilencing`.
`"enabled": false` turns off `line-checks` (no-silencing, the rules below, and
the extras).

When `"enabled": true` (or `true`), also flag rule-gaming extras:

- `as` casts (not `as const` or `import { x as y }`)
- postfix non-null `!`
- the same suppression comments (rule `suppression`)
- any `void …;` statement (including `void foo()`)
- underscore-prefixed parameters (`_unused`)

### comment-pattern

Off unless `steps.line-checks.commentPatterns` is non-empty. Scans added
comment lines (`//`, `/*`, or leading `*`) in JS/TS files (`.ts`, `.tsx`,
`.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts`), including test files, ignoring
comment-like text inside string literals. Each hit prints
`file:line [comment-pattern] matches /<pattern>/: <trimmed comment>` for the
first matching pattern on that line. Patterns are compiled with no regex flags;
an invalid regex in config is a GATE ERROR.

### test-import

On by default for added lines in non-test JS/TS files (`.ts`, `.tsx`, `.js`,
`.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts` not matching `testGlobs`). Each hit
prints `file:line [test-import] ...`. It flags added static `import` /
`export ... from`, `import = require(...)`, `import('...').Type`, dynamic
`import('...')`, and `require('...')` specifiers that target:

- Known test-framework packages (including subpaths): `vitest`, `jest`,
  `mocha`, `jasmine`, `ava`, `node:test`, `sinon`, `chai`, `msw/node`,
  `@playwright/test`, `cypress`, and scopes `@jest/*` and `@testing-library/*`.
- Relative paths whose resolved repo-relative file matches `testGlobs`.

Opt shared test-helper folders out with `steps.line-checks.allowTestImports`,
or adjust which paths count as tests with top-level `testGlobs`.

### test-env

On by default for added lines in non-test JS/TS files (same extensions and
`testGlobs` exclusion as `test-import`). Each hit prints
`file:line [test-env] <expression>`. It flags added test-runner environment
checks (dot or string-literal bracket access):

- `process.env.VITEST`, `process.env.JEST_WORKER_ID`,
  `import.meta.env.VITEST`, and `import.meta.vitest`.
- Equality/inequality checks (`===`, `!==`, `==`, `!=`, either operand order)
  of `process.env.NODE_ENV` or `import.meta.env.MODE` against `'test'`.
- Any extra names listed in `steps.line-checks.testEnvNames` on `process.env`
  or `import.meta.env`.

Comparisons to `'production'` or `'development'` and bare reads of `NODE_ENV`
or `MODE` are not flagged.

### Protected paths

`protectedPaths` globs. Any added, changed, deleted, or renamed path in the
diff that matches is **RED**: `path [protected-path] this path is off-limits`.
Absent or empty means off.

### Config lock

Changing an in-repo `heimdall.config.json` (or `gate.config.json`, or an
in-repo `--config` file) is **RED** unless `HEIMDALL_ALLOW_CONFIG_CHANGE=1` is
set (`GATE_ALLOW_CONFIG_CHANGE=1` still works as a deprecated alias).

When the resolved config lives **outside** the target repo (`$HEIMDALL_HOME`,
this CLI's `configs/` folder, `~/.heimdall`, `~/.gate`, or an external
`--config`):

- If that config directory sits inside a git repo and any file there
  (`heimdall.config.json` and every sibling, such as `knip.json` or helper
  scripts) has uncommitted changes — staged, unstaged, or untracked — Heimdall
  is **RED**: `path [config-uncommitted] commit this config change first`.
  `HEIMDALL_ALLOW_CONFIG_CHANGE=1` overrides this, same as the in-repo guard.
- If the config directory is not inside a git repo (for example a loose
  `~/.heimdall`), the summary prints a **WARNING** that the config is not
  version-controlled, but the run does not fail.
- When the containing git repo has a HEAD, the summary prints that commit hash
  next to the config path.

This is why real configs belong in your own private git repo pointed to by
`HEIMDALL_HOME`.

### Base guard

See `requireParentBase` and `maxChangedFiles` above. Both run after the diff is
known and before setup/steps, so a story that silently compares a whole feature
against `main`, or feeds hundreds of files to ESLint, becomes a GATE ERROR
instead of a surprise RED.

## CLI flags

```text
heimdall [--config <path>] [--cwd <path>] [--base <ref>] [--allow-wide]
```

| Flag | Meaning |
| --- | --- |
| `--config <path>` | Use this config file only. Relative paths resolve from `--cwd` / the current directory. |
| `--cwd <path>` | Repo to check (default: current directory). Heimdall finds the git root from here. |
| `--base <ref>` | Comparison base. Overrides config `baseRef`. A ref that does not resolve is a GATE ERROR. |
| `--allow-wide` | Continue when the diff exceeds `maxChangedFiles` (same as `HEIMDALL_ALLOW_WIDE=1`). |
| `-h`, `--help` | Print help and exit 0. |

Unknown flags are a GATE ERROR.

## Environment variables

| Variable | Role |
| --- | --- |
| `HEIMDALL_HOME` | Per-repo config tree. Default: this CLI's `configs/` folder. |
| `GATE_HOME` | Deprecated alias of `HEIMDALL_HOME`. |
| `HEIMDALL_CONFIG_DIR` | Set by Heimdall for every command: the folder of the config file that was used. |
| `GATE_CONFIG_DIR` | Deprecated alias; still set so older commands keep working. |
| `HEIMDALL_TMP` | Set by Heimdall: per-run temp directory (deleted afterwards). |
| `GATE_TMP` | Deprecated alias; still set. |
| `HEIMDALL_ALLOW_CONFIG_CHANGE` | `=1` skips the in-repo config-change RED and the outside-repo uncommitted-config RED. |
| `GATE_ALLOW_CONFIG_CHANGE` | Deprecated alias. |
| `HEIMDALL_ALLOW_WIDE` | `=1` continues when the diff exceeds `maxChangedFiles`. |
| `GATE_ALLOW_WIDE` | Deprecated alias. |

Using a `GATE_*` name without the matching `HEIMDALL_*` name prints a one-line
deprecation warning. Using `gate.config.json` instead of
`heimdall.config.json` does the same.

`$HEIMDALL_CONFIG_DIR` is the folder that holds the config file that was used
(in-repo or under `$HEIMDALL_HOME`), including on knip's merge-base run, so a
command can load a sibling file. When the repo has no knip or jscpd, the
central-binary command and pinned versions are in
[SETUP-WITH-AN-AGENT.md](./SETUP-WITH-AN-AGENT.md#step-3-write-a-config-for-each-repo)
and [`configs/example/heimdall.config.json`](./configs/example/heimdall.config.json).
When the repo already has knip:

```text
npx --no-install knip --config "$HEIMDALL_CONFIG_DIR/knip.json" --reporter json --no-progress
```

When the repo already has jscpd:

```text
npx --no-install jscpd src --reporters json --silent --output "$HEIMDALL_TMP" && cat "$HEIMDALL_TMP/jscpd-report.json"
```

Example secrets and architecture commands (both off unless enabled; pin the
tool versions in the command, and keep the rules files next to the config).
secretlint 14.x reads `@secretlint/secretlint-rule-preset-recommend` from
`.secretlintrc.json`; there is no separate v14 preset package:

```text
npx --no-install -p secretlint@14 secretlint --secretlintrc "$HEIMDALL_CONFIG_DIR/.secretlintrc.json" --format json "**/*"
npx --no-install -p dependency-cruiser@18 depcruise --config "$HEIMDALL_CONFIG_DIR/.dependency-cruiser.cjs" src --output-type json
```

## Tool output

Heimdall parses tool output. It does not invent findings from a non-zero exit
alone (except tests, which are red when they fail and the failure can be
parsed). A runner crash with no parseable output is a **GATE ERROR**.

- **eslint:** JSON formatter (`-f json`)
- **knip / knip-production:** JSON reporter `{ "files": [...unused files], "issues": [...] }` including
  unused deps/devDeps, unlisted, unresolved, binaries, exports, types, enum/class
  members, and duplicates.
- **secrets:** secretlint `--format json` (14.x), an ESLint-like
  `{ filePath, messages: [{ ruleId, loc.start.line }] }[]`. Each finding prints
  as `file:line [rule]` with no message text. Unparseable output is a GATE
  ERROR that names the parser reason and the exit code. A non-zero exit with
  no findings is a GATE ERROR that names the command and the exit code.
  Neither includes tool stdout or stderr, which may hold a secret.
- **architecture:** dependency-cruiser `--output-type json` (18.x)
  `{ "summary": { "violations": [{ "from", "to", "rule": { "name", "severity" }, "cycle"? }] } }`.
  Only `severity: "error"` counts. Each finding is `[rule] from -> to`, or the
  cycle path for circular violations.
- **jscpd:** `{ "duplicates": [...] }`
- **typecheck:** `file(line,col): error TSxxxx:` or `file:line:col - error TSxxxx:`
- **tests:** vitest/jest JSON reporter (`--reporter=json` / `--json`, the
  `testResults` object) when present on stdout, else vitest
  `FAIL file > suite > title` and jest `● suite › title`. A flake matches only
  `file > full title`. File-load failures, failing hooks, unhandled errors, and
  any other failure with no `FAIL file > title` line cannot be flakes: if the
  runner exits non-zero, those keep the tests step **RED**.

If a command fails and the output cannot be parsed, that is a **GATE ERROR**.
A missing command (shell exit 127) is a GATE ERROR that names the step and
`steps.<name>.command`, or for setup/teardown the top-level key and both
the failing command and its index. A step that times out, is killed by a
signal, or exits with a null code is never a pass: it is a GATE ERROR and
the signal is named.
On timeout Heimdall SIGTERMs the step's process group, then SIGKILLs after a
short grace so child processes cannot linger. SIGINT or SIGTERM on Heimdall
itself kills the running step tree, runs teardown, and exits non-zero.

Knip's JSON reporter is parsed from stdout. The step materializes the merge-base
in `$HEIMDALL_TMP/knip-base` (or `$HEIMDALL_TMP/knip-production-base` for
`knip-production`; no stash) and runs the same command there.
Architecture does the same in `$HEIMDALL_TMP/architecture-base` and skips that
baseline run when the branch has no error-severity violations. ESLint uses
`$HEIMDALL_TMP/eslint-base` the same way, and skips that run when every finding
is already on an added line. The merge-base copy resolves the repo's own
workspace packages to the base copy's source; third-party packages are shared
from the live install.

## Sample output

```text
base: main (fallback)
merge-base: a1b2c3d
changed files: 3

src/app.ts:12 [eqeqeq] Expected '===' and instead saw '=='.

──────── HEIMDALL SUMMARY ────────
result:   RED
exit:     1
config:   /Users/me/dev/my-app/heimdall.config.json
base:     main
head:     b2c3d4e5f6789012345678901234567890abcdef
commit:   a1b2c3d4e5f6789012345678901234567890abcd
scope:    3 files, 40 added lines
eslint       FAIL  (1)
tests        pass
line-checks  pass
findings: 1
──────────────────────────────────
```

Green looks the same without findings, with `result: GREEN` and `exit: 0`.
A GATE ERROR prints `GATE ERROR: <reason>` above the summary and
`result: GATE ERROR` / `exit: 2`.

## Using Heimdall with agents

Heimdall is built to be the last thing a coding agent runs before it says a
change is done. Give your agents this rule, so a RED or GATE ERROR can't be
quietly skipped:

```text
When you finish a story or any code change, run `heimdall` from the repo root
before you say you're done.

- GREEN (exit 0): done. Paste the HEIMDALL SUMMARY block exactly as printed.
- RED (exit 1): fix the listed `file:line [rule] message` problems in the
  code, then run `heimdall` again. Repeat until it's GREEN. Never weaken or
  delete tests, add flakes, or edit the Heimdall config to get green.
- GATE ERROR (exit 2): Heimdall itself broke. Stop and report the full error.
  Don't work around it.
```

Where to put it:

| Agent | Global (nothing committed) | Per repo |
| --- | --- | --- |
| Cursor | `~/.cursor/rules/heimdall.mdc` with `alwaysApply: true` frontmatter, or Cursor's User Rules | `.cursor/rules/heimdall.mdc` |
| Claude Code | `~/.claude/CLAUDE.md` | `CLAUDE.md` |
| Codex and other `AGENTS.md` readers | the agent's global instructions, if it has them | `AGENTS.md` |
| Other bots | the bot's standing instructions or memory | — |

Ready-to-paste versions of each are in
[`SETUP-WITH-AN-AGENT.md`](./SETUP-WITH-AN-AGENT.md#step-5-offer-the-agent-rule).
If you share a repo with others and don't want a rule file committed, use the
global version, or list the per-repo file in `.git/info/exclude`.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | GREEN — every enabled step passed |
| 1 | RED — new problems in app code. Findings print as `file:line [rule] message` |
| 2 | GATE ERROR — bad config, missing tool, crash, timeout, unparseable output, setup/teardown failure |

## Contributing

```bash
npm install
npm test
npm run test:coverage
npm run build
```

The exact test command is **`npm test`** (`vitest run`). `npm run typecheck`
typechecks `src`, `test`, and `vitest.config.ts` via `tsconfig.json`. Tests
use temp git repos under the system temp directory and delete them afterwards.
Tests set `$HEIMDALL_HOME` to a temp directory and never touch the real
`~/.heimdall` or `~/.gate`. Outside-repo config lock tests use a temp git repo
as `$HEIMDALL_HOME`. Config-lookup tests create linked worktrees, bare-repo
worktrees, and submodules under the system temp directory and delete them
afterwards. The default `$HEIMDALL_HOME` (this repo's `configs/`) is asserted
only as a listed lookup path.

This repo pins `eslint`, `knip`, `jscpd`, `vitest`, and `typescript` to exact
versions. Licensed under MIT.
