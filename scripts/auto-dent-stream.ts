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
import { ghExec } from './auto-dent-github.js';

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
  bold: (t: string) => ansi('1', t),
  magenta: (t: string) => ansi('35', t),
};

// Phase status icons with color
const PHASE_STYLE: Record<string, (t: string) => string> = {
  PICK: color.cyan,
  EVALUATE: color.yellow,
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

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
}

// Tool use formatting

export function formatToolUse(
  name: string,
  input: Record<string, any>,
): string {
  switch (name) {
    case 'Read':
      return `Read ${truncate(input?.file_path || '?', 60)}`;
    case 'Edit':
      return `Edit ${truncate(input?.file_path || '?', 60)}`;
    case 'Write':
      return `Write ${truncate(input?.file_path || '?', 60)}`;
    case 'Bash':
      return `$ ${truncate(input?.command || input?.description || '?', 70)}`;
    case 'Grep':
      return `Grep "${truncate(input?.pattern || '?', 30)}" ${input?.path || ''}`;
    case 'Glob':
      return `Glob ${truncate(input?.pattern || '?', 50)}`;
    case 'Skill':
      return `Skill /${input?.skill_name || input?.skill || '?'}`;
    case 'Agent':
      return `Agent: ${truncate(input?.description || '?', 50)}`;
    case 'TaskCreate':
      return `Task+ ${truncate(input?.subject || '?', 50)}`;
    case 'TaskUpdate':
      return `Task~ #${input?.taskId || '?'} -> ${input?.status || '?'}`;
    case 'EnterWorktree':
      return `EnterWorktree ${input?.name || ''}`;
    case 'ExitWorktree':
      return `ExitWorktree`;
    case 'ToolSearch':
      return `ToolSearch`;
    default:
      return name;
  }
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
  const parts = [styleFn(`${icon} [${marker.phase}]`)];

  // Show the most informative fields for each phase
  const { fields } = marker;
  if (fields.issue) parts.push(fields.issue);
  if (fields.title) parts.push(fields.title);
  if (fields.verdict) parts.push(fields.verdict);
  if (fields.reason) parts.push(`(${fields.reason})`);
  if (fields.case) parts.push(`case:${fields.case}`);
  if (fields.branch) parts.push(`branch:${fields.branch}`);
  if (fields.result) parts.push(fields.result);
  if (fields.count) parts.push(`${fields.count} tests`);
  if (fields.url) parts.push(fields.url);
  if (fields.status) parts.push(fields.status);
  if (fields.epic) parts.push(`epic:${fields.epic}`);
  if (fields.issues_created) parts.push(`created:${fields.issues_created}`);
  if (fields.issues_filed) parts.push(`${fields.issues_filed} issues filed`);
  if (fields.lessons) parts.push(fields.lessons);

  return truncate(parts.join(' '), 120);
}

// Artifact extraction from agent output

export function extractArtifacts(text: string, result: RunResult): void {
  for (const m of text.matchAll(
    /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/g,
  )) {
    if (!result.prs.includes(m[0])) result.prs.push(m[0]);
  }
  for (const m of text.matchAll(
    /https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+/g,
  )) {
    if (!result.issuesFiled.includes(m[0])) result.issuesFiled.push(m[0]);
  }
  for (const m of text.matchAll(
    /(?:closes?|closed|fix(?:es|ed)?|resolves?)\s+(#\d+)/gi,
  )) {
    if (!result.issuesClosed.includes(m[1])) result.issuesClosed.push(m[1]);
  }
  for (const m of text.matchAll(/kaizen\s+#(\d+)/gi)) {
    const ref = `#${m[1]}`;
    if (!result.issuesClosed.includes(ref)) result.issuesClosed.push(ref);
  }
  for (const m of text.matchAll(/case[:\s]+(\d{6}-\d{4}-[\w-]+)/g)) {
    if (!result.cases.includes(m[1])) result.cases.push(m[1]);
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
): string {
  const elapsedSec = Math.floor((Date.now() - runStart) / 1000);
  const mins = Math.floor(elapsedSec / 60);
  const secs = elapsedSec % 60;

  const status = ctx.resultReceivedAt
    ? 'waiting for process exit'
    : 'working';

  const lines = [
    `### Run #${runNum} — in progress (${mins}m ${secs}s elapsed)`,
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| **Tool calls** | ${result.toolCalls} |`,
    `| **Cost so far** | $${result.cost.toFixed(2)} |`,
    `| **Status** | ${status} |`,
  ];

  if (ctx.lastActivity) {
    lines.push(`| **Last activity** | ${ctx.lastActivity} |`);
  }
  if (ctx.lastPhase) {
    lines.push(`| **Last phase** | ${ctx.lastPhase} |`);
  }
  if (result.prs.length > 0) {
    lines.push(`| **PRs so far** | ${result.prs.join(', ')} |`);
  }

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

  const comment = buildInFlightComment(runNum, runStart, result, ctx);
  const out = ghExec(
    `gh issue comment ${m[1]} --repo ${kaizenRepo} --body ${JSON.stringify(comment)}`,
  );
  if (out) {
    console.log(`  [in-flight] posted progress update for run #${runNum}`);
    return true;
  }
  return false;
}

// Main stream message processor

export function processStreamMessage(
  msg: Record<string, any>,
  result: RunResult,
  runStart: number,
  ctx?: StreamContext,
): void {
  const elapsed = formatElapsed(runStart);

  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') {
        console.log(
          `  ${color.dim(`[${elapsed}]`)}  ${color.bold('Session')} ${(msg.session_id || '').slice(0, 8)}... | model: ${msg.model || 'default'}`,
        );
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
            extractArtifacts(block.text, result);
            checkStopSignal(block.text, result);
            // Extract contemplation recommendations (#631)
            const recs = extractContemplationRecommendations(block.text);
            if (recs.length > 0) {
              if (!result.contemplationRecs) result.contemplationRecs = [];
              result.contemplationRecs.push(...recs);
            }
            for (const marker of parsePhaseMarkers(block.text)) {
              console.log(`  [${elapsed}]  ${formatPhaseMarker(marker)}`);
              if (ctx) ctx.lastPhase = formatPhaseMarker(marker);
            }
          }
        }
      }
      break;

    case 'result':
      if (ctx) {
        ctx.resultReceivedAt = Date.now();
      }
      if (msg.total_cost_usd) {
        result.cost = msg.total_cost_usd;
      }
      if (msg.result) {
        extractArtifacts(msg.result, result);
        checkStopSignal(msg.result, result);
        const recs = extractContemplationRecommendations(msg.result);
        if (recs.length > 0) {
          if (!result.contemplationRecs) result.contemplationRecs = [];
          result.contemplationRecs.push(...recs);
        }
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
