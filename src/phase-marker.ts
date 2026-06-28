/**
 * phase-marker.ts — the ONE formatter for `AUTO_DENT_PHASE` marker lines.
 *
 * Auto-dent agents and the store path emit structured progress markers that the
 * stream ingestor (`scripts/auto-dent-stream.ts` `parsePhaseMarkers`) reads back
 * into the work-cycle ledger and live console. Historically every emitter
 * hand-wrote the `AUTO_DENT_PHASE: X | k=v` string; the parser lived elsewhere.
 * This is the single emit-side source of truth so a producer can never format a
 * line the parser won't read (a round-trip test pins the two together, the same
 * "single constant shared by both sides" discipline as `BRANCH_PUSH_PENDING`).
 *
 * #1502: the `store-plan`/`store-testplan` CLI emits a `PLAN` marker through
 * here so the console can confirm a substantive plan/test-plan was stored, via a
 * structured signal rather than a prose regex over CLI output (I29).
 */

/** Line prefix the stream parser keys on. */
export const PHASE_MARKER_PREFIX = 'AUTO_DENT_PHASE';

/**
 * Format one marker line: `AUTO_DENT_PHASE: <PHASE> | k=v | k=v`. Undefined/empty
 * fields are dropped. Values must be single-line and `|`-free (URLs, issue refs,
 * short labels) — the parser splits on `|` and the first `=`.
 */
export function formatPhaseMarkerLine(
  phase: string,
  fields: Record<string, string | undefined | null> = {},
): string {
  const parts = [`${PHASE_MARKER_PREFIX}: ${phase}`];
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || v === '') continue;
    parts.push(`${k}=${v}`);
  }
  return parts.join(' | ');
}
