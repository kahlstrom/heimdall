# Set up Heimdall with an AI agent

This file is written for an **AI coding agent** (Grok Bot, Claude Code, Cursor,
Codex, or similar) that has been asked to set Heimdall up for its user. If you
are a person, see the [README](./README.md) instead, or hand this file to your
agent:

```text
Set up Heimdall for my repos by following https://github.com/kahlstrom/heimdall/blob/main/SETUP-WITH-AN-AGENT.md
```

Agent: work through the steps below in order. Ask the user wherever a step
says to ask, and wait for the answer. Use only the options documented in the
[README](./README.md); do not invent config keys, flags, or environment
variables. Unknown config keys are a GATE ERROR.

## Hard rules for the agent

Follow these for the whole setup, even if a step seems to need otherwise:

1. **Change nothing inside the user's project repos without asking first.**
   That includes config files, rule files, `package.json`, lockfiles, and
   `.gitignore`. Reading files is fine.
2. **Never commit Heimdall configs or rule files into a project repo unless the
   user says so.** Some users share repos with other people and want nothing
   Heimdall-related committed there.
3. **Never install Heimdall as a dependency of a project repo.** It is one
   standalone command on the user's PATH that every repo calls. No
   `npm install heimdall`, no `devDependencies` entry.
4. **Never disable checks, loosen the config, edit or delete tests, or add
   flakes to get GREEN** without the user's explicit OK for that specific
   change.
5. **Paste Heimdall's output exactly as it printed.** Do not summarize, reword,
   or trim the `HEIMDALL SUMMARY` block.
6. **On a GATE ERROR, stop and report the full error.** Do not work around it.
7. **Stop any process you start** (for example a test database started for
   `setup`) before you finish.

## What Heimdall is (short version)

- `heimdall` runs from inside a git repo and ends in one of three verdicts:
  **GREEN (exit 0)**, **RED (exit 1)** with `file:line [rule] message`
  findings, or **GATE ERROR (exit 2)** when Heimdall itself or its setup is
  broken.
- It compares the working tree (including uncommitted and untracked files) to
  the merge-base of a base ref and fails only on **new** problems. Secrets and
  jscpd findings are limited to changed files and lines. An ESLint finding
  counts if it is on an added line, or if it is new versus the merge-base
  anywhere. Knip and architecture fail only on findings that are not present
  at the merge-base. Tests and typecheck run in full. Built-in `line-checks`
  look only at added lines.
- Each repo needs a `heimdall.config.json` that lists the commands to run.

## Step 1: Check prerequisites and install

1. Check Node.js and git:

   ```bash
   node --version   # must be v20 or newer
   git --version
   ```

   If Node is older than 20 or git is missing, stop and tell the user. Do not
   upgrade system tools without asking.

2. Check whether Heimdall is already installed:

   ```bash
   command -v heimdall && heimdall --help
   ```

   If it prints the usage text, skip to Step 2.

3. Otherwise install it **globally**, as a standalone command. Ask the user
   which way they prefer; npm is the default:

   ```bash
   npm install -g @kahlstrom/heimdall
   ```

   Or from a clone (useful if they want to read or change Heimdall's code):

   ```bash
   git clone https://github.com/kahlstrom/heimdall.git
   cd heimdall
   npm install
   npm run build
   npm link
   ```

   Either way, `heimdall` ends up on the PATH and nothing is added to any
   project repo. Do not run either command inside a project repo, and never
   run `npm install` without `-g` for Heimdall.

4. Confirm: `heimdall --help` prints the usage text.

## Step 2: Decide which repos and where configs live

Ask the user:

1. **Which repos should Heimdall cover?** Get the absolute path of each git
   repo.
2. **Where should the configs live?** Recommend a **private git repo** of
   configs, with `HEIMDALL_HOME` pointing at a clone of it. Explain why:
   - When the config lives outside the project repo and inside a git repo,
     Heimdall's **config lock** turns RED if any file in that config folder
     has uncommitted changes. That stops an agent from quietly loosening the
     config mid-task. A config folder that is not in a git repo only gets a
     warning.
   - It keeps configs out of the project repos, which matters when those
     repos are shared.

   Do not put real configs in the global npm install's `configs/` folder
   (it is replaced on upgrade) or in a Heimdall clone's `configs/` folder
   (it is gitignored there apart from the example, so the lock does not
   protect it).

   Other options, if the user prefers:
   - `~/.heimdall/<repo-folder>/heimdall.config.json`. This is looked up
     without any environment variable. If `~/.heimdall` is itself a clone of
     the private configs repo, the lock works there too.
   - `<git root>/heimdall.config.json` inside the project repo. Only with the
     user's OK, and only committed if they say so. Changing an in-repo config
     is RED unless `HEIMDALL_ALLOW_CONFIG_CHANGE=1` is set.

3. **Set up the configs repo** (if they chose it). Create the private repo
   only with the user's go-ahead, and let them pick where it is hosted.
   Inside it, make one folder per project repo:

   ```text
   heimdall-configs/
     package.json                # pinned knip + jscpd, once at the home root
     my-app/
       heimdall.config.json
       knip.json                 # sibling, used as $HEIMDALL_CONFIG_DIR/knip.json
       .secretlintrc.json        # required when steps.secrets is enabled
       .dependency-cruiser.cjs   # required when steps.architecture is enabled
     another-repo/
       heimdall.config.json
   ```

   **Folder naming:** Heimdall finds a config by one **git common-dir repo
   name**, tried as-is, then lowercased. A repo at `~/Projects/MyApp` matches
   `MyApp/` or `myapp/`. A linked worktree at `MyApp-feature` still uses
   `MyApp/`. Name each folder after the main checkout (or bare repo, minus
   `.git`), not the worktree folder and not the GitHub name if they differ.

4. **Persist `HEIMDALL_HOME`.** Add it to the user's shell profile (ask
   first, and show the line you will add):

   | Shell | File | Line |
   | --- | --- | --- |
   | zsh (macOS default) | `~/.zshrc` | `export HEIMDALL_HOME="$HOME/path/to/heimdall-configs"` |
   | bash | `~/.bashrc` (and `~/.bash_profile` on macOS) | `export HEIMDALL_HOME="$HOME/path/to/heimdall-configs"` |
   | fish | run once | `set -Ux HEIMDALL_HOME $HOME/path/to/heimdall-configs` |

   Then check in a fresh shell: `echo "$HEIMDALL_HOME"`. Some IDEs and bots
   do not load the shell profile, so `heimdall` may not see the variable when
   they run it. If that happens, tell the user and suggest the `~/.heimdall`
   option above, which needs no variable.

## Step 3: Write a config for each repo

**Install knip and jscpd once in the config home**, not in any project repo.
A central copy leaves the repo's dependencies unchanged, so you do not need
to ask before using knip or jscpd.

Use `$HEIMDALL_HOME` when it is set. Otherwise use `~/.heimdall` (create it
if needed):

```bash
CONFIG_HOME="${HEIMDALL_HOME:-$HOME/.heimdall}"
mkdir -p "$CONFIG_HOME"
cd "$CONFIG_HOME"
```

Write this `package.json` at that home root (exact versions; do not float to
latest):

```json
{
  "private": true,
  "dependencies": {
    "knip": "5.88.1",
    "jscpd": "4.3.0"
  }
}
```

Then install:

```bash
npm install
```

If the config home is a git repo, add `node_modules/` to its `.gitignore`
and commit `package.json` and `package-lock.json` there (with the user's
OK). Do **not** add knip or jscpd to any project repo's `package.json`.

Heimdall does not set `$HEIMDALL_HOME` for step commands. A home config
always sits at `<home>/<repo-folder>/`, so both `$HEIMDALL_HOME` and
`~/.heimdall` use one central-binary form. That command, and the pinned
versions in the `package.json` above, are stated here once; other docs
link here and to
[`configs/example/heimdall.config.json`](./configs/example/heimdall.config.json):

```text
"$HEIMDALL_CONFIG_DIR/../node_modules/.bin/knip" --config "$HEIMDALL_CONFIG_DIR/knip.json" --reporter json --no-progress
```

```text
"$HEIMDALL_CONFIG_DIR/../node_modules/.bin/jscpd" src --reporters json --silent --output "$HEIMDALL_TMP" && cat "$HEIMDALL_TMP/jscpd-report.json"
```

When the Heimdall config is in the project repo (only with the user's OK),
`$HEIMDALL_CONFIG_DIR/../node_modules/.bin` is not the config home. Use the
repo's own install: `npx --no-install knip` and `npx --no-install jscpd`.

For each repo, read (don't change) its `package.json` scripts and existing
tool configs (`tsconfig.json`, `eslint.config.*` or `.eslintrc*`,
`vitest.config.*`, `jest.config.*`, `knip.json`, `.jscpd.json`,
`.secretlintrc.json`, `.dependency-cruiser.cjs`, and the lockfile). Work out
the **real** commands for each Heimdall step:

| Step | Use it only if | Typical command |
| --- | --- | --- |
| `typecheck` | the repo has TypeScript and a `tsconfig.json` | `npx --no-install tsc --noEmit` |
| `tests` | the repo has Vitest or Jest | `npx --no-install vitest run --reporter=json` or `npx --no-install jest --json` |
| `eslint` | the repo has ESLint configured | `npx --no-install eslint . -f json` |
| `knip` | JavaScript or TypeScript | config-home, no repo install: the central command above. In-repo config or repo has knip: `npx --no-install knip --reporter json --no-progress`. Generate the sibling `knip.json` with the loop below. |
| `jscpd` | JavaScript or TypeScript | config-home, no repo install: the central command above. In-repo config or repo has jscpd: `npx --no-install jscpd src --reporters json --silent --output "$HEIMDALL_TMP" && cat "$HEIMDALL_TMP/jscpd-report.json"` |
| `secrets` | the repo has secretlint 14.x | `npx --no-install -p secretlint@14 secretlint --secretlintrc "$HEIMDALL_CONFIG_DIR/.secretlintrc.json" --format json "**/*"` |
| `architecture` | the repo has dependency-cruiser 18.x | `npx --no-install -p dependency-cruiser@18 depcruise --config "$HEIMDALL_CONFIG_DIR/.dependency-cruiser.cjs" src --output-type json` |
| `line-checks` | always available, built in | omit it (no-silencing stays on) or set `true` for the stricter extras. When `secrets` is enabled, new `secretlint-disable` and `gitleaks:allow` comments are flagged too (the finding names the kind only, never the rest of the line). |

Rules for this step:

- **Only include commands the repo can run.** Match the repo's own scripts
  (paths, flags, config files) for typecheck, tests, and eslint. knip and
  jscpd may use the central install in the config home when the repo does
  not have them. Leave out steps that do not apply; a missing step is off.
- Keep `npx --no-install` for tools the repo already has, so a missing
  binary is a GATE ERROR instead of a silent download. The central knip and
  jscpd commands call the config-home binaries directly (no `npx`).
- Use the JSON reporters shown above. Heimdall parses tool output, and
  unparseable output from a failing command is a GATE ERROR.
- **Ask before adding a tool to the repo's own dependencies.** A central
  knip or jscpd install in the config home does not change the repo, so it
  does not need asking. Adding knip, jscpd, secretlint, or
  dependency-cruiser to the project itself still does. Pin secretlint 14.x
  (with `@secretlint/secretlint-rule-preset-recommend` in
  `.secretlintrc.json`) and dependency-cruiser 18.x in the command; do not
  leave `npx` unpinned.
- **Ask which folders to protect.** Anything listed in `protectedPaths`
  (globs such as `"src/generated/**"` or `"migrations/**"`) turns RED if a
  change touches it. Leave it empty if the user has none.
- **Ask whether the tests need setup or teardown**, such as starting a test
  database. Put those commands in `setup` and `teardown`. Setup failure is a
  GATE ERROR; teardown always runs.
- **Ask about the base branch.** By default Heimdall compares against
  `--base` if given, then config `baseRef`, then the branch's upstream when
  it tracks a different branch, otherwise `main`, then `origin/main`. If the
  repo's default branch has another name, set `baseRef` in the config (for
  example `"origin/master"`). Use `--base` only for a one-off run against a
  different base. If the user works in short story branches
  off a feature branch and never wants a silent fallback to `main`, set
  `"requireParentBase": true`.
- Leave `maxChangedFiles` at its default (`100`) unless the user asks.
- Leave `flakes` empty. Only add an entry with the user's explicit OK, as
  `"file > full test title"`.
- When using the central knip binary, always pass
  `--config "$HEIMDALL_CONFIG_DIR/knip.json"` so the merge-base run loads the
  same file. Generate that sibling with the loop below: write `knip.json`
  next to whichever `heimdall.config.json` will be used (in the project repo
  only with the user's OK, per hard rule 1). If the repo already has a knip
  or jscpd config, copy it next to the Heimdall config; still run the knip
  loop on that copy. For `secrets` and `architecture`, keep
  `.secretlintrc.json` and `.dependency-cruiser.cjs` next to the Heimdall
  config the same way. A missing or empty rules file is a GATE ERROR.

### Generate `$HEIMDALL_CONFIG_DIR/knip.json`

Write a working sibling `knip.json` so knip matches how this repo actually
boots. Do it with as little user involvement as you can: classify each
finding yourself.

**Loop** (stop when what is left is real dead code, for at most about 5
rounds):

1. **Write a starter `knip.json`** next to this repo's
   `heimdall.config.json`. Infer it from the repo's `package.json` (`bin`,
   `main`, `exports`, `scripts`, `workspaces`), any `pnpm-workspace.yaml`,
   the framework, entry points, and workspaces. A typical single-package
   TypeScript starter is
   [`configs/example/knip.json`](./configs/example/knip.json).

   For a monorepo, put per-package `entry` and `project` under
   `workspaces` (the root workspace is `"."`). Knip ignores root-level
   `entry` / `project` when `workspaces` is set.

2. **Run the central knip** from the project repo root with `--config`
   pointing at that sibling file. Heimdall is not running here, so
   `$HEIMDALL_CONFIG_DIR` is unset; use the folder that holds this repo's
   `heimdall.config.json`:

   ```bash
   "<folder holding heimdall.config.json>/../node_modules/.bin/knip" --config "<folder holding heimdall.config.json>/knip.json"
   ```

   When the Heimdall config is in-repo, use the repo's own install instead:
   `npx --no-install knip --config "<folder holding heimdall.config.json>/knip.json"`.

3. **Triage each flagged item.** Do not hide anything you have not
   classified.

   | Finding | Action |
   | --- | --- |
   | A real file reported unused that the repo actually uses (config files, scripts, server or worker entries, framework routes) | Add it to `entry`, or to that package's `entry` under `workspaces` |
   | A generated or vendored folder | Add it to `ignore` |
   | A plugin that is misfiring | Disable it with `"<plugin>": false` |
   | Real dead code (unused files, exports, or dependencies that nothing loads) | Leave it reported. List it for the user. Never hide it with `ignore` or extra `entry` rows |

4. **Repeat** from step 2 until the leftover findings are real dead
   code, for at most about 5 rounds. Then stop, keep the sibling
   `knip.json`, and report what is still flagged (the real dead code, plus
   anything you could not classify). Keep a list of every `knip.json`
   addition (each `entry`, `workspaces` row, `ignore` path, and disabled
   plugin) with a one-line reason, plus the count of leftover dead-code
   findings. The Step 6 report needs both.

**Hard rules for this loop:**

- **Never disable knip.** Do not set `steps.knip.enabled` to `false`, drop
  the step, or skip the command to get a clean run.
- **Never ignore real source folders** (for example `"src/**"` or
  `"packages/**"`). `ignore` is only for generated or vendored trees.
- **Never use a blanket ignore** (`"**"`, `"**/*"`, or any `ignore` that
  swallows the project) to get a clean run.
- **Ask the user only about findings you cannot classify.** If you can
  tell it is an entry, generated or vendored, a bad plugin, or dead code,
  act on it without asking.

A minimal config for a TypeScript + Vitest + ESLint repo:

```json
{
  "steps": {
    "typecheck": { "command": "npx --no-install tsc --noEmit" },
    "tests": { "command": "npx --no-install vitest run --reporter=json" },
    "eslint": { "command": "npx --no-install eslint . -f json" }
  },
  "protectedPaths": []
}
```

The full template with every key is
[`configs/example/heimdall.config.json`](./configs/example/heimdall.config.json).
If the configs live in a git repo, **commit each new config there** before
running Heimdall, or the config lock will turn the run RED. Commit to the
configs repo only with the user's OK.

## Step 4: Run Heimdall in each repo

From each repo's root:

```bash
heimdall
```

Then:

- **GREEN:** report it with the summary pasted exactly.
- **RED:** paste the findings and summary exactly, then explain them. Secrets,
  jscpd, and line-checks only count added-line hits. ESLint counts a finding
  on an added line, or one that is new versus the merge-base anywhere. Knip
  and architecture only count findings not present at the merge-base. On a
  branch with no changes those should be quiet. Secrets findings print as
  `file:line [rule]` with no message text. Tests and typecheck run in full, so
  failures that already exist on the base branch will show here. Tell the user
  what is failing and ask what they want to do.
  Do **not** fix code, edit or delete tests, add flakes, disable steps, or
  loosen the config to get GREEN unless the user explicitly OKs that change.
- **GATE ERROR:** stop and report the full error exactly. Common causes are a
  config that was not found (the message lists every path tried), an unknown
  config key, a missing tool (shell exit 127 names the step and
  `steps.<name>.command`, or for setup/teardown the top-level key and the
  failing command), a missing or empty secrets/architecture rules file,
  unparseable tool output, a timeout, a failed setup command, or a base guard
  (`requireParentBase`, or more changed files than `maxChangedFiles`). Suggest
  a fix, but do not apply it without asking.
  Never pass `--allow-wide` or set `HEIMDALL_ALLOW_WIDE=1` or
  `HEIMDALL_ALLOW_CONFIG_CHANGE=1` on your own.

An empty diff against the base prints a WARNING in the summary. That is
expected on a clean branch and is not a failure.

**Prove the setup on a no-change branch.** After the config and sibling
`knip.json` are in place, run `heimdall` from the project root on a
branch with **no changes** versus the base (clean working tree, no
uncommitted or untracked files). Existing knip dead-code findings
(the baseline) do not fail Heimdall: only **new** findings count.
Tests and typecheck still run in full. The empty-diff WARNING above is
expected on this run and is not a failure.

Handle that verdict with the same rules as the rest of Step 4:
**GREEN** proves the setup. **RED**: paste, explain, tell the user what
is failing, and ask what they want to do; do not fix code, tests, or
config without an OK. **GATE ERROR**: stop and report the full error;
do not work around it (hard rule 6). Do not start another "fix the
config or knip.json and re-run" loop here. `knip.json` edits belong
only in the bounded loop above.

## Step 5: Offer the agent rule

The rule tells coding agents to run Heimdall before they call work done. Ask
the user:

1. Which agents they use (Cursor, Claude Code, an `AGENTS.md`-aware agent
   such as Codex, or another bot).
2. Whether the rule should be **global** (applies to every repo, nothing
   committed) or **per repo**.
3. For per-repo rules: **may the file be committed in the project repo?** If
   not, either use the global version, or add the file's path to the repo's
   `.git/info/exclude` so git ignores it without changing `.gitignore`.

Write only the files the user picks.

### Rule text

All versions below use this text:

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

### Cursor

Global: `~/.cursor/rules/heimdall.mdc`. Per repo: `.cursor/rules/heimdall.mdc`
in the repo root.

```markdown
---
description: Run Heimdall before calling any code change done
alwaysApply: true
---

When you finish a story or any code change, run `heimdall` from the repo root
before you say you're done.

- GREEN (exit 0): done. Paste the HEIMDALL SUMMARY block exactly as printed.
- RED (exit 1): fix the listed `file:line [rule] message` problems in the
  code, then run `heimdall` again. Repeat until it's GREEN. Never weaken or
  delete tests, add flakes, or edit the Heimdall config to get green.
- GATE ERROR (exit 2): Heimdall itself broke. Stop and report the full error.
  Don't work around it.
```

If the user's Cursor setup does not pick up rules from `~/.cursor/rules`,
paste the rule text into Cursor's **User Rules** settings instead.

### Claude Code

Global: `~/.claude/CLAUDE.md`. Per repo: `CLAUDE.md` in the repo root. Append
this section (keep anything already in the file):

```markdown
## Heimdall quality gate

When you finish a story or any code change, run `heimdall` from the repo root
before you say you're done.

- GREEN (exit 0): done. Paste the HEIMDALL SUMMARY block exactly as printed.
- RED (exit 1): fix the listed `file:line [rule] message` problems in the
  code, then run `heimdall` again. Repeat until it's GREEN. Never weaken or
  delete tests, add flakes, or edit the Heimdall config to get green.
- GATE ERROR (exit 2): Heimdall itself broke. Stop and report the full error.
  Don't work around it.
```

### AGENTS.md (Codex and other agents that read it)

Per repo: `AGENTS.md` in the repo root. Append the same `## Heimdall quality
gate` section shown for Claude Code. If the agent supports a global
instructions file, the same section can go there instead.

### Any other bot or agent

Add the rule text to the bot's standing instructions, custom instructions, or
memory, wherever it keeps rules that apply to every coding task.

## Step 6: Report back

Finish with one block per repo, then a short list of anything left for the
user to decide. If the no-change Heimdall run in Step 4 was **GREEN**,
Result is `GREEN`. If it was **RED** or **GATE ERROR**, follow that
step's handling (report and ask; do not work around a GATE ERROR) and
finish with `setup not proven: <reason>` — for example a base-branch
test failure, a RED finding, or the GATE ERROR text.

```text
Repo:        /path/to/my-app
Config:      $HEIMDALL_HOME/my-app/heimdall.config.json (committed: yes/no)
Steps:       typecheck, tests, eslint, knip, jscpd, line-checks (knip, jscpd: $HEIMDALL_CONFIG_DIR/../node_modules/.bin)
Protected:   src/generated/** (or: none)
Setup:       none (or: the setup/teardown commands)
Result:      GREEN (no-change branch) (or: setup not proven: tests already fail on the base branch)
Rule:        Cursor global rule (or: CLAUDE.md in repo, not committed; none)
Changes in this repo: none (or: exactly what was changed, with the user's OK)
knip.json additions (each with a one-line reason):
  entry: src/cli.ts — package.json bin
  workspaces["packages/ui"].entry: src/index.ts — package main
  ignore: src/generated/** — codegen output
  "<plugin>": false — plugin misfires on this repo
  (or: none — starter matched the repo)
knip baseline: 12 existing dead-code findings (these do not fail Heimdall; only new findings count)
knip leftover: none (or: the real dead code still reported, listed; never hidden)

<HEIMDALL SUMMARY block pasted exactly>
```

For a RED or GATE ERROR, add the findings or the full error, exactly as
printed, and what you suggest doing next.
