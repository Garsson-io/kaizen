/**
 * hook-gym-format.ts — Human-readable timeline rendering for captured hook runs.
 *
 * Consumes a HookTimeline (from hook-gym-stream's processor) and produces the
 * Markdown block shape described in docs/hook-gym-spec.md. Used by cmdRun to
 * write `timeline.md` into each run's output directory and by cmdRunAll's
 * summary table.
 *
 * Pure function — no I/O, no clock. Deterministic output for a given input.
 */

import type { HookTimeline, ParsedHookEvent } from './hook-gym-schema.js';

/**
 * Format a HookTimeline as a Markdown block. Structure:
 *
 *   # Hook Timeline — <n> events · <ms>ms
 *
 *   | t (ms) | event          | hook                  | decision    | dur (ms) | reason    |
 *   |-------:|----------------|-----------------------|-------------|---------:|-----------|
 *   | 0      | SessionStart   | SessionStart:startup  | none        | 5        | —         |
 *   | ...
 *
 *   ## Gates
 *   - needs_review: activated @123ms, cleared @4567ms
 *   - needs_pr_kaizen: activated @2100ms (still active at run end)
 *
 * Gate ordering is deterministic (alphabetical by gate name). Events keep their
 * input order (already sorted by timestamp by createHookStreamProcessor).
 */
export function formatTimeline(timeline: HookTimeline): string {
  const events = timeline.events;
  const endMs = events.reduce((m, e) => Math.max(m, e.timestamp), 0);

  const out: string[] = [];
  out.push(`# Hook Timeline — ${events.length} event${events.length === 1 ? '' : 's'} · ${endMs}ms`);
  out.push('');

  if (events.length === 0) {
    out.push('_No hook events captured._');
  } else {
    const rows = events.map(renderEventRow);
    out.push('| t (ms) | event | hook | decision | dur (ms) | reason |');
    out.push('|-------:|-------|------|----------|---------:|--------|');
    for (const row of rows) out.push(row);
  }

  out.push('');
  out.push('## Gates');
  out.push('');

  const gateNames = new Set<string>([
    ...Object.keys(timeline.gatesActivated),
    ...Object.keys(timeline.gatesCleared),
  ]);
  if (gateNames.size === 0) {
    out.push('_No gates observed._');
  } else {
    const sorted = [...gateNames].sort();
    for (const name of sorted) {
      out.push(`- ${formatGateLine(name, timeline)}`);
    }
  }

  return out.join('\n') + '\n';
}

function renderEventRow(e: ParsedHookEvent): string {
  const decision = e.decision ?? 'none';
  const reason = e.reason ? truncate(e.reason, 60) : '—';
  const hook = e.hookName || e.eventType;
  return `| ${e.timestamp} | ${e.eventType} | ${escape(hook)} | ${decision} | ${e.durationMs} | ${escape(reason)} |`;
}

function formatGateLine(name: string, t: HookTimeline): string {
  const activated = t.gatesActivated[name];
  const cleared = t.gatesCleared[name];
  if (activated != null && cleared != null) {
    return `**${name}**: activated @${activated}ms, cleared @${cleared}ms`;
  }
  if (activated != null) {
    return `**${name}**: activated @${activated}ms (still active at run end)`;
  }
  if (cleared != null) {
    // clear without activation — happens when a run starts with a gate already
    // set from a prior session
    return `**${name}**: cleared @${cleared}ms (no activation observed this run)`;
  }
  return `**${name}**: (unknown)`;
}

function escape(s: string): string {
  // Escape pipe characters so we don't corrupt the table.
  return s.replace(/\|/g, '\\|');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/**
 * Produce a one-line summary for use in run-all summary tables:
 *
 *   "probe-hooks: 12 events · 2 gates · 4532ms"
 */
export function summarizeTimeline(name: string, timeline: HookTimeline): string {
  const gates = new Set<string>([
    ...Object.keys(timeline.gatesActivated),
    ...Object.keys(timeline.gatesCleared),
  ]).size;
  const endMs = timeline.events.reduce((m, e) => Math.max(m, e.timestamp), 0);
  return `${name}: ${timeline.events.length} events · ${gates} gates · ${endMs}ms`;
}
