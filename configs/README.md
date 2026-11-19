# Per-repo Heimdall configs

Heimdall looks up a config by one repo name from the git common directory, so a
linked worktree uses the same folder as the main checkout. Keep one folder per
repo next to this file, named after that repo (tried as-is, then lowercased):

```text
configs/
  README.md
  example/                  # copy this
    heimdall.config.json
  my-app/                   # used when you run heimdall inside ~/Projects/my-app
    heimdall.config.json
    knip.json               # optional sibling; referenced as $HEIMDALL_CONFIG_DIR/knip.json
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

Commands use `npx --no-install` so a missing local tool is a **GATE ERROR**
instead of a silent download of an unpinned latest. `$HEIMDALL_TMP` is a
per-run temp directory; `$HEIMDALL_CONFIG_DIR` is the folder that contains the
config file that was used. Older `$GATE_TMP` and `$GATE_CONFIG_DIR` names are
still set as aliases.

Copy the example, then fill in the commands that repo actually uses and disable
steps you do not want with `"enabled": false`. Unknown keys anywhere in the
file are a GATE ERROR.
