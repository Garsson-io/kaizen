#!/usr/bin/env npx tsx
/**
 * auto-dent-analyze — Cold-start and efficiency analysis for auto-dent batches.
 *
 * Parses batch logs and computes:
 *   - Cold-start time: seconds from session init to first Edit/Write tool call
 *   - Phase breakdown: % time in discovery vs coding vs testing vs shipping
 *   - Top repeated tool-call patterns across runs
 *   - Variance: consistency of cold-start across runs
 *
 * Usage:
 *   npx tsx scripts/auto-dent-analyze.ts <batch-dir-or-log-file>
 *   npx tsx scripts/auto-dent-analyze.ts logs/auto-dent/batch-260323-0003-072b
 *
 * See issue #304.
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, basename, resolve } from 'path';
import { execSync } from 'child_process';

// Types

export interface ToolEvent {
  /** Seconds since session start */
  offsetSec: number;
  name: string;
  /** Short summary of the tool call */
  summary: string;
}

export interface PhaseEvent {
  offsetSec: number;
  phase: string;
}

export interface RunAnalysis {
  runFile: string;
  /** Seconds from session init to first Edit/Write tool call (NaN if none) */
  coldStartSec: number;
  /** Total duration from first to last event */
  totalDurationSec: number;
  /** Tool call count */
  toolCalls: number;
  /** Phase durations in seconds (approximate, from phase markers) */
  phaseDurations: Record<string, number>;
  /** Tool category fractions: discovery/coding/testing/shipping/other */
  toolCategoryFractions: Record<string, number>;
  /** Most-used tool call patterns (tool name + abbreviated input) */
  topPatterns: Array<{ pattern: string; count: number }>;
  /** All tool events for further analysis */
  toolEvents: ToolEvent[];
  /** All phase events for further analysis */
  phaseEvents: PhaseEvent[];
}

export interface BatchAnalysis {
  batchDir: string;
  batchId: string;
  runs: RunAnalysis[];
  /** Average cold-start across runs */
  avgColdStartSec: number;
  /** Standard deviation of cold-start */
  stddevColdStartSec: number;
  /** Min/max cold-start */
  minColdStartSec: number;
  maxColdStartSec: number;
  /** Top repeated patterns across ALL runs */
  globalTopPatterns: Array<{ pattern: string; count: number; runCount: number }>;
  /** Phase breakdown across all runs (fraction of total time) */
  globalPhaseFractions: Record<string, number>;
}

// Parsing helpers

const CODING_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const DISCOVERY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Agent', 'ToolSearch']);
const SHIPPING_TOOLS = new Set(['Bash']); // git/gh commands

function truncateInput(name: string, input: Record<string, any>): string {
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
      return basename(input?.file_path || '?');
    case 'Bash': {
      const cmd = input?.command || input?.description || '?';
      return cmd.slice(0, 60);
    }
    case 'Grep':
      return `"${(input?.pattern || '?').slice(0, 30)}"`;
    case 'Glob':
      return (input?.pattern || '?').slice(0, 40);
    case 'Skill':
      return `/${input?.skill_name || input?.skill || '?'}`;
    case 'Agent':
      return (input?.description || '?').slice(0, 40);
    default:
      return '';
  }
}

function categorizeToolPhase(
  name: string,
  input: Record<string, any>,
): 'discovery' | 'coding' | 'testing' | 'shipping' | 'other' {
  if (CODING_TOOLS.has(name)) return 'coding';
  if (DISCOVERY_TOOLS.has(name)) return 'discovery';
  if (name === 'Bash') {
    const cmd = (input?.command || '').toLowerCase();
    if (cmd.includes('test') || cmd.includes('vitest') || cmd.includes('jest'))
      return 'testing';
    if (cmd.includes('git') || cmd.includes('gh '))
      return 'shipping';
    return 'other';
  }
  if (name === 'Skill') return 'other';
  return 'other';
}

/**
 * Parse a single run log file and extract analysis metrics.
 *
 * Timestamps: only `user` messages carry a `timestamp` field in stream-json.
 * We use the first user timestamp as session-start, and propagate the last
 * known timestamp to subsequent assistant messages.
 */
export function analyzeRunLog(logPath: string): RunAnalysis {
  const content = readFileSync(logPath, 'utf8');
  const lines = content.split('\n');

  const toolEvents: ToolEvent[] = [];
  const phaseEvents: PhaseEvent[] = [];
  const toolInputs: Array<{ name: string; input: Record<string, any> }> = [];
  let firstTimestampMs: number | null = null;
  let lastKnownTimestampMs: number | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;

    let msg: Record<string, any>;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    // Track timestamps from any message that has one (primarily `user` messages)
    if (msg.timestamp) {
      const ts = new Date(msg.timestamp).getTime();
      if (!isNaN(ts)) {
        if (firstTimestampMs === null) firstTimestampMs = ts;
        lastKnownTimestampMs = ts;
      }
    }

    // Compute offset from first timestamp
    let offsetSec = 0;
    if (firstTimestampMs !== null && lastKnownTimestampMs !== null) {
      offsetSec = (lastKnownTimestampMs - firstTimestampMs) / 1000;
    }

    // Track tool use
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'tool_use') {
          const name = block.name;
          const input = block.input || {};
          const summary = `${name} ${truncateInput(name, input)}`.trim();
          toolEvents.push({ offsetSec, name, summary });
          toolInputs.push({ name, input });
        }
        if (block.type === 'text' && block.text) {
          // Extract phase markers
          for (const m of block.text.matchAll(
            /^AUTO_DENT_PHASE:\s*(\w+)/gm,
          )) {
            phaseEvents.push({ offsetSec, phase: m[1] });
          }
        }
      }
    }
  }

  // Cold start: time from session init to first Edit/Write
  const firstCodingTool = toolEvents.find((e) => CODING_TOOLS.has(e.name));
  const coldStartSec = firstCodingTool ? firstCodingTool.offsetSec : NaN;

  // Total duration
  const lastEvent = toolEvents[toolEvents.length - 1];
  const totalDurationSec = lastEvent ? lastEvent.offsetSec : 0;

  // Phase durations (approximate: from one phase marker to the next)
  const phaseDurations: Record<string, number> = {};
  for (let i = 0; i < phaseEvents.length; i++) {
    const start = phaseEvents[i].offsetSec;
    const end =
      i + 1 < phaseEvents.length
        ? phaseEvents[i + 1].offsetSec
        : totalDurationSec;
    const phase = phaseEvents[i].phase;
    phaseDurations[phase] = (phaseDurations[phase] || 0) + (end - start);
  }

  // Tool call patterns
  const patternCounts = new Map<string, number>();
  for (const e of toolEvents) {
    patternCounts.set(e.summary, (patternCounts.get(e.summary) || 0) + 1);
  }
  const topPatterns = [...patternCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([pattern, count]) => ({ pattern, count }));

  // Tool-category phase fractions
  const toolCategoryFractions = computeToolPhaseFractions(toolEvents, toolInputs);

  return {
    runFile: basename(logPath),
    coldStartSec,
    totalDurationSec,
    toolCalls: toolEvents.length,
    phaseDurations,
    toolCategoryFractions,
    topPatterns,
    toolEvents,
    phaseEvents,
  };
}

/**
 * Compute phase fractions from tool events (discovery/coding/testing/shipping).
 * This is a tool-category-based breakdown, not phase-marker-based.
 */
export function computeToolPhaseFractions(
  toolEvents: ToolEvent[],
  messages: Array<{ name: string; input: Record<string, any> }>,
): Record<string, number> {
  const counts: Record<string, number> = {
    discovery: 0,
    coding: 0,
    testing: 0,
    shipping: 0,
    other: 0,
  };

  for (const msg of messages) {
    const cat = categorizeToolPhase(msg.name, msg.input);
    counts[cat]++;
  }

  const total = Object.values(counts).reduce((s, c) => s + c, 0);
  if (total === 0)
    return { discovery: 0, coding: 0, testing: 0, shipping: 0, other: 0 };

  const fractions: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts)) {
    fractions[k] = v / total;
  }
  return fractions;
}

/**
 * Analyze an entire batch directory.
 */
export function analyzeBatch(batchDir: string): BatchAnalysis {
  const logFiles = readdirSync(batchDir)
    .filter((f) => f.endsWith('.log') && f.startsWith('run-'))
    .sort();

  const runs = logFiles.map((f) => analyzeRunLog(join(batchDir, f)));

  // Cold-start statistics
  const coldStarts = runs
    .map((r) => r.coldStartSec)
    .filter((v) => !isNaN(v));

  const avg =
    coldStarts.length > 0
      ? coldStarts.reduce((s, v) => s + v, 0) / coldStarts.length
      : NaN;

  const variance =
    coldStarts.length > 1
      ? coldStarts.reduce((s, v) => s + (v - avg) ** 2, 0) /
        (coldStarts.length - 1)
      : 0;

  const stddev = Math.sqrt(variance);

  // Global patterns across all runs
  const globalPatterns = new Map<string, { count: number; runs: Set<string> }>();
  for (const run of runs) {
    for (const p of run.topPatterns) {
      const existing = globalPatterns.get(p.pattern);
      if (existing) {
        existing.count += p.count;
        existing.runs.add(run.runFile);
      } else {
        globalPatterns.set(p.pattern, {
          count: p.count,
          runs: new Set([run.runFile]),
        });
      }
    }
  }
  const globalTopPatterns = [...globalPatterns.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 15)
    .map(([pattern, { count, runs: runSet }]) => ({
      pattern,
      count,
      runCount: runSet.size,
    }));

  // Phase fractions (from phase durations, summed across runs)
  const totalPhaseDurations: Record<string, number> = {};
  for (const run of runs) {
    for (const [phase, dur] of Object.entries(run.phaseDurations)) {
      totalPhaseDurations[phase] =
        (totalPhaseDurations[phase] || 0) + dur;
    }
  }
  const totalTime = Object.values(totalPhaseDurations).reduce(
    (s, v) => s + v,
    0,
  );
  const globalPhaseFractions: Record<string, number> = {};
  for (const [phase, dur] of Object.entries(totalPhaseDurations)) {
    globalPhaseFractions[phase] = totalTime > 0 ? dur / totalTime : 0;
  }

  // Extract batch ID from state.json or dir name
  let batchId = basename(batchDir);
  const stateFile = join(batchDir, 'state.json');
  if (existsSync(stateFile)) {
    try {
      const state = JSON.parse(readFileSync(stateFile, 'utf8'));
      if (state.batch_id) batchId = state.batch_id;
    } catch { /* use dir name */ }
  }

  return {
    batchDir,
    batchId,
    runs,
    avgColdStartSec: avg,
    stddevColdStartSec: stddev,
    minColdStartSec:
      coldStarts.length > 0 ? Math.min(...coldStarts) : NaN,
    maxColdStartSec:
      coldStarts.length > 0 ? Math.max(...coldStarts) : NaN,
    globalTopPatterns,
    globalPhaseFractions,
  };
}

// Formatting

export function formatRunAnalysis(run: RunAnalysis): string {
  const lines = [
    `### ${run.runFile}`,
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| **Cold start** | ${isNaN(run.coldStartSec) ? 'N/A (no Edit/Write)' : `${run.coldStartSec.toFixed(0)}s`} |`,
    `| **Duration** | ${run.totalDurationSec.toFixed(0)}s |`,
    `| **Tool calls** | ${run.toolCalls} |`,
  ];

  if (run.toolCategoryFractions) {
    const nonZero = Object.entries(run.toolCategoryFractions)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);
    if (nonZero.length > 0) {
      lines.push('', '**Tool category breakdown:**');
      for (const [cat, frac] of nonZero) {
        lines.push(`- ${cat}: ${(frac * 100).toFixed(0)}%`);
      }
    }
  }

  if (Object.keys(run.phaseDurations).length > 0) {
    lines.push('', '**Phase durations (from markers):**');
    for (const [phase, dur] of Object.entries(run.phaseDurations).sort(
      (a, b) => b[1] - a[1],
    )) {
      lines.push(`- ${phase}: ${dur.toFixed(0)}s`);
    }
  }

  if (run.topPatterns.length > 0) {
    lines.push('', '**Top tool patterns:**');
    for (const p of run.topPatterns.slice(0, 5)) {
      lines.push(`- \`${p.pattern}\` x${p.count}`);
    }
  }

  return lines.join('\n');
}

export function formatBatchAnalysis(batch: BatchAnalysis): string {
  const lines = [
    `## Auto-Dent Batch Analysis: ${batch.batchId}`,
    '',
    `Analyzed ${batch.runs.length} runs from \`${batch.batchDir}\``,
    '',
    `### Cold-Start Summary`,
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| **Average** | ${isNaN(batch.avgColdStartSec) ? 'N/A' : `${batch.avgColdStartSec.toFixed(0)}s`} |`,
    `| **Std dev** | ${batch.stddevColdStartSec.toFixed(0)}s |`,
    `| **Min** | ${isNaN(batch.minColdStartSec) ? 'N/A' : `${batch.minColdStartSec.toFixed(0)}s`} |`,
    `| **Max** | ${isNaN(batch.maxColdStartSec) ? 'N/A' : `${batch.maxColdStartSec.toFixed(0)}s`} |`,
  ];

  if (Object.keys(batch.globalPhaseFractions).length > 0) {
    lines.push('', '### Phase Breakdown (all runs)', '');
    for (const [phase, frac] of Object.entries(
      batch.globalPhaseFractions,
    ).sort((a, b) => b[1] - a[1])) {
      lines.push(`- **${phase}**: ${(frac * 100).toFixed(1)}%`);
    }
  }

  if (batch.globalTopPatterns.length > 0) {
    lines.push('', '### Top Repeated Tool Patterns (across all runs)', '');
    lines.push('| Pattern | Count | Runs |');
    lines.push('|---------|-------|------|');
    for (const p of batch.globalTopPatterns) {
      lines.push(
        `| \`${p.pattern.slice(0, 60)}\` | ${p.count} | ${p.runCount}/${batch.runs.length} |`,
      );
    }
  }

  lines.push('', '### Per-Run Details', '');
  for (const run of batch.runs) {
    lines.push(formatRunAnalysis(run));
    lines.push('');
  }

  return lines.join('\n');
}

// CLI

function main(): void {
  const target = process.argv[2];

  if (!target || target === '--help') {
    console.log(`auto-dent-analyze — Cold-start and efficiency analysis

Usage:
  auto-dent-analyze.ts <batch-dir>         Analyze all runs in a batch
  auto-dent-analyze.ts <log-file>          Analyze a single run log
  auto-dent-analyze.ts --all               Analyze all batches

Examples:
  npx tsx scripts/auto-dent-analyze.ts logs/auto-dent/batch-260323-0003-072b
  npx tsx scripts/auto-dent-analyze.ts logs/auto-dent/batch-260323-0003-072b/run-1-260322220305.log
  npx tsx scripts/auto-dent-analyze.ts --all`);
    process.exit(0);
  }

  if (target === '--all') {
    const repoRoot = getRepoRoot();
    const logsDir = join(repoRoot, 'logs', 'auto-dent');
    if (!existsSync(logsDir)) {
      console.error('No logs directory found. Run auto-dent first.');
      process.exit(1);
    }
    const batches = readdirSync(logsDir)
      .filter((d) => d.startsWith('batch-'))
      .sort();

    if (batches.length === 0) {
      console.error('No batch directories found.');
      process.exit(1);
    }

    for (const b of batches) {
      const analysis = analyzeBatch(join(logsDir, b));
      console.log(formatBatchAnalysis(analysis));
      console.log('');
    }
    return;
  }

  const resolved = resolve(target);

  if (!existsSync(resolved)) {
    console.error(`Not found: ${resolved}`);
    process.exit(1);
  }

  // Single file
  if (resolved.endsWith('.log')) {
    const run = analyzeRunLog(resolved);
    console.log(formatRunAnalysis(run));
    return;
  }

  // Directory
  const analysis = analyzeBatch(resolved);
  console.log(formatBatchAnalysis(analysis));
}

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

const isDirectRun =
  process.argv[1]?.endsWith('auto-dent-analyze.ts') ||
  process.argv[1]?.endsWith('auto-dent-analyze.js');

if (isDirectRun) {
  main();
}
