/**
 * CLI argument handling. Unknown flags are GATE ERROR, not a crash.
 */
import { formatReport } from './report.js';
import { parseNodeHeapMb, runGate } from './runner.js';
import { EXIT_GATE_ERROR, EXIT_GREEN, errorMessage, type ExitCode } from './types.js';

export const HELP = `Usage: heimdall [--config <path>] [--cwd <path>] [--base <ref>] [--allow-wide] [--node-heap <mb>]

Run Heimdall, the shared quality gate, from inside a target git repo.

  --config <path>   path to heimdall.config.json
                    default: <git-root>/heimdall.config.json, then
                    <git-root>/gate.config.json (deprecated), then
                    $HEIMDALL_HOME/<name>/heimdall.config.json, then
                    ~/.heimdall/<name>/, then ~/.gate/<name>/
                    ($HEIMDALL_HOME defaults to this CLI's configs/ folder;
                    <name> is from the git common dir so a worktree uses
                    the main repo's name; tried as-is then lowercased;
                    GATE_HOME is a deprecated alias)
  --cwd <path>      repo to check (default: current directory)
  --base <ref>      comparison base (overrides config baseRef)
  --allow-wide      continue when the diff exceeds maxChangedFiles
                    (same as HEIMDALL_ALLOW_WIDE=1)
  --node-heap <mb>  append --max-old-space-size=<mb> to child NODE_OPTIONS
                    (positive integer; overrides HEIMDALL_NODE_HEAP_MB)
  -h, --help        show this help

Exit codes:
  0  GREEN       all enabled steps passed
  1  RED         new problems in app code (file:line [rule] message)
  2  GATE ERROR  bad config, missing tool, crash, timeout, or unparseable tool output
`;

export type CliIo = {
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
};

export type ParsedArgs =
  | { readonly kind: 'help' }
  | {
      readonly kind: 'run';
      readonly cwd?: string;
      readonly configPath?: string;
      readonly baseRef?: string;
      readonly allowWide?: boolean;
      readonly nodeHeapMb?: number;
    }
  | { readonly kind: 'error'; readonly reason: string };

type FlagValue =
  | { readonly kind: 'miss' }
  | { readonly kind: 'ok'; readonly value: string; readonly skip: number }
  | { readonly kind: 'error'; readonly reason: string };

/**
 * Space-separated and `--flag=value` forms. A missing or empty value is a
 * usage error; a token that starts with `-` is not a value.
 */
function readFlagValue(
  argv: readonly string[],
  index: number,
  flag: string,
  missingReason: string,
): FlagValue {
  const arg = argv[index];
  if (arg === flag) {
    const value = argv[index + 1];
    if (!value || value.startsWith('-')) {
      return { kind: 'error', reason: missingReason };
    }
    return { kind: 'ok', value, skip: 1 };
  }
  const prefix = `${flag}=`;
  if (typeof arg === 'string' && arg.startsWith(prefix)) {
    const value = arg.slice(prefix.length);
    if (!value) {
      return { kind: 'error', reason: missingReason };
    }
    return { kind: 'ok', value, skip: 0 };
  }
  return { kind: 'miss' };
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let cwd: string | undefined;
  let configPath: string | undefined;
  let baseRef: string | undefined;
  let allowWide = false;
  let nodeHeapMb: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      return { kind: 'help' };
    }
    if (arg === '--allow-wide') {
      allowWide = true;
      continue;
    }
    const cwdValue = readFlagValue(argv, index, '--cwd', '--cwd requires a path');
    if (cwdValue.kind === 'error') {
      return cwdValue;
    }
    if (cwdValue.kind === 'ok') {
      cwd = cwdValue.value;
      index += cwdValue.skip;
      continue;
    }
    const configValue = readFlagValue(argv, index, '--config', '--config requires a path');
    if (configValue.kind === 'error') {
      return configValue;
    }
    if (configValue.kind === 'ok') {
      configPath = configValue.value;
      index += configValue.skip;
      continue;
    }
    const baseValue = readFlagValue(argv, index, '--base', '--base requires a ref');
    if (baseValue.kind === 'error') {
      return baseValue;
    }
    if (baseValue.kind === 'ok') {
      baseRef = baseValue.value;
      index += baseValue.skip;
      continue;
    }
    const nodeHeapValue = readFlagValue(
      argv,
      index,
      '--node-heap',
      '--node-heap requires a positive integer (MB)',
    );
    if (nodeHeapValue.kind === 'error') {
      return nodeHeapValue;
    }
    if (nodeHeapValue.kind === 'ok') {
      const parsed = parseNodeHeapMb(nodeHeapValue.value, '--node-heap');
      if (!parsed.ok) {
        return { kind: 'error', reason: parsed.error };
      }
      nodeHeapMb = parsed.value;
      index += nodeHeapValue.skip;
      continue;
    }
    return { kind: 'error', reason: `unknown argument: ${arg}` };
  }
  const run: {
    kind: 'run';
    cwd?: string;
    configPath?: string;
    baseRef?: string;
    allowWide?: boolean;
    nodeHeapMb?: number;
  } = { kind: 'run' };
  if (cwd !== undefined) {
    run.cwd = cwd;
  }
  if (configPath !== undefined) {
    run.configPath = configPath;
  }
  if (baseRef !== undefined) {
    run.baseRef = baseRef;
  }
  if (allowWide) {
    run.allowWide = true;
  }
  if (nodeHeapMb !== undefined) {
    run.nodeHeapMb = nodeHeapMb;
  }
  return run;
}

export async function main(
  argv: readonly string[],
  defaultCwd: string,
  io: CliIo,
  abortSignal?: AbortSignal,
): Promise<ExitCode> {
  const args = parseArgs(argv);
  if (args.kind === 'help') {
    io.stdout.write(HELP);
    return EXIT_GREEN;
  }
  if (args.kind === 'error') {
    io.stderr.write(`GATE ERROR: ${args.reason}\n`);
    return EXIT_GATE_ERROR;
  }
  try {
    const outcome = await runGate({
      cwd: args.cwd ?? defaultCwd,
      ...(args.configPath !== undefined ? { configPath: args.configPath } : {}),
      ...(args.baseRef !== undefined ? { baseRef: args.baseRef } : {}),
      ...(args.allowWide === true ? { allowWide: true } : {}),
      ...(args.nodeHeapMb !== undefined ? { nodeHeapMb: args.nodeHeapMb } : {}),
      ...(abortSignal !== undefined ? { abortSignal } : {}),
      log: (text) => io.stdout.write(text),
    });
    io.stdout.write(formatReport(outcome));
    return outcome.exitCode;
  } catch (cause) {
    io.stderr.write(`GATE ERROR: unexpected exception: ${errorMessage(cause)}\n`);
    return EXIT_GATE_ERROR;
  }
}
