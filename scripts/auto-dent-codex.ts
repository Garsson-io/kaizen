/**
 * auto-dent-codex — script-facing compatibility exports for Codex provider helpers.
 */

export {
  assessCodexRun,
  assessCodexRunFields,
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
  type CodexRunAssessmentFields,
  type ParsedCodexJsonl,
} from '../src/codex-agent.js';
