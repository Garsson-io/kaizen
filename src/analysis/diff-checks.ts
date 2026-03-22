/**
 * diff-checks.ts — Deterministic failure mode detectors for code diffs.
 *
 * Each function analyzes DiffFile[] and returns Detection[] for a specific
 * failure mode. These are pure functions with no I/O — injectable and testable.
 */

import {
  type DiffFile,
  type Detection,
  FailureMode,
} from './types.js';
import { truncate, isTestFile } from './util.js';

/**
 * FM1: Detect duplicated code blocks in added lines.
 *
 * Finds blocks of N+ consecutive lines that appear identically in 2+ files,
 * or appear twice within the same file. Default threshold: 3 lines.
 */
export function detectDryViolations(
  files: DiffFile[],
  minBlockSize = 3,
): Detection[] {
  const detections: Detection[] = [];

  // Collect all added-line blocks per file
  const blocksByFile = files.map((f) => ({
    path: f.path,
    blocks: extractConsecutiveBlocks(f.additions, minBlockSize),
  }));

  // Cross-file: find blocks that appear in 2+ files
  const blockIndex = new Map<string, string[]>(); // block content -> file paths
  for (const { path, blocks } of blocksByFile) {
    for (const block of blocks) {
      const key = block.join('\n').trim();
      if (!key) continue;
      const existing = blockIndex.get(key) ?? [];
      existing.push(path);
      blockIndex.set(key, existing);
    }
  }

  for (const [block, paths] of blockIndex) {
    if (paths.length >= 2) {
      const uniquePaths = [...new Set(paths)];
      if (uniquePaths.length >= 2) {
        detections.push({
          mode: FailureMode.DRY_VIOLATION,
          confidence: 85,
          location: uniquePaths.join(', '),
          detail: `${uniquePaths.length} files share a ${block.split('\n').length}-line duplicated block: "${truncate(block, 80)}"`,
        });
      }
    }
  }

  // Within-file: find blocks that appear 2+ times in the same file
  for (const { path, blocks } of blocksByFile) {
    const seen = new Map<string, number>();
    for (const block of blocks) {
      const key = block.join('\n').trim();
      if (!key) continue;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    for (const [block, count] of seen) {
      if (count >= 2) {
        detections.push({
          mode: FailureMode.DRY_VIOLATION,
          confidence: 80,
          location: path,
          detail: `Block appears ${count}x within file (${block.split('\n').length} lines): "${truncate(block, 80)}"`,
        });
      }
    }
  }

  return detections;
}

/**
 * FM6: Detect stale references after renames.
 *
 * Given a list of renamed symbols (old -> new), checks if any added lines
 * still reference the old name. This catches the pattern where a rename
 * is done on the target file but consumers still use the old name.
 */
export function detectStaleReferences(
  files: DiffFile[],
  renamedSymbols: { old: string; new: string }[],
): Detection[] {
  const detections: Detection[] = [];

  for (const { old: oldName, new: newName } of renamedSymbols) {
    for (const file of files) {
      // Check added lines for old symbol name
      for (let i = 0; i < file.additions.length; i++) {
        const line = file.additions[i];
        if (containsSymbol(line, oldName) && !containsSymbol(line, newName)) {
          detections.push({
            mode: FailureMode.STALE_REFERENCE,
            confidence: 90,
            location: `${file.path}:+${i + 1}`,
            detail: `Added line references old name "${oldName}" (renamed to "${newName}"): "${truncate(line.trim(), 80)}"`,
          });
        }
      }
    }
  }

  return detections;
}

/**
 * FM5: Detect environment assumptions in shell/hook code.
 *
 * Checks for:
 * - `git status` / `git diff` without `-C` flag (assumes CWD = target repo)
 * - Hardcoded absolute paths (e.g., /home/username/)
 * - Missing git config in test setup (git init without user.name/user.email)
 */
export function detectEnvAssumptions(files: DiffFile[]): Detection[] {
  const detections: Detection[] = [];

  for (const file of files) {
    const isShellOrHook =
      file.path.endsWith('.sh') || file.path.includes('hooks/');
    const isTest = isTestFile(file.path);

    for (let i = 0; i < file.additions.length; i++) {
      const line = file.additions[i];

      // git status/diff without -C (shell files only)
      if (isShellOrHook && /\bgit\s+(status|diff)\b/.test(line) && !/-C\b/.test(line)) {
        // Exclude lines that are comments
        if (!line.trimStart().startsWith('#')) {
          detections.push({
            mode: FailureMode.ENV_ASSUMPTION,
            confidence: 75,
            location: `${file.path}:+${i + 1}`,
            detail: `"git ${/status|diff/.exec(line)?.[0]}" without -C flag — may check wrong worktree CWD`,
          });
        }
      }

      // Hardcoded home directory paths
      const homeMatch = /\/home\/\w+\//.exec(line);
      if (homeMatch && !line.trimStart().startsWith('#') && !line.trimStart().startsWith('//')) {
        detections.push({
          mode: FailureMode.ENV_ASSUMPTION,
          confidence: 90,
          location: `${file.path}:+${i + 1}`,
          detail: `Hardcoded home path "${homeMatch[0]}" — breaks on other machines`,
        });
      }

      // Test files: git init without setting user config
      if (isTest && /\bgit\s+init\b/.test(line)) {
        // Look ahead for user.name/user.email in next 5 lines
        const lookAhead = file.additions.slice(i + 1, i + 6).join('\n');
        if (!/user\.(name|email)/.test(lookAhead)) {
          detections.push({
            mode: FailureMode.ENV_ASSUMPTION,
            confidence: 70,
            location: `${file.path}:+${i + 1}`,
            detail: 'git init without setting user.name/user.email — fails in CI (no global git config)',
          });
        }
      }
    }
  }

  return detections;
}

/**
 * FM4: Detect scope cuts that remove testability.
 *
 * Checks for patterns where source code is added but no corresponding
 * test file changes exist, especially for new files or significant changes.
 */
export function detectScopeCutTestability(files: DiffFile[]): Detection[] {
  const detections: Detection[] = [];

  const sourceFiles = files.filter(
    (f) =>
      (f.path.endsWith('.ts') || f.path.endsWith('.sh')) &&
      !isTestFile(f.path) &&
      f.additions.length > 20, // only flag significant additions
  );

  const testFiles = new Set(
    files.filter((f) => isTestFile(f.path)).map((f) => f.path),
  );

  for (const src of sourceFiles) {
    // Check if there's a corresponding test file in the diff
    const baseName = src.path.replace(/\.(ts|sh)$/, '');
    const hasTest =
      testFiles.has(`${baseName}.test.ts`) ||
      testFiles.has(`${baseName}.test.sh`) ||
      [...testFiles].some(
        (t) =>
          t.includes(baseName.split('/').pop() ?? '') ||
          t.includes(src.path.split('/').pop()?.replace(/\.\w+$/, '') ?? ''),
      );

    if (!hasTest) {
      detections.push({
        mode: FailureMode.SCOPE_CUT_TESTABILITY,
        confidence: 65,
        location: src.path,
        detail: `${src.additions.length} lines added to source with no corresponding test changes — "tests later" = no tests`,
      });
    }
  }

  return detections;
}

// --- Helpers ---

function extractConsecutiveBlocks(
  lines: string[],
  minSize: number,
): string[][] {
  const blocks: string[][] = [];
  const nonEmpty = lines.filter((l) => l.trim().length > 0);

  for (let i = 0; i <= nonEmpty.length - minSize; i++) {
    blocks.push(nonEmpty.slice(i, i + minSize));
  }
  return blocks;
}

function containsSymbol(line: string, symbol: string): boolean {
  // Match as a word boundary — not inside a longer identifier
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(line);
}

