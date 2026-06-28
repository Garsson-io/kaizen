/**
 * capped-attachment.ts — the ONE home for assembling a GitHub-comment-bounded
 * body from named blocks, head+tail-truncating the largest blocks until the
 * whole thing fits, with a pointer back to the full data on disk.
 *
 * History: this logic was born private inside `scripts/batch-artifacts-upload.ts`
 * (#696). When the run-transcript attachment (#1508) needed the identical
 * "cap to GitHub's comment limit" dance, copying it would have spawned a second
 * capper that drifts from the first — the exact failure mode the #1385
 * truncate-helper ratchet exists to prevent. So it was hoisted here and both
 * callers (`buildArtifactsComment`, `buildTranscriptComment`) now share it.
 *
 * Pure + deterministic: no clock, no I/O. Callers inject any timestamps.
 */

/**
 * GitHub's hard limit for an issue/PR-comment body. A POST/PATCH above this is
 * rejected outright, so any assembled comment MUST stay under it.
 */
export const GITHUB_COMMENT_LIMIT = 65536;

/**
 * Default effective budget for an attachment body. Below the hard limit to
 * leave room for the `<!-- kaizen:<name> -->\n` marker `writeAttachment`
 * prepends plus a safety margin for multi-byte accounting differences.
 */
export const DEFAULT_BODY_BUDGET = 64_000;

/** A large, truncatable block rendered inside a collapsed `<details>`. */
export interface CappedBlock {
  /** `<summary>` label, e.g. `events.jsonl (3 events)`. */
  label: string;
  /** Fenced-code language, e.g. `jsonl`, `json`, `text`. */
  fence: string;
  /** Raw block content (already trimmed by the caller if desired). */
  content: string;
}

export interface CappedBodyOptions {
  /** Always-kept header (markdown). Survives every truncation. */
  header: string;
  /** Optional always-kept summary block (pre-rendered markdown), or null. */
  summary?: string | null;
  /** Large blocks, truncated in order (first = least structurally fragile). */
  blocks: CappedBlock[];
  /** Max body length. Defaults to {@link DEFAULT_BODY_BUDGET}. */
  budget?: number;
  /**
   * Human-readable on-disk location of the full data, e.g.
   * `logs/auto-dent/<batchId>`. Embedded in every truncation marker so a reader
   * of the truncated comment knows where the complete artifact lives.
   */
  pointer: string;
}

/**
 * Truncate `text` to at most `maxChars`, keeping a balanced head and tail and
 * dropping the middle with a marker that points back to the on-disk source.
 * Deterministic and line-aligned so truncated JSONL/JSON stays readable.
 */
export function truncateMiddle(
  text: string,
  maxChars: number,
  pointer: string,
): string {
  if (text.length <= maxChars) return text;

  const lines = text.split('\n');
  const marker = (removed: number): string =>
    `... [${removed} lines truncated — full data on disk at ${pointer}] ...`;

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

/** Render one block as a collapsed `<details>` with a fenced code body. */
export function detailsBlock(
  summary: string,
  fence: string,
  content: string,
): string {
  return `<details>\n<summary>${summary}</summary>\n\n\`\`\`${fence}\n${content}\n\`\`\`\n\n</details>`;
}

const SEP = '\n\n';

/**
 * Assemble a size-bounded comment body. The `header` (and `summary`, if present)
 * always survive; the large `blocks` are truncated head+tail in order until the
 * whole body fits `budget`. A final hard-cut backstop guarantees the result is
 * never above budget even in pathological cases (decoration alone overshoots).
 */
export function buildCappedBody(opts: CappedBodyOptions): string {
  const budget = opts.budget ?? DEFAULT_BODY_BUDGET;
  const fixedParts = [opts.header, opts.summary].filter(Boolean) as string[];
  const fixed = fixedParts.join(SEP);

  // Rendered, truncatable blocks (parallel to opts.blocks).
  const rendered = opts.blocks.map((b) => detailsBlock(b.label, b.fence, b.content));

  const assemble = (): string => [fixed, ...rendered].filter(Boolean).join(SEP);

  // Truncate blocks in order until the whole body fits. Block decoration
  // (`<details>`/fences/summary) is ~120 chars; we size the inner content
  // against the room left by everything else and let truncateMiddle keep it
  // line-aligned.
  for (let i = 0; i < opts.blocks.length; i++) {
    if (assemble().length <= budget) break;
    const others = [fixed, ...rendered.filter((_, j) => j !== i)]
      .filter(Boolean)
      .join(SEP);
    const room = budget - others.length - 200;
    const inner = truncateMiddle(opts.blocks[i].content, Math.max(0, room), opts.pointer);
    rendered[i] = detailsBlock(`${opts.blocks[i].label} (truncated)`, opts.blocks[i].fence, inner);
  }

  let body = assemble();

  // Final backstop: if decoration alone still overshoots (pathological), hard-cut.
  // Reserve the EXACT suffix length (it scales with the pointer) so the result is
  // provably ≤ budget, not budget + pointer.length.
  if (body.length > budget) {
    const suffix = `\n\n... [comment truncated — full data on disk at ${opts.pointer}] ...`;
    body = body.slice(0, Math.max(0, budget - suffix.length)) + suffix;
  }

  return body;
}
