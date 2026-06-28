import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import type { ProviderCapability } from './auto-dent-provider.js';
import {
  buildProviderComparisonArtifact,
  defaultProviderComparisonResults,
  formatProviderComparisonReport,
  parseProviderComparisonArtifact,
  providerComparisonScenarios,
  recommendProviderStrategy,
  renderProviderMatrixDryRun,
  validateProviderComparisonScenario,
  writeProviderComparisonArtifact,
  type ProviderComparisonArtifact,
  type ProviderComparisonResult,
} from './auto-dent-provider-matrix.js';

describe('provider comparison matrix (#1152)', () => {
  it('uses the shared Markdown table cell escaping helper for provider tables (#1356)', () => {
    const capabilitySource = readFileSync('scripts/auto-dent-provider-capabilities.ts', 'utf8');
    const matrixSource = readFileSync('scripts/auto-dent-provider-matrix.ts', 'utf8');

    expect(capabilitySource).not.toMatch(/function\s+escapeCell\s*\(/);
    expect(matrixSource).not.toMatch(/function\s+escapeMarkdownCell\s*\(/);
  });

  it('dry-run renders all required provider strategies with phase-level provider records', () => {
    const scenarios = providerComparisonScenarios();

    expect(scenarios.map((scenario) => scenario.id)).toEqual([
      'claude-only',
      'codex-only',
      'claude-plan-review-codex-implement',
      'codex-plan-implement-provider-validation',
    ]);

    for (const scenario of scenarios) {
      const validation = validateProviderComparisonScenario(scenario);
      expect(validation.ok, scenario.id).toBe(true);
      expect(scenario.phaseProviders.validation).toEqual({
        provider: 'provider-independent',
        billing: 'local-only',
      });
      expect(scenario.phaseProviders.planning).toBeDefined();
      expect(scenario.phaseProviders.implementation).toBeDefined();
      expect(scenario.phaseProviders.review).toBeDefined();
    }

    const rendered = renderProviderMatrixDryRun(scenarios);
    expect(rendered).toContain('Provider comparison matrix dry run');
    expect(rendered).toContain('claude-only');
    expect(rendered).toContain('codex-only');
    expect(rendered).toContain('Claude planning/review + Codex implementation');
    expect(rendered).toContain('planning=claude (subscription-cli)');
    expect(rendered).toContain('implementation=codex (subscription-cli)');
    expect(rendered).not.toContain('api-token');
  });

  it('rejects subscription-incompatible matrix scenarios', () => {
    const apiTokenOnlyReview: ProviderCapability[] = [
      {
        provider: 'codex',
        phase: 'review',
        billingMode: 'api-token',
        fit: 'avoid',
        acceptedForUnattended: false,
        rationale: 'api token only test fixture',
      },
    ];

    const scenario = {
      ...providerComparisonScenarios().find((candidate) => candidate.id === 'codex-only')!,
    };
    const validation = validateProviderComparisonScenario(scenario, apiTokenOnlyReview);

    expect(validation.ok).toBe(false);
    expect(validation.violations[0].phase).toBe('review');
    expect(validation.violations[0].reason).toContain('api-token');
  });

  it('writes and parses provider comparison artifacts without losing verdict or metric fields', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'provider-matrix-'));
    const artifact = buildProviderComparisonArtifact({
      batchId: 'matrix-1152',
      scenario: 'synthetic-lifecycle',
      generatedAt: '2026-06-27T13:00:00.000Z',
      results: defaultProviderComparisonResults(),
    });

    const artifactPath = writeProviderComparisonArtifact(tmp, artifact);
    const parsed = parseProviderComparisonArtifact(readFileSync(artifactPath, 'utf8'));

    expect(parsed.batchId).toBe('matrix-1152');
    expect(parsed.scenario).toBe('synthetic-lifecycle');
    expect(parsed.results).toHaveLength(4);
    expect(parsed.results[0]).toMatchObject({
      scenarioId: 'claude-only',
      processVerdict: 'pass',
      failureClass: null,
      metrics: {
        processPassRate: 1,
        emptySuccessRate: 0,
        processIncompleteRate: 0,
        reviewQuality: 'strong',
        costSignal: 'available',
        hookRejections: 0,
        operatorInspectability: 'high',
      },
    });
    expect(parsed.results[0].phaseProviders.validation).toEqual({
      provider: 'provider-independent',
      billing: 'local-only',
    });
  });

  it('rejects provider comparison artifacts with invalid phase provider records (#1490)', () => {
    const artifact = buildProviderComparisonArtifact({
      batchId: 'matrix-invalid',
      scenario: 'synthetic-lifecycle',
      generatedAt: '2026-06-27T13:00:00.000Z',
      results: defaultProviderComparisonResults(),
    });
    const invalid = {
      ...artifact,
      results: [
        {
          ...artifact.results[0],
          phaseProviders: {
            planning: { provider: 'not-a-provider', billing: 'subscription-cli' },
          },
        },
      ],
    };

    expect(() => parseProviderComparisonArtifact(JSON.stringify(invalid))).toThrow(
      /phaseProviders/,
    );
  });

  it('formats reports with provider strategy, verdict, failure class, metrics, and recommendation', () => {
    const artifact = buildProviderComparisonArtifact({
      batchId: 'matrix-1152',
      scenario: 'synthetic-lifecycle',
      generatedAt: '2026-06-27T13:00:00.000Z',
      results: defaultProviderComparisonResults(),
    });

    const report = formatProviderComparisonReport(artifact);

    expect(report).toContain('## Provider Comparison Matrix: matrix-1152');
    expect(report).toContain('| Strategy | Planning | Implementation | Review | Validation | Verdict | Failure class |');
    expect(report).toContain('Claude only');
    expect(report).toContain('Codex only');
    expect(report).toContain('process-incomplete');
    expect(report).toContain('missing-review-evidence');
    expect(report).toContain('process pass rate');
    expect(report).toContain('empty-success rate');
    expect(report).toContain('hook rejections');
    expect(report).toContain('Recommended default provider strategy');
    expect(report).toContain('claude-plan-review-codex-implement');
  });

  it('escapes backslashes and pipes in markdown table cells', () => {
    const [result] = defaultProviderComparisonResults();
    const artifact = buildProviderComparisonArtifact({
      batchId: 'matrix-escape',
      scenario: 'synthetic-lifecycle',
      generatedAt: '2026-06-27T13:00:00.000Z',
      results: [
        {
          ...result,
          label: 'Claude | Windows \\ path',
          failureClass: 'path\\pipe|class',
        },
      ],
    });

    const report = formatProviderComparisonReport(artifact);

    expect(report).toContain('Claude \\| Windows \\\\ path');
    expect(report).toContain('path\\\\pipe\\|class');
  });

  it('recommends the best subscription-compatible passing strategy by measured evidence', () => {
    const base = defaultProviderComparisonResults();
    const strongerCodexImplementation = base.find(
      (result) => result.scenarioId === 'claude-plan-review-codex-implement',
    )!;

    const recommendation = recommendProviderStrategy(base);

    expect(recommendation.scenarioId).toBe(strongerCodexImplementation.scenarioId);
    expect(recommendation.reason).toContain('passing process verdict');
    expect(recommendation.reason).toContain('inspectability');
  });

  it('CLI dry-run and report commands do not invoke provider CLIs or require API-token billing', () => {
    const dryRun = spawnSync(
      'npx',
      ['tsx', 'scripts/auto-dent-provider-matrix.ts', '--dry-run'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(dryRun.status).toBe(0);
    expect(dryRun.stdout).toContain('Provider comparison matrix dry run');
    expect(dryRun.stdout).toContain('codex-only');
    expect(dryRun.stdout).not.toContain('api-token');
    expect(dryRun.stderr).toBe('');

    const tmp = mkdtempSync(join(tmpdir(), 'provider-matrix-cli-'));
    const artifact: ProviderComparisonArtifact = buildProviderComparisonArtifact({
      batchId: 'matrix-cli',
      scenario: 'synthetic-lifecycle',
      generatedAt: '2026-06-27T13:00:00.000Z',
      results: defaultProviderComparisonResults(),
    });
    const artifactPath = join(tmp, 'provider-comparison.json');
    writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));

    const report = spawnSync(
      'npx',
      ['tsx', 'scripts/auto-dent-provider-matrix.ts', '--report', artifactPath],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(report.status).toBe(0);
    expect(report.stdout).toContain('Provider Comparison Matrix: matrix-cli');
    expect(report.stdout).toContain('Recommended default provider strategy');
    expect(report.stdout).not.toContain('api-token');
    expect(report.stderr).toBe('');
  });
});
