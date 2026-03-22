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

  const windowHours = windowMs / 3600000;

  detections.push(
    ...detectFileOverlapClusters(sorted, windowMs, minClusterSize, windowHours),
    ...detectIssueReferenceClusters(sorted, windowMs, minClusterSize, windowHours),
    ...detectFixChains(sorted, windowMs, minClusterSize, windowHours),
  );

  return detections;
}

function formatPRNums(prs: PRRecord[]): string {
  return prs.map((p) => `#${p.number}`).join(', ');
}

function detectFileOverlapClusters(
  prs: PRRecord[],
  windowMs: number,
  minSize: number,
  windowHours: number,
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
      const prNums = formatPRNums(cluster);
      detections.push({
        mode: FailureMode.MULTI_PR_FIX_CYCLE,
        confidence: 85,
        location: prNums,
        detail: `${cluster.length} PRs touch overlapping files within ${windowHours}h: ${prNums}. Likely iterating on a broken feature.`,
      });
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
  windowHours: number,
): Detection[] {
  const detections: Detection[] = [];

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

    const first = new Date(group[0].mergedAt).getTime();
    const last = new Date(group[group.length - 1].mergedAt).getTime();
    if (last - first <= windowMs) {
      const prNums = formatPRNums(group);
      detections.push({
        mode: FailureMode.MULTI_PR_FIX_CYCLE,
        confidence: 90,
        location: prNums,
        detail: `${group.length} PRs all reference issue #${issue} within ${windowHours}h: ${prNums}. What test would have caught this before the first PR?`,
      });
    }
  }

  return detections;
}

function detectFixChains(
  prs: PRRecord[],
  windowMs: number,
  minSize: number,
  windowHours: number,
): Detection[] {
  const detections: Detection[] = [];
  const fixPRs = prs.filter((p) =>
    /^fix[:(]/.test(p.title.toLowerCase()),
  );

  if (fixPRs.length < minSize) return detections;

  for (let i = 0; i < fixPRs.length; i++) {
    const chain: PRRecord[] = [fixPRs[i]];
    const windowEnd = new Date(fixPRs[i].mergedAt).getTime() + windowMs;

    for (let j = i + 1; j < fixPRs.length; j++) {
      if (new Date(fixPRs[j].mergedAt).getTime() > windowEnd) break;
      chain.push(fixPRs[j]);
    }

    if (chain.length >= minSize) {
      const prNums = formatPRNums(chain);
      detections.push({
        mode: FailureMode.MULTI_PR_FIX_CYCLE,
        confidence: 80,
        location: prNums,
        detail: `${chain.length} "fix:" PRs merged within ${windowHours}h: ${prNums}. Ship-then-fix spiral pattern.`,
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
