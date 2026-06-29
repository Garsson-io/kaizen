/**
 * review-battery.ts — Independent subagent review system.
 *
 * Spawns focused review agents that compare artifacts (plans, PRs, issues)
 * and produce structured findings. Used by both auto-dent harness (between sessions)
 * and interactive skills (via Agent tool).
 *
 * Core primitive: compare(artifact_a, artifact_b, adversarial_prompt) → findings[]
 *
 * Part of the review loop system — see docs/artifact-lifecycle.md
 * Linear: ENG-6638
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { readYamlFrontmatter, stripYamlFrontmatter } from './lib/frontmatter.js';
import { firstMarkdownFence, markdownFences } from './lib/markdown-fence.js';
import { resolveProjectRoot, type GitRunner } from './lib/resolve-project-root.js';
import { spawnAgent, type SpawnAgentProvider } from './spawn-claude.js';
import { subscriptionAgentProvider } from './provider-contract.js';
import { retrievePlan, issueTarget } from './structured-data.js';
import {
  normalizeFindingStatus,
  deriveVerdictFromFindings,
  type FindingStatus,
  type ReviewFinding,
} from './review-finding-contract.js';

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

/** Prefix for synthetic findings that represent missing input data, not code gaps.
 * Used by review-fix.ts to distinguish fixable code gaps from unfixable data-availability gaps. */
export const DATA_GAP_PREFIX = '[data-gap]';
export type { FindingStatus, ReviewFinding } from './review-finding-contract.js';

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
  /** Provider that produced or attempted this review dimension (#1147). */
  provider?: ReviewProvider;
}

export type ReviewFailureClass =
  | 'claude_review_failed'
  | 'codex_review_failed';

export type ReviewProvider = SpawnAgentProvider;

export interface ReviewDimensionFailure {
  dimension: string;
  provider: ReviewProvider;
  failureClass: ReviewFailureClass;
  detail?: string;
}

/** Aggregated result from running multiple review dimensions */
export interface BatteryResult {
  /** Results per dimension */
  dimensions: DimensionReview[];
  /** Provider selected for this battery (#1147). */
  reviewProvider?: ReviewProvider;
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
  /** Dimensions that returned null (timeout or claude error) */
  failedDimensions: string[];
  /** Provider-aware failure classification per failed dimension (#1147). */
  failedDimensionFailures?: ReviewDimensionFailure[];
  /** Dimensions auto-skipped due to missing required data (e.g. no plan text) */
  skippedDimensions: string[];
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

export function selectReviewProvider(provider?: ReviewProvider): ReviewProvider {
  return provider ?? subscriptionAgentProvider('claude');
}

function providerLabel(provider: ReviewProvider): string {
  return `${provider.provider} (${provider.billing})`;
}

// ── Review Dimensions ───────────────────────────────────────────────
//
// Dimensions are auto-discovered from prompts/review-*.md files.
// To add a new dimension: create prompts/review-<name>.md and it's available.

export type ReviewDimension = string;

/** Data categories a dimension can require */
export type DataNeed = 'diff' | 'issue' | 'pr' | 'codebase' | 'tests' | 'plan' | 'session' | 'git-history' | 'multiple_prs' | 'reflection_history';

/** Frontmatter metadata from a review dimension prompt */
export interface DimensionMeta {
  name: string;
  description: string;
  /** What artifact this dimension reviews: pr, plan, or both */
  applies_to: string;
  /** What data this dimension needs to do its job */
  needs: DataNeed[];
  /** Signals that make this dimension higher priority for a given PR */
  high_when: string[];
  /** Signals that make this dimension lower priority (bundle with others) */
  low_when: string[];
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
/**
 * Format a human-readable review briefing.
 * Shows dimensions, their data needs, priority signals, and overlap groups.
 * The agent reads this and decides grouping — the briefing provides signals, not decisions.
 */
export function reviewBriefing(
  metas: DimensionMeta[],
  prLines: number,
): string {
  const allNeeds = new Set<DataNeed>();
  for (const m of metas) m.needs.forEach(n => allNeeds.add(n));
  const groups = computeDataOverlap(metas);

  const lines: string[] = [
    `## Review Briefing`,
    ``,
    `PR size: ${prLines} lines | Dimensions: ${metas.length} | Data needed: ${[...allNeeds].join(', ')}`,
    ``,
    `### Dimensions and Priority Signals`,
    ``,
  ];

  for (const m of metas) {
    lines.push(`**${m.name}** (needs: ${m.needs.join(', ')}) — ${m.description}`);
    if (m.high_when.length > 0) {
      lines.push(`  High priority when: ${m.high_when.join('; ')}`);
    }
    if (m.low_when.length > 0) {
      lines.push(`  Low priority when: ${m.low_when.join('; ')}`);
    }
    lines.push('');
  }

  lines.push(`### Natural Groupings (by shared data needs)`, '');
  for (const g of groups) {
    lines.push(`- **[${g.shared_needs.join(', ')}]**: ${g.dimensions.join(', ')}`);
  }
  lines.push('');
  lines.push(`Use priority signals + PR context to decide: how many subagents, which dimensions per agent, whether any dimension warrants redundancy.`);

  return lines.join('\n');
}

/**
 * Parse YAML frontmatter from a review prompt file.
 * Returns null if no frontmatter found or YAML is invalid.
 */
export function parseFrontmatter(content: string): Record<string, unknown> | null {
  return readYamlFrontmatter(content);
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
 * List dimensions applicable to post-PR review.
 * Includes only dimensions with applies_to === 'pr' or 'both'.
 * Automatically excludes plan-only and reflection-only dimensions.
 */
export function listPrDimensions(promptsDir?: string): string[] {
  return loadDimensionMetas(promptsDir)
    .filter(m => m.applies_to === 'pr' || m.applies_to === 'both')
    .map(m => m.name);
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
      const needsRaw = fm?.needs;
      const needs: DataNeed[] = Array.isArray(needsRaw)
        ? needsRaw as DataNeed[]
        : (typeof needsRaw === 'string' ? [needsRaw as DataNeed] : ['diff']);
      const highWhen = Array.isArray(fm?.high_when) ? fm.high_when as string[] : [];
      const lowWhen = Array.isArray(fm?.low_when) ? fm.low_when as string[] : [];
      metas.push({
        name: (fm?.name as string) ?? dimName,
        description: (fm?.description as string) ?? '',
        applies_to: (fm?.applies_to as string) ?? 'pr',
        needs,
        high_when: highWhen,
        low_when: lowWhen,
        file,
      });
    } catch {
      metas.push({ name: dimName, description: '', applies_to: 'pr', needs: ['diff'], high_when: [], low_when: [], file });
    }
  }
  return metas;
}

// ── Coverage Validation ─────────────────────────────────────────────

/**
 * Validate that all expected dimensions were reviewed.
 * Call after collecting subagent results to ensure nothing was skipped.
 *
 * Returns { complete, missing } — the agent MUST run missing dimensions
 * before proceeding.
 */
export function validateReviewCoverage(
  expected: DimensionMeta[],
  reviewed: DimensionReview[],
): { complete: boolean; missing: DimensionMeta[]; reviewed: string[] } {
  const reviewedNames = new Set(reviewed.map(r => r.dimension));
  const missing = expected.filter(d => !reviewedNames.has(d.name));
  return {
    complete: missing.length === 0,
    missing,
    reviewed: [...reviewedNames],
  };
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
  const jsonStr = firstMarkdownFence(raw, ['json', ''])?.code ?? raw.trim();

  // Try to find a JSON object in the text
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);

    // Validate required fields
    if (!Array.isArray(parsed.findings)) return null;

    const findings: ReviewFinding[] = parsed.findings.map((f: any) => ({
      requirement: String(f.requirement ?? f.item ?? ''),
      status: normalizeFindingStatus(f.status),
      detail: String(f.detail ?? f.description ?? ''),
    }));

    return {
      dimension: parsed.dimension ?? dimension,
      verdict: deriveVerdictFromFindings(findings),
      findings,
      summary: String(parsed.summary ?? ''),
    };
  } catch {
    return null;
  }
}

// ── Prompt Loading ──────────────────────────────────────────────────

/**
 * Substitute variables and conditional sections in a template string.
 * - `{{#key}}...{{/key}}` — include block only if vars[key] is non-empty
 * - `{{key}}` — replace with vars[key], or leave as `{{key}}` if missing
 * Cleans up extra blank lines left by removed conditional sections.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  let result = template.replace(
    /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_match, key: string, body: string) => vars[key] ? body : '',
  );
  result = result.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => vars[key] ?? `{{${key}}}`);
  result = result.replace(/\n{3,}/g, '\n\n');
  return result.trim();
}

function boundedContext(label: string, value: string | undefined, maxChars: number): string[] {
  const text = (value ?? '').trim();
  if (!text) return [];
  const bounded = text.length > maxChars
    ? `${text.slice(0, maxChars)}\n\n[truncated: ${text.length - maxChars} chars omitted]`
    : text;
  return [`### ${label}`, '', bounded];
}

export function appendPrefetchedReviewContext(prompt: string, vars: Record<string, string>): string {
  const sections = [
    ...boundedContext('Stored plan', vars.plan_text, 8_000),
    ...boundedContext('Issue body', vars.issue_body, 8_000),
    ...boundedContext('PR body', vars.pr_body, 8_000),
    ...boundedContext('PR diff/stat', vars.pr_diff_stat, 20_000),
  ];
  if (sections.length === 0) return prompt;

  return [
    prompt,
    '',
    '## Prefetched Review Context',
    '',
    'Use this harness-provided context as primary evidence. If it conflicts with live GitHub reads, call out the conflict explicitly instead of treating the context as missing.',
    '',
    ...sections,
  ].join('\n');
}

/**
 * Resolve the prompts directory. Checks repo-root/prompts first,
 * then falls back to the directory relative to this file.
 */
export function resolvePromptsDir(git?: GitRunner): string {
  const thisDir = dirname(new URL(import.meta.url).pathname);
  const root = resolveProjectRoot(thisDir, git);
  const dir = resolve(root, 'prompts');
  if (existsSync(dir)) return dir;
  return resolve(thisDir, '..', 'prompts');
}

/**
 * Load a review prompt template and substitute variables.
 * Strips YAML frontmatter before sending — frontmatter is metadata for the
 * tool loader (needs, high_when, etc.) and must not be sent to the LLM.
 */
export function loadReviewPrompt(
  dimension: ReviewDimension,
  vars: Record<string, string>,
  promptsDir?: string,
  opts: { includePrefetchedContext?: boolean } = {},
): string {
  const dir = promptsDir ?? resolvePromptsDir();
  const dims = discoverDimensions(dir);
  const templateFile = dims[dimension];
  if (!templateFile) {
    const available = Object.keys(dims).join(', ');
    throw new Error(`Unknown review dimension: "${dimension}". Available: ${available}`);
  }
  const templatePath = resolve(dir, templateFile);

  if (!existsSync(templatePath)) {
    throw new Error(`Review prompt template not found: ${templatePath}`);
  }

  const content = readFileSync(templatePath, 'utf8');
  const body = stripYamlFrontmatter(content);
  const rendered = renderTemplate(body, vars);
  return opts.includePrefetchedContext === false
    ? rendered
    : appendPrefetchedReviewContext(rendered, vars);
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
  /** Additional prompt variables for reflection or specialized dimensions. */
  extraVars?: Record<string, string>;
  /** Working directory for the provider call */
  cwd?: string;
  /** Timeout in ms (default: 120000) */
  timeoutMs?: number;
  /** Review provider. Defaults to Claude subscription CLI (#1147). */
  reviewProvider?: ReviewProvider;
}

// ── Agent Subprocess Helper ──────────────────────────────────────────
// The provider-aware spawn loop lives in the shared `spawnAgent` primitive
// (src/spawn-claude.ts) so the review battery and the independence-by-spawn
// judge share one implementation (#1231/#1580 DRY mandate).

const runAgent = spawnAgent;

function reviewFailureClass(provider: ReviewProvider): ReviewFailureClass {
  return provider.provider === 'codex' ? 'codex_review_failed' : 'claude_review_failed';
}

export function summarizeReviewProviderFailure(parts: {
  provider: ReviewProvider;
  exitCode?: number;
  text?: string;
  stderr?: string;
}): string {
  const candidates = [parts.stderr, parts.text]
    .map(value => (value ?? '').trim())
    .filter(Boolean);
  const detail = candidates[0] ?? 'provider returned no diagnostic output';
  const squashed = detail.replace(/\s+/g, ' ').trim();
  const bounded = squashed.length > 500 ? `${squashed.slice(0, 497)}...` : squashed;
  const exit = parts.exitCode === undefined ? '' : ` exit ${parts.exitCode}:`;
  return `${providerLabel(parts.provider)}${exit} ${bounded}`;
}

/**
 * Spawn a single review agent via the selected provider.
 * Returns the parsed DimensionReview, or null if the review failed.
 */
export async function spawnReview(opts: SpawnReviewOptions): Promise<{
  review: DimensionReview | null;
  costUsd: number;
  durationMs: number;
  provider: ReviewProvider;
  failureClass?: ReviewFailureClass;
  failureDetail?: string;
}> {
  const provider = selectReviewProvider(opts.reviewProvider);
  const failureClass = reviewFailureClass(provider);

  const vars: Record<string, string> = {
    ...(opts.extraVars ?? {}),
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
    return { review: null, costUsd: 0, durationMs: 0, provider, failureClass };
  }

  const { text, costUsd, durationMs, exitCode, rawStderr } = await runAgent(prompt, {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    provider,
  });

  if (exitCode !== 0) {
    const failureDetail = summarizeReviewProviderFailure({ provider, exitCode, text, stderr: rawStderr });
    console.error(`  [review:${provider.provider}] failed for ${opts.dimension}: ${failureDetail}`);
    return { review: null, costUsd: 0, durationMs, provider, failureClass, failureDetail };
  }

  const review = parseReviewOutput(text, opts.dimension);
  const failureDetail = review ? undefined : summarizeReviewProviderFailure({ provider, text });
  if (review) review.provider = provider;
  return {
    review,
    costUsd,
    durationMs,
    provider,
    failureClass: review ? undefined : failureClass,
    failureDetail,
  };
}

// ── Batch Review ─────────────────────────────────────────────────────

export interface SpawnBatchReviewOptions extends Omit<SpawnReviewOptions, 'dimension'> {
  dimensions: ReviewDimension[];
}

/**
 * Parse all DimensionReview JSON blocks from a batch response.
 * A batch prompt asks the selected provider to output one ```json block per dimension.
 * Returns all successfully parsed reviews (may be fewer than requested).
 */
export function parseAllReviewOutputs(raw: string, expectedDimensions: string[]): DimensionReview[] {
  const results: DimensionReview[] = [];
  for (const block of markdownFences(raw, ['json', ''])) {
    const review = parseReviewOutput(block.code, '');
    if (review && review.dimension) results.push(review);
  }
  return results;
}

/**
 * Group dimensions by their shared data-needs signature.
 * Dimensions with identical needs can be batched into one claude call.
 * Unknown dimensions (not in metas) are never batched.
 */
export function groupByDataNeeds(
  dimensions: ReviewDimension[],
  metas: DimensionMeta[],
): ReviewDimension[][] {
  const groups = new Map<string, ReviewDimension[]>();
  for (const dim of dimensions) {
    const meta = metas.find(m => m.name === dim);
    const key = meta ? [...meta.needs].sort().join(',') : `_solo_${dim}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(dim);
  }
  return [...groups.values()];
}

/**
 * Spawn multiple review dimensions in a single provider call.
 * Prompts are concatenated; the LLM outputs one ```json block per dimension.
 * Cost is split evenly across dimensions.
 */
export async function spawnBatchReview(
  opts: SpawnBatchReviewOptions,
): Promise<Array<{
  review: DimensionReview | null;
  costUsd: number;
  durationMs: number;
  provider: ReviewProvider;
  failureClass?: ReviewFailureClass;
  failureDetail?: string;
}>> {
  const provider = selectReviewProvider(opts.reviewProvider);
  const failureClass = reviewFailureClass(provider);

  const vars: Record<string, string> = {
    ...(opts.extraVars ?? {}),
    pr_url: opts.prUrl ?? '',
    issue_num: opts.issueNum ?? '',
    repo: opts.repo ?? '',
    plan_text: opts.planText ?? '',
    issue_body: opts.issueBody ?? '',
    pr_body: opts.prBody ?? '',
    pr_diff_stat: opts.prDiffStat ?? '',
  };

  const loadedDims: string[] = [];
  const prompts: string[] = [];
  for (const dim of opts.dimensions) {
    try {
      prompts.push(loadReviewPrompt(dim, vars, undefined, { includePrefetchedContext: false }));
      loadedDims.push(dim);
    } catch (e: any) {
      console.error(`  [review] batch: failed to load prompt for ${dim}: ${e.message}`);
    }
  }

  if (prompts.length === 0) {
    const failureDetail = summarizeReviewProviderFailure({ provider, text: 'no review prompts could be loaded' });
    return opts.dimensions.map(() => ({ review: null, costUsd: 0, durationMs: 0, provider, failureClass, failureDetail }));
  }

  const batchPrompt =
    `Review this PR across ${prompts.length} dimension(s). ` +
    `For each dimension, output a separate \`\`\`json block with the "dimension" field set to the dimension name.\n\n` +
    appendPrefetchedReviewContext(prompts.join('\n\n---\n\n'), vars);

  const { text, costUsd, durationMs, exitCode, rawStderr } = await runAgent(batchPrompt, {
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    provider,
  });

  if (exitCode !== 0) {
    const failureDetail = summarizeReviewProviderFailure({ provider, exitCode, text, stderr: rawStderr });
    console.error(`  [review:${provider.provider}] batch failed: ${failureDetail}`);
    return opts.dimensions.map(() => ({ review: null, costUsd: 0, durationMs, provider, failureClass, failureDetail }));
  }

  const reviews = parseAllReviewOutputs(text, loadedDims);
  const costPerDim = costUsd / Math.max(loadedDims.length, 1);

  return opts.dimensions.map(dim => {
    const review = reviews.find(r => r.dimension === dim) ?? null;
    const failureDetail = review ? undefined : summarizeReviewProviderFailure({ provider, text });
    if (review) review.provider = provider;
    return {
      review,
      costUsd: costPerDim,
      durationMs,
      provider,
      failureClass: review ? undefined : failureClass,
      failureDetail,
    };
  });
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
  /** Additional prompt variables for reflection or specialized dimensions. */
  extraVars?: Record<string, string>;
  /** Working directory */
  cwd?: string;
  /** Timeout per review in ms */
  timeoutMs?: number;
  /** Review provider. Defaults to Claude subscription CLI (#1147). */
  reviewProvider?: ReviewProvider;
}

/**
 * Run a battery of review dimensions in parallel.
 * - Auto-skips dims that need 'plan' data when no planText is provided.
 * - Batches dims with identical data needs into one selected-provider call.
 * - Logs per-dim timing and surfaces failed dims explicitly.
 */
export async function reviewBattery(opts: BatteryOptions): Promise<BatteryResult> {
  const start = Date.now();
  const reviewProvider = selectReviewProvider(opts.reviewProvider);

  // Auto-load planText from GitHub issue when not provided (kaizen #902).
  // Use a local variable to avoid mutating the caller's opts object.
  let planText = opts.planText;
  if (!planText && opts.issueNum && opts.repo) {
    try {
      const stored = retrievePlan(issueTarget(opts.issueNum, opts.repo));
      if (stored) {
        planText = stored;
        console.log(`  [review] auto-loaded plan text from issue #${opts.issueNum} (${stored.length} chars)`);
      }
    } catch { /* best effort — plan dims will emit MISSING if not found */ }
  }

  // Dimensions that need 'plan' data but don't have it get a synthetic MISSING
  // finding instead of being silently skipped (kaizen #901). This ensures the
  // battery report surfaces the gap and the fix loop knows about it.
  const metas = loadDimensionMetas();
  const skippedDimensions: string[] = [];
  const skippedResults: DimensionReview[] = [];
  const effective = opts.dimensions.filter(dim => {
    const meta = metas.find(m => m.name === dim);
    if (meta?.needs.includes('plan') && !planText) {
      skippedDimensions.push(dim);
      skippedResults.push({
        dimension: dim,
        verdict: 'fail',
        provider: reviewProvider,
        findings: [{
          requirement: `${DATA_GAP_PREFIX} Plan text available for review`,
          status: 'MISSING',
          detail: `Dimension "${dim}" requires plan text but none was provided. Create a plan before running this review.`,
        }],
        summary: `Skipped: no plan text provided (requires "plan" data)`,
      });
      return false;
    }
    return true;
  });

  if (skippedDimensions.length > 0) {
    console.log(`  [review] ${skippedDimensions.length} dim(s) missing plan text (MISSING finding): ${skippedDimensions.join(', ')}`);
  }

  // Group by shared data needs; batch same-needs dims into one call
  const batches = groupByDataNeeds(effective, metas);
  const sharedOpts = {
    prUrl: opts.prUrl, issueNum: opts.issueNum, repo: opts.repo,
    issueBody: opts.issueBody, prBody: opts.prBody, prDiffStat: opts.prDiffStat,
    planText, extraVars: opts.extraVars, cwd: opts.cwd, timeoutMs: opts.timeoutMs, reviewProvider,
  };

  const batchResultGroups = await Promise.all(
    batches.map(batch =>
      batch.length > 1
        ? spawnBatchReview({ dimensions: batch, ...sharedOpts })
        : spawnReview({ dimension: batch[0], ...sharedOpts }).then(r => [r]),
    ),
  );

  // Map results back to effective dimension order
  const resultMap = new Map<string, { review: DimensionReview | null; costUsd: number; durationMs: number; provider: ReviewProvider; failureClass?: ReviewFailureClass; failureDetail?: string }>();
  for (let i = 0; i < batches.length; i++) {
    for (let j = 0; j < batches[i].length; j++) {
      resultMap.set(batches[i][j], batchResultGroups[i][j]);
    }
  }
  const results = effective.map(dim => resultMap.get(dim)!);

  // Log per-dim timing and collect failures
  const failedDimensions: string[] = [];
  const failedDimensionFailures: ReviewDimensionFailure[] = [];
  for (const [i, dim] of effective.entries()) {
    const r = results[i];
    if (r.review === null) {
      failedDimensions.push(dim);
      if (r.failureClass) {
        failedDimensionFailures.push({ dimension: dim, provider: r.provider, failureClass: r.failureClass, detail: r.failureDetail });
      }
      console.error(`  [review] ${dim}: FAILED in ${Math.round(r.durationMs / 1000)}s${r.failureDetail ? ` — ${r.failureDetail}` : ''}`);
    } else {
      console.log(`  [review] ${dim}: ${r.review.verdict.toUpperCase()} in ${Math.round(r.durationMs / 1000)}s ($${r.costUsd.toFixed(3)})`);
    }
  }

  // Merge real results with synthetic MISSING results for skipped dims (kaizen #901)
  const dimensions = [
    ...skippedResults,
    ...results.map(r => r.review).filter((r): r is DimensionReview => r !== null),
  ];

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
    reviewProvider,
    verdict: missingCount === 0 && dimensions.length === (effective.length + skippedDimensions.length) ? 'pass' : 'fail',
    missingCount,
    partialCount,
    durationMs,
    costUsd,
    failedDimensions,
    failedDimensionFailures,
    skippedDimensions,
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
    ...(result.reviewProvider ? [`| Review provider | ${providerLabel(result.reviewProvider)} |`] : []),
    '',
  ];

  for (const dim of result.dimensions) {
    lines.push(`#### ${dim.dimension}: ${dim.verdict}`);
    if (dim.provider) lines.push(`_Provider: ${providerLabel(dim.provider)}_`);
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
