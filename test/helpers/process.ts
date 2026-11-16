import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * True only if the pid is a running process. Zombies (SIGKILL'd children
 * waiting for init to reap) are not "left running".
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const listed = spawnSync('ps', ['-o', 'state=', '-p', String(pid)], { encoding: 'utf8' });
  const state = listed.stdout.trim();
  if (state === '' || state.startsWith('Z')) {
    return false;
  }
  return listed.status === 0;
}

export async function waitForFile(file: string, timeoutMs = 1000): Promise<string> {
  const started = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${file}`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 15);
    });
  }
  return fs.readFileSync(file, 'utf8').trim();
}

export function nodeCommand(source: string): string {
  return `${process.execPath} -e ${JSON.stringify(source)}`;
}
