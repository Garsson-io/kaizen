import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MIGRATED_FILES = [
  'src/hooks/pre-push.ts',
  'src/hooks/pr-review-loop.ts',
];

describe('hook git runner invariant', () => {
  it('keeps migrated hooks off shell-string git wrappers', () => {
    const offenders = MIGRATED_FILES.filter((file) => {
      const content = readFileSync(file, 'utf-8');
      return [
        /execSync\(`git \$\{args\}`/,
        /function git\(args: string/,
        /\bgit\('/,
      ].some((pattern) => pattern.test(content));
    });

    expect(offenders).toEqual([]);
  });
});
