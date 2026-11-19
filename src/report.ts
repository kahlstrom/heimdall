/**
 * Human-facing report. Findings are concise and actionable; the summary block
 * is last so a log tail still shows the verdict.
 */
import type { BaseRefSource } from './git.js';
import {
  EXIT_GATE_ERROR,
  EXIT_GREEN,
  EXIT_RED,
  assertNever,
  type Finding,
  type GateOutcome,
  type StepResult,
} from './types.js';

const FINDINGS_WITHOUT_LINE = new Set(['protected-path', 'config-uncommitted']);

export function formatFinding(finding: Finding): string {
  if (FINDINGS_WITHOUT_LINE.has(finding.rule)) {
    return `${finding.file} [${finding.rule}] ${finding.message}`;
  }
  // Secrets findings must never print secretlint's message text or a matched value.
  if (finding.step === 'secrets' || finding.message === '') {
    return `${finding.file}:${finding.line} [${finding.rule}]`;
  }
  // Architecture findings are graph edges, not line hits.
  if (finding.step === 'architecture') {
    return `[${finding.rule}] ${finding.message}`;
  }
  return `${finding.file}:${finding.line} [${finding.rule}] ${finding.message}`;
}

function stepLine(result: StepResult): string {
  switch (result.kind) {
    case 'pass': {
      const excused = result.excused;
      if (excused !== undefined && excused.length > 0) {
        return `${padName(result.name)} pass  (excused ${excused.length}: ${excused.join(', ')})`;
      }
      return `${padName(result.name)} pass`;
    }
    case 'fail':
      return `${padName(result.name)} FAIL  (${result.findings.length})`;
    case 'error':
      return `${padName(result.name)} GATE ERROR  (${result.reason})`;
    case 'skipped':
      return `${padName(result.name)} skip  (${result.reason})`;
    default:
      return assertNever(result, 'unhandled step result');
  }
}

function padName(name: string): string {
  return name.padEnd(12, ' ');
}

export function exitCodeLabel(code: number): string {
  if (code === EXIT_GREEN) return 'GREEN';
  if (code === EXIT_RED) return 'RED';
  if (code === EXIT_GATE_ERROR) return 'GATE ERROR';
  return `unknown (${code})`;
}

function collectFindings(outcome: GateOutcome): readonly Finding[] {
  const fromSteps: Finding[] = [];
  for (const step of outcome.steps) {
    if (step.kind === 'fail') {
      fromSteps.push(...step.findings);
    }
  }
  return fromSteps;
}

function baseSourceLabel(source: BaseRefSource): string {
  switch (source) {
    case 'cli':
      return '(from --base)';
    case 'config':
      return '(from config)';
    case 'upstream':
      return '(from upstream)';
    case 'fallback':
      return '(fallback)';
    default:
      return assertNever(source, 'unhandled base source');
  }
}

/**
 * Printed at the start of every run, before setup and steps.
 * Merge-base is the short sha; the summary still prints the full commit.
 */
export function formatRunPrelude(
  baseRef: string,
  mergeBaseSha: string,
  changedFileCount: number,
  source: BaseRefSource,
): string {
  return `base: ${baseRef} ${baseSourceLabel(source)}\nmerge-base: ${mergeBaseSha.slice(0, 7)}\nchanged files: ${changedFileCount}\n`;
}

/**
 * Loud summary line when the story has no changes versus the resolved base.
 */
export function emptyDiffWarning(baseSpec: string, mergeBaseSha: string): string {
  return `EMPTY DIFF against base ${baseSpec} (${mergeBaseSha}). Scoped steps have nothing to check.`;
}

/**
 * Outside-repo config whose directory is not inside any git work tree
 * (`~/.heimdall`, a loose temp `$HEIMDALL_HOME`). Warning only; the run still proceeds.
 */
export function unversionedConfigWarning(configDir: string): string {
  return `config is not version-controlled (${configDir})`;
}

export function formatReport(outcome: GateOutcome): string {
  const lines: string[] = [];
  const findings = collectFindings(outcome);
  for (const finding of findings) {
    lines.push(formatFinding(finding));
  }
  if (outcome.kind === 'error') {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push(`GATE ERROR: ${outcome.reason}`);
  }
  if (lines.length > 0) {
    lines.push('');
  }
  lines.push('──────── HEIMDALL SUMMARY ────────');
  for (const warning of outcome.warnings) {
    lines.push(`WARNING:  ${warning}`);
  }
  lines.push(`result:   ${exitCodeLabel(outcome.exitCode)}`);
  lines.push(`exit:     ${outcome.exitCode}`);
  if (outcome.configPath) {
    const commit = outcome.configCommit ? `  commit ${outcome.configCommit}` : '';
    lines.push(`config:   ${outcome.configPath}${commit}`);
  }
  lines.push(`base:     ${outcome.baseRef ?? '(none)'}`);
  if (outcome.mergeBaseSha) {
    lines.push(`commit:   ${outcome.mergeBaseSha}`);
  }
  if (outcome.baseSha) {
    lines.push(`resolved: ${outcome.baseSha}`);
  }
  if (outcome.changedFileCount !== undefined) {
    lines.push(`scope:    ${outcome.changedFileCount} files, ${outcome.addedLineCount ?? 0} added lines`);
  }
  for (const step of outcome.steps) {
    lines.push(stepLine(step));
  }
  if (findings.length > 0) {
    lines.push(`findings: ${findings.length}`);
  }
  lines.push('──────────────────────────────────');
  return `${lines.join('\n')}\n`;
}
