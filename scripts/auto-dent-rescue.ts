/**
 * auto-dent-rescue.ts — Failure rescue finalizer for auto-dent runs (#1255).
 *
 * When an auto-dent run terminates abnormally (wall-clock watchdog SIGTERM,
 * crash, non-zero exit) before the PR phase, any committed-but-unpushed or
 * dirty work in the run's case worktree is stranded with no PR. Operators then
 * have to file a *manual* "[rescue]" PR (the #1252–#1260 symptom cluster).
 *
 * This module binds the run finalizer to a best-effort, gate-skipping rescue:
 *   - existing open PR for the branch  → commit dirty as-is, push to the PR
 *   - no PR but worktree has work      → commit dirty as-is, push, open a DRAFT PR
 *   - nothing rescueable               → do nothing (never manufacture noise)
 *
 * The rescue explicitly SKIPS every quality gate (review battery, plan
 * substance, dirty-file gate, lifecycle/process verdict, tests) and marks its
 * output clearly as NOT-VALIDATED. A rescue failure is recorded but never
 * hides the original run failure.
 *
 * DRY (#1164): reuses `readDirtyFiles`/`GitExec` from src/hooks/lib/git-state.ts
 * and `gh` from src/lib/gh-exec.ts — no new porcelain parser or gh wrapper.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createDefaultGitExec,
  readDirtyFiles,
  type GitExec,
  type DirtyState,
} from '../src/hooks/lib/git-state.js';
import { gh as defaultGh } from '../src/lib/gh-exec.js';
import { findOpenPrUrlForBranch } from '../src/lib/github-pr.js';

/** Quality gates a rescue deliberately skips — surfaced in the rescue report. */
export const SKIPPED_GATES: readonly string[] = [
  'review battery',
  'plan substance gate',
  'dirty-file gate (files committed as-is)',
  'lifecycle / process verdict',
  'test gate',
];

export interface RunExitInfo {
  exitCode: number;
  timedOut: boolean;
  stopRequested: boolean;
}

export interface RunExitClassification {
  /** True for watchdog timeout / non-zero exit — terminal, work likely stranded. */
  abnormal: boolean;
  /** Human reason used in the rescue report. */
  reason: string;
}

/**
 * Classify a run's exit into the failure reason shown in the rescue report.
 * Timeout is authoritative (it is the dominant strand cause, #686), then a
 * non-zero exit, then an intentional agent stop, then a clean exit.
 */
export function classifyRunExit(info: RunExitInfo): RunExitClassification {
  if (info.timedOut) {
    return { abnormal: true, reason: 'timeout (wall-clock watchdog SIGTERM)' };
  }
  if (info.exitCode !== 0) {
    return { abnormal: true, reason: `abnormal exit (code ${info.exitCode})` };
  }
  if (info.stopRequested) {
    return { abnormal: false, reason: 'agent requested stop' };
  }
  return { abnormal: false, reason: 'clean exit' };
}

export type RescueKind = 'none' | 'push-existing' | 'create-draft';

export interface RescueDecisionInput {
  /** Commits on the branch ahead of the base (origin/main). */
  commitsAheadBase: number;
  /** Commits ahead of the remote tracking branch (work not yet pushed). */
  unpushedCommits: number;
  /** Content-verified dirty (staged + modified + untracked) file count. */
  dirtyTotal: number;
  /** URL of an open PR already targeting this branch, or null. */
  existingOpenPr: string | null;
}

export interface RescueAction {
  kind: RescueKind;
  /** Whether dirty files must be committed as-is before pushing. */
  commitDirty: boolean;
  reason: string;
}

/**
 * Decide what to do with a run worktree. The gate-correctness core:
 *
 * - With an existing open PR, committed+pushed work is ALREADY on the PR, so we
 *   act only when there is *unpushed* work or *dirty* files. A healthy PR with
 *   no new work yields `none` — we never post a spurious rescue comment.
 * - With no PR, any work ahead of base (or dirty) means the run produced work
 *   that would otherwise vanish → open a draft rescue PR.
 */
export function decideRescueAction(input: RescueDecisionInput): RescueAction {
  const commitDirty = input.dirtyTotal > 0;
  if (input.existingOpenPr) {
    const needsPush = input.unpushedCommits > 0 || input.dirtyTotal > 0;
    return needsPush
      ? {
          kind: 'push-existing',
          commitDirty,
          reason: `extend existing PR ${input.existingOpenPr} (${input.unpushedCommits} unpushed, ${input.dirtyTotal} dirty)`,
        }
      : { kind: 'none', commitDirty: false, reason: 'open PR already has all work; nothing to rescue' };
  }
  const hasWork = input.commitsAheadBase > 0 || input.dirtyTotal > 0;
  return hasWork
    ? {
        kind: 'create-draft',
        commitDirty,
        reason: `no PR for branch with rescueable work (${input.commitsAheadBase} commits ahead, ${input.dirtyTotal} dirty)`,
      }
    : { kind: 'none', commitDirty: false, reason: 'no commits ahead and no dirty files' };
}

export interface RescueReportInput {
  runTag: string;
  runId: string;
  worktree: string;
  branch: string;
  failureReason: string;
  commitsAhead: number;
  dirtyTotal: number;
  skippedGates?: readonly string[];
  pickedIssue?: string;
}

/**
 * Format the rescue PR body / comment. The banner makes it impossible to
 * mistake rescued output for validated, review-passed work.
 */
export function formatRescueReport(input: RescueReportInput): string {
  const gates = input.skippedGates ?? SKIPPED_GATES;
  const lines = [
    '## ⚠️ FAILED-RUN RESCUE — NOT VALIDATED WORK',
    '',
    'This branch was preserved by the auto-dent rescue finalizer after the run',
    'terminated before the normal PR phase. **No quality gate has passed.** Treat',
    'this as raw, unreviewed work that needs a human (or a fresh run) to validate,',
    'finish, or discard.',
    '',
    '| Field | Value |',
    '|-------|-------|',
    `| Failure reason | ${input.failureReason} |`,
    `| Run tag | ${input.runTag} |`,
    `| Run id | ${input.runId} |`,
    `| Worktree | \`${input.worktree}\` |`,
    `| Branch | \`${input.branch}\` |`,
    `| Commits ahead of base | ${input.commitsAhead} |`,
    `| Dirty files committed as-is | ${input.dirtyTotal} |`,
  ];
  if (input.pickedIssue) lines.push(`| Picked issue | ${input.pickedIssue} |`);
  lines.push('', '### Gates skipped by the rescue path', '');
  for (const g of gates) lines.push(`- ${g}`);
  lines.push('');
  return lines.join('\n');
}

/** Build the rescue PR title. */
export function buildRescueTitle(runTag: string, pickedIssue?: string): string {
  const suffix = pickedIssue ? ` ${pickedIssue}` : '';
  return `[rescue] ${runTag} — stranded work preserved (NOT validated)${suffix}`;
}

export interface RescueTarget {
  worktree: string;
  branch: string;
}

export interface RescueContext {
  /** Host repo (owner/name) for PR operations. */
  repo: string;
  runTag: string;
  runId: string;
  failureReason: string;
  pickedIssue?: string;
  /** Base branch for create-draft and the ahead-of-base count. Default 'origin/main'. */
  base?: string;
}

export interface RescueDeps {
  git: GitExec;
  gh: (args: string[]) => string;
  readDirty: (dir: string) => DirtyState;
  log?: (msg: string) => void;
}

export interface RescueOutcome {
  branch: string;
  worktree: string;
  action: RescueKind;
  prUrl?: string;
  pushed: boolean;
  error?: string;
}

function countRevList(git: GitExec, worktree: string, range: string): number {
  const r = git(['-C', worktree, 'rev-list', '--count', range]);
  if (r.exitCode !== 0) return 0;
  const n = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Rescue a single run worktree. Best-effort: every git/gh step is guarded so a
 * rescue failure is recorded in the outcome but never thrown — the original run
 * failure must remain the headline (#1255).
 */
export function rescueTarget(target: RescueTarget, ctx: RescueContext, deps: RescueDeps): RescueOutcome {
  const { git, gh, readDirty, log } = deps;
  const base = ctx.base ?? 'origin/main';
  const outcome: RescueOutcome = {
    branch: target.branch,
    worktree: target.worktree,
    action: 'none',
    pushed: false,
  };

  if (!existsSync(target.worktree)) {
    return outcome; // worktree already gone — nothing to rescue
  }

  let dirtyTotal = 0;
  try {
    dirtyTotal = readDirty(target.worktree).verified.total;
  } catch {
    // Fall back to a raw porcelain count if the verified reader fails.
    const r = git(['-C', target.worktree, 'status', '--porcelain']);
    dirtyTotal = r.stdout.split('\n').filter(Boolean).length;
  }

  const commitsAheadBase = countRevList(git, target.worktree, `${base}..HEAD`);
  const unpushedCommits = countRevList(git, target.worktree, '@{u}..HEAD');
  const existingOpenPr = findOpenPrUrlForBranch({ gh, repo: ctx.repo, branch: target.branch }) ?? null;

  const action = decideRescueAction({ commitsAheadBase, unpushedCommits, dirtyTotal, existingOpenPr });
  outcome.action = action.kind;
  if (action.kind === 'none') {
    log?.(`${target.branch}: ${action.reason}`);
    return outcome;
  }
  log?.(`${target.branch}: ${action.reason}`);

  try {
    if (action.commitDirty) {
      git(['-C', target.worktree, 'add', '-A']);
      const commit = git([
        '-C', target.worktree, 'commit', '--no-verify', '-m',
        `[rescue] preserve stranded work as-is (${ctx.failureReason})`,
      ]);
      if (commit.exitCode !== 0 && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
        throw new Error(`commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`);
      }
    }

    // Push with --no-verify: the rescue path intentionally bypasses the
    // pre-push gate so abnormal-run work is never lost behind a gate.
    const push = git(['-C', target.worktree, 'push', '--no-verify', '-u', 'origin', target.branch]);
    if (push.exitCode !== 0) {
      throw new Error(`push failed: ${push.stderr.trim() || push.stdout.trim()}`);
    }
    outcome.pushed = true;

    const report = formatRescueReport({
      runTag: ctx.runTag,
      runId: ctx.runId,
      worktree: target.worktree,
      branch: target.branch,
      failureReason: ctx.failureReason,
      commitsAhead: commitsAheadBase,
      dirtyTotal,
      pickedIssue: ctx.pickedIssue,
    });

    if (action.kind === 'push-existing' && existingOpenPr) {
      gh(['pr', 'comment', existingOpenPr, '--repo', ctx.repo, '--body', report]);
      outcome.prUrl = existingOpenPr;
    } else {
      const url = gh([
        'pr', 'create', '--repo', ctx.repo, '--draft',
        '--head', target.branch,
        '--base', (ctx.base ?? 'origin/main').replace(/^origin\//, ''),
        '--title', buildRescueTitle(ctx.runTag, ctx.pickedIssue),
        '--body', report,
      ]);
      outcome.prUrl = url.trim();
    }
    log?.(`${target.branch}: rescued via ${action.kind} → ${outcome.prUrl ?? '(no url)'}`);
  } catch (err) {
    outcome.error = err instanceof Error ? err.message : String(err);
    log?.(`${target.branch}: rescue failed — ${outcome.error}`);
  }

  return outcome;
}

/** Rescue all of a run's worktrees. */
export function rescueRun(targets: RescueTarget[], ctx: RescueContext, deps: RescueDeps): RescueOutcome[] {
  return targets.map((t) => rescueTarget(t, ctx, deps));
}

/** Git config key carrying the run that created/owns a case worktree (#1270). */
export const RUNTAG_CONFIG_KEY = 'kaizen.runtag';

export interface CollectRunWorktreesOptions {
  /**
   * This run's tag. When set together with `git`, on-disk case worktrees stamped
   * with this exact runtag are unioned in — covering worktrees created *before*
   * the `IMPLEMENT` marker was emitted (the #1270 crash-before-marker strand).
   */
  runTag?: string;
  /** Git runner used to enumerate worktrees and read their per-worktree runtag. */
  git?: GitExec;
}

/**
 * Read a worktree's durable run attribution stamp (`kaizen.runtag`, written at
 * `git worktree add` time by the capture-worktree-context hook). Returns the tag
 * or `null`. A worktree with no stamp, or whose `--worktree` config can't be
 * read, yields `null` — it is never attributed to any run.
 */
function readWorktreeRunTag(git: GitExec, worktree: string): string | null {
  const r = git(['-C', worktree, 'config', '--worktree', '--get', RUNTAG_CONFIG_KEY]);
  if (r.exitCode !== 0) return null;
  const tag = r.stdout.trim();
  return tag.length > 0 ? tag : null;
}

/** Resolve a worktree's current branch from HEAD; null on detached/error. */
function readWorktreeBranch(git: GitExec, worktree: string): string | null {
  const r = git(['-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (r.exitCode !== 0) return null;
  const b = r.stdout.trim();
  return b && b !== 'HEAD' ? b : null;
}

/**
 * Enumerate the absolute paths of every git worktree under
 * `<repoRoot>/.claude/worktrees`. Uses `git worktree list --porcelain` so the
 * set is authoritative (no directory-name guessing). Returns [] on any failure.
 */
function listManagedWorktrees(git: GitExec, repoRoot: string): string[] {
  const r = git(['-C', repoRoot, 'worktree', 'list', '--porcelain']);
  if (r.exitCode !== 0) return [];
  const prefix = join(repoRoot, '.claude', 'worktrees');
  const paths: string[] = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^worktree (.+)$/.exec(line.trim());
    if (m && m[1].startsWith(prefix)) paths.push(m[1]);
  }
  return paths;
}

/**
 * Derive the rescue targets for THIS run.
 *
 * Base set: the case ids the run reported through `IMPLEMENT` stream markers
 * (`cases`). This is scoped to the run's own worktrees only.
 *
 * #1270 union: when `opts.runTag` + `opts.git` are supplied, also include any
 * on-disk managed worktree whose per-worktree `kaizen.runtag` equals this run's
 * tag. This recovers worktrees created *before* the marker was emitted (the
 * crash-before-marker strand that previously forced manual `[rescue]` PRs).
 *
 * Concurrency safety is structural: a worktree stamped with a *different*
 * runtag — or with no stamp at all — is never attributed to this run, so a
 * sibling run's in-progress WIP can never be swept up. Targets are de-duplicated
 * by worktree path, with the marker-derived branch taking precedence.
 */
export function collectRunWorktrees(
  repoRoot: string,
  cases: string[],
  opts: CollectRunWorktreesOptions = {},
): RescueTarget[] {
  const byPath = new Map<string, RescueTarget>();

  for (const caseId of cases) {
    if (!caseId) continue;
    const worktree = join(repoRoot, '.claude', 'worktrees', caseId);
    if (!existsSync(worktree)) continue;
    byPath.set(worktree, { worktree, branch: `case/${caseId}` });
  }

  if (opts.runTag && opts.git) {
    const git = opts.git;
    for (const worktree of listManagedWorktrees(git, repoRoot)) {
      if (byPath.has(worktree) || !existsSync(worktree)) continue;
      if (readWorktreeRunTag(git, worktree) !== opts.runTag) continue;
      const branch = readWorktreeBranch(git, worktree);
      if (!branch) continue; // detached/unknown — can't safely push
      byPath.set(worktree, { worktree, branch });
    }
  }

  return [...byPath.values()];
}

/** Default deps wiring the shared primitives (used by the finalizer). */
export function defaultRescueDeps(log?: (msg: string) => void): RescueDeps {
  return {
    git: createDefaultGitExec(),
    gh: (args) => defaultGh(args),
    readDirty: (dir) => readDirtyFiles(dir),
    log,
  };
}
