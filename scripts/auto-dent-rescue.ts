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
 * DRY (#1164): reuses `readDirtyFiles`/`GitExec` from src/hooks/lib/git-state.ts,
 * `gh` from src/lib/gh-exec.ts, and `queryBranchPrState` from src/lib/github-pr.ts
 * — no new porcelain parser, gh wrapper, or second branch-PR query mechanism.
 *
 * Gate correctness (#1284): the branch-PR query also surfaces the I7 "merged
 * branch" state, so the rescue path refuses to open a redundant PR on a branch
 * whose PR already merged (the #1282/#1280 supersede race).
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
import { parseIssueNumber, queryBranchPrState, queryIssueState } from '../src/lib/github-pr.js';

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
  /**
   * Whether the run terminated abnormally (`classifyRunExit().abnormal`): a
   * watchdog timeout or non-zero exit, where work was likely STRANDED. A clean
   * exit / intentional agent stop is NOT abnormal. This is required (not
   * defaulted) so every caller must bind the computed classification at this
   * choke point — the #943/#1227 "computed-but-not-bound" guard. It gates ONLY
   * `create-draft`: manufacturing a brand-new draft rescue PR is justified only
   * when termination stranded the work. `push-existing` (extending an already
   * open PR) is exit-agnostic and ignores this field. (#1289)
   */
  abnormal: boolean;
  /**
   * True when the most-recent PR for the branch is MERGED and there is no open
   * PR — the I7 "merged branch" state. Pushing to or opening a PR on such a
   * branch is forbidden (CLAUDE.md branch hygiene), and in the rescue path it
   * is the #1282 supersede race: the branch's PR merged seconds before the
   * rescue ran, so an open-only lookup saw no PR and would manufacture a
   * redundant draft. Defaults to false.
   */
  mostRecentMerged?: boolean;
  /**
   * True when the run's picked issue is already CLOSED. The work a fresh draft
   * rescue PR would preserve has been resolved/superseded by another path — a
   * revert, a sibling run, or a manual close. This is the live #1225 cluster:
   * #1225 ("redo the gate correctly OR revert") was closed by *revert* (#1297),
   * yet three draft rescue PRs to redo it (#1258–#1260) sat open as orphans
   * nobody reconciled. Opening a brand-new draft for resolved work manufactures
   * exactly that orphan. Symmetric sibling of `mostRecentMerged`: it gates ONLY
   * `create-draft`; `push-existing` (extending an already-open PR) ignores it.
   * Fail-open: an unknown issue state must arrive here as false, never true.
   * Defaults to false. (#1300)
   */
  pickedIssueClosed?: boolean;
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
  // I7 supersede guard: a branch whose most-recent PR merged with no newer open
  // PR must never be pushed to or get a fresh PR (CLAUDE.md branch hygiene). This
  // is the #1282 race — the branch's PR (#1280) merged 12s before the rescue ran,
  // so an open-only lookup saw no PR and would otherwise manufacture a redundant
  // draft for work already on main. The open-PR path above keeps precedence (an
  // open PR means mostRecentMerged is false), so a healthy PR is unaffected.
  if (input.mostRecentMerged) {
    return {
      kind: 'none',
      commitDirty: false,
      reason: 'branch already has a merged PR and no open PR — work shipped; not pushing to a merged branch (I7)',
    };
  }
  const hasWork = input.commitsAheadBase > 0 || input.dirtyTotal > 0;
  if (!hasWork) {
    return { kind: 'none', commitDirty: false, reason: 'no commits ahead and no dirty files' };
  }
  // #1300 closed-issue guard: a fresh draft rescue PR exists to preserve work
  // that would otherwise vanish, but when the picked issue is already CLOSED the
  // work is moot — resolved/superseded by another path (revert, sibling run,
  // manual close). The live cluster: #1225 closed by revert (#1297), leaving
  // draft rescues #1258–#1260 open as orphans nobody reconciled. Symmetric with
  // the mostRecentMerged (I7) guard above. The open-PR path keeps precedence, so
  // an in-flight PR is unaffected; this only stops manufacturing a new orphan.
  if (input.pickedIssueClosed) {
    return {
      kind: 'none',
      commitDirty: false,
      reason: 'picked issue already closed — work resolved/superseded by another path; not manufacturing an orphan rescue draft (#1300)',
    };
  }
  // #1289: only an ABNORMAL termination (watchdog timeout / non-zero exit) strands
  // work that warrants manufacturing a brand-new draft rescue PR. A clean exit or
  // intentional agent stop that ends with worktree commits and no PR is deliberate
  // (discovery output, an explore/contemplate run, or an agent that stopped on
  // purpose) — opening a spurious "NOT VALIDATED" draft for it is the over-eager
  // inverse of the strand failure. Leave it alone. The `push-existing` path above
  // keeps precedence and is exit-agnostic: extending an already-open PR is always safe.
  if (!input.abnormal) {
    return {
      kind: 'none',
      commitDirty: false,
      reason: 'clean exit with worktree commits and no PR — intentional stop / discovery output, not manufacturing a draft (#1289)',
    };
  }
  return {
    kind: 'create-draft',
    commitDirty,
    reason: `abnormal exit stranded work with no PR (${input.commitsAheadBase} commits ahead, ${input.dirtyTotal} dirty)`,
  };
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
  /**
   * Whether the run terminated abnormally (`classifyRunExit().abnormal`). Bound
   * from the run's exit classification and forwarded to `decideRescueAction` so a
   * brand-new draft rescue PR is only manufactured for crash/timeout-stranded
   * work, never for a clean-exit worktree (#1289).
   */
  abnormal: boolean;
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
  // One branch-PR query (shared helper) yields BOTH the open-PR push target and
  // the merged-branch supersede signal — no second, open-only query mechanism.
  const prState = queryBranchPrState({ gh, repo: ctx.repo, branch: target.branch });
  const existingOpenPr = prState.openUrl ?? null;
  const mostRecentMerged = prState.mostRecent?.state === 'MERGED' && !prState.hasOpen;

  // #1300: a brand-new draft (the only path the closed-issue guard gates) is
  // only on the table when there's no open PR. Query the picked issue's state
  // just then — never on the push-existing path — and fail open: a null/unknown
  // state leaves pickedIssueClosed false, so a legitimate rescue is never blocked.
  let pickedIssueClosed = false;
  if (!existingOpenPr) {
    const issueNumber = parseIssueNumber(ctx.pickedIssue);
    if (issueNumber != null) {
      pickedIssueClosed = queryIssueState({ gh, repo: ctx.repo, issue: issueNumber }) === 'CLOSED';
    }
  }

  const action = decideRescueAction({ commitsAheadBase, unpushedCommits, dirtyTotal, existingOpenPr, mostRecentMerged, pickedIssueClosed, abnormal: ctx.abnormal });
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
