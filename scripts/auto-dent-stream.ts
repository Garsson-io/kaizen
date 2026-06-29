/**
 * auto-dent-stream — Stream processing for auto-dent batch runs.
 *
 * Extracted from auto-dent-run.ts (#600) to reduce cognitive load
 * and enable isolated testing of the stream pipeline.
 *
 * Handles: stream-json message processing, phase marker parsing,
 * artifact extraction, tool use formatting, and in-flight updates.
 */

import type { RunResult } from './auto-dent-run.js';
import { parseFinalRunClaim } from './auto-dent-final-claim.js';
import { ghExec } from './auto-dent-github.js';
import {
  buildKaizenCycleSteps,
  formatIssueForDisplay,
  formatProgressStepsMarkdown,
  upsertProgressStep,
  type RunProgressStep,
} from './auto-dent-progress.js';
import {
  renderPhaseMarkerSummary,
  renderToolUse,
} from './auto-dent-display.js';
import { parseHookOutputs, type HookOutput } from '../src/hooks/lib/gate-signal.js';
import type { Provider } from './auto-dent-provider.js';
import {
  evaluateHookActivation,
  extractInitPlugins,
  formatHookActivationBanner,
  unknownHookActivationVerdict,
  type HookActivationVerdict,
} from './auto-dent-hook-activation.js';

// ANSI color helpers (graceful degradation when NO_COLOR is set or not a TTY)

const colorEnabled = process.stdout.isTTY && !process.env.NO_COLOR;

function ansi(code: string, text: string): string {
  return colorEnabled ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const color = {
  green: (t: string) => ansi('32', t),
  yellow: (t: string) => ansi('33', t),
  red: (t: string) => ansi('31', t),
  dim: (t: string) => ansi('90', t),
  cyan: (t: string) => ansi('36', t),
  blue: (t: string) => ansi('34', t),
  bold: (t: string) => ansi('1', t),
  magenta: (t: string) => ansi('35', t),
};

// Phase status icons with color
const PHASE_STYLE: Record<string, (t: string) => string> = {
  PICK: color.cyan,
  PLAN: color.blue,
  EVALUATE: color.yellow,
  DELEGATE: color.cyan,
  IMPLEMENT: color.magenta,
  TEST: color.green,
  PR: color.green,
  MERGE: color.green,
  DECOMPOSE: color.cyan,
  REFLECT: color.yellow,
  STOP: color.red,
};

// Display helpers

function formatElapsed(startMs: number): string {
  const elapsed = Math.floor((Date.now() - startMs) / 1000);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

export {
  collapseWhitespace,
  prettifyPath,
  relativizeWorktreePath,
  stripCdPrefix,
} from './auto-dent-display.js';

// Tool use formatting

export function formatToolUse(
  name: string,
  input: Record<string, any>,
): string {
  return renderToolUse(name, input);
}

// Structured phase marker parsing
// Agents emit: AUTO_DENT_PHASE: <PHASE> | key=value | key=value ...

export interface PhaseMarker {
  phase: string;
  fields: Record<string, string>;
}

export function parsePhaseMarkers(text: string): PhaseMarker[] {
  const markers: PhaseMarker[] = [];

  for (const match of text.matchAll(
    /^AUTO_DENT_PHASE:\s*(\w+)(?:\s*\|(.+))?$/gm,
  )) {
    const phase = match[1];
    const fields: Record<string, string> = {};

    if (match[2]) {
      for (const pair of match[2].split('|')) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx > 0) {
          fields[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
        }
      }
    }

    markers.push({ phase, fields });
  }

  return markers;
}

export function formatPhaseMarker(marker: PhaseMarker): string {
  const styleFn = PHASE_STYLE[marker.phase] || color.dim;
  const icon = marker.phase === 'STOP' ? '\u25cf' : '\u25c9';
  return renderPhaseMarkerSummary(marker, styleFn(`${icon} [${marker.phase}]`));
}

// Artifact extraction from agent output

function pushUnique<T>(items: T[], item: T): void {
  if (!items.includes(item)) items.push(item);
}

function extractIssueRefs(value: string): string[] {
  const refs: string[] = [];
  for (const m of value.matchAll(/#\d+/g)) {
    pushUnique(refs, m[0]);
  }
  for (const m of value.matchAll(/https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+/g)) {
    pushUnique(refs, m[0]);
  }
  return refs;
}

/**
 * Human label for a pushed-but-PR-less branch. One constant shared by the ledger
 * step detail and the live-console line so the two phrasings can never drift (#1492).
 */
export const BRANCH_PUSH_PENDING = 'branch pushed — PR pending';

/**
 * GitHub's post-`git push` "create a pull request" helper URL — `pull/new/<branch>`
 * or `compare/<branch>?expand=1`. This is NOT a PR: the `pull/\d+` matcher above
 * already excludes it (no digit follows `pull/`), so detecting it only *adds* the
 * missing positive "branch pushed, PR pending" signal. Returns the first match, or
 * null. Single source of truth for the pattern, reused by the ledger and the live
 * console emitter so the two can never disagree (#1492).
 */
export function extractBranchPushUrl(text: string): string | null {
  const m = text.match(
    /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:pull\/new\/[^\s)]+|compare\/[^\s)?]+(?:\?[^\s)]*)?)/,
  );
  return m ? m[0] : null;
}

export function extractArtifacts(text: string, result: RunResult): void {
  for (const output of parseHookOutputs(text)) {
    updateProgressFromHookOutput(output, result);
  }
  for (const marker of parsePhaseMarkers(text)) {
    updateProgressFromMarker(marker, result);
    if (marker.phase === 'PICK' && marker.fields.issue) {
      result.pickedIssue = marker.fields.issue;
      result.pickedIssueTitle = marker.fields.title || result.pickedIssueTitle;
    }
    if (marker.phase === 'PR' && marker.fields.url) {
      pushUnique(result.prs, marker.fields.url);
    }
    if (marker.phase === 'IMPLEMENT' && marker.fields.case) {
      pushUnique(result.cases, marker.fields.case);
    }
    for (const key of ['issues_filed', 'issues_created']) {
      if (!marker.fields[key]) continue;
      for (const ref of extractIssueRefs(marker.fields[key])) {
        pushUnique(result.issuesFiled, ref);
      }
    }
    for (const key of ['issues_closed', 'closed']) {
      if (!marker.fields[key]) continue;
      for (const ref of extractIssueRefs(marker.fields[key])) {
        pushUnique(result.issuesClosed, ref);
      }
    }
  }
  for (const m of text.matchAll(/^\s*(?:\*\*)?PRs created:\s*(?:\*\*)?\s*(https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+)/gmi)) {
    pushPr(result, m[1]);
  }
  // A GitHub branch-push helper URL is NOT a PR (#1492). Surface it as a
  // distinct "branch pushed — PR pending" signal so a pushed branch is not
  // misread as no-progress or conflated with a real PR. Only while no real PR
  // has landed yet; a later `/pull/<N>` replaces this step via pushPr ('replace').
  if (result.prs.length === 0) {
    const pushUrl = extractBranchPushUrl(text);
    if (pushUrl) {
      upsertProgressStep(result, {
        phase: 'PR',
        state: 'branch-pushed',
        detail: BRANCH_PUSH_PENDING,
        url: pushUrl,
      }, 'replace');
    }
  }
  for (const m of text.matchAll(/case[:\s]+(\d{6}-\d{4}-[\w-]+)/g)) {
    pushUnique(result.cases, m[1]);
  }
  // Extract issues pruned (closed as not-planned/wontfix/duplicate)
  for (const _m of text.matchAll(
    /gh\s+issue\s+close\s+.*--reason\s+not-planned/g,
  )) {
    result.issuesPruned++;
  }
  // Extract net lines deleted from git diff --stat summaries
  // Matches patterns like "5 files changed, 10 insertions(+), 50 deletions(-)"
  for (const m of text.matchAll(
    /(\d+)\s+insertion[s]?\(\+\).*?(\d+)\s+deletion[s]?\(-\)/g,
  )) {
    const insertions = parseInt(m[1], 10);
    const deletions = parseInt(m[2], 10);
    const net = deletions - insertions;
    if (net > 0) result.linesDeleted += net;
  }
}

function pushPr(result: RunResult, prUrl: string): void {
  pushUnique(result.prs, prUrl);
  upsertProgressStep(result, {
    phase: 'PR',
    state: 'created',
    detail: prUrl,
    url: prUrl,
  }, 'replace');
}

function updateProgressFromMarker(marker: PhaseMarker, result: RunResult): void {
  const step = progressStepFromMarker(marker);
  if (!step) return;
  upsertProgressStep(result, step);
}

function updateProgressFromHookOutput(output: HookOutput, result: RunResult): void {
  if (output.type !== 'gate-set' && output.type !== 'gate-clear') return;
  if (!output.gate) return;

  if (output.pr) pushPr(result, output.pr);

  const detail = [output.round ? `round ${output.round}:` : '', output.reason]
    .filter(Boolean)
    .join(' ');
  const url = output.pr || result.prs[0];

  switch (output.gate) {
    case 'needs_review':
      upsertProgressStep(result, {
        phase: 'REVIEW',
        state: output.type === 'gate-set' ? 'pending' : 'passed',
        detail,
        url,
      }, 'replace');
      return;
    case 'needs_pr_kaizen':
      upsertProgressStep(result, {
        phase: 'REFLECT',
        state: output.type === 'gate-set' ? 'pending' : 'completed',
        detail: output.reason,
      }, 'replace');
      return;
    case 'needs_post_merge':
      upsertProgressStep(result, {
        phase: 'MERGE',
        state: output.type === 'gate-set' ? 'merged' : 'completed',
        detail: output.reason,
        url,
      }, 'replace');
      return;
  }
}

function progressStepFromMarker(marker: PhaseMarker): RunProgressStep | null {
  const f = marker.fields;
  switch (marker.phase) {
    case 'PLAN':
      // #1502: the store-plan/store-testplan CLI emits this when a plan or test
      // plan is stored. Upgrades the ledger PLAN row from `not observed` →
      // `stored` so an operator can confirm the I3/I8 gate's payload exists
      // without opening the issue.
      return {
        phase: 'PLAN',
        state: 'stored',
        detail: f.kind ? `${f.kind} stored` : 'stored',
        url: f.url,
      };
    case 'PICK':
      return {
        phase: 'PICK',
        state: f.issue ? 'selected' : 'seen',
        detail: [f.issue, f.title].filter(Boolean).join(' — '),
        url: f.issue?.startsWith('http') ? f.issue : undefined,
      };
    case 'EVALUATE':
      return {
        phase: 'EVALUATE',
        state: f.verdict || 'seen',
        detail: f.reason || '',
      };
    case 'DELEGATE':
      return {
        phase: 'DELEGATE',
        state: f.status || f.result || 'seen',
        detail: f.reason || f.evidence || f.detail || '',
      };
    case 'IMPLEMENT':
      return {
        phase: 'IMPLEMENT',
        state: f.case ? 'started' : 'seen',
        detail: [f.case ? `case:${f.case}` : '', f.branch ? `branch:${f.branch}` : ''].filter(Boolean).join(' '),
      };
    case 'TEST':
      return {
        phase: 'TEST',
        state: f.result || 'seen',
        detail: f.count ? `${f.count} tests` : '',
      };
    case 'PR':
      return {
        phase: 'PR',
        state: f.url ? 'created' : 'seen',
        detail: f.url || '',
        url: f.url,
      };
    case 'MERGE':
      return {
        phase: 'MERGE',
        state: f.status || 'seen',
        detail: f.url || '',
        url: f.url,
      };
    case 'REFLECT':
      return {
        phase: 'REFLECT',
        state: f.issues_filed || f.issues_created ? 'filed' : 'seen',
        detail: [f.issues_filed ? `${f.issues_filed} issues filed` : '', f.issues_created ? `created:${f.issues_created}` : '', f.lessons].filter(Boolean).join(' '),
      };
    case 'STOP':
      return {
        phase: 'STOP',
        state: 'requested',
        detail: f.reason || '',
      };
    default:
      return null;
  }
}

/**
 * Extract structured contemplation recommendations from run output.
 *
 * Parses lines matching: CONTEMPLATION_REC: <recommendation text>
 * These are emitted by contemplate-strategy.md runs to feed back
 * strategic insights into subsequent batch runs (#631).
 */
export function extractContemplationRecommendations(text: string): string[] {
  const recs: string[] = [];
  for (const match of text.matchAll(/^CONTEMPLATION_REC:[^\S\n]*(.+)$/gm)) {
    const rec = match[1].trim();
    if (rec) recs.push(rec);
  }
  return recs;
}

/**
 * Extract structured reflection insights from reflect-mode run output.
 *
 * Parses lines matching: REFLECTION_INSIGHT: <insight text>
 * These are emitted by reflect-batch.md runs to feed back
 * analysis insights into subsequent batch runs (#699).
 */
export function extractReflectionInsights(text: string): string[] {
  const insights: string[] = [];
  for (const match of text.matchAll(/^REFLECTION_INSIGHT:[^\S\n]*(.+)$/gm)) {
    const insight = match[1].trim();
    if (insight) insights.push(insight);
  }
  return insights;
}

export function checkStopSignal(text: string, result: RunResult): void {
  // Primary: structured phase marker format (preferred, avoids in-band ambiguity).
  // AUTO_DENT_PHASE: STOP | reason=<text>
  for (const marker of parsePhaseMarkers(text)) {
    if (marker.phase === 'STOP' && marker.fields.reason) {
      result.stopRequested = true;
      result.stopReason = marker.fields.reason;
      return;
    }
  }

  // Legacy: in-band text signal (kept for backward compatibility).
  // Require signal at start of a line to avoid false positives from
  // conversational text that mentions the signal (see batch-260322-2148-5c83).
  const match = text.match(/^AUTO_DENT_STOP:\s*(.+)/m);
  if (match) {
    result.stopRequested = true;
    result.stopReason = match[1].trim();
  }
}

// Stream context for in-flight tracking

export interface StreamContext {
  resultReceivedAt?: number;
  lastPhase?: string;
  lastActivity?: string;
  /** Provider running this session — decides whether hooks are expected (#843). */
  provider?: Provider;
  /** Count of system.init events observed in this run (#1501). */
  initEventsSeen?: number;
  /** Hook-activation verdict computed from the session's `system.init` event (#843). */
  hookActivation?: HookActivationVerdict;
  /**
   * Rendered run-state lines already printed to the live console, for cross-message
   * dedup (#1492). A decision echoed through multiple stream messages — e.g. a
   * marker the agent both narrates and `echo`es to stdout — prints exactly once.
   */
  printedMarkers?: Set<string>;
}

// In-flight progress update interval (10 minutes)
export const IN_FLIGHT_UPDATE_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Build the in-flight progress comment body for the GitHub progress issue.
 * Posted periodically during a run so observers can see batch health.
 */
export function buildInFlightComment(
  runNum: number,
  runStart: number,
  result: RunResult,
  ctx: StreamContext,
  repo = '',
): string {
  const elapsedSec = Math.floor((Date.now() - runStart) / 1000);
  const mins = Math.floor(elapsedSec / 60);
  const secs = elapsedSec % 60;

  const status = ctx.resultReceivedAt
    ? 'waiting for process exit'
    : 'working';
  const synthetic = result.pickedIssue === 'not applicable';

  const lines = [
    `### Run #${runNum} — in progress (${mins}m ${secs}s elapsed)`,
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| **Tool calls** | ${result.toolCalls} |`,
    `| **Cost so far** | $${result.cost.toFixed(2)} |`,
    `| **Status** | ${status} |`,
    `| **Issue worked** | ${formatIssueForDisplay(result.pickedIssue, repo, result.pickedIssueTitle)} |`,
    `| **PR generated** | ${result.prs.length > 0 ? result.prs.join(', ') : 'none yet'} |`,
    `| **Review state** | ${synthetic ? 'not applicable' : result.reviewVerdict ?? (result.prs.length > 0 ? 'pending' : 'not started')} |`,
  ];

  if (ctx.hookActivation?.degraded) {
    lines.push(`| **⚠️ Hooks** | DEGRADED — kaizen hooks did not load; run is unverified (#843) |`);
  }
  if (ctx.lastActivity) {
    lines.push(`| **Last activity** | ${ctx.lastActivity} |`);
  }
  if (ctx.lastPhase) {
    lines.push(`| **Last phase** | ${ctx.lastPhase} |`);
  }
  if (result.prs.length > 0) {
    lines.push(`| **PRs so far** | ${result.prs.join(', ')} |`);
  }
  lines.push(
    '',
    formatProgressStepsMarkdown(result, repo),
  );

  return lines.join('\n');
}

/**
 * Post an in-flight progress comment to the GitHub progress issue.
 * Non-fatal: swallows errors to avoid disrupting the run.
 */
export function postInFlightUpdate(
  progressIssue: string,
  kaizenRepo: string,
  runNum: number,
  runStart: number,
  result: RunResult,
  ctx: StreamContext,
): boolean {
  if (!progressIssue || !kaizenRepo) return false;
  const m = progressIssue.match(/issues\/(\d+)/);
  if (!m) return false;

  const comment = buildInFlightComment(runNum, runStart, result, ctx, kaizenRepo);
  const out = ghExec(
    `gh issue comment ${m[1]} --repo ${kaizenRepo} --body ${JSON.stringify(comment)}`,
  );
  if (out) {
    console.log(`  [in-flight] posted progress update for run #${runNum}`);
    return true;
  }
  return false;
}

// Run-text ingestion — one pipeline for every text source (#1492)

/**
 * Print one derived run-state line to the live console, at most once. Dedup is
 * keyed on the rendered line via `ctx.printedMarkers`, so the same decision
 * echoed through several stream messages prints a single time. Returns whether
 * the line was actually printed. With no `ctx`, prints unconditionally (callers
 * with no cross-message state — old behaviour preserved).
 */
function emitOnce(line: string, elapsed: string, ctx?: StreamContext): boolean {
  if (ctx) {
    ctx.printedMarkers ??= new Set<string>();
    if (ctx.printedMarkers.has(line)) return false;
    ctx.printedMarkers.add(line);
  }
  console.log(`  ${color.dim(`[${elapsed}]`)}  ${line}`);
  return true;
}

/**
 * The single console sink for parsed phase markers. Every text source routes
 * here, so the live console mirrors the artifact ledger instead of only showing
 * markers the agent happened to put in assistant prose (#1492).
 */
export function emitPhaseMarkers(
  text: string,
  elapsed: string,
  ctx?: StreamContext,
): void {
  for (const marker of parsePhaseMarkers(text)) {
    const line = formatPhaseMarker(marker);
    if (emitOnce(line, elapsed, ctx) && ctx) ctx.lastPhase = line;
  }
}

/**
 * One pipeline for every run-text source (assistant text, tool results, final
 * result). Folding the three previously-divergent branches into a single helper
 * is what keeps the artifact ledger and the live console from drifting — the
 * exact gap behind #1492, where a phase marker echoed into a tool result fed the
 * ledger but never reached the console.
 *
 * `control` gates the signals that *change run behaviour* (`checkStopSignal`,
 * contemplation recs, reflection insights). Those are honoured only for
 * agent-authoritative text — assistant text and the final result — never for
 * tool results: source/prompt files contain literal `AUTO_DENT_PHASE: STOP`
 * strings, so a `cat` of one must not be able to halt the batch. Display-only
 * signals (the artifact ledger and console markers) run for every source.
 */
export function ingestRunText(
  text: string,
  result: RunResult,
  elapsed: string,
  ctx?: StreamContext,
  opts: { control?: boolean } = {},
): void {
  extractArtifacts(text, result);
  emitPhaseMarkers(text, elapsed, ctx);
  const pushUrl = extractBranchPushUrl(text);
  if (pushUrl) {
    emitOnce(
      `${color.yellow('◉ [PUSH]')} ${BRANCH_PUSH_PENDING} ${pushUrl}`,
      elapsed,
      ctx,
    );
  }
  if (!opts.control) return;

  checkStopSignal(text, result);
  const recs = extractContemplationRecommendations(text);
  if (recs.length > 0) (result.contemplationRecs ??= []).push(...recs);
  const insights = extractReflectionInsights(text);
  if (insights.length > 0) (result.reflectionInsights ??= []).push(...insights);
}

function streamCostCandidate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function extractStreamCostUsd(msg: Record<string, any>): number | undefined {
  const candidates = [
    msg.total_cost_usd,
    msg.cost_usd,
    msg.usage?.total_cost_usd,
    msg.usage?.cost_usd,
    msg.message?.usage?.total_cost_usd,
    msg.message?.usage?.cost_usd,
    msg.message?.cost_usd,
  ];

  return candidates.map(streamCostCandidate).find((cost) => cost !== undefined);
}

function updateStreamCost(msg: Record<string, any>, result: RunResult, opts: { terminal: boolean }): void {
  const cost = extractStreamCostUsd(msg);
  if (cost === undefined) return;

  if (opts.terminal || cost > result.cost) {
    result.cost = cost;
  }
}

// Main stream message processor

export function processStreamMessage(
  msg: Record<string, any>,
  result: RunResult,
  runStart: number,
  ctx?: StreamContext,
): void {
  const elapsed = formatElapsed(runStart);
  if (msg.type !== 'result') updateStreamCost(msg, result, { terminal: false });

  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') {
        if (ctx) ctx.initEventsSeen = (ctx.initEventsSeen ?? 0) + 1;
        console.log(
          `  ${color.dim(`[${elapsed}]`)}  ${color.bold('Session')} ${(msg.session_id || '').slice(0, 8)}... | model: ${msg.model || 'default'}`,
        );
        // Prove kaizen hooks actually loaded this session (#843). The init event
        // is ground truth for what loaded; a `plugins:[]` Claude run ran with NO
        // kaizen hooks (no review/dirty/stop gate) and must not pass silently.
        // Only evaluated when the run's provider is known (both live spawn paths
        // set ctx.provider). Replay/test callers that pass no ctx opt out, so a
        // replayed codex log is never misclassified as a degraded claude run.
        if (ctx?.provider) {
          const verdict = (ctx.initEventsSeen ?? 0) > 1
            ? unknownHookActivationVerdict(
              ctx.provider,
              `expected exactly one system.init event, saw ${ctx.initEventsSeen}`,
            )
            : evaluateHookActivation({
              provider: ctx.provider,
              plugins: extractInitPlugins(msg),
            });
          ctx.hookActivation = verdict;
          result.hookActivation = verdict;
          const banner = formatHookActivationBanner(verdict);
          if (verdict.degraded) {
            console.error(color.red(banner));
          } else {
            console.log(`  ${color.dim(`[${elapsed}]`)}  ${color.dim(banner)}`);
          }
        }
      }
      break;

    case 'assistant':
      if (msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            result.toolCalls++;
            const toolDesc = formatToolUse(block.name, block.input);
            console.log(`  ${color.dim(`[${elapsed}]`)}  ${toolDesc}`);
            if (ctx) ctx.lastActivity = toolDesc;
          }
          if (block.type === 'text' && block.text) {
            // Assistant prose is agent-authoritative → control signals honoured.
            ingestRunText(block.text, result, elapsed, ctx, { control: true });
          }
        }
      }
      break;

    case 'user':
      if (msg.tool_use_result?.gitOperation?.pr?.action === 'created') {
        const prUrl = msg.tool_use_result.gitOperation.pr.url;
        if (typeof prUrl === 'string' && prUrl) {
          pushPr(result, prUrl);
        }
      }
      if (msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_result' && typeof block.content === 'string') {
            // Tool output is NOT agent-authoritative (a cat'd file may contain a
            // literal STOP marker) → ledger + console only, no control signals.
            ingestRunText(block.content, result, elapsed, ctx);
          }
        }
      }
      break;

    case 'result':
      if (ctx) {
        ctx.resultReceivedAt = Date.now();
      }
      updateStreamCost(msg, result, { terminal: true });
      if (msg.result) {
        // Final result is agent-authoritative → control signals honoured.
        ingestRunText(msg.result, result, elapsed, ctx, { control: true });
        const claimResult = parseFinalRunClaim(msg.result);
        result.finalClaimStatus = claimResult.status;
        result.finalClaim = claimResult.claim;
        result.finalClaimWarnings = claimResult.warnings;
      }
      {
        const statusText = msg.subtype === 'success'
          ? color.green('done')
          : color.red(`error: ${msg.subtype}`);
        console.log(
          `  ${color.dim(`[${elapsed}]`)}  ${statusText} | $${result.cost?.toFixed(2) || '?'} | ${result.toolCalls} tool calls`,
        );
      }
      break;
  }
}

/**
 * Format heartbeat line for periodic progress output during a run.
 */
export function formatHeartbeat(
  runStart: number,
  toolCalls: number,
  ctx: StreamContext,
): string {
  const elapsed = formatElapsed(runStart);
  if (ctx.resultReceivedAt) {
    const ago = Math.floor((Date.now() - ctx.resultReceivedAt) / 1000);
    return `  [${elapsed}]  ... waiting for process exit (result received ${ago}s ago, ${toolCalls} tool calls)`;
  }
  return `  [${elapsed}]  ... working (${toolCalls} tool calls so far)`;
}
