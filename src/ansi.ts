import { stripVTControlCharacters } from 'node:util';

/**
 * Remove ANSI/VT terminal escape sequences (CSI color/cursor codes, OSC
 * sequences, etc.) so parsers match colored tool output like plain text.
 */
export function stripAnsi(text: string): string {
  return stripVTControlCharacters(text);
}
