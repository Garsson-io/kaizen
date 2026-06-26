/**
 * batch-artifacts-upload.ts — durable RAW batch artifacts on the progress issue
 * (#696, epic #842 "Rich Data on Disk, Nothing in the Cloud", #688).
 *
 * `closeBatchProgressIssue` already writes a *structured summary* `batch-outcome`
 * attachment (#1108) for cross-batch learning. But the **raw forensic data** —
 * the full `events.jsonl` and `state.json` produced on disk during the batch —
 * is never uploaded anywhere. When something goes wrong in an unattended batch,
 * the disk artifacts live on the machine that ran it; the cloud has nothing.
 *
 * This module closes that gap at the batch-finalize choke point. It inlines the
 * raw artifacts into a single idempotent marker comment on the progress issue,
 * reusing the same `writeAttachment` primitive every other kaizen attachment
 * uses — so re-running finalize edits the comment in place instead of posting a
 * duplicate (this is #696's idempotency requirement, solved structurally rather
 * than by hand-rolled comment-id bookkeeping).
 *
 * History: supersedes the orphaned `scripts/upload-batch-artifacts.sh` (PR #695),
 * which was never wired in. Its `update` mode re-wrote the issue *body* and would
 * have raced the TypeScript progress-issue writer (`auto-dent-run.ts` /
 * `auto-dent-stream.ts`); only its non-conflicting `finalize` artifacts dump is
 * carried forward here.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { writeAttachment } from '../src/section-editor.js';

/** Named-attachment key on the progress issue. Sibling of `batch-outcome`. */
export const BATCH_ARTIFACTS_ATTACHMENT = 'batch-artifacts';

/**
 * GitHub's hard limit for an issue-comment body. A POST/PATCH above this is
 * rejected outright, so the assembled comment MUST stay under it — large batches
 * (42KB state.json + 11KB events.jsonl + markdown overhead) can approach it.
 */
export const GITHUB_COMMENT_LIMIT = 65536;

/**
 * Effective budget for the artifacts body. Below the hard limit to leave room
 * for the `<!-- kaizen:batch-artifacts -->\n` marker `writeAttachment` prepends
 * plus a safety margin for any multi-byte accounting differences.
 */
export const ARTIFACTS_BODY_BUDGET = 64_000;

/** Raw artifact contents read off disk. `null` = the file was absent. */
export interface ArtifactParts {
  batchId: string;
  stateJson: string | null;
  eventsJsonl: string | null;
  summary: string | null;
}

function readIfExists(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

/**
 * Read the raw artifacts from a batch directory. Tolerant: any missing file
 * becomes `null` rather than throwing — a batch that died early may have a
 * state.json but no events.jsonl, or vice versa.
 */
export function readArtifactParts(batchDir: string): ArtifactParts {
  return {
    batchId: basename(batchDir),
    stateJson: readIfExists(join(batchDir, 'state.json')),
    eventsJsonl: readIfExists(join(batchDir, 'events.jsonl')),
    summary:
      readIfExists(join(batchDir, 'batch-summary.txt')) ??
      readIfExists(join(batchDir, 'batch-summary-report.md')),
  };
}

/**
 * Truncate `text` to at most `maxChars`, keeping a balanced head and tail and
 * dropping the middle with a marker that points back to the on-disk source.
 * Deterministic and line-aligned so truncated JSONL/JSON stays readable.
 */
function truncateMiddle(text: string, maxChars: number, batchId: string): string {
  if (text.length <= maxChars) return text;

  const lines = text.split('\n');
  const marker = (removed: number): string =>
    `... [${removed} lines truncated — full data on disk at logs/auto-dent/${batchId}] ...`;

  // Reserve space for the worst-case marker (all lines removed) + a newline.
  const reserve = marker(lines.length).length + 1;
  const budget = Math.max(0, maxChars - reserve);

  const head: string[] = [];
  const tail: string[] = [];
  let hi = 0;
  let ti = lines.length - 1;
  let used = 0;
  let takeHead = true;

  // Alternate taking from head and tail so the kept context is balanced.
  while (hi <= ti) {
    const line = takeHead ? lines[hi] : lines[ti];
    if (used + line.length + 1 > budget) break;
    used += line.length + 1;
    if (takeHead) {
      head.push(line);
      hi++;
    } else {
      tail.unshift(line);
      ti--;
    }
    takeHead = !takeHead;
  }

  const removed = ti - hi + 1;
  return [...head, marker(removed), ...tail].join('\n');
}

function detailsBlock(summary: string, fence: string, content: string): string {
  return `<details>\n<summary>${summary}</summary>\n\n\`\`\`${fence}\n${content}\n\`\`\`\n\n</details>`;
}

/**
 * Assemble the artifacts comment body from raw parts. PURE: time is injected so
 * the output is deterministic and testable (mirrors `buildBatchOutcome`). The
 * returned string carries NO marker — `writeAttachment` prepends it.
 *
 * Enforces {@link ARTIFACTS_BODY_BUDGET}: if the full body would exceed it, the
 * largest inlined block (events.jsonl, then state.json) is truncated head+tail
 * with a marker pointing at the on-disk copy. The human header + summary always
 * survive so the comment is never empty.
 */
export function buildArtifactsComment(parts: ArtifactParts, nowIso: string): string {
  const { batchId } = parts;
  const eventCount = parts.eventsJsonl
    ? parts.eventsJsonl.split('\n').filter((l) => l.trim().length > 0).length
    : 0;

  const header =
    `## Batch Artifacts: \`${batchId}\`\n\n` +
    `_Generated ${nowIso} — raw machine-readable forensic dump. ` +
    `Full data on disk at \`logs/auto-dent/${batchId}\`._`;

  const summaryBlock = parts.summary
    ? `### Batch Summary\n\n\`\`\`\n${parts.summary.trimEnd()}\n\`\`\``
    : null;

  // Fixed overhead = everything except the two large inlined blocks. Budget the
  // remaining room across events.jsonl + state.json.
  const sections: string[] = [header];
  if (summaryBlock) sections.push(summaryBlock);

  const fixed = sections.join('\n\n');
  const SEP = '\n\n';

  let eventsBlock = parts.eventsJsonl
    ? detailsBlock(`events.jsonl (${eventCount} events)`, 'jsonl', parts.eventsJsonl.trimEnd())
    : null;
  let stateBlock = parts.stateJson
    ? detailsBlock('state.json', 'json', parts.stateJson.trimEnd())
    : null;

  const assemble = (): string =>
    [fixed, eventsBlock, stateBlock].filter(Boolean).join(SEP);

  // Shrink the inlined raw blocks until the whole body fits the budget. Trim
  // events.jsonl first (append-only log, least structurally fragile), then
  // state.json. Block decoration (`<details>`/fences/summary) is ~120 chars; we
  // size the inner content against the remaining room and let truncateMiddle
  // keep it line-aligned.
  if (assemble().length > ARTIFACTS_BODY_BUDGET && parts.eventsJsonl) {
    const otherLen = [fixed, stateBlock].filter(Boolean).join(SEP).length;
    const room = ARTIFACTS_BODY_BUDGET - otherLen - 200;
    const inner = truncateMiddle(parts.eventsJsonl.trimEnd(), Math.max(0, room), batchId);
    eventsBlock = detailsBlock(`events.jsonl (${eventCount} events, truncated)`, 'jsonl', inner);
  }

  if (assemble().length > ARTIFACTS_BODY_BUDGET && parts.stateJson) {
    const otherLen = [fixed, eventsBlock].filter(Boolean).join(SEP).length;
    const room = ARTIFACTS_BODY_BUDGET - otherLen - 200;
    const inner = truncateMiddle(parts.stateJson.trimEnd(), Math.max(0, room), batchId);
    stateBlock = detailsBlock('state.json (truncated)', 'json', inner);
  }

  let body = assemble();

  // Final backstop: if decoration alone still overshoots (pathological), hard-cut.
  if (body.length > ARTIFACTS_BODY_BUDGET) {
    body =
      body.slice(0, ARTIFACTS_BODY_BUDGET - 80) +
      `\n\n... [comment truncated — full data on disk at logs/auto-dent/${batchId}] ...`;
  }

  return body;
}

/**
 * Read a batch's raw artifacts and write them as the idempotent `batch-artifacts`
 * attachment on the progress issue. Returns the comment URL, or `null` when the
 * batch directory has no artifacts to upload (nothing on disk yet).
 *
 * Best-effort by contract: callers wrap this so a GitHub failure never blocks
 * batch close. `nowIso` is injected for testability.
 */
export function uploadBatchArtifacts(
  issueNumber: string,
  repo: string,
  batchDir: string,
  nowIso: string,
): string | null {
  const parts = readArtifactParts(batchDir);
  if (!parts.stateJson && !parts.eventsJsonl && !parts.summary) return null;

  const body = buildArtifactsComment(parts, nowIso);
  return writeAttachment({ kind: 'issue', number: issueNumber, repo }, BATCH_ARTIFACTS_ATTACHMENT, body);
}
