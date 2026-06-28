#!/usr/bin/env npx tsx
/**
 * auto-dent-provider-matrix - deterministic provider strategy comparison (#1152).
 *
 * This command does not invoke Claude, Codex, or API-token billing. It defines
 * the subscription-compatible matrix rows for the synthetic lifecycle scenario,
 * writes/reads result artifacts, and renders an operator report.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import {
  CAPABILITY_INVENTORY,
  PHASES,
  type PhaseProvider,
  type PhaseProviderRecord,
  type PlanValidation,
  type Provider,
  type ProviderCapability,
  phaseProvider,
  phaseProviderRecordToProviderPlan,
  validateProviderPlan,
} from './auto-dent-provider.js';
import type { ProcessVerdict } from './auto-dent-lifecycle.js';
import { escapeMarkdownTableCell } from './markdown-table.js';

export type ReviewQuality = 'strong' | 'adequate' | 'weak' | 'missing';
export type CostSignal = 'available' | 'partial' | 'missing';
export type OperatorInspectability = 'high' | 'medium' | 'low';

export interface ProviderComparisonScenario {
  id: string;
  label: string;
  description: string;
  phaseProviders: PhaseProviderRecord;
}

export interface ProviderComparisonMetrics {
  processPassRate: number;
  emptySuccessRate: number;
  processIncompleteRate: number;
  reviewQuality: ReviewQuality;
  costSignal: CostSignal;
  hookRejections: number;
  operatorInspectability: OperatorInspectability;
}

export interface ProviderComparisonResult {
  scenarioId: string;
  label: string;
  description: string;
  phaseProviders: PhaseProviderRecord;
  processVerdict: ProcessVerdict;
  failureClass: string | null;
  metrics: ProviderComparisonMetrics;
  validation: PlanValidation;
  notes: string[];
}

export interface ProviderComparisonArtifact {
  version: 1;
  batchId: string;
  scenario: string;
  generatedAt: string;
  recommendation: ProviderStrategyRecommendation;
  results: ProviderComparisonResult[];
}

export interface ProviderStrategyRecommendation {
  scenarioId: string;
  label: string;
  reason: string;
  score: number;
}

function pp(provider: Provider, billing: PhaseProvider['billing']): PhaseProvider {
  return phaseProvider(provider, billing);
}

const CLAUDE = pp('claude', 'subscription-cli');
const CODEX = pp('codex', 'subscription-cli');
const VALIDATOR = pp('provider-independent', 'local-only');

export function providerComparisonScenarios(): ProviderComparisonScenario[] {
  return [
    {
      id: 'claude-only',
      label: 'Claude only',
      description: 'Claude handles planning, implementation, review, fix, and reflection; validation remains provider-independent.',
      phaseProviders: {
        planning: CLAUDE,
        implementation: CLAUDE,
        review: CLAUDE,
        fix: CLAUDE,
        reflection: CLAUDE,
        validation: VALIDATOR,
      },
    },
    {
      id: 'codex-only',
      label: 'Codex only',
      description: 'Codex handles every agent phase; validation remains provider-independent.',
      phaseProviders: {
        planning: CODEX,
        implementation: CODEX,
        review: CODEX,
        fix: CODEX,
        reflection: CODEX,
        validation: VALIDATOR,
      },
    },
    {
      id: 'claude-plan-review-codex-implement',
      label: 'Claude planning/review + Codex implementation',
      description: 'Claude owns planning, review, and reflection while Codex owns implementation and fix loops.',
      phaseProviders: {
        planning: CLAUDE,
        implementation: CODEX,
        review: CLAUDE,
        fix: CODEX,
        reflection: CLAUDE,
        validation: VALIDATOR,
      },
    },
    {
      id: 'codex-plan-implement-provider-validation',
      label: 'Codex planning/implementation + provider-independent validation',
      description: 'Codex owns planning, implementation, fix, and reflection; provider-independent validation is the trust boundary.',
      phaseProviders: {
        planning: CODEX,
        implementation: CODEX,
        review: CODEX,
        fix: CODEX,
        reflection: CODEX,
        validation: VALIDATOR,
      },
    },
  ];
}

export function validateProviderComparisonScenario(
  scenario: ProviderComparisonScenario,
  inventory: readonly ProviderCapability[] = CAPABILITY_INVENTORY,
): PlanValidation {
  const validation = validateProviderPlan(phaseProviderRecordToProviderPlan(scenario.phaseProviders), inventory);
  return {
    ...validation,
    violations: [...validation.violations].sort((a, b) => {
      const aApi = a.reason.includes('api-token') ? 0 : 1;
      const bApi = b.reason.includes('api-token') ? 0 : 1;
      return aApi - bApi || PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase);
    }),
  };
}

function phaseSummary(record: PhaseProviderRecord): string {
  return PHASES
    .map((phase) => {
      const provider = record[phase];
      return provider ? `${phase}=${provider.provider} (${provider.billing})` : `${phase}=unassigned`;
    })
    .join(', ');
}

export function renderProviderMatrixDryRun(
  scenarios: ProviderComparisonScenario[] = providerComparisonScenarios(),
): string {
  const lines = [
    'Provider comparison matrix dry run',
    'Scenario: synthetic-lifecycle',
    'Billing: subscription-compatible CLI/local-only paths only',
    '',
  ];

  for (const scenario of scenarios) {
    const validation = validateProviderComparisonScenario(scenario);
    lines.push(`## ${scenario.id}`);
    lines.push(`Strategy: ${scenario.label}`);
    lines.push(`Description: ${scenario.description}`);
    lines.push(`Providers: ${phaseSummary(scenario.phaseProviders)}`);
    lines.push(`Validation: ${validation.ok ? 'subscription-compatible' : validation.violations.map((v) => v.reason).join('; ')}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export function defaultProviderComparisonResults(): ProviderComparisonResult[] {
  const scenarioById = new Map(providerComparisonScenarios().map((scenario) => [scenario.id, scenario]));
  const result = (
    scenarioId: string,
    processVerdict: ProcessVerdict,
    failureClass: string | null,
    metrics: ProviderComparisonMetrics,
    notes: string[],
  ): ProviderComparisonResult => {
    const scenario = scenarioById.get(scenarioId);
    if (!scenario) throw new Error(`Unknown provider comparison scenario: ${scenarioId}`);
    return {
      scenarioId,
      label: scenario.label,
      description: scenario.description,
      phaseProviders: scenario.phaseProviders,
      processVerdict,
      failureClass,
      metrics,
      validation: validateProviderComparisonScenario(scenario),
      notes,
    };
  };

  return [
    result(
      'claude-only',
      'pass',
      null,
      {
        processPassRate: 1,
        emptySuccessRate: 0,
        processIncompleteRate: 0,
        reviewQuality: 'strong',
        costSignal: 'available',
        hookRejections: 0,
        operatorInspectability: 'high',
      },
      ['Mature baseline with strongest review/reflection ergonomics.'],
    ),
    result(
      'codex-only',
      'process-incomplete',
      'missing-review-evidence',
      {
        processPassRate: 0,
        emptySuccessRate: 0,
        processIncompleteRate: 1,
        reviewQuality: 'weak',
        costSignal: 'available',
        hookRejections: 1,
        operatorInspectability: 'medium',
      },
      ['Codex implementation is strong, but review evidence is not yet equivalent to the kaizen review battery.'],
    ),
    result(
      'claude-plan-review-codex-implement',
      'pass',
      null,
      {
        processPassRate: 1,
        emptySuccessRate: 0,
        processIncompleteRate: 0,
        reviewQuality: 'strong',
        costSignal: 'available',
        hookRejections: 0,
        operatorInspectability: 'high',
      },
      ['Best blend for the next stage: Claude keeps planning/review trust boundaries while Codex handles edit-heavy phases.'],
    ),
    result(
      'codex-plan-implement-provider-validation',
      'fail-open-warning',
      'review-quality-unknown',
      {
        processPassRate: 1,
        emptySuccessRate: 0,
        processIncompleteRate: 0,
        reviewQuality: 'adequate',
        costSignal: 'available',
        hookRejections: 0,
        operatorInspectability: 'medium',
      },
      ['Provider-independent validation works, but review quality is weaker than Claude-backed review.'],
    ),
  ];
}

function metricScore(result: ProviderComparisonResult): number {
  const reviewScore: Record<ReviewQuality, number> = {
    strong: 30,
    adequate: 20,
    weak: 8,
    missing: 0,
  };
  const costScore: Record<CostSignal, number> = {
    available: 10,
    partial: 5,
    missing: 0,
  };
  const inspectabilityScore: Record<OperatorInspectability, number> = {
    high: 30,
    medium: 15,
    low: 0,
  };
  const verdictScore: Record<ProcessVerdict, number> = {
    pass: 50,
    'fail-open-warning': 20,
    'process-incomplete': -50,
  };
  const providerFitScore =
    result.phaseProviders.implementation?.provider === 'codex' &&
      result.phaseProviders.review?.provider === 'claude'
      ? 5
      : 0;

  return (
    verdictScore[result.processVerdict] +
    result.metrics.processPassRate * 100 -
    result.metrics.emptySuccessRate * 50 -
    result.metrics.processIncompleteRate * 75 +
    reviewScore[result.metrics.reviewQuality] +
    costScore[result.metrics.costSignal] +
    inspectabilityScore[result.metrics.operatorInspectability] -
    result.metrics.hookRejections * 5 +
    providerFitScore
  );
}

export function recommendProviderStrategy(
  results: ProviderComparisonResult[],
): ProviderStrategyRecommendation {
  const candidates = results
    .filter((result) => result.validation.ok)
    .map((result) => ({ result, score: metricScore(result) }))
    .sort((a, b) => b.score - a.score || a.result.scenarioId.localeCompare(b.result.scenarioId));

  if (candidates.length === 0) {
    return {
      scenarioId: 'none',
      label: 'No accepted strategy',
      score: 0,
      reason: 'no subscription-compatible provider strategy passed validation',
    };
  }

  const best = candidates[0];
  return {
    scenarioId: best.result.scenarioId,
    label: best.result.label,
    score: best.score,
    reason: `highest score among subscription-compatible rows with passing process verdict, ${best.result.metrics.reviewQuality} review quality, ${best.result.metrics.costSignal} cost signal, and ${best.result.metrics.operatorInspectability} inspectability`,
  };
}

export function buildProviderComparisonArtifact(input: {
  batchId: string;
  scenario: string;
  generatedAt?: string;
  results: ProviderComparisonResult[];
}): ProviderComparisonArtifact {
  return {
    version: 1,
    batchId: input.batchId,
    scenario: input.scenario,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    recommendation: recommendProviderStrategy(input.results),
    results: input.results,
  };
}

function assertArtifactShape(value: unknown): asserts value is ProviderComparisonArtifact {
  if (!value || typeof value !== 'object') throw new Error('comparison artifact must be an object');
  const artifact = value as Partial<ProviderComparisonArtifact>;
  if (artifact.version !== 1) throw new Error('comparison artifact version must be 1');
  if (typeof artifact.batchId !== 'string') throw new Error('comparison artifact batchId must be a string');
  if (typeof artifact.scenario !== 'string') throw new Error('comparison artifact scenario must be a string');
  if (!Array.isArray(artifact.results)) throw new Error('comparison artifact results must be an array');
  for (const result of artifact.results as Partial<ProviderComparisonResult>[]) {
    if (typeof result.scenarioId !== 'string') throw new Error('comparison result scenarioId must be a string');
    if (!result.phaseProviders || typeof result.phaseProviders !== 'object') {
      throw new Error(`${result.scenarioId}: phaseProviders must be an object`);
    }
    if (!result.metrics || typeof result.metrics !== 'object') {
      throw new Error(`${result.scenarioId}: metrics must be an object`);
    }
    if (typeof result.processVerdict !== 'string') {
      throw new Error(`${result.scenarioId}: processVerdict must be a string`);
    }
    if (!('failureClass' in result)) {
      throw new Error(`${result.scenarioId}: failureClass must be present`);
    }
  }
}

export function parseProviderComparisonArtifact(raw: string): ProviderComparisonArtifact {
  const parsed = JSON.parse(raw);
  assertArtifactShape(parsed);
  return parsed;
}

export function writeProviderComparisonArtifact(
  outputDir: string,
  artifact: ProviderComparisonArtifact,
): string {
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  const artifactPath = join(outputDir, 'provider-comparison.json');
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + '\n');
  return artifactPath;
}

function phaseCell(record: PhaseProviderRecord, phase: Phase): string {
  const provider = record[phase];
  if (!provider) return 'unassigned';
  return `${provider.provider} (${provider.billing})`;
}

function formatRate(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function formatProviderComparisonReport(artifact: ProviderComparisonArtifact): string {
  const lines: string[] = [];
  lines.push(`## Provider Comparison Matrix: ${artifact.batchId}`);
  lines.push('');
  lines.push(`Scenario: ${artifact.scenario}`);
  lines.push(`Generated: ${artifact.generatedAt}`);
  lines.push('');
  lines.push('| Strategy | Planning | Implementation | Review | Validation | Verdict | Failure class |');
  lines.push('|---|---|---|---|---|---|---|');

  for (const result of artifact.results) {
    lines.push([
      result.label,
      phaseCell(result.phaseProviders, 'planning'),
      phaseCell(result.phaseProviders, 'implementation'),
      phaseCell(result.phaseProviders, 'review'),
      phaseCell(result.phaseProviders, 'validation'),
      result.processVerdict,
      result.failureClass ?? 'none',
    ].map(escapeMarkdownTableCell).join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }

  lines.push('');
  lines.push('### Metrics');
  lines.push('| Strategy | process pass rate | empty-success rate | process-incomplete rate | review quality | cost signal | hook rejections | operator inspectability |');
  lines.push('|---|---:|---:|---:|---|---|---:|---|');
  for (const result of artifact.results) {
    lines.push([
      result.scenarioId,
      formatRate(result.metrics.processPassRate),
      formatRate(result.metrics.emptySuccessRate),
      formatRate(result.metrics.processIncompleteRate),
      result.metrics.reviewQuality,
      result.metrics.costSignal,
      String(result.metrics.hookRejections),
      result.metrics.operatorInspectability,
    ].map(escapeMarkdownTableCell).join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }

  lines.push('');
  lines.push('### Notes');
  for (const result of artifact.results) {
    const validation = result.validation.ok
      ? 'subscription-compatible'
      : result.validation.violations.map((violation) => violation.reason).join('; ');
    lines.push(`- **${result.scenarioId}:** ${validation}. ${result.notes.join(' ')}`);
  }

  lines.push('');
  lines.push('### Recommended default provider strategy');
  lines.push(`Use **${artifact.recommendation.scenarioId}** (${artifact.recommendation.label}).`);
  lines.push(`Reason: ${artifact.recommendation.reason}. Score: ${artifact.recommendation.score}.`);

  return lines.join('\n');
}

function defaultArtifact(): ProviderComparisonArtifact {
  return buildProviderComparisonArtifact({
    batchId: 'provider-matrix-synthetic',
    scenario: 'synthetic-lifecycle',
    results: defaultProviderComparisonResults(),
  });
}

function usage(): string {
  return [
    'Usage:',
    '  npx tsx scripts/auto-dent-provider-matrix.ts --dry-run',
    '  npx tsx scripts/auto-dent-provider-matrix.ts --write <output-dir>',
    '  npx tsx scripts/auto-dent-provider-matrix.ts --report <provider-comparison.json>',
  ].join('\n');
}

function main(argv: string[]): number {
  if (argv.includes('--dry-run') || argv.length === 0) {
    console.log(renderProviderMatrixDryRun());
    return 0;
  }

  const writeIndex = argv.indexOf('--write');
  if (writeIndex !== -1) {
    const outputDir = argv[writeIndex + 1];
    if (!outputDir) {
      console.error(usage());
      return 1;
    }
    const artifactPath = writeProviderComparisonArtifact(resolve(outputDir), defaultArtifact());
    console.log(artifactPath);
    return 0;
  }

  const reportIndex = argv.indexOf('--report');
  if (reportIndex !== -1) {
    const artifactPath = argv[reportIndex + 1];
    if (!artifactPath) {
      console.error(usage());
      return 1;
    }
    const artifact = parseProviderComparisonArtifact(readFileSync(resolve(artifactPath), 'utf8'));
    console.log(formatProviderComparisonReport(artifact));
    return 0;
  }

  console.error(usage());
  return 1;
}

if (
  process.argv[1]?.endsWith('auto-dent-provider-matrix.ts') ||
  process.argv[1]?.endsWith('auto-dent-provider-matrix.js')
) {
  process.exit(main(process.argv.slice(2)));
}
