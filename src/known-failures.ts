/**
 * known-failures.ts — the single source of truth for "known failing test ->
 * owned open issue" (#1518).
 *
 * A failing test is either part of the current change and must be fixed before
 * merge, or it is a separate, tracked incident with exactly one owning OPEN
 * issue. It can never be invisible background noise. This module loads and
 * validates the registry (`.agents/kaizen/known-failures.json`) and provides
 * the classification primitives reused by:
 *   - `run-all-tests.sh` (via `scripts/known-failures-status.ts --classify`):
 *     unowned failures fail the suite; owned ones are logged and tolerated.
 *   - the `known-failures` CI gate (`--validate`): every entry's owning issue
 *     must be OPEN, or CI fails.
 *   - the merge-readiness SSOT (`qualityVerdictBlockReasons`, via a `testHealth`
 *     signal): a run that observed unowned failures is not merge-ready.
 *
 * Keeping one classifier here (rather than re-deriving ownership in bash, in CI,
 * and at the merge gate) is the DRY/consolidation requirement of this work.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveProjectRoot } from './lib/resolve-project-root.js';

/** Registry location, relative to the project root. */
export const KNOWN_FAILURES_PATH = '.agents/kaizen/known-failures.json';

export interface KnownFailure {
  /**
   * Substring matched against a failing test id — a Vitest test name, a shell
   * test file, or a legacy pytest nodeid.
   * Coarser strings (a file name) intentionally cover every failure in that
   * file; use the full nodeid to scope to a single case.
   */
  test: string;
  /** Owning GitHub issue number. Must reference an OPEN issue. */
  issue: number;
  /** Why this failure is tolerated for now (human context). */
  reason: string;
  /** Optional: who registered the entry. */
  addedBy?: string;
}

export interface KnownFailuresValidation {
  ok: boolean;
  errors: string[];
  entries: KnownFailure[];
}

export type IssueState = 'open' | 'closed' | 'missing';

export interface OwnershipProblem {
  issue: number;
  state: IssueState;
  tests: string[];
}

/** Absolute path to the registry for the given (or detected) project root. */
export function knownFailuresPath(root: string = resolveProjectRoot(process.cwd())): string {
  return join(root, KNOWN_FAILURES_PATH);
}

/** Parse + validate registry content. Unknown top-level keys (e.g. `_doc`) are ignored. */
export function parseKnownFailures(content: string): KnownFailuresValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return { ok: false, errors: [`invalid JSON: ${(e as Error).message}`], entries: [] };
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { knownFailures?: unknown }).knownFailures)) {
    return { ok: false, errors: ['expected an object with a "knownFailures" array'], entries: [] };
  }

  const raw = (parsed as { knownFailures: unknown[] }).knownFailures;
  const errors: string[] = [];
  const entries: KnownFailure[] = [];

  raw.forEach((entry, i) => {
    const where = `knownFailures[${i}]`;
    if (!entry || typeof entry !== 'object') {
      errors.push(`${where}: must be an object`);
      return;
    }
    const { test, issue, reason, addedBy } = entry as Partial<KnownFailure>;
    // A `test` must look like a real test identifier, not a catch-all. Naive
    // `id.includes(test)` matching means an over-broad entry (e.g. "test" or
    // "py") would silently tolerate unrelated failures — so require a recognizable
    // delimiter (`.`/`/`/`:`/`-`, present in every test file/name/id, or
    // shell test file) and a minimum length. Use the full nodeid to be safe.
    const testStr = typeof test === 'string' ? test.trim() : '';
    const testOk = testStr.length >= 5 && /[.:/\\-]/.test(testStr);
    const issueOk = typeof issue === 'number' && Number.isInteger(issue) && issue > 0;
    const reasonOk = typeof reason === 'string' && reason.trim().length > 0;
    if (!testOk) errors.push(`${where}.test: must be a specific test id (≥5 chars and contain one of . / : -), not a catch-all`);
    if (!issueOk) errors.push(`${where}.issue: must be a positive integer (the owning open issue)`);
    if (!reasonOk) errors.push(`${where}.reason: must be a non-empty string (why it is tolerated)`);
    if (testOk && issueOk && reasonOk) {
      entries.push({
        test: testStr,
        issue: issue!,
        reason: reason!.trim(),
        ...(typeof addedBy === 'string' && addedBy.trim() ? { addedBy: addedBy.trim() } : {}),
      });
    }
  });

  return { ok: errors.length === 0, errors, entries };
}

/** Load the registry from disk. A missing file is treated as an empty registry. */
export function loadKnownFailures(root?: string): KnownFailuresValidation {
  const path = knownFailuresPath(root);
  if (!existsSync(path)) return { ok: true, errors: [], entries: [] };
  return parseKnownFailures(readFileSync(path, 'utf8'));
}

/** The registry entry that owns a failing test id, if any (substring match). */
export function isKnownFailure(testId: string, entries: KnownFailure[]): KnownFailure | undefined {
  const id = testId.trim();
  if (!id) return undefined;
  return entries.find(e => id.includes(e.test));
}

/** The failing ids NOT covered by any registry entry — these must block. */
export function unownedFailures(failingIds: string[], entries: KnownFailure[]): string[] {
  return failingIds.map(s => s.trim()).filter(Boolean).filter(id => !isKnownFailure(id, entries));
}

/**
 * Registry entries whose owning issue is not OPEN — a closed/missing owner means
 * the failure is no longer tracked, so the entry must be removed (fix the test)
 * or re-filed. Pure: the issue-state lookup is injected for testability.
 */
export function findOwnershipProblems(
  entries: KnownFailure[],
  stateOf: (issue: number) => IssueState,
): OwnershipProblem[] {
  const byIssue = new Map<number, string[]>();
  for (const e of entries) {
    const tests = byIssue.get(e.issue) ?? [];
    tests.push(e.test);
    byIssue.set(e.issue, tests);
  }
  const problems: OwnershipProblem[] = [];
  for (const [issue, tests] of byIssue) {
    const state = stateOf(issue);
    if (state !== 'open') problems.push({ issue, state, tests });
  }
  return problems;
}
