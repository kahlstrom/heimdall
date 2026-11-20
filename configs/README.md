# Per-repo Heimdall configs

Heimdall looks up a config by one repo name from the git common directory, so a
linked worktree uses the same folder as the main checkout. Keep one folder per
repo next to this file, named after that repo (tried as-is, then lowercased):

```text
configs/
  README.md
  package.json              # pinned knip + jscpd at the home root (not in a project repo)
  example/                  # copy this
    heimdall.config.json
    knip.json               # sibling; referenced as $HEIMDALL_CONFIG_DIR/knip.json
    .secretlintrc.json      # sibling rules file for steps.secrets
    .dependency-cruiser.cjs # sibling rules file for steps.architecture
  my-app/                   # used when you run heimdall inside ~/Projects/my-app
    heimdall.config.json
    knip.json
    .secretlintrc.json
    .dependency-cruiser.cjs
```

`$HEIMDALL_HOME` defaults to this `configs/` directory (resolved from the CLI
install, not from cwd). Override it to point at any other tree of per-repo
folders.

## Keep real configs in a private git repo

This package ships only `configs/example/`. Do not commit your real project
configs here if you publish or share this tree.

Recommended setup:

1. Create a **private** git repository for your Heimdall configs (one folder
   per target repo, plus any sibling files such as `knip.json` or helper
   scripts).
2. Point `$HEIMDALL_HOME` at a clone of that private repo.
3. Commit every config change **before** running Heimdall.

That last point is what makes the config lock work. When the resolved config
lives outside the target repo and its directory sits inside a git work tree,
Heimdall is **RED** if any file there is staged, unstaged, or untracked. A
human who is editing the config on purpose can set
`HEIMDALL_ALLOW_CONFIG_CHANGE=1`. A loose directory that is not a git repo
only prints a warning, so a private git repo is how you get the lock.

`~/.heimdall/<name>/` is tried after `$HEIMDALL_HOME`, then `~/.gate/<name>/`
for older installs. `gate.config.json` is still read as a deprecated fallback
when `heimdall.config.json` is missing.

## Example file

[`example/heimdall.config.json`](./example/heimdall.config.json) is a complete,
copy-paste-ready template. Every key Heimdall accepts is present except
`baseRef`, which is omitted on purpose so Heimdall resolves the merge-base from
git (upstream parent, then `main`, then `origin/main`).

Commands for tools the repo already has use `npx --no-install` so a missing
local binary is a **GATE ERROR** instead of a silent download of an unpinned
latest. knip and jscpd in the example call the central binaries in
`$HEIMDALL_HOME/node_modules/.bin` (or `$HOME/.heimdall/node_modules/.bin`
when configs live in `~/.heimdall` without `$HEIMDALL_HOME`). `$HEIMDALL_TMP`
is a per-run temp directory; `$HEIMDALL_CONFIG_DIR` is the folder that
contains the config file that was used. Older `$GATE_TMP` and
`$GATE_CONFIG_DIR` names are still set as aliases.

Copy the example, then fill in the commands that repo actually uses and disable
steps you do not want with `"enabled": false`. Unknown keys anywhere in the
file are a GATE ERROR.

## Install knip and jscpd once at the config home root

Do not add knip or jscpd to a project repo. Put a `package.json` at the
Heimdall config home root (`$HEIMDALL_HOME` or `~/.heimdall`) that pins
`knip` `5.88.1` and `jscpd` `4.3.0`, run `npm install` there, and gitignore
`node_modules/`. Point `steps.knip` and `steps.jscpd` at those binaries, as
in [`example/heimdall.config.json`](./example/heimdall.config.json). When the
repo already has knip or jscpd, keep using `npx --no-install` for that tool
instead. Exact install steps are in
[`SETUP-WITH-AN-AGENT.md`](../SETUP-WITH-AN-AGENT.md).

## Pin optional tool versions and keep rules files next to the config

`steps.secrets` and `steps.architecture` are off in the example
(`"enabled": false`). When you turn one on, pin the tool in the command so a
missing binary is a GATE ERROR instead of `npx` fetching an unpinned latest:

- **secrets:** secretlint **14.x**, with `@secretlint/secretlint-rule-preset-recommend`
  in `.secretlintrc.json` (secretlint 14.x ships that preset; keep the rule id
  in the rc file).
- **architecture:** dependency-cruiser **18.x**.

Keep the rules files next to that repo's Heimdall config and point the command
at them with `$HEIMDALL_CONFIG_DIR`:

- `.secretlintrc.json`
- `.dependency-cruiser.cjs`

A missing or empty rules file is a **GATE ERROR**: the tool exits without
JSON findings Heimdall can parse, so the step cannot pass. Do not put personal
paths (`/Users/...`, `/home/...`) in the command; use `$HEIMDALL_CONFIG_DIR`
and `$HEIMDALL_TMP`.
