/**
 * auto-dent-github — GitHub CLI operations for auto-dent batch runs.
 *
 * Extracted from auto-dent-run.ts (#600) to reduce cognitive load
 * and enable isolated testing of GitHub interactions.
 *
 * All functions wrap the `gh` CLI and are tolerant of failures
 * (logging warnings rather than throwing).
 */

import { execSync } from 'child_process';
import type { RunResult } from './auto-dent-run.js';

// GitHub CLI wrapper (tolerant of failures)

export function ghExec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 30_000 }).trim();
  } catch (e: any) {
    console.log(
      `  [hygiene] warning: ${cmd.slice(0, 80)}... -> ${e.message?.split('\n')[0] || 'failed'}`,
    );
    return '';
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

// Branch sweep

export type SweepAction = 'updated' | 'already_current' | 'merged' | 'closed' | 'failed';

export interface SweepResult {
  pr: string;
  action: SweepAction;
}

/**
 * Sweep all batch PRs: update stale branches so auto-merge can proceed.
 *
 * When strict branch protection is enabled and main advances (from a
 * previous run's PR merging), subsequent PRs fall BEHIND and auto-merge
 * stalls silently. This sweep detects BEHIND branches and calls the
 * GitHub API to update them.
 *
 * See issue #368, hypothesis H1/H4.
 */
export function sweepBatchPRs(allPrUrls: string[]): SweepResult[] {
  const results: SweepResult[] = [];

  for (const prUrl of allPrUrls) {
    const m = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (!m) continue;

    const [, repo, prNum] = m;

    try {
      const json = ghExec(
        `gh pr view ${prNum} --repo ${repo} --json state,mergeStateStatus,autoMergeRequest`,
      );
      if (!json) {
        results.push({ pr: prUrl, action: 'failed' });
        continue;
      }

      const data = JSON.parse(json);

      if (data.state === 'MERGED') {
        results.push({ pr: prUrl, action: 'merged' });
        continue;
      }
      if (data.state === 'CLOSED') {
        results.push({ pr: prUrl, action: 'closed' });
        continue;
      }

      // Only update if branch is behind and auto-merge is queued
      if (
        data.mergeStateStatus === 'BEHIND' &&
        data.autoMergeRequest
      ) {
        const updateOut = ghExec(
          `gh api repos/${repo}/pulls/${prNum}/update-branch -X PUT -f expected_head_sha="" 2>&1`,
        );
        if (updateOut && !updateOut.includes('error')) {
          console.log(`  [sweep] updated stale branch for PR #${prNum}`);
          results.push({ pr: prUrl, action: 'updated' });
        } else {
          console.log(`  [sweep] failed to update branch for PR #${prNum}`);
          results.push({ pr: prUrl, action: 'failed' });
        }
      } else {
        results.push({ pr: prUrl, action: 'already_current' });
      }
    } catch {
      results.push({ pr: prUrl, action: 'failed' });
    }
  }

  return results;
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
