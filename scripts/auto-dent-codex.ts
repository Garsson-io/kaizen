/**
 * auto-dent-codex — script-facing compatibility exports for Codex provider helpers.
 */

export {
  buildCodexExecArgs,
  extractCodexPhaseMarkers,
  hasCodexTerminalEvent,
  normalizeCodexEventToStreamMessages,
  normalizeCodexFinalTextToStreamMessages,
  parseCodexJsonl,
  type AutoDentStreamMessage,
  type ParsedCodexJsonl,
} from '../src/codex-agent.js';
