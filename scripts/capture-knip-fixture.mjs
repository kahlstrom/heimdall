#!/usr/bin/env node
/**
 * Recreate test/fixtures/knip-json-reporter.json from a real knip --reporter json
 * run against the all-issues fixture. Re-run after bumping knip:
 *
 *   node scripts/capture-knip-fixture.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = path.join(ROOT, 'test/helpers/knip-all-issues-files.json');
const OUT = path.join(ROOT, 'test/fixtures/knip-json-reporter.json');
const KNIP_BIN = path.join(ROOT, 'node_modules/.bin/knip');

const files = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-knip-capture-'));
try {
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }
  let stdout = '';
  try {
    stdout = execFileSync(KNIP_BIN, ['--reporter', 'json', '--no-progress'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (cause) {
    if (cause && typeof cause === 'object' && 'stdout' in cause && typeof cause.stdout === 'string') {
      stdout = cause.stdout;
    } else {
      throw cause;
    }
  }
  const parsed = JSON.parse(stdout);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(parsed, null, 2)}\n`);
  process.stdout.write(`wrote ${path.relative(ROOT, OUT)}\n`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
