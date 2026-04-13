/**
 * gate-signal.ts — Canonical YAML gate signal schema.
 *
 * Every gate transition in the kaizen hook system emits a structured YAML
 * block alongside the human-readable message. This makes gate transitions
 * machine-parseable (by hook-gym, CI, telemetry) while keeping the output
 * readable by humans in the terminal.
 *
 * Format in hook stdout:
 *
 *   ---
 *   gate: needs_review
 *   action: set
 *   pr: https://github.com/.../pull/42
 *   round: 1
 *   reason: push_exceeds_threshold
 *   ---
 *   📋 PR created: ...
 *   MANDATORY SELF-REVIEW LOOP ...
 *
 * The YAML block is delimited by `---` on its own line. The parser looks
 * for this delimiter pair. Content after the closing `---` is the
 * human-readable message (unchanged from before this feature).
 */

import { z } from 'zod';
import YAML from 'yaml';

export const GateNameSchema = z.enum(['needs_review', 'needs_pr_kaizen', 'needs_post_merge']);
export type GateName = z.infer<typeof GateNameSchema>;

export const GateActionSchema = z.enum(['set', 'clear']);
export type GateAction = z.infer<typeof GateActionSchema>;

export const GateSignalSchema = z.object({
  gate: GateNameSchema,
  action: GateActionSchema,
  pr: z.string().optional(),
  round: z.number().int().positive().optional(),
  reason: z.string().optional(),
});
export type GateSignal = z.infer<typeof GateSignalSchema>;

/**
 * Format a gate signal as a YAML block delimited by `---`.
 * Returns the string to prepend to hook output.
 */
export function formatGateSignal(signal: GateSignal): string {
  const validated = GateSignalSchema.parse(signal);
  const obj: Record<string, unknown> = {
    gate: validated.gate,
    action: validated.action,
  };
  if (validated.pr) obj.pr = validated.pr;
  if (validated.round != null) obj.round = validated.round;
  if (validated.reason) obj.reason = validated.reason;
  return `---\n${YAML.stringify(obj).trimEnd()}\n---\n`;
}

/**
 * Try to extract a GateSignal from hook output text.
 * Returns the signal if found, null otherwise.
 * Looks for a YAML block delimited by `---` at the start of the text
 * or at the start of any line.
 */
export function parseGateSignal(text: string): GateSignal | null {
  const match = text.match(/^---\n([\s\S]*?\n)---/m);
  if (!match) return null;
  try {
    const parsed = YAML.parse(match[1]);
    const result = GateSignalSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
