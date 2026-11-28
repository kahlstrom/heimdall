/**
 * Parse tool output into Findings. Unparseable output is a GATE ERROR at the
 * step layer — these functions return Result so the caller can map it.
 */
import { stripAnsi } from './ansi.js';
import { extractJson } from './json.js';
import { err, isRecord, ok, type Finding, type Result, type StepName } from './types.js';

function finding(
  step: StepName,
  file: string,
  line: number,
  rule: string,
  message: string,
  endLine?: number,
): Finding {
  if (endLine === undefined) {
    return { step, file, line, rule, message };
  }
  return { step, file, line, rule, message, endLine };
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Walk ESLint-shaped `{ filePath, messages }[]` output. secretlint `--format json`
 * uses the same envelope. Callers supply the per-message Finding; this loop
 * never reads `message` text.
 */
function forEachFileMessage(
  files: readonly unknown[],
  onMessage: (file: string, message: Record<string, unknown>) => void,
): void {
  for (const entry of files) {
    if (!isRecord(entry)) {
      continue;
    }
    const file = asString(entry.filePath, '');
    if (!file || !Array.isArray(entry.messages)) {
      continue;
    }
    for (const message of entry.messages) {
      if (!isRecord(message)) {
        continue;
      }
      onMessage(file, message);
    }
  }
}

export type EslintParsed = {
  readonly errors: readonly Finding[];
  readonly warnings: readonly Finding[];
};

/**
 * ESLint JSON formatter (`-f json`). ESLint 9 dropped the unix formatter from core.
 * Severity 2+ is an error; severity 1 is a warning. The step ignores warnings
 * unless `steps.eslint.maxWarnings` is set.
 */
export function parseEslintOutput(output: string): Result<EslintParsed> {
  const json = extractJson(output);
  if (json.ok) {
    return parseEslintJson(json.value);
  }
  return err(`eslint output is not JSON (${json.error})`);
}

function parseEslintJson(value: unknown): Result<EslintParsed> {
  if (!Array.isArray(value)) {
    return err('eslint JSON must be an array of file results');
  }
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  forEachFileMessage(value, (file, message) => {
    const severity = asNumber(message.severity, 2);
    if (severity < 1) {
      return;
    }
    const line = asNumber(message.line, 0);
    const rule = asString(message.ruleId, 'eslint');
    const text = asString(message.message, severity >= 2 ? 'eslint error' : 'eslint warning');
    const messageId = asString(message.messageId, '');
    const hit = finding('eslint', file, line, rule || 'eslint', text);
    const withId = messageId === '' ? hit : { ...hit, messageId };
    if (severity >= 2) {
      errors.push(withId);
    } else {
      warnings.push(withId);
    }
  });
  return ok({ errors, warnings });
}

/**
 * knip JSON reporter (pinned 5.x): `{ files: [...unused files], issues: [...rows] }`.
 * Unknown non-empty keys are a GATE ERROR so a new knip issue type cannot vanish.
 */
const KNIP_TOP_LEVEL_KEYS = new Set(['files', 'issues']);
const KNIP_ROW_METADATA_KEYS = new Set(['file', 'owners']);
const KNIP_ITEM_ARRAY_KEYS = new Set([
  'dependencies',
  'devDependencies',
  'optionalPeerDependencies',
  'unlisted',
  'binaries',
  'unresolved',
  'exports',
  'nsExports',
  'types',
  'nsTypes',
  'catalog',
]);
const KNIP_MEMBER_OBJECT_KEYS = new Set(['enumMembers', 'classMembers']);
const KNIP_NESTED_ARRAY_KEYS = new Set(['duplicates']);

type KnipStepName = 'knip' | 'knip-production';

export function parseKnipOutput(output: string, step: KnipStepName = 'knip'): Result<Finding[]> {
  const json = extractJson(output);
  if (!json.ok) {
    return err(`${step} output is not JSON: ${json.error}`);
  }
  return parseKnipJson(json.value, step);
}

export function parseKnipJson(value: unknown, step: KnipStepName): Result<Finding[]> {
  if (!isRecord(value)) {
    return err('knip JSON must be an object');
  }
  const unknownTop = unknownNonEmptyKeys(value, KNIP_TOP_LEVEL_KEYS);
  if (unknownTop) {
    return err(`knip JSON has unknown key ${JSON.stringify(unknownTop)}`);
  }

  const findings: Finding[] = [];
  if (value.files !== undefined) {
    const files = parseKnipUnusedFiles(value.files, step);
    if (!files.ok) {
      return files;
    }
    findings.push(...files.value);
  }
  if (value.issues !== undefined) {
    if (!Array.isArray(value.issues)) {
      return err('knip JSON issues must be an array');
    }
    for (const entry of value.issues) {
      if (!isRecord(entry)) {
        continue;
      }
      const row = parseKnipIssueRow(entry, step);
      if (!row.ok) {
        return row;
      }
      findings.push(...row.value);
    }
  }
  return ok(findings);
}

function parseKnipUnusedFiles(files: unknown, step: KnipStepName): Result<Finding[]> {
  if (!Array.isArray(files)) {
    return err('knip JSON files must be an array');
  }
  const findings: Finding[] = [];
  for (const item of files) {
    if (typeof item === 'string' && item) {
      findings.push(finding(step, item, 0, 'files', item));
      continue;
    }
    if (isRecord(item)) {
      const name = asString(item.name, '');
      if (name) {
        findings.push(finding(step, name, 0, 'files', name));
      }
    }
  }
  return ok(findings);
}

function parseKnipIssueRow(entry: Record<string, unknown>, step: KnipStepName): Result<Finding[]> {
  const file = asString(entry.file, '');
  if (!file) {
    return ok([]);
  }
  const findings: Finding[] = [];
  for (const [key, value] of Object.entries(entry)) {
    if (KNIP_ROW_METADATA_KEYS.has(key) || !isNonEmptyKnipValue(value)) {
      continue;
    }
    if (KNIP_MEMBER_OBJECT_KEYS.has(key)) {
      const members = addKnipMembers(findings, file, key, value, step);
      if (!members.ok) {
        return members;
      }
      continue;
    }
    if (KNIP_NESTED_ARRAY_KEYS.has(key)) {
      const groups = addKnipDuplicateGroups(findings, file, value, step);
      if (!groups.ok) {
        return groups;
      }
      continue;
    }
    if (KNIP_ITEM_ARRAY_KEYS.has(key)) {
      addKnipItems(findings, file, key, value, step);
      continue;
    }
    return err(`knip JSON has unknown issue type ${JSON.stringify(key)}`);
  }
  return ok(findings);
}

function addKnipItems(
  findings: Finding[],
  file: string,
  rule: string,
  items: unknown,
  step: KnipStepName,
): void {
  if (!Array.isArray(items)) {
    return;
  }
  for (const item of items) {
    if (typeof item === 'string') {
      findings.push(finding(step, file, 0, rule, item));
      continue;
    }
    if (!isRecord(item)) {
      continue;
    }
    const name = asString(item.name, '');
    if (!name) {
      continue;
    }
    findings.push(finding(step, file, asNumber(item.line, 0), rule, name));
  }
}

function addKnipMembers(
  findings: Finding[],
  file: string,
  rule: string,
  value: unknown,
  step: KnipStepName,
): Result<void> {
  if (!isRecord(value)) {
    return err(`knip JSON ${rule} must be an object of member arrays`);
  }
  for (const [parent, items] of Object.entries(value)) {
    if (!Array.isArray(items)) {
      return err(`knip JSON ${rule}.${parent} must be an array`);
    }
    for (const item of items) {
      if (!isRecord(item)) {
        continue;
      }
      const name = asString(item.name, '');
      if (!name) {
        continue;
      }
      const message = parent ? `${parent}.${name}` : name;
      findings.push(finding(step, file, asNumber(item.line, 0), rule, message));
    }
  }
  return ok(undefined);
}

function addKnipDuplicateGroups(
  findings: Finding[],
  file: string,
  value: unknown,
  step: KnipStepName,
): Result<void> {
  if (!Array.isArray(value)) {
    return err('knip JSON duplicates must be an array of groups');
  }
  for (const group of value) {
    if (!Array.isArray(group)) {
      return err('knip JSON duplicates entries must be arrays of symbols');
    }
    const names: string[] = [];
    let line = 0;
    for (const item of group) {
      if (!isRecord(item)) {
        continue;
      }
      const name = asString(item.name, '');
      if (!name) {
        continue;
      }
      if (names.length === 0) {
        line = asNumber(item.line, 0);
      }
      names.push(name);
    }
    if (names.length > 0) {
      findings.push(finding(step, file, line, 'duplicates', names.join('|')));
    }
  }
  return ok(undefined);
}

function isNonEmptyKnipValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isRecord(value)) {
    return Object.keys(value).length > 0;
  }
  if (typeof value === 'string') {
    return value.length > 0;
  }
  return true;
}

function unknownNonEmptyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): string | undefined {
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key) && isNonEmptyKnipValue(item)) {
      return key;
    }
  }
  return undefined;
}

/**
 * jscpd JSON reporter: `{ duplicates: [{ firstFile, secondFile }] }`.
 */
export function parseJscpdOutput(output: string): Result<Finding[]> {
  const json = extractJson(output);
  if (!json.ok) {
    return err(`jscpd output is not JSON: ${json.error}`);
  }
  return parseJscpdJson(json.value);
}

export function parseJscpdJson(value: unknown): Result<Finding[]> {
  if (!isRecord(value) || !Array.isArray(value.duplicates)) {
    return err('jscpd JSON must be an object with a duplicates array');
  }
  const findings: Finding[] = [];
  for (const dup of value.duplicates) {
    if (!isRecord(dup)) {
      continue;
    }
    const first = fileLoc(dup.firstFile);
    const second = fileLoc(dup.secondFile);
    if (!first || !second) {
      continue;
    }
    const lines = asNumber(dup.lines, 0);
    const message = `duplicate of ${second.file}:${second.start}-${second.end} (${lines} lines)`;
    findings.push(finding('jscpd', first.file, first.start, 'duplicate', message, first.end));
    findings.push(
      finding(
        'jscpd',
        second.file,
        second.start,
        'duplicate',
        `duplicate of ${first.file}:${first.start}-${first.end} (${lines} lines)`,
        second.end,
      ),
    );
  }
  return ok(findings);
}

function fileLoc(value: unknown): { file: string; start: number; end: number } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const file = asString(value.name, asString(value.path, ''));
  if (!file) {
    return undefined;
  }
  const start = asNumber(value.start, 1);
  const end = asNumber(value.end, start);
  return { file, start, end };
}

/**
 * secretlint `--format json` (pinned 14.x). Results are an ESLint-like array of
 * `{ filePath, messages }`. Each message has `ruleId` and `loc.start.line`
 * (and sometimes `line` when a lint formatter converted the result).
 *
 * Findings never copy `message`, `data`, `raw`, or `sourceContent`: those fields
 * can hold the matched secret. Reports print rule id, file, and line only.
 */
export function parseSecretsOutput(output: string): Result<Finding[]> {
  const json = extractJson(output);
  if (!json.ok) {
    // Never embed json.error: JSON.parse quotes the input, which may be a secret.
    return err('secrets output is not JSON');
  }
  return parseSecretsJson(json.value);
}

export function parseSecretsJson(value: unknown): Result<Finding[]> {
  if (!Array.isArray(value)) {
    return err('secrets JSON must be an array of file results');
  }
  const findings: Finding[] = [];
  forEachFileMessage(value, (file, message) => {
    const rule = asString(message.ruleId, 'secrets') || 'secrets';
    findings.push(finding('secrets', file, secretlintMessageLine(message), rule, ''));
  });
  return ok(findings);
}

function secretlintMessageLine(message: Record<string, unknown>): number {
  if (typeof message.line === 'number' && Number.isFinite(message.line)) {
    return message.line;
  }
  if (!isRecord(message.loc)) {
    return 0;
  }
  if (typeof message.loc.line === 'number' && Number.isFinite(message.loc.line)) {
    return message.loc.line;
  }
  if (isRecord(message.loc.start)) {
    return asNumber(message.loc.start.line, 0);
  }
  return 0;
}

/**
 * dependency-cruiser `--output-type json` (pinned 18.x):
 * `{ summary: { violations: [{ from, to, rule: { name, severity }, cycle? }] } }`.
 * Only `severity: "error"` counts. Cycle findings use the cycle path; others
 * use `from -> to`. Identity is rule + from + to (+ cycle), not line numbers.
 *
 * 18.x `cycle` is `IMiniDependency[]` (`{ name, dependencyTypes }`); string
 * entries are accepted so a fixture can pin just the path.
 */
export function parseArchitectureOutput(output: string): Result<Finding[]> {
  const json = extractJson(output);
  if (!json.ok) {
    return err(`architecture output is not JSON: ${json.error}`);
  }
  return parseArchitectureJson(json.value);
}

export function parseArchitectureJson(value: unknown): Result<Finding[]> {
  if (!isRecord(value) || !isRecord(value.summary) || !Array.isArray(value.summary.violations)) {
    return err('architecture JSON must be an object with summary.violations[]');
  }
  const findings: Finding[] = [];
  for (const entry of value.summary.violations) {
    if (!isRecord(entry) || !isRecord(entry.rule)) {
      continue;
    }
    if (asString(entry.rule.severity, '') !== 'error') {
      continue;
    }
    const from = asString(entry.from, '');
    const to = asString(entry.to, '');
    const rule = asString(entry.rule.name, '');
    if (!from || !to || !rule) {
      continue;
    }
    findings.push(
      finding('architecture', from, 0, rule, architectureFindingMessage(from, to, architectureCycleNames(entry.cycle))),
    );
  }
  return ok(findings);
}

function architectureCycleNames(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item) {
      names.push(item);
      continue;
    }
    if (isRecord(item)) {
      const name = asString(item.name, '');
      if (name) {
        names.push(name);
      }
    }
  }
  return names.length > 0 ? names : undefined;
}

/**
 * Cycle path is the reported finding (and the identity's extra key). Regular
 * violations use `from -> to` so two edges of the same rule stay distinct.
 */
function architectureFindingMessage(
  from: string,
  to: string,
  cycle: readonly string[] | undefined,
): string {
  if (cycle === undefined || cycle.length === 0) {
    return `${from} -> ${to}`;
  }
  const names = cycle[0] === from ? cycle : [from, ...cycle];
  return names.join(' -> ');
}

/**
 * tsc pretty and `file(line,col): error TSxxxx:` formats.
 */
export function parseTypecheckOutput(output: string): Result<Finding[]> {
  const findings: Finding[] = [];
  const paren = /^(.+?)\((\d+),\d+\):\s+error\s+(TS\d+):\s+(.+)$/;
  const colon = /^(.+?):(\d+):\d+\s+-\s+error\s+(TS\d+):\s+(.+)$/;
  for (const raw of stripAnsi(output).split('\n')) {
    const trimmed = raw.trim();
    const match = paren.exec(trimmed) ?? colon.exec(trimmed);
    if (!match) {
      continue;
    }
    findings.push(
      finding('typecheck', match[1] ?? '', Number.parseInt(match[2] ?? '0', 10), match[3] ?? 'TS', match[4] ?? ''),
    );
  }
  return ok(findings);
}
