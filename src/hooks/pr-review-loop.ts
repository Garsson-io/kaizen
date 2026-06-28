/**
 * pr-review-loop.ts — Multi-round PR self-review with state tracking.
 *
 * @enforces I5  — Review round has structured findings stored (sentinel gate).
 * @enforces I15 — Every push to an open PR's branch triggers a review round.
 * @enforces I16 — PR create/merge triggers reflection gate (partial; clear path in pr-kaizen-clear).
 * @enforces I28 — Review must cover all dimensions (partial: sentinel requires at least one finding;
 *                 full dimension coverage check tracked in #1038).
 *                 Canonical: docs/kaizen-invariants.md.
 *
 * PostToolUse hook on Bash — always exits 0 (advisory, not blocking).
 *
 * Triggers:
 *   1. gh pr create  — starts review loop (round 1)
 *   2. git push      — after pushing fixes, enforces next review round
 *   3. gh pr diff    — outputs checklist for current round
 *   4. gh pr merge   — sets up post-merge workflow gate
 *
 * Part of kAIzen Agent Control Flow — see .agents/kaizen/README.md
 * Migration: kaizen #320 (Phase 3 of #223)
 */

import { appendFileSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildReviewSentinelRecord,
  serializeReviewSentinel,
  validateReviewSentinel,
  type ReviewSentinelInput,
  type ReviewSentinelValidation,
} from '../review-sentinel.js';
import { findOpenPrUrlForBranch } from '../lib/github-pr.js';
import { type HookInput, readHookInput, traceHookEvent, writeHookOutput } from './hook-io.js';
import { currentHookBranch } from './lib/current-branch.js';
import { formatGateSignal, type GateSignal } from './lib/gate-signal.js';
import { gitStdout } from './lib/git-state.js';
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
  prUrlToStateKey,
  readStateFile,
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
  /** Structured gate signal (emitted as YAML prefix in hook output). */
  gateSignal?: GateSignal;
}

function trace(decision: HookDecision, trigger: string): void {
  traceHookEvent('pr-review-loop', {
    trigger,
    action: decision.action,
    reason: decision.reason,
    ...decision.context,
  });
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Compute diff line count between two SHAs. Returns 0 if either SHA is invalid. */
function diffLines(fromSha: string, toRef: string = 'HEAD'): number {
  if (!fromSha) return 0;
  const statLine = gitStdout(['diff', '--stat', `${fromSha}..${toRef}`]).split('\n').pop() ?? '';
  const ins = parseInt(statLine.match(/(\d+) insertion/)?.[1] ?? '0', 10);
  const del = parseInt(statLine.match(/(\d+) deletion/)?.[1] ?? '0', 10);
  return ins + del;
}

/** Check if a SHA exists in the git history. */
function shaExists(sha: string): boolean {
  if (!sha) return false;
  return gitStdout(['cat-file', '-t', sha]) === 'commit';
}

function detectGhRepo(): string | undefined {
  const url = gitStdout(['remote', 'get-url', 'origin']);
  return url.match(/github\.com[:/]([^/]+\/[^/.]+)/)?.[1];
}

function isValidPrUrl(url: string): boolean {
  return /^https:\/\/github\.com\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\/pull\/\d+$/.test(
    url,
  );
}

/**
 * Check if a review sentinel proves the given PR and round were reviewed.
 * The sentinel is written by store-review-summary in cli-structured-data.ts.
 * Format: <stateDir>/<stateKey>.reviewed-r<round>
 */
function defaultCheckReviewSentinel(prUrl: string, round: string, stateDir: string): ReviewSentinelValidation {
  const sentinel = join(stateDir, `${prUrlToStateKey(prUrl)}.reviewed-r${round}`);
  try {
    statSync(sentinel);
    return validateReviewSentinel(readFileSync(sentinel, 'utf-8'), { prUrl, round });
  } catch {
    return { ok: false, reason: 'missing_sentinel' };
  }
}

/**
 * Write a review sentinel for the given PR and round.
 * Called by store-review-summary after findings are stored.
 */
export function writeReviewSentinel(
  prUrl: string,
  round: string | number,
  stateDir: string = DEFAULT_STATE_DIR,
  options: Partial<ReviewSentinelInput> = {},
): void {
  ensureStateDir(stateDir);
  const sentinel = join(stateDir, `${prUrlToStateKey(prUrl)}.reviewed-r${round}`);
  const record = buildReviewSentinelRecord({ ...options, prUrl, round });
  writeFileSync(sentinel, serializeReviewSentinel(record));
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
    const state = readStateFile(fp);
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

/** Query gh for the open PR URL on the given branch. Returns undefined on failure.
 *  Set KAIZEN_PR_LOOKUP_DISABLED=1 to skip (for testing environments). */
function defaultLookupPrUrlForBranch(branch: string): string | undefined {
  if (process.env.KAIZEN_PR_LOOKUP_DISABLED === '1') return undefined;
  return findOpenPrUrlForBranch({ branch });
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
  /** Override review sentinel check for testing (#920) */
  checkReviewSentinel?: (prUrl: string, round: string, stateDir: string) => boolean;
  /** Fallback: look up PR URL for branch when stdout/stderr are empty (#973).
   *  Default uses the shared open-PR branch lookup helper. */
  lookupPrUrlForBranch?: (branch: string) => string | undefined;
}

function decide(
  action: HookDecision['action'],
  reason: string,
  message: string | null,
  context?: Record<string, unknown>,
  gateSignal?: GateSignal,
): HookDecision {
  return { action, reason, message, context, gateSignal };
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
  const branch = options.branch ?? currentHookBranch();
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
      gitStdout(['worktree', 'list', '--porcelain']).match(/^worktree (.+)/m)?.[1] ??
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
    let prUrl = reconstructPrUrl(cmdLine, stdout, stderr, 'create', repoFromGit);

    // Fallback (#973): when stdout/stderr are empty (heredoc body command substitution
    // can cause gh pr create output to be undetected), query gh for the current branch's PR.
    if (!prUrl) {
      const lookup = options.lookupPrUrlForBranch ?? defaultLookupPrUrlForBranch;
      prUrl = lookup(branch);
    }

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
    const sha = gitStdout(['rev-parse', 'HEAD']);
    if (sha) {
      appendFileSync(fp, `LAST_REVIEWED_SHA=${sha}\n`);
      appendFileSync(fp, `LAST_FULL_REVIEW_SHA=${sha}\n`);
    }

    const createMsg = `\n\ud83d\udccb PR created: ${prUrl}\n\nMANDATORY SELF-REVIEW LOOP \u2014 you MUST complete this before proceeding.\nROUND 1/${MAX_ROUNDS}: Start your review now.\n${printChecklist(prUrl, '1', MAX_ROUNDS)}\nTrack your round: "ROUND N/${MAX_ROUNDS}: [reviewing|issues found|clean]"\n`;
    return decide('create_gate', 'pr_created', createMsg, { prUrl },
      { hook: 'pr-review-loop', type: 'gate-set', gate: 'needs_review', pr: prUrl, round: 1, reason: 'PR created — run /kaizen-review-pr' });
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
    const parents = gitStdout(['log', '-1', '--format=%P', 'HEAD']).split(/\s+/).filter(Boolean);
    if (parents.length >= 2) {
      const mainHead = gitStdout(['rev-parse', 'origin/main']);
      if (mainHead && parents.includes(mainHead)) {
        return decide('ignore', 'merge_from_main', null, { parents });
      }
    }

    const round = parseInt(found.round, 10) || 1;
    const nextRound = round + 1;

    // Diff-size scaling (kaizen #117, #909)
    const rawState = readStateFile(found.filepath);
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

    // Auto-pass: BOTH incremental AND cumulative must be small,
    // AND no prior review has passed. A push after STATUS=passed is a
    // review-fix push — it must always require a new review round,
    // regardless of size. (Bug found via hook-gym TDD, kaizen #1053.)
    if (found.status !== 'passed' && incrementalLines > 0 && incrementalLines <= SMALL_PUSH_THRESHOLD && cumulativeLines <= CUMULATIVE_CAP) {
      const fp = writeStateFile(stateDir, prUrlToStateKey(found.prUrl), {
        PR_URL: found.prUrl,
        ROUND: String(nextRound),
        STATUS: 'passed',
        BRANCH: branch,
      });
      const sha = gitStdout(['rev-parse', 'HEAD']);
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
      diffContext,
      { hook: 'pr-review-loop', type: 'gate-set', gate: 'needs_review', pr: found.prUrl, round: nextRound, reason: 'Push detected — new review round' });
  }

  // ── TRIGGER 3: gh pr diff ──────────────────────────────────────
  if (isPrDiff) {
    const found = findStateByStatuses(['needs_review'], branch, stateDir);
    if (!found || found.status === 'passed' || found.status === 'escalated') {
      return decide('ignore', 'no_pending_review', null, { branch, status: found?.status });
    }

    // #920: Verify review outcome exists before clearing gate.
    // The sentinel is written by store-review-summary (cli-structured-data.ts).
    // Without it, gh pr diff alone doesn't prove dimension agents were spawned.
    const sentinelResult = options.checkReviewSentinel
      ? {
          ok: options.checkReviewSentinel(found.prUrl, found.round, stateDir),
          reason: 'custom_check_failed',
        }
      : defaultCheckReviewSentinel(found.prUrl, found.round, stateDir);
    if (!sentinelResult.ok) {
      const reason = sentinelResult.reason === 'missing_sentinel' ? 'no_review_sentinel' : 'invalid_review_sentinel';
      const msg = `\n\ud83d\udccb REVIEW ROUND ${found.round}/${MAX_ROUNDS}\n${printChecklist(found.prUrl, found.round, MAX_ROUNDS)}\n\u26a0\ufe0f invalid review sentinel: no valid review sentinel stored for round ${found.round} (${sentinelResult.reason}). Run \`/kaizen-review-pr ${found.prUrl}\` to spawn dimension agents.\n`;
      return decide('needs_review', reason, msg, { prUrl: found.prUrl, round: found.round, sentinelReason: sentinelResult.reason });
    }

    const fp = writeStateFile(stateDir, prUrlToStateKey(found.prUrl), {
      PR_URL: found.prUrl,
      ROUND: found.round,
      STATUS: 'passed',
      BRANCH: branch,
    });
    const sha = gitStdout(['rev-parse', 'HEAD']);
    if (sha) {
      appendFileSync(fp, `LAST_REVIEWED_SHA=${sha}\n`);
      appendFileSync(fp, `LAST_FULL_REVIEW_SHA=${sha}\n`);
    }

    const msg = `\n\ud83d\udccb REVIEW ROUND ${found.round}/${MAX_ROUNDS}\n${printChecklist(found.prUrl, found.round, MAX_ROUNDS)}\n\u2705 REVIEW PASSED (round ${found.round}/${MAX_ROUNDS})\n`;
    return decide('review_passed', 'diff_reviewed', msg, { prUrl: found.prUrl, round: found.round },
      { hook: 'pr-review-loop', type: 'gate-clear', gate: 'needs_review', pr: found.prUrl, round: parseInt(found.round, 10), reason: 'Review passed' });
  }

  return decide('ignore', 'unmatched_trigger', null);
}

// ── Main entry point ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const input = await readHookInput();
  if (!input) {
    trace({ action: 'ignore', reason: 'null_input', message: null }, 'null');
    process.exit(0);
  }

  const decision = processHookInput(input);

  // Trace every decision for observability
  const trigger = [
    isGhPrCommand(stripHeredocBody(input.tool_input?.command ?? ''), 'create') && 'pr_create',
    isGitCommand(stripHeredocBody(input.tool_input?.command ?? ''), 'push') && 'git_push',
    isGhPrCommand(stripHeredocBody(input.tool_input?.command ?? ''), 'diff') && 'pr_diff',
    isGhPrCommand(stripHeredocBody(input.tool_input?.command ?? ''), 'merge') && 'pr_merge',
  ].find(Boolean) || 'other';
  trace(decision, String(trigger));

  if (decision.message) {
    const prefix = decision.gateSignal ? formatGateSignal(decision.gateSignal) : '';
    writeHookOutput(prefix + decision.message);
  }
  process.exit(0);
}

if (
  process.argv[1]?.endsWith('pr-review-loop.ts') ||
  process.argv[1]?.endsWith('pr-review-loop.js')
) {
  main().catch(() => process.exit(0));
}
