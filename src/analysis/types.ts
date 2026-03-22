/**
 * types.ts — Failure mode taxonomy and detection result types.
 *
 * Each failure mode (FM) is a recurring pattern discovered through kaizen
 * analysis of closed issues and PRs. Detectors are deterministic functions
 * that check code, diffs, reflections, or PR metadata for these patterns.
 */

export enum FailureMode {
  /** FM1: Copy-pasted blocks instead of shared helpers */
  DRY_VIOLATION = 'FM1:DRY_VIOLATION',
  /** FM2: Feature ships broken, 2-5 follow-up fix PRs */
  MULTI_PR_FIX_CYCLE = 'FM2:MULTI_PR_FIX_CYCLE',
  /** FM3: Reflection gate satisfied with minimal effort / generic waivers */
  REFLECTION_GAMING = 'FM3:REFLECTION_GAMING',
  /** FM4: Essential scope (test harness, E2E) cut as "scope creep" */
  SCOPE_CUT_TESTABILITY = 'FM4:SCOPE_CUT_TESTABILITY',
  /** FM5: Code assumes single CWD, single env, breaks in worktree/CI */
  ENV_ASSUMPTION = 'FM5:ENV_ASSUMPTION',
  /** FM6: Renames/migrations leave stale references in consumers */
  STALE_REFERENCE = 'FM6:STALE_REFERENCE',
  /** FM7: Squash merge data loss from incomplete commits */
  SQUASH_DATA_LOSS = 'FM7:SQUASH_DATA_LOSS',
}

export interface Detection {
  mode: FailureMode;
  confidence: number; // 0-100
  location: string; // file:line or description
  detail: string; // human-readable explanation
}

/** A unified diff hunk for analysis */
export interface DiffFile {
  path: string;
  additions: string[]; // lines added (without + prefix)
  deletions: string[]; // lines removed (without - prefix)
  rawDiff: string;
}

/** PR metadata for multi-PR pattern detection */
export interface PRRecord {
  number: number;
  title: string;
  mergedAt: string; // ISO timestamp
  changedFiles: string[];
  additions: number;
  deletions: number;
  labels: string[];
  linkedIssues: number[]; // issue numbers referenced
}

/** KAIZEN_IMPEDIMENTS entry for reflection quality analysis */
export interface Impediment {
  finding: string;
  type?: 'meta' | 'positive' | 'standard';
  disposition: string;
  reason?: string;
  ref?: string;
}

/** A synthetic scenario for autoresearch-style testing */
export interface SyntheticScenario {
  name: string;
  description: string;
  /** Which failure mode this scenario targets */
  targetMode: FailureMode;
  /** Whether this scenario SHOULD trigger detection (true) or should be clean (false) */
  expectDetection: boolean;
}

export interface DiffScenario extends SyntheticScenario {
  kind: 'diff';
  files: DiffFile[];
  /** For stale-reference checks: symbols that were renamed/removed */
  renamedSymbols?: { old: string; new: string }[];
}

export interface ReflectionScenario extends SyntheticScenario {
  kind: 'reflection';
  impediments: Impediment[];
}

export interface PRHistoryScenario extends SyntheticScenario {
  kind: 'pr-history';
  prs: PRRecord[];
}

export type Scenario = DiffScenario | ReflectionScenario | PRHistoryScenario;

export interface ScenarioResult {
  scenario: SyntheticScenario;
  detections: Detection[];
  passed: boolean; // true if detection matched expectation
}

export interface ExperimentReport {
  timestamp: string;
  scenarios: ScenarioResult[];
  detectionRate: Record<FailureMode, { caught: number; total: number; rate: number }>;
  falsePositiveRate: Record<FailureMode, { caught: number; total: number; rate: number }>;
}
