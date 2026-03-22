/**
 * pr-pattern-checks.ts — Detect multi-PR fix cycles and related patterns.
 *
 * Analyzes PR metadata to find the "4-PR pattern" (FM2) where the same
 * feature requires multiple follow-up fix PRs.
 */

import { type PRRecord, type Detection, FailureMode } from './types.js';

/**
 * FM2: Detect multi-PR fix cycles.
 *
 * Finds clusters of PRs that:
 * - Touch the same files within a time window
 * - Reference the same issue/case
 * - Have "fix:" titles referencing the same area
 * - Are merged in rapid succession (< windowMs apart)
 */
export function detectMultiPRCycles(
  prs: PRRecord[],
  opts: { windowMs?: number; minClusterSize?: number } = {},
): Detection[] {
  const windowMs = opts.windowMs ?? 2 * 60 * 60 * 1000; // 2 hours
  const minClusterSize = opts.minClusterSize ?? 3;
  const detections: Detection[] = [];

  if (prs.length < minClusterSize) return detections;

  // Sort by merge time
  const sorted = [...prs].sort(
    (a, b) => new Date(a.mergedAt).getTime() - new Date(b.mergedAt).getTime(),
  );

  // Strategy 1: Same files touched in rapid succession
  const fileClusterDetections = detectFileOverlapClusters(
    sorted,
    windowMs,
    minClusterSize,
  );
  detections.push(...fileClusterDetections);

  // Strategy 2: Same issue referenced
  const issueClusterDetections = detectIssueReferenceClusters(
    sorted,
    windowMs,
    minClusterSize,
  );
  detections.push(...issueClusterDetections);

  // Strategy 3: Rapid-fire fix PRs (any "fix:" PRs within window)
  const fixChainDetections = detectFixChains(
    sorted,
    windowMs,
    minClusterSize,
  );
  detections.push(...fixChainDetections);

  return detections;
}

function detectFileOverlapClusters(
  prs: PRRecord[],
  windowMs: number,
  minSize: number,
): Detection[] {
  const detections: Detection[] = [];

  for (let i = 0; i < prs.length; i++) {
    const cluster: PRRecord[] = [prs[i]];
    const windowEnd = new Date(prs[i].mergedAt).getTime() + windowMs;

    for (let j = i + 1; j < prs.length; j++) {
      if (new Date(prs[j].mergedAt).getTime() > windowEnd) break;

      const overlap = fileOverlap(prs[i].changedFiles, prs[j].changedFiles);
      if (overlap > 0) {
        cluster.push(prs[j]);
      }
    }

    if (cluster.length >= minSize) {
      const prNums = cluster.map((p) => `#${p.number}`).join(', ');
      detections.push({
        mode: FailureMode.MULTI_PR_FIX_CYCLE,
        confidence: 85,
        location: prNums,
        detail: `${cluster.length} PRs touch overlapping files within ${windowMs / 3600000}h: ${prNums}. Likely iterating on a broken feature.`,
      });
      // Skip past this cluster to avoid duplicate detections
      i += cluster.length - 2;
      break;
    }
  }

  return detections;
}

function detectIssueReferenceClusters(
  prs: PRRecord[],
  windowMs: number,
  minSize: number,
): Detection[] {
  const detections: Detection[] = [];

  // Group PRs by linked issue
  const byIssue = new Map<number, PRRecord[]>();
  for (const pr of prs) {
    for (const issue of pr.linkedIssues) {
      const group = byIssue.get(issue) ?? [];
      group.push(pr);
      byIssue.set(issue, group);
    }
  }

  for (const [issue, group] of byIssue) {
    if (group.length < minSize) continue;

    // Check if they're within the time window
    const first = new Date(group[0].mergedAt).getTime();
    const last = new Date(group[group.length - 1].mergedAt).getTime();
    if (last - first <= windowMs) {
      const prNums = group.map((p) => `#${p.number}`).join(', ');
      detections.push({
        mode: FailureMode.MULTI_PR_FIX_CYCLE,
        confidence: 90,
        location: prNums,
        detail: `${group.length} PRs all reference issue #${issue} within ${windowMs / 3600000}h: ${prNums}. What test would have caught this before the first PR?`,
      });
    }
  }

  return detections;
}

function detectFixChains(
  prs: PRRecord[],
  windowMs: number,
  minSize: number,
): Detection[] {
  const detections: Detection[] = [];
  const fixPRs = prs.filter((p) =>
    /^fix[:(]/.test(p.title.toLowerCase()),
  );

  if (fixPRs.length < minSize) return detections;

  // Sliding window of rapid fix PRs
  for (let i = 0; i < fixPRs.length; i++) {
    const chain: PRRecord[] = [fixPRs[i]];
    const windowEnd = new Date(fixPRs[i].mergedAt).getTime() + windowMs;

    for (let j = i + 1; j < fixPRs.length; j++) {
      if (new Date(fixPRs[j].mergedAt).getTime() > windowEnd) break;
      chain.push(fixPRs[j]);
    }

    if (chain.length >= minSize) {
      const prNums = chain.map((p) => `#${p.number}`).join(', ');
      detections.push({
        mode: FailureMode.MULTI_PR_FIX_CYCLE,
        confidence: 80,
        location: prNums,
        detail: `${chain.length} "fix:" PRs merged within ${windowMs / 3600000}h: ${prNums}. Ship-then-fix spiral pattern.`,
      });
      i += chain.length - 2;
      break;
    }
  }

  return detections;
}

function fileOverlap(a: string[], b: string[]): number {
  const setA = new Set(a);
  return b.filter((f) => setA.has(f)).length;
}
