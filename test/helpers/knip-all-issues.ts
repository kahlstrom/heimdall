/**
 * Shared knip all-issues fixture. Source files live in knip-all-issues-files.json
 * so the capture script and tests write the same project.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const KNIP_ALL_ISSUES_SPEC = path.join(HERE, 'knip-all-issues-files.json');
export const KNIP_JSON_REPORTER_FIXTURE = path.join(HERE, '../fixtures/knip-json-reporter.json');

export const KNIP_BIN = path.resolve(HERE, '../../node_modules/.bin/knip');

export type KnipFixtureFiles = Record<string, string>;

export function loadKnipAllIssuesFiles(): KnipFixtureFiles {
  const raw: unknown = JSON.parse(fs.readFileSync(KNIP_ALL_ISSUES_SPEC, 'utf8'));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${KNIP_ALL_ISSUES_SPEC} must be an object of path → contents`);
  }
  const files: KnipFixtureFiles = {};
  for (const [rel, contents] of Object.entries(raw)) {
    if (typeof contents !== 'string') {
      throw new Error(`${KNIP_ALL_ISSUES_SPEC} value for ${rel} must be a string`);
    }
    files[rel] = contents;
  }
  return files;
}

/**
 * Write the all-issues knip project into `dir`. Used by tests and the capture script.
 */
export function writeKnipAllIssuesFixture(dir: string): void {
  const files = loadKnipAllIssuesFiles();
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }
}

/**
 * Run the pinned knip JSON reporter against `dir` and return stdout.
 * Knip exits 1 when it finds issues; that is still success for capture.
 */
export function runKnipJsonReporter(dir: string): string {
  try {
    return execFileSync(KNIP_BIN, ['--reporter', 'json', '--no-progress'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (cause) {
    // knip exits 1 when it reports issues; stdout is still the JSON document.
    if (cause && typeof cause === 'object' && 'stdout' in cause && typeof cause.stdout === 'string') {
      return cause.stdout;
    }
    throw cause;
  }
}
