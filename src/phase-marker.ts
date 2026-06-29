import { z } from 'zod';

/**
 * phase-marker.ts — the ONE parser/formatter for `AUTO_DENT_PHASE` marker lines.
 *
 * Auto-dent agents and the store path emit structured progress markers that the
 * stream ingestor (`scripts/auto-dent-stream.ts` `parsePhaseMarkers`) reads back
 * into the work-cycle ledger and live console. Historically every emitter
 * hand-wrote the legacy `AUTO_DENT_PHASE: X | k=v` string; the parser lived
 * elsewhere. The emitter keeps that public protocol, while the parser also
 * accepts JSON payloads for machine-authored diagnostics.
 *
 * #1502: the `store-plan`/`store-testplan` CLI emits a `PLAN` marker through
 * here so the console can confirm a substantive plan/test-plan was stored, via a
 * structured signal rather than a prose regex over CLI output (I29).
 */

/** Line prefix the stream parser keys on. */
export const PHASE_MARKER_PREFIX = 'AUTO_DENT_PHASE';

export interface PhaseMarker {
  phase: string;
  fields: Record<string, string>;
}

export const PhaseMarkerSchema = z.object({
  phase: z.string().min(1),
  fields: z.record(z.string(), z.string()).default({}),
}).strict();

function parseJsonMarker(raw: string): PhaseMarker | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const marker = PhaseMarkerSchema.safeParse(parsed);
    return marker.success ? marker.data : null;
  } catch {
    return null;
  }
}

function parseLegacyMarker(raw: string): PhaseMarker | null {
  const match = raw.match(/^(\w+)(?:\s*\|(.+))?$/);
  if (!match) return null;
  const phase = match[1];
  const fields: Record<string, string> = {};

  if (match[2]) {
    for (const pair of match[2].split('|')) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx > 0) {
        fields[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
      }
    }
  }

  return { phase, fields };
}

export function parsePhaseMarkers(text: string): PhaseMarker[] {
  const markers: PhaseMarker[] = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith(`${PHASE_MARKER_PREFIX}:`)) continue;
    const raw = trimmed.slice(PHASE_MARKER_PREFIX.length + 1).trim();
    const marker = raw.startsWith('{') ? parseJsonMarker(raw) : parseLegacyMarker(raw);
    if (marker) markers.push(marker);
  }

  return markers;
}

/**
 * Format one marker line in the public legacy protocol:
 * `AUTO_DENT_PHASE: <PHASE> | k=v | k=v`. Undefined/empty fields are dropped.
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
