import { describe, expect, it } from 'vitest';

import { currentHookBranch } from './current-branch.js';

describe('currentHookBranch', () => {
  it('uses the injected branch reader when it returns a branch', () => {
    expect(currentHookBranch({ readBranch: () => 'feature/refactor\n' })).toBe(
      'feature/refactor',
    );
  });

  it('falls back to unknown when branch lookup returns empty output', () => {
    expect(currentHookBranch({ readBranch: () => '' })).toBe('unknown');
  });

  it('uses caller-provided fallback when branch lookup returns empty output', () => {
    expect(currentHookBranch({ readBranch: () => '', fallback: '' })).toBe('');
  });

  it('falls back to unknown when branch lookup throws', () => {
    expect(
      currentHookBranch({
        readBranch: () => {
          throw new Error('git failed');
        },
      }),
    ).toBe('unknown');
  });

  it('uses caller-provided fallback when branch lookup throws', () => {
    expect(
      currentHookBranch({
        readBranch: () => {
          throw new Error('git failed');
        },
        fallback: '',
      }),
    ).toBe('');
  });
});
