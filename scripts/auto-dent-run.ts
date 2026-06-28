#!/usr/bin/env npx tsx
/**
 * auto-dent-run — Execute a single make-a-dent run with real-time observability.
 *
 * Called by the trampoline (auto-dent.sh). Re-read from disk each
 * iteration, so merged improvements take effect on the next run.
 *
 * Usage: npx tsx scripts/auto-dent-run.ts <state-file>
 *
 * Reads batch config and cross-run state from state.json.
 * Spawns claude with --output-format stream-json for real-time milestones.
 * Writes results back after the run completes.
 *
 * Stop mechanism: Claude emits "AUTO_DENT_PHASE: STOP | reason=<reason>"
 * (structured phase marker) to signal stop. Legacy "AUTO_DENT_STOP: <reason>"
 * is also supported for backward compatibility. See issue #499.
 *
 * Decomposed into modules (#600):
 *   - auto-dent-github.ts  — GitHub CLI operations (merge, sweep, label, cleanup)
 *   - auto-dent-stream.ts  — Stream processing (phase markers, artifacts, display)
 */

import { spawn, execFileSync, execSync } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { createInterface } from 'readline';
import { dirname, resolve } from 'path';
import { scoreRunResult, scoreBatch, formatRunScoreLine, formatBatchScoreTable, formatIssuesClosedLine, postHocScoreBatch, formatPostHocLine, detectCostAnomaly, classifyFailure, failureClassLabel, formatFailureDistribution } from './auto-dent-score.js';
import { firstHookReason } from './hook-signals.js';
import { claimNextItem, markItem, resetAssignedItems, readPlan, themeProgress } from './auto-dent-plan.js';
import { writeAttachment, addSection } from '../src/section-editor.js';
import {
  reviewBattery,
  formatBatteryReport,
  listPrDimensions,
  resolvePromptsDir,
  renderTemplate,
} from '../src/review-battery.js';
import { EventEmitter, makeRunId, type AutoDentEvent } from './auto-dent-events.js';
import { defaultReviewFixProviders, runFixLoop } from './review-fix.js';
import { buildRunManifest, writeRunManifest, bundleArtifacts, formatManifestSummary } from './auto-dent-artifacts.js';
import { uploadBatchArtifacts } from './batch-artifacts-upload.js';
import {
  buildBatchOutcome,
  writeBatchOutcomeAttachment,
  readBatchOutcomesFromGithub,
  computeSteeringRecommendations,
} from './batch-outcome.js';
import { phaseProvidersForAgentProvider, type PhaseProviderRecord } from './auto-dent-provider.js';
import {
  buildKaizenCycleSteps,
  formatIssueForDisplay,
  formatIssueUrl,
  formatProgressStepsMarkdown,
  formatReviewForDisplay,
  upsertProgressStep,
  type RunProgressStep,
} from './auto-dent-progress.js';
import { truncateAtWordBoundary } from './auto-dent-display.js';
import { parseJsonObject } from '../src/lib/json-value.js';
import { readDurableJsonValueFile, readJsonValueFile, writeDurableJsonValueFile } from '../src/lib/json-file.js';
import { hasHardQualityFailure } from '../src/verdict-binding-policy.js';

// Re-export from extracted modules for backward compatibility
export {
  ghExec,
  checkMergeStatus,
  driveBatchToMerge,
  labelArtifacts,
  queueAutoMerge,
  extractLinkedIssue,
  isIssueClosed,
  cleanupSupersededPRs,
  fetchIssueLabels,
  syncEpicChecklists,
  verifyIssuesClosed,
  reconcileBatchClosedIssues,
  type MergeStatus,
  type DriveStatus,
  type DriveReason,
  type DriveResult,
  type DriveOptions,
  type CleanupResult,
  type EpicSyncResult,
  type VerifyCloseResult,
} from './auto-dent-github.js';
import { decideAutoMergeSafety } from './auto-dent-merge-policy.js';

export {
  EventEmitter,
  makeRunId,
  type AutoDentEvent,
  type RunStartEvent,
  type RunIssuePickedEvent,
  type RunPrCreatedEvent,
  type RunCompleteEvent,
  type BatchReflectEvent,
  type EventEnvelope,
} from './auto-dent-events.js';

// Re-export shared utilities from review-battery for backward compatibility
export { resolvePromptsDir, renderTemplate } from '../src/review-battery.js';

export {
  color,
  formatToolUse,
  parsePhaseMarkers,
  formatPhaseMarker,
  extractArtifacts,
  extractContemplationRecommendations,
  extractReflectionInsights,
  checkStopSignal,
  processStreamMessage,
  buildInFlightComment,
  postInFlightUpdate,
  formatHeartbeat,
  IN_FLIGHT_UPDATE_INTERVAL_MS,
  type PhaseMarker,
  type StreamContext,
} from './auto-dent-stream.js';

// Lifecycle validation — re-exported for back-compat (#1103).
export {
  validateRunLifecycle,
  summarizeLifecycle,
  verifyLifecycleEvidence,
  validateProcessEvidence,
  foldEvidenceIntoHealth,
  summarizeEvidence,
  summarizeProcessValidation,
  LIFECYCLE_ORDER,
  FLOATING_PHASES,
  REQUIRED_PREDECESSORS,
  type LifecycleValidation,
  type LifecycleHealth,
  type LifecycleEvidence,
  type EvidenceVerification,
  type ProcessGap,
  type ProcessVerdict,
} from './auto-dent-lifecycle.js';

// Import for internal use
import {
  ghExec,
  checkMergeStatus,
  driveBatchToMerge,
  labelArtifacts,
  queueAutoMerge,
  fetchIssueLabels,
  verifyIssuesClosed,
  reconcileBatchClosedIssues,
  syncEpicChecklists,
} from './auto-dent-github.js';
import {
  color,
  processStreamMessage,
  parsePhaseMarkers,
  postInFlightUpdate,
  formatHeartbeat,
  IN_FLIGHT_UPDATE_INTERVAL_MS,
  type StreamContext,
} from './auto-dent-stream.js';
import { degradedRunLogBanner, type HookActivationVerdict } from './auto-dent-hook-activation.js';
import {
  buildCodexExecArgs,
  extractCodexPhaseMarkers,
  normalizeCodexEventToStreamMessages,
  normalizeCodexFinalTextToStreamMessages,
  parseCodexJsonl,
} from './auto-dent-codex.js';
import {
  compareFinalClaimToEvidence,
  foldFinalClaimWarningsIntoProcess,
  writeFinalClaimArtifact,
  type FinalClaimStatus,
  type FinalRunClaim,
} from './auto-dent-final-claim.js';
import {
  validateRunLifecycle,
  summarizeLifecycle,
  verifyLifecycleEvidence,
  validateProcessEvidence,
  foldEvidenceIntoHealth,
  summarizeEvidence,
  summarizeProcessValidation,
  type LifecycleHealth,
  type LifecycleEvidence,
  type ProcessEvidence,
  type ProcessVerdict,
} from './auto-dent-lifecycle.js';
import {
  classifyRunExit,
  collectRunWorktrees,
  rescueRun,
  defaultRescueDeps,
} from './auto-dent-rescue.js';
import { createDefaultGitExec } from '../src/hooks/lib/git-state.js';
import { runStalePrTriageMaintenance } from './stale-pr-triage.js';
import { gh as ghArgs } from '../src/lib/gh-exec.js';

// Types

export interface BatchState {
  batch_id: string;
  batch_start: number;
  batch_end?: number;
  guidance: string;
  max_runs: number;
  cooldown: number;
  budget: string;
  max_budget?: string;
  max_failures: number;
  kaizen_repo: string;
  host_repo: string;
  run: number;
  prs: string[];
  /**
   * Draft "[rescue]" PRs created by the failure finalizer (#1255). Kept SEPARATE
   * from `prs` so unvalidated, gate-skipped rescue output never inflates the
   * batch's success metrics. Absent on older state files.
   */
  rescue_prs?: string[];
  issues_filed: string[];
  issues_closed: string[];
  cases: string[];
  consecutive_failures: number;
  current_cooldown: number;
  stop_reason: string;
  last_issue: string;
  last_pr: string;
  last_case: string;
  last_branch: string;
  last_worktree: string;
  progress_issue?: string;
  test_task?: boolean;
  experiment?: boolean;
  /** Agent provider. Defaults to claude for older state files. Codex uses subscription CLI (#1139). */
  provider?: 'claude' | 'codex';
  last_heartbeat?: number;
  max_run_seconds?: number;
  run_history?: RunMetrics[];
  /** Recommendations from contemplation runs that feed back into subsequent runs */
  contemplation_recommendations?: string[];
  /** Insights from reflect-mode runs that feed back into subsequent runs (#699) */
  reflection_insights?: string[];
  /**
   * Cross-batch steering derived from PRIOR batches' GitHub outcomes (#940 Phase 2).
   * Populated once per batch (fail-open) and surfaced as {{cross_batch_steering}}
   * so observable cloud data biases this batch's choices.
   */
  cross_batch_steering?: string[];
}

export interface RunMetrics {
  run: number;
  start_epoch: number;
  duration_seconds: number;
  exit_code: number;
  cost_usd: number;
  tool_calls: number;
  prs: string[];
  issues_filed: string[];
  issues_closed: string[];
  cases: string[];
  stop_requested: boolean;
  /** Cognitive mode used for this run (default: "exploit" for backward compat) */
  mode?: string;
  /** Net lines removed (positive = deletion, 0 for older runs) */
  lines_deleted?: number;
  /** Issues closed as obsolete/duplicate (not-planned), not fixed */
  issues_pruned?: number;
  /** Prompt template file name used for this run */
  prompt_template?: string;
  /** SHA-256 hash of the prompt template content (first 12 chars) */
  prompt_hash?: string;
  /** Structured failure classification (populated post-run) */
  failure_class?: string;
  /** Reason a hook blocked this run, when failure_class is hook_rejection (#1102) */
  hook_rejection_reason?: string;
  /** Number of lifecycle ordering violations detected post-run */
  lifecycle_violations?: number;
  /** Lifecycle health: clean (ok) | degraded (ordering) | critical (gaps/phantoms) (#1103) */
  lifecycle_health?: LifecycleHealth;
  /** Durable process-evidence verdict (#1149) */
  process_verdict?: ProcessVerdict;
  /** Count of failed/warning process evidence checks (#1149) */
  process_issue_count?: number;
  /** Compact process evidence summary (#1149) */
  process_summary?: string;
  /** Review battery verdict for PRs created in this run */
  review_verdict?: 'pass' | 'fail' | 'skipped';
  /** Review battery cost (USD) */
  review_cost_usd?: number;
  /**
   * Provider + billing mode used for each lifecycle phase (#1143, epic #1134).
   * Absent on older runs (treated as unknown). Defaults to Claude-under-subscription
   * for the agent phases and provider-independent for validation — see
   * `defaultPhaseProviders()` in scripts/auto-dent-provider.ts.
   */
  phase_providers?: PhaseProviderRecord;
  /** Status of the schema-constrained final run claim (#1145). */
  final_claim_status?: FinalClaimStatus;
  /** Parsed final claim object, when valid (#1145). */
  final_claim?: FinalRunClaim;
  /** Sidecar path for the persisted final claim object (#1145). */
  final_claim_path?: string;
  /** Warnings from final-claim parsing or claim/evidence comparison (#1145). */
  final_claim_warnings?: string[];
  /**
   * Whether kaizen hooks actually loaded this session, from the `system.init`
   * event (#843). `degraded` means a hook-supporting provider ran with the
   * kaizen plugin absent — the run was NOT gated by kaizen enforcement.
   */
  hook_activation?: HookActivationVerdict;
}

export interface RunResult {
  prs: string[];
  issuesFiled: string[];
  issuesClosed: string[];
  cases: string[];
  /** Issue selected for this run, usually from the PICK phase marker. */
  pickedIssue?: string;
  /** Human title for the selected issue, when the PICK marker included it. */
  pickedIssueTitle?: string;
  /** Structured phase progress reconstructed from AUTO_DENT_PHASE markers. */
  progressSteps?: RunProgressStep[];
  cost: number;
  toolCalls: number;
  stopRequested: boolean;
  stopReason?: string;
  /** Net lines removed (positive = deletion) */
  linesDeleted: number;
  /** Issues closed as not-planned (pruned, not fixed) */
  issuesPruned: number;
  /** Structured failure classification */
  failureClass?: string;
  /** Whether the run was killed by the wall-clock timeout watchdog (#686) */
  timedOut?: boolean;
  /** Contemplation recommendations extracted from contemplate run output */
  contemplationRecs?: string[];
  /** Reflection insights extracted from reflect-mode run output (#699) */
  reflectionInsights?: string[];
  /** Advisory requirements review verdict for the PR produced by this run */
  reviewVerdict?: 'pass' | 'fail' | 'skipped';
  /** Cost of the requirements review in USD */
  reviewCostUsd?: number;
  /** Review attachment/comment URLs produced by the review wiring, if any. */
  reviewUrls?: string[];
  /** Parsed schema-constrained final run claim (#1145). */
  finalClaim?: FinalRunClaim;
  /** Parse status for the final run claim (#1145). */
  finalClaimStatus?: FinalClaimStatus;
  /** Sidecar path for the persisted final claim object (#1145). */
  finalClaimPath?: string;
  /** Parse/comparison warnings for the final run claim (#1145). */
  finalClaimWarnings?: string[];
  /** Hook-activation verdict from the session's `system.init` event (#843). */
  hookActivation?: HookActivationVerdict;
}

type RunMetricsBaseField =
  | 'run'
  | 'start_epoch'
  | 'duration_seconds'
  | 'exit_code'
  | 'cost_usd'
  | 'tool_calls'
  | 'prs'
  | 'issues_filed'
  | 'issues_closed'
  | 'cases'
  | 'stop_requested'
  | 'mode'
  | 'lines_deleted'
  | 'issues_pruned'
  | 'final_claim_status'
  | 'final_claim'
  | 'final_claim_path'
  | 'final_claim_warnings';

export type RunMetricsMetadata = Partial<Omit<RunMetrics, RunMetricsBaseField>>;

export interface BuildRunMetricsInput {
  runNum: number;
  runStartEpoch: number;
  duration: number;
  exitCode: number;
  runMode: string;
  result: RunResult;
  metadata?: RunMetricsMetadata;
}

export function buildRunMetrics(input: BuildRunMetricsInput): RunMetrics {
  const { runNum, runStartEpoch, duration, exitCode, runMode, result, metadata = {} } = input;
  return {
    run: runNum,
    start_epoch: runStartEpoch,
    duration_seconds: duration,
    exit_code: exitCode,
    cost_usd: result.cost,
    tool_calls: result.toolCalls,
    prs: result.prs,
    issues_filed: result.issuesFiled,
    issues_closed: result.issuesClosed,
    cases: result.cases,
    stop_requested: result.stopRequested,
    mode: runMode,
    lines_deleted: result.linesDeleted,
    issues_pruned: result.issuesPruned,
    final_claim_status: result.finalClaimStatus,
    final_claim: result.finalClaim,
    final_claim_path: result.finalClaimPath,
    final_claim_warnings: result.finalClaimWarnings,
    hook_activation: result.hookActivation,
    ...metadata,
  };
}
import { extractPlanText } from '../src/structured-data.js';
export { extractPlanText };

// State I/O

export function readState(stateFile: string): BatchState {
  const state = readDurableJsonValueFile(stateFile, {
    backup: true,
    onBackupRead: (bak) => console.error(`[state-io] Primary state corrupt, falling back to ${bak}`),
  });
  if (state && typeof state === 'object' && !Array.isArray(state)) return state as BatchState;
  throw new Error(`State file corrupt and no backup available: ${stateFile}`);
}

export function writeState(stateFile: string, state: BatchState): void {
  writeDurableJsonValueFile(stateFile, state, { backup: true });
}

// Resolve repo root

function getRepoRoot(): string {
  try {
    const gitCommonDir = execSync(
      'git rev-parse --path-format=absolute --git-common-dir',
      { encoding: 'utf8' },
    ).trim();
    return gitCommonDir.replace(/\/\.git$/, '');
  } catch {
    return resolve(dirname(new URL(import.meta.url).pathname), '..');
  }
}

// Prompt building

/**
 * Resolve the prompts directory. Checks repo-root/prompts first,
 * then falls back to the directory relative to this script.
 */
/**
 * Load persisted reflection insights from the batch log directory.
 * Returns formatted markdown string for prompt injection, or empty string if none.
 * Also returns issue numbers that the reflection flagged to avoid.
 */
export function loadReflectionInsights(logDir: string): { text: string; avoidIssues: string[] } {
  const summaryPath = resolve(logDir, 'reflection-summary.json');
  try {
    if (!existsSync(summaryPath)) return { text: '', avoidIssues: [] };
    const raw = readJsonValueFile(summaryPath);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { text: '', avoidIssues: [] };
    const summary = raw as Record<string, any>;
    const insights: Array<{ type: string; message: string }> = Array.isArray(summary.insights) ? summary.insights : [];
    if (insights.length === 0) return { text: '', avoidIssues: summary.avoidIssues || [] };

    const lines = [
      `_Mid-batch reflection (after run ${summary.runCount}, success rate: ${(summary.successRate * 100).toFixed(0)}%):_`,
      '',
    ];
    for (const insight of insights) {
      const icon = insight.type === 'success_pattern' ? '+' :
                   insight.type === 'failure_pattern' ? '!' :
                   insight.type === 'efficiency' ? '$' : '*';
      lines.push(`- **[${icon}]** ${insight.message}`);
    }

    return { text: lines.join('\n'), avoidIssues: summary.avoidIssues || [] };
  } catch {
    return { text: '', avoidIssues: [] };
  }
}

/**
 * Load reflection history — all prior reflection entries in this batch.
 * Used to give the reflect-batch prompt visibility into prior reflections.
 */
export function loadReflectionHistory(logDir: string): string {
  const historyPath = resolve(logDir, 'reflection-history.json');
  try {
    if (!existsSync(historyPath)) return '';
    const entries = readJsonValueFile(historyPath);
    if (!Array.isArray(entries) || entries.length === 0) return '';

    return entries.map((entry: any, idx: number) => {
      const insights = (entry.insights || [])
        .map((i: any) => `  - **[${i.type}]** ${i.message}`)
        .join('\n');
      return `### Reflection ${idx + 1} (after run ${entry.runCount}, success: ${(entry.successRate * 100).toFixed(0)}%, cost/PR: $${entry.avgCostPerPr.toFixed(2)})\n${insights}`;
    }).join('\n\n');
  } catch {
    return '';
  }
}

/**
 * Build template variables from batch state and run number.
 * These are substituted into prompt templates via {{variable}} syntax.
 */
export function buildTemplateVars(
  state: BatchState,
  runNum: number,
  logDir?: string,
): Record<string, string> {
  const runTag = `${state.batch_id}/run-${runNum}`;
  const hostRepo = state.host_repo || state.kaizen_repo || 'unknown';
  const now = new Date();

  // Try to claim next item from plan (if a plan exists)
  let planAssignment = '';
  let claimedPlanIssue = '';
  let reflectionInsights = '';
  let priorReflections = '';
  if (logDir) {
    const planItem = claimNextItem(logDir);
    if (planItem) {
      claimedPlanIssue = planItem.issue;
      const lines = [
        `- **Issue:** ${planItem.issue} — ${planItem.title}`,
        `- **Approach:** ${planItem.approach}`,
        `- **Score:** ${planItem.score}/10`,
      ];
      if (planItem.item_type === 'decompose') {
        lines.push(`- **Type:** decompose — this is an epic/PRD that needs to be broken into concrete issues first`);
        if (planItem.parent_epic) {
          lines.push(`- **Parent epic:** ${planItem.parent_epic}`);
        }
      }
      // Surface theme membership so the run knows it is continuing a
      // coordinated bundle of related work, not a one-off issue (#941).
      if (planItem.theme) {
        const plan = readPlan(logDir);
        const tp = plan ? themeProgress(plan).find((t) => t.id === planItem.theme) : undefined;
        if (tp) {
          lines.push(
            `- **Theme:** ${tp.title} (${tp.done}/${tp.total} complete) — part of a coordinated bundle of related issues; keep this PR scoped to the theme and prefer finishing the theme before switching topics`,
          );
        }
      }
      planAssignment = lines.join('\n');
      console.log(`  [plan] assigned ${planItem.issue}: ${planItem.title}${planItem.item_type === 'decompose' ? ' [DECOMPOSE]' : ''}${planItem.theme ? ` [theme:${planItem.theme}]` : ''}`);
    }

    // Load reflection insights from prior mid-batch reflection (#603)
    const reflection = loadReflectionInsights(logDir);
    reflectionInsights = reflection.text;
    if (reflection.avoidIssues.length > 0) {
      console.log(`  [reflect] loaded ${reflection.avoidIssues.length} issue(s) to avoid from reflection`);
    }

    // Load reflection history for reflect/contemplate prompts (#611)
    priorReflections = loadReflectionHistory(logDir);
  }

  // Merge state-based reflection insights from REFLECTION_INSIGHT: markers (#699)
  const stateInsights = [...new Set(state.reflection_insights || [])];
  if (stateInsights.length > 0) {
    const stateInsightsText = stateInsights.map((r, i) => `${i + 1}. ${r}`).join('\n');
    reflectionInsights = reflectionInsights
      ? `${reflectionInsights}\n\n### Agent Reflection Insights\n\n${stateInsightsText}`
      : stateInsightsText;
  }

  // Build run history table and batch-level stats for reflect/contemplate prompts
  let runHistoryTable = '';
  let totalCost = '';
  let prCount = '';
  let issuesClosedCount = '';
  let runCount = '';
  let prMergeStatus = '';
  let failureClassSummary = '';
  const history = state.run_history || [];
  if (history.length > 0) {
    const batchScore = scoreBatch(history);
    runHistoryTable = [
      '| Run | Mode | Cost | PRs | Issues | Duration | Status |',
      '|-----|------|------|-----|--------|----------|--------|',
      ...batchScore.runs.map((r, i) => {
        const m = history[i];
        const status = r.success ? 'pass' : failureClassLabel(r.failure_class);
        return `| ${m?.run ?? i} | ${r.mode} | $${r.cost_usd.toFixed(2)} | ${r.pr_count} | ${r.issues_closed_count} | ${r.duration_seconds}s | ${status} |`;
      }),
    ].join('\n');
    totalCost = batchScore.total_cost_usd.toFixed(2);
    prCount = String(batchScore.total_prs);
    issuesClosedCount = String(batchScore.total_issues_closed);
    runCount = String(batchScore.total_runs);
    failureClassSummary = formatFailureDistribution(batchScore.runs.map(r => r.failure_class));

    // Build PR merge status summary with actual merge state from GitHub
    if (state.prs.length > 0) {
      prMergeStatus = state.prs.map(url => {
        const status = checkMergeStatus(url);
        const label = status === 'merged' ? '**merged**'
          : status === 'auto_queued' ? '**open** (auto-merge queued)'
          : status === 'closed' ? '**closed**'
          : status === 'open' ? '**open**'
          : 'unknown';
        return `- ${url} — ${label}`;
      }).join('\n');
    }
  }

  // Format contemplation recommendations for prompt injection (dedup on read — #700)
  const contemplationRecs = [...new Set(state.contemplation_recommendations || [])];
  const contemplationRecsText = contemplationRecs.length > 0
    ? contemplationRecs.map((r, i) => `${i + 1}. ${r}`).join('\n')
    : '';

  // Cross-batch steering from prior batches' GitHub outcomes (#940 Phase 2).
  const crossBatchSteering = [...new Set(state.cross_batch_steering || [])];
  const crossBatchSteeringText = crossBatchSteering.length > 0
    ? crossBatchSteering.map((r, i) => `${i + 1}. ${r}`).join('\n')
    : '';

  return {
    guidance: state.guidance,
    run_tag: runTag,
    run_tag_slug: runTag.replace(/\//g, '-'),
    run_num: String(runNum),
    run_context: `${runNum}${state.max_runs > 0 ? ` of ${state.max_runs}` : ''}`,
    host_repo: hostRepo,
    kaizen_repo: state.kaizen_repo || 'unknown',
    batch_id: state.batch_id,
    timestamp: now.toISOString().replace(/[-:T]/g, '').slice(0, 14),
    iso_now: now.toISOString(),
    issues_closed: state.issues_closed.join(' '),
    prs: state.prs.join(' '),
    plan_assignment: planAssignment,
    claimed_plan_issue: claimedPlanIssue,
    reflection_insights: reflectionInsights,
    cross_batch_steering: crossBatchSteeringText,
    run_history_table: runHistoryTable,
    total_cost: totalCost,
    pr_count: prCount,
    issues_closed_count: issuesClosedCount,
    run_count: runCount,
    pr_merge_status: prMergeStatus,
    prior_reflections: priorReflections,
    failure_class_summary: failureClassSummary,
    contemplation_recommendations: contemplationRecsText,
  };
}

/**
 * Render a Mustache-lite template string.
 *
 * Supports:
 *   {{variable}}          — simple substitution
 *   {{#variable}}...{{/variable}} — conditional section (rendered if variable is non-empty)
 */
/**
 * Load a prompt template from the prompts directory.
 * Returns null if the file doesn't exist (caller should fall back to inline).
 */
export function loadPromptTemplate(templateName: string): string | null {
  const promptsDir = resolvePromptsDir();
  const templatePath = resolve(promptsDir, templateName);
  try {
    return readFileSync(templatePath, 'utf8');
  } catch {
    return null;
  }
}

// Mode selection

export interface ModeSelection {
  mode: string;
  template: string;
  /** Why this mode was selected (signal name, 'schedule', 'guidance', or 'bandit') */
  reason: string;
  /** Full bandit breakdown when the selection came from the UCB1 policy (reason === 'bandit') */
  bandit?: BanditResult;
}

const MODE_TEMPLATES: Record<string, string> = {
  exploit: 'deep-dive-default.md',
  explore: 'explore-gaps.md',
  reflect: 'reflect-batch.md',
  subtract: 'subtract-prune.md',
  contemplate: 'contemplate-strategy.md',
};

/**
 * Check signal-driven overrides based on batch state.
 * Returns a ModeSelection if a signal fires, or null to fall through to the schedule.
 *
 * Signals (checked in priority order):
 *   1. 3+ consecutive failures -> reflect (diagnose what's going wrong)
 *   2. No PRs in last 5 runs with history -> explore (backlog may be exhausted)
 *   3. Same mode 4+ times consecutively -> force a different mode
 */
export function checkSignalOverrides(state: BatchState): ModeSelection | null {
  const history = state.run_history || [];
  if (history.length < 3) return null;

  // Signal 1: consecutive failures -> reflect
  if (state.consecutive_failures >= 3) {
    return {
      mode: 'reflect',
      template: MODE_TEMPLATES.reflect,
      reason: 'signal:consecutive-failures',
    };
  }

  // Signal 2: no PRs in last 5 runs -> explore (backlog may be exhausted)
  if (history.length >= 5) {
    const recent5 = history.slice(-5);
    const recentPRs = recent5.reduce((sum, r) => sum + r.prs.length, 0);
    if (recentPRs === 0) {
      return {
        mode: 'explore',
        template: MODE_TEMPLATES.explore,
        reason: 'signal:no-recent-prs',
      };
    }
  }

  // Signal 3: same mode 4+ times in a row -> break the streak
  if (history.length >= 4) {
    const recent4 = history.slice(-4);
    const modes = recent4.map(r => r.mode || 'exploit');
    if (modes.every(m => m === modes[0])) {
      const staleMode = modes[0];
      // Pick a different mode: if stuck on exploit, explore; otherwise contemplate
      const breakMode = staleMode === 'exploit' ? 'explore' : 'contemplate';
      return {
        mode: breakMode,
        template: MODE_TEMPLATES[breakMode],
        reason: `signal:mode-streak-${staleMode}`,
      };
    }
  }

  return null;
}

/**
 * Compute mode-appropriate success metric for a run.
 * Each mode has its own definition of "success":
 *   - exploit: PRs produced
 *   - explore: issues filed (its purpose is discovery, not PRs)
 *   - reflect: issues filed (insights that become actionable issues)
 *   - subtract: lines deleted + issues pruned (reduction, not addition)
 *   - contemplate: fixed baseline (strategic value not measurable per-run)
 */
export function modeSuccess(mode: string, metrics: RunMetrics): number {
  switch (mode) {
    case 'exploit':
      return metrics.prs.length;
    case 'explore':
      return metrics.issues_filed.length;
    case 'reflect':
      return metrics.issues_filed.length;
    case 'subtract':
      return (metrics.lines_deleted ?? 0) / 100 + (metrics.issues_pruned ?? 0);
    case 'contemplate':
      return 1; // strategic value, always counts as success
    default:
      return metrics.prs.length;
  }
}

/** Telemetry outcome for a completed run (the `run.complete.outcome` field). */
export type RunOutcome = 'success' | 'empty_success' | 'failure' | 'stop';

/** Signals consumed to bind a run's outcome to its recorded verdicts. */
export interface RunOutcomeSignals {
  stopRequested: boolean;
  exitCode: number;
  /** Mode-aware artifact count — the output of {@link modeSuccess}. */
  artifactCount: number;
  reviewVerdict?: 'pass' | 'fail' | 'skipped';
  processVerdict?: ProcessVerdict;
  lifecycleHealth?: LifecycleHealth;
}

/**
 * Derive a run's telemetry `outcome` from BOTH its artifact count and the
 * quality verdicts the same `run.complete` event already records (#1224,
 * meta #1227).
 *
 * The run-success stamp is a terminal action; binding it to the verdicts means
 * a run that recorded a quality FAILURE can never roll up to
 * `success`/`empty_success`. Otherwise a red run reads as green in the batch
 * summary — which is how PR #1212 (review battery FAIL) got merged (#1220).
 *
 * Quality-fail signals (any one ⇒ `failure`, failing closed):
 *   - `reviewVerdict === 'fail'`         — review battery + fix loop failed/exhausted
 *   - `processVerdict === 'process-incomplete'` — lifecycle evidence missing
 *   - `lifecycleHealth === 'critical'`   — structural lifecycle gap
 *
 * Intentionally NOT gated (documented, to avoid over-broad false-failures):
 *   - `processVerdict 'fail-open-warning'` — fail-open by design (validator
 *     did not run / soft warning); must not flip a real win to a loss.
 *   - `lifecycleHealth 'degraded'` — set whenever `processVerdict !== 'pass'`
 *     (see the emit path), so it is a superset of `process-incomplete` and too
 *     broad to gate on directly; the precise signal already covers the failure.
 *   - `reviewVerdict 'skipped'` / undefined verdicts — legitimate for modes
 *     with no PR to review; treated as non-failing.
 *
 * Precedence (preserved from the original inline computation): a requested STOP
 * wins, then a hard nonzero exit, then the verdict gate, then artifact count.
 */
export function deriveRunOutcome(signals: RunOutcomeSignals): RunOutcome {
  if (signals.stopRequested) return 'stop';
  if (signals.exitCode !== 0) return 'failure';
  if (hasHardQualityFailure(signals)) return 'failure';
  return signals.artifactCount > 0 ? 'success' : 'empty_success';
}

/** Schedulable cognitive modes (contemplate is an overlay, not bandit-scheduled). */
export const SCHEDULABLE_MODES = ['exploit', 'explore', 'reflect', 'subtract'] as const;

/** Default UCB1 exploration constant (classic value). Tunable via KAIZEN_BANDIT_C. */
export const DEFAULT_BANDIT_C = Math.SQRT2;

/** Per-mode breakdown of the bandit's decision, surfaced for observability. */
export interface BanditDetail {
  mode: string;
  /** How many runs have been spent on this mode (its "pulls"). */
  plays: number;
  /** Raw average mode-appropriate reward (modeSuccess) over those runs. */
  meanReward: number;
  /** Exploitation term: meanReward normalized to [0,1] across modes. */
  exploitTerm: number;
  /** Exploration bonus: c · sqrt(ln(N+1) / max(plays,1)) — shrinks as a mode is tried more. */
  exploreBonus: number;
  /** Upper confidence bound: exploitTerm + exploreBonus. */
  ucb: number;
  /** Final normalized selection weight (sums to 1.0 across modes). */
  weight: number;
}

export interface BanditResult {
  /** Normalized selection weights, summing to 1.0. */
  weights: Record<string, number>;
  /** Per-mode breakdown (one entry per schedulable mode). */
  details: BanditDetail[];
  /** Total plays across schedulable modes (the bandit's N). */
  totalPlays: number;
  /** Exploration constant actually used. */
  explorationC: number;
}

/**
 * Compute cognitive-mode selection weights with a UCB1 multi-armed-bandit policy.
 *
 * The mode scheduler faces the explore/exploit dilemma directly: keep using the
 * mode that has paid off, or try one that has been tried less and might pay off
 * more. UCB1 makes that tradeoff principled instead of an ad-hoc blend:
 *
 *   score(m) = exploitTerm(m) + c · sqrt( ln(N + 1) / plays(m) )
 *
 * - `exploitTerm(m)` is the mean mode-appropriate reward (`modeSuccess`),
 *   normalized to [0,1] across modes — what we'd pick if we only exploited.
 * - The second term is the exploration bonus: it *grows* (relatively) for modes
 *   left untried and *shrinks* as a mode accumulates plays, so a lucky single
 *   result can't permanently dominate and a neglected mode is always revisited.
 *   This is the property the previous heuristic (a flat 5% floor) could not express.
 * - `c` is the single, visible knob for "how much to explore" (default √2).
 *
 * Scores normalize to weights that flow through `weightedModeSelect`, preserving
 * the existing deterministic, parallel-batch-diverging draw.
 *
 * Returns null when there are fewer than `minRuns` mode-tagged runs, leaving the
 * fixed cold-start schedule in charge (it seeds every mode at least once).
 */
export function computeBanditWeights(
  history: RunMetrics[],
  opts: { minRuns?: number; explorationC?: number } = {},
): BanditResult | null {
  const minRuns = opts.minRuns ?? 10;
  const explorationC = opts.explorationC ?? DEFAULT_BANDIT_C;

  // Only runs with mode data count toward bandit statistics.
  const withMode = history.filter(r => r.mode);
  if (withMode.length < minRuns) return null;

  // Group runs by mode.
  const byMode = new Map<string, RunMetrics[]>();
  for (const r of withMode) {
    const group = byMode.get(r.mode!) || [];
    group.push(r);
    byMode.set(r.mode!, group);
  }

  // Plays + mean reward per schedulable mode.
  const plays: Record<string, number> = {};
  const meanReward: Record<string, number> = {};
  for (const mode of SCHEDULABLE_MODES) {
    const runs = byMode.get(mode) || [];
    plays[mode] = runs.length;
    meanReward[mode] = runs.length
      ? runs.reduce((s, r) => s + modeSuccess(mode, r), 0) / runs.length
      : 0;
  }

  // N is the total plays across schedulable modes (the bandit's horizon).
  const totalPlays = SCHEDULABLE_MODES.reduce((s, m) => s + plays[m], 0);
  // Normalize the exploitation term to [0,1] so it is comparable to the bonus.
  const maxMean = Math.max(...SCHEDULABLE_MODES.map(m => meanReward[m]), 0);

  // Compute each mode's UCB once; reuse the exact same terms when building the
  // breakdown so the reported detail can never diverge from the real decision.
  const exploitTerm: Record<string, number> = {};
  const exploreBonus: Record<string, number> = {};
  const ucb: Record<string, number> = {};
  for (const mode of SCHEDULABLE_MODES) {
    exploitTerm[mode] = maxMean > 0 ? meanReward[mode] / maxMean : 0;
    // max(plays,1): a never-chosen mode gets the largest finite bonus, guaranteeing
    // it is revisited rather than starved (the fixed schedule has already seeded
    // every mode once before the bandit activates, so plays>=1 in practice).
    exploreBonus[mode] = explorationC * Math.sqrt(Math.log(totalPlays + 1) / Math.max(plays[mode], 1));
    ucb[mode] = exploitTerm[mode] + exploreBonus[mode];
  }

  // Normalize UCB scores to selection weights summing to 1.0. exploreBonus > 0
  // for c > 0, so the sum is positive; if c === 0 and all rewards are 0 (no signal
  // at all), fall back to uniform weights rather than dividing by zero.
  const totalUcb = SCHEDULABLE_MODES.reduce((s, m) => s + ucb[m], 0);
  const weights: Record<string, number> = {};
  for (const mode of SCHEDULABLE_MODES) {
    weights[mode] = totalUcb > 0 ? ucb[mode] / totalUcb : 1 / SCHEDULABLE_MODES.length;
  }

  const details: BanditDetail[] = SCHEDULABLE_MODES.map(mode => ({
    mode,
    plays: plays[mode],
    meanReward: meanReward[mode],
    exploitTerm: exploitTerm[mode],
    exploreBonus: exploreBonus[mode],
    ucb: ucb[mode],
    weight: weights[mode],
  }));

  return { weights, details, totalPlays, explorationC };
}

/** Read the bandit exploration constant from the environment, falling back to the default. */
export function banditExplorationC(): number {
  const raw = process.env.KAIZEN_BANDIT_C;
  if (raw === undefined || raw === '') return DEFAULT_BANDIT_C;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_BANDIT_C;
}

/**
 * Hash a string into a 32-bit integer for seed mixing.
 */
function hashString(s: string): number {
  let h = 0;
  for (const c of s) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
  return h;
}

/**
 * Select a mode using weighted random selection.
 * Uses runNum and optional batchId as a deterministic seed for reproducibility.
 * Including batchId ensures parallel batches explore different mode sequences.
 */
export function weightedModeSelect(
  weights: Record<string, number>,
  runNum: number,
  batchId?: string,
): string {
  // Deterministic pseudo-random from runNum + batchId
  // Mix batch_id into seed so parallel batches diverge
  const batchHash = batchId ? hashString(batchId) : 0;
  const hash = (((runNum * 2654435761 + batchHash) >>> 0) / 4294967296);

  const entries = Object.entries(weights).sort((a, b) => a[0].localeCompare(b[0]));
  let cumulative = 0;
  for (const [mode, weight] of entries) {
    cumulative += weight;
    if (hash < cumulative) return mode;
  }
  // Fallback (shouldn't happen with normalized weights)
  return entries[entries.length - 1][0];
}

/**
 * Select the cognitive mode for a given run.
 *
 * Priority (highest first):
 *   1. Guidance override: "mode:<name>" in guidance forces that mode
 *   2. Test task: always exploit with test template
 *   3. Signal-driven: reactive to batch state (failures, stalls, streaks)
 *   4. Contemplate overlay: every 15th run for strategic assessment
 *   5. Bandit selection: UCB1 explore/exploit weighting from run history
 *   6. Base cycle (mod 10): 0-6 exploit, 7 explore, 8 reflect, 9 subtract
 */
export function selectMode(state: BatchState, runNum: number): ModeSelection {
  // Force mode from guidance (e.g., "mode:explore")
  const modeOverride = state.guidance.match(/\bmode:(\w+)/i);
  if (modeOverride) {
    const forced = modeOverride[1].toLowerCase();
    return {
      mode: forced,
      template: MODE_TEMPLATES[forced] || MODE_TEMPLATES.exploit,
      reason: 'guidance',
    };
  }

  // Test task always uses test template
  if (state.test_task) {
    return { mode: 'exploit', template: 'test-task.md', reason: 'test-task' };
  }

  // Signal-driven overrides (reactive to batch state)
  const signalMode = checkSignalOverrides(state);
  if (signalMode) return signalMode;

  // Contemplate overlay: every 15th run pauses for strategic assessment
  if (runNum > 0 && runNum % 15 === 14) {
    return { mode: 'contemplate', template: MODE_TEMPLATES.contemplate, reason: 'schedule' };
  }

  // Bandit selection: principled UCB1 explore/exploit weighting when data allows.
  const bandit = computeBanditWeights(state.run_history || [], { explorationC: banditExplorationC() });
  if (bandit) {
    const mode = weightedModeSelect(bandit.weights, runNum, state.batch_id);
    return { mode, template: MODE_TEMPLATES[mode] || MODE_TEMPLATES.exploit, reason: 'bandit', bandit };
  }

  // Fallback: fixed schedule (used for first N runs before enough data)
  const slot = runNum % 10;
  if (slot <= 6) return { mode: 'exploit', template: MODE_TEMPLATES.exploit, reason: 'schedule' };
  if (slot === 7) return { mode: 'explore', template: MODE_TEMPLATES.explore, reason: 'schedule' };
  if (slot === 8) return { mode: 'reflect', template: MODE_TEMPLATES.reflect, reason: 'schedule' };
  return { mode: 'subtract', template: MODE_TEMPLATES.subtract, reason: 'schedule' };
}

/**
 * Compute mode distribution from run history.
 * Returns a record of mode -> count.
 */
export function computeModeDistribution(history: RunMetrics[]): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const r of history) {
    const m = r.mode || 'exploit';
    dist[m] = (dist[m] || 0) + 1;
  }
  return dist;
}

export interface PromptMetadata {
  /** The rendered prompt text */
  prompt: string;
  /** Template file name (e.g., "deep-dive-default.md"), or "inline" for fallback */
  template: string;
  /** SHA-256 hash of the raw template content (first 12 chars), or "none" for inline */
  hash: string;
  /** Issue ref of the plan item claimed for this run (e.g., "#302"), if any */
  claimedPlanIssue?: string;
}

export function buildPrompt(state: BatchState, runNum: number, logDir?: string): string {
  return buildPromptWithMetadata(state, runNum, logDir).prompt;
}

/**
 * Populate `state.cross_batch_steering` from PRIOR batches' GitHub outcomes,
 * once per batch (#940 Phase 2). This is what closes the cross-batch learning
 * loop: Phase 1 wrote durable `batch-outcome` records to GitHub; here a later
 * batch reads them, derives steering recommendations, and persists them so every
 * run in this batch sees them via {{cross_batch_steering}}.
 *
 * Fail-open and idempotent: runs only when the field is unset, and any GitHub /
 * parse error degrades to an empty array (no steering) rather than breaking the
 * run. The result is persisted so it is computed at most once per batch. `deps`
 * is injectable for tests. Returns the steering strings that were stored.
 */
export function populateCrossBatchSteering(
  state: BatchState,
  stateFile: string,
  deps: { read?: typeof readBatchOutcomesFromGithub } = {},
): string[] {
  // Already attempted this batch (possibly resumed) — don't refetch.
  if (state.cross_batch_steering !== undefined) return state.cross_batch_steering;

  const repo = state.kaizen_repo;
  let steering: string[] = [];
  if (repo && repo !== 'unknown') {
    try {
      const read = deps.read ?? readBatchOutcomesFromGithub;
      const outcomes = read(repo, { excludeBatchId: state.batch_id });
      const report = computeSteeringRecommendations(outcomes);
      steering = report.recommendations.map((r) => r.text);
      if (steering.length > 0) {
        console.log(
          `  [intelligence] cross-batch steering: ${steering.length} signal(s) from ${report.batches_analyzed} prior batch(es)`,
        );
      } else {
        console.log(
          `  [intelligence] cross-batch steering: no strong signal from ${report.batches_analyzed} prior batch(es)`,
        );
      }
    } catch (err) {
      // Fail-open: prior-batch intelligence is a nicety, never a blocker.
      console.log(
        `  [intelligence] cross-batch steering skipped: ${(err as Error).message?.split('\n')[0]}`,
      );
      steering = [];
    }
  }

  state.cross_batch_steering = steering;
  try {
    writeState(stateFile, state);
  } catch {
    /* best-effort persistence; in-memory value still steers this run */
  }
  return steering;
}

export function buildPromptWithMetadata(state: BatchState, runNum: number, logDir?: string): PromptMetadata {
  const vars = buildTemplateVars(state, runNum, logDir);
  const claimedPlanIssue = vars.claimed_plan_issue || undefined;

  const { template: templateFile } = selectMode(state, runNum);
  const templateContent = loadPromptTemplate(templateFile);

  if (templateContent) {
    const hash = createHash('sha256').update(templateContent).digest('hex').slice(0, 12);
    return {
      prompt: renderTemplate(templateContent, vars),
      template: templateFile,
      hash,
      claimedPlanIssue,
    };
  }

  // Inline fallback (kept for backward compatibility)
  return {
    prompt: buildPromptInline(state, runNum),
    template: 'inline',
    hash: 'none',
    claimedPlanIssue,
  };
}

function buildPromptInline(state: BatchState, runNum: number): string {
  const runTag = `${state.batch_id}/run-${runNum}`;
  const kaizenRepo = state.kaizen_repo || 'unknown';
  const hostRepo = state.host_repo || kaizenRepo;

  let prompt: string;

  if (state.test_task) {
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, '')
      .slice(0, 14);
    prompt = `You are running a synthetic test task for pipeline validation.

Run tag: ${runTag}

## Task

1. Create a new branch from HEAD: \`test-probe-${runTag.replace(/\//g, '-')}\`
2. Create a file \`test-probe-${timestamp}.md\` with this content:
   \`\`\`
   # Test Probe
   Run tag: ${runTag}
   Timestamp: ${new Date().toISOString()}
   \`\`\`
3. Commit with message: "test: probe ${runTag}"
4. Create a PR: \`gh pr create --title "test: probe ${runTag}" --body "Synthetic test task for pipeline validation. Run tag: ${runTag}" --repo ${hostRepo}\`
5. Leave auto-merge to the harness after review verdicts are known

Do not ask for confirmation. Complete all steps.`;
  } else {
    prompt = `Use /kaizen-deep-dive with this guidance: ${state.guidance}`;
  }

  prompt += `

Run tag: ${runTag}
Include this run tag in any PR descriptions or commit messages you create.

## Batch Context

You are running inside an auto-dent batch loop (run ${runNum}${state.max_runs > 0 ? ` of ${state.max_runs}` : ''}).
After this run completes, the loop will start another run with fresh context.
Run to completion. Do not ask for confirmation — make autonomous decisions.`;

  if (state.issues_closed.length > 0) {
    prompt += `\n\nIssues already addressed in previous runs (do not rework): ${state.issues_closed.join(' ')}`;
  }

  if (state.prs.length > 0) {
    prompt += `\n\nPRs already created in this batch (avoid overlapping work): ${state.prs.join(' ')}`;
  }

  prompt += `

## Merge & Labeling Policy

After creating a PR, do NOT run merge commands yourself.
The auto-dent harness queues auto-merge after review verdicts and process evidence are known.
Leave the PR open for the harness-owned terminal action.

## Stopping the Loop

If you determine there is no more meaningful work to do matching the guidance
(backlog exhausted, all relevant issues claimed, or remaining issues are
blocked/too risky), include this exact marker in your final response:

AUTO_DENT_PHASE: STOP | reason=<reason>

For example: "AUTO_DENT_PHASE: STOP | reason=backlog exhausted — no more open issues matching 'hooks reliability'"
This will gracefully stop the batch loop. Only use this when you've genuinely
run out of work — not when a single run is complete.

When done, summarize what was accomplished. List all PRs created, issues filed,
and issues closed with full URLs.

## Progress Markers

Throughout your work, emit structured progress markers so the harness can show
what you're doing. Place each marker on its own line. Format:

AUTO_DENT_PHASE: <PHASE> | key=value | key=value ...

Phases and their expected keys:

| Phase | When | Keys |
|-------|------|------|
| PICK | After selecting an issue | issue=<#NNN or URL>, title=<short title> |
| EVALUATE | After scoping the work | verdict=<proceed/skip/defer>, reason=<why> |
| IMPLEMENT | Starting implementation | case=<case-id>, branch=<branch-name> |
| TEST | After running tests | result=<pass/fail>, count=<number of tests> |
| PR | After creating a PR | url=<PR URL> |
| MERGE | After the harness reports merge status | url=<PR URL>, status=<queued/merged/blocked> |
| REFLECT | After reflection | issues_filed=<N>, lessons=<short summary> |

Example:
  AUTO_DENT_PHASE: PICK | issue=#472 | title=improve hook test DRY
  AUTO_DENT_PHASE: EVALUATE | verdict=proceed | reason=clear spec, medium complexity
  AUTO_DENT_PHASE: IMPLEMENT | case=260323-1200-k472 | branch=case/260323-1200-k472
  AUTO_DENT_PHASE: TEST | result=pass | count=15
  AUTO_DENT_PHASE: PR | url=https://github.com/Garsson-io/kaizen/pull/500
  AUTO_DENT_PHASE: MERGE | url=https://github.com/Garsson-io/kaizen/pull/500 | status=queued
  AUTO_DENT_PHASE: REFLECT | issues_filed=1 | lessons=shared helpers reduce test boilerplate

Emit these naturally as you complete each phase. Missing keys are fine — emit what you have.`;

  return prompt;
}

/**
 * Clean raw guidance into a readable title.
 * Fixes obvious typos, normalizes whitespace, sentence-cases.
 */
export function cleanGuidanceForTitle(guidance: string): string {
  return guidance
    .replace(/\s+/g, ' ')
    .trim();
}

// Batch progress issue management

/**
 * Search GitHub for an existing batch progress issue by batch ID.
 * Returns the issue URL if found, empty string otherwise.
 */
export function findExistingProgressIssue(batchId: string, kaizenRepo: string): string {
  const result = ghExec(
    `gh issue list --repo ${kaizenRepo} --label auto-dent --search ${JSON.stringify(batchId)} --json url --limit 1`,
  );
  if (!result) return '';
  try {
    const issues = JSON.parse(result) as Array<{ url: string }>;
    if (issues.length > 0) return issues[0].url;
  } catch {
    // JSON parse failed — no match
  }
  return '';
}

export function ensureBatchProgressIssue(
  state: BatchState,
  stateFile: string,
): string {
  if (state.progress_issue) return state.progress_issue;

  const kaizenRepo = state.kaizen_repo;
  if (!kaizenRepo) return '';

  // Search for an existing progress issue to avoid duplicates (#726)
  const existing = findExistingProgressIssue(state.batch_id, kaizenRepo);
  if (existing) {
    console.log(`  [hygiene] found existing batch progress issue: ${existing}`);
    const freshState = readState(stateFile);
    freshState.progress_issue = existing;
    writeState(stateFile, freshState);
    return existing;
  }

  const cleanGuidance = cleanGuidanceForTitle(state.guidance);
  const title = `[Auto-Dent] ${truncateAtWordBoundary(cleanGuidance, 70)} (${state.batch_id})`;
  const startedAt = new Date(state.batch_start * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  const body = [
    `## Auto-Dent Batch`,
    '',
    `> **Guidance:** ${state.guidance}`,
    '',
    '<details>',
    '<summary>Batch config</summary>',
    '',
    `| Field | Value |`,
    `|-------|-------|`,
    `| **Batch ID** | \`${state.batch_id}\` |`,
    `| **Max runs** | ${state.max_runs || 'unlimited'} |`,
    `| **Budget/run** | ${state.budget ? '$' + state.budget : 'none'} |`,
    `| **Max budget** | ${state.max_budget ? '$' + state.max_budget : 'none'} |`,
    `| **Cooldown** | ${state.cooldown}s |`,
    `| **Max failures** | ${state.max_failures} |`,
    `| **Started** | ${startedAt} |`,
    '',
    '</details>',
    '',
    '_Run-by-run updates posted as comments. Auto-managed by auto-dent._',
  ].join('\n');

  const url = ghExec(
    `gh issue create --repo ${kaizenRepo} --title ${JSON.stringify(title)} --label auto-dent,kaizen --body ${JSON.stringify(body)}`,
  );

  if (url) {
    console.log(`  [hygiene] created batch progress issue: ${url}`);
    const freshState = readState(stateFile);
    freshState.progress_issue = url;
    writeState(stateFile, freshState);
    return url;
  }
  return '';
}

export function updateBatchProgressIssue(
  progressIssue: string,
  kaizenRepo: string,
  runNum: number,
  exitCode: number,
  duration: number,
  result: RunResult,
): void {
  if (!progressIssue || !kaizenRepo) return;

  const m = progressIssue.match(/issues\/(\d+)/);
  if (!m) return;
  const issueNum = m[1];

  const score = scoreRunResult(result, exitCode, duration);
  const status = score.success ? 'pass' : exitCode === 0 ? 'no-pr' : `fail (exit ${exitCode})`;
  const mins = Math.floor(duration / 60);
  const secs = duration % 60;

  const lines = [
    `### Run #${runNum} — ${status}`,
    '',
    `> ${formatRunScoreLine(score)}`,
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| **Duration** | ${mins}m ${secs}s |`,
    `| **Cost** | $${result.cost.toFixed(2)} |`,
    `| **Tool calls** | ${result.toolCalls} |`,
    `| **Issue worked** | ${formatIssueForDisplay(result.pickedIssue, kaizenRepo, result.pickedIssueTitle)} |`,
    `| **PR generated** | ${result.prs.length > 0 ? result.prs.join(', ') : 'none'} |`,
    `| **Review state** | ${formatReviewForDisplay(result)} |`,
  ];

  if (result.issuesFiled.length > 0) {
    lines.push(`| **Issues filed** | ${result.issuesFiled.join(', ')} |`);
  }
  if (result.issuesClosed.length > 0) {
    lines.push(`| **Issues closed** | ${result.issuesClosed.join(' ')} |`);
  }
  if (result.cases.length > 0) {
    lines.push(
      `| **Cases** | ${result.cases.map((c) => '`' + c + '`').join(', ')} |`,
    );
  }
  if (result.stopRequested) {
    lines.push('', `**STOP requested:** ${result.stopReason}`);
  }
  const stepsTable = formatProgressStepsMarkdown(result, kaizenRepo);
  if (stepsTable) {
    lines.push('', stepsTable);
  }

  const comment = lines.join('\n');
  ghExec(
    `gh issue comment ${issueNum} --repo ${kaizenRepo} --body ${JSON.stringify(comment)}`,
  );
  console.log(`  [hygiene] updated progress issue with run #${runNum}`);
}

/**
 * Run post-hoc scoring: check merge status for all batch PRs.
 * Returns the post-hoc result which can be attached to a BatchScore.
 */
export function runPostHocScoring(
  allPrUrls: string[],
  totalCostUsd: number,
): ReturnType<typeof postHocScoreBatch> {
  const prStatuses = allPrUrls.map((url) => ({
    url,
    status: checkMergeStatus(url),
  }));
  return postHocScoreBatch(prStatuses, totalCostUsd);
}

export function closeBatchProgressIssue(
  progressIssue: string,
  kaizenRepo: string,
  state: BatchState,
  batchDir?: string,
): void {
  if (!progressIssue || !kaizenRepo) return;
  const m = progressIssue.match(/issues\/(\d+)/);
  if (!m) return;

  const elapsed = Math.floor(Date.now() / 1000) - state.batch_start;
  const hours = Math.floor(elapsed / 3600);
  const mins = Math.floor((elapsed % 3600) / 60);

  const batchScore = scoreBatch(state.run_history || []);

  // Authoritative "issues closed" count (#1173): the per-run sum in batchScore is
  // scraped from agent narration and undercounts (it never saw GitHub's verified
  // auto-closures). Reconcile once here from the merged PR bodies — the deduped
  // union of verified ∪ force-closed — so the summary, score table, and
  // batch-outcome attachment all report the true count instead of the scrape.
  // Best-effort: a gh failure must never block batch close.
  // null until reconcile runs; an empty array means "reconcile ran, nothing
  // closed" (authoritative) — distinct from null ("reconcile did not run").
  let reconciledClosed: string[] | null = null;
  if (state.prs.length > 0) {
    try {
      reconciledClosed = reconcileBatchClosedIssues(state.prs, kaizenRepo);
      batchScore.reconciled_issues_closed = reconciledClosed.length;
    } catch (err) {
      console.log(`  [intelligence] issues-closed reconcile skipped: ${(err as Error).message}`);
    }
  }

  // Post-hoc: check final merge status for all PRs
  if (state.prs.length > 0) {
    const postHoc = runPostHocScoring(state.prs, batchScore.total_cost_usd);
    batchScore.post_hoc = postHoc;
    console.log(`  [post-hoc] ${formatPostHocLine(postHoc)}`);
  }

  const summary = [
    `### Batch Complete`,
    '',
    formatBatchScoreTable(batchScore),
    `| **Wall time** | ${hours}h ${mins}m |`,
    `| **Stop reason** | ${state.stop_reason || 'completed'} |`,
    '',
    `**PRs:** ${state.prs.length > 0 ? state.prs.join(', ') : 'none'}`,
    `**Issues filed:** ${state.issues_filed.length > 0 ? state.issues_filed.join(', ') : 'none'}`,
    `**Issues closed:** ${formatIssuesClosedLine(reconciledClosed, state.issues_closed)}`,
  ].join('\n');

  ghExec(
    `gh issue comment ${m[1]} --repo ${kaizenRepo} --body ${JSON.stringify(summary)}`,
  );

  // Durable cross-batch learning (#1108, #940 Phase 1): write a machine-readable
  // batch-outcome attachment BEFORE closing, so future batches can read back what
  // this batch measured instead of starting blind. Best-effort — a failed write
  // must never block batch close (this runs on abnormal exits too).
  try {
    const outcome = buildBatchOutcome(state, batchScore, Math.floor(Date.now() / 1000));
    writeBatchOutcomeAttachment(m[1], kaizenRepo, outcome);
    console.log(`  [intelligence] stored batch-outcome attachment on #${m[1]}`);
  } catch (err) {
    console.log(`  [intelligence] batch-outcome write skipped: ${(err as Error).message}`);
  }

  // Durable RAW artifacts (#696, epic #842): inline the on-disk events.jsonl +
  // state.json into an idempotent attachment so the cloud has the forensic data,
  // not just the summary. Best-effort — must never block close (abnormal exits too).
  if (batchDir) {
    try {
      const url = uploadBatchArtifacts(m[1], kaizenRepo, batchDir, new Date().toISOString());
      if (url) console.log(`  [intelligence] uploaded raw batch artifacts to #${m[1]}`);
      else console.log(`  [intelligence] no raw artifacts on disk to upload`);
    } catch (err) {
      console.log(`  [intelligence] batch-artifacts upload skipped: ${(err as Error).message}`);
    }
  }

  // Pre-existing-PR graveyard maintenance (#1365, follow-up to #1159/PR #1363):
  // run the stale-PR triage once per batch, sibling to the rescue finalizer's
  // current-run-strand pass. Posts the grouped report to the progress issue and,
  // unless opted out, closes the deliberately-safe `close-superseded` set (every
  // `Closes #N` already CLOSED, fail-open). Best-effort and self-guarding — a
  // failure here must never block the batch close below.
  try {
    const apply = process.env.KAIZEN_NO_STALE_PR_APPLY !== '1';
    const staleDaysRaw = parseInt(process.env.KAIZEN_STALE_PR_DAYS ?? '', 10);
    const staleDays = Number.isFinite(staleDaysRaw) && staleDaysRaw >= 0 ? staleDaysRaw : 21;
    const result = runStalePrTriageMaintenance({
      gh: ghArgs,
      nowMs: Date.now(),
      repo: kaizenRepo,
      staleDays,
      limit: 100,
      apply,
      progressIssue: m[1],
      log: (msg) => console.log(`  [stale-pr] ${msg}`),
      err: (msg) => console.log(`  [stale-pr] ${msg}`),
    });
    const closed = result.applied?.closed.length ?? 0;
    console.log(
      `  [stale-pr] triaged ${result.rows.length} open PR(s)` +
        (apply ? `, closed ${closed} superseded` : ' (report-only)'),
    );
  } catch (err) {
    console.log(`  [stale-pr] triage maintenance skipped: ${(err as Error).message}`);
  }

  ghExec(`gh issue close ${m[1]} --repo ${kaizenRepo} --reason completed`);
  console.log(`  [hygiene] closed batch progress issue`);
}

// Execute Claude

// Default max wall time per run: 20 minutes (#686)
const DEFAULT_MAX_RUN_SECONDS = 20 * 60;
// Grace period after result before SIGTERM
const POST_RESULT_GRACE_MS = 60_000;
// Grace period after SIGTERM before SIGKILL
const SIGKILL_GRACE_MS = 10_000;

interface ProviderRunResult {
  exitCode: number;
  duration: number;
  result: RunResult;
  mode: string;
  modeReason: string;
  promptMeta: PromptMetadata;
}

async function runCodex(
  input: {
    state: BatchState;
    runNum: number;
    logFile: string;
    repoRoot: string;
    stateFile: string;
    prompt: string;
    promptMeta: PromptMetadata;
    mode: string;
    modeReason: string;
    result: RunResult;
  },
): Promise<ProviderRunResult> {
  const logDir = dirname(input.stateFile);
  const rawFile = `${logDir}/run-${input.runNum}-codex.jsonl`;
  const runStart = Date.now();
  const maxRunMs = (input.state.max_run_seconds || DEFAULT_MAX_RUN_SECONDS) * 1000;

  let version = 'unknown';
  try {
    version = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    // Missing version detail should not hide the primary spawn error below.
  }

  appendFileSync(input.logFile, `[provider] codex subscription-cli\n`);
  appendFileSync(input.logFile, `[provider] version=${version}\n`);
  appendFileSync(input.logFile, `[provider] raw_jsonl=${rawFile}\n`);
  writeFileSync(rawFile, '');

  return new Promise((resolvePromise) => {
    let processExited = false;
    let raw = '';
    const ctx: StreamContext = { provider: 'codex' };
    const child = spawn('codex', buildCodexExecArgs(input.repoRoot), {
      cwd: input.repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin?.end(input.prompt);

    const wallTimer = setTimeout(() => {
      if (!processExited) {
        input.result.timedOut = true;
        appendFileSync(input.logFile, `\n[watchdog] codex wall-time timeout (${maxRunMs / 1000}s) — sending SIGTERM\n`);
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!processExited) child.kill('SIGKILL');
        }, SIGKILL_GRACE_MS);
      }
    }, maxRunMs);

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      raw += line + '\n';
      appendFileSync(rawFile, line + '\n');

      const event = parseJsonObject(line);
      if (!event) return;

      try {
        for (const streamMessage of normalizeCodexEventToStreamMessages(event)) {
          processStreamMessage(streamMessage, input.result, runStart, ctx);
        }
      } catch {
        // Raw JSONL remains durable; a malformed display row should not hide run completion.
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      appendFileSync(input.logFile, data.toString());
    });

    const finish = (exitCode: number) => {
      if (processExited) return;
      processExited = true;
      clearTimeout(wallTimer);
      const parsed = parseCodexJsonl(raw);
      if (!input.result.finalClaimStatus && parsed.finalText) {
        for (const streamMessage of normalizeCodexFinalTextToStreamMessages(parsed.finalText)) {
          processStreamMessage(streamMessage, input.result, runStart, ctx);
        }
      }

      appendFileSync(input.logFile, `\n--- codex final text ---\n${parsed.finalText || parsed.text}\n`);
      const markers = extractCodexPhaseMarkers(parsed);
      if (markers.length > 0) {
        appendFileSync(input.logFile, `\n--- codex lifecycle markers ---\n${markers.join('\n')}\n`);
      }
      if (parsed.malformedLines.length > 0) {
        appendFileSync(input.logFile, `\n[codex] malformed_jsonl_lines=${parsed.malformedLines.length}\n`);
      }

      const duration = Math.floor((Date.now() - runStart) / 1000);
      resolvePromise({
        exitCode,
        duration,
        result: input.result,
        mode: input.mode,
        modeReason: input.modeReason,
        promptMeta: input.promptMeta,
      });
    };

    child.on('close', (code) => finish(code ?? 1));
    child.on('error', (err) => {
      appendFileSync(input.logFile, `\nCodex process error: ${err.message}\n`);
      finish(1);
    });
  });
}

async function runClaude(
  state: BatchState,
  runNum: number,
  logFile: string,
  repoRoot: string,
  stateFile: string,
): Promise<{ exitCode: number; duration: number; result: RunResult; mode: string; modeReason: string; promptMeta: PromptMetadata }> {
  const result: RunResult = {
    prs: [],
    issuesFiled: [],
    issuesClosed: [],
    cases: [],
    cost: 0,
    toolCalls: 0,
    stopRequested: false,
    linesDeleted: 0,
    issuesPruned: 0,
  };

  // Claude path: hooks are expected. The init-event check (#843) proves they loaded.
  const ctx: StreamContext = { provider: 'claude' };

  const logDir = dirname(stateFile);
  const modeSelection = selectMode(state, runNum);
  if (modeSelection.mode !== 'exploit' || modeSelection.reason !== 'schedule') {
    console.log(`  [mode] run #${runNum}: ${modeSelection.mode} (${modeSelection.reason}, template: ${modeSelection.template})`);
  }
  if (modeSelection.bandit) {
    // Make the explore/exploit decision auditable: show each mode's UCB breakdown.
    const b = modeSelection.bandit;
    const breakdown = b.details
      .map(d => `${d.mode} w=${d.weight.toFixed(2)} (reward=${d.meanReward.toFixed(2)}/${d.plays}p, +explore=${d.exploreBonus.toFixed(2)})`)
      .join('  ');
    console.log(`  [bandit] N=${b.totalPlays} c=${b.explorationC.toFixed(2)}  ${breakdown}`);
  }
  const promptMeta = buildPromptWithMetadata(state, runNum, logDir);
  const prompt = promptMeta.prompt;
  if (state.test_task && !result.pickedIssue) {
    result.pickedIssue = 'not applicable';
    result.pickedIssueTitle = 'synthetic test task';
  }
  if (promptMeta.claimedPlanIssue && !result.pickedIssue) {
    result.pickedIssue = promptMeta.claimedPlanIssue;
    result.progressSteps = result.progressSteps || [];
    if (!result.progressSteps.some((s) => s.phase === 'PICK')) {
      result.progressSteps.push({
        phase: 'PICK',
        state: 'assigned',
        detail: promptMeta.claimedPlanIssue,
        url: formatIssueUrl(promptMeta.claimedPlanIssue, state.kaizen_repo || state.host_repo || ''),
      });
    }
    upsertProgressStep(result, {
      phase: 'PLAN',
      state: 'assigned',
      detail: `batch plan item ${promptMeta.claimedPlanIssue}`,
      url: formatIssueUrl(promptMeta.claimedPlanIssue, state.kaizen_repo || state.host_repo || ''),
    });
  }

  // Save rendered prompt for observability (#602)
  const promptFile = `${logDir}/run-${runNum}-prompt.md`;
  writeFileSync(promptFile, prompt + '\n');

  if (shouldRunCodexProvider(state)) {
    return runCodex({
      state,
      runNum,
      logFile,
      repoRoot,
      stateFile,
      prompt,
      promptMeta,
      mode: modeSelection.mode,
      modeReason: modeSelection.reason,
      result,
    });
  }

  const nonce = `${new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(2, 12)}-${Math.random().toString(16).slice(2, 6)}`;

  const args = [
    '-w',
    nonce,
    '-p',
    prompt,
    '--dangerously-skip-permissions',
    '--output-format',
    'stream-json',
    '--verbose',
  ];
  if (state.budget) {
    args.push('--max-budget-usd', state.budget);
  }

  const runStart = Date.now();
  const maxRunMs =
    (state.max_run_seconds || DEFAULT_MAX_RUN_SECONDS) * 1000;

  // #1270: expose this run's identity to the spawned agent. The
  // capture-worktree-context hook reads KAIZEN_RUN_TAG to stamp every case
  // worktree the agent creates, giving the rescue finalizer a durable,
  // run-scoped attribution signal independent of stream markers.
  // (Local names are agent-prefixed to stay clear of the canonical post-run
  // `runId` declaration guarded by the #1128 regression test.)
  const agentRunTag = `${state.batch_id}/run-${runNum}`;
  const agentRunId = makeRunId(state.batch_id, runNum);

  return new Promise((resolvePromise) => {
    let processExited = false;

    const child = spawn('claude', args, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, KAIZEN_RUN_TAG: agentRunTag, KAIZEN_RUN_ID: agentRunId },
    });

    const cleanup = (...timers: (ReturnType<typeof setInterval> | ReturnType<typeof setTimeout> | undefined)[]) => {
      for (const t of timers) {
        if (t) clearTimeout(t as any);
      }
    };

    // Heartbeat: distinguish done-vs-stuck (#355)
    let lastOutputTime = Date.now();
    const heartbeatInterval = setInterval(() => {
      const silence = Math.floor((Date.now() - lastOutputTime) / 1000);
      if (silence >= 55) {
        console.log(formatHeartbeat(runStart, result.toolCalls, ctx));
      }
    }, 60_000);

    // Liveness marker: update state.json periodically (#357)
    const livenessInterval = setInterval(() => {
      try {
        const s = readState(stateFile);
        s.last_heartbeat = Math.floor(Date.now() / 1000);
        writeState(stateFile, s);
      } catch {
        // State file write failure is non-fatal
      }
    }, 60_000);

    // In-flight progress updates to GitHub issue (#356)
    const progressIssue = ensureBatchProgressIssue(state, stateFile);
    const inFlightInterval = progressIssue
      ? setInterval(() => {
          postInFlightUpdate(
            progressIssue,
            state.kaizen_repo,
            runNum,
            runStart,
            result,
            ctx,
          );
        }, IN_FLIGHT_UPDATE_INTERVAL_MS)
      : undefined;

    // Global wall-time timeout (#354, #686)
    const wallTimer = setTimeout(() => {
      if (!processExited) {
        result.timedOut = true;
        console.log(
          `  [watchdog] run exceeded ${maxRunMs / 1000}s wall time — SIGTERM`,
        );
        appendFileSync(
          logFile,
          `\n[watchdog] wall-time timeout (${maxRunMs / 1000}s) — sending SIGTERM\n`,
        );
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!processExited) {
            console.log(
              `  [watchdog] process still alive after SIGTERM+${SIGKILL_GRACE_MS / 1000}s — SIGKILL`,
            );
            child.kill('SIGKILL');
          }
        }, SIGKILL_GRACE_MS);
      }
    }, maxRunMs);

    // Post-result kill timer (#354)
    let postResultTimer: ReturnType<typeof setTimeout> | undefined;

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      appendFileSync(logFile, line + '\n');
      lastOutputTime = Date.now();

      const msg = parseJsonObject(line);
      if (!msg) return;

      try {
        processStreamMessage(msg, result, runStart, ctx);

        // Start post-result kill timer when result is received
        if (msg.type === 'result' && !postResultTimer) {
          postResultTimer = setTimeout(() => {
            if (!processExited) {
              console.log(
                `  [watchdog] result received but process alive after ${POST_RESULT_GRACE_MS / 1000}s — SIGTERM`,
              );
              appendFileSync(
                logFile,
                `\n[watchdog] post-result timeout (${POST_RESULT_GRACE_MS / 1000}s) — sending SIGTERM\n`,
              );
              child.kill('SIGTERM');
              setTimeout(() => {
                if (!processExited) {
                  console.log(
                    `  [watchdog] process still alive after SIGTERM+${SIGKILL_GRACE_MS / 1000}s — SIGKILL`,
                  );
                  child.kill('SIGKILL');
                }
              }, SIGKILL_GRACE_MS);
            }
          }, POST_RESULT_GRACE_MS);
        }
      } catch { /* skip malformed stream messages */ }
    });

    child.stderr?.on('data', (data: Buffer) => {
      appendFileSync(logFile, data.toString());
    });

    child.on('close', (code) => {
      processExited = true;
      cleanup(heartbeatInterval, livenessInterval, inFlightInterval, wallTimer, postResultTimer);
      const duration = Math.floor((Date.now() - runStart) / 1000);
      resolvePromise({ exitCode: code ?? 1, duration, result, mode: modeSelection.mode, modeReason: modeSelection.reason, promptMeta });
    });

    child.on('error', (err) => {
      processExited = true;
      cleanup(heartbeatInterval, livenessInterval, inFlightInterval, wallTimer, postResultTimer);
      appendFileSync(logFile, `\nProcess error: ${err.message}\n`);
      const duration = Math.floor((Date.now() - runStart) / 1000);
      resolvePromise({ exitCode: 1, duration, result, mode: modeSelection.mode, modeReason: modeSelection.reason, promptMeta });
    });
  });
}

// Display

/**
 * Format a batch scoreboard footer showing cumulative stats.
 * Shown after each run so the operator can see batch health at a glance.
 */
export function formatBatchFooter(state: BatchState): string {
  const history = state.run_history || [];
  const totalCost = history.reduce((s, r) => s + r.cost_usd, 0);
  const totalPRs = state.prs.length;
  const mergedCount = history.filter(
    (r) => r.prs.length > 0 && r.exit_code === 0,
  ).length;
  const mergeRate =
    totalPRs > 0 ? Math.round((mergedCount / totalPRs) * 100) : 0;

  const bar = '\u2501'.repeat(54);
  const line = [
    `  Run ${state.run}`,
    `PRs: ${totalPRs}`,
    `$${totalCost.toFixed(2)}`,
    `${mergeRate}% success`,
  ].join(' \u2502 ');

  // Mode distribution
  const modeDist = computeModeDistribution(history);
  const modeStr = Object.entries(modeDist)
    .sort((a, b) => b[1] - a[1])
    .map(([m, c]) => `${m}:${c}`)
    .join(' ');

  const lines = [
    `  ${color.dim(bar)}`,
    `  ${color.bold(line)}`,
  ];

  if (modeStr) {
    lines.push(`  ${color.dim(`  Modes: ${modeStr}`)}`);
  }

  lines.push(`  ${color.dim(bar)}`);

  return lines.join('\n');
}

function printRunSummary(
  runNum: number,
  exitCode: number,
  duration: number,
  result: RunResult,
  repo = '',
): void {
  const status =
    exitCode === 0 ? color.green('success') : color.red(`failed (exit ${exitCode})`);

  console.log('');
  console.log(
    `  ${color.bold(`\u250c\u2500 Run #${runNum} Summary`)} ${'─'.repeat(30)}`,
  );
  console.log(`  \u2502 Status:   ${status}`);
  console.log(`  \u2502 Duration: ${duration}s`);
  console.log(`  \u2502 Cost:     $${result.cost.toFixed(2)}`);
  console.log(`  \u2502 Tools:    ${result.toolCalls} calls`);

  console.log(`  \u2502 Issue:    ${formatIssueForDisplay(result.pickedIssue, repo, result.pickedIssueTitle)}`);
  if (result.prs.length === 0) {
    console.log(`  \u2502 ${color.green('PR:')}       none`);
  } else {
    for (const pr of result.prs) console.log(`  \u2502 ${color.green('PR:')}       ${pr}`);
  }
  console.log(`  \u2502 Review:   ${formatReviewForDisplay(result)}`);
  if (result.hookActivation) {
    const h = result.hookActivation;
    const hookLine = h.degraded
      ? color.red('DEGRADED \u2014 kaizen hooks did NOT load; run unverified (#843)')
      : h.active
        ? color.green('active')
        : color.dim('n/a (provider has no hook runtime)');
    console.log(`  \u2502 ${h.degraded ? color.red('Hooks:') : 'Hooks:'}    ${hookLine}`);
  }
  for (const issue of result.issuesFiled)
    console.log(`  \u2502 ${color.cyan('Issue:')}    ${issue}`);
  if (result.issuesClosed.length > 0)
    console.log(`  \u2502 Closed:   ${result.issuesClosed.join(' ')}`);
  for (const c of result.cases) console.log(`  \u2502 Case:     ${c}`);
  if (result.stopRequested)
    console.log(`  \u2502 ${color.red('STOP:')}     ${result.stopReason}`);
  console.log(`  \u2502 Steps:`);
  for (const step of buildKaizenCycleSteps(result, repo)) {
    console.log(`  \u2502   ${step.phase}: ${step.state}${step.detail ? ` — ${step.detail}` : ''}${step.url ? ` (${step.url})` : ''}`);
  }

  console.log(
    `  \u2514${'─'.repeat(54)}`,
  );
  console.log('');
}

function phaseProvidersForState(state: BatchState): PhaseProviderRecord {
  return phaseProvidersForAgentProvider(state.provider);
}

export function shouldRunCodexProvider(state: Pick<BatchState, 'provider'>): boolean {
  return state.provider === 'codex';
}

// Lifecycle validation — implementation lives in ./auto-dent-lifecycle.ts.
// Re-exported here for back-compat (existing importers and tests reference it
// from './auto-dent-run'). See that module for the enriched gap/phantom/health
// detection (#1103).

// Review wiring — extracted for testability (#896, #914)

export interface ReviewWiringDeps {
  reviewBattery: typeof reviewBattery;
  runFixLoop: typeof runFixLoop;
  listPrDimensions: typeof listPrDimensions;
  formatBatteryReport: typeof formatBatteryReport;
  emit: (event: AutoDentEvent) => void;
  appendLog: (text: string) => void;
  writeAttachment: typeof writeAttachment;
  ghExec: (cmd: string) => string;
}

export interface ReviewWiringInput {
  prs: string[];
  pickedIssue: string;
  repo: string;
  totalBudget: number;
  implementationCost: number;
  runId: string;
  batchId: string;
  runNum: number;
}

export interface ReviewWiringResult {
  reviewVerdict: 'pass' | 'fail' | 'skipped';
  reviewCostUsd: number;
  reviewUrls: string[];
}

export async function runReviewWiring(
  input: ReviewWiringInput,
  deps: ReviewWiringDeps,
): Promise<ReviewWiringResult> {
  let reviewVerdict: 'pass' | 'fail' | 'skipped' = 'skipped';
  let reviewCostUsd = 0;
  const reviewUrls: string[] = [];

  // #898: Use remaining budget after implementation, not total budget
  const reviewBudgetCap = Math.min(
    (input.totalBudget - input.implementationCost) * 0.4,
    2.0,
  );

  if (input.prs.length === 0 || !input.pickedIssue) {
    return { reviewVerdict, reviewCostUsd, reviewUrls };
  }

  try {
    const dimensions = deps.listPrDimensions();
    for (const prUrl of input.prs) {
      // #899: Shared event fields to avoid repetition
      const reviewEventBase = { run_id: input.runId, batch_id: input.batchId, run_num: input.runNum, pr_url: prUrl };

      deps.emit({
        ...reviewEventBase,
        type: 'review.round_start',
        round: 1,
        dimensions: dimensions.map(d => typeof d === 'string' ? d : (d as any).name ?? d),
      } as AutoDentEvent);

      const batteryResult = await deps.reviewBattery({
        dimensions,
        prUrl,
        issueNum: input.pickedIssue,
        repo: input.repo,
        timeoutMs: 120_000,
      });
      reviewCostUsd += batteryResult.costUsd;

      deps.emit({
        ...reviewEventBase,
        type: 'review.round_complete',
        round: 1,
        verdict: batteryResult.verdict,
        missing_count: batteryResult.missingCount,
        partial_count: batteryResult.partialCount,
        cost_usd: batteryResult.costUsd,
        duration_ms: batteryResult.durationMs,
      } as AutoDentEvent);

      if (batteryResult.verdict === 'fail') {
        const report = deps.formatBatteryReport(batteryResult);
        deps.appendLog(`\n--- review-battery ---\n${report}\n`);
        try {
          const prNum = prUrl.match(/\/pull\/(\d+)/)?.[1] ?? '';
          if (prNum && input.repo) {
            const url = deps.writeAttachment({ kind: 'pr', number: prNum, repo: input.repo }, 'review-battery', `## Review Battery: FAIL\n\n${report}`);
            if (url && !reviewUrls.includes(url)) reviewUrls.push(url);
          }
        } catch { /* best effort */ }

        // #897: Count gaps before deciding whether to spawn fix loop
        const gapsCount = batteryResult.dimensions.reduce(
          (acc, d) => acc + d.findings.filter(f => f.status !== 'DONE').length, 0,
        );
        const remainingBudget = reviewBudgetCap - reviewCostUsd;

        if (gapsCount > 0 && remainingBudget > 0.10) {
          deps.emit({
            ...reviewEventBase,
            type: 'review.fix_spawned',
            round: 1,
            gaps_count: gapsCount,
          } as AutoDentEvent);

          try {
            const reviewFixProviders = defaultReviewFixProviders();
            const fixState = await deps.runFixLoop({
              prUrl,
              issueNum: input.pickedIssue,
              repo: input.repo,
              reviewProvider: reviewFixProviders.reviewProvider,
              fixProvider: reviewFixProviders.fixProvider,
              dryRun: false,
              maxRounds: 2, // fix loop runs up to 2 fix+re-review rounds internally
              budgetCap: remainingBudget,
              resume: false, // fresh run within auto-dent; not crash recovery
            });
            const fixCost = fixState.totalCostUsd ?? 0;
            reviewCostUsd += fixCost;

            deps.emit({
              ...reviewEventBase,
              type: 'review.fix_complete',
              round: fixState.currentRound,
              success: fixState.outcome === 'pass',
              cost_usd: fixCost,
            } as AutoDentEvent);

            if (fixState.outcome === 'pass') {
              reviewVerdict = 'pass';
              deps.appendLog(`\nreview_fix=pass rounds=${fixState.currentRound} cost=$${fixCost.toFixed(2)} pr=${prUrl}\n`);
            } else {
              reviewVerdict = 'fail';
              deps.appendLog(`\nreview_fix=fail rounds=${fixState.currentRound} cost=$${fixCost.toFixed(2)} pr=${prUrl}\n`);
              try {
                const url = deps.ghExec(`gh pr comment ${prUrl} --body ${JSON.stringify(
                  `## Review Fix Loop: Exhausted\n\n` +
                  `Ran ${fixState.currentRound} fix round(s) but gaps remain. ` +
                  `Total review+fix cost: $${reviewCostUsd.toFixed(2)}.\n\n` +
                  `@aviadr1 needs human review.`
                )}`);
                if (url && !reviewUrls.includes(url)) reviewUrls.push(url);
              } catch { /* best effort */ }
            }
          } catch (e: any) {
            deps.appendLog(`\nreview_fix_error=${e.message}\n`);
            reviewVerdict = 'fail';
          }
        } else if (gapsCount === 0) {
          // #897: All dimensions timed out / returned no findings
          reviewVerdict = 'fail';
        } else {
          reviewVerdict = 'fail';
        }
      } else if (reviewVerdict !== 'fail') {
        reviewVerdict = 'pass';
        deps.appendLog(`\nreview_battery=pass pr=${prUrl} cost=$${batteryResult.costUsd.toFixed(2)}\n`);
        try {
          const prNum = prUrl.match(/\/pull\/(\d+)/)?.[1] ?? '';
          if (prNum && input.repo) {
            const url = deps.writeAttachment(
              { kind: 'pr', number: prNum, repo: input.repo },
              'review-battery',
              deps.formatBatteryReport(batteryResult),
            );
            if (url && !reviewUrls.includes(url)) reviewUrls.push(url);
          }
        } catch { /* best effort */ }
      }
    }
  } catch {
    // Review battery error — non-fatal
  }

  return { reviewVerdict, reviewCostUsd, reviewUrls };
}

// Main

const MIN_RUN_SECONDS = 60;

async function main(): Promise<void> {
  const stateFile = process.argv[2];
  if (!stateFile || !existsSync(stateFile)) {
    console.error('Usage: auto-dent-run.ts <state-file>');
    if (stateFile) console.error(`State file not found: ${stateFile}`);
    process.exit(1);
  }

  const repoRoot = getRepoRoot();
  const state = readState(stateFile);
  const logDir = dirname(stateFile);
  const runNum = state.run + 1;
  const runTag = `${state.batch_id}/run-${runNum}`;

  // On first run or resume, reset any 'assigned' items from interrupted runs
  const resetCount = resetAssignedItems(logDir);
  if (resetCount > 0) {
    console.log(`  [plan] reset ${resetCount} interrupted item(s) from 'assigned' to 'pending'`);
  }

  // Close the cross-batch learning loop (#940 Phase 2): read prior batches'
  // GitHub outcomes once per batch and surface steering via the prompt. Fail-open.
  populateCrossBatchSteering(state, stateFile);

  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(2, 14);
  const logFile = `${logDir}/run-${runNum}-${timestamp}.log`;

  console.log(`Tag: ${runTag}`);
  console.log(`Log: ${logFile}`);

  // Structured telemetry (#647) — emitter created early
  const events = new EventEmitter(logDir);

  const runStartEpoch = Math.floor(Date.now() / 1000);
  const runStartDate = new Date();
  const { exitCode, duration, result, mode: runMode, modeReason: runModeReason, promptMeta } = await runClaude(
    state,
    runNum,
    logFile,
    repoRoot,
    stateFile,
  );
  const runId = makeRunId(state.batch_id, runNum);

  // Emit run.start telemetry with correct pre-run timestamp (#656)
  // Uses emitAt() to backdate the envelope timestamp to when the run actually started,
  // and includes start_epoch for explicit duration calculations.
  events.emitAt(runStartDate, {
    type: 'run.start',
    run_id: runId,
    batch_id: state.batch_id,
    run_num: runNum,
    mode: runMode,
    mode_reason: runModeReason,
    prompt_template: promptMeta.template,
    prompt_hash: promptMeta.hash,
    start_epoch: runStartEpoch,
  });

  // Append metadata to log
  appendFileSync(
    logFile,
    [
      '',
      '--- auto-dent metadata ---',
      `batch_id=${state.batch_id}`,
      `run=${runNum}`,
      `exit_code=${exitCode}`,
      `duration_seconds=${duration}`,
      `cost_usd=${result.cost.toFixed(2)}`,
      `prompt_template=${promptMeta.template}`,
      `prompt_hash=${promptMeta.hash}`,
      `prs=${result.prs.join(' ')}`,
      `issues_filed=${result.issuesFiled.join(' ')}`,
      `issues_closed=${result.issuesClosed.join(' ')}`,
      `cases=${result.cases.join(' ')}`,
      `stop_requested=${result.stopRequested}`,
      '',
    ].join('\n'),
  );

  // Emit per-artifact events from stream results (#647)
  let pickedIssue = '';
  {
    // Extract picked issue from log phase markers
    try {
      const logContent = readFileSync(logFile, 'utf8');
      const repo = state.kaizen_repo || state.host_repo || '';
      for (const marker of parsePhaseMarkers(logContent)) {
        if (marker.phase === 'PICK' && marker.fields.issue) {
          pickedIssue = marker.fields.issue;
          const labels = repo ? fetchIssueLabels(marker.fields.issue, repo) : [];
          events.emit({
            type: 'run.issue_picked',
            run_id: runId,
            batch_id: state.batch_id,
            run_num: runNum,
            issue: marker.fields.issue,
            title: marker.fields.title || '',
            labels,
          });
        }
      }
    } catch { /* best effort */ }
    for (const prUrl of result.prs) {
      events.emit({
        type: 'run.pr_created',
        run_id: runId,
        batch_id: state.batch_id,
        run_num: runNum,
        pr_url: prUrl,
      });
    }
  }

  // Post-run review battery with fix loop (#891, #914)
  const { reviewVerdict, reviewCostUsd, reviewUrls } = await runReviewWiring(
    {
      prs: result.prs,
      pickedIssue: pickedIssue ?? '',
      repo: state.kaizen_repo || state.host_repo || '',
      totalBudget: parseFloat(state.budget) || 2,
      implementationCost: result.cost ?? 0,
      runId,
      batchId: state.batch_id,
      runNum,
    },
    {
      reviewBattery,
      runFixLoop,
      listPrDimensions,
      formatBatteryReport,
      emit: (event) => events.emit(event),
      appendLog: (text) => appendFileSync(logFile, text),
      writeAttachment,
      ghExec,
    },
  );
  result.reviewVerdict = reviewVerdict;
  result.reviewCostUsd = reviewCostUsd;
  result.reviewUrls = reviewUrls;
  upsertProgressStep(result, {
    phase: 'REVIEW',
    state: state.test_task ? 'not applicable' : reviewVerdict,
    detail: state.test_task ? 'synthetic test task' : reviewUrls.length > 0 ? reviewUrls.join(', ') : (result.prs[0] || ''),
    url: reviewUrls[0] || result.prs[0],
  });
  if (result.finalClaim) {
    result.finalClaimPath = writeFinalClaimArtifact(logDir, runNum, result.finalClaim);
    appendFileSync(logFile, `final_claim_path=${result.finalClaimPath}\n`);
  }
  if (result.finalClaimStatus && result.finalClaimStatus !== 'valid') {
    appendFileSync(logFile, `final_claim_status=${result.finalClaimStatus}: ${(result.finalClaimWarnings || []).join('; ')}\n`);
  }
  // Persist a degraded hook-activation verdict into the per-run log (#843). The
  // controller's stderr banner is not captured here, so without this the only
  // durable per-run record would be the state.json metric; write it next to the
  // run it describes so a `plugins:[]` session is never silent in the logs.
  const hookLogBanner = degradedRunLogBanner(result.hookActivation);
  if (hookLogBanner) {
    appendFileSync(logFile, `\n${hookLogBanner}\n`);
  }

  // Lifecycle validation (#639, #1103) — observability + steering, never a hard
  // block. Beyond ordering, this detects critical gaps (PR without IMPLEMENT,
  // MERGE without PR) and phantom claims (TEST result=pass with count=0) — the
  // "verify outcomes, not commands" category (#943, #950).
  let lifecycleViolationCount = 0;
  let lifecycleHealth: LifecycleHealth = 'clean';
  let lifecycleCriticalCount = 0;
  let lifecycleSteeringNote: string | null = null;
  let processVerdict: ProcessVerdict = 'fail-open-warning';
  let processIssueCount = 0;
  let processSummary = 'fail-open-warning: process validator did not run';
  try {
    const lifecycle = validateRunLifecycle(logFile);

    // External evidence cross-check (#1138, epic #1134): the markers above are
    // the agent's self-report; here we judge them against the outcomes the
    // harness extracted independently (PRs, cases, filed/closed issues, the
    // review verdict). A run that *claims* PR/MERGE/REFLECT without durable
    // evidence is process-incomplete. Provider-independent — the same evidence
    // is assembled for a Codex run.
    const evidence: LifecycleEvidence = {
      prsCreated: result.prs.length,
      casesCreated: result.cases.length,
      issuesFiledOrClosed: result.issuesFiled.length + result.issuesClosed.length,
      reviewVerdict: state.test_task ? 'pass' : result.reviewVerdict,
    };
    const evidenceCheck = verifyLifecycleEvidence(lifecycle, evidence);
    const phaseSet = new Set(lifecycle.phasesPresent);
    const hasDurableTestMarker = phaseSet.has('TEST') && lifecycle.phantomPhases.every((p) => p.phase !== 'TEST');
    const mergeStatuses = result.prs.map((pr) => checkMergeStatus(pr));
    const mergeReadiness: ProcessEvidence['mergeReadiness'] =
      result.prs.length === 0 ? 'not-applicable'
        : mergeStatuses.some((status) => status === 'unknown') ? 'unknown'
          : mergeStatuses.some((status) => status === 'closed') ? 'not-ready'
            : mergeStatuses.every((status) => status === 'merged' || status === 'auto_queued') ? 'ready'
              : 'unknown';
    const processEvidence: ProcessEvidence = {
      planEvidence: Boolean(state.test_task) || Boolean(promptMeta.claimedPlanIssue),
      implementationEvidence: Boolean(state.test_task) ? result.prs.length > 0 : result.cases.length > 0,
      prEvidence: result.prs.length > 0,
      testEvidence: Boolean(state.test_task) || hasDurableTestMarker,
      reviewEvidence: Boolean(state.test_task) || (result.reviewVerdict != null && result.reviewVerdict !== 'skipped'),
      reflectionEvidence: Boolean(state.test_task) || result.issuesFiled.length + result.issuesClosed.length > 0,
      mergeReadiness,
    };
    const processValidation = validateProcessEvidence(lifecycle, processEvidence);
    if (result.finalClaim) {
      const claimWarnings = compareFinalClaimToEvidence(result.finalClaim, {
        prs: result.prs,
        cases: result.cases,
        testEvidence: processEvidence.testEvidence === true,
        reviewEvidence: processEvidence.reviewEvidence === true,
        reflectionEvidence: processEvidence.reflectionEvidence === true,
      });
      if (claimWarnings.length > 0) {
        result.finalClaimWarnings = [
          ...(result.finalClaimWarnings || []),
          ...claimWarnings,
        ];
      }
    }

    lifecycleViolationCount = lifecycle.violations.length;
    lifecycleHealth = foldEvidenceIntoHealth(lifecycle.health, evidenceCheck);
    lifecycleCriticalCount = lifecycle.criticalGaps.length + lifecycle.phantomPhases.length;
    const summary = summarizeLifecycle(lifecycle);
    processVerdict = processValidation.verdict;
    processIssueCount = processValidation.failedChecks.length + processValidation.warningChecks.length;
    processSummary = summarizeProcessValidation(processValidation);
    const claimEvidenceWarnings = result.finalClaimWarnings || [];
    if (claimEvidenceWarnings.length > 0) {
      appendFileSync(logFile, `final_claim_warnings=${claimEvidenceWarnings.join('; ')}\n`);
      const folded = foldFinalClaimWarningsIntoProcess(
        processVerdict,
        processIssueCount,
        processSummary,
        Boolean(result.finalClaim),
        claimEvidenceWarnings,
      );
      processVerdict = folded.verdict;
      processIssueCount = folded.issueCount;
      processSummary = folded.summary;
    }
    if (processVerdict !== 'pass' && lifecycleHealth !== 'critical') {
      lifecycleHealth = 'degraded';
    }

    // Surface process-completeness for observability/telemetry regardless of health.
    appendFileSync(
      logFile,
      `\nlifecycle_process_complete=${evidenceCheck.processComplete}\n`,
    );
    if (!evidenceCheck.processComplete) {
      const evidenceSummary = summarizeEvidence(evidenceCheck);
      console.log(`  ${color.yellow('[lifecycle]')} ${evidenceSummary}`);
      appendFileSync(logFile, `lifecycle_evidence: ${evidenceSummary}\n`);
      // Steer the next run: the agent's narrative wasn't backed by outcomes.
      lifecycleSteeringNote =
        `Prior run was PROCESS-INCOMPLETE (${evidenceSummary}). ` +
        `Don't emit a lifecycle phase you didn't actually complete — auto-dent verifies claims against real PRs, cases, filed issues, and the review verdict, not against your markers.`;
    }
    appendFileSync(logFile, `process_verdict=${processVerdict}: ${processSummary}\n`);
    if (processVerdict !== 'pass') {
      console.log(`  ${color.yellow('[process]')} ${processSummary}`);
      lifecycleSteeringNote =
        `Prior run had process verdict ${processVerdict} (${processSummary}). ` +
        `Back claims with durable plan, implementation, PR, test, review, reflection, and merge-readiness evidence.`;
    }

    if (lifecycle.health === 'critical') {
      // Claimed-to-ship-without-building, or claimed-green-but-ran-nothing.
      console.log(`  ${color.red('[lifecycle]')} ${summary}`);
      appendFileSync(logFile, `\nlifecycle_health=critical: ${summary}\n`);
      // Steer the next run: warn the agent that this run's narrative didn't hold.
      // A critical marker problem takes precedence over an evidence note.
      lifecycleSteeringNote =
        `Prior run had a CRITICAL lifecycle problem (${summary}). ` +
        `Do not emit PR/MERGE without a real IMPLEMENT, and never emit TEST result=pass with count=0 — run the tests.`;
    } else if (lifecycle.health === 'degraded') {
      console.log(`  ${color.yellow('[lifecycle]')} ${summary}`);
      appendFileSync(logFile, `\nlifecycle_violations=${lifecycle.violations.length}: ${summary}\n`);
    } else {
      console.log(`  ${color.dim('[lifecycle]')} ${summary}`);
    }
    if (lifecycle.phasesMissing.length > 0) {
      console.log(
        `  ${color.dim('[lifecycle]')} missing phases: ${lifecycle.phasesMissing.join(', ')}`,
      );
    }
  } catch {
    // Log file unreadable — classify fail-open so telemetry does not claim pass.
    processVerdict = 'fail-open-warning';
    processIssueCount = 1;
    processSummary = 'fail-open-warning: process validator could not read the run log';
    lifecycleHealth = lifecycleHealth === 'critical' ? 'critical' : 'degraded';
    lifecycleSteeringNote =
      `Prior run had process verdict fail-open-warning (${processSummary}). ` +
      `Ensure the run log is durable so auto-dent can validate process evidence.`;
  }

  for (const pr of result.prs) {
    const status = checkMergeStatus(pr);
    upsertProgressStep(result, {
      phase: 'MERGE',
      state: status,
      detail: pr,
      url: pr,
    });
  }

  printRunSummary(runNum, exitCode, duration, result, state.kaizen_repo || state.host_repo || '');

  // Cost anomaly detection (#585)
  {
    const priorHistory = (readState(stateFile).run_history || []);
    const anomaly = detectCostAnomaly(result.cost, priorHistory);
    if (anomaly && anomaly.severity !== 'normal') {
      const tag = anomaly.severity === 'anomaly' ? 'ANOMALY' : 'WARNING';
      console.log(
        `  ${color.yellow(`[cost-${tag.toLowerCase()}]`)} run #${runNum} cost $${anomaly.run_cost.toFixed(2)} is ${anomaly.cost_vs_avg.toFixed(1)}x the rolling avg ($${anomaly.rolling_avg.toFixed(2)})`,
      );
    }
  }

  // Emit run.complete telemetry event (#647, #657)
  // Uses mode-aware success: explore/reflect runs that file issues count as success,
  // not just runs that produce PRs.
  {
    const runMetricsForOutcome = buildRunMetrics({
      runNum,
      runStartEpoch,
      duration,
      exitCode,
      runMode,
      result,
    });
    // Bind the run-success stamp to the verdicts this run already recorded
    // (#1224, meta #1227): a review FAIL / process-incomplete / critical
    // lifecycle gap must never roll up to `success` — red runs cannot read as
    // green in the batch summary.
    const outcome = deriveRunOutcome({
      stopRequested: result.stopRequested,
      exitCode,
      artifactCount: modeSuccess(runMode, runMetricsForOutcome),
      reviewVerdict,
      processVerdict,
      lifecycleHealth,
    });
    events.emit({
      type: 'run.complete',
      run_id: runId,
      batch_id: state.batch_id,
      run_num: runNum,
      duration_ms: duration * 1000,
      exit_code: exitCode,
      cost_usd: result.cost,
      tool_calls: result.toolCalls,
      prs_created: result.prs.length,
      issues_filed: result.issuesFiled.length,
      issues_closed: result.issuesClosed.length,
      stop_requested: result.stopRequested,
      failure_class: result.failureClass,
      lifecycle_violations: lifecycleViolationCount,
      lifecycle_health: lifecycleHealth,
      lifecycle_critical: lifecycleCriticalCount,
      process_verdict: processVerdict,
      process_issue_count: processIssueCount,
      process_summary: processSummary,
      review_verdict: reviewVerdict,
      review_cost_usd: reviewCostUsd,
      phase_providers: phaseProvidersForState(state),
      outcome,
      mode: runMode,
    });
  }

  // Write run artifact manifest and bundle (#916)
  {
    const manifest = buildRunManifest(logDir, state.batch_id, runNum);
    const manifestPath = writeRunManifest(logDir, manifest);
    console.log(`  [artifacts] ${formatManifestSummary(manifest)}`);
    console.log(`  [artifacts] manifest: ${manifestPath}`);
    try {
      const archivePath = bundleArtifacts(logDir, manifest);
      console.log(`  [artifacts] bundle: ${archivePath}`);
    } catch (err) {
      console.warn(`  [artifacts] bundle skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Batch scoreboard (cumulative stats across all runs)
  {
    const previewState = readState(stateFile);
    // Include this run's PRs for an accurate footer
    for (const pr of result.prs) {
      if (!previewState.prs.includes(pr)) previewState.prs.push(pr);
    }
    previewState.run = runNum;
    if (!previewState.run_history) previewState.run_history = [];
    console.log(formatBatchFooter(previewState));
    console.log('');
  }

  // Mark plan item done/skipped based on run outcome
  if (promptMeta.claimedPlanIssue) {
    const produced = result.prs.length > 0 || result.issuesFiled.length > 0 || result.issuesClosed.length > 0;
    const planStatus = produced ? 'done' : 'skipped';
    markItem(logDir, promptMeta.claimedPlanIssue, planStatus as 'done' | 'skipped');
    console.log(`  [plan] marked ${promptMeta.claimedPlanIssue} as ${planStatus}`);
  }

  // Post-run hygiene
  const progressIssue = ensureBatchProgressIssue(state, stateFile);
  labelArtifacts(result, 'auto-dent');
  const autoMergeDecision = decideAutoMergeSafety({
    prCount: result.prs.length,
    reviewRequired: !state.test_task,
    reviewVerdict,
    processVerdict,
    lifecycleHealth,
    // Bind the hook-activation verdict (#843/#1500) to the merge decision (#1220):
    // a run whose kaizen hooks did not load (degraded), or one where no
    // `system.init` was observed on a hook-expecting provider, is not merge-ready.
    // Default provider to 'claude' (hook-expecting) for legacy state → fail-closed.
    hookActivation: result.hookActivation,
    provider: state.provider ?? 'claude',
    // testHealth (#1481/#1518) is consumed by the shared SSOT and is enforced
    // provider-agnostically at the test runner (run-all-tests.sh owned/unowned
    // classification) and the `known-failures` CI gate. The harness does not run
    // the suite itself, so it has no truthful run-level test signal to pass here
    // yet — left `unknown` (non-blocking) rather than fabricated. Capturing a
    // run-level test-failure signal for the harness is a deferred follow-up,
    // mirroring how #1220 deferred run-success consumption to #1501.
  });
  const autoMergeQueue = queueAutoMerge(result, state.host_repo || state.kaizen_repo, autoMergeDecision);
  if (!autoMergeDecision.allow) {
    appendFileSync(logFile, `auto_merge_blocked=${autoMergeDecision.reasons.join('; ')}\n`);
    if (autoMergeQueue.cancelFailed.length > 0) {
      appendFileSync(logFile, `auto_merge_cancel_failed=${autoMergeQueue.cancelFailed.join(',')}\n`);
    }
  } else if (autoMergeQueue.queueFailed.length > 0) {
    appendFileSync(logFile, `auto_merge_queue_failed=${autoMergeQueue.queueFailed.join(',')}\n`);
  }

  for (const pr of result.prs) {
    const status = checkMergeStatus(pr);
    console.log(`  [merge-tracking] ${pr}: ${status}`);
    if (state.experiment) {
      appendFileSync(logFile, `merge_status=${pr} ${status}\n`);
    }
  }

  // Drive ALL batch PRs (not just this run's) toward a terminal state. This
  // supersedes the old one-shot sweep: it polls each queued PR, re-updating a
  // branch that falls BEHIND *across* attempts (not just once), and classifies
  // any PR that can't merge (blocked / conflicting / failing checks / timed out)
  // with a reason instead of leaving it silently "queued". (Issue #1129, #368)
  //
  // Per-run budget is intentionally short — each subsequent run re-polls the
  // full batch, so PRs continue to be driven across the trampoline without any
  // single run blocking for long. `--auto` stays queued, so GitHub may still
  // merge a "timed_out" PR server-side after the batch ends.
  const cancelFailed = new Set(autoMergeQueue.cancelFailed);
  const unsafeCurrentPRs = autoMergeDecision.allow
    ? new Set<string>()
    : new Set(result.prs.filter((pr) => !cancelFailed.has(pr)));
  const allBatchPRs = [...new Set([...state.prs, ...result.prs])].filter((pr) => !unsafeCurrentPRs.has(pr));
  if (allBatchPRs.length > 0) {
    const driveResults = driveBatchToMerge(allBatchPRs, {
      maxAttempts: 6,
      sleepMs: 10_000,
      // An unsafe PR whose auto-merge cancel FAILED stays in the batch so it
      // remains visible/babysat, but must never be advanced toward merge — else
      // the babysitter would merge the very PR the merge-readiness gate refused
      // (#1220). `cancelFailed` is non-empty only when a block fired, so this is
      // a no-op for healthy runs.
      holdPrs: cancelFailed,
    });
    const stuck = driveResults.filter((r) => r.status === 'stuck');
    for (const r of driveResults) {
      if (r.status === 'merged' || r.status === 'closed') continue;
      console.log(`  [babysit] ${r.pr}: stuck (${r.reason}) after ${r.attempts} poll(s)`);
    }
    const merged = driveResults.filter((r) => r.status === 'merged').length;
    if (merged > 0 || stuck.length > 0) {
      console.log(
        `  [babysit] ${merged} merged, ${stuck.length} stuck of ${driveResults.length} batch PR(s)`,
      );
    }
    // Persist the per-PR drive outcome to the run log UNCONDITIONALLY (not just
    // in experiment mode): the stuck signal must be durable so downstream
    // observability (#842/#940) can consume it from normal headless runs, not
    // only experiments. The run log always exists. (review: improvement-lifecycle)
    for (const r of driveResults) {
      appendFileSync(
        logFile,
        `merge_drive=${r.pr} ${r.status}${r.reason ? ':' + r.reason : ''} attempts=${r.attempts}\n`,
      );
    }
    const representative = driveResults.find((r) => result.prs.includes(r.pr)) || driveResults[0];
    if (representative) {
      upsertProgressStep(result, {
        phase: 'MERGE',
        state: representative.status,
        detail: representative.reason ? `${representative.pr} ${representative.reason}` : representative.pr,
        url: representative.pr,
      });
    }
  }

  // Verify issues claimed by merged PRs are actually closed (#730, Gap 2)
  // Must run before epic sync so force-closed issues are included
  const allBatchPRsForVerify = [...new Set([...state.prs, ...result.prs])];
  if (allBatchPRsForVerify.length > 0) {
    const verifyResults = verifyIssuesClosed(allBatchPRsForVerify, state.kaizen_repo);
    const forceClosed = verifyResults.flatMap((r) => r.forceClosed);
    if (forceClosed.length > 0) {
      console.log(`  [verify-close] force-closed ${forceClosed.length} issue(s): ${forceClosed.join(', ')}`);
      // Add force-closed issues to the result so they're tracked in state
      for (const issue of forceClosed) {
        const num = issue.replace('#', '');
        const url = `https://github.com/${state.kaizen_repo}/issues/${num}`;
        if (!result.issuesClosed.includes(url) && !result.issuesClosed.includes(issue)) {
          result.issuesClosed.push(url);
        }
      }
    }
  }

  // Sync epic checklists for all closed issues in this batch (#730, Gap 1)
  const allClosedNums = [...new Set([
    ...state.issues_closed,
    ...result.issuesClosed,
  ])].map((ref) => {
    const m = ref.match(/(\d+)/);
    return m ? m[1] : '';
  }).filter(Boolean);
  if (allClosedNums.length > 0) {
    const epicResults = syncEpicChecklists(allClosedNums, state.kaizen_repo);
    for (const er of epicResults) {
      console.log(`  [epic-sync] ${er.epic}: ${er.issuesChecked.length} newly checked, ${er.alreadyChecked.length} already checked`);
    }
  }

  updateBatchProgressIssue(
    progressIssue,
    state.kaizen_repo,
    runNum,
    exitCode,
    duration,
    result,
  );

  // Update state
  const freshState = readState(stateFile);
  freshState.run = runNum;

  // Append per-run metrics for batch observability
  const runMetrics = buildRunMetrics({
    runNum,
    runStartEpoch,
    duration,
    exitCode,
    runMode,
    result,
    metadata: {
      prompt_template: promptMeta.template,
      prompt_hash: promptMeta.hash,
      lifecycle_violations: lifecycleViolationCount,
      lifecycle_health: lifecycleHealth,
      process_verdict: processVerdict,
      process_issue_count: processIssueCount,
      process_summary: processSummary,
      review_verdict: reviewVerdict,
      review_cost_usd: reviewCostUsd,
      phase_providers: phaseProvidersForState(state),
    },
  });
  // Classify failure: wall-clock timeout is authoritative (#686), then heuristics.
  // Feed the run log so the log-based branch (hook_rejection, infrastructure,
  // etc.) actually runs — without this argument it was dead code (#1102).
  const runLog = existsSync(logFile) ? readFileSync(logFile, 'utf8') : undefined;
  runMetrics.failure_class = result.timedOut ? 'timeout' : classifyFailure(runMetrics, runLog);
  if (runMetrics.failure_class === 'hook_rejection' && runLog) {
    runMetrics.hook_rejection_reason = firstHookReason(runLog);
  }
  if (!freshState.run_history) freshState.run_history = [];
  freshState.run_history.push(runMetrics);

  for (const pr of result.prs) {
    if (!freshState.prs.includes(pr)) freshState.prs.push(pr);
  }
  for (const issue of result.issuesFiled) {
    if (!freshState.issues_filed.includes(issue))
      freshState.issues_filed.push(issue);
  }
  for (const closed of result.issuesClosed) {
    if (!freshState.issues_closed.includes(closed))
      freshState.issues_closed.push(closed);
  }
  for (const caseName of result.cases) {
    if (!freshState.cases.includes(caseName)) freshState.cases.push(caseName);
  }

  // Store contemplation recommendations in batch state (#631)
  if (result.contemplationRecs && result.contemplationRecs.length > 0) {
    if (!freshState.contemplation_recommendations) freshState.contemplation_recommendations = [];
    const existing = new Set(freshState.contemplation_recommendations);
    const newRecs = result.contemplationRecs.filter(r => !existing.has(r));
    freshState.contemplation_recommendations.push(...newRecs);
    console.log(`  [contemplate] ${newRecs.length} new recommendation(s) stored (${result.contemplationRecs.length - newRecs.length} duplicates skipped)`);
    events.emit({
      type: 'batch.reflect',
      run_id: runId,
      batch_id: state.batch_id,
      run_num: runNum,
      recommendations_count: result.contemplationRecs.length,
    });
  }

  // Store reflection insights in batch state (#699)
  if (result.reflectionInsights && result.reflectionInsights.length > 0) {
    if (!freshState.reflection_insights) freshState.reflection_insights = [];
    const existing = new Set(freshState.reflection_insights);
    const newInsights = result.reflectionInsights.filter(r => !existing.has(r));
    freshState.reflection_insights.push(...newInsights);
    console.log(`  [reflect] ${newInsights.length} new insight(s) stored (${result.reflectionInsights.length - newInsights.length} duplicates skipped)`);
  }

  // Steer the next run on a CRITICAL lifecycle problem (#1103). Observable data
  // must steer future runs (#940) — feed the warning into the next prompt via
  // the same reflection-insight channel, deduped.
  if (lifecycleSteeringNote) {
    if (!freshState.reflection_insights) freshState.reflection_insights = [];
    if (!freshState.reflection_insights.includes(lifecycleSteeringNote)) {
      freshState.reflection_insights.push(lifecycleSteeringNote);
      console.log(`  ${color.red('[lifecycle]')} steering insight added for next run`);
    }
  }

  if (result.prs.length > 0) {
    freshState.last_pr = result.prs[result.prs.length - 1];
  }
  if (result.issuesFiled.length > 0) {
    freshState.last_issue = result.issuesFiled[result.issuesFiled.length - 1];
  } else if (result.issuesClosed.length > 0) {
    freshState.last_issue = result.issuesClosed[result.issuesClosed.length - 1];
  }
  if (result.cases.length > 0) {
    const lastCase = result.cases[result.cases.length - 1];
    freshState.last_case = lastCase;
    freshState.last_branch = `case/${lastCase}`;
    freshState.last_worktree = `.claude/worktrees/${lastCase}`;
  }

  const hasPrs = result.prs.length > 0;
  if (exitCode !== 0 && !hasPrs) {
    freshState.consecutive_failures =
      (freshState.consecutive_failures || 0) + 1;
    console.log(
      `>>> Consecutive failures: ${freshState.consecutive_failures} / ${freshState.max_failures}`,
    );
  } else {
    freshState.consecutive_failures = 0;
    freshState.current_cooldown = freshState.cooldown;
  }

  const hasIssues = result.issuesFiled.length > 0;
  if (duration < MIN_RUN_SECONDS && !hasPrs && !hasIssues) {
    console.log(
      `>>> Fast fail detected (${duration}s < ${MIN_RUN_SECONDS}s threshold, no output)`,
    );
    freshState.current_cooldown = Math.min(
      (freshState.current_cooldown || freshState.cooldown) * 2,
      600,
    );
    console.log(`>>> Escalated cooldown to ${freshState.current_cooldown}s`);
  }

  if (result.stopRequested) {
    freshState.stop_reason = `agent requested stop: ${result.stopReason}`;
    console.log(`>>> Claude requested batch stop: ${result.stopReason}`);
  }

  // #1255: rescue stranded work. If a run worktree has commits ahead of main or
  // dirty files, preserve it — push to an existing PR, or open a clearly-marked
  // DRAFT rescue PR (gates skipped) — so abnormal termination never strands
  // rescueable work the way it forced the #1252–#1260 manual rescues. Scoped to
  // THIS run's own case worktrees; best-effort and fully guarded so a rescue
  // failure can never hide or block the original run outcome.
  try {
    // #1270: union the marker-reported cases with any on-disk case worktree
    // stamped with THIS run's tag, so work stranded *before* the IMPLEMENT
    // marker (crash/SIGKILL) is still rescued. The runtag scan is run-scoped and
    // concurrency-safe — a sibling run's worktrees carry a different tag.
    const targets = collectRunWorktrees(repoRoot, result.cases, {
      runTag,
      git: createDefaultGitExec(),
    });
    if (targets.length > 0) {
      const { reason: failureReason, abnormal } = classifyRunExit({
        exitCode,
        timedOut: Boolean(result.timedOut),
        stopRequested: Boolean(result.stopRequested),
      });
      const outcomes = rescueRun(
        targets,
        {
          repo: state.host_repo || state.kaizen_repo,
          runTag,
          runId,
          failureReason,
          // #1289: bind the exit classification to the rescue gate so a clean-exit
          // worktree with commits never gets a spurious "NOT VALIDATED" draft PR.
          abnormal,
          pickedIssue,
        },
        defaultRescueDeps((m) => console.log(`  [rescue] ${m}`)),
      );
      let rescuedCount = 0;
      for (const o of outcomes) {
        if (o.action === 'none') continue;
        appendFileSync(
          logFile,
          `rescue=${o.branch} action=${o.action} pr=${o.prUrl || ''} pushed=${o.pushed} err=${o.error || ''}\n`,
        );
        if (o.prUrl && o.action === 'create-draft' && !o.error) {
          if (!freshState.rescue_prs) freshState.rescue_prs = [];
          if (!freshState.rescue_prs.includes(o.prUrl)) freshState.rescue_prs.push(o.prUrl);
        }
        if (o.pushed || o.prUrl) rescuedCount++;
      }
      if (rescuedCount > 0) {
        console.log(`  ${color.yellow('[rescue]')} preserved ${rescuedCount} stranded worktree(s) — NOT validated work`);
      }
    }
  } catch (err) {
    // Rescue must never hide the original run failure (#1255).
    console.warn(`  [rescue] best-effort rescue failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  writeState(stateFile, freshState);
  process.exit(exitCode);
}

// Post plan to progress issue subcommand

export function formatPlanAsMarkdown(planPath: string): string {
  if (!existsSync(planPath)) return '';
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const items: Array<{
    issue: string;
    title: string;
    score: number;
    approach: string;
    status: string;
    item_type?: string;
  }> = plan.items || [];
  if (items.length === 0) return '';

  const lines = [
    '### Batch Plan (pre-pass)',
    '',
    '| # | Issue | Title | Score | Type | Status |',
    '|---|-------|-------|-------|------|--------|',
  ];
  items.forEach((item, i) => {
    const type = item.item_type || 'leaf';
    lines.push(
      `| ${i + 1} | ${item.issue} | ${item.title} | ${item.score} | ${type} | ${item.status} |`,
    );
  });

  if (plan.wip_excluded?.length > 0) {
    lines.push('', `_WIP excluded:_ ${plan.wip_excluded.join(', ')}`);
  }
  if (plan.epics_scanned?.length > 0) {
    lines.push(`_Epics scanned:_ ${plan.epics_scanned.join(', ')}`);
  }

  lines.push(
    '',
    `_Generated by planning pre-pass at ${plan.created_at || 'unknown'}. Runs will claim items in order._`,
  );
  return lines.join('\n');
}

function postPlan(): void {
  const stateFile = process.argv[3];
  if (!stateFile || !existsSync(stateFile)) {
    console.error('Usage: auto-dent-run.ts --post-plan <state-file>');
    process.exit(1);
  }
  const state = readState(stateFile);
  const logDir = dirname(stateFile);
  const planPath = resolve(logDir, 'plan.json');

  const progressIssue = ensureBatchProgressIssue(state, stateFile);
  if (!progressIssue) {
    console.log('No progress issue available — skipping plan post.');
    return;
  }

  const markdown = formatPlanAsMarkdown(planPath);
  if (!markdown) {
    console.log('No plan items to post.');
    return;
  }

  const kaizenRepo = state.kaizen_repo;
  if (!kaizenRepo) return;

  ghExec(
    `gh issue comment ${progressIssue} --repo ${kaizenRepo} --body ${JSON.stringify(markdown)}`,
  );
  console.log(`  [plan] Posted plan summary to ${progressIssue}`);
}

// Close batch subcommand

function closeBatch(): void {
  const stateFile = process.argv[3];
  if (!stateFile || !existsSync(stateFile)) {
    console.error('Usage: auto-dent-run.ts --close-batch <state-file>');
    process.exit(1);
  }
  const state = readState(stateFile);
  if (state.progress_issue) {
    // state.json lives inside the batch directory; its parent is the batch dir
    // that holds events.jsonl + the raw artifacts (#696).
    closeBatchProgressIssue(state.progress_issue, state.kaizen_repo, state, dirname(stateFile));
  }
}

// Post-hoc scoring subcommand

function postHocScore(): void {
  const stateFile = process.argv[3];
  if (!stateFile || !existsSync(stateFile)) {
    console.error('Usage: auto-dent-run.ts --post-hoc-score <state-file>');
    process.exit(1);
  }
  const state = readState(stateFile);
  const batchScore = scoreBatch(state.run_history || []);

  if (state.prs.length === 0) {
    console.log('No PRs to score.');
    return;
  }

  console.log(`Checking merge status for ${state.prs.length} PR(s)...`);
  const postHoc = runPostHocScoring(state.prs, batchScore.total_cost_usd);
  batchScore.post_hoc = postHoc;

  console.log('');
  console.log(formatBatchScoreTable(batchScore));
  console.log('');
  for (const pr of postHoc.prs) {
    console.log(`  ${pr.status.padEnd(12)} ${pr.url}`);
  }
  console.log('');
  console.log(formatPostHocLine(postHoc));
}

// Guard: don't run main() when imported for testing
const isDirectRun =
  process.argv[1]?.endsWith('auto-dent-run.ts') ||
  process.argv[1]?.endsWith('auto-dent-run.js');

if (isDirectRun) {
  if (process.argv[2] === '--close-batch') {
    closeBatch();
  } else if (process.argv[2] === '--post-plan') {
    postPlan();
  } else if (process.argv[2] === '--post-hoc-score') {
    postHocScore();
  } else {
    main().catch((err) => {
      console.error('Fatal error:', err);
      process.exit(1);
    });
  }
}
