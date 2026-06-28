import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const HOOKS_DIR = join(__dirname, '../../.claude/hooks');
const HOOK_LIB_DIR = join(HOOKS_DIR, 'lib');

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

  it('keeps command segment splitting behind parse-command (#828)', () => {
    const segmentSplitPattern = /sed 's\/\[\|;&\]\\\{1,\\\}\/\\n\/g'/;
    const files = [
      ...readdirSync(HOOKS_DIR)
        .filter((name) => name.endsWith('.sh'))
        .map((name) => join(HOOKS_DIR, name)),
      ...readdirSync(HOOK_LIB_DIR)
        .filter((name) => name.endsWith('.sh') && name !== 'parse-command.sh')
        .map((name) => join(HOOK_LIB_DIR, name)),
    ];
    const offenders = files
      .filter((file) => segmentSplitPattern.test(readFileSync(file, 'utf-8')))
      .map((file) => file.replace(`${HOOKS_DIR}/`, ''))
      .sort();

    expect(offenders).toEqual([]);
  });
});
