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
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createInterface } from 'readline';
import { dirname, resolve } from 'path';
import {
  type BatchState,
  buildTemplateVars,
  renderTemplate,
  loadPromptTemplate,
} from './auto-dent-run.js';

export interface PlanItem {
  issue: string;
  title: string;
  score: number;
  approach: string;
  status: 'pending' | 'assigned' | 'done' | 'skipped';
}

export interface BatchPlan {
  created_at: string;
  guidance: string;
  items: PlanItem[];
  wip_excluded: string[];
  epics_scanned: string[];
}

function readState(stateFile: string): BatchState {
  return JSON.parse(readFileSync(stateFile, 'utf8'));
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
  if (!raw || !Array.isArray(raw.items)) return null;

  const items: PlanItem[] = raw.items
    .filter((item: any) => item.issue && item.title)
    .map((item: any) => ({
      issue: String(item.issue),
      title: String(item.title),
      score: Number(item.score) || 0,
      approach: String(item.approach || ''),
      status: 'pending' as const,
    }));

  if (items.length === 0) return null;

  return {
    created_at: raw.created_at || new Date().toISOString(),
    guidance: raw.guidance || '',
    items,
    wip_excluded: Array.isArray(raw.wip_excluded) ? raw.wip_excluded : [],
    epics_scanned: Array.isArray(raw.epics_scanned) ? raw.epics_scanned : [],
  };
}

/**
 * Run the planning Claude invocation and return the plan.
 */
async function runPlanning(
  state: BatchState,
  repoRoot: string,
): Promise<BatchPlan | null> {
  const prompt = buildPlanPrompt(state);
  let fullText = '';

  return new Promise((resolve) => {
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

    const child = spawn('claude', args, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // 5-minute timeout for planning
    const timer = setTimeout(() => {
      console.log('  [plan] planning timed out after 5 minutes');
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000);
    }, 5 * 60 * 1000);

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text') {
              fullText += block.text;
            }
          }
        }
        if (msg.type === 'result' && msg.result) {
          fullText += '\n' + msg.result;
        }
      } catch {
        // Non-JSON line
      }
    });

    child.stderr?.on('data', () => {
      // Ignore stderr for planning
    });

    child.on('close', () => {
      clearTimeout(timer);
      const parsed = extractPlanJson(fullText);
      if (parsed) {
        const plan = validatePlan(parsed);
        resolve(plan);
      } else {
        console.log('  [plan] could not extract plan JSON from response');
        resolve(null);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      console.log(`  [plan] error: ${err.message}`);
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
 * Get the next pending item from a plan.
 * Marks it as 'assigned' in the plan file.
 */
export function claimNextItem(logDir: string): PlanItem | null {
  const plan = readPlan(logDir);
  if (!plan) return null;

  const next = plan.items.find((item) => item.status === 'pending');
  if (!next) return null;

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
 * Format a plan summary for display.
 */
export function formatPlanSummary(plan: BatchPlan): string {
  const lines = [
    `Plan: ${plan.items.length} items ranked by score`,
  ];
  for (const item of plan.items.slice(0, 10)) {
    const scoreBar = '#'.repeat(Math.round(item.score));
    lines.push(`  ${item.issue.padEnd(6)} [${scoreBar.padEnd(10)}] ${item.title}`);
  }
  if (plan.wip_excluded.length > 0) {
    lines.push(`  Excluded (WIP): ${plan.wip_excluded.join(', ')}`);
  }
  if (plan.epics_scanned.length > 0) {
    lines.push(`  Epics scanned: ${plan.epics_scanned.length}`);
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

  const plan = await runPlanning(state, repoRoot);

  if (!plan) {
    console.log('>>> Planning failed — batch will use discovery mode (no plan).');
    process.exit(0); // Non-fatal: batch continues without a plan
  }

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
