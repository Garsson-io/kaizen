/**
 * state-utils.ts — TypeScript port of .claude/kaizen/hooks/lib/state-utils.sh
 *
 * Manages workflow gate state files for kaizen hooks. Provides typed,
 * atomic state operations replacing fragile bash grep/sed/printf chains.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_STATE_DIR = '/tmp/.pr-review-state';
export const DEFAULT_MAX_STATE_AGE = 7200; // 2 hours

export interface StateFile {
  PR_URL: string;
  STATUS: string;
  BRANCH: string;
  ROUND?: string;
}

/**
 * Convert a PR URL to a safe state file key.
 * e.g. https://github.com/Garsson-io/nanoclaw/pull/33 → Garsson-io_nanoclaw_33
 */
export function prUrlToStateKey(url: string): string {
  return url
    .replace('https://github.com/', '')
    .replace('/pull/', '_')
    .replace(/\//g, '_');
}

/** Parse a state file's key=value content. */
export function parseStateFile(content: string): Partial<StateFile> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const eqIdx = line.indexOf('=');
    if (eqIdx > 0) {
      const key = line.slice(0, eqIdx).trim();
      const value = line.slice(eqIdx + 1).trim();
      result[key] = value;
    }
  }
  return result as Partial<StateFile>;
}

/** Serialize a state file to key=value format. */
export function serializeStateFile(state: StateFile): string {
  let content = `PR_URL=${state.PR_URL}\nSTATUS=${state.STATUS}\nBRANCH=${state.BRANCH}\n`;
  if (state.ROUND) {
    content += `ROUND=${state.ROUND}\n`;
  }
  return content;
}

/** Ensure the state directory exists with mode 700. */
export function ensureStateDir(stateDir: string = DEFAULT_STATE_DIR): void {
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Write a state file atomically.
 * Creates the state directory if needed.
 */
export function writeStateFile(
  stateDir: string,
  filename: string,
  state: StateFile,
): string {
  ensureStateDir(stateDir);
  const filepath = join(stateDir, filename);
  writeFileSync(filepath, serializeStateFile(state), { mode: 0o600 });
  return filepath;
}

/**
 * Check if a state file belongs to the current worktree and is not stale.
 */
export function isStateForCurrentWorktree(
  filepath: string,
  now: number,
  currentBranch: string,
  maxAge: number = DEFAULT_MAX_STATE_AGE,
): boolean {
  if (!existsSync(filepath)) return false;

  // Skip stale state files
  const mtime = statSync(filepath).mtimeMs / 1000;
  const age = now - mtime;
  if (age > maxAge) return false;

  // Read and parse
  const content = readFileSync(filepath, 'utf-8');
  const state = parseStateFile(content);

  // Skip state files from other branches
  if (state.BRANCH && currentBranch && state.BRANCH !== currentBranch) {
    return false;
  }

  // Skip legacy state files without BRANCH
  if (!state.BRANCH) return false;

  return true;
}

/**
 * List state files (non-stale, any branch).
 * For cross-branch lookups (e.g., active agent declarations).
 */
export function listStateFilesAnyBranch(
  stateDir: string = DEFAULT_STATE_DIR,
  maxAge: number = DEFAULT_MAX_STATE_AGE,
): string[] {
  if (!existsSync(stateDir)) return [];
  const now = Date.now() / 1000;
  const files: string[] = [];

  for (const entry of readdirSync(stateDir)) {
    const filepath = join(stateDir, entry);
    try {
      const mtime = statSync(filepath).mtimeMs / 1000;
      if (now - mtime > maxAge) continue;

      const content = readFileSync(filepath, 'utf-8');
      const state = parseStateFile(content);
      if (!state.BRANCH) continue;

      files.push(filepath);
    } catch {
      continue;
    }
  }
  return files;
}

/**
 * Mark a PR's reflection as completed.
 * Creates a kaizen-done-<key> marker file.
 */
export function markReflectionDone(
  prUrl: string,
  branch: string,
  stateDir: string = DEFAULT_STATE_DIR,
): void {
  const key = prUrlToStateKey(prUrl);
  writeStateFile(stateDir, `kaizen-done-${key}`, {
    PR_URL: prUrl,
    STATUS: 'kaizen_done',
    BRANCH: branch,
  });
}

/**
 * Check if a PR's reflection has already been completed.
 * Uses any-branch lookup (reflection may have been done in a different worktree).
 */
export function isReflectionDone(
  prUrl: string,
  stateDir: string = DEFAULT_STATE_DIR,
  maxAge: number = DEFAULT_MAX_STATE_AGE,
): boolean {
  const key = prUrlToStateKey(prUrl);
  const marker = join(stateDir, `kaizen-done-${key}`);
  if (!existsSync(marker)) return false;

  const now = Date.now() / 1000;
  const mtime = statSync(marker).mtimeMs / 1000;
  if (now - mtime > maxAge) {
    try {
      unlinkSync(marker);
    } catch {
      /* ignore */
    }
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Branch-scoped state queries (parity with bash state-utils.sh — kaizen #333)
// ---------------------------------------------------------------------------

/**
 * List state files for the current worktree (branch-scoped, non-stale).
 * Bash equivalent: list_state_files_for_current_worktree()
 */
export function listStateFilesForCurrentWorktree(
  currentBranch: string,
  stateDir: string = DEFAULT_STATE_DIR,
  maxAge: number = DEFAULT_MAX_STATE_AGE,
): string[] {
  if (!existsSync(stateDir)) return [];
  const now = Date.now() / 1000;
  const files: string[] = [];

  for (const entry of readdirSync(stateDir)) {
    const filepath = join(stateDir, entry);
    if (isStateForCurrentWorktree(filepath, now, currentBranch, maxAge)) {
      files.push(filepath);
    }
  }
  return files;
}

/** Result from state file queries — PR_URL and STATUS. */
export interface StateQueryResult {
  prUrl: string;
  status: string;
  filepath: string;
}

/**
 * Find the first state file with a given STATUS for the current branch.
 * Bash equivalent: find_state_with_status()
 */
export function findStateWithStatus(
  wantedStatus: string,
  currentBranch: string,
  stateDir: string = DEFAULT_STATE_DIR,
  maxAge: number = DEFAULT_MAX_STATE_AGE,
): StateQueryResult | null {
  for (const filepath of listStateFilesForCurrentWorktree(
    currentBranch,
    stateDir,
    maxAge,
  )) {
    const state = parseStateFile(readFileSync(filepath, 'utf-8'));
    if (state.STATUS === wantedStatus) {
      return { prUrl: state.PR_URL ?? '', status: state.STATUS, filepath };
    }
  }
  return null;
}

/**
 * Clear the first state file matching a given STATUS for the current branch.
 * Bash equivalent: clear_state_with_status()
 */
export function clearStateWithStatus(
  wantedStatus: string,
  currentBranch: string,
  stateDir: string = DEFAULT_STATE_DIR,
  maxAge: number = DEFAULT_MAX_STATE_AGE,
): boolean {
  const result = findStateWithStatus(
    wantedStatus,
    currentBranch,
    stateDir,
    maxAge,
  );
  if (!result) return false;
  try {
    unlinkSync(result.filepath);
  } catch {
    /* ignore */
  }
  return true;
}

/**
 * Find ALL state files matching a given STATUS for the current branch.
 * Bash equivalent: find_all_states_with_status()
 */
export function findAllStatesWithStatus(
  wantedStatus: string,
  currentBranch: string,
  stateDir: string = DEFAULT_STATE_DIR,
  maxAge: number = DEFAULT_MAX_STATE_AGE,
): StateQueryResult[] {
  const results: StateQueryResult[] = [];
  for (const filepath of listStateFilesForCurrentWorktree(
    currentBranch,
    stateDir,
    maxAge,
  )) {
    const state = parseStateFile(readFileSync(filepath, 'utf-8'));
    if (state.STATUS === wantedStatus) {
      results.push({
        prUrl: state.PR_URL ?? '',
        status: state.STATUS,
        filepath,
      });
    }
  }
  return results;
}

/**
 * Clear ALL state files matching a given STATUS for the current branch.
 * Bash equivalent: clear_all_states_with_status()
 */
export function clearAllStatesWithStatus(
  wantedStatus: string,
  currentBranch: string,
  stateDir: string = DEFAULT_STATE_DIR,
  maxAge: number = DEFAULT_MAX_STATE_AGE,
): number {
  let cleared = 0;
  for (const result of findAllStatesWithStatus(
    wantedStatus,
    currentBranch,
    stateDir,
    maxAge,
  )) {
    try {
      unlinkSync(result.filepath);
      cleared++;
    } catch {
      /* ignore */
    }
  }
  return cleared;
}

// ---------------------------------------------------------------------------
// Cross-branch state queries (any branch — kaizen #239, #125)
// ---------------------------------------------------------------------------

/**
 * Find the first state file with a given STATUS across all branches.
 * Bash equivalent: find_state_with_status_any_branch()
 */
export function findStateWithStatusAnyBranch(
  wantedStatus: string,
  stateDir: string = DEFAULT_STATE_DIR,
  maxAge: number = DEFAULT_MAX_STATE_AGE,
): StateQueryResult | null {
  for (const filepath of listStateFilesAnyBranch(stateDir, maxAge)) {
    const state = parseStateFile(readFileSync(filepath, 'utf-8'));
    if (state.STATUS === wantedStatus) {
      return { prUrl: state.PR_URL ?? '', status: state.STATUS, filepath };
    }
  }
  return null;
}

/**
 * Clear state with given STATUS across all branches.
 * Optional prUrl filter: only clear the file matching both STATUS and PR_URL.
 * Bash equivalent: clear_state_with_status_any_branch()
 */
export function clearStateWithStatusAnyBranch(
  wantedStatus: string,
  stateDir: string = DEFAULT_STATE_DIR,
  maxAge: number = DEFAULT_MAX_STATE_AGE,
  specificPrUrl?: string,
): boolean {
  for (const filepath of listStateFilesAnyBranch(stateDir, maxAge)) {
    const state = parseStateFile(readFileSync(filepath, 'utf-8'));
    if (state.STATUS !== wantedStatus) continue;
    if (specificPrUrl && state.PR_URL !== specificPrUrl) continue;
    try {
      unlinkSync(filepath);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

/**
 * Find the NEWEST state file with a given STATUS across all branches.
 * When multiple match, returns the most recently modified one.
 * Bash equivalent: find_newest_state_with_status_any_branch()
 */
export function findNewestStateWithStatusAnyBranch(
  wantedStatus: string,
  stateDir: string = DEFAULT_STATE_DIR,
  maxAge: number = DEFAULT_MAX_STATE_AGE,
): StateQueryResult | null {
  let newest: StateQueryResult | null = null;
  let newestMtime = 0;

  for (const filepath of listStateFilesAnyBranch(stateDir, maxAge)) {
    const state = parseStateFile(readFileSync(filepath, 'utf-8'));
    if (state.STATUS !== wantedStatus) continue;

    const mtime = statSync(filepath).mtimeMs;
    if (mtime > newestMtime) {
      newestMtime = mtime;
      newest = { prUrl: state.PR_URL ?? '', status: state.STATUS, filepath };
    }
  }
  return newest;
}
