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

import { spawn, execSync } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, appendFileSync, existsSync, renameSync, copyFileSync } from 'fs';
import { createInterface } from 'readline';
import { dirname, resolve } from 'path';
import { scoreRunResult, scoreBatch, formatRunScoreLine, formatBatchScoreTable, postHocScoreBatch, formatPostHocLine, detectCostAnomaly, classifyFailure, failureClassLabel, formatFailureDistribution } from './auto-dent-score.js';
import { claimNextItem, markItem, resetAssignedItems } from './auto-dent-plan.js';
import {
  reviewBattery,
  formatBatteryReport,
  listDimensions,
  resolvePromptsDir,
  renderTemplate,
} from '../src/review-battery.js';
import { EventEmitter, makeRunId, type AutoDentEvent } from './auto-dent-events.js';

// Re-export from extracted modules for backward compatibility
export {
  ghExec,
  checkMergeStatus,
  sweepBatchPRs,
  labelArtifacts,
  queueAutoMerge,
  extractLinkedIssue,
  isIssueClosed,
  cleanupSupersededPRs,
  fetchIssueLabels,
  syncEpicChecklists,
  verifyIssuesClosed,
  type MergeStatus,
  type SweepAction,
  type SweepResult,
  type CleanupResult,
  type EpicSyncResult,
  type VerifyCloseResult,
} from './auto-dent-github.js';

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

// Import for internal use
import {
  ghExec,
  checkMergeStatus,
  sweepBatchPRs,
  labelArtifacts,
  queueAutoMerge,
  fetchIssueLabels,
  verifyIssuesClosed,
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
  last_heartbeat?: number;
  max_run_seconds?: number;
  run_history?: RunMetrics[];
  /** Recommendations from contemplation runs that feed back into subsequent runs */
  contemplation_recommendations?: string[];
  /** Insights from reflect-mode runs that feed back into subsequent runs (#699) */
  reflection_insights?: string[];
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
  /** Number of lifecycle ordering violations detected post-run */
  lifecycle_violations?: number;
  /** Review battery verdict for PRs created in this run */
  review_verdict?: 'pass' | 'fail' | 'skipped';
  /** Review battery cost (USD) */
  review_cost_usd?: number;
}

export interface RunResult {
  prs: string[];
  issuesFiled: string[];
  issuesClosed: string[];
  cases: string[];
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
}

// State I/O

export function readState(stateFile: string): BatchState {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    // Primary file corrupt/missing — try backup
    const bak = stateFile + '.bak';
    if (existsSync(bak)) {
      console.error(`[state-io] Primary state corrupt, falling back to ${bak}`);
      return JSON.parse(readFileSync(bak, 'utf8'));
    }
    throw new Error(`State file corrupt and no backup available: ${stateFile}`);
  }
}

export function writeState(stateFile: string, state: BatchState): void {
  const tmp = stateFile + '.tmp';
  const content = JSON.stringify(state, null, 2) + '\n';
  // Validate we can round-trip before writing
  JSON.parse(content);
  // Backup current state before overwriting
  if (existsSync(stateFile)) {
    copyFileSync(stateFile, stateFile + '.bak');
  }
  // Atomic write: write to temp, then rename
  writeFileSync(tmp, content);
  renameSync(tmp, stateFile);
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
    const raw = JSON.parse(readFileSync(summaryPath, 'utf8'));
    const insights: Array<{ type: string; message: string }> = raw.insights || [];
    if (insights.length === 0) return { text: '', avoidIssues: raw.avoidIssues || [] };

    const lines = [
      `_Mid-batch reflection (after run ${raw.runCount}, success rate: ${(raw.successRate * 100).toFixed(0)}%):_`,
      '',
    ];
    for (const insight of insights) {
      const icon = insight.type === 'success_pattern' ? '+' :
                   insight.type === 'failure_pattern' ? '!' :
                   insight.type === 'efficiency' ? '$' : '*';
      lines.push(`- **[${icon}]** ${insight.message}`);
    }

    return { text: lines.join('\n'), avoidIssues: raw.avoidIssues || [] };
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
    const entries = JSON.parse(readFileSync(historyPath, 'utf8'));
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
      planAssignment = lines.join('\n');
      console.log(`  [plan] assigned ${planItem.issue}: ${planItem.title}${planItem.item_type === 'decompose' ? ' [DECOMPOSE]' : ''}`);
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
  /** Why this mode was selected (signal name or 'schedule') */
  reason: string;
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

/**
 * Compute adaptive mode weights from run history.
 *
 * For each mode, computes an effectiveness score based on mode-appropriate
 * success metrics (not just PRs). Each mode is measured by its own output:
 *   - exploit → PRs/run, PRs/$
 *   - explore/reflect → issues/run, issues/$
 *   - subtract → (lines_deleted/100 + issues_pruned)/run
 *   - contemplate → fixed baseline
 *
 * Returns weights normalized so they sum to 1.0, or null if insufficient data.
 * Requires at least `minRuns` total runs with mode data to activate.
 */
export function computeAdaptiveWeights(
  history: RunMetrics[],
  minRuns: number = 10,
): Record<string, number> | null {
  // Only runs with mode data
  const withMode = history.filter(r => r.mode);
  if (withMode.length < minRuns) return null;

  // Group by mode
  const byMode = new Map<string, RunMetrics[]>();
  for (const r of withMode) {
    const group = byMode.get(r.mode!) || [];
    group.push(r);
    byMode.set(r.mode!, group);
  }

  // Default schedulable modes (contemplate has its own overlay)
  const schedulableModes = ['exploit', 'explore', 'reflect', 'subtract'];

  // Base weights (matching the fixed schedule proportions)
  const baseWeights: Record<string, number> = {
    exploit: 0.7,
    explore: 0.1,
    reflect: 0.1,
    subtract: 0.1,
  };

  // Compute raw effectiveness scores using mode-appropriate metrics
  const scores: Record<string, number> = {};
  for (const mode of schedulableModes) {
    const runs = byMode.get(mode) || [];
    if (runs.length === 0) {
      // No data for this mode — use base weight as-is
      scores[mode] = baseWeights[mode];
      continue;
    }

    const totalSuccess = runs.reduce((s, r) => s + modeSuccess(mode, r), 0);
    const totalCostVal = runs.reduce((s, r) => s + r.cost_usd, 0);
    const successRate = totalSuccess / runs.length;
    const efficiency = totalCostVal > 0 ? totalSuccess / totalCostVal : 0;

    // Blend success rate and efficiency, then scale by base weight
    // This preserves the general shape (exploit dominant) while rewarding performance
    const rawScore = (successRate * 0.7 + efficiency * 0.3) * baseWeights[mode];
    // Floor at 5% of base to ensure every mode gets some chance
    scores[mode] = Math.max(rawScore, baseWeights[mode] * 0.05);
  }

  // Normalize to sum to 1.0
  const total = Object.values(scores).reduce((s, v) => s + v, 0);
  if (total === 0) return null;

  const weights: Record<string, number> = {};
  for (const mode of schedulableModes) {
    weights[mode] = scores[mode] / total;
  }
  return weights;
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
 *   5. Adaptive selection: weighted by mode performance from run history
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

  // Adaptive selection: use performance data when available
  const adaptiveWeights = computeAdaptiveWeights(state.run_history || []);
  if (adaptiveWeights) {
    const mode = weightedModeSelect(adaptiveWeights, runNum, state.batch_id);
    return { mode, template: MODE_TEMPLATES[mode] || MODE_TEMPLATES.exploit, reason: 'adaptive' };
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
5. Queue auto-merge: \`gh pr merge <url> --repo ${hostRepo} --squash --delete-branch --auto\`

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

After creating a PR, you MUST queue it for auto-merge:
  gh pr merge <url> --repo ${hostRepo} --squash --delete-branch --auto
Do NOT leave PRs open for manual review — this is an unattended batch.
The harness will also attempt auto-merge as a safety net, but do it yourself first.

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
| MERGE | After queuing auto-merge | url=<PR URL>, status=<queued/merged> |
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

// Text utilities

/**
 * Truncate text at a word boundary, max `max` characters.
 * Appends ellipsis if truncated.
 */
export function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const truncated = text.slice(0, max);
  const lastSpace = truncated.lastIndexOf(' ');
  const cut = lastSpace > max * 0.5 ? lastSpace : max;
  return truncated.slice(0, cut).replace(/[,\s]+$/, '') + '...';
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
  const title = `[Auto-Dent] ${truncateAtWord(cleanGuidance, 70)} (${state.batch_id})`;
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
  ];

  if (result.prs.length > 0) {
    lines.push(`| **PRs** | ${result.prs.join(', ')} |`);
  }
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
): void {
  if (!progressIssue || !kaizenRepo) return;
  const m = progressIssue.match(/issues\/(\d+)/);
  if (!m) return;

  const elapsed = Math.floor(Date.now() / 1000) - state.batch_start;
  const hours = Math.floor(elapsed / 3600);
  const mins = Math.floor((elapsed % 3600) / 60);

  const batchScore = scoreBatch(state.run_history || []);

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
    `**Issues closed:** ${state.issues_closed.length > 0 ? state.issues_closed.join(' ') : 'none'}`,
  ].join('\n');

  ghExec(
    `gh issue comment ${m[1]} --repo ${kaizenRepo} --body ${JSON.stringify(summary)}`,
  );
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

  const ctx: StreamContext = {};

  const logDir = dirname(stateFile);
  const modeSelection = selectMode(state, runNum);
  if (modeSelection.mode !== 'exploit' || modeSelection.reason !== 'schedule') {
    console.log(`  [mode] run #${runNum}: ${modeSelection.mode} (${modeSelection.reason}, template: ${modeSelection.template})`);
  }
  const promptMeta = buildPromptWithMetadata(state, runNum, logDir);
  const prompt = promptMeta.prompt;

  // Save rendered prompt for observability (#602)
  const promptFile = `${logDir}/run-${runNum}-prompt.md`;
  writeFileSync(promptFile, prompt + '\n');

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

  return new Promise((resolvePromise) => {
    let processExited = false;

    const child = spawn('claude', args, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
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

      try {
        const msg = JSON.parse(line);
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
      } catch {
        // Non-JSON line
      }
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
      resolvePromise({ exitCode: 1, duration, result, mode: modeSelection.mode, promptMeta });
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

  for (const pr of result.prs) console.log(`  \u2502 ${color.green('PR:')}       ${pr}`);
  for (const issue of result.issuesFiled)
    console.log(`  \u2502 ${color.cyan('Issue:')}    ${issue}`);
  if (result.issuesClosed.length > 0)
    console.log(`  \u2502 Closed:   ${result.issuesClosed.join(' ')}`);
  for (const c of result.cases) console.log(`  \u2502 Case:     ${c}`);
  if (result.stopRequested)
    console.log(`  \u2502 ${color.red('STOP:')}     ${result.stopReason}`);

  console.log(
    `  \u2514${'─'.repeat(54)}`,
  );
  console.log('');
}

// Lifecycle validation

const LIFECYCLE_ORDER = ['PICK', 'EVALUATE', 'IMPLEMENT', 'TEST', 'PR', 'MERGE', 'REFLECT'];
const FLOATING_PHASES = new Set(['DECOMPOSE', 'STOP']);

export interface LifecycleValidation {
  valid: boolean;
  phasesPresent: string[];
  phasesMissing: string[];
  violations: Array<{ phase: string; after: string }>;
}

/**
 * Validate lifecycle phase ordering from a run log file.
 * Reads the log, extracts AUTO_DENT_PHASE markers, and checks ordering.
 * Advisory only — violations are logged but don't block the batch.
 */
export function validateRunLifecycle(logFile: string): LifecycleValidation {
  const logContent = readFileSync(logFile, 'utf8');
  const markers = parsePhaseMarkers(logContent);
  const phasesPresent = markers.map(m => m.phase);
  const orderedPhases = phasesPresent.filter(p => !FLOATING_PHASES.has(p));
  const violations: Array<{ phase: string; after: string }> = [];

  for (let i = 1; i < orderedPhases.length; i++) {
    const prevIdx = LIFECYCLE_ORDER.indexOf(orderedPhases[i - 1]);
    const currIdx = LIFECYCLE_ORDER.indexOf(orderedPhases[i]);
    if (prevIdx === -1 || currIdx === -1) continue;
    if (currIdx < prevIdx) {
      violations.push({ phase: orderedPhases[i], after: orderedPhases[i - 1] });
    }
  }

  const presentSet = new Set(phasesPresent);
  const phasesMissing = LIFECYCLE_ORDER.filter(p => !presentSet.has(p));

  return { valid: violations.length === 0, phasesPresent, phasesMissing, violations };
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

  // Emit run.start telemetry with correct pre-run timestamp (#656)
  // Uses emitAt() to backdate the envelope timestamp to when the run actually started,
  // and includes start_epoch for explicit duration calculations.
  events.emitAt(runStartDate, {
    type: 'run.start',
    run_id: makeRunId(state.batch_id, runNum),
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

  printRunSummary(runNum, exitCode, duration, result);

  // Emit per-artifact events from stream results (#647)
  let pickedIssue = '';
  {
    const runId = makeRunId(state.batch_id, runNum);
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

  // Post-run review battery (#ENG-6638) — advisory, not blocking
  // Runs requirements review on each PR to detect gaps before merge.
  let reviewVerdict: 'pass' | 'fail' | 'skipped' = 'skipped';
  let reviewCostUsd = 0;
  if (result.prs.length > 0 && pickedIssue) {
    const repo = state.kaizen_repo || state.host_repo || '';
    try {
      const dimensions = listDimensions().filter(d => d !== 'plan-coverage'); // plan-coverage is for pre-implementation
      console.log(`  ${color.dim('[review-battery]')} running ${dimensions.join(', ')} review for ${result.prs.length} PR(s)...`);
      for (const prUrl of result.prs) {
        const batteryResult = reviewBattery({
          dimensions,
          prUrl,
          issueNum: pickedIssue,
          repo,
          timeoutMs: 120_000,
        });
        reviewCostUsd += batteryResult.costUsd;
        if (batteryResult.verdict === 'fail') {
          reviewVerdict = 'fail';
          const report = formatBatteryReport(batteryResult);
          console.log(`  ${color.yellow('[review-battery]')} FAIL for ${prUrl}`);
          for (const dim of batteryResult.dimensions) {
            for (const f of dim.findings) {
              if (f.status !== 'DONE') {
                console.log(`    ${f.status}: ${f.requirement} — ${f.detail}`);
              }
            }
          }
          appendFileSync(logFile, `\n--- review-battery ---\n${report}\n`);
          // Post review findings as PR comment (best effort)
          try {
            ghExec(`gh pr comment ${prUrl} --body ${JSON.stringify(`## Review Battery: FAIL\n\n${report}`)}`);
          } catch { /* best effort */ }
        } else if (reviewVerdict !== 'fail') {
          reviewVerdict = 'pass';
          console.log(`  ${color.green('[review-battery]')} PASS for ${prUrl}`);
          appendFileSync(logFile, `\nreview_battery=pass pr=${prUrl} cost=$${batteryResult.costUsd.toFixed(2)}\n`);
        }
      }
    } catch (e: any) {
      console.log(`  ${color.dim('[review-battery]')} error: ${e.message}`);
      appendFileSync(logFile, `\nreview_battery_error=${e.message}\n`);
    }
  }

  // Store review verdict back onto result so scoreRunResult picks it up
  result.reviewVerdict = reviewVerdict;
  result.reviewCostUsd = reviewCostUsd;

  // Lifecycle validation (#639) — advisory, not blocking
  let lifecycleViolationCount = 0;
  try {
    const lifecycle = validateRunLifecycle(logFile);
    lifecycleViolationCount = lifecycle.violations.length;
    if (!lifecycle.valid) {
      const details = lifecycle.violations
        .map(v => `${v.phase} appeared after ${v.after}`)
        .join(', ');
      console.log(
        `  ${color.yellow('[lifecycle]')} ${lifecycle.violations.length} violation(s): ${details}`,
      );
      appendFileSync(logFile, `\nlifecycle_violations=${lifecycle.violations.length}: ${details}\n`);
    } else {
      console.log(
        `  ${color.dim('[lifecycle]')} valid (${lifecycle.phasesPresent.join(' -> ')})`,
      );
    }
    if (lifecycle.phasesMissing.length > 0) {
      console.log(
        `  ${color.dim('[lifecycle]')} missing phases: ${lifecycle.phasesMissing.join(', ')}`,
      );
    }
  } catch {
    // Log file unreadable — skip lifecycle check
  }

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
    const runMetricsForOutcome: RunMetrics = {
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
    };
    const outcome = result.stopRequested ? 'stop' as const
      : (exitCode === 0 && modeSuccess(runMode, runMetricsForOutcome) > 0) ? 'success' as const
      : (exitCode === 0) ? 'empty_success' as const
      : 'failure' as const;
    events.emit({
      type: 'run.complete',
      run_id: makeRunId(state.batch_id, runNum),
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
      review_verdict: reviewVerdict,
      review_cost_usd: reviewCostUsd,
      outcome,
      mode: runMode,
    });
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
  queueAutoMerge(result, state.host_repo || state.kaizen_repo);

  for (const pr of result.prs) {
    const status = checkMergeStatus(pr);
    console.log(`  [merge-tracking] ${pr}: ${status}`);
    if (state.experiment) {
      appendFileSync(logFile, `merge_status=${pr} ${status}\n`);
    }
  }

  // Sweep ALL batch PRs (not just this run's) to update stale branches.
  // When main advances from a merged PR, earlier PRs fall BEHIND and
  // auto-merge stalls. This unblocks them. (Issue #368, H1/H4)
  const allBatchPRs = [...new Set([...state.prs, ...result.prs])];
  if (allBatchPRs.length > 0) {
    const sweepResults = sweepBatchPRs(allBatchPRs);
    const updated = sweepResults.filter((r) => r.action === 'updated');
    if (updated.length > 0) {
      console.log(
        `  [sweep] updated ${updated.length} stale PR branch(es)`,
      );
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
  const runMetrics: RunMetrics = {
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
    prompt_template: promptMeta.template,
    prompt_hash: promptMeta.hash,
    lifecycle_violations: lifecycleViolationCount,
    review_verdict: reviewVerdict,
    review_cost_usd: reviewCostUsd,
  };
  // Classify failure: wall-clock timeout is authoritative (#686), then heuristics
  runMetrics.failure_class = result.timedOut ? 'timeout' : classifyFailure(runMetrics);
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
      run_id: makeRunId(state.batch_id, runNum),
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
    closeBatchProgressIssue(state.progress_issue, state.kaizen_repo, state);
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
