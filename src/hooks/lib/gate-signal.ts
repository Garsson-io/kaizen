/**
 * gate-signal.ts — Canonical YAML hook output schema.
 *
 * EVERY hook that emits text MUST use this schema. One parser understands
 * all hook output. The YAML IS the human-readable output — no separate
 * prose needed.
 *
 * Format:
 *
 *   ---
 *   hook: pr-review-loop
 *   type: gate-set
 *   gate: needs_review
 *   pr: https://github.com/.../pull/42
 *   round: 1
 *   reason: PR created — run /kaizen-review-pr
 *   ---
 *
 * Types:
 *   gate-set   — gate activated (needs_review, needs_pr_kaizen, needs_post_merge)
 *   gate-clear — gate deactivated
 *   deny       — tool use denied (PreToolUse)
 *   warn       — advisory warning (non-blocking)
 *   block      — session stop blocked (Stop hook)
 *   info       — informational output (version bump, timing, etc.)
 */

import { z } from 'zod';
import {
  formatDelimitedYamlBlock,
  parseDelimitedYamlBlocks,
  parseFirstDelimitedYamlBlock,
} from '../../lib/yaml-block.js';

export const GateNameSchema = z.enum(['needs_review', 'needs_pr_kaizen', 'needs_post_merge']);
export type GateName = z.infer<typeof GateNameSchema>;

export const HookOutputTypeSchema = z.enum(['gate-set', 'gate-clear', 'deny', 'warn', 'block', 'info']);
export type HookOutputType = z.infer<typeof HookOutputTypeSchema>;

export const HookOutputSchema = z.object({
  hook: z.string(),
  type: HookOutputTypeSchema,
  gate: GateNameSchema.optional(),
  pr: z.string().optional(),
  round: z.number().int().positive().optional(),
  reason: z.string(),
});
export type HookOutput = z.infer<typeof HookOutputSchema>;

// Backward-compat alias — gate signals are just HookOutput with type gate-set/gate-clear
export type GateSignal = HookOutput;
export const GateSignalSchema = HookOutputSchema;

/**
 * Format a hook output as a YAML block delimited by `---`.
 */
export function formatHookOutput(output: HookOutput): string {
  const validated = HookOutputSchema.parse(output);
  const obj: Record<string, unknown> = {
    hook: validated.hook,
    type: validated.type,
  };
  if (validated.gate) obj.gate = validated.gate;
  if (validated.pr) obj.pr = validated.pr;
  if (validated.round != null) obj.round = validated.round;
  obj.reason = validated.reason;
  return formatDelimitedYamlBlock(obj);
}

// Convenience alias for gate signals
export const formatGateSignal = formatHookOutput;

/**
 * Try to extract a HookOutput from hook output text.
 * Returns the parsed output if found, null otherwise.
 */
export function parseHookOutput(text: string): HookOutput | null {
  const parsed = parseFirstDelimitedYamlBlock(text);
  if (!parsed) return null;
  const result = HookOutputSchema.safeParse(parsed.data);
  return result.success ? result.data : null;
}

/**
 * Extract every valid HookOutput YAML block from mixed hook output text.
 */
export function parseHookOutputs(text: string): HookOutput[] {
  const outputs: HookOutput[] = [];
  for (const block of parseDelimitedYamlBlocks(text)) {
    const result = HookOutputSchema.safeParse(block.data);
    if (result.success) outputs.push(result.data);
  }
  return outputs;
}

// Convenience alias
export const parseGateSignal = parseHookOutput;
