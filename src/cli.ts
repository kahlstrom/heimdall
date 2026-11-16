#!/usr/bin/env node
/**
 * Bin entry: no static app imports, so a missing or stale dist/ still prints
 * GATE ERROR and exits 2 instead of Node's default 1 (red).
 */

function writeBootError(message: string): void {
  try {
    process.stderr.write(`GATE ERROR: ${message}\n`);
  } catch {
    // stderr may already be closed (EPIPE)
  }
}

try {
  const { startGateCli } = await import('./cli-start.js');
  await startGateCli();
} catch (cause) {
  const detail = cause instanceof Error ? cause.message : String(cause);
  writeBootError(`unexpected exception: ${detail}`);
  process.exitCode = 2;
}
