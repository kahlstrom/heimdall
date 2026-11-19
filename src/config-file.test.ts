import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG_NAME,
  LEGACY_CONFIG_NAME,
  compatibilityGateHome,
  heimdallFallbackHome,
  loadGateConfigFile,
  packageConfigsDir,
  resolveConfigPath,
} from './config.js';

const MINIMAL_CONFIG = JSON.stringify({ steps: { tests: { command: 'npm test' } } });

function writeConfig(filePath: string, body: string = MINIMAL_CONFIG): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body);
  return filePath;
}

function withLookupDirs(
  folderName: string,
  fn: (dirs: { gitRoot: string; gateHome: string; env: NodeJS.ProcessEnv; lookupName: string }) => void,
  lookupName: string = folderName,
): void {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-lookup-'));
  try {
    const gitRoot = path.join(parent, folderName);
    const gateHome = path.join(parent, 'home');
    fs.mkdirSync(gitRoot, { recursive: true });
    fs.mkdirSync(gateHome, { recursive: true });
    fn({ gitRoot, gateHome, env: { HEIMDALL_HOME: gateHome }, lookupName });
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

describe('loadGateConfigFile', () => {
  it('loads a valid file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heimdall-config-'));
    try {
      const filePath = path.join(dir, 'heimdall.config.json');
      fs.writeFileSync(filePath, JSON.stringify({ steps: { tests: { command: 'npm test' } } }));
      const loaded = loadGateConfigFile(filePath);
      expect(loaded.ok).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns a GATE ERROR reason for missing files', () => {
    const loaded = loadGateConfigFile('/tmp/heimdall-definitely-missing-config.json');
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error).toMatch(/cannot read/);
    }
  });
});

describe('resolveConfigPath', () => {
  it('prefers an explicit --config path when that file exists', () => {
    withLookupDirs('Repo', ({ gitRoot, env, lookupName }) => {
      const explicit = writeConfig(path.join(gitRoot, 'custom.heimdall.json'));
      writeConfig(path.join(gitRoot, DEFAULT_CONFIG_NAME));
      const looked = resolveConfigPath(gitRoot, gitRoot, lookupName, 'custom.heimdall.json', env);
      expect(looked).toEqual({ ok: true, value: explicit });
    });
  });

  it('uses <git root>/heimdall.config.json when --config is omitted', () => {
    withLookupDirs('Repo', ({ gitRoot, env, lookupName }) => {
      const inRepo = writeConfig(path.join(gitRoot, DEFAULT_CONFIG_NAME));
      const looked = resolveConfigPath(gitRoot, gitRoot, lookupName, undefined, env);
      expect(looked).toEqual({ ok: true, value: inRepo });
    });
  });

  it('falls back to <git root>/gate.config.json when heimdall.config.json is absent', () => {
    withLookupDirs('Repo', ({ gitRoot, env, lookupName }) => {
      const legacy = writeConfig(path.join(gitRoot, LEGACY_CONFIG_NAME));
      const looked = resolveConfigPath(gitRoot, gitRoot, lookupName, undefined, env);
      expect(looked).toEqual({ ok: true, value: legacy });
    });
  });

  it('prefers in-repo heimdall.config.json over in-repo gate.config.json', () => {
    withLookupDirs('Repo', ({ gitRoot, env, lookupName }) => {
      const current = writeConfig(path.join(gitRoot, DEFAULT_CONFIG_NAME));
      writeConfig(path.join(gitRoot, LEGACY_CONFIG_NAME));
      const looked = resolveConfigPath(gitRoot, gitRoot, lookupName, undefined, env);
      expect(looked).toEqual({ ok: true, value: current });
    });
  });

  it('uses $HEIMDALL_HOME/<name>/heimdall.config.json when the git root has none', () => {
    withLookupDirs('Repo', ({ gitRoot, gateHome, env, lookupName }) => {
      const homeConfig = writeConfig(path.join(gateHome, 'Repo', DEFAULT_CONFIG_NAME));
      const looked = resolveConfigPath(gitRoot, gitRoot, lookupName, undefined, env);
      expect(looked).toEqual({ ok: true, value: homeConfig });
    });
  });

  it('falls back to $HEIMDALL_HOME/<name>/gate.config.json', () => {
    withLookupDirs('Repo', ({ gitRoot, gateHome, env, lookupName }) => {
      const homeConfig = writeConfig(path.join(gateHome, 'Repo', LEGACY_CONFIG_NAME));
      const looked = resolveConfigPath(gitRoot, gitRoot, lookupName, undefined, env);
      expect(looked).toEqual({ ok: true, value: homeConfig });
    });
  });

  it('falls back to a lowercased $HEIMDALL_HOME folder (MyApp finds myapp)', () => {
    withLookupDirs('MyApp', ({ gitRoot, gateHome, env, lookupName }) => {
      const homeConfig = writeConfig(path.join(gateHome, 'myapp', DEFAULT_CONFIG_NAME));
      const looked = resolveConfigPath(gitRoot, gitRoot, lookupName, undefined, env);
      expect(looked).toEqual({ ok: true, value: homeConfig });
    });
  });

  it('prefers the as-is $HEIMDALL_HOME folder over the lowercased one', () => {
    withLookupDirs('MyApp', ({ gitRoot, gateHome, env, lookupName }) => {
      const asIs = writeConfig(path.join(gateHome, 'MyApp', DEFAULT_CONFIG_NAME));
      writeConfig(path.join(gateHome, 'myapp', DEFAULT_CONFIG_NAME));
      const looked = resolveConfigPath(gitRoot, gitRoot, lookupName, undefined, env);
      expect(looked).toEqual({ ok: true, value: asIs });
    });
  });

  it('prefers the in-repo config over $HEIMDALL_HOME', () => {
    withLookupDirs('Repo', ({ gitRoot, gateHome, env, lookupName }) => {
      const inRepo = writeConfig(path.join(gitRoot, DEFAULT_CONFIG_NAME));
      writeConfig(path.join(gateHome, 'Repo', DEFAULT_CONFIG_NAME));
      const looked = resolveConfigPath(gitRoot, gitRoot, lookupName, undefined, env);
      expect(looked).toEqual({ ok: true, value: inRepo });
    });
  });

  it('honours $GATE_HOME as a deprecated alias of $HEIMDALL_HOME', () => {
    withLookupDirs('Repo', ({ gitRoot, gateHome, lookupName }) => {
      const homeConfig = writeConfig(path.join(gateHome, 'Repo', DEFAULT_CONFIG_NAME));
      const looked = resolveConfigPath(gitRoot, gitRoot, lookupName, undefined, { GATE_HOME: gateHome });
      expect(looked).toEqual({ ok: true, value: homeConfig });
    });
  });

  it('prefers $HEIMDALL_HOME over $GATE_HOME when both are set', () => {
    withLookupDirs('Repo', ({ gitRoot, gateHome, lookupName }) => {
      const preferred = writeConfig(path.join(gateHome, 'Repo', DEFAULT_CONFIG_NAME));
      const other = path.join(path.dirname(gateHome), 'legacy-home');
      writeConfig(path.join(other, 'Repo', DEFAULT_CONFIG_NAME));
      const looked = resolveConfigPath(gitRoot, gitRoot, lookupName, undefined, {
        HEIMDALL_HOME: gateHome,
        GATE_HOME: other,
      });
      expect(looked).toEqual({ ok: true, value: preferred });
    });
  });

  it('does not fall through when --config is missing; the error lists that path only', () => {
    withLookupDirs('Repo', ({ gitRoot, gateHome, env, lookupName }) => {
      writeConfig(path.join(gitRoot, DEFAULT_CONFIG_NAME));
      writeConfig(path.join(gateHome, 'Repo', DEFAULT_CONFIG_NAME));
      const explicit = path.join(gitRoot, 'missing.heimdall.json');
      const looked = resolveConfigPath(gitRoot, gitRoot, lookupName, 'missing.heimdall.json', env);
      expect(looked.ok).toBe(false);
      if (!looked.ok) {
        expect(looked.error).toContain(explicit);
        expect(looked.error).not.toContain(path.join(gitRoot, DEFAULT_CONFIG_NAME));
        expect(looked.error).not.toContain(path.join(gateHome, 'Repo', DEFAULT_CONFIG_NAME));
      }
    });
  });

  it('does not list the same $HEIMDALL_HOME path twice when the folder name is already lowercase', () => {
    // Unique name so a real ~/.heimdall/my-app cannot satisfy this lookup.
    withLookupDirs('lookupcase', ({ gitRoot, gateHome, env, lookupName }) => {
      const looked = resolveConfigPath(gitRoot, gitRoot, lookupName, undefined, env);
      expect(looked.ok).toBe(false);
      if (!looked.ok) {
        const homePath = path.join(gateHome, 'lookupcase', DEFAULT_CONFIG_NAME);
        expect(looked.error.split(homePath)).toHaveLength(2);
      }
    });
  });

  it('is a GATE ERROR that lists every path it tried, including lowercase and the legacy filename', () => {
    // Unique name so a real ~/.heimdall/my-app cannot satisfy this lookup.
    withLookupDirs('LookupCase', ({ gitRoot, gateHome, env, lookupName }) => {
      const looked = resolveConfigPath(gitRoot, gitRoot, lookupName, undefined, env);
      expect(looked.ok).toBe(false);
      if (!looked.ok) {
        expect(looked.error).toMatch(/no heimdall.config.json found/);
        expect(looked.error).toContain(path.join(gitRoot, DEFAULT_CONFIG_NAME));
        expect(looked.error).toContain(path.join(gitRoot, LEGACY_CONFIG_NAME));
        expect(looked.error).toContain(path.join(gateHome, 'LookupCase', DEFAULT_CONFIG_NAME));
        expect(looked.error).toContain(path.join(gateHome, 'lookupcase', DEFAULT_CONFIG_NAME));
        expect(looked.error).toContain(path.join(heimdallFallbackHome(), 'LookupCase', DEFAULT_CONFIG_NAME));
        expect(looked.error).toContain(path.join(heimdallFallbackHome(), 'lookupcase', DEFAULT_CONFIG_NAME));
        expect(looked.error).toContain(path.join(compatibilityGateHome(), 'LookupCase', DEFAULT_CONFIG_NAME));
        expect(looked.error).toContain(path.join(compatibilityGateHome(), 'lookupcase', DEFAULT_CONFIG_NAME));
      }
    });
  });

  it('uses the git common-dir name, not the worktree folder basename', () => {
    withLookupDirs('foo-feat-s03', ({ gitRoot, gateHome, env, lookupName }) => {
      const homeConfig = writeConfig(path.join(gateHome, 'foo', DEFAULT_CONFIG_NAME));
      writeConfig(path.join(gateHome, 'foo-feat-s03', DEFAULT_CONFIG_NAME));
      const looked = resolveConfigPath(gitRoot, gitRoot, lookupName, undefined, env);
      expect(looked).toEqual({ ok: true, value: homeConfig });
    }, 'foo');
  });

  it('lists only the common-dir name in a GATE ERROR, not the worktree folder basename', () => {
    withLookupDirs('foo-feat-s03', ({ gitRoot, gateHome, env, lookupName }) => {
      const looked = resolveConfigPath(gitRoot, gitRoot, lookupName, undefined, env);
      expect(looked.ok).toBe(false);
      if (!looked.ok) {
        expect(looked.error).toContain(path.join(gateHome, 'foo', DEFAULT_CONFIG_NAME));
        expect(looked.error).not.toContain(path.join(gateHome, 'foo-feat-s03', DEFAULT_CONFIG_NAME));
      }
    }, 'foo');
  });

  it('defaults $HEIMDALL_HOME to this CLI configs/ folder, then ~/.heimdall, then ~/.gate', () => {
    // Unique folder name so this cannot match a real configs/<repo> or home folder.
    const unique = `heimdall-default-home-${process.pid}-${Date.now()}`;
    const gitRoot = path.join(os.tmpdir(), unique);
    const looked = resolveConfigPath('/cwd', gitRoot, unique, undefined, {});
    expect(looked.ok).toBe(false);
    if (!looked.ok) {
      const packagePath = path.join(packageConfigsDir(), unique, DEFAULT_CONFIG_NAME);
      const heimdallPath = path.join(heimdallFallbackHome(), unique, DEFAULT_CONFIG_NAME);
      const legacyPath = path.join(compatibilityGateHome(), unique, DEFAULT_CONFIG_NAME);
      expect(looked.error).toContain(path.join(gitRoot, DEFAULT_CONFIG_NAME));
      expect(looked.error).toContain(packagePath);
      expect(looked.error).toContain(heimdallPath);
      expect(looked.error).toContain(legacyPath);
      expect(looked.error.indexOf(packagePath)).toBeLessThan(looked.error.indexOf(heimdallPath));
      expect(looked.error.indexOf(heimdallPath)).toBeLessThan(looked.error.indexOf(legacyPath));
    }
  });
});
