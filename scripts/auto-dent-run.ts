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
 */

import { spawn, execSync } from 'child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { createInterface } from 'readline';
import { dirname, resolve } from 'path';
import { scoreRunResult, scoreBatch, formatRunScoreLine, formatBatchScoreTable, postHocScoreBatch, formatPostHocLine } from './auto-dent-score.js';

// Types

export interface BatchState {
  batch_id: string;
  batch_start: number;
  batch_end?: number;
  guidance: string;
  max_runs: number;
  cooldown: number;
  budget: string;
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
}

// State I/O

function readState(stateFile: string): BatchState {
  return JSON.parse(readFileSync(stateFile, 'utf8'));
}

function writeState(stateFile: string, state: BatchState): void {
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
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
export function resolvePromptsDir(): string {
  // Use --show-toplevel (worktree-aware) not --git-common-dir (main repo root).
  // Prompts are worktree-local files that may differ per branch.
  try {
    const toplevel = execSync(
      'git rev-parse --show-toplevel',
      { encoding: 'utf8' },
    ).trim();
    const dir = resolve(toplevel, 'prompts');
    if (existsSync(dir)) return dir;
  } catch {
    // Fall through
  }
  return resolve(dirname(new URL(import.meta.url).pathname), '..', 'prompts');
}

/**
 * Build template variables from batch state and run number.
 * These are substituted into prompt templates via {{variable}} syntax.
 */
export function buildTemplateVars(
  state: BatchState,
  runNum: number,
): Record<string, string> {
  const runTag = `${state.batch_id}/run-${runNum}`;
  const hostRepo = state.host_repo || state.kaizen_repo || 'unknown';
  const now = new Date();

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
  };
}

/**
 * Render a Mustache-lite template string.
 *
 * Supports:
 *   {{variable}}          — simple substitution
 *   {{#variable}}...{{/variable}} — conditional section (rendered if variable is non-empty)
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  // Process conditional sections: {{#key}}...{{/key}}
  let result = template.replace(
    /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_match, key: string, body: string) => {
      return vars[key] ? body : '';
    },
  );

  // Substitute variables: {{key}}
  result = result.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    return vars[key] ?? `{{${key}}}`;
  });

  // Clean up blank lines left by removed conditional sections
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}

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

export function buildPrompt(state: BatchState, runNum: number): string {
  const vars = buildTemplateVars(state, runNum);

  // Try to load from external template file
  const templateFile = state.test_task
    ? 'test-task.md'
    : 'deep-dive-default.md';
  const template = loadPromptTemplate(templateFile);

  if (template) {
    return renderTemplate(template, vars);
  }

  // Inline fallback (kept for backward compatibility)
  return buildPromptInline(state, runNum);
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

// Stream-JSON parsing

function formatElapsed(startMs: number): string {
  const elapsed = Math.floor((Date.now() - startMs) / 1000);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
}

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
  const parts = [`[${marker.phase}]`];

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
  if (fields.issues_filed) parts.push(`${fields.issues_filed} issues filed`);
  if (fields.lessons) parts.push(fields.lessons);

  return truncate(parts.join(' '), 120);
}

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

export interface StreamContext {
  resultReceivedAt?: number;
  lastPhase?: string;
  lastActivity?: string;
}

// In-flight progress update interval (10 minutes)
const IN_FLIGHT_UPDATE_INTERVAL_MS = 10 * 60 * 1000;

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
          `  [${elapsed}]  Session ${(msg.session_id || '').slice(0, 8)}... | model: ${msg.model || 'default'}`,
        );
      }
      break;

    case 'assistant':
      if (msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') {
            result.toolCalls++;
            const toolDesc = formatToolUse(block.name, block.input);
            console.log(`  [${elapsed}]  ${toolDesc}`);
            if (ctx) ctx.lastActivity = toolDesc;
          }
          if (block.type === 'text' && block.text) {
            extractArtifacts(block.text, result);
            checkStopSignal(block.text, result);
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
      }
      console.log(
        `  [${elapsed}]  ${msg.subtype === 'success' ? 'done' : `error: ${msg.subtype}`} | $${result.cost?.toFixed(2) || '?'} | ${result.toolCalls} tool calls`,
      );
      break;
  }
}

// Post-run hygiene

function ghExec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 30_000 }).trim();
  } catch (e: any) {
    console.log(
      `  [hygiene] warning: ${cmd.slice(0, 80)}... -> ${e.message?.split('\n')[0] || 'failed'}`,
    );
    return '';
  }
}

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

export function ensureBatchProgressIssue(
  state: BatchState,
  stateFile: string,
): string {
  if (state.progress_issue) return state.progress_issue;

  const kaizenRepo = state.kaizen_repo;
  if (!kaizenRepo) return '';

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

// Default max wall time per run: 45 minutes
const DEFAULT_MAX_RUN_SECONDS = 45 * 60;
// Grace period after result before SIGTERM
const POST_RESULT_GRACE_MS = 60_000;
// Grace period after SIGTERM before SIGKILL
const SIGKILL_GRACE_MS = 10_000;

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

async function runClaude(
  state: BatchState,
  runNum: number,
  logFile: string,
  repoRoot: string,
  stateFile: string,
): Promise<{ exitCode: number; duration: number; result: RunResult }> {
  const result: RunResult = {
    prs: [],
    issuesFiled: [],
    issuesClosed: [],
    cases: [],
    cost: 0,
    toolCalls: 0,
    stopRequested: false,
  };

  const ctx: StreamContext = {};

  const prompt = buildPrompt(state, runNum);
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

  return new Promise((resolve) => {
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

    // Global wall-time timeout (#354)
    const wallTimer = setTimeout(() => {
      if (!processExited) {
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
      resolve({ exitCode: code ?? 1, duration, result });
    });

    child.on('error', (err) => {
      processExited = true;
      cleanup(heartbeatInterval, livenessInterval, inFlightInterval, wallTimer, postResultTimer);
      appendFileSync(logFile, `\nProcess error: ${err.message}\n`);
      const duration = Math.floor((Date.now() - runStart) / 1000);
      resolve({ exitCode: 1, duration, result });
    });
  });
}

// Display

function printRunSummary(
  runNum: number,
  exitCode: number,
  duration: number,
  result: RunResult,
): void {
  const status = exitCode === 0 ? 'success' : `failed (exit ${exitCode})`;

  console.log('');
  console.log(
    `  \u250c\u2500 Run #${runNum} Summary \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`,
  );
  console.log(`  \u2502 Status:   ${status}`);
  console.log(`  \u2502 Duration: ${duration}s`);
  console.log(`  \u2502 Cost:     $${result.cost.toFixed(2)}`);
  console.log(`  \u2502 Tools:    ${result.toolCalls} calls`);

  for (const pr of result.prs) console.log(`  \u2502 PR:       ${pr}`);
  for (const issue of result.issuesFiled)
    console.log(`  \u2502 Issue:    ${issue}`);
  if (result.issuesClosed.length > 0)
    console.log(`  \u2502 Closed:   ${result.issuesClosed.join(' ')}`);
  for (const c of result.cases) console.log(`  \u2502 Case:     ${c}`);
  if (result.stopRequested)
    console.log(`  \u2502 STOP:     ${result.stopReason}`);

  console.log(
    `  \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`,
  );
  console.log('');
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

  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(2, 14);
  const logFile = `${logDir}/run-${runNum}-${timestamp}.log`;

  console.log(`Tag: ${runTag}`);
  console.log(`Log: ${logFile}`);

  const runStartEpoch = Math.floor(Date.now() / 1000);
  const { exitCode, duration, result } = await runClaude(
    state,
    runNum,
    logFile,
    repoRoot,
    stateFile,
  );

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
      `prs=${result.prs.join(' ')}`,
      `issues_filed=${result.issuesFiled.join(' ')}`,
      `issues_closed=${result.issuesClosed.join(' ')}`,
      `cases=${result.cases.join(' ')}`,
      `stop_requested=${result.stopRequested}`,
      '',
    ].join('\n'),
  );

  printRunSummary(runNum, exitCode, duration, result);

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
  };
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
  } else if (process.argv[2] === '--post-hoc-score') {
    postHocScore();
  } else {
    main().catch((err) => {
      console.error('Fatal error:', err);
      process.exit(1);
    });
  }
}
