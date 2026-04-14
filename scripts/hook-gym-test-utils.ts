import type { ParsedHookEvent } from './hook-gym-schema.js';

/**
 * Create a ParsedHookEvent with sensible defaults for testing.
 * Override any field via the partial parameter.
 */
export function evt(partial: Partial<ParsedHookEvent>): ParsedHookEvent {
  return {
    timestamp: 0,
    eventType: 'PreToolUse',
    hookId: 'h1',
    hookName: 'PreToolUse:Bash',
    durationMs: 5,
    exitCode: 0,
    outcome: 'success',
    decision: 'none',
    reason: null,
    rawOutput: '',
    stderr: null,
    ...partial,
  };
}
