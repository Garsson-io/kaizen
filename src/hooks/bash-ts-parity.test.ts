/**
 * bash-ts-parity.test.ts — CI sync check for bash/TS shared library parity.
 *
 * Ensures that functions in the bash shared libraries (parse-command.sh)
 * have corresponding TypeScript implementations, and vice versa.
 * Drift between the two was undetected until manual comparison (kaizen #347).
 *
 * state-utils.sh was deleted in kaizen #790 — all state management is now
 * TypeScript-only. Only parse-command parity remains.
 *
 * Naming convention: bash uses snake_case, TS uses camelCase.
 * The test normalizes both to compare.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HOOKS_LIB_DIR = join(__dirname, '../../.claude/hooks/lib');
const HOOKS_DIR = join(__dirname, '../../.claude/hooks');
const HOOKS_TS_DIR = __dirname;

// Functions intentionally present in only one version.
// Each entry must have a comment explaining WHY it's excluded.
const EXCLUSIONS: Record<string, string> = {
  // TS internal utility for splitting compound commands; bash uses IFS/sed inline
  splitCommandSegments:
    'ts-only: internal helper, bash splits on operators inline',

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
      const parseCommandBash = extractBashFunctions(
        join(HOOKS_LIB_DIR, 'parse-command.sh'),
      );

      const parseCommandTs = extractTsFunctions(
        join(HOOKS_TS_DIR, 'parse-command.ts'),
      );

      for (const excluded of Object.keys(EXCLUSIONS)) {
        const existsInBash = parseCommandBash.includes(excluded);
        const existsInTs = parseCommandTs.includes(excluded);
        expect(
          existsInBash || existsInTs,
          `Exclusion '${excluded}' doesn't exist in either bash or TS — remove stale exclusion`,
        ).toBe(true);
      }
    });
  });
});

describe('shell source lint', () => {
  // state-utils.sh was deleted in kaizen #790. Any new bash hook that accidentally
  // re-introduces `source state-utils.sh` would fail at runtime with a cryptic error.
  // This lint catches it at CI time with a clear message. (#790 gap fix)
  it('no .sh file sources state-utils.sh', () => {
    const sourcePattern = /\bsource\s+.*state-utils\.sh|\.\s+.*state-utils\.sh/;

    function collectShFiles(dir: string): string[] {
      const entries = readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          files.push(...collectShFiles(join(dir, entry.name)));
        } else if (entry.name.endsWith('.sh')) {
          files.push(join(dir, entry.name));
        }
      }
      return files;
    }

    const shFiles = collectShFiles(HOOKS_DIR);
    const violators: string[] = [];

    for (const filepath of shFiles) {
      const content = readFileSync(filepath, 'utf-8');
      if (sourcePattern.test(content)) {
        violators.push(filepath);
      }
    }

    expect(
      violators,
      `These .sh files source state-utils.sh, which was deleted in #790. ` +
        `Use TS state functions (src/hooks/state-utils.ts) instead: ${violators.join(', ')}`,
    ).toEqual([]);
  });
});
