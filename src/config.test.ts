import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { flakeLooksLikeFile, parseGateConfig } from './config.js';
import { COMMAND_STEP_NAMES, DEFAULT_STEP_TIMEOUT_MS } from './types.js';

describe('tsconfig.json', () => {
  it('includes test files in the default typecheck project', () => {
    const tsconfigPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tsconfig.json');
    const raw: unknown = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));
    expect(raw).toMatchObject({
      compilerOptions: { noEmit: true },
      include: expect.arrayContaining(['src/**/*.ts', 'test/**/*.ts']),
    });
    if (typeof raw === 'object' && raw !== null && 'exclude' in raw) {
      expect(raw.exclude).not.toEqual(expect.arrayContaining(['src/**/*.test.ts']));
    }
  });
});

const EXAMPLE_CONFIG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../configs/example/heimdall.config.json',
);
const OWN_CONFIG_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../heimdall.config.json');

describe('configs/example/heimdall.config.json', () => {
  it('does not default baseRef to this branch\'s own upstream', () => {
    const raw: unknown = JSON.parse(fs.readFileSync(EXAMPLE_CONFIG_PATH, 'utf8'));
    expect(raw).not.toHaveProperty('baseRef');
  });

  it('configures the tests step with a JSON reporter', () => {
    const raw: unknown = JSON.parse(fs.readFileSync(EXAMPLE_CONFIG_PATH, 'utf8'));
    expect(raw).toMatchObject({
      steps: { tests: { command: expect.stringContaining('--reporter=json') } },
    });
  });

  it('pins tool commands to local installs with --no-install', () => {
    const raw: unknown = JSON.parse(fs.readFileSync(EXAMPLE_CONFIG_PATH, 'utf8'));
    expect(raw).toMatchObject({
      steps: {
        typecheck: { command: expect.stringContaining('npx --no-install') },
        tests: { command: expect.stringContaining('npx --no-install') },
        eslint: { command: expect.stringContaining('npx --no-install') },
        knip: { command: expect.stringContaining('npx --no-install') },
        jscpd: { command: expect.stringContaining('npx --no-install') },
        secrets: { command: expect.stringContaining('npx --no-install') },
        architecture: { command: expect.stringContaining('npx --no-install') },
      },
    });
  });

  it('shows secrets and architecture present but disabled, with pinned commands and no personal paths', () => {
    const exampleDir = path.dirname(EXAMPLE_CONFIG_PATH);
    const parsed = parseGateConfig(JSON.parse(fs.readFileSync(EXAMPLE_CONFIG_PATH, 'utf8')), EXAMPLE_CONFIG_PATH);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const secretsCommand = parsed.value.steps.secrets?.command ?? '';
    const architectureCommand = parsed.value.steps.architecture?.command ?? '';
    expect(parsed.value.steps.secrets?.enabled).toBe(false);
    expect(parsed.value.steps.architecture?.enabled).toBe(false);
    expect(secretsCommand).toContain('secretlint@14');
    expect(secretsCommand).toContain('--format json');
    expect(secretsCommand).toContain('$HEIMDALL_CONFIG_DIR/.secretlintrc.json');
    expect(architectureCommand).toContain('dependency-cruiser@18');
    expect(architectureCommand).toContain('--output-type json');
    expect(architectureCommand).toContain('$HEIMDALL_CONFIG_DIR/.dependency-cruiser.cjs');
    for (const command of [secretsCommand, architectureCommand]) {
      expect(command).toContain('npx --no-install');
      expect(command).not.toMatch(/\/Users\/|\/home\/|~\/|[A-Za-z]:\\/);
    }
    const secretlintrc: unknown = JSON.parse(
      fs.readFileSync(path.join(exampleDir, '.secretlintrc.json'), 'utf8'),
    );
    expect(secretlintrc).toMatchObject({
      rules: [{ id: '@secretlint/secretlint-rule-preset-recommend' }],
    });
    expect(fs.existsSync(path.join(exampleDir, '.dependency-cruiser.cjs'))).toBe(true);
  });
});

describe('heimdall.config.json', () => {
  it('uses npx --no-install, matches the example jscpd command, and runs knip --production', () => {
    const own = parseGateConfig(
      JSON.parse(fs.readFileSync(OWN_CONFIG_PATH, 'utf8')),
      'heimdall.config.json',
    );
    const example = parseGateConfig(
      JSON.parse(fs.readFileSync(EXAMPLE_CONFIG_PATH, 'utf8')),
      'heimdall.config.json',
    );
    expect(own.ok).toBe(true);
    expect(example.ok).toBe(true);
    if (!own.ok || !example.ok) {
      return;
    }
    for (const name of COMMAND_STEP_NAMES) {
      const command = own.value.steps[name]?.command;
      if (command === undefined) {
        expect(['secrets', 'architecture']).toContain(name);
        continue;
      }
      expect(command).toContain('npx --no-install');
    }
    expect(own.value.steps.secrets).toBeUndefined();
    expect(own.value.steps.architecture).toBeUndefined();
    expect(example.value.steps.secrets?.enabled).toBe(false);
    expect(example.value.steps.architecture?.enabled).toBe(false);
    expect(own.value.steps.jscpd?.command).toBe(example.value.steps.jscpd?.command);
    expect(own.value.steps.knip?.command).toContain('--production');
  });
});

describe('parseGateConfig', () => {
  it('accepts a minimal valid config', () => {
    const parsed = parseGateConfig(
      {
        steps: {
          tests: { command: 'npm test' },
        },
      },
      'heimdall.config.json',
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.steps.tests?.enabled).toBe(true);
      expect(parsed.value.steps.tests?.command).toBe('npm test');
      expect(parsed.value.steps.tests?.timeoutMs).toBe(DEFAULT_STEP_TIMEOUT_MS);
      expect(parsed.value.flakes).toEqual([]);
    }
  });

  it('rejects a non-object', () => {
    const parsed = parseGateConfig([], 'heimdall.config.json');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toMatch(/JSON object/);
    }
  });

  it('rejects unknown top-level keys', () => {
    const parsed = parseGateConfig({ steps: { tests: { command: 't' } }, extra: 1 }, 'x');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toMatch(/unknown key/);
      expect(parsed.error).toMatch(/extra/);
    }
  });

  it('rejects unknown step names', () => {
    const parsed = parseGateConfig({ steps: { tests: { command: 't' }, banana: {} } }, 'x');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toMatch(/banana/);
    }
  });

  it('rejects an enabled command step without a command', () => {
    const parsed = parseGateConfig({ steps: { eslint: { enabled: true } } }, 'x');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toMatch(/steps.eslint.command/);
    }
  });

  it('allows a disabled step without a command', () => {
    const parsed = parseGateConfig(
      { steps: { tests: { command: 't' }, eslint: { enabled: false } } },
      'x',
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.steps.eslint?.enabled).toBe(false);
    }
  });

  it('rejects flake names that look like files', () => {
    const parsed = parseGateConfig(
      { steps: { tests: { command: 't' } }, flakes: ['foo.test.ts'] },
      'x',
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toMatch(/file plus full title, not a whole file/);
    }
  });

  it('rejects flake names that look like paths', () => {
    const parsed = parseGateConfig(
      { steps: { tests: { command: 't' } }, flakes: ['src/foo.test.ts'] },
      'x',
    );
    expect(parsed.ok).toBe(false);
  });

  it('rejects a bare test title as a flake', () => {
    const parsed = parseGateConfig(
      { steps: { tests: { command: 't' } }, flakes: ['times out talking to billing'] },
      'x',
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toMatch(/file plus full title/);
    }
  });

  it('accepts file plus full title as a flake', () => {
    const parsed = parseGateConfig(
      {
        steps: { tests: { command: 't' } },
        flakes: ['src/bill.test.ts > billing > times out talking to billing'],
      },
      'x',
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.flakes).toEqual(['src/bill.test.ts > billing > times out talking to billing']);
    }
  });

  it('rejects zero enabled steps', () => {
    const parsed = parseGateConfig({ steps: { tests: { enabled: false, command: 't' } } }, 'x');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toMatch(/at least one step/);
    }
  });

  it('accepts line-checks as a boolean', () => {
    const parsed = parseGateConfig({ steps: { 'line-checks': true } }, 'x');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.steps['line-checks']?.enabled).toBe(true);
      expect(parsed.value.steps['line-checks']?.allowSilencing).toEqual([]);
    }
  });

  it('accepts steps.line-checks.allowSilencing globs', () => {
    const parsed = parseGateConfig(
      { steps: { 'line-checks': { enabled: true, allowSilencing: ['src/generated/**'] } } },
      'x',
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.steps['line-checks']?.allowSilencing).toEqual(['src/generated/**']);
    }
  });

  it('rejects a non-array allowSilencing', () => {
    const parsed = parseGateConfig(
      { steps: { 'line-checks': { allowSilencing: 'src/generated/**' } } },
      'x',
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toMatch(/steps\.line-checks\.allowSilencing/);
    }
  });

  it('accepts protectedPaths globs and defaults to empty', () => {
    const withPaths = parseGateConfig(
      { steps: { tests: { command: 't' } }, protectedPaths: ['src/generated/**', 'vendor/**'] },
      'x',
    );
    expect(withPaths.ok).toBe(true);
    if (withPaths.ok) {
      expect(withPaths.value.protectedPaths).toEqual(['src/generated/**', 'vendor/**']);
    }
    const absent = parseGateConfig({ steps: { tests: { command: 't' } } }, 'x');
    expect(absent.ok).toBe(true);
    if (absent.ok) {
      expect(absent.value.protectedPaths).toEqual([]);
    }
  });

  it('rejects a non-array or empty-string protectedPaths', () => {
    expect(parseGateConfig({ steps: { tests: { command: 't' } }, protectedPaths: 'secret.ts' }, 'x').ok).toBe(false);
    expect(parseGateConfig({ steps: { tests: { command: 't' } }, protectedPaths: [''] }, 'x').ok).toBe(false);
  });

  it('accepts setup and teardown command lists', () => {
    const parsed = parseGateConfig(
      {
        steps: { tests: { command: 't' } },
        setup: ['echo up'],
        teardown: ['echo down'],
      },
      'x',
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.setup).toEqual(['echo up']);
      expect(parsed.value.teardown).toEqual(['echo down']);
    }
  });

  it('rejects non-boolean enabled flags and non-array setup', () => {
    expect(parseGateConfig({ steps: { tests: { command: 't', enabled: 'yes' } } }, 'x').ok).toBe(false);
    expect(parseGateConfig({ steps: { tests: { command: 't' } }, setup: 'echo up' }, 'x').ok).toBe(false);
    expect(parseGateConfig({ steps: { tests: { command: 't' } }, teardown: [1] }, 'x').ok).toBe(false);
    expect(parseGateConfig({ baseRef: '' , steps: { tests: { command: 't' } } }, 'x').ok).toBe(false);
  });

  it('defaults requireParentBase to false and maxChangedFiles to 100', () => {
    const parsed = parseGateConfig({ steps: { tests: { command: 't' } } }, 'x');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.requireParentBase).toBe(false);
      expect(parsed.value.maxChangedFiles).toBe(100);
    }
  });

  it('accepts requireParentBase true and a positive maxChangedFiles', () => {
    const parsed = parseGateConfig(
      { steps: { tests: { command: 't' } }, requireParentBase: true, maxChangedFiles: 50 },
      'x',
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.requireParentBase).toBe(true);
      expect(parsed.value.maxChangedFiles).toBe(50);
    }
  });

  it('rejects a non-boolean requireParentBase', () => {
    const parsed = parseGateConfig({ steps: { tests: { command: 't' } }, requireParentBase: 'yes' }, 'x');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toMatch(/requireParentBase must be a boolean/);
    }
  });

  it('rejects a non-positive or non-integer maxChangedFiles', () => {
    const zero = parseGateConfig({ steps: { tests: { command: 't' } }, maxChangedFiles: 0 }, 'x');
    expect(zero.ok).toBe(false);
    if (!zero.ok) {
      expect(zero.error).toMatch(/maxChangedFiles must be a positive integer/);
    }
    expect(parseGateConfig({ steps: { tests: { command: 't' } }, maxChangedFiles: -1 }, 'x').ok).toBe(false);
    expect(parseGateConfig({ steps: { tests: { command: 't' } }, maxChangedFiles: 1.5 }, 'x').ok).toBe(false);
    expect(parseGateConfig({ steps: { tests: { command: 't' } }, maxChangedFiles: '100' }, 'x').ok).toBe(false);
  });

  it('accepts a per-step timeoutMs override', () => {
    const parsed = parseGateConfig(
      { steps: { tests: { command: 't', timeoutMs: 1500 } } },
      'x',
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.steps.tests?.timeoutMs).toBe(1500);
    }
  });

  it('rejects a non-positive or non-integer timeoutMs', () => {
    expect(parseGateConfig({ steps: { tests: { command: 't', timeoutMs: 0 } } }, 'x').ok).toBe(false);
    expect(parseGateConfig({ steps: { tests: { command: 't', timeoutMs: -1 } } }, 'x').ok).toBe(false);
    expect(parseGateConfig({ steps: { tests: { command: 't', timeoutMs: 1.5 } } }, 'x').ok).toBe(false);
    expect(parseGateConfig({ steps: { tests: { command: 't', timeoutMs: 'fast' } } }, 'x').ok).toBe(false);
  });

  it('accepts a non-negative integer eslint maxWarnings including 0', () => {
    const parsed = parseGateConfig({ steps: { eslint: { command: 'e', maxWarnings: 0 } } }, 'x');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.steps.eslint?.maxWarnings).toBe(0);
    }
  });

  it('leaves eslint maxWarnings unset when the key is absent', () => {
    const parsed = parseGateConfig({ steps: { eslint: { command: 'e' } } }, 'x');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.steps.eslint?.maxWarnings).toBeUndefined();
    }
  });

  it('rejects a negative, non-integer, or non-number eslint maxWarnings as a GATE ERROR', () => {
    const negative = parseGateConfig({ steps: { eslint: { command: 'e', maxWarnings: -1 } } }, 'x');
    expect(negative.ok).toBe(false);
    if (!negative.ok) {
      expect(negative.error).toMatch(/steps\.eslint\.maxWarnings must be a non-negative integer/);
    }
    const fraction = parseGateConfig({ steps: { eslint: { command: 'e', maxWarnings: 1.5 } } }, 'x');
    expect(fraction.ok).toBe(false);
    if (!fraction.ok) {
      expect(fraction.error).toMatch(/steps\.eslint\.maxWarnings must be a non-negative integer/);
    }
    const asString = parseGateConfig({ steps: { eslint: { command: 'e', maxWarnings: '0' } } }, 'x');
    expect(asString.ok).toBe(false);
    if (!asString.ok) {
      expect(asString.error).toMatch(/steps\.eslint\.maxWarnings must be a non-negative integer/);
    }
  });

  it('rejects empty flake strings', () => {
    const parsed = parseGateConfig({ steps: { tests: { command: 't' } }, flakes: [''] }, 'x');
    expect(parsed.ok).toBe(false);
  });

  it('leaves secrets off when omitted and requires a command when enabled', () => {
    const omitted = parseGateConfig({ steps: { tests: { command: 't' } } }, 'x');
    expect(omitted.ok).toBe(true);
    if (omitted.ok) {
      expect(omitted.value.steps.secrets).toBeUndefined();
    }
    const enabled = parseGateConfig({ steps: { secrets: { command: 'secretlint --format json "**/*"' } } }, 'x');
    expect(enabled.ok).toBe(true);
    if (enabled.ok) {
      expect(enabled.value.steps.secrets?.enabled).toBe(true);
      expect(enabled.value.steps.secrets?.command).toBe('secretlint --format json "**/*"');
    }
    const missingCommand = parseGateConfig({ steps: { secrets: { enabled: true } } }, 'x');
    expect(missingCommand.ok).toBe(false);
    if (!missingCommand.ok) {
      expect(missingCommand.error).toMatch(/steps\.secrets\.command/);
    }
  });

  it('leaves architecture off when omitted and requires a command when enabled', () => {
    const omitted = parseGateConfig({ steps: { tests: { command: 't' } } }, 'x');
    expect(omitted.ok).toBe(true);
    if (omitted.ok) {
      expect(omitted.value.steps.architecture).toBeUndefined();
    }
    const enabled = parseGateConfig({
      steps: { architecture: { command: 'depcruise src --output-type json' } },
    }, 'x');
    expect(enabled.ok).toBe(true);
    if (enabled.ok) {
      expect(enabled.value.steps.architecture?.enabled).toBe(true);
      expect(enabled.value.steps.architecture?.command).toBe('depcruise src --output-type json');
    }
    const missingCommand = parseGateConfig({ steps: { architecture: { enabled: true } } }, 'x');
    expect(missingCommand.ok).toBe(false);
    if (!missingCommand.ok) {
      expect(missingCommand.error).toMatch(/steps\.architecture\.command/);
    }
  });
});

describe('package.json tool pins', () => {
  it('pins eslint, knip, jscpd, vitest, and typescript to exact versions', () => {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json');
    const raw: unknown = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    expect(raw).toMatchObject({
      dependencies: expect.any(Object),
      devDependencies: expect.any(Object),
    });
    if (!isPkg(raw)) {
      throw new Error('package.json is not an object');
    }
    const deps = { ...raw.dependencies, ...raw.devDependencies };
    for (const name of ['eslint', 'knip', 'jscpd', 'vitest', 'typescript'] as const) {
      expect(deps[name], name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

function isPkg(value: unknown): value is {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} {
  return typeof value === 'object' && value !== null;
}

describe('flakeLooksLikeFile', () => {
  it('detects extensions and path separators', () => {
    expect(flakeLooksLikeFile('does the thing')).toBe(false);
    expect(flakeLooksLikeFile('foo.test.ts')).toBe(true);
    expect(flakeLooksLikeFile('src/foo')).toBe(true);
  });
});

describe('bundled configs/example', () => {
  it('parses the example config and leaves requireParentBase off', () => {
    const parsed = parseGateConfig(JSON.parse(fs.readFileSync(EXAMPLE_CONFIG_PATH, 'utf8')), EXAMPLE_CONFIG_PATH);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.requireParentBase).toBe(false);
      expect(parsed.value.steps.tests?.enabled).toBe(true);
    }
  });
});
