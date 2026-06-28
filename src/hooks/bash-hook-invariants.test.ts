import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const HOOKS_DIR = join(__dirname, '../../.claude/hooks');

describe('bash hook source invariants', () => {
  it('keeps stdin JSON parsing behind input-utils (#828)', () => {
    const offenders = readdirSync(HOOKS_DIR)
      .filter((name) => name.endsWith('.sh'))
      .flatMap((name) => {
        const content = readFileSync(join(HOOKS_DIR, name), 'utf-8');
        const parsesHookInput =
          content.includes('INPUT=$(cat)') ||
          /\.tool_(input|response)\./.test(content);
        const usesSharedParser = content.includes('lib/input-utils.sh');

        return parsesHookInput && !usesSharedParser ? [name] : [];
      })
      .sort();

    expect(offenders).toEqual([]);
  });

  it('keeps deny JSON emission behind hook-output (#828)', () => {
    const offenders = readdirSync(HOOKS_DIR)
      .filter((name) => name.endsWith('.sh'))
      .flatMap((name) => {
        const content = readFileSync(join(HOOKS_DIR, name), 'utf-8');
        const emitsDenyJson =
          content.includes('hookSpecificOutput') &&
          content.includes('permissionDecision');
        const usesSharedOutput = content.includes('lib/hook-output.sh');

        return emitsDenyJson && !usesSharedOutput ? [name] : [];
      })
      .sort();

    expect(offenders).toEqual([]);
  });
});
