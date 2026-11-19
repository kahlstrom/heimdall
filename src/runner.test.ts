import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_DIR_ENV, DEPRECATED_CONFIG_WARNING, LEGACY_CONFIG_DIR_ENV, TMP_ENV, LEGACY_TMP_ENV } from './config.js';
import { formatFinding, formatReport } from './report.js';
import { runGate } from './runner.js';
import {
  commandResult as result,
  failFindings,
  withProcessEnv,
  withTempGateHome,
  writeHomeGateConfig,
} from '../test/helpers/gate-test.js';
import { isProcessAlive, nodeCommand, waitForFile } from '../test/helpers/process.js';
import { addWorktree, commitAll, git, withTempRepo, writeRepoFile } from '../test/helpers/temp-repo.js';

const PASSING_TESTS_CONFIG = { steps: { tests: { command: 'npm test' } } };

function writeGateConfig(repo: string, raw: unknown, rel = 'heimdall.config.json'): void {
  writeRepoFile(repo, rel, `${JSON.stringify(raw)}\n`);
}

async function seededRepo(
  fn: (repo: string) => Promise<void>,
  gateConfig: unknown | null = PASSING_TESTS_CONFIG,
): Promise<void> {
  await withTempRepo(async (repo) => {
    writeRepoFile(repo, 'src/legacy.ts', 'const leftover = 1;\n');
    if (gateConfig !== null) {
      writeGateConfig(repo, gateConfig);
    }
    commitAll(repo, 'base');
    git(repo, ['checkout', '-q', '-b', 'feat']);
    writeRepoFile(repo, 'src/new.ts', 'export const value = 1;\n');
    commitAll(repo, 'feat');
    await fn(repo);
  });
}

function mockPass() {
  return { runCommand: async () => result({ exitCode: 0, stdout: 'ok\n' }) };
}

const PROTECTED_SECRET_CONFIG = {
  steps: { tests: { command: 'npm test' } },
  protectedPaths: ['src/secret.ts'],
};

async function featFile(
  config: unknown,
  rel: string,
  contents: string,
  fn: (repo: string) => Promise<void>,
): Promise<void> {
  await withTempRepo(async (repo) => {
    writeGateConfig(repo, config);
    commitAll(repo, 'base');
    git(repo, ['checkout', '-q', '-b', 'feat']);
    writeRepoFile(repo, rel, contents);
    commitAll(repo, 'feat');
    await fn(repo);
  });
}

async function withProtectedSecretRepo(
  afterFeat: (repo: string) => void,
  fn: (repo: string) => Promise<void>,
  commitMessage: string,
): Promise<void> {
  await withTempRepo(async (repo) => {
    writeGateConfig(repo, PROTECTED_SECRET_CONFIG);
    writeRepoFile(repo, 'src/secret.ts', 'export const secret = 1;\n');
    commitAll(repo, 'base');
    git(repo, ['checkout', '-q', '-b', 'feat']);
    afterFeat(repo);
    commitAll(repo, commitMessage);
    await fn(repo);
  });
}

function expectSameFile(actual: string | undefined, expected: string): void {
  expect(actual).toBeDefined();
  if (actual === undefined) {
    return;
  }
  expect(fs.realpathSync(actual)).toBe(fs.realpathSync(expected));
}

async function withLoosenedConfig(
  fn: (outcome: Awaited<ReturnType<typeof runGate>>) => void,
  allowConfigChange = false,
): Promise<void> {
  await withTempRepo(async (repo) => {
    writeGateConfig(repo, PASSING_TESTS_CONFIG);
    commitAll(repo, 'base');
    git(repo, ['checkout', '-q', '-b', 'feat']);
    writeGateConfig(repo, { steps: { tests: { command: 'npm test', enabled: false }, 'line-checks': true } });
    commitAll(repo, 'edit config');
    const overrides = allowConfigChange ? { HEIMDALL_ALLOW_CONFIG_CHANGE: '1' } : {};
    const unset = allowConfigChange
      ? ['GATE_ALLOW_CONFIG_CHANGE']
      : ['HEIMDALL_ALLOW_CONFIG_CHANGE', 'GATE_ALLOW_CONFIG_CHANGE'];
    await withProcessEnv(overrides, async () => {
      fn(await runGate({ cwd: repo }));
    }, unset);
  });
}

describe('runGate exit codes', () => {
  it('returns GATE ERROR outside a git repo', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-nogit-'));
    try {
      const outcome = await runGate({ cwd: dir });
      expect(outcome.kind).toBe('error');
      expect(outcome.exitCode).toBe(2);
      if (outcome.kind === 'error') {
        expect(outcome.reason).toMatch(/not a git repository/);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns green when every enabled step passes', async () => {
    await seededRepo(async (repo) => {
      const outcome = await runGate({ cwd: repo, ...mockPass() });
      expect(outcome.kind).toBe('green');
      expect(outcome.exitCode).toBe(0);
      expectSameFile(outcome.configPath, path.join(repo, 'heimdall.config.json'));
    });
  });

  it('returns red for a new lint finding and ignores legacy ones', async () => {
    await seededRepo(async (repo) => {
      const eslintJson = JSON.stringify([
        {
          filePath: `${repo}/src/legacy.ts`,
          messages: [{ line: 1, ruleId: 'no-unused-vars', message: 'legacy', severity: 2 }],
        },
        {
          filePath: `${repo}/src/new.ts`,
          messages: [{ line: 1, ruleId: 'eqeqeq', message: 'use ===', severity: 2 }],
        },
      ]);
      const outcome = await runGate({
        cwd: repo,
        runCommand: async () => result({ exitCode: 1, stdout: eslintJson }),
      });
      expect(outcome.kind).toBe('red');
      expect(outcome.exitCode).toBe(1);
      const findings = failFindings(outcome);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.file).toMatch(/src\/new\.ts$/);
      expect(findings[0]?.rule).toBe('eqeqeq');
    }, { steps: { eslint: { command: 'npx eslint -f json' } } });
  });

  it('returns green when lint findings are only in untouched files', async () => {
    await seededRepo(async (repo) => {
      const eslintJson = JSON.stringify([
        {
          filePath: `${repo}/src/legacy.ts`,
          messages: [{ line: 1, ruleId: 'no-unused-vars', message: 'legacy', severity: 2 }],
        },
      ]);
      const outcome = await runGate({
        cwd: repo,
        runCommand: async () => result({ exitCode: 1, stdout: eslintJson }),
      });
      expect(outcome.kind).toBe('green');
      expect(outcome.exitCode).toBe(0);
    }, { steps: { eslint: { command: 'npx eslint -f json' } } });
  });

  it('returns GATE ERROR for a missing tool', async () => {
    await seededRepo(async (repo) => {
      const outcome = await runGate({
        cwd: repo,
        runCommand: async () =>
          result({
            exitCode: null,
            stdout: '',
            spawnError: "spawn not-a-real-gate-tool ENOENT",
          }),
      });
      expect(outcome.kind).toBe('error');
      expect(outcome.exitCode).toBe(2);
      if (outcome.kind === 'error') {
        expect(outcome.reason).toMatch(/not found|ENOENT/);
        expect(outcome.reason).not.toMatch(/src\/new/);
      }
    }, { steps: { tests: { command: 'not-a-real-gate-tool' } } });
  });

  it('returns GATE ERROR for a crashed command', async () => {
    await seededRepo(async (repo) => {
      const outcome = await runGate({
        cwd: repo,
        runCommand: async () => result({ exitCode: null, signal: 'SIGSEGV', stdout: '' }),
      });
      expect(outcome.kind).toBe('error');
      expect(outcome.exitCode).toBe(2);
      if (outcome.kind === 'error') {
        expect(outcome.reason).toMatch(/SIGSEGV/);
      }
    }, { steps: { knip: { command: 'npx knip --reporter json' } } });
  });

  it('returns GATE ERROR for unparseable knip output on a failed command', async () => {
    await seededRepo(async (repo) => {
      const outcome = await runGate({
        cwd: repo,
        runCommand: async () => result({ exitCode: 1, stdout: 'knip exploded, not json' }),
      });
      expect(outcome.kind).toBe('error');
      expect(outcome.exitCode).toBe(2);
      if (outcome.kind === 'error') {
        expect(outcome.reason).toMatch(/knip output is not JSON/);
      }
    }, { steps: { knip: { command: 'npx knip --reporter json' } } });
  });

  it('returns GATE ERROR for invalid JSON config on disk', async () => {
    await seededRepo(async (repo) => {
      writeRepoFile(repo, 'heimdall.config.json', '{ not json');
      const outcome = await runGate({ cwd: repo });
      expect(outcome.kind).toBe('error');
      expect(outcome.exitCode).toBe(2);
      if (outcome.kind === 'error') {
        expect(outcome.reason).toMatch(/not valid JSON/);
      }
    }, null);
  });

  it('returns GATE ERROR listing every config path it tried', async () => {
    await withTempGateHome(async (gateHome) => {
      await seededRepo(async (repo) => {
        const outcome = await runGate({ cwd: repo });
        expect(outcome.kind).toBe('error');
        expect(outcome.exitCode).toBe(2);
        if (outcome.kind === 'error') {
          const name = path.basename(repo);
          expect(outcome.reason).toMatch(/no heimdall.config.json found/);
          expect(outcome.reason).toContain(path.join(repo, 'heimdall.config.json'));
          expect(outcome.reason).toContain(path.join(repo, 'gate.config.json'));
          expect(outcome.reason).toContain(path.join(gateHome, name, 'heimdall.config.json'));
          expect(outcome.reason).toContain(path.join(gateHome, name, 'gate.config.json'));
        }
      }, null);
    });
  });

  it('passes tests that fail only on named flakes', async () => {
    await seededRepo(async (repo) => {
      const outcome = await runGate({
        cwd: repo,
        runCommand: async () =>
          result({
            exitCode: 1,
            stdout: ' FAIL  src/bill.test.ts > suite > times out talking to billing\n',
          }),
      });
      expect(outcome.kind).toBe('green');
      expect(outcome.exitCode).toBe(0);
    }, {
      steps: { tests: { command: 'npx vitest run' } },
      flakes: ['src/bill.test.ts > suite > times out talking to billing'],
    });
  });

  it('fails tests that are not in the flake list', async () => {
    await seededRepo(async (repo) => {
      const outcome = await runGate({
        cwd: repo,
        runCommand: async () =>
          result({
            exitCode: 1,
            stdout: ' FAIL  src/a.test.ts > suite > real regression\n',
          }),
      });
      expect(outcome.kind).toBe('red');
      expect(outcome.exitCode).toBe(1);
      expect(failFindings(outcome)[0]?.message).toBe('suite > real regression');
    }, {
      steps: { tests: { command: 'npx vitest run' } },
      flakes: ['src/bill.test.ts > suite > times out talking to billing'],
    });
  });

  it('GATE ERRORs when flakes are configured but test names cannot be parsed', async () => {
    await seededRepo(async (repo) => {
      const outcome = await runGate({
        cwd: repo,
        runCommand: async () => result({ exitCode: 1, stdout: 'Boom, no FAIL lines' }),
      });
      expect(outcome.kind).toBe('error');
      expect(outcome.exitCode).toBe(2);
      if (outcome.kind === 'error') {
        expect(outcome.reason).toMatch(/no parseable failed tests/);
      }
    }, {
      steps: { tests: { command: 'npx vitest run' } },
      flakes: ['src/bill.test.ts > suite > times out talking to billing'],
    });
  });

  it('runs teardown after a failing step and still reports red', async () => {
    await seededRepo(async (repo) => {
      const ran: string[] = [];
      const outcome = await runGate({
        cwd: repo,
        runCommand: async (command) => {
          ran.push(command);
          if (command === 'echo down') {
            return result({ exitCode: 0, stdout: 'down\n' });
          }
          return result({
            exitCode: 1,
            stdout: ' FAIL  src/a.test.ts > suite > real regression\n',
          });
        },
      });
      expect(ran).toContain('echo down');
      expect(outcome.kind).toBe('red');
    }, {
      steps: { tests: { command: 'npx vitest run' } },
      teardown: ['echo down'],
    });
  });

  it('setup failure is a GATE ERROR and still runs teardown', async () => {
    await seededRepo(async (repo) => {
      const ran: string[] = [];
      const outcome = await runGate({
        cwd: repo,
        runCommand: async (command) => {
          ran.push(command);
          if (command === 'echo up') {
            return result({ exitCode: 1, stdout: 'no db\n' });
          }
          return result({ exitCode: 0, stdout: 'ok\n' });
        },
      });
      expect(ran).toEqual(['echo up', 'echo down']);
      expect(outcome.kind).toBe('error');
      expect(outcome.exitCode).toBe(2);
      if (outcome.kind === 'error') {
        expect(outcome.reason).toMatch(/setup command/);
      }
    }, {
      steps: { tests: { command: 'npx vitest run' } },
      setup: ['echo up'],
      teardown: ['echo down'],
    });
  });

  it('line-checks flags an as-cast on an added line', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'src/ok.ts', 'export const n = 1;\n');
      writeGateConfig(repo, { steps: { 'line-checks': true } });
      commitAll(repo, 'base');
      git(repo, ['checkout', '-q', '-b', 'feat']);
      writeRepoFile(repo, 'src/cast.ts', 'export const n = (x: unknown) => x as number;\n');
      commitAll(repo, 'feat');
      const outcome = await runGate({ cwd: repo });
      expect(outcome.kind).toBe('red');
      expect(failFindings(outcome).some((hit) => hit.rule === 'as-cast')).toBe(true);
    });
  });

  it('teardown failure is a GATE ERROR', async () => {
    await seededRepo(async (repo) => {
      const outcome = await runGate({
        cwd: repo,
        runCommand: async (command) => {
          if (command === 'echo down') {
            return result({ exitCode: 1, stdout: 'could not stop db\n' });
          }
          return result({ exitCode: 0, stdout: 'ok\n' });
        },
      });
      expect(outcome.kind).toBe('error');
      expect(outcome.exitCode).toBe(2);
      if (outcome.kind === 'error') {
        expect(outcome.reason).toMatch(/teardown command/);
      }
    }, {
      steps: { tests: { command: 'npx vitest run' } },
      teardown: ['echo down'],
    });
  });

  it('knip findings in unchanged files do not turn the run red', async () => {
    await seededRepo(async (repo) => {
      const knipJson = JSON.stringify({
        issues: [{ file: 'src/legacy.ts', exports: [{ name: 'leftover', line: 1 }] }],
      });
      const outcome = await runGate({
        cwd: repo,
        runCommand: async () => result({ exitCode: 1, stdout: knipJson }),
      });
      expect(outcome.kind).toBe('green');
    }, { steps: { knip: { command: 'npx knip --reporter json' } } });
  });

  it('warns when the diff against the resolved base is empty', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'src/ok.ts', 'export const n = 1;\n');
      writeGateConfig(repo, PASSING_TESTS_CONFIG);
      commitAll(repo, 'base');
      const outcome = await runGate({ cwd: repo, ...mockPass() });
      expect(outcome.kind).toBe('green');
      if (outcome.kind === 'green') {
        expect(outcome.warnings.some((warning) => warning.includes('EMPTY DIFF against base main'))).toBe(true);
        expect(outcome.warnings.some((warning) => warning.includes(outcome.mergeBaseSha))).toBe(true);
      }
    });
  });

  it('records the resolved base branch and merge-base commit', async () => {
    await seededRepo(async (repo) => {
      const mainSha = git(repo, ['rev-parse', 'main']).trim();
      const outcome = await runGate({ cwd: repo, ...mockPass() });
      expect(outcome.kind).toBe('green');
      expect(outcome.baseRef).toBe('main');
      expect(outcome.mergeBaseSha).toBe(mainSha);
    });
  });

  it('goes red when the story changes the gate config', async () => {
    await withLoosenedConfig((outcome) => {
      expect(outcome.kind).toBe('red');
      expect(outcome.exitCode).toBe(1);
      const findings = failFindings(outcome);
      expect(findings.some((hit) => hit.rule === 'config-change')).toBe(true);
      expect(findings[0]?.file).toBe('heimdall.config.json');
      expect(findings[0]?.message).toMatch(/HEIMDALL_ALLOW_CONFIG_CHANGE=1/);
    });
  });

  it('allows a config change when HEIMDALL_ALLOW_CONFIG_CHANGE=1', async () => {
    await withLoosenedConfig((outcome) => {
      expect(outcome.kind).toBe('green');
    }, true);
  });

  it('honours GATE_ALLOW_CONFIG_CHANGE=1 as a deprecated alias', async () => {
    await withTempRepo(async (repo) => {
      writeGateConfig(repo, PASSING_TESTS_CONFIG);
      commitAll(repo, 'base');
      git(repo, ['checkout', '-q', '-b', 'feat']);
      writeGateConfig(repo, { steps: { tests: { command: 'npm test', enabled: false }, 'line-checks': true } });
      commitAll(repo, 'edit config');
      await withProcessEnv({ GATE_ALLOW_CONFIG_CHANGE: '1' }, async () => {
        const outcome = await runGate({ cwd: repo, ...mockPass() });
        expect(outcome.kind).toBe('green');
        expect(outcome.warnings).toContain('GATE_ALLOW_CONFIG_CHANGE is deprecated; use HEIMDALL_ALLOW_CONFIG_CHANGE');
      }, ['HEIMDALL_ALLOW_CONFIG_CHANGE']);
    });
  });

  it('times out a hung step as GATE ERROR naming the step and timeout', async () => {
    await seededRepo(async (repo) => {
      const started = Date.now();
      const outcome = await runGate({ cwd: repo });
      expect(Date.now() - started).toBeLessThan(1500);
      expect(outcome.kind).toBe('error');
      expect(outcome.exitCode).toBe(2);
      if (outcome.kind === 'error') {
        expect(outcome.reason).toBe('tests timed out after 250ms');
      }
    }, {
      steps: {
        tests: {
          command: nodeCommand('setInterval(() => {}, 1000)'),
          timeoutMs: 250,
        },
      },
    });
  });

  it('kills the running step tree and returns GATE ERROR when aborted', async () => {
    await seededRepo(async (repo) => {
      const pidFile = path.join(repo, 'hang.pid');
      const abort = new AbortController();
      await withProcessEnv({ GATE_PID_FILE: pidFile }, async () => {
        const pending = runGate({
          cwd: repo,
          abortSignal: abort.signal,
        });
        const pid = Number(await waitForFile(pidFile, 800));
        abort.abort('SIGTERM');
        const outcome = await pending;
        expect(outcome.kind).toBe('error');
        expect(outcome.exitCode).toBe(2);
        expect(outcome.exitCode).not.toBe(0);
        if (outcome.kind === 'error') {
          expect(outcome.reason).toMatch(/heimdall interrupted \(SIGTERM\)/);
        }
        expect(isProcessAlive(pid)).toBe(false);
      });
    }, {
      steps: {
        tests: {
          command: nodeCommand(
            "require('node:fs').writeFileSync(process.env.GATE_PID_FILE, String(process.pid)); setInterval(() => {}, 1000);",
          ),
          timeoutMs: 5000,
        },
      },
    });
  });

  it('loads $HEIMDALL_HOME/<repo>/heimdall.config.json when the git root has none', async () => {
    await withTempGateHome(async (gateHome) => {
      await seededRepo(async (repo) => {
        const configPath = writeHomeGateConfig(gateHome, path.basename(repo), PASSING_TESTS_CONFIG);
        const outcome = await runGate({ cwd: repo, ...mockPass() });
        expect(outcome.kind).toBe('green');
        expectSameFile(outcome.configPath, configPath);
      }, null);
    });
  });

  it('loads $HEIMDALL_HOME/<main-repo>/ from a linked worktree whose folder name differs', async () => {
    await withTempGateHome(async (gateHome) => {
      await withTempRepo(async (repo) => {
        writeRepoFile(repo, 'src/a.ts', 'export const a = 1;\n');
        commitAll(repo, 'base');
        git(repo, ['checkout', '-q', '-b', 'feat-s03']);
        writeRepoFile(repo, 'src/a.ts', 'export const a = 2;\n');
        commitAll(repo, 'feat');
        git(repo, ['checkout', '-q', 'main']);
        const worktree = addWorktree(repo, 'foo-feat-s03', 'feat-s03');
        writeHomeGateConfig(gateHome, 'foo-feat-s03', PASSING_TESTS_CONFIG);
        const configPath = writeHomeGateConfig(gateHome, 'foo', PASSING_TESTS_CONFIG);
        const outcome = await runGate({ cwd: worktree, ...mockPass() });
        expect(outcome.kind).toBe('green');
        expectSameFile(outcome.configPath, configPath);
      }, { folderName: 'foo' });
    });
  });

  it('lists the common-dir name, not the worktree folder, when no config is found', async () => {
    await withTempGateHome(async (gateHome) => {
      await withTempRepo(async (repo) => {
        writeRepoFile(repo, 'src/a.ts', 'export const a = 1;\n');
        commitAll(repo, 'base');
        const worktree = addWorktree(repo, 'foo-feat-s03');
        const outcome = await runGate({ cwd: worktree });
        expect(outcome.kind).toBe('error');
        expect(outcome.exitCode).toBe(2);
        if (outcome.kind === 'error') {
          expect(outcome.reason).toMatch(/no heimdall.config.json found/);
          expect(outcome.reason).toContain(path.join(worktree, 'heimdall.config.json'));
          expect(outcome.reason).toContain(path.join(gateHome, 'foo', 'heimdall.config.json'));
          expect(outcome.reason).toContain(path.join(gateHome, 'foo', 'gate.config.json'));
          expect(outcome.reason).not.toContain(path.join(gateHome, 'foo-feat-s03', 'heimdall.config.json'));
        }
      }, { folderName: 'foo' });
    });
  });

  it('loads $HEIMDALL_HOME/<lowercase>/heimdall.config.json for a mixed-case git root folder', async () => {
    await withTempGateHome(async (gateHome) => {
      await withTempRepo(async (repo) => {
        writeRepoFile(repo, 'src/new.ts', 'export const value = 1;\n');
        writeHomeGateConfig(gateHome, 'myapp', PASSING_TESTS_CONFIG);
        commitAll(repo, 'feat');
        const outcome = await runGate({ cwd: repo, ...mockPass() });
        expect(outcome.kind).toBe('green');
        expectSameFile(outcome.configPath, path.join(gateHome, 'myapp', 'heimdall.config.json'));
      }, { folderName: 'MyApp' });
    });
  });

  it('does not treat a $HEIMDALL_HOME config as a config-change', async () => {
    await withTempGateHome(async (gateHome) => {
      await seededRepo(async (repo) => {
        writeHomeGateConfig(gateHome, path.basename(repo), {
          steps: { tests: { command: 'npm test', enabled: false }, 'line-checks': true },
        });
        await withProcessEnv({}, async () => {
          const outcome = await runGate({ cwd: repo, ...mockPass() });
          expect(outcome.kind).toBe('green');
          expect(failFindings(outcome).some((hit) => hit.rule === 'config-change')).toBe(false);
        }, ['HEIMDALL_ALLOW_CONFIG_CHANGE', 'GATE_ALLOW_CONFIG_CHANGE']);
      }, null);
    });
  });

  it('sets HEIMDALL_CONFIG_DIR and HEIMDALL_TMP for every command including knip baseline', async () => {
    await withTempGateHome(async (gateHome) => {
      await seededRepo(async (repo) => {
        const configDir = path.dirname(writeHomeGateConfig(gateHome, path.basename(repo), {
          steps: { knip: { command: 'npx knip --reporter json' } },
          setup: ['echo up'],
        }));
        const seen: Array<{ cwd: string; configDir: string | undefined; legacyConfigDir: string | undefined; tmp: string | undefined; legacyTmp: string | undefined }> = [];
        const current = JSON.stringify({
          files: [],
          issues: [{ file: 'src/new.ts', exports: [{ name: 'value', line: 1 }] }],
        });
        const base = JSON.stringify({ files: [], issues: [] });
        const outcome = await runGate({
          cwd: repo,
          runCommand: async (command, cwd, env) => {
            seen.push({
              cwd,
              configDir: env[CONFIG_DIR_ENV],
              legacyConfigDir: env[LEGACY_CONFIG_DIR_ENV],
              tmp: env[TMP_ENV],
              legacyTmp: env[LEGACY_TMP_ENV],
            });
            if (command === 'echo up') {
              return result({ exitCode: 0, stdout: 'up\n' });
            }
            if (cwd.includes('knip-base')) {
              return result({ exitCode: 0, stdout: base });
            }
            return result({ exitCode: 1, stdout: current });
          },
        });
        expect(seen.length).toBeGreaterThanOrEqual(2);
        expect(seen.every((shot) => shot.configDir === configDir)).toBe(true);
        expect(seen.every((shot) => shot.legacyConfigDir === configDir)).toBe(true);
        expect(seen.every((shot) => shot.tmp !== undefined && shot.tmp === shot.legacyTmp)).toBe(true);
        expect(seen.some((shot) => shot.cwd.includes('knip-base'))).toBe(true);
        expectSameFile(outcome.configPath, path.join(configDir, 'heimdall.config.json'));
      }, null);
    });
  });

  it('loads in-repo gate.config.json as a deprecated fallback with a warning', async () => {
    await withTempRepo(async (repo) => {
      writeRepoFile(repo, 'src/ok.ts', 'export const n = 1;\n');
      writeGateConfig(repo, PASSING_TESTS_CONFIG, 'gate.config.json');
      commitAll(repo, 'base');
      git(repo, ['checkout', '-q', '-b', 'feat']);
      writeRepoFile(repo, 'src/new.ts', 'export const value = 1;\n');
      commitAll(repo, 'feat');
      const outcome = await runGate({ cwd: repo, ...mockPass() });
      expect(outcome.kind).toBe('green');
      expectSameFile(outcome.configPath, path.join(repo, 'gate.config.json'));
      expect(outcome.warnings).toContain(DEPRECATED_CONFIG_WARNING);
    });
  });

  it('prefers in-repo heimdall.config.json over a sibling gate.config.json', async () => {
    await withTempRepo(async (repo) => {
      writeGateConfig(repo, PASSING_TESTS_CONFIG);
      writeGateConfig(repo, { steps: { tests: { command: 'npm test', enabled: false }, 'line-checks': true } }, 'gate.config.json');
      commitAll(repo, 'base');
      const outcome = await runGate({ cwd: repo, ...mockPass() });
      expect(outcome.kind).toBe('green');
      expectSameFile(outcome.configPath, path.join(repo, 'heimdall.config.json'));
      expect(outcome.warnings).not.toContain(DEPRECATED_CONFIG_WARNING);
    });
  });

  it('loads $GATE_HOME as a deprecated alias of $HEIMDALL_HOME', async () => {
    await withTempGateHome(async (gateHome) => {
      await seededRepo(async (repo) => {
        const configPath = writeHomeGateConfig(gateHome, path.basename(repo), PASSING_TESTS_CONFIG);
        await withProcessEnv({ GATE_HOME: gateHome }, async () => {
          const outcome = await runGate({ cwd: repo, ...mockPass() });
          expect(outcome.kind).toBe('green');
          expectSameFile(outcome.configPath, configPath);
          expect(outcome.warnings).toContain('GATE_HOME is deprecated; use HEIMDALL_HOME');
        }, ['HEIMDALL_HOME']);
      }, null);
    });
  });

  it('goes red when a custom --config file is in the story diff', async () => {
    await withTempRepo(async (repo) => {
      writeGateConfig(repo, PASSING_TESTS_CONFIG, 'team.gate.json');
      commitAll(repo, 'base');
      git(repo, ['checkout', '-q', '-b', 'feat']);
      writeGateConfig(
        repo,
        {
          steps: { tests: { command: 'npm test' } },
          flakes: ['src/a.test.ts > suite > never fails'],
        },
        'team.gate.json',
      );
      commitAll(repo, 'add flake via config');
      await withProcessEnv({}, async () => {
        const outcome = await runGate({
          cwd: repo,
          configPath: 'team.gate.json',
          ...mockPass(),
        });
        expect(outcome.kind).toBe('red');
        const findings = failFindings(outcome);
        expect(findings[0]?.file).toBe('team.gate.json');
        expect(findings[0]?.rule).toBe('config-change');
      }, ['HEIMDALL_ALLOW_CONFIG_CHANGE', 'GATE_ALLOW_CONFIG_CHANGE']);
    });
  });

  it('flags no-silencing on added lines even when line-checks is omitted', async () => {
    await featFile(PASSING_TESTS_CONFIG, 'src/silence.ts', 'void leftover;\n', async (repo) => {
      const outcome = await runGate({ cwd: repo, ...mockPass() });
      expect(outcome.kind).toBe('red');
      expect(failFindings(outcome).some((hit) => hit.rule === 'no-silencing' && hit.file === 'src/silence.ts')).toBe(
        true,
      );
    });
  });

  it('does not flag as-cast extras when line-checks is omitted', async () => {
    await featFile(
      PASSING_TESTS_CONFIG,
      'src/cast.ts',
      'export const n = (x: unknown) => x as number;\n',
      async (repo) => {
        const outcome = await runGate({ cwd: repo, ...mockPass() });
        expect(outcome.kind).toBe('green');
        expect(failFindings(outcome).some((hit) => hit.rule === 'as-cast')).toBe(false);
      },
    );
  });

  it('goes red when a protected path is added, changed, deleted, or renamed', async () => {
    await featFile(PROTECTED_SECRET_CONFIG, 'src/secret.ts', 'export const secret = 1;\n', async (repo) => {
      const added = await runGate({ cwd: repo, ...mockPass() });
      expect(failFindings(added).some((hit) => hit.file === 'src/secret.ts' && hit.rule === 'protected-path')).toBe(
        true,
      );
    });

    await withProtectedSecretRepo(
      (repo) => {
        writeRepoFile(repo, 'src/secret.ts', 'export const secret = 2;\n');
      },
      async (repo) => {
        const changed = await runGate({ cwd: repo, ...mockPass() });
        expect(changed.kind).toBe('red');
        const changedHits = failFindings(changed).filter((hit) => hit.rule === 'protected-path');
        expect(changedHits).toHaveLength(1);
        const changedHit = changedHits[0];
        expect(changedHit?.file).toBe('src/secret.ts');
        expect(changedHit?.message).toBe('this path is off-limits');
        if (changedHit) {
          expect(formatFinding(changedHit)).toBe('src/secret.ts [protected-path] this path is off-limits');
        }
      },
      'edit secret',
    );

    await withProtectedSecretRepo(
      (repo) => {
        fs.unlinkSync(path.join(repo, 'src/secret.ts'));
      },
      async (repo) => {
        const deleted = await runGate({ cwd: repo, ...mockPass() });
        expect(failFindings(deleted).some((hit) => hit.file === 'src/secret.ts' && hit.rule === 'protected-path')).toBe(
          true,
        );
      },
      'delete secret',
    );

    await withProtectedSecretRepo(
      (repo) => {
        git(repo, ['mv', 'src/secret.ts', 'src/ok.ts']);
      },
      async (repo) => {
        const renamed = await runGate({ cwd: repo, ...mockPass() });
        expect(failFindings(renamed).some((hit) => hit.file === 'src/secret.ts' && hit.rule === 'protected-path')).toBe(
          true,
        );
      },
      'rename secret',
    );
  });

  it('ignores protectedPaths when the list is absent or empty', async () => {
    await featFile(
      { steps: { tests: { command: 'npm test' } }, protectedPaths: [] },
      'src/secret.ts',
      'export const secret = 1;\n',
      async (repo) => {
        const outcome = await runGate({ cwd: repo, ...mockPass() });
        expect(outcome.kind).toBe('green');
        expect(failFindings(outcome).some((hit) => hit.rule === 'protected-path')).toBe(false);
      },
    );
  });
});

describe('outside-repo config lock', () => {
  async function withGitGateHome(
    fn: (ctx: { target: string; configRepo: string; gateHome: string; repoName: string }) => Promise<void>,
    gateHomeFromRepo: (configRepo: string) => string = (repo) => repo,
  ): Promise<void> {
    await withTempRepo(async (configRepo) => {
      const gateHome = gateHomeFromRepo(configRepo);
      fs.mkdirSync(gateHome, { recursive: true });
      await withProcessEnv({ HEIMDALL_HOME: gateHome }, async () => {
        await seededRepo(async (target) => {
          await fn({
            target,
            configRepo,
            gateHome,
            repoName: path.basename(target),
          });
        }, null);
      }, ['HEIMDALL_ALLOW_CONFIG_CHANGE', 'GATE_ALLOW_CONFIG_CHANGE', 'GATE_HOME']);
    });
  }

  function seedHomeConfig(gateHome: string, repoName: string): string {
    const configPath = writeHomeGateConfig(gateHome, repoName, PASSING_TESTS_CONFIG);
    writeRepoFile(path.dirname(configPath), 'knip.json', '{}\n');
    return configPath;
  }

  it('goes red for unstaged, staged, and untracked files in the config directory', async () => {
    await withGitGateHome(async ({ target, configRepo, gateHome, repoName }) => {
      seedHomeConfig(gateHome, repoName);
      writeRepoFile(gateHome, `${repoName}/helper.js`, 'export {}\n');
      commitAll(configRepo, 'config');
      writeRepoFile(gateHome, `${repoName}/knip.json`, '{ "ignore": [] }\n');
      writeRepoFile(gateHome, `${repoName}/helper.js`, 'export const dirty = 1;\n');
      git(configRepo, ['add', `${repoName}/helper.js`]);
      writeRepoFile(gateHome, `${repoName}/extra.json`, '{}\n');
      const outcome = await runGate({ cwd: target, ...mockPass() });
      expect(outcome.kind).toBe('red');
      expect(outcome.exitCode).toBe(1);
      const hits = failFindings(outcome).filter((hit) => hit.rule === 'config-uncommitted');
      expect(hits.map((hit) => hit.file)).toEqual([
        `${repoName}/extra.json`,
        `${repoName}/helper.js`,
        `${repoName}/knip.json`,
      ]);
      expect(hits.every((hit) => hit.message === 'commit this config change first')).toBe(true);
      const first = hits[0];
      expect(first).toBeDefined();
      if (first) {
        expect(formatFinding(first)).toBe(
          `${repoName}/extra.json [config-uncommitted] commit this config change first`,
        );
      }
    });
  });

  it('allows uncommitted outside-repo config files when HEIMDALL_ALLOW_CONFIG_CHANGE=1', async () => {
    await withGitGateHome(async ({ target, configRepo, gateHome, repoName }) => {
      seedHomeConfig(gateHome, repoName);
      commitAll(configRepo, 'config');
      writeRepoFile(gateHome, `${repoName}/knip.json`, '{ "ignore": [] }\n');
      await withProcessEnv({ HEIMDALL_ALLOW_CONFIG_CHANGE: '1' }, async () => {
        const outcome = await runGate({ cwd: target, ...mockPass() });
        expect(outcome.kind).toBe('green');
        expect(failFindings(outcome).some((hit) => hit.rule === 'config-uncommitted')).toBe(false);
        expect(outcome.configCommit).toBe(git(configRepo, ['rev-parse', 'HEAD']).trim());
      });
    });
  });

  it('is green and prints the config commit hash when the outside-repo config is clean', async () => {
    await withGitGateHome(async ({ target, configRepo, gateHome, repoName }) => {
      const configPath = seedHomeConfig(gateHome, repoName);
      commitAll(configRepo, 'config');
      const sha = git(configRepo, ['rev-parse', 'HEAD']).trim();
      const outcome = await runGate({ cwd: target, ...mockPass() });
      expect(outcome.kind).toBe('green');
      expect(failFindings(outcome).some((hit) => hit.rule === 'config-uncommitted')).toBe(false);
      expect(outcome.configCommit).toBe(sha);
      expectSameFile(outcome.configPath, configPath);
      expect(formatReport(outcome)).toContain(`commit ${sha}`);
    });
  });

  it('does not fail when a sibling config directory is dirty', async () => {
    await withGitGateHome(async ({ target, configRepo, gateHome, repoName }) => {
      seedHomeConfig(gateHome, repoName);
      seedHomeConfig(gateHome, 'other');
      commitAll(configRepo, 'config');
      writeRepoFile(gateHome, 'other/knip.json', '{ "ignore": [] }\n');
      const outcome = await runGate({ cwd: target, ...mockPass() });
      expect(outcome.kind).toBe('green');
      expect(failFindings(outcome).some((hit) => hit.rule === 'config-uncommitted')).toBe(false);
    }, (configRepo) => path.join(configRepo, 'configs'));
  });

  it('warns and stays green when the outside-repo config is not in a git repo', async () => {
    await withTempGateHome(async (gateHome) => {
      await seededRepo(async (target) => {
        const configPath = seedHomeConfig(gateHome, path.basename(target));
        const outcome = await runGate({ cwd: target, ...mockPass() });
        expect(outcome.kind).toBe('green');
        expect(outcome.configCommit).toBeUndefined();
        expect(failFindings(outcome).some((hit) => hit.rule === 'config-uncommitted')).toBe(false);
        expect(outcome.warnings).toContain(`config is not version-controlled (${path.dirname(configPath)})`);
        expect(formatReport(outcome)).toMatch(/WARNING:\s+config is not version-controlled/);
      }, null);
    });
  });

  it('goes red for an uncommitted sibling when --config points outside the target repo', async () => {
    await withTempRepo(async (configRepo) => {
      writeGateConfig(configRepo, PASSING_TESTS_CONFIG);
      const configPath = path.join(configRepo, 'heimdall.config.json');
      writeRepoFile(configRepo, 'knip.json', '{}\n');
      commitAll(configRepo, 'config');
      writeRepoFile(configRepo, 'knip.json', '{ "ignore": [] }\n');
      await seededRepo(async (target) => {
        await withProcessEnv({}, async () => {
          const outcome = await runGate({
            cwd: target,
            configPath,
            ...mockPass(),
          });
          expect(outcome.kind).toBe('red');
          const hits = failFindings(outcome).filter((hit) => hit.rule === 'config-uncommitted');
          expect(hits.map((hit) => hit.file)).toEqual(['knip.json']);
          expect(outcome.configCommit).toBe(git(configRepo, ['rev-parse', 'HEAD']).trim());
        }, ['HEIMDALL_ALLOW_CONFIG_CHANGE', 'GATE_ALLOW_CONFIG_CHANGE']);
      }, null);
    });
  });

  it('does not apply the outside-repo lock to an in-repo config', async () => {
    await withTempRepo(async (repo) => {
      writeGateConfig(repo, PASSING_TESTS_CONFIG);
      writeRepoFile(repo, 'knip.json', '{}\n');
      commitAll(repo, 'base');
      git(repo, ['checkout', '-q', '-b', 'feat']);
      writeRepoFile(repo, 'src/new.ts', 'export const value = 1;\n');
      commitAll(repo, 'feat');
      writeRepoFile(repo, 'knip.json', '{ "ignore": [] }\n');
      await withProcessEnv({}, async () => {
        const outcome = await runGate({ cwd: repo, ...mockPass() });
        expect(outcome.kind).toBe('green');
        expect(outcome.configCommit).toBeUndefined();
        expect(failFindings(outcome).some((hit) => hit.rule === 'config-uncommitted')).toBe(false);
        expect(failFindings(outcome).some((hit) => hit.rule === 'config-change')).toBe(false);
      }, ['HEIMDALL_ALLOW_CONFIG_CHANGE', 'GATE_ALLOW_CONFIG_CHANGE']);
    });
  });
});

const PARENT_BASE_CONFIG = {
  steps: { tests: { command: 'npm test' } },
  requireParentBase: true,
  setup: ['echo up'],
};

function trackOwnRemote(repo: string): void {
  const sha = git(repo, ['rev-parse', 'HEAD']).trim();
  const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  git(repo, ['remote', 'add', 'origin', 'https://example.invalid/heimdall.git']);
  git(repo, ['update-ref', `refs/remotes/origin/${branch}`, sha]);
  git(repo, ['branch', `--set-upstream-to=origin/${branch}`]);
}

describe('runGate base guard', () => {
  it('is a GATE ERROR when requireParentBase is true and the base falls back to main', async () => {
    await withTempRepo(async (repo) => {
      writeGateConfig(repo, PARENT_BASE_CONFIG);
      commitAll(repo, 'initial');
      git(repo, ['checkout', '-q', '-b', 'feat']);
      writeRepoFile(repo, 'src/a.ts', 'export const a = 1;\n');
      commitAll(repo, 'feat');
      trackOwnRemote(repo);
      let ranCommand = false;
      const outcome = await runGate({
        cwd: repo,
        runCommand: async () => {
          ranCommand = true;
          return result({ exitCode: 0, stdout: 'ok\n' });
        },
      });
      expect(outcome.kind).toBe('error');
      expect(outcome.exitCode).toBe(2);
      expect(ranCommand).toBe(false);
      if (outcome.kind === 'error') {
        expect(outcome.reason).toMatch(/base resolved to main/);
        expect(outcome.reason).toMatch(/git branch --set-upstream-to=origin\/FEATURE/);
      }
    });
  });

  it('is a GATE ERROR when requireParentBase is true and the base falls back to origin/main', async () => {
    await withTempRepo(async (repo) => {
      writeGateConfig(repo, PARENT_BASE_CONFIG);
      commitAll(repo, 'initial');
      git(repo, ['branch', '-m', 'trunk']);
      git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
      git(repo, ['checkout', '-q', '-b', 'feat']);
      writeRepoFile(repo, 'src/a.ts', 'export const a = 1;\n');
      commitAll(repo, 'feat');
      trackOwnRemote(repo);
      let ranCommand = false;
      const outcome = await runGate({
        cwd: repo,
        runCommand: async () => {
          ranCommand = true;
          return result({ exitCode: 0, stdout: 'ok\n' });
        },
      });
      expect(outcome.kind).toBe('error');
      expect(outcome.exitCode).toBe(2);
      expect(ranCommand).toBe(false);
      if (outcome.kind === 'error') {
        expect(outcome.reason).toMatch(/base resolved to origin\/main/);
        expect(outcome.reason).toMatch(/git branch --set-upstream-to=origin\/FEATURE/);
      }
    });
  });

  it('is a GATE ERROR when requireParentBase is true and no upstream is set', async () => {
    await withTempRepo(async (repo) => {
      writeGateConfig(repo, PARENT_BASE_CONFIG);
      commitAll(repo, 'initial');
      git(repo, ['checkout', '-q', '-b', 'feat']);
      writeRepoFile(repo, 'src/a.ts', 'export const a = 1;\n');
      commitAll(repo, 'feat');
      let ranCommand = false;
      const outcome = await runGate({
        cwd: repo,
        runCommand: async () => {
          ranCommand = true;
          return result({ exitCode: 0, stdout: 'ok\n' });
        },
      });
      expect(outcome.kind).toBe('error');
      expect(outcome.exitCode).toBe(2);
      expect(ranCommand).toBe(false);
      if (outcome.kind === 'error') {
        expect(outcome.reason).toMatch(/no upstream is set/);
        expect(outcome.reason).toMatch(/git branch --set-upstream-to=origin\/FEATURE/);
      }
    });
  });

  it('does not fire the parent-base guard when requireParentBase is false', async () => {
    await withTempRepo(async (repo) => {
      writeGateConfig(repo, { steps: { tests: { command: 'npm test' } }, setup: ['echo up'] });
      commitAll(repo, 'initial');
      git(repo, ['checkout', '-q', '-b', 'feat']);
      writeRepoFile(repo, 'src/a.ts', 'export const a = 1;\n');
      commitAll(repo, 'feat');
      trackOwnRemote(repo);
      const commands: string[] = [];
      const outcome = await runGate({
        cwd: repo,
        runCommand: async (command) => {
          commands.push(command);
          return result({ exitCode: 0, stdout: 'ok\n' });
        },
      });
      expect(outcome.kind).toBe('green');
      expect(commands).toEqual(['echo up', 'npm test']);
    });
  });

  it('keeps an explicit baseRef of main when requireParentBase is true', async () => {
    await withTempRepo(async (repo) => {
      writeGateConfig(repo, {
        baseRef: 'main',
        requireParentBase: true,
        steps: { tests: { command: 'npm test' } },
      });
      commitAll(repo, 'initial');
      git(repo, ['checkout', '-q', '-b', 'feat']);
      writeRepoFile(repo, 'src/a.ts', 'export const a = 1;\n');
      commitAll(repo, 'feat');
      const outcome = await runGate({ cwd: repo, ...mockPass() });
      expect(outcome.kind).toBe('green');
      expect(outcome.baseRef).toBe('main');
    });
  });

  it('is a GATE ERROR when the changed-file count is above maxChangedFiles', async () => {
    await withTempRepo(async (repo) => {
      writeGateConfig(repo, {
        steps: { tests: { command: 'npm test' } },
        maxChangedFiles: 1,
        setup: ['echo up'],
      });
      commitAll(repo, 'initial');
      git(repo, ['checkout', '-q', '-b', 'feat']);
      writeRepoFile(repo, 'src/a.ts', 'export const a = 1;\n');
      commitAll(repo, 'feat');
      writeRepoFile(repo, 'src/untracked.ts', 'export const u = 1;\n');
      let ranCommand = false;
      await withProcessEnv({}, async () => {
        const outcome = await runGate({
          cwd: repo,
          runCommand: async () => {
            ranCommand = true;
            return result({ exitCode: 0, stdout: 'ok\n' });
          },
        });
        expect(outcome.kind).toBe('error');
        expect(outcome.exitCode).toBe(2);
        expect(ranCommand).toBe(false);
        if (outcome.kind === 'error') {
          expect(outcome.reason).toMatch(/changed file count 2 is above maxChangedFiles 1 \(base main\)/);
        }
        expect(outcome.changedFileCount).toBe(2);
      }, ['HEIMDALL_ALLOW_WIDE', 'GATE_ALLOW_WIDE']);
    });
  });

  it('continues with a warning when --allow-wide is passed over the file cap', async () => {
    await withTempRepo(async (repo) => {
      writeGateConfig(repo, {
        steps: { tests: { command: 'npm test' } },
        maxChangedFiles: 1,
      });
      commitAll(repo, 'initial');
      git(repo, ['checkout', '-q', '-b', 'feat']);
      writeRepoFile(repo, 'src/a.ts', 'export const a = 1;\n');
      writeRepoFile(repo, 'src/b.ts', 'export const b = 1;\n');
      commitAll(repo, 'feat');
      await withProcessEnv({}, async () => {
        const logs: string[] = [];
        const outcome = await runGate({
          cwd: repo,
          allowWide: true,
          log: (text) => logs.push(text),
          ...mockPass(),
        });
        expect(outcome.kind).toBe('green');
        expect(outcome.warnings.some((warning) =>
          warning.includes('changed file count 2 is above maxChangedFiles 1 (base main)'),
        )).toBe(true);
        expect(logs.some((line) => line.startsWith('WARNING:'))).toBe(true);
      }, ['HEIMDALL_ALLOW_WIDE', 'GATE_ALLOW_WIDE']);
    });
  });

  it('continues with a warning when HEIMDALL_ALLOW_WIDE=1 is set over the file cap', async () => {
    await withTempRepo(async (repo) => {
      writeGateConfig(repo, {
        steps: { tests: { command: 'npm test' } },
        maxChangedFiles: 1,
      });
      commitAll(repo, 'initial');
      git(repo, ['checkout', '-q', '-b', 'feat']);
      writeRepoFile(repo, 'src/a.ts', 'export const a = 1;\n');
      writeRepoFile(repo, 'src/b.ts', 'export const b = 1;\n');
      commitAll(repo, 'feat');
      await withProcessEnv({ HEIMDALL_ALLOW_WIDE: '1' }, async () => {
        const outcome = await runGate({ cwd: repo, ...mockPass() });
        expect(outcome.kind).toBe('green');
        expect(outcome.warnings.some((warning) =>
          warning.includes('changed file count 2 is above maxChangedFiles 1 (base main)'),
        )).toBe(true);
      }, ['GATE_ALLOW_WIDE']);
    });
  });

  it('honours GATE_ALLOW_WIDE=1 as a deprecated alias', async () => {
    await withTempRepo(async (repo) => {
      writeGateConfig(repo, {
        steps: { tests: { command: 'npm test' } },
        maxChangedFiles: 1,
      });
      commitAll(repo, 'initial');
      git(repo, ['checkout', '-q', '-b', 'feat']);
      writeRepoFile(repo, 'src/a.ts', 'export const a = 1;\n');
      writeRepoFile(repo, 'src/b.ts', 'export const b = 1;\n');
      commitAll(repo, 'feat');
      await withProcessEnv({ GATE_ALLOW_WIDE: '1' }, async () => {
        const outcome = await runGate({ cwd: repo, ...mockPass() });
        expect(outcome.kind).toBe('green');
        expect(outcome.warnings).toContain('GATE_ALLOW_WIDE is deprecated; use HEIMDALL_ALLOW_WIDE');
      }, ['HEIMDALL_ALLOW_WIDE']);
    });
  });

  it('prints base, merge-base, and changed-file count before setup and steps', async () => {
    await withTempRepo(async (repo) => {
      writeGateConfig(repo, {
        steps: { tests: { command: 'npm test' } },
        setup: ['echo up'],
      });
      commitAll(repo, 'initial');
      git(repo, ['checkout', '-q', '-b', 'feat']);
      writeRepoFile(repo, 'src/a.ts', 'export const a = 1;\n');
      commitAll(repo, 'feat');
      const mergeBase = git(repo, ['merge-base', 'main', 'HEAD']).trim();
      const events: string[] = [];
      const outcome = await runGate({
        cwd: repo,
        log: (text) => events.push(`log:${text}`),
        runCommand: async (command) => {
          events.push(`cmd:${command}`);
          return result({ exitCode: 0, stdout: 'ok\n' });
        },
      });
      expect(outcome.kind).toBe('green');
      const firstCmd = events.findIndex((event) => event.startsWith('cmd:'));
      expect(firstCmd).toBeGreaterThan(0);
      expect(events.slice(0, firstCmd).every((event) => event.startsWith('log:'))).toBe(true);
      expect(events.slice(firstCmd)).toEqual(['cmd:echo up', 'cmd:npm test']);
      const prelude = events.slice(0, firstCmd).join('');
      expect(prelude).toContain('base: main\n');
      expect(prelude).toContain(`merge-base: ${mergeBase.slice(0, 7)}\n`);
      expect(prelude).toContain('changed files: 1\n');
    });
  });
});
