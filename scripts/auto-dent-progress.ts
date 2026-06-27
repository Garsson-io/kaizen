/**
 * Shared kaizen work-cycle progress rendering for auto-dent.
 *
 * Both in-flight stream comments and post-run progress issue comments use this
 * module so lifecycle row semantics cannot drift between operator surfaces.
 */

export interface RunProgressStep {
  phase: string;
  state: string;
  detail: string;
  url?: string;
}

export interface ProgressResult {
  prs: string[];
  cases: string[];
  pickedIssue?: string;
  pickedIssueTitle?: string;
  progressSteps?: RunProgressStep[];
  reviewVerdict?: 'pass' | 'fail' | 'skipped';
  reviewUrls?: string[];
  stopRequested: boolean;
  stopReason?: string;
}

export type ProgressUpsertMode = 'merge' | 'replace';

const PROGRESS_PHASE_ORDER = ['PICK', 'PLAN', 'EVALUATE', 'CASE', 'IMPLEMENT', 'TEST', 'PR', 'REVIEW', 'FIX', 'MERGE', 'REFLECT', 'CLEANUP', 'STOP'];
const SYNTHETIC_NOT_APPLICABLE_PHASES = new Set(['PLAN', 'EVALUATE', 'CASE', 'TEST', 'REVIEW', 'FIX', 'REFLECT', 'CLEANUP']);

export function formatIssueUrl(issue: string | undefined, repo: string): string {
  if (!issue) return '';
  if (/^https?:\/\//.test(issue)) return issue;
  const match = issue.match(/#?(\d+)/);
  if (!match || !repo) return issue;
  return `https://github.com/${repo}/issues/${match[1]}`;
}

export function formatIssueForDisplay(issue: string | undefined, repo: string, title?: string): string {
  const url = formatIssueUrl(issue, repo);
  if (!url) return 'unknown';
  return title ? `${url} — ${title}` : url;
}

export function formatReviewForDisplay(result: ProgressResult): string {
  if (result.pickedIssue === 'not applicable') {
    const urls = result.prs.length > 0 ? ` (${result.prs.join(', ')})` : '';
    return `not applicable${urls}`;
  }
  const verdict = result.reviewVerdict ?? (result.prs.length > 0 ? 'pending' : 'skipped');
  const urls = result.reviewUrls && result.reviewUrls.length > 0 ? result.reviewUrls : result.prs;
  return urls.length > 0 ? `${verdict} (${urls.join(', ')})` : verdict;
}

export function upsertProgressStep(
  result: ProgressResult,
  step: RunProgressStep,
  mode: ProgressUpsertMode = 'merge',
): void {
  result.progressSteps = result.progressSteps || [];
  const existing = result.progressSteps.find((s) => s.phase === step.phase);
  if (!existing) {
    result.progressSteps.push(step);
    return;
  }
  if (mode === 'replace') {
    existing.state = step.state;
    existing.detail = step.detail;
    existing.url = step.url;
    return;
  }
  existing.state = step.state || existing.state;
  existing.detail = step.detail || existing.detail;
  existing.url = step.url || existing.url;
}

function orderedProgressSteps(steps: RunProgressStep[]): RunProgressStep[] {
  return [...steps].sort((a, b) => {
    const ai = PROGRESS_PHASE_ORDER.indexOf(a.phase);
    const bi = PROGRESS_PHASE_ORDER.indexOf(b.phase);
    const ao = ai === -1 ? PROGRESS_PHASE_ORDER.length : ai;
    const bo = bi === -1 ? PROGRESS_PHASE_ORDER.length : bi;
    return ao - bo;
  });
}

export function buildKaizenCycleSteps(result: ProgressResult, repo = ''): RunProgressStep[] {
  const existing = new Map<string, RunProgressStep>();
  for (const step of result.progressSteps || []) {
    existing.set(step.phase, step);
  }
  const synthetic = result.pickedIssue === 'not applicable';
  const issueDetail = formatIssueForDisplay(result.pickedIssue, repo, result.pickedIssueTitle);
  const prDetail = result.prs.join(', ');
  const caseDetail = result.cases.join(', ');

  const defaults: RunProgressStep[] = [
    {
      phase: 'PICK',
      state: synthetic ? 'not applicable' : result.pickedIssue ? 'selected' : 'not observed',
      detail: synthetic ? (result.pickedIssueTitle || 'synthetic task') : (result.pickedIssue ? issueDetail : ''),
      url: synthetic ? undefined : formatIssueUrl(result.pickedIssue, repo),
    },
    { phase: 'PLAN', state: synthetic ? 'not applicable' : 'not observed', detail: synthetic ? 'synthetic test task' : '' },
    { phase: 'EVALUATE', state: synthetic ? 'not applicable' : 'not observed', detail: synthetic ? 'synthetic test task' : '' },
    {
      phase: 'CASE',
      state: synthetic ? 'not applicable' : result.cases.length > 0 ? 'created' : 'not observed',
      detail: synthetic ? 'synthetic test task' : caseDetail,
    },
    { phase: 'IMPLEMENT', state: synthetic && result.prs.length > 0 ? 'done' : 'not observed', detail: synthetic && result.prs.length > 0 ? 'synthetic file committed' : '' },
    { phase: 'TEST', state: synthetic ? 'not applicable' : 'not observed', detail: synthetic ? 'pipeline probe, not product tests' : '' },
    {
      phase: 'PR',
      state: result.prs.length > 0 ? 'created' : 'not observed',
      detail: prDetail,
      url: result.prs[0],
    },
    {
      phase: 'REVIEW',
      state: synthetic ? 'not applicable' : result.reviewVerdict || (result.prs.length > 0 ? 'pending' : 'not observed'),
      detail: synthetic ? 'synthetic test task' : formatReviewForDisplay(result),
      url: result.reviewUrls?.[0] || result.prs[0],
    },
    {
      phase: 'FIX',
      state: synthetic ? 'not applicable' : result.reviewVerdict === 'pass' || result.reviewVerdict === 'skipped' ? 'not needed' : 'not observed',
      detail: synthetic ? 'synthetic test task' : '',
    },
    { phase: 'MERGE', state: result.prs.length > 0 ? 'not observed' : 'not applicable', detail: prDetail, url: result.prs[0] },
    { phase: 'REFLECT', state: synthetic ? 'not applicable' : 'not observed', detail: synthetic ? 'synthetic test task' : '' },
    { phase: 'CLEANUP', state: synthetic ? 'not applicable' : 'not observed', detail: synthetic ? 'synthetic test task' : '' },
    { phase: 'STOP', state: result.stopRequested ? 'requested' : 'not requested', detail: result.stopReason || '' },
  ];

  for (const step of defaults) {
    const observed = existing.get(step.phase);
    if (!observed) continue;
    if (synthetic && SYNTHETIC_NOT_APPLICABLE_PHASES.has(step.phase)) {
      continue;
    }
    step.state = observed.state || step.state;
    step.detail = observed.detail || step.detail;
    step.url = observed.url || step.url;
  }
  return orderedProgressSteps(defaults);
}

export function formatProgressStepsMarkdown(result: ProgressResult, repo = ''): string {
  const lines = [
    `#### Kaizen Work Cycle`,
    '',
    `| Step | State | Detail | Link |`,
    `|------|-------|--------|------|`,
  ];
  for (const step of buildKaizenCycleSteps(result, repo)) {
    lines.push(`| ${step.phase} | ${step.state} | ${step.detail || '-'} | ${step.url || '-'} |`);
  }
  return lines.join('\n');
}
