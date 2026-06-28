#!/usr/bin/env npx tsx
import { spawnSync } from 'node:child_process';

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
    'For status, use the reusable workflow status call:',
    '  npx tsx scripts/kaizen-workflow-driver.ts status --mode <mode> --issue <N> --repo <owner/repo>',
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
    lines.push(`| ${stage.label} | ${stage.state} | ${stage.evidence.replace(/\|/g, '\\|')} |`);
  }
  return lines.join('\n');
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i++;
    }
  }
  return parsed;
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

function runText(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

function hasStoredArtifact(kind: 'plan' | 'testplan', repo: string, issue: string): boolean {
  const command = kind === 'plan' ? 'retrieve-plan' : 'retrieve-testplan';
  const output = runText('npx', ['tsx', 'src/cli-structured-data.ts', command, '--issue', issue, '--repo', repo]);
  if (!output) return false;
  return !/^No (plan|test plan) found\./i.test(output.trim());
}

function currentBranch(): string {
  return runText('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
}

function hasLocalChanges(): boolean {
  return runText('git', ['status', '--short']) !== '';
}

function hasBranchCommits(): boolean {
  const output = runText('git', ['log', '--oneline', 'origin/main..HEAD']);
  return output !== '';
}

export function collectWorkflowEvidence(input: WorkflowEvidenceLookupInput): WorkflowEvidenceInput {
  const evidence: WorkflowEvidenceInput = {};
  const issue = input.issue;
  const issueNumber = input.issueNumber ?? (issue ? String(issue.number) : '');
  if (issue) {
    evidence.issueIdentity = `Issue #${issue.number} loaded from ${input.repo ?? 'repo'}: ${issue.title} (${issue.url})`;
  }
  if (input.repo && issueNumber && hasStoredArtifact('plan', input.repo, issueNumber) && hasStoredArtifact('testplan', input.repo, issueNumber)) {
    evidence.plan = `stored plan and test plan found for #${issueNumber}`;
  }

  const branch = currentBranch();
  if (branch && branch !== 'main' && branch !== 'master') {
    evidence.worktreeCase = `working on branch ${branch}`;
  }
  if (hasBranchCommits()) {
    evidence.implementation = 'branch has commits ahead of origin/main';
  } else if (hasLocalChanges()) {
    evidence.implementation = 'in progress: local changes are present';
  }

  return evidence;
}

export function runCli(argv: string[]): number {
  const command = argv[0];
  const args = parseArgs(argv.slice(1));
  const mode = typeof args.mode === 'string' ? args.mode : 'exploit';

  if (command === 'goal') {
    const task = typeof args.task === 'string' ? args.task : 'complete the requested kaizen work';
    const repo = typeof args.repo === 'string' ? args.repo : '';
    const issueNum = typeof args.issue === 'string' ? args.issue : '';
    const issue = repo && issueNum ? fetchIssueIdentity(repo, issueNum) : undefined;
    process.stdout.write(buildManualGoalDirective({ task, issue }) + '\n');
    return 0;
  }

  if (command === 'status') {
    const repo = typeof args.repo === 'string' ? args.repo : '';
    const issueNum = typeof args.issue === 'string' ? args.issue : '';
    const issue = repo && issueNum ? fetchIssueIdentity(repo, issueNum) : undefined;
    const status = buildWorkflowStatus({
      mode,
      issue,
      evidence: collectWorkflowEvidence({ mode, repo, issue, issueNumber: issueNum }),
    });
    process.stdout.write(renderWorkflowStatusMarkdown(status) + '\n');
    return 0;
  }

  if (command === 'contract') {
    process.stdout.write(renderAutoDentGoalContract(mode) + '\n');
    return 0;
  }

  process.stderr.write('Usage: kaizen-workflow-driver.ts <goal|status|contract> [--mode M] [--issue N] [--repo owner/repo] [--task text]\n');
  return 1;
}

const isMain = process.argv[1]?.endsWith('kaizen-workflow-driver.ts') || process.argv[1]?.endsWith('kaizen-workflow-driver.js');
if (isMain) {
  process.exitCode = runCli(process.argv.slice(2));
}
