#!/usr/bin/env tsx
/**
 * Rerun the PR-attached Review verdict gate after a stored review summary changes.
 *
 * A manual workflow_dispatch run can pass after review data is stored, but it is
 * not the pull_request check run shown in the PR status rollup. This helper
 * finds the latest pull_request run for the PR's current head SHA and reruns it
 * so the attached check can observe the newly stored authoritative review round.
 */

import { ghResult, type GhResult } from '../src/lib/gh-exec.js';

const DEFAULT_WORKFLOW = 'review-verdict-gate.yml';
const ACTIVE_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

export interface ReviewGateWorkflowRun {
  id?: number;
  database_id?: number;
  event?: string;
  head_sha?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string;
}

export interface RerunDecision {
  action: 'rerun' | 'skip';
  reason: string;
}

export interface RerunResult {
  action: 'rerun' | 'skip';
  runId?: number;
  message: string;
}

export type GhRunner = (args: string[], timeoutMs?: number, input?: string) => GhResult;

function readArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function usage(): never {
  console.error('Usage: npx tsx scripts/rerun-review-verdict-gate.ts --repo owner/repo --pr N [--workflow review-verdict-gate.yml]');
  process.exit(2);
}

function runGh(gh: GhRunner, args: string[], context: string): string {
  const result = gh(args, 30_000);
  if (result.status !== 0) {
    throw new Error(`${context} failed: ${result.stderr || result.stdout || `gh ${args.join(' ')}`}`);
  }
  return result.stdout;
}

function runId(run: ReviewGateWorkflowRun): number | null {
  return typeof run.id === 'number' ? run.id
    : typeof run.database_id === 'number' ? run.database_id
      : null;
}

export function isReviewSummaryAttachmentComment(body: string): boolean {
  return /<!--\s*kaizen:review\/r\d+\/summary\s*-->/.test(body);
}

export function selectPrHeadPullRequestRun(
  runs: ReviewGateWorkflowRun[],
  headSha: string,
): ReviewGateWorkflowRun | null {
  return runs.find((run) => run.event === 'pull_request' && run.head_sha === headSha && runId(run) !== null) ?? null;
}

export function decideRerun(run: ReviewGateWorkflowRun): RerunDecision {
  const status = (run.status ?? '').toLowerCase();
  const conclusion = (run.conclusion ?? '').toLowerCase();

  if (ACTIVE_STATUSES.has(status)) {
    return { action: 'skip', reason: `matching pull_request run is already ${status}` };
  }
  if (conclusion === 'success') {
    return { action: 'skip', reason: 'matching pull_request run already succeeded' };
  }
  return { action: 'rerun', reason: `matching pull_request run concluded ${conclusion || status || 'unknown'}` };
}

export function fetchPrHeadSha(repo: string, pr: string, gh: GhRunner = ghResult): string {
  const stdout = runGh(
    gh,
    ['pr', 'view', pr, '--repo', repo, '--json', 'headRefOid', '--jq', '.headRefOid'],
    'fetch PR head SHA',
  );
  const headSha = stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(headSha)) {
    throw new Error(`fetch PR head SHA returned invalid SHA: ${JSON.stringify(headSha)}`);
  }
  return headSha;
}

export function fetchWorkflowRuns(
  repo: string,
  workflow: string,
  headSha: string,
  gh: GhRunner = ghResult,
): ReviewGateWorkflowRun[] {
  const stdout = runGh(
    gh,
    [
      'api',
      '--method',
      'GET',
      `repos/${repo}/actions/workflows/${workflow}/runs`,
      '-F',
      'event=pull_request',
      '-F',
      `head_sha=${headSha}`,
      '-F',
      'per_page=50',
    ],
    'list Review verdict gate workflow runs',
  );
  const parsed = JSON.parse(stdout) as { workflow_runs?: ReviewGateWorkflowRun[] };
  return Array.isArray(parsed.workflow_runs) ? parsed.workflow_runs : [];
}

export function rerunReviewVerdictGate(
  repo: string,
  pr: string,
  options: { workflow?: string; gh?: GhRunner } = {},
): RerunResult {
  const workflow = options.workflow ?? DEFAULT_WORKFLOW;
  const gh = options.gh ?? ghResult;
  const headSha = fetchPrHeadSha(repo, pr, gh);
  const runs = fetchWorkflowRuns(repo, workflow, headSha, gh);
  const run = selectPrHeadPullRequestRun(runs, headSha);

  if (!run) {
    throw new Error(`No pull_request ${workflow} run found for PR #${pr} at ${headSha}`);
  }

  const id = runId(run);
  if (id === null) {
    throw new Error(`Matching pull_request ${workflow} run has no run id`);
  }

  const decision = decideRerun(run);
  if (decision.action === 'skip') {
    return { action: 'skip', runId: id, message: decision.reason };
  }

  runGh(gh, ['api', '--method', 'POST', `repos/${repo}/actions/runs/${id}/rerun`], 'rerun Review verdict gate');
  return {
    action: 'rerun',
    runId: id,
    message: `Rerun requested for ${workflow} pull_request run ${id}: ${decision.reason}`,
  };
}

if (process.argv[1]?.endsWith('rerun-review-verdict-gate.ts') || process.argv[1]?.endsWith('rerun-review-verdict-gate.js')) {
  const repo = readArg('--repo') ?? process.env.GITHUB_REPOSITORY;
  const pr = readArg('--pr') ?? process.env.PR_NUMBER;
  const workflow = readArg('--workflow') ?? DEFAULT_WORKFLOW;
  if (!repo || !pr || !/^\d+$/.test(pr)) usage();

  try {
    const result = rerunReviewVerdictGate(repo, pr, { workflow });
    console.log(result.message);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
