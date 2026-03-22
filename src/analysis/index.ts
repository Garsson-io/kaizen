export { FailureMode } from './types.js';
export type {
  Detection,
  DiffFile,
  PRRecord,
  Impediment,
  SyntheticScenario,
  DiffScenario,
  ReflectionScenario,
  PRHistoryScenario,
  Scenario,
  ScenarioResult,
  ExperimentReport,
} from './types.js';

export {
  detectDryViolations,
  detectStaleReferences,
  detectEnvAssumptions,
  detectScopeCutTestability,
} from './diff-checks.js';

export {
  detectReflectionGaming,
  detectFiledWhenFixable,
  classifyReflectionQuality,
} from './reflection-checks.js';

export { detectMultiPRCycles } from './pr-pattern-checks.js';

export { runScenario, runExperiment, formatReport } from './run-scenarios.js';
