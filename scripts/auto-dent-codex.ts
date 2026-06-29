/**
 * auto-dent-codex — script-facing compatibility exports for Codex provider helpers.
 */

export {
  assessCodexRun,
  buildCodexExecArgs,
  extractCodexPhaseMarkers,
  hasCodexFailedTerminalEvent,
  hasCodexTerminalEvent,
  isCodexFailedTerminalEvent,
  isCodexTerminalEvent,
  normalizeCodexEventToStreamMessages,
  normalizeCodexFinalTextToStreamMessages,
  normalizeCodexProcessExitCode,
  parseCodexJsonl,
  type AutoDentStreamMessage,
  type CodexRunAssessment,
  type ParsedCodexJsonl,
} from '../src/codex-agent.js';
