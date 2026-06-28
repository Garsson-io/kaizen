/**
 * auto-dent-codex — script-facing compatibility exports for Codex provider helpers.
 */

export {
  buildCodexExecArgs,
  extractCodexPhaseMarkers,
  hasCodexFailedTerminalEvent,
  hasCodexTerminalEvent,
  isCodexFailedTerminalEvent,
  isCodexTerminalEvent,
  normalizeCodexEventToStreamMessages,
  normalizeCodexFinalTextToStreamMessages,
  parseCodexJsonl,
  type AutoDentStreamMessage,
  type ParsedCodexJsonl,
} from '../src/codex-agent.js';
