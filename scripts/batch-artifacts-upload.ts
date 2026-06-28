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
import {
  buildCappedBody,
  GITHUB_COMMENT_LIMIT,
  DEFAULT_BODY_BUDGET,
  type CappedBlock,
} from '../src/capped-attachment.js';

/** Named-attachment key on the progress issue. Sibling of `batch-outcome`. */
export const BATCH_ARTIFACTS_ATTACHMENT = 'batch-artifacts';

/**
 * Re-exported from the shared capper so existing importers (tests, callers)
 * keep their surface. GitHub's hard limit; the per-comment budget sits below it.
 */
export { GITHUB_COMMENT_LIMIT };
export const ARTIFACTS_BODY_BUDGET = DEFAULT_BODY_BUDGET;

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
 * Assemble the artifacts comment body from raw parts. PURE: time is injected so
 * the output is deterministic and testable (mirrors `buildBatchOutcome`). The
 * returned string carries NO marker — `writeAttachment` prepends it.
 *
 * Thin adapter over the shared {@link buildCappedBody}: it shapes the batch
 * artifacts into header + summary + two large blocks (events.jsonl, then
 * state.json) and lets the shared capper enforce {@link ARTIFACTS_BODY_BUDGET}
 * by head+tail-truncating the largest blocks, always preserving the header and
 * summary. Block ORDER is the truncation priority — events.jsonl first (an
 * append-only log, least structurally fragile), then state.json.
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

  const summary = parts.summary
    ? `### Batch Summary\n\n\`\`\`\n${parts.summary.trimEnd()}\n\`\`\``
    : null;

  const blocks: CappedBlock[] = [];
  if (parts.eventsJsonl) {
    blocks.push({
      label: `events.jsonl (${eventCount} events)`,
      fence: 'jsonl',
      content: parts.eventsJsonl.trimEnd(),
    });
  }
  if (parts.stateJson) {
    blocks.push({ label: 'state.json', fence: 'json', content: parts.stateJson.trimEnd() });
  }

  return buildCappedBody({
    header,
    summary,
    blocks,
    budget: ARTIFACTS_BODY_BUDGET,
    pointer: `logs/auto-dent/${batchId}`,
  });
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
