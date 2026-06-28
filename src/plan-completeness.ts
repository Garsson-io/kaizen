export type TrackingIssueState = 'OPEN' | 'CLOSED' | 'UNKNOWN';

export interface DeferredBehavior {
  behavior: string;
  trackingIssues: number[];
}

export interface PlanCompletenessFinding {
  requirement: string;
  status: 'DONE' | 'PARTIAL' | 'MISSING';
  detail: string;
}

export interface PlanCompletenessResult {
  totalBehaviors: number;
  deferredBehaviors: DeferredBehavior[];
  deferralRate: number;
  findings: PlanCompletenessFinding[];
}

function parseMarkdownTableRows(markdown: string): string[][] {
  const rows: string[][] = [];
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|') || !line.endsWith('|')) continue;
    if (/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line)) continue;
    const cells = line
      .slice(1, -1)
      .split('|')
      .map(cell => cell.trim());
    if (cells.length < 2) continue;
    rows.push(cells);
  }
  return rows;
}

function isHeaderRow(cells: string[]): boolean {
  const normalized = cells.map(cell => cell.toLowerCase());
  return normalized.includes('behavior') || normalized.includes('status') || normalized.includes('coverage');
}

function extractIssueNumbers(text: string): number[] {
  const matches = [...text.matchAll(/(?:^|[^\w])#(\d+)\b/g)];
  return [...new Set(matches.map(match => Number(match[1])).filter(Number.isInteger))];
}

export function parseDeferredBehaviors(testPlan: string): {
  totalBehaviors: number;
  deferredBehaviors: DeferredBehavior[];
} {
  const rows = parseMarkdownTableRows(testPlan).filter(cells => !isHeaderRow(cells));
  let totalBehaviors = 0;
  const deferredBehaviors: DeferredBehavior[] = [];

  for (const cells of rows) {
    const rowText = cells.join(' | ');
    if (!/[✅⏳]/u.test(rowText)) continue;
    totalBehaviors += 1;
    if (!rowText.includes('⏳')) continue;
    const behavior = cells.find(cell => cell && !/^H?\d+$/i.test(cell)) ?? rowText;
    deferredBehaviors.push({
      behavior,
      trackingIssues: extractIssueNumbers(rowText),
    });
  }

  if (totalBehaviors > 0) {
    return { totalBehaviors, deferredBehaviors };
  }

  const markerLines = testPlan
    .split('\n')
    .map(line => line.trim())
    .filter(line => /[✅⏳]/u.test(line));

  return {
    totalBehaviors: markerLines.length,
    deferredBehaviors: markerLines
      .filter(line => line.includes('⏳'))
      .map(line => ({ behavior: line, trackingIssues: extractIssueNumbers(line) })),
  };
}

export function evaluatePlanCompleteness(
  testPlan: string,
  issueState: (issue: number) => TrackingIssueState = () => 'UNKNOWN',
): PlanCompletenessResult {
  const parsed = parseDeferredBehaviors(testPlan);
  const findings: PlanCompletenessFinding[] = [];
  const deferralRate = parsed.totalBehaviors === 0
    ? 0
    : parsed.deferredBehaviors.length / parsed.totalBehaviors;

  if (parsed.deferredBehaviors.length === 0) {
    findings.push({
      requirement: 'No untracked deferred behaviors',
      status: 'DONE',
      detail: 'No test-plan behavior rows are marked deferred.',
    });
  }

  for (const deferred of parsed.deferredBehaviors) {
    if (deferred.trackingIssues.length === 0) {
      findings.push({
        requirement: `Deferred behavior is tracked: ${deferred.behavior}`,
        status: 'MISSING',
        detail: 'Behavior is marked ⏳ but does not name a tracking issue.',
      });
      continue;
    }

    const closed = deferred.trackingIssues.filter(issue => issueState(issue) === 'CLOSED');
    const unknown = deferred.trackingIssues.filter(issue => issueState(issue) === 'UNKNOWN');
    if (closed.length > 0) {
      findings.push({
        requirement: `Deferred behavior has open tracking issue: ${deferred.behavior}`,
        status: 'MISSING',
        detail: `Tracking issue(s) are closed or stale: ${closed.map(issue => `#${issue}`).join(', ')}.`,
      });
      continue;
    }
    if (unknown.length > 0) {
      findings.push({
        requirement: `Deferred behavior has verified tracking issue: ${deferred.behavior}`,
        status: 'PARTIAL',
        detail: `Tracking issue state could not be verified: ${unknown.map(issue => `#${issue}`).join(', ')}.`,
      });
      continue;
    }
    findings.push({
      requirement: `Deferred behavior has open tracking issue: ${deferred.behavior}`,
      status: 'DONE',
      detail: `Deferred behavior tracks open issue(s): ${deferred.trackingIssues.map(issue => `#${issue}`).join(', ')}.`,
    });
  }

  if (parsed.totalBehaviors > 0 && deferralRate > 0.3) {
    findings.push({
      requirement: 'Deferred behavior rate stays within review threshold',
      status: 'PARTIAL',
      detail: `${parsed.deferredBehaviors.length}/${parsed.totalBehaviors} behaviors are deferred (${Math.round(deferralRate * 100)}%); this is a scope-match warning.`,
    });
  }

  return {
    totalBehaviors: parsed.totalBehaviors,
    deferredBehaviors: parsed.deferredBehaviors,
    deferralRate,
    findings,
  };
}
