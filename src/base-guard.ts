/**
 * Pre-run guards so a story cannot silently compare a whole feature against
 * main, or feed a hundreds-of-files diff to ESLint.
 */

const FALLBACK_BASE_SPECS = new Set(['main', 'origin/main']);

const UPSTREAM_HINT =
  'set the branch upstream to its feature branch, for example git branch --set-upstream-to=origin/FEATURE';

export type WideDiffDecision =
  | { readonly kind: 'ok' }
  | { readonly kind: 'error'; readonly reason: string }
  | { readonly kind: 'warn'; readonly warning: string };

/**
 * When requireParentBase is on and baseRef is not explicit, refuse a missing
 * upstream or a resolved base of main / origin/main.
 */
export function parentBaseError(input: {
  readonly requireParentBase: boolean;
  readonly configuredBaseRef: string | undefined;
  readonly resolvedSpec: string;
  readonly hasUpstream: boolean;
}): string | undefined {
  if (!input.requireParentBase || input.configuredBaseRef !== undefined) {
    return undefined;
  }
  if (!input.hasUpstream) {
    return `no upstream is set; ${UPSTREAM_HINT}`;
  }
  if (FALLBACK_BASE_SPECS.has(input.resolvedSpec)) {
    return `base resolved to ${input.resolvedSpec}; ${UPSTREAM_HINT}`;
  }
  return undefined;
}

/**
 * After the diff is known: GATE ERROR above maxChangedFiles unless overridden.
 */
export function wideDiffDecision(input: {
  readonly changedFileCount: number;
  readonly maxChangedFiles: number;
  readonly baseRef: string;
  readonly allowWide: boolean;
}): WideDiffDecision {
  if (input.changedFileCount <= input.maxChangedFiles) {
    return { kind: 'ok' };
  }
  const detail =
    `changed file count ${input.changedFileCount} is above maxChangedFiles ${input.maxChangedFiles} ` +
    `(base ${input.baseRef})`;
  if (input.allowWide) {
    return {
      kind: 'warn',
      warning: `${detail}; continuing because --allow-wide or HEIMDALL_ALLOW_WIDE=1 is set`,
    };
  }
  return {
    kind: 'error',
    reason: `${detail}; pass --allow-wide or set HEIMDALL_ALLOW_WIDE=1 to continue`,
  };
}
