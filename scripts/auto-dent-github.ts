/**
 * auto-dent-github — GitHub CLI operations for auto-dent batch runs.
 *
 * Extracted from auto-dent-run.ts (#600) to reduce cognitive load
 * and enable isolated testing of GitHub interactions.
 *
 * All functions wrap the `gh` CLI and are tolerant of failures
 * (logging warnings rather than throwing).
 */

import { gh } from '../src/lib/gh-exec.js';
import type { RunResult } from './auto-dent-run.js';

// GitHub CLI wrapper (tolerant of failures)

/**
 * Parse a shell-style command string into an array of arguments.
 * Handles double-quoted strings (with JSON/shell escape sequences) and
 * single-quoted strings. Does NOT interpret backticks or $() substitutions —
 * that is exactly the point: user-controlled data (e.g. markdown backtick
 * code-spans in --body) never reaches a shell.
 */
export function parseShellArgs(cmd: string): string[] {
  const args: string[] = [];
  let current = '';
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === ' ' || c === '\t') {
      if (current !== '') { args.push(current); current = ''; }
      i++;
    } else if (c === '"') {
      i++;
      while (i < cmd.length && cmd[i] !== '"') {
        if (cmd[i] === '\\' && i + 1 < cmd.length) {
          const esc = cmd[i + 1];
          if (esc === '"' || esc === '\\' || esc === '/') { current += esc; i += 2; }
          else if (esc === 'n') { current += '\n'; i += 2; }
          else if (esc === 'r') { current += '\r'; i += 2; }
          else if (esc === 't') { current += '\t'; i += 2; }
          else { current += '\\'; current += esc; i += 2; }
        } else {
          current += cmd[i]; i++;
        }
      }
      i++;
    } else if (c === "'") {
      i++;
      while (i < cmd.length && cmd[i] !== "'") { current += cmd[i]; i++; }
      i++;
    } else {
      current += c; i++;
    }
  }
  if (current !== '') args.push(current);
  return args;
}

/**
 * Execute a gh CLI command without going through a shell.
 * Parses the command string into args, then delegates to gh() from
 * gh-exec.ts. Swallows errors (returns '') for backward compatibility.
 */
export function ghExec(cmd: string): string {
  const args = parseShellArgs(cmd);
  const [_bin, ...rest] = args;
  try {
    return gh(rest);
  } catch (e: any) {
    console.log(
      `  [hygiene] warning: ${cmd.slice(0, 80)}... -> ${e.message?.split('\n')[0] || 'failed'}`,
    );
    return '';
  }
}

// Issue label lookup

/**
 * Fetch labels for a GitHub issue by number.
 * Returns an array of label names, or empty array on failure.
 * Best-effort: never throws.
 */
export function fetchIssueLabels(issueRef: string, repo: string): string[] {
  // issueRef may be "#123" or "123" or a full URL
  const numMatch = issueRef.match(/(\d+)/);
  if (!numMatch) return [];
  const issueNum = numMatch[1];
  try {
    const json = ghExec(
      `gh issue view ${issueNum} --repo ${repo} --json labels`,
    );
    if (!json) return [];
    const data = JSON.parse(json);
    return (data.labels || []).map((l: { name: string }) => l.name);
  } catch {
    return [];
  }
}

// Merge status

export type MergeStatus =
  | 'merged'
  | 'auto_queued'
  | 'open'
  | 'closed'
  | 'unknown';

export function checkMergeStatus(prUrl: string): MergeStatus {
  const m = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (!m) return 'unknown';
  try {
    const json = ghExec(
      `gh pr view ${m[2]} --repo ${m[1]} --json state,mergeStateStatus,autoMergeRequest`,
    );
    if (!json) return 'unknown';
    const data = JSON.parse(json);
    if (data.state === 'MERGED') return 'merged';
    if (data.state === 'CLOSED') return 'closed';
    if (data.autoMergeRequest) return 'auto_queued';
    return 'open';
  } catch {
    return 'unknown';
  }
}

// Active merge babysitter (#1129)
//
// queueAutoMerge() fires `gh pr merge --auto` and exits. That alone leaves
// queued PRs to stall: when main advances (a sibling PR merges), a PR falls
// BEHIND and its queued merge waits forever, while a blocked/conflicting PR
// just sits open — both reported as "queued" with no reason (#368). This
// babysitter polls each PR until it merges, closes, is classified stuck (with a
// reason), or a bounded attempt budget is exhausted, re-updating BEHIND branches
// across attempts. It only REPORTS — the `--auto` queue stays in place, so
// GitHub may still merge server-side later. (Supersedes the earlier one-shot
// branch sweep, which updated BEHIND branches exactly once; #368 H1/H4.)

export type DriveStatus = 'merged' | 'closed' | 'stuck';
export type DriveReason =
  | 'blocked'
  | 'conflicting'
  | 'checks_failing'
  | 'timed_out'
  | 'unknown';

export interface DriveResult {
  pr: string;
  status: DriveStatus;
  /** Present only when status is 'stuck' — why it didn't merge. */
  reason?: DriveReason;
  /** Number of poll attempts spent on this PR. */
  attempts: number;
}

export interface DriveOptions {
  /** Max poll attempts per PR before giving up (default 20). */
  maxAttempts?: number;
  /** Milliseconds to sleep between polling rounds (default 15000). */
  sleepMs?: number;
  /** Injectable sleep — default is a real synchronous sleep; tests pass a no-op. */
  sleep?: (ms: number) => void;
}

/**
 * Synchronous sleep. The auto-dent post-run path is already synchronous (gh
 * calls block via spawnSync), so the babysitter blocks rather than introducing
 * async plumbing. Atomics.wait is the standard way to sleep a thread without
 * busy-waiting.
 */
function defaultSleep(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Classify a single `gh pr view` payload into a terminal verdict, or null to
 * keep polling. Failing required checks and merge conflicts won't resolve
 * without a new push, so they are terminal-stuck; BEHIND/CLEAN/UNSTABLE are
 * transient and keep polling.
 */
export function classifyMergeView(
  data: {
    state?: string;
    mergeStateStatus?: string;
    statusCheckRollup?: Array<{ state?: string; conclusion?: string }>;
  },
): { status: DriveStatus; reason?: DriveReason } | null {
  if (data.state === 'MERGED') return { status: 'merged' };
  if (data.state === 'CLOSED') return { status: 'closed' };

  const checks = Array.isArray(data.statusCheckRollup) ? data.statusCheckRollup : [];
  const failed = checks.some((c) => {
    const s = (c?.state ?? c?.conclusion ?? '').toString().toUpperCase();
    return s === 'FAILURE' || s === 'ERROR' || s === 'TIMED_OUT' || s === 'CANCELLED';
  });
  if (failed) return { status: 'stuck', reason: 'checks_failing' };

  switch (data.mergeStateStatus) {
    case 'DIRTY':
      return { status: 'stuck', reason: 'conflicting' };
    case 'BLOCKED':
      return { status: 'stuck', reason: 'blocked' };
    default:
      // BEHIND / CLEAN / UNSTABLE / HAS_HOOKS / UNKNOWN → not terminal yet.
      return null;
  }
}

interface PrPollState {
  pr: string;
  repo: string;
  num: string;
  status: DriveStatus | 'pending';
  reason?: DriveReason;
  attempts: number;
}

export function driveBatchToMerge(
  prUrls: string[],
  opts: DriveOptions = {},
): DriveResult[] {
  const maxAttempts = opts.maxAttempts ?? 20;
  const sleepMs = opts.sleepMs ?? 15000;
  const sleep = opts.sleep ?? defaultSleep;

  const states: PrPollState[] = [];
  for (const pr of prUrls) {
    const m = pr.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (!m) continue; // skip invalid URLs (best-effort, module convention)
    states.push({ pr, repo: m[1], num: m[2], status: 'pending', attempts: 0 });
  }
  if (states.length === 0) return [];

  let round = 0;
  while (states.some((s) => s.status === 'pending') && round < maxAttempts) {
    round++;
    if (round > 1) sleep(sleepMs); // don't sleep before the first poll
    for (const s of states) {
      if (s.status !== 'pending') continue;
      s.attempts = round;

      const json = ghExec(
        `gh pr view ${s.num} --repo ${s.repo} --json state,mergeStateStatus,statusCheckRollup,autoMergeRequest`,
      );
      if (!json) {
        s.reason = 'unknown'; // couldn't read — leave pending for the budget
        continue;
      }

      let data: {
        state?: string;
        mergeStateStatus?: string;
        autoMergeRequest?: unknown;
        statusCheckRollup?: Array<{ state?: string; conclusion?: string }>;
      };
      try {
        data = JSON.parse(json);
      } catch {
        s.reason = 'unknown';
        continue;
      }

      const verdict = classifyMergeView(data);
      if (verdict) {
        s.status = verdict.status;
        s.reason = verdict.reason;
        continue;
      }

      // Non-terminal. If BEHIND with auto-merge queued, re-update the branch —
      // the part the one-shot sweep could only do once (#368). Then keep polling.
      if (data.mergeStateStatus === 'BEHIND' && data.autoMergeRequest) {
        ghExec(
          `gh api repos/${s.repo}/pulls/${s.num}/update-branch -X PUT -f expected_head_sha=""`,
        );
      }
      s.reason = 'timed_out'; // in-progress; if the budget runs out, it timed out
    }
  }

  return states.map((s) => {
    if (s.status === 'pending') {
      return {
        pr: s.pr,
        status: 'stuck' as const,
        reason: s.reason ?? 'timed_out',
        attempts: s.attempts,
      };
    }
    const r: DriveResult = {
      pr: s.pr,
      status: s.status as DriveStatus,
      attempts: s.attempts,
    };
    if (s.status === 'stuck' && s.reason) r.reason = s.reason;
    return r;
  });
}

// Artifact labeling and auto-merge

export function labelArtifacts(result: RunResult, label: string): void {
  for (const pr of result.prs) {
    const m = pr.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (m) {
      ghExec(`gh pr edit ${m[2]} --repo ${m[1]} --add-label ${label}`);
      console.log(`  [hygiene] labeled PR ${pr}`);
    }
  }
  for (const issue of result.issuesFiled) {
    const m = issue.match(/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/);
    if (m) {
      ghExec(`gh issue edit ${m[2]} --repo ${m[1]} --add-label ${label}`);
      console.log(`  [hygiene] labeled issue ${issue}`);
    }
  }
}

export function queueAutoMerge(result: RunResult, hostRepo: string): void {
  for (const pr of result.prs) {
    const m = pr.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (m) {
      const out = ghExec(
        `gh pr merge ${m[2]} --repo ${m[1]} --squash --delete-branch --auto`,
      );
      if (out) {
        console.log(`  [hygiene] queued auto-merge for PR ${pr}`);
      }
    }
  }
}

// PR cleanup — close superseded PRs whose target issues are already closed

export interface CleanupResult {
  pr: string;
  action: 'closed' | 'already_closed' | 'already_merged' | 'still_open' | 'no_issue' | 'failed';
  issue?: string;
}

/**
 * Extract the linked issue number from a PR body.
 * Looks for "Closes #NNN", "Fixes #NNN", "Resolves #NNN" patterns.
 */
export function extractLinkedIssue(prBody: string): string | null {
  const match = prBody.match(
    /(?:closes?|fix(?:es|ed)?|resolves?)\s+#(\d+)/i,
  );
  return match ? match[1] : null;
}

/**
 * Check if a GitHub issue is closed.
 */
export function isIssueClosed(issueNum: string, repo: string): boolean {
  const json = ghExec(
    `gh issue view ${issueNum} --repo ${repo} --json state`,
  );
  if (!json) return false;
  try {
    return JSON.parse(json).state === 'CLOSED';
  } catch {
    return false;
  }
}

/**
 * Close superseded PRs — PRs from a batch whose target issues are already closed.
 *
 * When a batch run fixes an issue and a later run (or earlier parallel run)
 * also created a PR for the same issue, the second PR is superseded.
 * This function finds and closes those stale PRs.
 */
export function cleanupSupersededPRs(
  prUrls: string[],
  repo: string,
): CleanupResult[] {
  const results: CleanupResult[] = [];

  for (const prUrl of prUrls) {
    const m = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (!m) continue;

    const [, prRepo, prNum] = m;

    try {
      // Get PR state and body
      const json = ghExec(
        `gh pr view ${prNum} --repo ${prRepo} --json state,body`,
      );
      if (!json) {
        results.push({ pr: prUrl, action: 'failed' });
        continue;
      }

      const data = JSON.parse(json);

      if (data.state === 'MERGED') {
        results.push({ pr: prUrl, action: 'already_merged' });
        continue;
      }
      if (data.state === 'CLOSED') {
        results.push({ pr: prUrl, action: 'already_closed' });
        continue;
      }

      // Extract linked issue
      const issueNum = extractLinkedIssue(data.body || '');
      if (!issueNum) {
        results.push({ pr: prUrl, action: 'no_issue' });
        continue;
      }

      // Check if linked issue is closed
      if (isIssueClosed(issueNum, repo)) {
        // Close the superseded PR
        const closeResult = ghExec(
          `gh pr close ${prNum} --repo ${prRepo} --comment "Superseded — issue #${issueNum} was already resolved by another PR in this batch."`,
        );
        if (closeResult !== undefined) {
          console.log(`  [cleanup] closed superseded PR #${prNum} (issue #${issueNum} already resolved)`);
          results.push({ pr: prUrl, action: 'closed', issue: `#${issueNum}` });
        } else {
          results.push({ pr: prUrl, action: 'failed', issue: `#${issueNum}` });
        }
      } else {
        results.push({ pr: prUrl, action: 'still_open', issue: `#${issueNum}` });
      }
    } catch {
      results.push({ pr: prUrl, action: 'failed' });
    }
  }

  return results;
}

// Epic checklist sync (#730)

export interface EpicSyncResult {
  epic: string;
  issuesChecked: string[];
  alreadyChecked: string[];
}

/**
 * Extract issue numbers from an epic body's checklist.
 * Matches `- [ ] #NNN` and `- [x] #NNN` patterns.
 */
export function parseEpicChecklist(body: string): Array<{ issue: string; checked: boolean }> {
  const items: Array<{ issue: string; checked: boolean }> = [];
  const regex = /- \[([ x])\] #(\d+)/g;
  let match;
  while ((match = regex.exec(body)) !== null) {
    items.push({ issue: match[2], checked: match[1] === 'x' });
  }
  return items;
}

/**
 * Sync epic checklists — for each closed issue, find open epics that reference
 * it in their checklist and check off the corresponding `- [ ] #NNN` entry.
 *
 * Scans all open issues with the `epic` label in the given repo.
 * Returns results per epic that was modified.
 */
export function syncEpicChecklists(
  closedIssueNums: string[],
  repo: string,
): EpicSyncResult[] {
  if (closedIssueNums.length === 0) return [];

  const closedSet = new Set(closedIssueNums);
  const results: EpicSyncResult[] = [];

  // Get all open epics
  const epicListJson = ghExec(
    `gh issue list --repo ${repo} --label epic --state open --json number,body --limit 50`,
  );
  if (!epicListJson) return [];

  let epics: Array<{ number: number; body: string }>;
  try {
    epics = JSON.parse(epicListJson);
  } catch {
    return [];
  }

  for (const epic of epics) {
    const checklistItems = parseEpicChecklist(epic.body);
    const toCheck = checklistItems.filter(
      (item) => !item.checked && closedSet.has(item.issue),
    );
    const alreadyChecked = checklistItems.filter(
      (item) => item.checked && closedSet.has(item.issue),
    );

    if (toCheck.length === 0) continue;

    // Build updated body
    let updatedBody = epic.body;
    for (const item of toCheck) {
      updatedBody = updatedBody.replace(
        new RegExp(`- \\[ \\] #${item.issue}\\b`),
        `- [x] #${item.issue}`,
      );
    }

    // Update the epic body via gh
    ghExec(
      `gh issue edit ${epic.number} --repo ${repo} --body ${JSON.stringify(updatedBody)}`,
    );
    console.log(
      `  [epic-sync] #${epic.number}: checked off ${toCheck.map((i) => '#' + i.issue).join(', ')}`,
    );

    results.push({
      epic: `#${epic.number}`,
      issuesChecked: toCheck.map((i) => '#' + i.issue),
      alreadyChecked: alreadyChecked.map((i) => '#' + i.issue),
    });
  }

  return results;
}

// Squash-merge auto-close verification (#730)

export interface VerifyCloseResult {
  pr: string;
  verified: string[];
  forceClosed: string[];
}

/**
 * Extract all issue numbers referenced by close keywords in a PR body.
 * Matches: Closes #NNN, Fixes #NNN, Resolves #NNN (case-insensitive, multiple).
 */
export function extractAllLinkedIssues(prBody: string): string[] {
  const issues: string[] = [];
  const regex = /(?:closes?|fix(?:es|ed)?|resolves?)\s+#(\d+)/gi;
  let match;
  while ((match = regex.exec(prBody)) !== null) {
    issues.push(match[1]);
  }
  return [...new Set(issues)];
}

/**
 * After PRs are merged, verify that issues they claimed to close are actually
 * closed on GitHub. If any are still open, close them explicitly.
 *
 * This guards against a known GitHub edge case where squash-merge doesn't
 * always fire the auto-close mechanism.
 */
export function verifyIssuesClosed(
  prUrls: string[],
  repo: string,
): VerifyCloseResult[] {
  const results: VerifyCloseResult[] = [];

  for (const prUrl of prUrls) {
    const m = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (!m) continue;
    const [, prRepo, prNum] = m;

    try {
      const json = ghExec(
        `gh pr view ${prNum} --repo ${prRepo} --json state,body`,
      );
      if (!json) continue;

      const data = JSON.parse(json);
      if (data.state !== 'MERGED') continue;

      const linkedIssues = extractAllLinkedIssues(data.body || '');
      if (linkedIssues.length === 0) continue;

      const verified: string[] = [];
      const forceClosed: string[] = [];

      for (const issueNum of linkedIssues) {
        if (isIssueClosed(issueNum, repo)) {
          verified.push(`#${issueNum}`);
        } else {
          // Force-close the issue
          ghExec(
            `gh issue close ${issueNum} --repo ${repo} --comment "Auto-closed: PR #${prNum} was merged but GitHub did not auto-close this issue (squash-merge edge case)."`,
          );
          console.log(
            `  [verify-close] force-closed #${issueNum} (PR #${prNum} merged but issue remained open)`,
          );
          forceClosed.push(`#${issueNum}`);
        }
      }

      if (verified.length > 0 || forceClosed.length > 0) {
        results.push({ pr: prUrl, verified, forceClosed });
      }
    } catch {
      // Best effort — continue to next PR
    }
  }

  return results;
}
