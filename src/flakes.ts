/**
 * Known-flake handling is by file plus full title, never a whole file and
 * never a bare leaf name. A leaf like "renders" would excuse every suite.
 */
import { stripAnsi } from './ansi.js';
import { extractJsonWhere } from './json.js';
import { isRecord } from './types.js';

export type FailedTest = {
  readonly file: string;
  readonly name: string;
};

/**
 * `test` is a named case that a flake can match. Everything else is a real
 * failure the flake list cannot forgive: load errors, hooks, unhandled
 * rejections, and count mismatches with no `FAIL file > title` line.
 */
type TestFailureKind = 'test' | 'file-load' | 'hook' | 'unhandled' | 'unparsed';

export type TestFailure = FailedTest & {
  readonly kind: TestFailureKind;
};

type FlakeId = {
  readonly file: string;
  readonly title: string;
};

const UNPARSED_FAILURE: TestFailure = {
  kind: 'unparsed',
  file: '',
  name: 'failure with no FAIL file > title line',
};

const FLAKE_SEP = ' > ';

/**
 * Config entries are `file > suite > title`. Split on the first separator so
 * the title can still contain ` > `.
 */
export function parseFlakeId(entry: string): FlakeId | undefined {
  const at = entry.indexOf(FLAKE_SEP);
  if (at <= 0) {
    return undefined;
  }
  const file = entry.slice(0, at).trim();
  const title = entry.slice(at + FLAKE_SEP.length).trim();
  if (!file || !title) {
    return undefined;
  }
  return { file, title };
}

function filesMatchFlake(actualFile: string, flakeFile: string): boolean {
  const actual = actualFile.replaceAll('\\', '/');
  const flake = flakeFile.replaceAll('\\', '/');
  return actual === flake || actual.endsWith(`/${flake}`);
}

export function testMatchesFlake(test: FailedTest, flake: string): boolean {
  const id = parseFlakeId(flake);
  if (!id) {
    return false;
  }
  return filesMatchFlake(test.file, id.file) && test.name === id.title;
}

function isTestReporterJson(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Array.isArray(value.testResults);
}

function assertionTitle(assertion: Record<string, unknown>): string {
  const ancestors = Array.isArray(assertion.ancestorTitles)
    ? assertion.ancestorTitles.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
  const title = typeof assertion.title === 'string' ? assertion.title : '';
  return [...ancestors, title].filter((part) => part.length > 0).join(' > ');
}

function isFailedStatus(value: unknown): boolean {
  return value === 'failed' || value === 'fail';
}

function failureKey(failure: TestFailure): string {
  return `${failure.kind}::${failure.file}::${failure.name}`;
}

function addFailure(failures: TestFailure[], seen: Set<string>, failure: TestFailure): void {
  const key = failureKey(failure);
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  failures.push(failure);
}

function parseReporterJson(value: Record<string, unknown>): TestFailure[] {
  const failures: TestFailure[] = [];
  const seen = new Set<string>();
  const testResults = value.testResults;
  if (!Array.isArray(testResults)) {
    return failures;
  }
  let namedCount = 0;
  for (const result of testResults) {
    if (!isRecord(result)) {
      continue;
    }
    const file = typeof result.name === 'string' ? result.name.replaceAll('\\', '/') : '';
    const assertions = Array.isArray(result.assertionResults) ? result.assertionResults : [];
    let failedAssertions = 0;
    for (const assertion of assertions) {
      if (!isRecord(assertion) || !isFailedStatus(assertion.status)) {
        continue;
      }
      failedAssertions += 1;
      namedCount += 1;
      addFailure(failures, seen, {
        kind: 'test',
        file,
        name: assertionTitle(assertion),
      });
    }
    if (isFailedStatus(result.status) && failedAssertions === 0) {
      const kind: TestFailureKind = assertions.length === 0 ? 'file-load' : 'hook';
      addFailure(failures, seen, {
        kind,
        file,
        name: kind === 'file-load' ? 'test file failed to load' : 'failing hook',
      });
    }
  }
  const reportedFailed =
    typeof value.numFailedTests === 'number' && Number.isFinite(value.numFailedTests)
      ? value.numFailedTests
      : namedCount;
  for (let extra = namedCount; extra < reportedFailed; extra += 1) {
    addFailure(failures, seen, UNPARSED_FAILURE);
  }
  return failures;
}

const VITEST_NAMED = /^\s*FAIL\s+(?:\|[^|\n]+\|\s+)?(\S+)\s+>\s+(.+?)\s*$/;
const VITEST_LOAD = /^\s*FAIL\s+(?:\|[^|\n]+\|\s+)?(\S+)\s+\[\s+\1\s+\]\s*$/;
const JEST_BULLET = /^\s*●\s+(.+?)\s*$/;
const JEST_FAIL_FILE = /^\s*FAIL\s+(\S+)\s*$/;

function matchCount(output: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(output);
  if (!match || match[1] === undefined) {
    return undefined;
  }
  const count = Number(match[1]);
  return Number.isFinite(count) ? count : undefined;
}

function reconcileTextCounts(output: string, failures: TestFailure[], seen: Set<string>): void {
  const named = failures.filter((item) => item.kind === 'test').length;
  const testsFailed =
    matchCount(output, /^\s*Tests\s+(\d+)\s+failed/m) ??
    matchCount(output, /^\s*Tests:\s+(\d+)\s+failed/m);
  if (testsFailed !== undefined) {
    for (let extra = named; extra < testsFailed; extra += 1) {
      addFailure(failures, seen, UNPARSED_FAILURE);
    }
  }
  const filesFailed =
    matchCount(output, /^\s*Test Files\s+(\d+)\s+failed/m) ??
    matchCount(output, /^\s*Test Suites:\s+(\d+)\s+failed/m);
  const coveredFiles = new Set(failures.map((item) => item.file).filter((file) => file.length > 0)).size;
  if (filesFailed !== undefined) {
    for (let extra = coveredFiles; extra < filesFailed; extra += 1) {
      addFailure(failures, seen, UNPARSED_FAILURE);
    }
  }
  const errors = matchCount(output, /^\s*Errors\s+(\d+)\s+error/m);
  if (errors !== undefined && errors > 0) {
    addFailure(failures, seen, { kind: 'unhandled', file: '', name: 'unhandled error' });
  }
}

function parseTextFailures(output: string): TestFailure[] {
  const failures: TestFailure[] = [];
  const seen = new Set<string>();
  let section: 'suites' | 'tests' | 'unhandled' | undefined;
  let jestFile = '';

  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.includes('Failed Suites')) {
      section = 'suites';
      continue;
    }
    if (line.includes('Failed Tests')) {
      section = 'tests';
      continue;
    }
    if (line.includes('Unhandled Errors')) {
      section = 'unhandled';
      addFailure(failures, seen, { kind: 'unhandled', file: '', name: 'unhandled error' });
      continue;
    }

    const load = VITEST_LOAD.exec(line);
    if (load && load[1]) {
      addFailure(failures, seen, {
        kind: 'file-load',
        file: load[1],
        name: 'test file failed to load',
      });
      continue;
    }

    const named = VITEST_NAMED.exec(line);
    if (named && named[1] && named[2]) {
      const kind: TestFailureKind = section === 'suites' ? 'hook' : 'test';
      addFailure(failures, seen, {
        kind,
        file: named[1],
        name: named[2].trim(),
      });
      continue;
    }

    const jestFail = JEST_FAIL_FILE.exec(line);
    if (jestFail && jestFail[1] && !line.includes('>')) {
      jestFile = jestFail[1];
      continue;
    }

    const bullet = JEST_BULLET.exec(line);
    if (bullet && bullet[1]) {
      const title = bullet[1].replace(/\s+›\s+/g, ' > ').trim();
      if (/test suite failed to run/i.test(title)) {
        addFailure(failures, seen, {
          kind: 'file-load',
          file: jestFile,
          name: 'test file failed to load',
        });
      } else {
        addFailure(failures, seen, { kind: 'test', file: jestFile, name: title });
      }
    }
  }

  reconcileTextCounts(output, failures, seen);
  return failures;
}

/**
 * Prefer vitest/jest JSON (`testResults`) on stdout. Fall back to scraping
 * FAIL lines and the summary. JSON does not record unhandled errors, so those
 * are still taken from text when present.
 */
export function parseTestRun(stdout: string, combined: string): readonly TestFailure[] | undefined {
  const cleanStdout = stripAnsi(stdout);
  const cleanCombined = stripAnsi(combined);
  const reporter = extractJsonWhere(cleanStdout, isTestReporterJson);
  if (reporter.ok && isTestReporterJson(reporter.value)) {
    const failures = parseReporterJson(reporter.value);
    const seen = new Set(failures.map(failureKey));
    for (const extra of parseTextFailures(cleanCombined)) {
      if (extra.kind === 'unhandled') {
        addFailure(failures, seen, extra);
      }
    }
    return failures;
  }
  const textFailures = parseTextFailures(cleanCombined);
  if (textFailures.length === 0) {
    return undefined;
  }
  return textFailures;
}

export function classifyFailedTests(
  failed: readonly TestFailure[],
  flakes: readonly string[],
): { readonly unknown: TestFailure[]; readonly matched: TestFailure[] } {
  const unknown: TestFailure[] = [];
  const matched: TestFailure[] = [];
  for (const test of failed) {
    const isFlake = test.kind === 'test' && flakes.some((flake) => testMatchesFlake(test, flake));
    if (isFlake) {
      matched.push(test);
    } else {
      unknown.push(test);
    }
  }
  return { unknown, matched };
}
