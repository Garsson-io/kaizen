#!/usr/bin/env npx tsx
/**
 * Stale-PR triage (#1159).
 *
 * The rescue finalizer (`auto-dent-rescue.ts`, #1255) drives PRs/strands created
 * during the *current* run's exit to a terminal state, and the merge babysitter
 * (#1129) drives *in-batch queued* PRs. Neither ever looks at **pre-existing**
 * open PRs that predate the current batch — so a graveyard of stale PRs (e.g.
 * #845/#847/#1021/#1026/#1084) sits in limbo: not abandoned-and-closed, not
 * finished-and-merged. Several encode already-shipped decisions yet none get
 * closed. This is the unmet, pre-existing-PR half of "prevent work from being
 * abandoned".
 *
 * This module is the complement: it lists open PRs older than N days, classifies
 * each (superseded / mergeable / resumable / needs-review), and proposes a
 * terminal action. Report-only by default; `--apply` closes ONLY the
 * high-confidence `close-superseded` PRs (whose linked `Closes #N` issue is
 * already CLOSED).
 *
 * DRY: reuses the shared `gh()` wrapper and `queryIssueState` rather than adding
 * a second gh wrapper or a second issue-state query. The pure decision core
 * (`classifyStalePr`) mirrors `decideRescueAction`'s guarded-precedence +
 * annotated-reason style and is the unit-testable seam.
 */

import { gh as defaultGh } from '../src/lib/gh-exec.js';
import { queryIssueState, type GhRunner, type IssueState } from '../src/lib/github-pr.js';

/** Mergeability as reported by `gh pr list --json mergeable`. */
export type Mergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';

/** Proposed terminal action for a stale PR, in precedence order. */
export type StalePrAction =
  | 'skip-fresh' // younger than the staleness threshold — leave it alone
  | 'close-superseded' // linked issue already CLOSED — pure noise, close it
  | 'merge-ready' // clean, non-draft, issue still open — propose merge
  | 'resume' // conflicting — needs rebase/rework to reach a terminal state
  | 'review'; // unknown mergeability or draft — needs a human/agent look

export interface StalePrInput {
  /** Days since the PR was last updated. */
  ageDays: number;
  /** Staleness threshold; PRs younger than this are skipped. */
  staleDays: number;
  /**
   * States of EVERY issue the PR closes (`Closes #A, #B`), in body order. Empty
   * when there is no closing reference. Each entry is null when that issue's
   * lookup failed. Fail-open: a null is NEVER treated as CLOSED (mirrors
   * {@link queryIssueState} discipline, #1225/#1300), and a PR is only
   * superseded when it closes at least one issue and EVERY one is CLOSED — a PR
   * that closes #A (open) and #B (closed) is NOT noise.
   */
  linkedIssueStates: (IssueState | null)[];
  /** Mergeability as reported by GitHub. */
  mergeable: Mergeable;
  /** Whether the PR is a draft. */
  isDraft: boolean;
}

export interface StalePrTriage {
  action: StalePrAction;
  reason: string;
}

/**
 * Decide the terminal action for one stale PR. Pure — no I/O.
 *
 * Precedence (most authoritative terminal signal first):
 *  1. fresh (ageDays < staleDays)            -> skip-fresh
 *  2. ALL linked issues CLOSED                -> close-superseded
 *  3. CONFLICTING                             -> resume
 *  4. MERGEABLE && !draft                     -> merge-ready
 *  5. otherwise (UNKNOWN / draft)             -> review
 *
 * The closed-issue signal wins over mergeability because a PR whose closing
 * issues are all resolved is pure noise regardless of whether it would merge
 * cleanly. A null entry is never treated as CLOSED, and close-superseded
 * requires EVERY closing issue to be CLOSED — so an unknown/missing linkage, or
 * a PR that still closes one open issue, can never trigger a close.
 */
export function classifyStalePr(input: StalePrInput): StalePrTriage {
  if (input.ageDays < input.staleDays) {
    return {
      action: 'skip-fresh',
      reason: `updated ${input.ageDays}d ago, under the ${input.staleDays}d staleness threshold`,
    };
  }

  if (input.linkedIssueStates.length > 0 && input.linkedIssueStates.every((s) => s === 'CLOSED')) {
    return {
      action: 'close-superseded',
      reason: 'every linked Closes-issue is already CLOSED — the work it closes is resolved; pure noise',
    };
  }

  if (input.mergeable === 'CONFLICTING') {
    return {
      action: 'resume',
      reason: 'merge conflicts — needs rebase/rework before it can reach a terminal state',
    };
  }

  if (input.mergeable === 'MERGEABLE' && !input.isDraft) {
    return {
      action: 'merge-ready',
      reason: 'clean, non-draft, linked issue still open — propose merge',
    };
  }

  return {
    action: 'review',
    reason: input.isDraft
      ? 'draft PR — needs a human/agent decision (never auto-merged)'
      : 'mergeability unknown — needs a human/agent look',
  };
}

// Matches a closing keyword adjacent to one or more comma-separated `#N`
// references, e.g. `Closes #1081, #1080, #1082`. The lead `#N` is captured by
// the keyword group; trailing `, #N` items are picked up by re-scanning.
const CLOSING_KEYWORD_G = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s*#(\d+)((?:\s*,\s*#\d+)*)/gi;
const HASH_NUMBER_G = /#(\d+)/g;

/**
 * Extract EVERY issue number a PR body closes, honoring the I1 keyword grammar:
 * a `#N` counts only when adjacent to a closing keyword (close/closes/closed,
 * fix/fixes/fixed, resolve/resolves/resolved), including comma-separated lists
 * like `Closes #1081, #1080, #1082`. Returns the numbers in body order, deduped.
 *
 * Informational references (`Parent: #N`, `Refs: #N`) are NOT closing keywords,
 * so they are excluded — they must not drive a supersede/close decision.
 */
export function extractClosesIssues(body: string | null | undefined): number[] {
  if (!body) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const m of body.matchAll(CLOSING_KEYWORD_G)) {
    // m[1] is the lead number; m[2] holds any `, #N` continuation.
    for (const h of `#${m[1]}${m[2] ?? ''}`.matchAll(HASH_NUMBER_G)) {
      const n = parseInt(h[1], 10);
      if (Number.isFinite(n) && n > 0 && !seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI plumbing (thin shell around the pure core above).
// ---------------------------------------------------------------------------

interface RawPr {
  number: number;
  title: string;
  updatedAt: string;
  isDraft: boolean;
  mergeable: string;
  body: string;
  url: string;
}

export interface TriageRow {
  number: number;
  title: string;
  url: string;
  ageDays: number;
  closesIssues: number[];
  triage: StalePrTriage;
}

function normalizeMergeable(raw: string): Mergeable {
  return raw === 'MERGEABLE' || raw === 'CONFLICTING' ? raw : 'UNKNOWN';
}

/** Whole days between an ISO timestamp and `now` (clamped at 0). */
export function ageInDays(updatedAtIso: string, nowMs: number): number {
  const then = Date.parse(updatedAtIso);
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, Math.floor((nowMs - then) / 86_400_000));
}

interface TriageDeps {
  gh: GhRunner;
  nowMs: number;
  repo: string;
  staleDays: number;
  limit: number;
}

/** Fetch open PRs and classify each. Pure-ish: all I/O goes through `deps.gh`. */
export function triageOpenPrs(deps: TriageDeps): TriageRow[] {
  const out = deps.gh([
    'pr', 'list',
    '--repo', deps.repo,
    '--state', 'open',
    '--json', 'number,title,updatedAt,isDraft,mergeable,body,url',
    '--limit', String(deps.limit),
  ]);
  let prs: RawPr[];
  try {
    prs = JSON.parse(out || '[]') as RawPr[];
  } catch {
    return [];
  }
  if (!Array.isArray(prs)) return [];

  const rows: TriageRow[] = [];
  for (const pr of prs) {
    const ageDays = ageInDays(pr.updatedAt, deps.nowMs);
    const closesIssues = extractClosesIssues(pr.body);
    // Only spend issue-state lookups on PRs that are actually stale.
    const linkedIssueStates: (IssueState | null)[] =
      ageDays >= deps.staleDays
        ? closesIssues.map((issue) => queryIssueState({ repo: deps.repo, issue, gh: deps.gh }))
        : [];
    const triage = classifyStalePr({
      ageDays,
      staleDays: deps.staleDays,
      linkedIssueStates,
      mergeable: normalizeMergeable(pr.mergeable),
      isDraft: pr.isDraft,
    });
    rows.push({ number: pr.number, title: pr.title, url: pr.url, ageDays, closesIssues, triage });
  }
  return rows;
}

export interface CliOptions {
  repo: string;
  staleDays: number;
  limit: number;
  apply: boolean;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { repo: '', staleDays: 21, limit: 100, apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') opts.repo = argv[++i] ?? '';
    else if (arg === '--stale-days') opts.staleDays = parseInt(argv[++i] ?? '', 10);
    else if (arg === '--limit') opts.limit = parseInt(argv[++i] ?? '', 10);
    else if (arg === '--apply') opts.apply = true;
  }
  if (!opts.repo) throw new Error('--repo <owner/name> is required');
  if (!Number.isFinite(opts.staleDays) || opts.staleDays < 0) opts.staleDays = 21;
  if (!Number.isFinite(opts.limit) || opts.limit <= 0) opts.limit = 100;
  return opts;
}

const ACTION_ORDER: StalePrAction[] = [
  'close-superseded',
  'resume',
  'merge-ready',
  'review',
  'skip-fresh',
];

export function formatReport(rows: TriageRow[]): string {
  const lines: string[] = [];
  for (const action of ACTION_ORDER) {
    const group = rows.filter((r) => r.triage.action === action);
    if (group.length === 0) continue;
    lines.push(`\n## ${action} (${group.length})`);
    for (const r of group) {
      const closes = r.closesIssues.length > 0 ? ` closes ${r.closesIssues.map((n) => `#${n}`).join(', ')}` : '';
      lines.push(`  #${r.number} (${r.ageDays}d${closes}) — ${r.title}`);
      lines.push(`    ${r.triage.reason}`);
      lines.push(`    ${r.url}`);
    }
  }
  return lines.join('\n');
}

export interface ApplyDeps {
  gh: GhRunner;
  repo: string;
  log?: (msg: string) => void;
  err?: (msg: string) => void;
}

export interface ApplyResult {
  closed: number[];
  failed: number[];
}

/**
 * Apply the ONLY terminal action this tool performs automatically: close the
 * `close-superseded` PRs (whose every `Closes #N` issue is already CLOSED).
 * `resume`/`merge-ready`/`review` are deliberately NOT auto-actioned — they are
 * not safely automatable. Each close is guarded; a per-PR failure is recorded
 * and logged but never aborts the rest. Returns the outcome for the caller/test.
 */
export function applyTriage(rows: TriageRow[], deps: ApplyDeps): ApplyResult {
  const log = deps.log ?? (() => {});
  const err = deps.err ?? (() => {});
  const result: ApplyResult = { closed: [], failed: [] };
  for (const r of rows.filter((x) => x.triage.action === 'close-superseded')) {
    const issueList = r.closesIssues.map((n) => `#${n}`).join(', ');
    const comment = `Closing as superseded: the linked issue(s) ${issueList} this PR closes are already resolved. (stale-pr-triage #1159)`;
    try {
      deps.gh(['pr', 'close', String(r.number), '--repo', deps.repo, '--comment', comment]);
      result.closed.push(r.number);
      log(`closed #${r.number} (superseded by resolved ${issueList})`);
    } catch (e) {
      result.failed.push(r.number);
      err(`failed to close #${r.number}: ${(e as Error).message}`);
    }
  }
  return result;
}

function main(argv: string[]): void {
  const opts = parseCliArgs(argv);
  const gh: GhRunner = (args) => defaultGh(args);
  const rows = triageOpenPrs({
    gh,
    nowMs: Date.now(),
    repo: opts.repo,
    staleDays: opts.staleDays,
    limit: opts.limit,
  });

  console.log(`Stale-PR triage — ${opts.repo} (threshold ${opts.staleDays}d, ${rows.length} open PRs)`);
  console.log(formatReport(rows));

  if (!opts.apply) {
    const superseded = rows.filter((r) => r.triage.action === 'close-superseded');
    if (superseded.length > 0) {
      console.log(`\n${superseded.length} PR(s) classified close-superseded. Re-run with --apply to close them.`);
    }
    return;
  }

  applyTriage(rows, {
    gh,
    repo: opts.repo,
    log: (m) => console.log(m),
    err: (m) => console.error(m),
  });
}

function isMain(): boolean {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2));
}
