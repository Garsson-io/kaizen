/**
 * waiver-blocklist.ts — Shared generic waiver blocklist.
 *
 * Used by both pr-kaizen-clear (hook enforcement) and
 * reflection-checks (analysis/detection). Single source of truth
 * prevents drift (kaizen #446, DRY fix).
 *
 * Sourced from real incidents: #388, #280, #258.
 */

export const GENERIC_WAIVER_BLOCKLIST = [
  'overengineering',
  'over-engineering',
  'low frequency',
  'self-correcting',
  'acceptable tradeoff',
  'acceptable trade-off',
  'not worth it',
  'too complex',
  'diminishing returns',
  'edge case',
  'minor issue',
  'cosmetic',
] as const;

/** Check if a no-action reason matches the blocklist. Returns matched term or null. */
export function matchesWaiverBlocklist(reason: string): string | null {
  const lower = reason.toLowerCase();
  for (const blocked of GENERIC_WAIVER_BLOCKLIST) {
    if (lower.includes(blocked)) return blocked;
  }
  return null;
}
