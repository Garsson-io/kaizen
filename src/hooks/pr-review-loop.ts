/**
 * pr-review-loop.ts — Multi-round PR self-review with state tracking.
 *
 * PostToolUse hook on Bash — always exits 0 (advisory, not blocking).
 *
 * Triggers:
 *   1. gh pr create  — starts review loop (round 1)
 *   2. git push      — after pushing fixes, enforces next review round
 *   3. gh pr diff    — outputs checklist for current round
 *   4. gh pr merge   — sets up post-merge workflow gate
 *
 * Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
 * Migration: kaizen #320 (Phase 3 of #223)
 */

import { execSync } from 'node:child_process';
import { appendFileSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { type HookInput, readHookInput, writeHookOutput } from './hook-io.js';
import {
  isGhPrCommand,
  isGitCommand,
  reconstructPrUrl,
  stripHeredocBody,
} from './parse-command.js';
import {
  DEFAULT_STATE_DIR,
  ensureStateDir,
  listStateFilesForCurrentWorktree,
  parseStateFile,
  prUrlToStateKey,
  writeStateFile,
} from './state-utils.js';

export const MAX_ROUNDS = 4;
export const SMALL_PUSH_THRESHOLD = 15;
export const CUMULATIVE_CAP = 100;

// ── Observability ───────────────────────────────────────────────────

export interface HookDecision {
  /** What the hook decided */
  action: 'ignore' | 'create_gate' | 'auto_pass' | 'needs_review' | 'review_passed' | 'escalated' | 'post_merge';
  /** Why — machine-readable reason code */
  reason: string;
  /** Human message (shown to agent) */
  message: string | null;
  /** Context data for debugging */
  context?: Record<string, unknown>;
}

const TRACE_FILE = process.env.KAIZEN_HOOK_TRACE ?? '/tmp/.kaizen-hook-trace.jsonl';
const TRACE_ENABLED = process.env.KAIZEN_HOOK_TRACE !== '0';

function trace(decision: HookDecision, trigger: string): void {
  if (!TRACE_ENABLED) return;
  try {
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      hook: 'pr-review-loop',
      trigger,
      action: decision.action,
      reason: decision.reason,
      ...decision.context,
    });
    appendFileSync(TRACE_FILE, entry + '\n');
  } catch { /* never fail on trace */ }
}

// ── Helpers ──────────────────────────────────────────────────────────

function git(args: string, fallback = ''): string {
  try {
    return execSync(`git ${args}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return fallback;
  }
}

/** Compute diff line count between two SHAs. Returns 0 if either SHA is invalid. */
function diffLines(fromSha: string, toRef: string = 'HEAD'): number {
  if (!fromSha) return 0;
  const statLine = git(`diff --stat ${fromSha}..${toRef}`).split('\n').pop() ?? '';
  const ins = parseInt(statLine.match(/(\d+) insertion/)?.[1] ?? '0', 10);
  const del = parseInt(statLine.match(/(\d+) deletion/)?.[1] ?? '0', 10);
  return ins + del;
}

/** Check if a SHA exists in the git history. */
function shaExists(sha: string): boolean {
  if (!sha) return false;
  return git(`cat-file -t ${sha}`) === 'commit';
}

function detectGhRepo(): string | undefined {
  const url = git('remote get-url origin');
  return url.match(/github\.com[:/]([^/]+\/[^/.]+)/)?.[1];
}

function isValidPrUrl(url: string): boolean {
  return /^https:\/\/github\.com\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\/pull\/\d+$/.test(
    url,
  );
}

function printChecklist(
  prUrl: string,
  round: string,
  maxRounds: number,
): string {
  return `
Use the /review-pr skill for the full checklist. Run \`/review-pr ${prUrl}\` now.

PROCESS:
1. Run \`/review-pr ${prUrl}\`
2. Walk through EVERY section
3. If issues found: fix, commit, push
4. If clean: state "REVIEW PASSED (round ${round}/${maxRounds})"

After ${maxRounds} rounds: escalate to human via PR comment + Telegram.
`;
}

/**
 * Find the most recent state file matching any of the given statuses.
 */
function findStateByStatuses(
  statuses: string[],
  branch: string,
  stateDir: string,
): { prUrl: string; round: string; status: string; filepath: string } | null {
  const statusSet = new Set(statuses);
  let latest: {
    prUrl: string;
    round: string;
    status: string;
    filepath: string;
  } | null = null;
  let latestMtime = 0;

  for (const fp of listStateFilesForCurrentWorktree(branch, stateDir)) {
    const state = parseStateFile(readFileSync(fp, 'utf-8'));
    if (state.STATUS && statusSet.has(state.STATUS)) {
      const mtime = statSync(fp).mtimeMs;
      if (mtime > latestMtime) {
        latestMtime = mtime;
        latest = {
          prUrl: state.PR_URL ?? '',
          round: state.ROUND ?? '1',
          status: state.STATUS,
          filepath: fp,
        };
      }
    }
  }
  return latest;
}

// ── Core logic (extracted for testability) ───────────────────────────

export interface ProcessOptions {
  stateDir?: string;
  branch?: string;
  repoFromGit?: string;
  mainCheckout?: string;
  /** Override diff computation for testing */
  computeDiffLines?: (fromSha: string) => number;
  /** Override SHA existence check for testing */
  checkShaExists?: (sha: string) => boolean;
}

function decide(action: HookDecision['action'], reason: string, message: string | null, context?: Record<string, unknown>): HookDecision {
  return { action, reason, message, context };
}

export function processHookInput(
  input: HookInput,
  options: ProcessOptions = {},
): HookDecision {
  const command = input.tool_input?.command ?? '';
  const stdout = input.tool_response?.stdout ?? '';
  const stderr = input.tool_response?.stderr ?? '';
  const exitCode = String(input.tool_response?.exit_code ?? '0');

  if (exitCode !== '0') {
    return decide('ignore', 'non_zero_exit', null, { exitCode });
  }

  const cmdLine = stripHeredocBody(command);
  const stateDir =
    options.stateDir ?? process.env.STATE_DIR ?? DEFAULT_STATE_DIR;
  const branch =
    options.branch ?? git('rev-parse --abbrev-ref HEAD', 'unknown');
  const repoFromGit = options.repoFromGit ?? detectGhRepo();
  const getDiffLines = options.computeDiffLines ?? diffLines;
  const isShaValid = options.checkShaExists ?? shaExists;

  ensureStateDir(stateDir);

  const isPrCreate = isGhPrCommand(cmdLine, 'create');
  const isGitPush = isGitCommand(cmdLine, 'push');
  const isPrDiff = isGhPrCommand(cmdLine, 'diff');
  const isPrMerge = isGhPrCommand(cmdLine, 'merge');

  if (!isPrCreate && !isGitPush && !isPrDiff && !isPrMerge) {
    return decide('ignore', 'not_a_trigger', null, { cmdLine: cmdLine.slice(0, 80) });
  }

  // ── TRIGGER 4: gh pr merge ─────────────────────────────────────
  if (isPrMerge) {
    const mergeUrl = reconstructPrUrl(
      cmdLine,
      stdout,
      stderr,
      'merge',
      repoFromGit,
    );
    if (mergeUrl) {
      try {
        unlinkSync(join(stateDir, prUrlToStateKey(mergeUrl)));
      } catch {}
    }
    if (!mergeUrl)
      return decide('ignore', 'no_merge_url', '\n\u26a0\ufe0f Could not determine PR URL. Post-merge gate NOT set.\n');

    const isAuto = /--auto/.test(cmdLine);
    const postMergeKey = prUrlToStateKey(mergeUrl);
    const mc =
      options.mainCheckout ??
      git('worktree list --porcelain').match(/^worktree (.+)/m)?.[1] ??
      '.';

    if (isAuto) {
      writeStateFile(stateDir, `post-merge-${postMergeKey}`, {
        PR_URL: mergeUrl,
        STATUS: 'awaiting_merge',
        BRANCH: branch,
      });
      return decide('post_merge', 'auto_merge_queued', `\n\u23f3 Auto-merge queued for: ${mergeUrl}\n`, { mergeUrl });
    }

    writeStateFile(stateDir, `post-merge-${postMergeKey}`, {
      PR_URL: mergeUrl,
      STATUS: 'needs_post_merge',
      BRANCH: branch,
    });
    const mergeMsg = `\n\ud83c\udf89 PR merged: ${mergeUrl}\n\nNow complete the post-merge workflow:\n1. **Kaizen reflection (REQUIRED)** \u2014 Run \`/kaizen\` NOW.\n2. **Post-merge action needed** \u2014 classify per CLAUDE.md deploy policy.\n3. **Sync main** \u2014 \`git -C ${mc} fetch origin main && git -C ${mc} merge origin/main --no-edit\`\n4. **Update linked issue** \u2014 Close with lessons learned.\n5. **Spec update** \u2014 Move completed work to "Already Solved".\n\n\u26d4 You will NOT be able to finish until /kaizen is run.\n`;
    return decide('post_merge', 'merge_completed', mergeMsg, { mergeUrl });
  }

  // ── TRIGGER 1: gh pr create ────────────────────────────────────
  if (isPrCreate) {
    const prUrl = reconstructPrUrl(
      cmdLine,
      stdout,
      stderr,
      'create',
      repoFromGit,
    );
    if (!prUrl) {
      return decide('ignore', 'no_pr_url_from_create', null);
    }

    const key = prUrlToStateKey(prUrl);
    const fp = writeStateFile(stateDir, key, {
      PR_URL: prUrl,
      ROUND: '1',
      STATUS: 'needs_review',
      BRANCH: branch,
    });
    const sha = git('rev-parse HEAD');
    if (sha) {
      appendFileSync(fp, `LAST_REVIEWED_SHA=${sha}\n`);
      appendFileSync(fp, `LAST_FULL_REVIEW_SHA=${sha}\n`);
    }

    const createMsg = `\n\ud83d\udccb PR created: ${prUrl}\n\nMANDATORY SELF-REVIEW LOOP \u2014 you MUST complete this before proceeding.\nROUND 1/${MAX_ROUNDS}: Start your review now.\n${printChecklist(prUrl, '1', MAX_ROUNDS)}\nTrack your round: "ROUND N/${MAX_ROUNDS}: [reviewing|issues found|clean]"\n`;
    return decide('create_gate', 'pr_created', createMsg, { prUrl });
  }

  // ── TRIGGER 2: git push ────────────────────────────────────────
  if (isGitPush) {
    const found = findStateByStatuses(
      ['needs_review', 'passed'],
      branch,
      stateDir,
    );
    if (!found || !isValidPrUrl(found.prUrl)) {
      return decide('ignore', 'no_active_pr', null, { branch, hasState: !!found });
    }
    if (found.status === 'escalated') {
      return decide('ignore', 'already_escalated', null, { prUrl: found.prUrl, round: found.round });
    }

    // Skip merge-from-main pushes (kaizen #85)
    const parents = git('log -1 --format=%P HEAD').split(/\s+/).filter(Boolean);
    if (parents.length >= 2) {
      const mainHead = git('rev-parse origin/main');
      if (mainHead && parents.includes(mainHead)) {
        return decide('ignore', 'merge_from_main', null, { parents });
      }
    }

    const round = parseInt(found.round, 10) || 1;
    const nextRound = round + 1;

    // Diff-size scaling (kaizen #117, #909)
    const rawState = parseStateFile(readFileSync(found.filepath, 'utf-8'));
    const lastPushSha = (rawState as Record<string, string>).LAST_REVIEWED_SHA ?? '';
    const lastFullReviewSha = (rawState as Record<string, string>).LAST_FULL_REVIEW_SHA ?? lastPushSha;

    // Validate SHAs exist (may be rebased away)
    const pushShaValid = isShaValid(lastPushSha);
    const fullReviewShaValid = isShaValid(lastFullReviewSha);

    const incrementalLines = pushShaValid ? getDiffLines(lastPushSha) : 0;
    const cumulativeLines = fullReviewShaValid ? getDiffLines(lastFullReviewSha) : 0;

    const diffContext = {
      prUrl: found.prUrl, round, nextRound,
      lastPushSha: lastPushSha.slice(0, 8), lastFullReviewSha: lastFullReviewSha.slice(0, 8),
      pushShaValid, fullReviewShaValid,
      incrementalLines, cumulativeLines,
      thresholds: { smallPush: SMALL_PUSH_THRESHOLD, cumulativeCap: CUMULATIVE_CAP },
    };

    // Auto-pass: BOTH incremental AND cumulative must be small
    if (incrementalLines > 0 && incrementalLines <= SMALL_PUSH_THRESHOLD && cumulativeLines <= CUMULATIVE_CAP) {
      const fp = writeStateFile(stateDir, prUrlToStateKey(found.prUrl), {
        PR_URL: found.prUrl,
        ROUND: String(nextRound),
        STATUS: 'passed',
        BRANCH: branch,
      });
      const sha = git('rev-parse HEAD');
      if (sha) appendFileSync(fp, `LAST_REVIEWED_SHA=${sha}\n`);
      if (lastFullReviewSha) appendFileSync(fp, `LAST_FULL_REVIEW_SHA=${lastFullReviewSha}\n`);
      return decide('auto_pass', 'small_incremental_and_cumulative',
        `\n\ud83d\udd0d Small push (${incrementalLines} lines, ${cumulativeLines} cumulative) \u2014 abbreviated review (round ${nextRound}/${MAX_ROUNDS}). Auto-passed.\n`,
        diffContext);
    }

    // Escalate if max rounds exceeded
    if (nextRound > MAX_ROUNDS) {
      writeStateFile(stateDir, prUrlToStateKey(found.prUrl), {
        PR_URL: found.prUrl,
        ROUND: String(MAX_ROUNDS),
        STATUS: 'escalated',
        BRANCH: branch,
      });
      return decide('escalated', 'max_rounds_exceeded',
        `\n\u26a0\ufe0f REVIEW ROUND ${MAX_ROUNDS}/${MAX_ROUNDS} COMPLETE \u2014 escalate to human.\n`,
        diffContext);
    }

    // Require review
    writeStateFile(stateDir, prUrlToStateKey(found.prUrl), {
      PR_URL: found.prUrl,
      ROUND: String(nextRound),
      STATUS: 'needs_review',
      BRANCH: branch,
    });
    return decide('needs_review', 'push_exceeds_threshold',
      `\n\ud83d\udd04 Push detected (${incrementalLines} lines incremental, ${cumulativeLines} cumulative). Starting ROUND ${nextRound}/${MAX_ROUNDS}.\nRun \`gh pr diff ${found.prUrl}\` now.\n`,
      diffContext);
  }

  // ── TRIGGER 3: gh pr diff ──────────────────────────────────────
  if (isPrDiff) {
    const found = findStateByStatuses(['needs_review'], branch, stateDir);
    if (!found || found.status === 'passed' || found.status === 'escalated') {
      return decide('ignore', 'no_pending_review', null, { branch, status: found?.status });
    }

    const fp = writeStateFile(stateDir, prUrlToStateKey(found.prUrl), {
      PR_URL: found.prUrl,
      ROUND: found.round,
      STATUS: 'passed',
      BRANCH: branch,
    });
    const sha = git('rev-parse HEAD');
    if (sha) {
      appendFileSync(fp, `LAST_REVIEWED_SHA=${sha}\n`);
      appendFileSync(fp, `LAST_FULL_REVIEW_SHA=${sha}\n`);
    }

    const msg = `\n\ud83d\udccb REVIEW ROUND ${found.round}/${MAX_ROUNDS}\n${printChecklist(found.prUrl, found.round, MAX_ROUNDS)}\n\u2705 REVIEW PASSED (round ${found.round}/${MAX_ROUNDS})\n`;
    return decide('review_passed', 'diff_reviewed', msg, { prUrl: found.prUrl, round: found.round });
  }

  return decide('ignore', 'unmatched_trigger', null);
}

// ── Main entry point ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const input = await readHookInput();
  if (!input) process.exit(0);

  const decision = processHookInput(input);

  // Trace every decision for observability
  const trigger = [
    isGhPrCommand(stripHeredocBody(input.tool_input?.command ?? ''), 'create') && 'pr_create',
    isGitCommand(stripHeredocBody(input.tool_input?.command ?? ''), 'push') && 'git_push',
    isGhPrCommand(stripHeredocBody(input.tool_input?.command ?? ''), 'diff') && 'pr_diff',
    isGhPrCommand(stripHeredocBody(input.tool_input?.command ?? ''), 'merge') && 'pr_merge',
  ].find(Boolean) || 'other';
  trace(decision, String(trigger));

  if (decision.message) writeHookOutput(decision.message);
  process.exit(0);
}

if (
  process.argv[1]?.endsWith('pr-review-loop.ts') ||
  process.argv[1]?.endsWith('pr-review-loop.js')
) {
  main().catch(() => process.exit(0));
}
