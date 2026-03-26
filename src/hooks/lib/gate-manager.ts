/**
 * gate-manager.ts — Pure functions for reading, formatting, and clearing gates.
 *
 * Replaces the sequential 3-hook stop gauntlet with a single gate reader
 * that collects all pending state and produces one rich message.
 *
 * Gate types:
 *   - needs_review: PR self-review pending (from pr-review-loop.ts)
 *   - needs_pr_kaizen: Kaizen reflection pending (from kaizen-reflect.ts)
 *   - needs_post_merge: Post-merge sync pending (from pr-review-loop.ts)
 *
 * Part of kAIzen Agent Control Flow — kaizen #775
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  type StateQueryResult,
  DEFAULT_STATE_DIR,
  findAllStatesWithStatus,
  parseStateFile,
} from '../state-utils.js';

export interface PendingGate {
  type: 'review' | 'reflection' | 'post_merge';
  prUrl: string;
  label: string;
  detail: string;
  action: string;
  filepath: string;
}

export interface GateReport {
  gates: PendingGate[];
  message: string;
  shouldBlock: boolean;
}

const DEFERRED_ITEMS_FILE = '.kaizen-deferred-items.json';

/**
 * Read all pending gates for the current branch.
 * Returns a structured report with formatted message.
 */
export function readAllPendingGates(
  currentBranch: string,
  stateDir: string = DEFAULT_STATE_DIR,
  maxAge: number = 7200,
): GateReport {
  const gates: PendingGate[] = [];

  // Check review gates
  const reviews = findAllStatesWithStatus('needs_review', currentBranch, stateDir, maxAge);
  for (const r of reviews) {
    const state = readStateFromFile(r.filepath);
    const round = state.ROUND || '1';
    gates.push({
      type: 'review',
      prUrl: r.prUrl,
      label: `PR REVIEW (${r.prUrl} — round ${round})`,
      detail: `Run: gh pr diff ${extractPrNumber(r.prUrl)}`,
      action: `gh pr diff ${extractPrNumber(r.prUrl)}`,
      filepath: r.filepath,
    });
  }

  // Check reflection gates
  const reflections = findAllStatesWithStatus('needs_pr_kaizen', currentBranch, stateDir, maxAge);
  for (const r of reflections) {
    gates.push({
      type: 'reflection',
      prUrl: r.prUrl,
      label: `KAIZEN REFLECTION (${r.prUrl})`,
      detail: "Run: echo 'KAIZEN_IMPEDIMENTS: [...]'",
      action: "echo 'KAIZEN_IMPEDIMENTS: [...]'",
      filepath: r.filepath,
    });
  }

  // Check post-merge gates
  const postMerges = findAllStatesWithStatus('needs_post_merge', currentBranch, stateDir, maxAge);
  for (const r of postMerges) {
    gates.push({
      type: 'post_merge',
      prUrl: r.prUrl,
      label: `POST-MERGE SYNC (${r.prUrl})`,
      detail: '1. Run /kaizen to reflect on this PR\n   2. Then: git fetch origin main && git merge origin/main',
      action: 'git fetch origin main && git merge origin/main',
      filepath: r.filepath,
    });
  }

  const shouldBlock = gates.length > 0;
  const message = shouldBlock ? formatGateMessage(gates) : '';

  return { gates, message, shouldBlock };
}

/**
 * Format the combined gate message shown when Stop is blocked.
 */
export function formatGateMessage(gates: PendingGate[]): string {
  const lines: string[] = [];
  lines.push(`BEFORE STOPPING — ${gates.length} item${gates.length !== 1 ? 's' : ''} pending:`);
  lines.push('');

  for (let i = 0; i < gates.length; i++) {
    const g = gates[i];
    lines.push(`${i + 1}. ${g.label}`);
    lines.push(`   ${g.detail}`);
    lines.push('');
  }

  lines.push('Complete items above, then stop again.');
  lines.push("Or: echo 'KAIZEN_UNFINISHED: <honest reason>'");

  return lines.join('\n');
}

/**
 * Handle the KAIZEN_UNFINISHED escape — clear ALL gates and write deferred items.
 * Returns the list of deferred items for logging.
 */
export function handleUnfinishedEscape(
  reason: string,
  currentBranch: string,
  stateDir: string = DEFAULT_STATE_DIR,
  maxAge: number = 7200,
  deferredDir?: string,
): PendingGate[] {
  const report = readAllPendingGates(currentBranch, stateDir, maxAge);

  // Clear all gate state files
  for (const gate of report.gates) {
    try {
      if (existsSync(gate.filepath)) {
        unlinkSync(gate.filepath);
      }
    } catch {
      // ignore cleanup errors
    }
  }

  // Write deferred items file for next SessionStart
  if (report.gates.length > 0) {
    const deferred = {
      timestamp: new Date().toISOString(),
      branch: currentBranch,
      reason,
      items: report.gates.map((g) => ({
        type: g.type,
        prUrl: g.prUrl,
        label: g.label,
      })),
    };
    const targetDir = deferredDir || stateDir;
    const filepath = join(targetDir, DEFERRED_ITEMS_FILE);
    writeFileSync(filepath, JSON.stringify(deferred, null, 2));
  }

  return report.gates;
}

/**
 * Read deferred items from a previous session's KAIZEN_UNFINISHED escape.
 * Returns null if no deferred items exist.
 */
export function readDeferredItems(
  stateDir: string = DEFAULT_STATE_DIR,
): { timestamp: string; branch: string; reason: string; items: Array<{ type: string; prUrl: string; label: string }> } | null {
  const filepath = join(stateDir, DEFERRED_ITEMS_FILE);
  if (!existsSync(filepath)) return null;
  try {
    return JSON.parse(readFileSync(filepath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Clear deferred items file (call after showing them in SessionStart).
 */
export function clearDeferredItems(stateDir: string = DEFAULT_STATE_DIR): void {
  const filepath = join(stateDir, DEFERRED_ITEMS_FILE);
  try {
    if (existsSync(filepath)) {
      unlinkSync(filepath);
    }
  } catch {
    // ignore
  }
}

// Helpers

function readStateFromFile(filepath: string): Record<string, string> {
  try {
    const content = readFileSync(filepath, 'utf-8');
    return parseStateFile(content) as Record<string, string>;
  } catch {
    return {};
  }
}

function extractPrNumber(prUrl: string): string {
  const match = prUrl.match(/\/pull\/(\d+)/);
  return match ? match[1] : prUrl;
}

// Diagnostics for telemetry (kaizen #792)

export type ExcludeReason = 'stale' | 'no_branch' | 'wrong_branch' | 'read_error';

export interface StateFileDiagnostic {
  filename: string;
  status?: string;
  branch?: string;
  included: boolean;
  excludeReason?: ExcludeReason;
  ageSeconds?: number;
}

export interface GateDiagnostics {
  totalFiles: number;
  includedFiles: number;
  excludedFiles: number;
  excludeReasons: Record<ExcludeReason, number>;
  files: StateFileDiagnostic[];
}

/**
 * Scan the state directory and produce diagnostics showing why each file
 * was included or excluded. Used by stop-gate telemetry (kaizen #792).
 */
export function scanStateDirectoryDiagnostics(
  currentBranch: string,
  stateDir: string = DEFAULT_STATE_DIR,
  maxAge: number = 7200,
): GateDiagnostics {
  const diagnostics: StateFileDiagnostic[] = [];
  const excludeReasons: Record<ExcludeReason, number> = {
    stale: 0,
    no_branch: 0,
    wrong_branch: 0,
    read_error: 0,
  };

  if (!existsSync(stateDir)) {
    return { totalFiles: 0, includedFiles: 0, excludedFiles: 0, excludeReasons, files: [] };
  }

  const now = Date.now() / 1000;
  let entries: string[];
  try {
    entries = readdirSync(stateDir);
  } catch {
    return { totalFiles: 0, includedFiles: 0, excludedFiles: 0, excludeReasons, files: [] };
  }

  for (const entry of entries) {
    const filepath = join(stateDir, entry);
    let content: string;
    let mtime: number;

    try {
      content = readFileSync(filepath, 'utf-8');
      mtime = statSync(filepath).mtimeMs / 1000;
    } catch {
      diagnostics.push({ filename: entry, included: false, excludeReason: 'read_error' });
      excludeReasons.read_error++;
      continue;
    }

    const state = parseStateFile(content);
    const ageSeconds = Math.round(now - mtime);

    if (ageSeconds > maxAge) {
      diagnostics.push({
        filename: entry,
        status: state.STATUS,
        branch: state.BRANCH,
        included: false,
        excludeReason: 'stale',
        ageSeconds,
      });
      excludeReasons.stale++;
      continue;
    }

    if (!state.BRANCH) {
      diagnostics.push({
        filename: entry,
        status: state.STATUS,
        included: false,
        excludeReason: 'no_branch',
        ageSeconds,
      });
      excludeReasons.no_branch++;
      continue;
    }

    if (state.BRANCH !== currentBranch) {
      diagnostics.push({
        filename: entry,
        status: state.STATUS,
        branch: state.BRANCH,
        included: false,
        excludeReason: 'wrong_branch',
        ageSeconds,
      });
      excludeReasons.wrong_branch++;
      continue;
    }

    diagnostics.push({
      filename: entry,
      status: state.STATUS,
      branch: state.BRANCH,
      included: true,
      ageSeconds,
    });
  }

  const includedFiles = diagnostics.filter((d) => d.included).length;
  return {
    totalFiles: diagnostics.length,
    includedFiles,
    excludedFiles: diagnostics.length - includedFiles,
    excludeReasons,
    files: diagnostics,
  };
}
