/**
 * bash-ts-parity.test.ts — CI sync check for bash/TS shared library parity.
 *
 * Ensures that functions in duplicated bash/TS shared libraries have
 * corresponding sibling implementations or documented exclusions.
 * Drift between the two was undetected until manual comparison (kaizen #347).
 *
 * state-utils.sh was deleted in kaizen #790 — all state management is now
 * TypeScript-only. parse-command and allowlist remain as guarded overlap.
 *
 * Naming convention: bash uses snake_case, TS uses camelCase.
 * The test normalizes both to compare.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isAllowedRuntimeDir,
  isReadonlyMonitoringCommand,
} from './lib/allowlist.js';

const HOOKS_LIB_DIR = join(__dirname, '../../.claude/hooks/lib');
const HOOKS_TS_DIR = __dirname;

const PARITY_TARGETS = [
  { label: 'parse-command', bashFile: 'parse-command.sh', tsFile: 'parse-command.ts' },
  { label: 'allowlist', bashFile: 'allowlist.sh', tsFile: 'lib/allowlist.ts' },
] as const;

// Functions intentionally present in only one version.
// Each entry must have a comment explaining WHY it's excluded.
const EXCLUSIONS: Record<string, string> = {
  // TS splits extractPrUrl from reconstructPrUrl; bash inlines the grep
  extractPrUrl:
    'ts-only: extracted helper, bash inlines grep in reconstruct_pr_url',

  // Added in the #1073 categorical fix. The sibling .claude/hooks/*.sh layer
  // is being phased out (#762) — all new hook logic is TS-only, and the
  // check-dirty-files bash wrapper just dispatches to the TS hook.
  extractCdTarget:
    'ts-only: cwd-drift fix landed in TS hook (#1073); bash wrapper only dispatches',

  // The Impact-proof body-file gate is TS-only; the bash hook layer has no
  // corresponding body-file read path to keep in sync.
  effectiveCwdBeforeCommand:
    'ts-only: used by enforce-plan-stored Impact body-file resolution; no bash consumer',

  // Bash exposes helper functions globally because shell has no module-private
  // function scope. TS keeps these private; behavior parity below covers their
  // exported composition through isReadonlyMonitoringCommand.
  is_neutral_setup_segment:
    'bash-only public helper: TS equivalent is private isNeutralSetupSegment',
  is_readonly_monitoring_segment:
    'bash-only public helper: TS equivalent is private isReadonlyMonitoringSegment',
  is_readonly_or_setup_segment:
    'bash-only public helper: TS equivalent is private isReadonlyOrSetupSegment',

  // These are used by TS-only review/reflection gates. The bash gates that
  // still source allowlist.sh only need readonly monitoring and runtime-dir
  // checks, so adding bash equivalents would create dead surface.
  isEscapeHatch:
    'ts-only: used by TS review/reflection gates; no bash gate consumer remains',
  isReviewCommand:
    'ts-only: used by TS review gate; no bash gate consumer remains',
  isKaizenCommand:
    'ts-only: used by TS reflection gate; no bash gate consumer remains',
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

function allKnownFunctions(): Set<string> {
  const functions = new Set<string>();
  for (const target of PARITY_TARGETS) {
    for (const fn of extractBashFunctions(join(HOOKS_LIB_DIR, target.bashFile))) {
      functions.add(fn);
    }
    for (const fn of extractTsFunctions(join(HOOKS_TS_DIR, target.tsFile))) {
      functions.add(fn);
    }
  }
  return functions;
}

function bashBoolean(functionName: string, value: string): boolean {
  const script = `
    source "$HOOKS_LIB_DIR/parse-command.sh"
    source "$HOOKS_LIB_DIR/allowlist.sh"
    if "$FUNCTION_NAME" "$1"; then
      printf true
    else
      printf false
    fi
  `;
  const result = spawnSync('bash', ['-c', script, 'bash-parity', value], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOOKS_LIB_DIR,
      FUNCTION_NAME: functionName,
    },
  });

  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim() === 'true';
}

describe('bash/TS shared library parity', () => {
  for (const target of PARITY_TARGETS) {
    describe(target.label, () => {
      it('all bash functions have TS equivalents (or are excluded)', () => {
        const { missingInTs } = checkParity(target.bashFile, target.tsFile);
        expect(
          missingInTs,
          `Bash functions missing TS equivalent: ${missingInTs.join(', ')}. Either port them or add to EXCLUSIONS with a reason.`,
        ).toEqual([]);
      });

      it('all TS functions have bash equivalents (or are excluded)', () => {
        const { missingInBash } = checkParity(target.bashFile, target.tsFile);
        expect(
          missingInBash,
          `TS functions missing bash equivalent: ${missingInBash.join(', ')}. Either port them or add to EXCLUSIONS with a reason.`,
        ).toEqual([]);
      });

      it('extracts functions from both files', () => {
        const { bashFns, tsFns } = checkParity(target.bashFile, target.tsFile);
        expect(bashFns.length).toBeGreaterThan(3);
        expect(tsFns.length).toBeGreaterThan(3);
      });
    });
  }

  describe('exclusions are valid', () => {
    it('all excluded functions actually exist in their source', () => {
      const knownFunctions = allKnownFunctions();

      for (const excluded of Object.keys(EXCLUSIONS)) {
        expect(
          knownFunctions.has(excluded),
          `Exclusion '${excluded}' doesn't exist in either bash or TS — remove stale exclusion`,
        ).toBe(true);
      }
    });
  });

  describe('allowlist behavior parity', () => {
    const readonlyCases: Array<[string, boolean]> = [
      ['gh api repos/Garsson-io/kaizen/pulls/42', true],
      ['gh run list --limit 5', true],
      ['gh run rerun 12345', false],
      ['git status && gh run list --limit 5', true],
      ['git status && git push', false],
      ['echo foo | gh api repos/bar', false],
      ['cd .\ngit status', true],
      ['npm run build', false],
      ['npx vitest run src/hooks/lib/allowlist.test.ts', true],
    ];

    it.each(readonlyCases)('isReadonlyMonitoringCommand matches bash for %s', (cmd, expected) => {
      expect(isReadonlyMonitoringCommand(cmd)).toBe(expected);
      expect(bashBoolean('is_readonly_monitoring_command', cmd)).toBe(expected);
    });

    const runtimeDirCases: Array<[string, boolean]> = [
      ['.claude/settings.json', true],
      ['logs/app.log', true],
      ['strategy/memory.json', true],
      ['src/index.ts', false],
      ['package.json', false],
    ];

    it.each(runtimeDirCases)('isAllowedRuntimeDir matches bash for %s', (path, expected) => {
      expect(isAllowedRuntimeDir(path)).toBe(expected);
      expect(bashBoolean('is_allowed_runtime_dir', path)).toBe(expected);
    });
  });
});
