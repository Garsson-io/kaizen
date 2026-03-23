#!/usr/bin/env npx tsx
/**
 * auto-dent-ctl — Control running auto-dent batches.
 *
 * Subcommands:
 *   status              List active batches with last-worked-on info
 *   halt [batch-id]     Halt a specific batch (or all active batches)
 *   score [batch-id]    Score batches — efficiency, success rate, cost-per-PR
 *   score --post-hoc    Include live merge status checks
 *   cleanup [batch-id]  Close superseded PRs whose issues are already resolved from GitHub
 *
 * Usage:
 *   npx tsx scripts/auto-dent-ctl.ts status
 *   npx tsx scripts/auto-dent-ctl.ts halt
 *   npx tsx scripts/auto-dent-ctl.ts halt batch-260321-0136-a1b2
 */

import { readdirSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import type { BatchState } from './auto-dent-run.js';
import { checkMergeStatus, cleanupSupersededPRs } from './auto-dent-run.js';
import {
  scoreBatch,
  postHocScoreBatch,
  formatBatchScoreTable,
  formatRunScoreLine,
  formatPostHocLine,
} from './auto-dent-score.js';

function getRepoRoot(): string {
  try {
    const gitCommonDir = execSync(
      'git rev-parse --path-format=absolute --git-common-dir',
      { encoding: 'utf8' },
    ).trim();
    return gitCommonDir.replace(/\/\.git$/, '');
  } catch {
    return process.cwd();
  }
}

function getLogsDir(): string {
  return join(getRepoRoot(), 'logs', 'auto-dent');
}

export interface BatchInfo {
  batchId: string;
  dir: string;
  state: BatchState;
  active: boolean;
  halted: boolean;
}

export function discoverBatches(logsDir: string): BatchInfo[] {
  if (!existsSync(logsDir)) return [];

  const batches: BatchInfo[] = [];
  let entries: string[];
  try {
    entries = readdirSync(logsDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const dir = join(logsDir, entry);
    const stateFile = join(dir, 'state.json');
    if (!existsSync(stateFile)) continue;

    try {
      const state: BatchState = JSON.parse(readFileSync(stateFile, 'utf8'));
      const haltFile = join(dir, 'HALT');
      batches.push({
        batchId: state.batch_id || entry,
        dir,
        state,
        active: !state.batch_end && !state.stop_reason,
        halted: existsSync(haltFile),
      });
    } catch {
      // Corrupt state file — skip
    }
  }

  return batches;
}

export function formatBatchStatus(batch: BatchInfo): string {
  const s = batch.state;
  const status = batch.halted
    ? 'HALT REQUESTED'
    : batch.active
      ? 'RUNNING'
      : s.stop_reason || 'STOPPED';

  const elapsed = Math.floor(
    (s.batch_end || Date.now() / 1000) - s.batch_start,
  );
  const hours = Math.floor(elapsed / 3600);
  const mins = Math.floor((elapsed % 3600) / 60);

  const totalCost = (s.run_history || []).reduce(
    (sum: number, r: any) => sum + (r.cost_usd || 0),
    0,
  );

  const lines = [
    `  Batch:     ${batch.batchId}`,
    `  Status:    ${status}`,
    `  Guidance:  ${s.guidance}`,
    `  Runs:      ${s.run}${s.max_runs > 0 ? ` / ${s.max_runs}` : ''}`,
    `  Duration:  ${hours}h ${mins}m`,
    `  Cost:      $${totalCost.toFixed(2)}`,
    `  PRs:       ${s.prs.length > 0 ? s.prs.join(' ') : 'none'}`,
  ];

  if (s.last_issue) lines.push(`  Last issue:    ${s.last_issue}`);
  if (s.last_pr) lines.push(`  Last PR:       ${s.last_pr}`);
  if (s.last_case) lines.push(`  Last case:     ${s.last_case}`);
  if (s.last_branch) lines.push(`  Last branch:   ${s.last_branch}`);
  if (s.last_worktree) lines.push(`  Last worktree: ${s.last_worktree}`);

  if (s.run_history && s.run_history.length > 0) {
    lines.push('  Runs:');
    for (const r of s.run_history) {
      const rm = Math.floor(r.duration_seconds / 60);
      const rs = r.duration_seconds % 60;
      const status = r.exit_code === 0 ? 'ok' : `exit ${r.exit_code}`;
      const prCount = r.prs.length;
      const issueCount =
        r.issues_filed.length + r.issues_closed.length;
      lines.push(
        `    #${r.run}: ${rm}m${rs}s $${r.cost_usd.toFixed(2)} ${r.tool_calls}tc ${status}${prCount > 0 ? ` ${prCount}PR` : ''}${issueCount > 0 ? ` ${issueCount}iss` : ''}${r.stop_requested ? ' STOP' : ''}`,
      );
    }
  }

  return lines.join('\n');
}

export function formatLastState(state: BatchState): string {
  const lines: string[] = [];
  lines.push('╔══════════════════════════════════════════════════════════╗');
  lines.push('║             auto-dent — Last Worked On                  ║');
  lines.push('╠══════════════════════════════════════════════════════════╣');
  lines.push(`║ Batch:       ${state.batch_id}`);
  lines.push(`║ Run:         ${state.run}`);
  if (state.last_issue) lines.push(`║ Last issue:    ${state.last_issue}`);
  if (state.last_pr) lines.push(`║ Last PR:       ${state.last_pr}`);
  if (state.last_case) lines.push(`║ Last case:     ${state.last_case}`);
  if (state.last_branch) lines.push(`║ Last branch:   ${state.last_branch}`);
  if (state.last_worktree)
    lines.push(`║ Last worktree: ${state.last_worktree}`);
  if (!state.last_issue && !state.last_pr && !state.last_case) {
    lines.push('║ (no artifacts tracked yet)');
  }
  lines.push('╚══════════════════════════════════════════════════════════╝');
  return lines.join('\n');
}

export function formatBatchScoreOutput(batch: BatchInfo, postHoc: boolean = false): string {
  const s = batch.state;
  const history = s.run_history || [];

  if (history.length === 0) {
    return `  Batch ${batch.batchId}: no run history to score.`;
  }

  const batchScore = scoreBatch(history);
  const lines: string[] = [
    `  Batch: ${batch.batchId}`,
    '',
    formatBatchScoreTable(batchScore),
    '',
    '  Per-run scores:',
  ];

  for (let i = 0; i < batchScore.runs.length; i++) {
    const runScore = batchScore.runs[i];
    const runNum = history[i].run;
    lines.push(`    #${runNum}: ${formatRunScoreLine(runScore)}`);
  }

  if (postHoc && s.prs.length > 0) {
    lines.push('');
    lines.push('  Post-hoc merge status:');
    const prStatuses = s.prs.map((url) => ({
      url,
      status: checkMergeStatus(url),
    }));
    const postHocResult = postHocScoreBatch(prStatuses, batchScore.total_cost_usd);
    batchScore.post_hoc = postHocResult;

    for (const pr of postHocResult.prs) {
      lines.push(`    ${pr.url} — ${pr.status}`);
    }
    lines.push(`  ${formatPostHocLine(postHocResult)}`);
  }

  return lines.join('\n');
}

export function haltBatch(batchDir: string): void {
  const haltFile = join(batchDir, 'HALT');
  writeFileSync(haltFile, `halted at ${new Date().toISOString()}\n`);
}

function main(): void {
  const args = process.argv.slice(2);
  const subcommand = args[0];

  if (!subcommand || subcommand === '--help') {
    console.log(`auto-dent-ctl — Control running auto-dent batches

Usage:
  auto-dent-ctl.ts status              List batches with last-worked-on info
  auto-dent-ctl.ts halt [batch-id]     Halt specific batch (or all active)
  auto-dent-ctl.ts halt-state <file>   Print last-state from a state.json file
  auto-dent-ctl.ts score [batch-id]    Score batch(es) — efficiency, success rate, cost
  auto-dent-ctl.ts score --post-hoc [batch-id]  Include live PR merge status checks
  auto-dent-ctl.ts cleanup [batch-id]  Close superseded PRs whose issues are already resolved`);
    process.exit(0);
  }

  const logsDir = getLogsDir();

  switch (subcommand) {
    case 'status': {
      const batches = discoverBatches(logsDir);
      if (batches.length === 0) {
        console.log('No auto-dent batches found.');
        process.exit(0);
      }

      const active = batches.filter((b) => b.active);
      const stopped = batches.filter((b) => !b.active);

      if (active.length > 0) {
        console.log(`\n=== Active Batches (${active.length}) ===\n`);
        for (const b of active) {
          console.log(formatBatchStatus(b));
          console.log('');
        }
      }

      if (stopped.length > 0) {
        console.log(`=== Stopped Batches (${stopped.length}) ===\n`);
        for (const b of stopped) {
          console.log(formatBatchStatus(b));
          console.log('');
        }
      }
      break;
    }

    case 'halt': {
      const targetId = args[1];
      const batches = discoverBatches(logsDir);
      const active = batches.filter((b) => b.active && !b.halted);

      if (targetId) {
        const match = active.find((b) => b.batchId === targetId);
        if (!match) {
          console.error(`No active batch found with ID: ${targetId}`);
          const available = active.map((b) => b.batchId);
          if (available.length > 0) {
            console.error(`Active batches: ${available.join(', ')}`);
          }
          process.exit(1);
        }
        haltBatch(match.dir);
        console.log(`Halt requested for: ${match.batchId}`);
        console.log(formatLastState(match.state));
      } else {
        if (active.length === 0) {
          console.log('No active batches to halt.');
          process.exit(0);
        }
        for (const b of active) {
          haltBatch(b.dir);
          console.log(`Halt requested for: ${b.batchId}`);
          console.log(formatLastState(b.state));
          console.log('');
        }
      }
      break;
    }

    case 'score': {
      const postHoc = args.includes('--post-hoc');
      const scoreArgs = args.slice(1).filter((a) => a !== '--post-hoc');
      const targetId = scoreArgs[0];
      const batches = discoverBatches(logsDir);

      if (batches.length === 0) {
        console.log('No auto-dent batches found.');
        process.exit(0);
      }

      const targets = targetId
        ? batches.filter((b) => b.batchId === targetId)
        : batches;

      if (targets.length === 0) {
        console.error(`No batch found with ID: ${targetId}`);
        const available = batches.map((b) => b.batchId);
        console.error(`Available batches: ${available.join(', ')}`);
        process.exit(1);
      }

      for (const batch of targets) {
        console.log(formatBatchScoreOutput(batch, postHoc));
        console.log('');
      }
      break;
    }

    case 'cleanup': {
      const targetId = args[1];
      const batches = discoverBatches(logsDir);

      if (batches.length === 0) {
        console.log('No auto-dent batches found.');
        process.exit(0);
      }

      const targets = targetId
        ? batches.filter((b) => b.batchId === targetId)
        : batches.filter((b) => b.active);

      if (targets.length === 0) {
        if (targetId) {
          console.error(`No batch found with ID: ${targetId}`);
        } else {
          console.log('No active batches to clean up.');
        }
        process.exit(0);
      }

      for (const batch of targets) {
        const s = batch.state;
        const repo = s.kaizen_repo || s.host_repo;
        if (!repo) {
          console.log(`  Batch ${batch.batchId}: no repo configured, skipping.`);
          continue;
        }

        if (s.prs.length === 0) {
          console.log(`  Batch ${batch.batchId}: no PRs to clean up.`);
          continue;
        }

        console.log(`  Batch ${batch.batchId}: checking ${s.prs.length} PRs...`);
        const results = cleanupSupersededPRs(s.prs, repo);

        let closedCount = 0;
        for (const r of results) {
          if (r.action === 'closed') closedCount++;
          if (r.action !== 'still_open' && r.action !== 'already_merged') {
            console.log(`    ${r.pr} — ${r.action}${r.issue ? ` (${r.issue})` : ''}`);
          }
        }

        if (closedCount === 0) {
          console.log(`    No superseded PRs found.`);
        } else {
          console.log(`    Closed ${closedCount} superseded PR(s).`);
        }
      }
      break;
    }

    case 'halt-state': {
      const stateFile = args[1];
      if (!stateFile || !existsSync(stateFile)) {
        console.error('Usage: auto-dent-ctl.ts halt-state <state-file>');
        process.exit(1);
      }
      const state: BatchState = JSON.parse(readFileSync(stateFile, 'utf8'));
      console.log(formatLastState(state));
      break;
    }

    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      process.exit(1);
  }
}

const isDirectRun =
  process.argv[1]?.endsWith('auto-dent-ctl.ts') ||
  process.argv[1]?.endsWith('auto-dent-ctl.js');

if (isDirectRun) {
  main();
}
