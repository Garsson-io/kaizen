export interface ExploreConversionRun {
  mode?: string;
  issues_filed: string[];
  issues_closed: string[];
}

export interface ExploreExploitConversion {
  exploreIssuesFiled: number;
  exploreIssuesClosedByExploit: number;
  conversionRate: number;
}

function issueKey(ref: string): string | null {
  const match = ref.match(/(?:issues\/|#)?(\d+)\b/);
  return match ? match[1] : null;
}

export function computeExploreExploitConversion(history: ExploreConversionRun[]): ExploreExploitConversion {
  const exploreFiled = new Set<string>();
  const exploitClosed = new Set<string>();

  for (const run of history) {
    const mode = run.mode || 'exploit';
    if (mode === 'exploit') {
      for (const ref of run.issues_closed) {
        const key = issueKey(ref);
        if (key && exploreFiled.has(key)) exploitClosed.add(key);
      }
    }

    if (mode === 'explore') {
      for (const ref of run.issues_filed) {
        const key = issueKey(ref);
        if (key) exploreFiled.add(key);
      }
    }
  }

  return {
    exploreIssuesFiled: exploreFiled.size,
    exploreIssuesClosedByExploit: exploitClosed.size,
    conversionRate: exploreFiled.size > 0 ? exploitClosed.size / exploreFiled.size : 0,
  };
}

export function formatExploreExploitConversion(conversion: ExploreExploitConversion): string {
  const pct = Math.round(conversion.conversionRate * 100);
  return `${conversion.exploreIssuesClosedByExploit}/${conversion.exploreIssuesFiled} (${pct}%)`;
}
