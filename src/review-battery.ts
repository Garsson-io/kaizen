/**
 * review-battery.ts — Independent subagent review system.
 *
 * Spawns focused review agents that compare artifacts (plans, PRs, issues)
 * and produce structured findings. Used by both auto-dent harness (between sessions)
 * and interactive skills (via Agent tool).
 *
 * Core primitive: compare(artifact_a, artifact_b, adversarial_prompt) → findings[]
 *
 * Part of the review loop system — see docs/review-loop-spec.md
 * Linear: ENG-6638
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';

// ── Review Output Schema ────────────────────────────────────────────
//
// This schema is the contract between:
//   - Review prompts (must emit this JSON)
//   - parseReviewOutput (must parse it)
//   - Auto-dent harness (advisory post-run review)
//   - Skill integration (agent iterates until passing)
//
// Review prompts are instructed to output a JSON block fenced with
// ```json ... ``` containing this structure.

/** Status of a single requirement or criterion */
export type FindingStatus = 'DONE' | 'PARTIAL' | 'MISSING';

/** A single finding from a review dimension */
export interface ReviewFinding {
  /** The requirement or criterion being evaluated */
  requirement: string;
  /** Whether the requirement is met */
  status: FindingStatus;
  /** Explanation of the finding — what's done, what's missing, why */
  detail: string;
}

/** Output from a single review dimension */
export interface DimensionReview {
  /** Which dimension was reviewed (e.g., "plan-coverage", "requirements") */
  dimension: string;
  /** Overall verdict: pass if all findings are DONE, fail otherwise */
  verdict: 'pass' | 'fail';
  /** Individual findings per requirement */
  findings: ReviewFinding[];
  /** One-line summary of the review */
  summary: string;
}

/** Aggregated result from running multiple review dimensions */
export interface BatteryResult {
  /** Results per dimension */
  dimensions: DimensionReview[];
  /** Overall: pass only if ALL dimensions pass */
  verdict: 'pass' | 'fail';
  /** Total findings with status MISSING */
  missingCount: number;
  /** Total findings with status PARTIAL */
  partialCount: number;
  /** Wall-clock time for the full battery (ms) */
  durationMs: number;
  /** Total cost across all review agents (USD) */
  costUsd: number;
}

// ── Review Policy Constants ─────────────────────────────────────────
//
// These constants guide the agent's review-fix iteration in skills.
// The agent IS the loop — these are stop conditions, not code-level loops.

/** Maximum fix iterations before escalating to human */
export const MAX_FIX_ROUNDS = 3;

/** Budget cap per full battery run (USD). Abort if exceeded. */
export const BUDGET_CAP_USD = 2.0;

/**
 * Passing threshold: a battery passes when missingCount === 0.
 * PARTIAL findings are warnings, not blockers — they don't fail the battery.
 * This matches the verdict logic in reviewBattery().
 */
export const PASSING_THRESHOLD = { maxMissing: 0 } as const;

// ── Review Dimensions ───────────────────────────────────────────────
//
// Dimensions are auto-discovered from prompts/review-*.md files.
// To add a new dimension: create prompts/review-<name>.md and it's available.

export type ReviewDimension = string;

/** Data categories a dimension can require */
export type DataNeed = 'diff' | 'issue' | 'pr' | 'codebase' | 'tests' | 'plan' | 'session' | 'git-history';

/** Frontmatter metadata from a review dimension prompt */
export interface DimensionMeta {
  name: string;
  description: string;
  /** What artifact this dimension reviews: pr, plan, or both */
  applies_to: string;
  /** What data this dimension needs to do its job */
  needs: DataNeed[];
  file: string;
}

/**
 * Compute data-need overlap between dimensions.
 * Returns groups of dimensions that share the same data needs.
 * This is a SIGNAL for the agent to use when deciding how to group —
 * it does not make the grouping decision.
 */
export function computeDataOverlap(metas: DimensionMeta[]): Array<{
  /** The shared data needs */
  shared_needs: DataNeed[];
  /** Dimensions that share these needs */
  dimensions: string[];
}> {
  // Group by exact needs signature
  const byNeeds = new Map<string, string[]>();
  for (const m of metas) {
    const key = [...m.needs].sort().join(',');
    if (!byNeeds.has(key)) byNeeds.set(key, []);
    byNeeds.get(key)!.push(m.name);
  }
  return [...byNeeds.entries()].map(([key, dims]) => ({
    shared_needs: key.split(',').filter(Boolean) as DataNeed[],
    dimensions: dims,
  }));
}

/**
 * Produce a review briefing — all the signals an agent needs to decide
 * how many subagents to use and how to group dimensions.
 *
 * This function does NOT decide. It provides:
 * - All applicable dimensions with their data needs
 * - Natural groupings by data overlap
 * - PR size signal
 * - All data categories needed across all dimensions
 */
export function reviewBriefing(
  metas: DimensionMeta[],
  prLines: number,
): {
  dimensions: DimensionMeta[];
  data_overlap_groups: ReturnType<typeof computeDataOverlap>;
  all_data_needs: DataNeed[];
  pr_lines: number;
  dimension_count: number;
} {
  const allNeeds = new Set<DataNeed>();
  for (const m of metas) m.needs.forEach(n => allNeeds.add(n));

  return {
    dimensions: metas,
    data_overlap_groups: computeDataOverlap(metas),
    all_data_needs: [...allNeeds],
    pr_lines: prLines,
    dimension_count: metas.length,
  };
}

/**
 * Parse YAML frontmatter from a review prompt file.
 * Returns null if no frontmatter found.
 */
function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w[\w_-]*)\s*:\s*(.+)$/);
    if (kv) result[kv[1]] = kv[2].trim();
  }
  return result;
}

/**
 * Discover available review dimensions by scanning prompts/review-*.md.
 * Returns a map of dimension name → template filename.
 */
export function discoverDimensions(promptsDir?: string): Record<string, string> {
  const dir = promptsDir ?? resolvePromptsDir();
  const dims: Record<string, string> = {};
  try {
    for (const file of readdirSync(dir)) {
      const match = file.match(/^review-(.+)\.md$/);
      if (match) {
        dims[match[1]] = file;
      }
    }
  } catch {
    // Fall through — no prompts dir
  }
  return dims;
}

/**
 * List available dimension names.
 */
export function listDimensions(promptsDir?: string): string[] {
  return Object.keys(discoverDimensions(promptsDir));
}

/**
 * Load metadata for all review dimensions.
 * Reads frontmatter from each prompts/review-*.md file.
 */
export function loadDimensionMetas(promptsDir?: string): DimensionMeta[] {
  const dir = promptsDir ?? resolvePromptsDir();
  const dims = discoverDimensions(dir);
  const metas: DimensionMeta[] = [];
  for (const [dimName, file] of Object.entries(dims)) {
    try {
      const content = readFileSync(resolve(dir, file), 'utf8');
      const fm = parseFrontmatter(content);
      const needsStr = fm?.needs ?? 'diff';
      const needs = needsStr.replace(/[\[\]]/g, '').split(',').map(s => s.trim()).filter(Boolean) as DataNeed[];
      metas.push({
        name: fm?.name ?? dimName,
        description: fm?.description ?? '',
        applies_to: fm?.applies_to ?? 'pr',
        needs,
        file,
      });
    } catch {
      metas.push({ name: dimName, description: '', applies_to: 'pr', needs: ['diff'], file });
    }
  }
  return metas;
}

// ── Output Parsing ──────────────────────────────────────────────────

/**
 * Parse structured review output from a review agent's response.
 *
 * The agent is instructed to emit a JSON block fenced with ```json ... ```
 * We extract the first JSON block and parse it as a DimensionReview.
 *
 * Handles common failure modes:
 *   - JSON wrapped in markdown fences
 *   - JSON with preamble/postamble text
 *   - Malformed JSON (returns null)
 */
export function parseReviewOutput(raw: string, dimension: string): DimensionReview | null {
  // Try to extract JSON from markdown code fences first
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const jsonStr = fenceMatch ? fenceMatch[1].trim() : raw.trim();

  // Try to find a JSON object in the text
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);

    // Validate required fields
    if (!Array.isArray(parsed.findings)) return null;

    const findings: ReviewFinding[] = parsed.findings.map((f: any) => ({
      requirement: String(f.requirement ?? f.item ?? ''),
      status: normalizeStatus(f.status),
      detail: String(f.detail ?? f.description ?? ''),
    }));

    const hasFailure = findings.some(f => f.status !== 'DONE');

    return {
      dimension: parsed.dimension ?? dimension,
      verdict: hasFailure ? 'fail' : 'pass',
      findings,
      summary: String(parsed.summary ?? ''),
    };
  } catch {
    return null;
  }
}

function normalizeStatus(s: unknown): FindingStatus {
  const str = String(s).toUpperCase().trim();
  if (str === 'DONE' || str === 'PASS' || str === 'COMPLETE' || str === 'ADDRESSED') return 'DONE';
  if (str === 'PARTIAL' || str === 'PARTIALLY') return 'PARTIAL';
  return 'MISSING';
}

// ── Prompt Loading ──────────────────────────────────────────────────

/**
 * Resolve the prompts directory. Checks repo-root/prompts first,
 * then falls back to the directory relative to this file.
 */
export function resolvePromptsDir(): string {
  try {
    const toplevel = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).stdout.trim();
    const dir = resolve(toplevel, 'prompts');
    if (existsSync(dir)) return dir;
  } catch {
    // Fall through
  }
  return resolve(dirname(new URL(import.meta.url).pathname), '..', 'prompts');
}

/**
 * Load a review prompt template and substitute variables.
 */
export function loadReviewPrompt(
  dimension: ReviewDimension,
  vars: Record<string, string>,
): string {
  const promptsDir = resolvePromptsDir();
  const dims = discoverDimensions(promptsDir);
  const templateFile = dims[dimension];
  if (!templateFile) {
    const available = Object.keys(dims).join(', ');
    throw new Error(`Unknown review dimension: "${dimension}". Available: ${available}`);
  }
  const templatePath = resolve(promptsDir, templateFile);

  if (!existsSync(templatePath)) {
    throw new Error(`Review prompt template not found: ${templatePath}`);
  }

  let content = readFileSync(templatePath, 'utf8');

  // Mustache-style variable substitution
  for (const [key, value] of Object.entries(vars)) {
    content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }

  return content;
}

// ── Review Spawning ─────────────────────────────────────────────────

export interface SpawnReviewOptions {
  /** Review dimension to run */
  dimension: ReviewDimension;
  /** PR URL (for implementation reviews) */
  prUrl?: string;
  /** Issue number (for requirement comparison) */
  issueNum?: string;
  /** GitHub repo (owner/name) */
  repo?: string;
  /** Plan text (for plan reviews) */
  planText?: string;
  /** Issue body text (pre-fetched to avoid subagent re-fetching) */
  issueBody?: string;
  /** PR body text (pre-fetched) */
  prBody?: string;
  /** PR diff stat (pre-fetched) */
  prDiffStat?: string;
  /** Working directory for the claude -p call */
  cwd?: string;
  /** Timeout in ms (default: 120000) */
  timeoutMs?: number;
}

/**
 * Spawn a single review agent via `claude -p`.
 * Returns the parsed DimensionReview, or null if the review failed.
 */
export function spawnReview(opts: SpawnReviewOptions): { review: DimensionReview | null; costUsd: number; durationMs: number } {
  const vars: Record<string, string> = {
    pr_url: opts.prUrl ?? '',
    issue_num: opts.issueNum ?? '',
    repo: opts.repo ?? '',
    plan_text: opts.planText ?? '',
    issue_body: opts.issueBody ?? '',
    pr_body: opts.prBody ?? '',
    pr_diff_stat: opts.prDiffStat ?? '',
  };

  let prompt: string;
  try {
    prompt = loadReviewPrompt(opts.dimension, vars);
  } catch (e: any) {
    console.error(`  [review] failed to load prompt for ${opts.dimension}: ${e.message}`);
    return { review: null, costUsd: 0, durationMs: 0 };
  }

  const start = Date.now();
  const result = spawnSync('claude', [
    '-p',
    '--output-format', 'json',
    '--dangerously-skip-permissions',
    '--model', 'sonnet',
  ], {
    input: prompt,
    encoding: 'utf8',
    cwd: opts.cwd,
    timeout: opts.timeoutMs ?? 120_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const durationMs = Date.now() - start;

  if (result.status !== 0) {
    console.error(`  [review] claude -p failed for ${opts.dimension}: exit ${result.status}`);
    return { review: null, costUsd: 0, durationMs };
  }

  // Parse cost from JSON output
  let costUsd = 0;
  let responseText = '';
  try {
    const output = JSON.parse(result.stdout);
    responseText = output.result ?? '';
    costUsd = output.cost_usd ?? output.total_cost_usd ?? 0;
  } catch {
    responseText = result.stdout;
  }

  const review = parseReviewOutput(responseText, opts.dimension);
  return { review, costUsd, durationMs };
}

// ── Battery Orchestration ───────────────────────────────────────────

export interface BatteryOptions {
  /** Dimensions to review */
  dimensions: ReviewDimension[];
  /** PR URL */
  prUrl?: string;
  /** Issue number */
  issueNum?: string;
  /** GitHub repo */
  repo?: string;
  /** Pre-fetched issue body */
  issueBody?: string;
  /** Pre-fetched PR body */
  prBody?: string;
  /** Pre-fetched PR diff stat */
  prDiffStat?: string;
  /** Plan text (for plan reviews) */
  planText?: string;
  /** Working directory */
  cwd?: string;
  /** Timeout per review in ms */
  timeoutMs?: number;
}

/**
 * Run a battery of review dimensions in parallel.
 * Returns aggregated results with overall verdict.
 */
export function reviewBattery(opts: BatteryOptions): BatteryResult {
  const start = Date.now();

  // Run reviews sequentially (spawnSync is blocking).
  // For true parallelism, we'd need async spawn — sequential is simpler for v1.
  const results = opts.dimensions.map(dimension => {
    return spawnReview({
      dimension,
      prUrl: opts.prUrl,
      issueNum: opts.issueNum,
      repo: opts.repo,
      issueBody: opts.issueBody,
      prBody: opts.prBody,
      prDiffStat: opts.prDiffStat,
      planText: opts.planText,
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
    });
  });

  const dimensions = results
    .map(r => r.review)
    .filter((r): r is DimensionReview => r !== null);

  const missingCount = dimensions.reduce(
    (sum, d) => sum + d.findings.filter(f => f.status === 'MISSING').length, 0,
  );
  const partialCount = dimensions.reduce(
    (sum, d) => sum + d.findings.filter(f => f.status === 'PARTIAL').length, 0,
  );
  const costUsd = results.reduce((sum, r) => sum + r.costUsd, 0);
  const durationMs = Date.now() - start;

  return {
    dimensions,
    verdict: missingCount === 0 && dimensions.length === opts.dimensions.length ? 'pass' : 'fail',
    missingCount,
    partialCount,
    durationMs,
    costUsd,
  };
}

// ── Formatting ──────────────────────────────────────────────────────

/**
 * Format a BatteryResult as a markdown report suitable for PR comments
 * or progress issue updates.
 */
export function formatBatteryReport(result: BatteryResult): string {
  const lines: string[] = [
    `### Review Battery: ${result.verdict.toUpperCase()}`,
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Verdict | ${result.verdict} |`,
    `| Dimensions | ${result.dimensions.length} |`,
    `| Missing | ${result.missingCount} |`,
    `| Partial | ${result.partialCount} |`,
    `| Duration | ${(result.durationMs / 1000).toFixed(1)}s |`,
    `| Cost | $${result.costUsd.toFixed(2)} |`,
    '',
  ];

  for (const dim of result.dimensions) {
    lines.push(`#### ${dim.dimension}: ${dim.verdict}`);
    if (dim.summary) lines.push(`> ${dim.summary}`);
    lines.push('');

    for (const f of dim.findings) {
      const icon = f.status === 'DONE' ? '[x]' : f.status === 'PARTIAL' ? '[-]' : '[ ]';
      lines.push(`- ${icon} **${f.requirement}**: ${f.status} — ${f.detail}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
