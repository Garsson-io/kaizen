/**
 * bash-ts-parity.test.ts — CI sync check for bash/TS shared library parity.
 *
 * Ensures that functions in the bash shared libraries (state-utils.sh,
 * parse-command.sh) have corresponding TypeScript implementations, and
 * vice versa. Drift between the two was undetected until manual comparison
 * (kaizen #347).
 *
 * Naming convention: bash uses snake_case, TS uses camelCase.
 * The test normalizes both to compare.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HOOKS_LIB_DIR = join(__dirname, '../../.claude/kaizen/hooks/lib');
const HOOKS_TS_DIR = __dirname;

// Functions intentionally present in only one version.
// Each entry must have a comment explaining WHY it's excluded.
const EXCLUSIONS: Record<string, string> = {
  // Requires `gh` CLI calls — intentionally stays bash-only (shell orchestration)
  auto_close_kaizen_issues: 'bash-only: requires gh CLI for PR state checks',
  // Requires `gh` CLI for PR state lookup + auto-clear — bash-only orchestration
  find_needs_review_state:
    'bash-only: requires gh CLI for merged/closed PR auto-clear',

  // TS internal helpers with no bash equivalent (TS uses structured objects)
  parseStateFile: 'ts-only: internal helper, bash uses grep/cut inline',
  serializeStateFile: 'ts-only: internal helper, bash uses printf inline',
  ensureStateDir: 'ts-only: internal helper, bash uses mkdir -p inline',
  writeStateFile: 'ts-only: internal helper for atomic writes',

  // TS splits extractPrUrl from reconstructPrUrl; bash inlines the grep
  extractPrUrl:
    'ts-only: extracted helper, bash inlines grep in reconstruct_pr_url',
};

/** Extract function names from a bash script (matches `function_name() {`). */
function extractBashFunctions(filePath: string): string[] {
  const content = readFileSync(filePath, 'utf-8');
  const pattern = /^([a-z_][a-z0-9_]*)\s*\(\)/gm;
  const functions: string[] = [];
  let match;
  while ((match = pattern.exec(content)) !== null) {
    functions.push(match[1]);
  }
  return functions;
}

/** Extract exported function names from a TypeScript file. */
function extractTsFunctions(filePath: string): string[] {
  const content = readFileSync(filePath, 'utf-8');
  const pattern = /^export\s+function\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm;
  const functions: string[] = [];
  let match;
  while ((match = pattern.exec(content)) !== null) {
    functions.push(match[1]);
  }
  return functions;
}

/** Convert snake_case to camelCase for comparison. */
function snakeToCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/** Convert camelCase to snake_case for comparison. */
function camelToSnake(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function checkParity(bashFile: string, tsFile: string) {
  const bashFns = extractBashFunctions(join(HOOKS_LIB_DIR, bashFile));
  const tsFns = extractTsFunctions(join(HOOKS_TS_DIR, tsFile));

  // Normalize bash names to camelCase for comparison
  const bashCamel = new Map(bashFns.map((fn) => [snakeToCamel(fn), fn]));

  // Normalize TS names to snake_case for comparison
  const tsSnake = new Map(tsFns.map((fn) => [camelToSnake(fn), fn]));

  // Find bash functions missing from TS
  const missingInTs: string[] = [];
  for (const [camelName, bashName] of bashCamel) {
    if (!tsFns.includes(camelName) && !EXCLUSIONS[bashName]) {
      missingInTs.push(bashName);
    }
  }

  // Find TS functions missing from bash
  const missingInBash: string[] = [];
  for (const [snakeName, tsName] of tsSnake) {
    if (!bashFns.includes(snakeName) && !EXCLUSIONS[tsName]) {
      missingInBash.push(tsName);
    }
  }

  return { bashFns, tsFns, missingInTs, missingInBash };
}

describe('bash/TS shared library parity', () => {
  describe('state-utils', () => {
    it('all bash functions have TS equivalents (or are excluded)', () => {
      const { missingInTs } = checkParity('state-utils.sh', 'state-utils.ts');
      expect(
        missingInTs,
        `Bash functions missing TS equivalent: ${missingInTs.join(', ')}. Either port them or add to EXCLUSIONS with a reason.`,
      ).toEqual([]);
    });

    it('all TS functions have bash equivalents (or are excluded)', () => {
      const { missingInBash } = checkParity('state-utils.sh', 'state-utils.ts');
      expect(
        missingInBash,
        `TS functions missing bash equivalent: ${missingInBash.join(', ')}. Either port them or add to EXCLUSIONS with a reason.`,
      ).toEqual([]);
    });

    it('extracts functions from both files', () => {
      const { bashFns, tsFns } = checkParity(
        'state-utils.sh',
        'state-utils.ts',
      );
      expect(bashFns.length).toBeGreaterThan(5);
      expect(tsFns.length).toBeGreaterThan(5);
    });
  });

  describe('parse-command', () => {
    it('all bash functions have TS equivalents (or are excluded)', () => {
      const { missingInTs } = checkParity(
        'parse-command.sh',
        'parse-command.ts',
      );
      expect(
        missingInTs,
        `Bash functions missing TS equivalent: ${missingInTs.join(', ')}. Either port them or add to EXCLUSIONS with a reason.`,
      ).toEqual([]);
    });

    it('all TS functions have bash equivalents (or are excluded)', () => {
      const { missingInBash } = checkParity(
        'parse-command.sh',
        'parse-command.ts',
      );
      expect(
        missingInBash,
        `TS functions missing bash equivalent: ${missingInBash.join(', ')}. Either port them or add to EXCLUSIONS with a reason.`,
      ).toEqual([]);
    });

    it('extracts functions from both files', () => {
      const { bashFns, tsFns } = checkParity(
        'parse-command.sh',
        'parse-command.ts',
      );
      expect(bashFns.length).toBeGreaterThan(3);
      expect(tsFns.length).toBeGreaterThan(3);
    });
  });

  describe('exclusions are valid', () => {
    it('all excluded functions actually exist in their source', () => {
      const stateUtilsBash = extractBashFunctions(
        join(HOOKS_LIB_DIR, 'state-utils.sh'),
      );
      const parseCommandBash = extractBashFunctions(
        join(HOOKS_LIB_DIR, 'parse-command.sh'),
      );
      const allBash = [...stateUtilsBash, ...parseCommandBash];

      const stateUtilsTs = extractTsFunctions(
        join(HOOKS_TS_DIR, 'state-utils.ts'),
      );
      const parseCommandTs = extractTsFunctions(
        join(HOOKS_TS_DIR, 'parse-command.ts'),
      );
      const allTs = [...stateUtilsTs, ...parseCommandTs];

      for (const excluded of Object.keys(EXCLUSIONS)) {
        const existsInBash = allBash.includes(excluded);
        const existsInTs = allTs.includes(excluded);
        expect(
          existsInBash || existsInTs,
          `Exclusion '${excluded}' doesn't exist in either bash or TS — remove stale exclusion`,
        ).toBe(true);
      }
    });
  });
});
