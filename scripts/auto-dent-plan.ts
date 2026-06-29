#!/usr/bin/env npx tsx
/**
 * auto-dent-plan — Planning pre-pass for auto-dent batches.
 *
 * Runs a lightweight Claude invocation before the batch loop to scan the
 * issue backlog, rank candidates, and produce a plan.json. Subsequent
 * runs read the plan and get assigned specific work items instead of
 * rediscovering the landscape from scratch.
 *
 * Usage: npx tsx scripts/auto-dent-plan.ts <state-file>
 *
 * Reads batch config from state.json, produces plan.json in the same
 * directory. The plan includes ordered work items with scores and
 * one-sentence approaches.
 *
 * See issue #302.
 */

import { spawn } from 'child_process';
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { createInterface } from 'readline';
import { dirname, resolve } from 'path';
import { z } from 'zod';
import {
  type BatchState,
  buildTemplateVars,
  renderTemplate,
  loadPromptTemplate,
  readState,
} from './auto-dent-run.js';
import { buildCodexExecArgs, parseCodexJsonl } from './auto-dent-codex.js';
import type { PhaseProvider } from './auto-dent-provider.js';
import { parseJsonLines } from '../src/lib/json-lines.js';
import { subscriptionAgentProvider } from '../src/provider-contract.js';

export interface PlanItem {
  issue: string;
  title: string;
  score: number;
  approach: string;
  status: 'pending' | 'assigned' | 'done' | 'skipped';
  item_type?: 'leaf' | 'decompose';
  parent_epic?: string;
  /** Theme id this item belongs to (a coordinated cluster of related issues). */
  theme?: string;
}

export interface ClaimNextItemOptions {
  targetIssue?: string;
}

/**
 * A coordinated cluster of related work items — the unit of "bunching" that
 * lets a batch drive 3-5 related PRs to completion before switching topics,
 * instead of hopping across unrelated issues by score (#941).
 */
export interface PlanTheme {
  id: string;
  title: string;
  rationale: string;
  issues: string[];
}

export interface BatchPlan {
  created_at: string;
  guidance: string;
  /** Provider used by the planning pre-pass (#1146). */
  planning_provider?: PhaseProvider;
  items: PlanItem[];
  wip_excluded: string[];
  epics_scanned: string[];
  decomposition_candidates?: string[];
  /** Coordinated clusters of related items (#941). Derived if not LLM-provided. */
  themes?: PlanTheme[];
}

export type PlanningProviderName = 'claude' | 'codex';

export interface PlanningCommand {
  command: string;
  args: string[];
  /** Prompt stdin for providers that read the prompt from stdin. */
  stdin?: string;
}

const PlanningOutputItemSchema = z.object({
  issue: z.string().min(1),
  title: z.string().min(1),
  score: z.number(),
  approach: z.string(),
  status: z.enum(['pending', 'assigned', 'done', 'skipped']),
  item_type: z.enum(['leaf', 'decompose']),
  parent_epic: z.string().nullable(),
  theme: z.string().nullable(),
}).strict();

const PlanningOutputThemeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  rationale: z.string(),
  issues: z.array(z.string()).min(1),
}).strict();

const PlanningOutputSchema = z.object({
  created_at: z.string(),
  guidance: z.string(),
  items: z.array(PlanningOutputItemSchema).min(1),
  themes: z.array(PlanningOutputThemeSchema),
  wip_excluded: z.array(z.string()),
  epics_scanned: z.array(z.string()),
  decomposition_candidates: z.array(z.string()),
}).strict();

const RawPlanningInputSchema = z.object({
  created_at: z.unknown().optional(),
  guidance: z.unknown().optional(),
  planning_provider: z.unknown().optional(),
  items: z.array(z.unknown()),
  themes: z.unknown().optional(),
  wip_excluded: z.unknown().optional(),
  epics_scanned: z.unknown().optional(),
  decomposition_candidates: z.unknown().optional(),
}).passthrough();

const RawPlanItemInputSchema = z.object({
  issue: z.unknown(),
  title: z.unknown(),
  score: z.unknown().optional(),
  approach: z.unknown().optional(),
  item_type: z.unknown().optional(),
  parent_epic: z.unknown().optional(),
  theme: z.unknown().optional(),
}).passthrough();

const RawPlanThemeInputSchema = z.object({
  id: z.unknown(),
  title: z.unknown(),
  rationale: z.unknown().optional(),
  issues: z.array(z.unknown()).min(1),
}).passthrough();

export function validatePlanningOutputContract(raw: unknown): boolean {
  return PlanningOutputSchema.safeParse(raw).success;
}

function getRepoRoot(): string {
  try {
    const { execSync } = require('child_process');
    const gitCommonDir = execSync(
      'git rev-parse --path-format=absolute --git-common-dir',
      { encoding: 'utf8' },
    ).trim();
    return gitCommonDir.replace(/\/\.git$/, '');
  } catch {
    return resolve(dirname(new URL(import.meta.url).pathname), '..');
  }
}

/**
 * Build the planning prompt from the plan-prepass template.
 */
export function buildPlanPrompt(state: BatchState): string {
  const vars = buildTemplateVars(state, 0);
  // Add plan-specific vars
  vars.plan_size = String(Math.max(state.max_runs || 10, 5));

  const template = loadPromptTemplate('plan-prepass.md');
  if (template) {
    return renderTemplate(template, vars);
  }

  // Inline fallback
  return `You are a batch planning agent for auto-dent.
Scan open issues in ${state.host_repo || state.kaizen_repo} matching this guidance: ${state.guidance}
Output a JSON plan with ranked work items. Format:
\`\`\`json
{"created_at":"...","guidance":"...","items":[{"issue":"#N","title":"...","score":0,"approach":"...","status":"pending"}],"wip_excluded":[],"epics_scanned":[]}
\`\`\``;
}

export function selectPlanningProvider(state: BatchState): PhaseProvider {
  if (state.provider === 'codex') {
    return subscriptionAgentProvider('codex');
  }
  return subscriptionAgentProvider('claude');
}

function planningProviderName(provider: PhaseProvider): PlanningProviderName {
  return provider.provider === 'codex' ? 'codex' : 'claude';
}

export function buildPlanningCommand(
  provider: PhaseProvider,
  prompt: string,
  state: BatchState,
  repoRoot: string,
  schemaFile?: string,
): PlanningCommand {
  if (planningProviderName(provider) === 'codex') {
    const args = buildCodexExecArgs(repoRoot);
    if (schemaFile) {
      const promptArgIndex = args.lastIndexOf('-');
      args.splice(promptArgIndex >= 0 ? promptArgIndex : args.length, 0, '--output-schema', schemaFile);
    }
    return {
      command: 'codex',
      args,
      stdin: prompt,
    };
  }

  const args = [
    '-p',
    prompt,
    '--dangerously-skip-permissions',
    '--output-format',
    'stream-json',
    '--max-turns',
    '5',
  ];
  // Use a small budget for planning (if batch has a budget)
  if (state.budget) {
    const planBudget = Math.min(parseFloat(state.budget), 1.0).toFixed(2);
    args.push('--max-budget-usd', planBudget);
  }

  return { command: 'claude', args };
}

export function buildPlanningSchemaFile(logDir: string): string {
  const schemaFile = resolve(logDir, 'plan-output.schema.json');
  writeFileSync(schemaFile, JSON.stringify(z.toJSONSchema(PlanningOutputSchema), null, 2) + '\n');
  return schemaFile;
}

export function extractPlanningText(provider: PlanningProviderName, raw: string): string {
  if (provider === 'codex') {
    const parsed = parseCodexJsonl(raw);
    return parsed.finalText || parsed.text;
  }

  let fullText = '';
  for (const msg of parseJsonLines<Record<string, unknown>>(raw)) {
    const message = msg.message;
    if (msg.type === 'assistant' && message && typeof message === 'object') {
      const content = (message as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const record = block as Record<string, unknown>;
          if (record.type === 'text' && typeof record.text === 'string') {
            fullText += record.text;
          }
        }
      }
    }
    if (msg.type === 'result' && msg.result) {
      fullText += '\n' + String(msg.result);
    }
  }
  return fullText;
}

export function withPlanningProvider(plan: BatchPlan, provider: PhaseProvider): BatchPlan {
  return {
    ...plan,
    planning_provider: provider,
  };
}

export function formatPlanningFailure(provider: PhaseProvider, message: string): string {
  return `  [plan:${planningProviderName(provider)}] ${message}`;
}

export function planningRawOutputFile(logDir: string, provider: PlanningProviderName): string {
  return resolve(logDir, provider === 'codex' ? 'plan-codex.jsonl' : 'plan-claude-stream.jsonl');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function parsePlanningJsonLine(rawLine: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawLine);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function commandActivity(command: string): string {
  if (/\bgh\s+issue\s+(list|view|search)\b/.test(command)) return 'reading GitHub issues';
  if (/\bgh\s+pr\s+(list|view)\b/.test(command)) return 'checking GitHub PRs';
  if (/\bgit\s+worktree\b/.test(command) || /\bgit\s+status\b/.test(command)) return 'checking worktrees';
  if (/^(rg|grep|sed|cat|ls|find|jq|head|tail|wc)\b/.test(command.trim())) return 'inspecting files';
  return `running command: ${command.trim().replace(/\s+/g, ' ').slice(0, 80)}`;
}

export function summarizePlanningActivity(provider: PlanningProviderName, line: string): string | null {
  const obj = parsePlanningJsonLine(line);
  if (!obj) return null;

  if (provider === 'codex') {
    const item = obj.item;
    if (item && typeof item === 'object') {
      const itemObj = item as Record<string, unknown>;
      if (itemObj.type === 'command_execution' && typeof itemObj.command === 'string') {
        return commandActivity(itemObj.command);
      }
      if (itemObj.type === 'agent_message') return 'drafting batch plan';
    }
    const type = String(obj.type ?? '');
    if (type === 'thread.started' || type === 'turn.started') return 'provider turn started';
    return null;
  }

  const message = obj.message;
  if (message && typeof message === 'object') {
    const content = (message as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const record = block as Record<string, unknown>;
        if (record.type === 'tool_use' && record.name === 'Bash') {
          const input = record.input;
          if (input && typeof input === 'object' && typeof (input as Record<string, unknown>).command === 'string') {
            return commandActivity((input as Record<string, string>).command);
          }
        }
        if (record.type === 'text') return 'drafting batch plan';
      }
    }
  }
  if (obj.type === 'result') return 'finalizing plan';
  return null;
}

export function formatPlanningProgress(input: {
  provider: PhaseProvider;
  elapsedMs: number;
  stdoutLines: number;
  stdoutBytes: number;
  stderrBytes: number;
  lastActivity?: string;
  rawOutputFile: string;
}): string {
  const elapsed = `${Math.floor(input.elapsedMs / 1000)}s elapsed`;
  const activity = input.lastActivity || 'waiting for provider output';
  return [
    formatPlanningFailure(input.provider, `still planning (${elapsed}; ${activity}; stdout ${input.stdoutLines} lines/${formatBytes(input.stdoutBytes)}; stderr ${formatBytes(input.stderrBytes)}; raw ${input.rawOutputFile})`),
  ].join('');
}

export function clearPlanningTimers(
  timers: {
    timeout: ReturnType<typeof setTimeout>;
    progress: ReturnType<typeof setInterval>;
  },
  deps: {
    clearTimeoutFn?: typeof clearTimeout;
    clearIntervalFn?: typeof clearInterval;
  } = {},
): void {
  (deps.clearTimeoutFn ?? clearTimeout)(timers.timeout);
  (deps.clearIntervalFn ?? clearInterval)(timers.progress);
}

/**
 * Extract a JSON block from Claude's response text.
 * Looks for ```json ... ``` fenced blocks first, then bare JSON.
 */
export function extractPlanJson(text: string): BatchPlan | null {
  // Try fenced code block
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // Fall through
    }
  }

  // Try bare JSON object
  const bare = text.match(/\{[\s\S]*"items"[\s\S]*\}/);
  if (bare) {
    try {
      return JSON.parse(bare[0]);
    } catch {
      // Fall through
    }
  }

  return null;
}

/**
 * Validate and normalize a parsed plan.
 */
export function validatePlan(raw: any): BatchPlan | null {
  const parsed = RawPlanningInputSchema.safeParse(raw);
  if (!parsed.success) return null;
  const rawPlan = parsed.data;

  const items: PlanItem[] = rawPlan.items
    .map((item: any) => RawPlanItemInputSchema.safeParse(item))
    .filter((result: z.ZodSafeParseResult<z.infer<typeof RawPlanItemInputSchema>>) => result.success && Boolean(result.data.issue) && Boolean(result.data.title))
    .map((result: z.ZodSafeParseSuccess<z.infer<typeof RawPlanItemInputSchema>>) => result.data)
    .map((item) => ({
      issue: String(item.issue),
      title: String(item.title),
      score: Number(item.score) || 0,
      approach: String(item.approach || ''),
      status: 'pending' as const,
      ...(item.item_type === 'decompose' ? { item_type: 'decompose' as const, parent_epic: item.parent_epic ? String(item.parent_epic) : undefined } : { item_type: 'leaf' as const }),
      ...(item.theme ? { theme: String(item.theme) } : {}),
    }));

  if (items.length === 0) return null;

  const themes = validateThemes(rawPlan.themes);

  return {
    created_at: rawPlan.created_at || new Date().toISOString(),
    guidance: rawPlan.guidance || '',
    ...(rawPlan.planning_provider ? { planning_provider: rawPlan.planning_provider as PhaseProvider } : {}),
    items,
    wip_excluded: Array.isArray(rawPlan.wip_excluded) ? rawPlan.wip_excluded : [],
    epics_scanned: Array.isArray(rawPlan.epics_scanned) ? rawPlan.epics_scanned : [],
    decomposition_candidates: Array.isArray(rawPlan.decomposition_candidates) ? rawPlan.decomposition_candidates : [],
    ...(themes.length > 0 ? { themes } : {}),
  };
}

/**
 * Validate and normalize an LLM-provided themes array. Drops malformed
 * entries (missing id/title or empty issue list) and de-duplicates issues
 * across themes (first theme to claim an issue wins) so an item is never
 * stamped with two themes — which would make {@link themeProgress} miscount.
 */
export function validateThemes(raw: any): PlanTheme[] {
  if (!Array.isArray(raw)) return [];
  const claimed = new Set<string>();
  const out: PlanTheme[] = [];
  for (const t of raw) {
    const parsed = RawPlanThemeInputSchema.safeParse(t);
    if (!parsed.success || !parsed.data.id || !parsed.data.title) continue;
    const issues = parsed.data.issues
      .map((i: any) => String(i))
      .filter((i: string) => !claimed.has(i));
    if (issues.length === 0) continue;
    for (const i of issues) claimed.add(i);
    out.push({
      id: String(parsed.data.id),
      title: String(parsed.data.title),
      rationale: String(parsed.data.rationale || ''),
      issues,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Thematic clustering (#941) — group related issues into coordinated bundles.
// ---------------------------------------------------------------------------

const TITLE_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'and', 'or', 'for', 'in', 'on', 'with', 'is',
  'are', 'be', 'not', 'no', 'as', 'at', 'by', 'from', 'into', 'via', 'auto',
  'dent', 'kaizen', 'fix', 'add', 'l1', 'l2', 'l3', 'meta', 'epic', 'feat',
  'should', 'when', 'this', 'that', 'it', 'its', 'but', 'use', 'using',
]);

/** Tokenize a title into significant lowercase tokens (stopwords removed). */
export function titleTokens(title: string): Set<string> {
  const tokens = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((t) => t.length >= 3 && !TITLE_STOPWORDS.has(t));
  return new Set(tokens);
}

/** True when two items belong in the same coordinated theme. */
function itemsRelated(a: PlanItem, b: PlanItem): boolean {
  if (a.parent_epic && b.parent_epic && a.parent_epic === b.parent_epic) return true;
  const ta = titleTokens(a.title);
  const tb = titleTokens(b.title);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared >= 2;
}

/** Slugify a string into a stable theme id. */
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'theme';
}

/**
 * Derive coordinated themes from a flat item list using connected components
 * over the {@link itemsRelated} predicate (union-find). Components of size >= 2
 * become themes; singletons stay themeless so they are claimed last.
 *
 * Pure and deterministic: input order in → stable theme ids/order out. No
 * Date/random — safe under auto-dent's resume constraints.
 */
export function deriveThemes(items: PlanItem[]): PlanTheme[] {
  const n = items.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (x: number, y: number) => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent[Math.max(rx, ry)] = Math.min(rx, ry);
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (itemsRelated(items[i], items[j])) union(i, j);
    }
  }

  // Group indices by component root, preserving first-seen order.
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }

  const themes: PlanTheme[] = [];
  const usedIds = new Set<string>();
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue; // singletons stay themeless
    const members = idxs.map((i) => items[i]);
    // Theme label: shared parent_epic, else most common significant token.
    const epic = members[0].parent_epic;
    const sameEpic = epic && members.every((m) => m.parent_epic === epic);
    let label: string;
    if (sameEpic) {
      label = `epic ${epic}`;
    } else {
      const freq = new Map<string, number>();
      for (const m of members) for (const t of titleTokens(m.title)) freq.set(t, (freq.get(t) || 0) + 1);
      const best = [...freq.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0];
      label = best ? best[0] : members[0].issue;
    }
    let id = slugify(label);
    let suffix = 2;
    while (usedIds.has(id)) id = `${slugify(label)}-${suffix++}`;
    usedIds.add(id);
    themes.push({
      id,
      title: label,
      rationale: `${members.length} related items grouped by ${sameEpic ? 'shared parent epic' : 'shared topic'}`,
      issues: members.map((m) => m.issue),
    });
  }
  return themes;
}

/**
 * Ensure a plan has themes and that each item is stamped with its theme id.
 * If the plan already carries LLM-provided themes, they are respected and
 * used to stamp items; otherwise themes are derived deterministically.
 * Idempotent.
 */
export function ensureThemes(plan: BatchPlan): BatchPlan {
  const themes = plan.themes && plan.themes.length > 0 ? plan.themes : deriveThemes(plan.items);
  const issueToTheme = new Map<string, string>();
  for (const t of themes) for (const issue of t.issues) issueToTheme.set(issue, t.id);
  for (const item of plan.items) {
    const tid = issueToTheme.get(item.issue);
    if (tid) item.theme = tid;
  }
  plan.themes = themes;
  return plan;
}

/** Per-theme completion counts for observability and steering. */
export interface ThemeProgress {
  id: string;
  title: string;
  total: number;
  done: number;
  pending: number;
  assigned: number;
  skipped: number;
}

export function themeProgress(plan: BatchPlan): ThemeProgress[] {
  const themes = plan.themes || [];
  return themes.map((t) => {
    const members = plan.items.filter((i) => i.theme === t.id);
    const count = (s: PlanItem['status']) => members.filter((m) => m.status === s).length;
    return {
      id: t.id,
      title: t.title,
      total: members.length,
      done: count('done'),
      pending: count('pending'),
      assigned: count('assigned'),
      skipped: count('skipped'),
    };
  });
}

/**
 * Run the planning Claude invocation and return the plan.
 */
async function runPlanning(
  state: BatchState,
  repoRoot: string,
  logDir: string,
): Promise<BatchPlan | null> {
  const prompt = buildPlanPrompt(state);
  const provider = selectPlanningProvider(state);
  const providerName = planningProviderName(provider);
  const schemaFile = providerName === 'codex' ? buildPlanningSchemaFile(logDir) : undefined;
  const command = buildPlanningCommand(provider, prompt, state, repoRoot, schemaFile);
  const rawOutputFile = planningRawOutputFile(logDir, providerName);
  let rawOutput = '';
  let stdoutLines = 0;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let lastActivity: string | undefined;
  let lastPrintedActivity: string | undefined;

  return new Promise((resolve) => {
    writeFileSync(rawOutputFile, '');
    console.log(formatPlanningFailure(provider, `raw provider output: ${rawOutputFile}`));
    const startedAt = Date.now();
    const child = spawn(command.command, command.args, {
      cwd: repoRoot,
      stdio: [command.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    if (command.stdin) child.stdin?.end(command.stdin);

    // 5-minute timeout for planning
    const timer = setTimeout(() => {
      console.log(formatPlanningFailure(provider, 'planning timed out after 5 minutes'));
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000);
    }, 5 * 60 * 1000);
    const progressTimer = setInterval(() => {
      console.log(formatPlanningProgress({
        provider,
        elapsedMs: Date.now() - startedAt,
        stdoutLines,
        stdoutBytes,
        stderrBytes,
        lastActivity,
        rawOutputFile,
      }));
    }, 15_000);

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      rawOutput += line + '\n';
      appendFileSync(rawOutputFile, line + '\n');
      stdoutLines++;
      stdoutBytes += Buffer.byteLength(line + '\n');
      const activity = summarizePlanningActivity(providerName, line);
      if (activity) {
        lastActivity = activity;
        if (activity !== lastPrintedActivity) {
          console.log(formatPlanningFailure(provider, activity));
          lastPrintedActivity = activity;
        }
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderrBytes += data.length;
      appendFileSync(rawOutputFile, data.toString());
    });

    child.on('close', () => {
      clearPlanningTimers({ timeout: timer, progress: progressTimer });
      const fullText = extractPlanningText(providerName, rawOutput);
      const parsed = extractPlanJson(fullText);
      if (parsed) {
        const plan = validatePlan(parsed);
        if (plan) {
          resolve(withPlanningProvider(plan, provider));
        } else {
          console.log(formatPlanningFailure(provider, 'plan JSON failed validation'));
          resolve(null);
        }
      } else {
        console.log(formatPlanningFailure(provider, 'could not extract plan JSON from response'));
        resolve(null);
      }
    });

    child.on('error', (err) => {
      clearPlanningTimers({ timeout: timer, progress: progressTimer });
      console.log(formatPlanningFailure(provider, `error: ${err.message}`));
      resolve(null);
    });
  });
}

/**
 * Read plan.json from the batch log directory.
 */
export function readPlan(logDir: string): BatchPlan | null {
  const planFile = resolve(logDir, 'plan.json');
  if (!existsSync(planFile)) return null;
  try {
    return JSON.parse(readFileSync(planFile, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Choose the next pending item from a plan, preferring coordination:
 *
 * - If a theme is already in progress (has an `assigned`/`done`/`skipped`
 *   member) and still has `pending` members, claim the highest-score pending
 *   item from THAT theme — drive the bundle to completion before switching.
 * - Otherwise claim the highest-score pending item overall, which naturally
 *   starts the strongest theme first.
 *
 * When the plan carries no themes, this reduces to the legacy behavior
 * (first pending item in plan/array order) — a strict no-op for theme-less plans.
 */
export function selectNextItem(plan: BatchPlan): PlanItem | null {
  const pending = plan.items.filter((i) => i.status === 'pending');
  if (pending.length === 0) return null;

  const themes = plan.themes || [];
  if (themes.length > 0) {
    const inProgress = new Set(
      plan.items
        .filter((i) => i.theme && i.status !== 'pending')
        .map((i) => i.theme as string),
    );
    if (inProgress.size > 0) {
      const continuable = pending
        .filter((i) => i.theme && inProgress.has(i.theme))
        .sort((a, b) => b.score - a.score);
      if (continuable.length > 0) return continuable[0];
    }
    // No in-progress theme has pending work — start the strongest theme.
    return [...pending].sort((a, b) => b.score - a.score)[0];
  }

  // Theme-less plan: legacy behavior — first pending in existing order.
  return pending[0];
}

function normalizeIssueRef(ref: string): string {
  const match = ref.match(/(?:issues\/|#)?(\d+)\b/);
  return match ? `#${match[1]}` : ref;
}

function syntheticForcedPlanItem(targetIssue: string): PlanItem {
  return {
    issue: targetIssue,
    title: `manifest-forced target ${targetIssue}`,
    score: 10,
    approach: `Work the manifest-forced target ${targetIssue}; this assignment was inserted because a repeated explore candidate manifest selected it.`,
    status: 'assigned',
    item_type: 'leaf',
  };
}

/**
 * Get the next item to work from a plan and mark it 'assigned' in the file.
 */
export function claimNextItem(logDir: string, options: ClaimNextItemOptions = {}): PlanItem | null {
  const plan = readPlan(logDir);
  if (!plan) return null;

  const targetIssue = options.targetIssue ? normalizeIssueRef(options.targetIssue) : undefined;
  const existingTarget = targetIssue
    ? plan.items.find((i) => normalizeIssueRef(i.issue) === targetIssue)
    : undefined;
  const next = existingTarget
    ? existingTarget.status === 'pending' ? existingTarget : null
    : targetIssue ? syntheticForcedPlanItem(targetIssue) : selectNextItem(plan);
  if (!next) return null;

  if (targetIssue && !existingTarget) {
    plan.items.unshift(next);
  }
  next.status = 'assigned';
  const planFile = resolve(logDir, 'plan.json');
  writeFileSync(planFile, JSON.stringify(plan, null, 2) + '\n');
  return next;
}

/**
 * Mark an item as done or skipped in the plan.
 */
export function markItem(
  logDir: string,
  issueRef: string,
  status: 'done' | 'skipped',
): void {
  const plan = readPlan(logDir);
  if (!plan) return;

  const item = plan.items.find((i) => i.issue === issueRef);
  if (item) {
    item.status = status;
    const planFile = resolve(logDir, 'plan.json');
    writeFileSync(planFile, JSON.stringify(plan, null, 2) + '\n');
  }
}

/**
 * Reset any 'assigned' items back to 'pending'.
 * Called on batch start/resume to recover from interrupted runs
 * where items were claimed but never marked done/skipped.
 */
export function resetAssignedItems(logDir: string): number {
  const plan = readPlan(logDir);
  if (!plan) return 0;

  let resetCount = 0;
  for (const item of plan.items) {
    if (item.status === 'assigned') {
      item.status = 'pending';
      resetCount++;
    }
  }

  if (resetCount > 0) {
    const planFile = resolve(logDir, 'plan.json');
    writeFileSync(planFile, JSON.stringify(plan, null, 2) + '\n');
  }

  return resetCount;
}

/**
 * Format a plan summary for display.
 */
export function formatPlanSummary(plan: BatchPlan): string {
  const leafCount = plan.items.filter(i => i.item_type !== 'decompose').length;
  const decompCount = plan.items.filter(i => i.item_type === 'decompose').length;
  const lines = [
    `Plan: ${plan.items.length} items (${leafCount} leaf, ${decompCount} decompose) ranked by score`,
  ];
  for (const item of plan.items.slice(0, 10)) {
    const scoreBar = '#'.repeat(Math.round(item.score));
    const tag = item.item_type === 'decompose' ? ' [DECOMPOSE]' : '';
    lines.push(`  ${item.issue.padEnd(6)} [${scoreBar.padEnd(10)}] ${item.title}${tag}`);
  }
  if (plan.wip_excluded.length > 0) {
    lines.push(`  Excluded (WIP): ${plan.wip_excluded.join(', ')}`);
  }
  if (plan.epics_scanned.length > 0) {
    lines.push(`  Epics scanned: ${plan.epics_scanned.length}`);
  }
  if (plan.decomposition_candidates && plan.decomposition_candidates.length > 0) {
    lines.push(`  Decomposition candidates: ${plan.decomposition_candidates.length}`);
  }
  const progress = themeProgress(plan);
  if (progress.length > 0) {
    lines.push(`  Themes (${progress.length} coordinated bundle${progress.length === 1 ? '' : 's'}):`);
    for (const t of progress) {
      lines.push(`    - ${t.title} [${t.done}/${t.total}] ${t.id}`);
    }
  }
  return lines.join('\n');
}

// Main

async function main(): Promise<void> {
  const stateFile = process.argv[2];
  if (!stateFile || !existsSync(stateFile)) {
    console.error('Usage: auto-dent-plan.ts <state-file>');
    process.exit(1);
  }

  const state = readState(stateFile);
  const logDir = dirname(stateFile);
  const repoRoot = getRepoRoot();

  console.log('>>> Planning pre-pass starting...');
  console.log(`    Guidance: ${state.guidance}`);
  const provider = selectPlanningProvider(state);
  console.log(`    Provider: ${planningProviderName(provider)} (${provider.billing})`);

  const plan = await runPlanning(state, repoRoot, logDir);

  if (!plan) {
    console.log('>>> Planning failed — batch will use discovery mode (no plan).');
    process.exit(0); // Non-fatal: batch continues without a plan
  }

  ensureThemes(plan);
  const planFile = resolve(logDir, 'plan.json');
  writeFileSync(planFile, JSON.stringify(plan, null, 2) + '\n');

  console.log('>>> Plan created:');
  console.log(formatPlanSummary(plan));
  console.log(`>>> Plan file: ${planFile}`);
}

const isDirectRun =
  process.argv[1]?.endsWith('auto-dent-plan.ts') ||
  process.argv[1]?.endsWith('auto-dent-plan.js');

if (isDirectRun) {
  main().catch((err) => {
    console.error('Planning error:', err);
    process.exit(0); // Non-fatal
  });
}
