/**
 * auto-dent-codex — script-facing compatibility exports for Codex provider helpers.
 */

export {
  buildCodexExecArgs,
  extractCodexPhaseMarkers,
  hasCodexTerminalEvent,
  isCodexTerminalEvent,
  normalizeCodexEventToStreamMessages,
  normalizeCodexFinalTextToStreamMessages,
  parseCodexJsonl,
  type AutoDentStreamMessage,
  type ParsedCodexJsonl,
} from '../src/codex-agent.js';
