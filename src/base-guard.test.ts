import { describe, expect, it } from 'vitest';
import { parentBaseError, wideDiffDecision } from './base-guard.js';

describe('parentBaseError', () => {
  it('is silent when requireParentBase is false', () => {
    expect(
      parentBaseError({
        requireParentBase: false,
        configuredBaseRef: undefined,
        resolvedSpec: 'main',
        hasUpstream: false,
      }),
    ).toBeUndefined();
  });

  it('is silent when an explicit baseRef is configured', () => {
    expect(
      parentBaseError({
        requireParentBase: true,
        configuredBaseRef: 'main',
        resolvedSpec: 'main',
        hasUpstream: false,
      }),
    ).toBeUndefined();
  });

  it('names main when that is the resolved base', () => {
    const message = parentBaseError({
      requireParentBase: true,
      configuredBaseRef: undefined,
      resolvedSpec: 'main',
      hasUpstream: true,
    });
    expect(message).toMatch(/base resolved to main/);
    expect(message).toMatch(/git branch --set-upstream-to=origin\/FEATURE/);
  });

  it('names origin/main when that is the resolved base', () => {
    const message = parentBaseError({
      requireParentBase: true,
      configuredBaseRef: undefined,
      resolvedSpec: 'origin/main',
      hasUpstream: true,
    });
    expect(message).toMatch(/base resolved to origin\/main/);
  });

  it('says no upstream is set when @{u} is missing', () => {
    const message = parentBaseError({
      requireParentBase: true,
      configuredBaseRef: undefined,
      resolvedSpec: 'main',
      hasUpstream: false,
    });
    expect(message).toMatch(/no upstream is set/);
  });

  it('is silent when the resolved base is a feature parent', () => {
    expect(
      parentBaseError({
        requireParentBase: true,
        configuredBaseRef: undefined,
        resolvedSpec: 'origin/feat',
        hasUpstream: true,
      }),
    ).toBeUndefined();
  });
});

describe('wideDiffDecision', () => {
  it('is ok at the limit', () => {
    expect(
      wideDiffDecision({
        changedFileCount: 100,
        maxChangedFiles: 100,
        baseRef: 'main',
        allowWide: false,
      }),
    ).toEqual({ kind: 'ok' });
  });

  it('is a GATE ERROR above the limit', () => {
    const decision = wideDiffDecision({
      changedFileCount: 101,
      maxChangedFiles: 100,
      baseRef: 'feat',
      allowWide: false,
    });
    expect(decision.kind).toBe('error');
    if (decision.kind === 'error') {
      expect(decision.reason).toBe(
        'changed file count 101 is above maxChangedFiles 100 (base feat); pass --allow-wide or set HEIMDALL_ALLOW_WIDE=1 to continue',
      );
    }
  });

  it('warns and continues when allowWide is true', () => {
    const decision = wideDiffDecision({
      changedFileCount: 101,
      maxChangedFiles: 100,
      baseRef: 'feat',
      allowWide: true,
    });
    expect(decision.kind).toBe('warn');
    if (decision.kind === 'warn') {
      expect(decision.warning).toMatch(/changed file count 101 is above maxChangedFiles 100 \(base feat\)/);
      expect(decision.warning).toMatch(/--allow-wide or HEIMDALL_ALLOW_WIDE=1/);
    }
  });
});
