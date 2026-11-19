/**
 * CLI argument handling. Unknown flags are GATE ERROR, not a crash.
 */
import { formatReport } from './report.js';
import { runGate } from './runner.js';
import { EXIT_GATE_ERROR, EXIT_GREEN, errorMessage, type ExitCode } from './types.js';

export const HELP = `Usage: heimdall [--config <path>] [--cwd <path>] [--allow-wide]

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
  --allow-wide      continue when the diff exceeds maxChangedFiles
                    (same as HEIMDALL_ALLOW_WIDE=1)
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
  | { readonly kind: 'run'; readonly cwd?: string; readonly configPath?: string; readonly allowWide?: boolean }
  | { readonly kind: 'error'; readonly reason: string };

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let cwd: string | undefined;
  let configPath: string | undefined;
  let allowWide = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      return { kind: 'help' };
    }
    if (arg === '--allow-wide') {
      allowWide = true;
      continue;
    }
    if (arg === '--cwd') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) {
        return { kind: 'error', reason: '--cwd requires a path' };
      }
      cwd = value;
      index += 1;
      continue;
    }
    if (arg?.startsWith('--cwd=')) {
      const value = arg.slice('--cwd='.length);
      if (!value) {
        return { kind: 'error', reason: '--cwd requires a path' };
      }
      cwd = value;
      continue;
    }
    if (arg === '--config') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) {
        return { kind: 'error', reason: '--config requires a path' };
      }
      configPath = value;
      index += 1;
      continue;
    }
    if (arg?.startsWith('--config=')) {
      const value = arg.slice('--config='.length);
      if (!value) {
        return { kind: 'error', reason: '--config requires a path' };
      }
      configPath = value;
      continue;
    }
    return { kind: 'error', reason: `unknown argument: ${arg}` };
  }
  const run: { kind: 'run'; cwd?: string; configPath?: string; allowWide?: boolean } = { kind: 'run' };
  if (cwd !== undefined) {
    run.cwd = cwd;
  }
  if (configPath !== undefined) {
    run.configPath = configPath;
  }
  if (allowWide) {
    run.allowWide = true;
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
      ...(args.allowWide === true ? { allowWide: true } : {}),
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
