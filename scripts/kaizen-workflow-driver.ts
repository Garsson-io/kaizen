#!/usr/bin/env npx tsx
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { currentBranch, makeGitRun, type GitRun } from '../src/issue-binding.js';
import { resolveProjectRoot } from '../src/lib/resolve-project-root.js';

export type WorkflowMode = 'manual' | 'exploit' | 'explore' | 'reflect' | 'subtract' | 'contemplate' | string;

export interface WorkflowIssueIdentity {
  number: number;
  title: string;
  url: string;
}

export interface ManualGoalInput {
  task: string;
  issue?: WorkflowIssueIdentity;
}

export type WorkflowStageState = 'done' | 'pending' | 'in_progress' | 'blocked' | 'not_applicable';

export interface WorkflowEvidenceInput {
  issueIdentity?: string;
  plan?: string;
  worktreeCase?: string;
  implementation?: string;
  dryRefactor?: string;
  meetReality?: string;
  review?: string;
  reflection?: string;
  prCiMergeCleanup?: string;
}

type ParsedArgs = Record<string, string | boolean | string[]>;

export interface WorkflowStatusInput {
  mode: WorkflowMode;
  issue?: WorkflowIssueIdentity;
  evidence?: WorkflowEvidenceInput;
}

export interface WorkflowEvidenceLookupInput {
  mode: WorkflowMode;
  repo?: string;
  issue?: WorkflowIssueIdentity;
  issueNumber?: string;
  projectRoot?: string;
  gitRun?: GitRun;
}

export interface WorkflowStageStatus {
  id: string;
  label: string;
  state: WorkflowStageState;
  evidence: string;
}

export interface WorkflowStatus {
  mode: WorkflowMode;
  issue?: WorkflowIssueIdentity;
  stages: WorkflowStageStatus[];
}

export const FULL_KAIZEN_GATE_LABELS = [
  'ticket identity',
  'plan/test-plan gate',
  'worktree/case gate',
  'implementation with tests',
  'related-area DRY/refactor pass',
  'meet reality',
  'review/requirements/impact gates',
  'reflection gate',
  'PR/CI/merge/cleanup',
] as const;

const STAGES = [
  ['issue-identity', 'ticket identity', 'issueIdentity'],
  ['plan-testplan', 'plan/test-plan gate', 'plan'],
  ['worktree-case', 'worktree/case gate', 'worktreeCase'],
  ['implementation-tests', 'implementation with tests', 'implementation'],
  ['dry-refactor', 'related-area DRY/refactor pass', 'dryRefactor'],
  ['meet-reality', 'meet reality', 'meetReality'],
  ['review-requirements-impact', 'review/requirements/impact gates', 'review'],
  ['reflection', 'reflection gate', 'reflection'],
  ['pr-ci-merge-cleanup', 'PR/CI/merge/cleanup', 'prCiMergeCleanup'],
] as const;

const CLI_EVIDENCE_KEYS: Record<string, keyof WorkflowEvidenceInput> = {
  'issue-identity': 'issueIdentity',
  plan: 'plan',
  'worktree-case': 'worktreeCase',
  implementation: 'implementation',
  'dry-refactor': 'dryRefactor',
  'meet-reality': 'meetReality',
  review: 'review',
  reflection: 'reflection',
  'pr-ci-merge-cleanup': 'prCiMergeCleanup',
};

const MODE_TERMINAL_EVIDENCE: Record<string, string> = {
  manual: 'ticket URL, PR URL, tests, review verdict, meet-reality output, reflection, and cleanup evidence',
  exploit: 'PR URL, tests, review verdict, meet-reality output, reflection, and cleanup/merge readiness',
  explore: 'issues filed, backlog findings, and AUTO_DENT_PHASE: REFLECT evidence',
  reflect: 'REFLECTION_INSIGHT markers, recommendations, and any meta-kaizen issues filed',
  subtract: 'lines deleted, issues pruned, PR URL when code changed, and Chesterton evidence',
  contemplate: 'strategic recommendations and the reasoning that changes future run selection',
};

function issueText(issue?: WorkflowIssueIdentity): string {
  if (!issue) return '';
  return `Ticket: #${issue.number} ${issue.title} (${issue.url})`;
}

function evidenceState(evidence: string | undefined): WorkflowStageState {
  if (!evidence || evidence.trim() === '') return 'pending';
  const lowered = evidence.toLowerCase();
  if (lowered.includes('blocked')) return 'blocked';
  if (lowered.includes('pending') || lowered.includes('in progress')) return 'in_progress';
  if (lowered.includes('not applicable') || lowered.includes('n/a')) return 'not_applicable';
  return 'done';
}

export function terminalEvidenceForMode(mode: WorkflowMode): string {
  return MODE_TERMINAL_EVIDENCE[String(mode)] ?? MODE_TERMINAL_EVIDENCE.exploit;
}

export function buildManualGoalDirective(input: ManualGoalInput): string {
  const ticket = issueText(input.issue);
  const task = input.task.trim();
  const objective = [
    ticket || `Task: ${task}`,
    `Complete the full kaizen workflow for ${ticket || task}.`,
    'The goal is not complete until every applicable gate is respected or honestly deferred through the existing gate mechanisms:',
    FULL_KAIZEN_GATE_LABELS.join(' -> '),
    'Do a related-area DRY/refactor pass to reduce competing mechanisms, schemas, and drift.',
    'Meet reality: try the PR/workflow, observe outputs and side effects, and record whether the ticket goal was achieved.',
  ].join(' ');
  return `/goal ${objective}`;
}

export function renderAutoDentGoalContract(mode: WorkflowMode): string {
  return [
    '## Headless /goal Equivalent',
    '',
    'This run is governed by the same forcing function as /goal: do not finish this run while applicable kaizen gates remain pending.',
    `Mode: ${mode}`,
    `Terminal evidence for this mode: ${terminalEvidenceForMode(mode)}.`,
    '',
    'Do not finish this run until the applicable workflow stages are complete or explicitly blocked:',
    `- ${FULL_KAIZEN_GATE_LABELS.join('\n- ')}`,
    '',
    'The related-area DRY/refactor pass is required for implementation work: reduce competing mechanisms, schemas, and drift in the area touched by the ticket.',
    'Meet reality before declaring done: try the PR/workflow, observe outputs and side effects, and record whether the original goal changed in reality.',
    '',
    'Harness terminal protocol:',
    '- Leave merge commands and auto-merge queueing to the auto-dent harness after review verdicts and process evidence are known.',
    '- Explicitly close every issue the PR fixes in the host repo after creating the PR; do not rely only on PR closing keywords for non-default-branch runs.',
    '- Emit AUTO_DENT_PHASE markers as real phases complete: PICK, EVALUATE, IMPLEMENT, TEST, PR, MERGE, DECOMPOSE, REFLECT.',
    '- Emit AUTO_DENT_PHASE: STOP | reason=<reason> only when meaningful matching work is genuinely exhausted, not at the end of a normal run.',
    '- When done, summarize PRs created, issues filed, issues closed, tests, review status, and any remaining blockers with full URLs.',
    '',
    'For status, use the reusable workflow status call:',
    '  npx tsx scripts/kaizen-workflow-driver.ts status --mode <mode> --issue <N> --repo <owner/repo>',
    'Pass explicit stage evidence when automation or skills have proof the CLI cannot infer, for example:',
    '  --dry-refactor "done: duplicated workflow schema removed" --meet-reality "done: CLI output inspected"',
  ].join('\n');
}

export function buildWorkflowStatus(input: WorkflowStatusInput): WorkflowStatus {
  const evidence = input.evidence ?? {};
  const stages = STAGES.map(([id, label, key]) => {
    const value = evidence[key as keyof WorkflowEvidenceInput];
    return {
      id,
      label,
      state: evidenceState(value),
      evidence: value && value.trim() ? value : 'No evidence recorded yet.',
    };
  });
  return { mode: input.mode, issue: input.issue, stages };
}

export function mergeWorkflowEvidence(
  collected: WorkflowEvidenceInput,
  overrides: WorkflowEvidenceInput,
): WorkflowEvidenceInput {
  return { ...collected, ...overrides };
}

function escapeMarkdownTableCell(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, '<br>')
    .replace(/\|/g, '\\|');
}

export function renderWorkflowStatusMarkdown(status: WorkflowStatus): string {
  const lines = ['## Kaizen Workflow Status', ''];
  if (status.issue) {
    lines.push(`Ticket: #${status.issue.number} ${status.issue.title}`);
    lines.push(`URL: ${status.issue.url}`);
    lines.push('');
  }
  lines.push(`Mode: ${status.mode}`);
  lines.push('');
  lines.push('| Stage | State | Evidence |');
  lines.push('|---|---|---|');
  for (const stage of status.stages) {
    lines.push(`| ${escapeMarkdownTableCell(stage.label)} | ${stage.state} | ${escapeMarkdownTableCell(stage.evidence)} |`);
  }
  return lines.join('\n');
}

function setParsedArg(parsed: ParsedArgs, key: string, value: string | boolean): void {
  const existing = parsed[key];
  if (existing === undefined) {
    parsed[key] = value;
  } else if (Array.isArray(existing)) {
    existing.push(String(value));
  } else {
    parsed[key] = [String(existing), String(value)];
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      setParsedArg(parsed, key, true);
    } else {
      setParsedArg(parsed, key, next);
      i++;
    }
  }
  return parsed;
}

function firstString(value: string | boolean | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.find((entry) => entry.trim() !== '');
  return undefined;
}

export function parseCliEvidenceOverrides(args: ParsedArgs): WorkflowEvidenceInput {
  const evidence: WorkflowEvidenceInput = {};
  for (const [argKey, evidenceKey] of Object.entries(CLI_EVIDENCE_KEYS)) {
    const value = firstString(args[argKey]);
    if (value && value.trim()) evidence[evidenceKey] = value.trim();
  }
  return evidence;
}

function fetchIssueIdentity(repo: string, issue: string): WorkflowIssueIdentity | undefined {
  const result = spawnSync('gh', ['issue', 'view', issue, '--repo', repo, '--json', 'number,title,url'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0 || !result.stdout.trim()) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as WorkflowIssueIdentity;
    if (parsed.number && parsed.title && parsed.url) return parsed;
  } catch {
    return undefined;
  }
  return undefined;
}

function defaultProjectRoot(): string {
  return resolveProjectRoot(dirname(fileURLToPath(import.meta.url)));
}

function runText(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

function hasStoredArtifact(kind: 'plan' | 'testplan', repo: string, issue: string, cwd: string): boolean {
  const command = kind === 'plan' ? 'retrieve-plan' : 'retrieve-testplan';
  const output = runText('npx', ['tsx', 'src/cli-structured-data.ts', command, '--issue', issue, '--repo', repo], cwd);
  if (!output) return false;
  return !/^No (plan|test plan) found\./i.test(output.trim());
}

function hasLocalChanges(run: GitRun): boolean {
  return run(['status', '--short']).stdout !== '';
}

function hasBranchCommits(run: GitRun): boolean {
  return run(['log', '--oneline', 'origin/main..HEAD']).stdout !== '';
}

export function collectWorkflowEvidence(input: WorkflowEvidenceLookupInput): WorkflowEvidenceInput {
  const evidence: WorkflowEvidenceInput = {};
  const projectRoot = input.projectRoot ?? defaultProjectRoot();
  const gitRun = input.gitRun ?? makeGitRun(projectRoot);
  const issue = input.issue;
  const issueNumber = input.issueNumber ?? (issue ? String(issue.number) : '');
  if (issue) {
    evidence.issueIdentity = `Issue #${issue.number} loaded from ${input.repo ?? 'repo'}: ${issue.title} (${issue.url})`;
  }
  if (input.repo && issueNumber && hasStoredArtifact('plan', input.repo, issueNumber, projectRoot) && hasStoredArtifact('testplan', input.repo, issueNumber, projectRoot)) {
    evidence.plan = `stored plan and test plan found for #${issueNumber}`;
  }

  const branch = currentBranch(gitRun);
  if (branch && branch !== 'main' && branch !== 'master') {
    evidence.worktreeCase = `working on branch ${branch}`;
  }
  if (hasBranchCommits(gitRun)) {
    evidence.implementation = 'branch has commits ahead of origin/main';
  } else if (hasLocalChanges(gitRun)) {
    evidence.implementation = 'in progress: local changes are present';
  }

  return evidence;
}

export function runCli(argv: string[]): number {
  const command = argv[0];
  const args = parseArgs(argv.slice(1));
  const mode = firstString(args.mode) ?? 'exploit';

  if (command === 'goal') {
    const task = firstString(args.task) ?? 'complete the requested kaizen work';
    const repo = firstString(args.repo) ?? '';
    const issueNum = firstString(args.issue) ?? '';
    const issue = repo && issueNum ? fetchIssueIdentity(repo, issueNum) : undefined;
    process.stdout.write(buildManualGoalDirective({ task, issue }) + '\n');
    return 0;
  }

  if (command === 'status') {
    const repo = firstString(args.repo) ?? '';
    const issueNum = firstString(args.issue) ?? '';
    const issue = repo && issueNum ? fetchIssueIdentity(repo, issueNum) : undefined;
    const collected = collectWorkflowEvidence({ mode, repo, issue, issueNumber: issueNum });
    const overrides = parseCliEvidenceOverrides(args);
    const status = buildWorkflowStatus({
      mode,
      issue,
      evidence: mergeWorkflowEvidence(collected, overrides),
    });
    process.stdout.write(renderWorkflowStatusMarkdown(status) + '\n');
    return 0;
  }

  if (command === 'contract') {
    process.stdout.write(renderAutoDentGoalContract(mode) + '\n');
    return 0;
  }

  process.stderr.write('Usage: kaizen-workflow-driver.ts <goal|status|contract> [--mode M] [--issue N] [--repo owner/repo] [--task text] [--dry-refactor evidence] [--meet-reality evidence]\n');
  return 1;
}

const isMain = process.argv[1]?.endsWith('kaizen-workflow-driver.ts') || process.argv[1]?.endsWith('kaizen-workflow-driver.js');
if (isMain) {
  process.exitCode = runCli(process.argv.slice(2));
}
