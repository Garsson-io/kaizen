/**
 * transcript-attach.ts — attach a scrubbed, size-capped session/run JSONL
 * transcript to a PR as a durable, minable artifact (#1508).
 *
 * Every claude/codex session emits a full JSONL transcript — the richest record
 * of how the work actually went (tool calls, dead-ends, CLI fumbles, gate
 * dances). Auto-dent already persists it on disk (the per-run logFile), and
 * manual sessions have the provider transcript. Until now it was discarded for
 * reflection: impediments were grounded in the agent's *memory* of friction, not
 * the data. This attaches the transcript where `/kaizen-gaps`, reflection, and
 * future mining can reach it.
 *
 * Sibling of the `batch-artifacts` attachment (#696): same idempotent
 * `writeAttachment` primitive, same shared {@link buildCappedBody} capper (one
 * capper, no drift), with scrubbing layered in front (I19, fail closed).
 */

import { writeAttachment, type AttachmentTarget } from './section-editor.js';
import { buildCappedBody, type CappedBlock } from './capped-attachment.js';
import { scrubSecrets } from './scrub-secrets.js';

/** Named-attachment key on the PR. Sibling of `batch-artifacts`. */
export const RUN_TRANSCRIPT_ATTACHMENT = 'run-transcript';

export interface TranscriptParts {
  /** Human label for the transcript source (run id, session id, or "manual"). */
  label: string;
  /** Raw JSONL transcript text (unscrubbed). */
  transcript: string;
  /** On-disk path to the full transcript — embedded in the truncation pointer. */
  sourcePath: string;
}

export interface TranscriptComment {
  /** Assembled comment body (marker prepended later by `writeAttachment`). */
  body: string;
  /** Redactions applied by the scrubber (-1 = scrub failed → content withheld). */
  redactions: number;
}

/**
 * Build the scrubbed, size-bounded transcript comment body. PURE: `nowIso` is
 * injected for determinism. The transcript is scrubbed FIRST (so even truncation
 * markers never carry a secret), then capped via the shared capper.
 */
export function buildTranscriptComment(parts: TranscriptParts, nowIso: string): TranscriptComment {
  const scrub = scrubSecrets(parts.transcript);
  const lineCount = scrub.text.split('\n').filter((l) => l.trim().length > 0).length;

  const header =
    `## Session Transcript: \`${parts.label}\`\n\n` +
    `_Generated ${nowIso} — scrubbed JSONL transcript for friction/optimization ` +
    `mining (#1508). ${scrub.redactions} secret(s) redacted. ` +
    `Full data on disk at \`${parts.sourcePath}\`._`;

  const block: CappedBlock = {
    label: `transcript.jsonl (${lineCount} lines)`,
    fence: 'jsonl',
    content: scrub.text.trimEnd(),
  };

  const body = buildCappedBody({ header, blocks: [block], pointer: parts.sourcePath });
  return { body, redactions: scrub.redactions };
}

/**
 * Attach the scrubbed, capped transcript to `target` (a PR or issue) as the
 * idempotent `run-transcript` attachment. Returns the comment URL. `nowIso` and
 * `write` are injectable for tests; the default `write` is the real GitHub path.
 */
export function attachTranscript(
  target: AttachmentTarget,
  parts: TranscriptParts,
  nowIso: string,
  write: (t: AttachmentTarget, name: string, body: string) => string = writeAttachment,
): string {
  const { body } = buildTranscriptComment(parts, nowIso);
  return write(target, RUN_TRANSCRIPT_ATTACHMENT, body);
}
