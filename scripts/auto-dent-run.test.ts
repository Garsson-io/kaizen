import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { writeFileSync, unlinkSync, mkdtempSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildPrompt,
  buildPromptWithMetadata,
  buildTemplateVars,
  loadReflectionInsights,
  loadReflectionHistory,
  renderTemplate,
  loadPromptTemplate,
  extractArtifacts,
  extractContemplationRecommendations,
  extractReflectionInsights,
  parsePhaseMarkers,
  formatPhaseMarker,
  checkStopSignal,
  formatToolUse,
  formatHeartbeat,
  processStreamMessage,
  cleanGuidanceForTitle,
  buildInFlightComment,
  extractLinkedIssue,
  formatPlanAsMarkdown,
  selectMode,
  checkSignalOverrides,
  computeBanditWeights,
  SCHEDULABLE_MODES,
  DEFAULT_BANDIT_C,
  banditExplorationC,
  modeSuccess,
  deriveRunOutcome,
  buildRunMetrics,
  weightedModeSelect,
  computeModeDistribution,
  formatBatchFooter,
  readState,
  writeState,
  color,
  type BatchState,
  type CleanupResult,
  type PhaseMarker,
  type RunMetrics,
  type StreamContext,
  type DriveResult,
  type DriveReason,
  type PromptMetadata,
  validateRunLifecycle,
  findExistingProgressIssue,
  ensureBatchProgressIssue,
  updateBatchProgressIssue,
  extractPlanText,
  populateCrossBatchSteering,
  shouldRunCodexProvider,
  attachRunTranscripts,
} from './auto-dent-run.js';
import * as github from './auto-dent-github.js';
import { makeBatchState, makeRunResult } from './auto-dent-test-utils.js';
import { decideAutoMergeSafety } from './auto-dent-merge-policy.js';

const AUTO_DENT_RUN_SOURCE = readFileSync(new URL('./auto-dent-run.ts', import.meta.url), 'utf8');

describe('buildPrompt', () => {
  it('includes run tag with batch id and run number', () => {
    const state = makeBatchState();
    const prompt = buildPrompt(state, 3);
    expect(prompt).toContain('batch-260322-2100-a1b2/run-3');
  });

  it('includes guidance in the prompt', () => {
    const state = makeBatchState({ guidance: 'focus on testing infra' });
    const prompt = buildPrompt(state, 1);
    expect(prompt).toContain('focus on testing infra');
  });

  it('includes max runs context when set', () => {
    const state = makeBatchState({ max_runs: 10 });
    const prompt = buildPrompt(state, 3);
    expect(prompt).toContain('run 3 of 10');
  });

  it('omits max runs context when unlimited', () => {
    const state = makeBatchState({ max_runs: 0 });
    const prompt = buildPrompt(state, 3);
    expect(prompt).not.toContain('of 0');
    expect(prompt).toContain('run 3)');
  });

  it('includes previously closed issues as exclusions', () => {
    const state = makeBatchState({
      issues_closed: ['#100', '#200'],
    });
    const prompt = buildPrompt(state, 2);
    expect(prompt).toContain('#100');
    expect(prompt).toContain('#200');
    expect(prompt).toContain('do not rework');
  });

  it('includes previously created PRs to avoid overlap', () => {
    const state = makeBatchState({
      prs: ['https://github.com/Garsson-io/kaizen/pull/450'],
    });
    const prompt = buildPrompt(state, 2);
    expect(prompt).toContain('pull/450');
    expect(prompt).toContain('avoid overlapping');
  });

  it('omits exclusion sections when no prior work exists', () => {
    const state = makeBatchState();
    const prompt = buildPrompt(state, 1);
    expect(prompt).not.toContain('do not rework');
    expect(prompt).not.toContain('avoid overlapping');
  });

  it('keeps merge policy under harness control after review', () => {
    const state = makeBatchState({ host_repo: 'Garsson-io/kaizen' });
    const prompt = buildPrompt(state, 1);
    expect(prompt).not.toContain('gh pr merge');
    expect(prompt).toContain('Garsson-io/kaizen');
    expect(prompt).toContain('The auto-dent harness queues auto-merge after review');
    expect(prompt).toContain('status=<queued/merged/blocked>');
  });

  it('keeps merge policy under harness control in subtract mode', () => {
    const state = makeBatchState({ host_repo: 'Garsson-io/kaizen', guidance: 'mode:subtract' });
    const prompt = buildPrompt(state, 1);
    expect(prompt).not.toContain('gh pr merge');
    expect(prompt).toContain('The auto-dent harness queues auto-merge after review');
  });

  it('keeps merge policy under harness control in synthetic test-task mode', () => {
    const state = makeBatchState({ host_repo: 'Garsson-io/kaizen', test_task: true });
    const prompt = buildPrompt(state, 1);
    expect(prompt).not.toContain('gh pr merge');
    expect(prompt).toContain('The auto-dent harness queues auto-merge after review');
  });

  it('includes structured STOP phase marker instructions', () => {
    const state = makeBatchState();
    const prompt = buildPrompt(state, 1);
    expect(prompt).toContain('AUTO_DENT_PHASE: STOP | reason=');
  });

  it('generates test-task prompt when test_task is true', () => {
    const state = makeBatchState({ test_task: true });
    const prompt = buildPrompt(state, 1);
    expect(prompt).toContain('synthetic test task');
    expect(prompt).toContain('test-probe');
    expect(prompt).not.toContain('/kaizen-deep-dive');
  });

  it('generates deep-dive prompt when test_task is false', () => {
    const state = makeBatchState({ test_task: false });
    const prompt = buildPrompt(state, 1);
    expect(prompt).toContain('/kaizen-deep-dive');
  });
});

describe('buildTemplateVars', () => {
  it('builds all expected template variables', () => {
    const state = makeBatchState({
      issues_closed: ['#100', '#200'],
      prs: ['https://github.com/Garsson-io/kaizen/pull/450'],
    });
    const vars = buildTemplateVars(state, 3);

    expect(vars.guidance).toBe('improve hooks reliability');
    expect(vars.run_tag).toBe('batch-260322-2100-a1b2/run-3');
    expect(vars.run_tag_slug).toBe('batch-260322-2100-a1b2-run-3');
    expect(vars.run_num).toBe('3');
    expect(vars.run_context).toBe('3 of 5');
    expect(vars.host_repo).toBe('Garsson-io/kaizen');
    expect(vars.batch_id).toBe('batch-260322-2100-a1b2');
    expect(vars.issues_closed).toBe('#100 #200');
    expect(vars.prs).toContain('pull/450');
  });

  it('omits max runs from run_context when unlimited', () => {
    const state = makeBatchState({ max_runs: 0 });
    const vars = buildTemplateVars(state, 2);
    expect(vars.run_context).toBe('2');
  });

  it('uses kaizen_repo as fallback for host_repo', () => {
    const state = makeBatchState({ host_repo: '', kaizen_repo: 'Garsson-io/kaizen' });
    const vars = buildTemplateVars(state, 1);
    expect(vars.host_repo).toBe('Garsson-io/kaizen');
  });

  it('produces empty strings for empty arrays', () => {
    const state = makeBatchState();
    const vars = buildTemplateVars(state, 1);
    expect(vars.issues_closed).toBe('');
    expect(vars.prs).toBe('');
  });

  it('sets claimed_plan_issue when plan exists with pending items', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'plan-claim-vars-'));
    const plan = {
      created_at: '2026-03-23T00:00:00Z',
      guidance: 'test',
      items: [
        { issue: '#302', title: 'Test item', score: 8, approach: 'do it', status: 'pending' },
      ],
      wip_excluded: [],
      epics_scanned: [],
    };
    writeFileSync(join(tmpDir, 'plan.json'), JSON.stringify(plan));

    const state = makeBatchState();
    const vars = buildTemplateVars(state, 1, tmpDir);
    expect(vars.claimed_plan_issue).toBe('#302');
  });

  it('sets empty claimed_plan_issue when no plan exists', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'no-plan-vars-'));
    const state = makeBatchState();
    const vars = buildTemplateVars(state, 1, tmpDir);
    expect(vars.claimed_plan_issue).toBe('');
  });
});

// Reflection feedback loop (#603)

describe('loadReflectionInsights', () => {
  it('routes reflection JSON reads through the shared JSON file contract', () => {
    const reflectionSection = AUTO_DENT_RUN_SOURCE.slice(
      AUTO_DENT_RUN_SOURCE.indexOf('export function loadReflectionInsights'),
      AUTO_DENT_RUN_SOURCE.indexOf('/**\n * Build template variables'),
    );

    expect(reflectionSection).toContain('readJsonValueFile');
    expect(reflectionSection).not.toContain("JSON.parse(readFileSync(summaryPath, 'utf8'))");
    expect(reflectionSection).not.toContain("JSON.parse(readFileSync(historyPath, 'utf8'))");
  });

  it('returns empty when no reflection-summary.json exists', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'no-reflect-'));
    const result = loadReflectionInsights(tmpDir);
    expect(result.text).toBe('');
    expect(result.avoidIssues).toEqual([]);
  });

  it('loads and formats insights from persisted reflection', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'reflect-load-'));
    const summary = {
      timestamp: '2026-03-23T01:00:00Z',
      runCount: 10,
      successRate: 0.8,
      avgCostPerPr: 1.5,
      insights: [
        { type: 'success_pattern', message: 'High success rate: 80%' },
        { type: 'failure_pattern', message: 'Max 2 consecutive failures' },
      ],
      avoidIssues: ['42'],
    };
    writeFileSync(join(tmpDir, 'reflection-summary.json'), JSON.stringify(summary));

    const result = loadReflectionInsights(tmpDir);
    expect(result.text).toContain('success rate: 80%');
    expect(result.text).toContain('High success rate');
    expect(result.text).toContain('consecutive failures');
    expect(result.avoidIssues).toEqual(['42']);
  });

  it('returns empty text when insights array is empty', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'reflect-empty-'));
    const summary = {
      timestamp: '2026-03-23T01:00:00Z',
      runCount: 2,
      successRate: 1.0,
      avgCostPerPr: 0,
      insights: [],
      avoidIssues: [],
    };
    writeFileSync(join(tmpDir, 'reflection-summary.json'), JSON.stringify(summary));

    const result = loadReflectionInsights(tmpDir);
    expect(result.text).toBe('');
  });

  it('handles corrupt JSON gracefully', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'reflect-corrupt-'));
    writeFileSync(join(tmpDir, 'reflection-summary.json'), 'not json');
    const result = loadReflectionInsights(tmpDir);
    expect(result.text).toBe('');
    expect(result.avoidIssues).toEqual([]);
  });
});

describe('buildTemplateVars with reflection insights', () => {
  it('includes reflection_insights when reflection-summary.json exists in logDir', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'reflect-vars-'));
    const summary = {
      timestamp: '2026-03-23T01:00:00Z',
      runCount: 5,
      successRate: 0.6,
      avgCostPerPr: 2.0,
      insights: [
        { type: 'recommendation', message: 'Consider simpler issues' },
      ],
      avoidIssues: [],
    };
    writeFileSync(join(tmpDir, 'reflection-summary.json'), JSON.stringify(summary));

    const state = makeBatchState();
    const vars = buildTemplateVars(state, 6, tmpDir);
    expect(vars.reflection_insights).toContain('Consider simpler issues');
  });

  it('sets empty reflection_insights when no reflection exists', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'reflect-none-'));
    const state = makeBatchState();
    const vars = buildTemplateVars(state, 3, tmpDir);
    expect(vars.reflection_insights).toBe('');
  });

  it('surfaces cross_batch_steering as a numbered list when state has it', () => {
    const state = makeBatchState({ cross_batch_steering: ['Prefer exploit mode', 'Tighten test plans'] });
    const vars = buildTemplateVars(state, 1);
    expect(vars.cross_batch_steering).toContain('1. Prefer exploit mode');
    expect(vars.cross_batch_steering).toContain('2. Tighten test plans');
  });

  it('renders the cross-batch steering block in the prompt only when non-empty', () => {
    const withSteering = buildPrompt(makeBatchState({ cross_batch_steering: ['Reduce scope per run'] }), 1);
    expect(withSteering).toContain('Cross-Batch Steering');
    expect(withSteering).toContain('Reduce scope per run');

    const without = buildPrompt(makeBatchState({ cross_batch_steering: [] }), 1);
    expect(without).not.toContain('Cross-Batch Steering');
  });
});

describe('populateCrossBatchSteering — close the loop (#940 Phase 2)', () => {
  function tmpState(state: BatchState): string {
    const dir = mkdtempSync(join(tmpdir(), 'cbs-'));
    const f = join(dir, 'state.json');
    writeState(f, state);
    return f;
  }

  it('stores steering derived from prior outcomes and persists it', () => {
    const state = makeBatchState({ batch_id: 'self' });
    const f = tmpState(state);
    const result = populateCrossBatchSteering(state, f, {
      read: () => [
        // Two batches, both stopped "backlog exhausted" → recurring stop-reason signal.
        {
          schema_version: 1, batch_id: 'p1', guidance: 'g', batch_start: 1, batch_end: 2,
          wall_seconds: 1, stop_reason: 'backlog exhausted — no more open issues',
          totals: { runs: 2, successful_runs: 2, prs: 2, issues_closed: 2, issues_filed: 0, cost_usd: 4, duration_seconds: 100, lines_deleted: 0, issues_pruned: 0 },
          success_rate: 1, avg_cost_per_success: 2, overall_efficiency: 0.5, review_fail_rate: 0,
          cost_anomaly_count: 0, mode_diversity: 1, trend: null, mode_breakdown: [], prs: [], issues_closed: [], issues_filed: [],
        },
        {
          schema_version: 1, batch_id: 'p2', guidance: 'g', batch_start: 3, batch_end: 4,
          wall_seconds: 1, stop_reason: 'backlog exhausted matching guidance',
          totals: { runs: 2, successful_runs: 2, prs: 2, issues_closed: 2, issues_filed: 0, cost_usd: 4, duration_seconds: 100, lines_deleted: 0, issues_pruned: 0 },
          success_rate: 1, avg_cost_per_success: 2, overall_efficiency: 0.5, review_fail_rate: 0,
          cost_anomaly_count: 0, mode_diversity: 1, trend: null, mode_breakdown: [], prs: [], issues_closed: [], issues_filed: [],
        },
      ],
    });
    expect(result.some((s) => /backlog exhausted/i.test(s))).toBe(true);
    // Persisted to state and onto disk.
    expect(state.cross_batch_steering).toEqual(result);
    expect(readState(f).cross_batch_steering).toEqual(result);
  });

  it('is idempotent — does not refetch when already populated', () => {
    const state = makeBatchState({ cross_batch_steering: ['already here'] });
    const f = tmpState(state);
    let called = false;
    const result = populateCrossBatchSteering(state, f, { read: () => { called = true; return []; } });
    expect(called).toBe(false);
    expect(result).toEqual(['already here']);
  });

  it('fails open — a GitHub error yields empty steering, never a throw', () => {
    const state = makeBatchState({ batch_id: 'self' });
    const f = tmpState(state);
    const result = populateCrossBatchSteering(state, f, {
      read: () => { throw new Error('gh issue list failed: network'); },
    });
    expect(result).toEqual([]);
    expect(state.cross_batch_steering).toEqual([]);
  });
});

describe('loadReflectionHistory', () => {
  it('returns empty string when no history file exists', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'hist-none-'));
    expect(loadReflectionHistory(tmpDir)).toBe('');
  });

  it('returns empty string for empty array', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'hist-empty-'));
    writeFileSync(join(tmpDir, 'reflection-history.json'), '[]');
    expect(loadReflectionHistory(tmpDir)).toBe('');
  });

  it('formats reflection entries with run number, success rate, and insights', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'hist-data-'));
    const history = [
      {
        timestamp: '2026-03-23T01:00:00Z',
        runCount: 5,
        successRate: 0.8,
        avgCostPerPr: 1.50,
        insights: [
          { type: 'success_pattern', message: 'Hooks issues merge quickly' },
          { type: 'recommendation', message: 'Focus on testing gaps' },
        ],
        avoidIssues: [],
      },
      {
        timestamp: '2026-03-23T02:00:00Z',
        runCount: 15,
        successRate: 0.6,
        avgCostPerPr: 2.00,
        insights: [
          { type: 'failure_pattern', message: 'Large refactors fail' },
        ],
        avoidIssues: ['500'],
      },
    ];
    writeFileSync(join(tmpDir, 'reflection-history.json'), JSON.stringify(history));

    const result = loadReflectionHistory(tmpDir);
    expect(result).toContain('Reflection 1');
    expect(result).toContain('after run 5');
    expect(result).toContain('success: 80%');
    expect(result).toContain('Hooks issues merge quickly');
    expect(result).toContain('Reflection 2');
    expect(result).toContain('after run 15');
    expect(result).toContain('Large refactors fail');
  });

  it('returns empty string for corrupted file', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'hist-bad-'));
    writeFileSync(join(tmpDir, 'reflection-history.json'), 'not json');
    expect(loadReflectionHistory(tmpDir)).toBe('');
  });
});

describe('buildTemplateVars includes prior_reflections', () => {
  it('includes prior_reflections when reflection-history.json exists', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vars-hist-'));
    const history = [{
      timestamp: '2026-03-23T01:00:00Z',
      runCount: 8,
      successRate: 0.75,
      avgCostPerPr: 1.80,
      insights: [{ type: 'recommendation', message: 'Prioritize testing' }],
      avoidIssues: [],
    }];
    writeFileSync(join(tmpDir, 'reflection-history.json'), JSON.stringify(history));

    const state = makeBatchState();
    const vars = buildTemplateVars(state, 10, tmpDir);
    expect(vars.prior_reflections).toContain('Prioritize testing');
    expect(vars.prior_reflections).toContain('Reflection 1');
  });

  it('returns empty prior_reflections when no history exists', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vars-nohist-'));
    const state = makeBatchState();
    const vars = buildTemplateVars(state, 3, tmpDir);
    expect(vars.prior_reflections).toBe('');
  });
});

describe('buildTemplateVars with run_history', () => {
  it('populates run_history_table and batch stats when run_history exists', () => {
    const state = makeBatchState({
      run_history: [
        makeRunMetrics({ run: 1, cost_usd: 1.0, prs: ['pr1'], issues_closed: ['#10'], mode: 'exploit' }),
        makeRunMetrics({ run: 2, cost_usd: 2.0, prs: ['pr2', 'pr3'], issues_closed: ['#20', '#30'], mode: 'explore' }),
      ],
      prs: ['https://github.com/Garsson-io/kaizen/pull/100', 'https://github.com/Garsson-io/kaizen/pull/101'],
    });

    const vars = buildTemplateVars(state, 3);

    expect(vars.run_history_table).toContain('| Run | Mode | Cost | PRs | Issues | Duration | Status |');
    expect(vars.run_history_table).toContain('exploit');
    expect(vars.run_history_table).toContain('explore');
    expect(vars.total_cost).toBe('3.00');
    expect(vars.pr_count).toBe('3');
    expect(vars.issues_closed_count).toBe('3');
    expect(vars.run_count).toBe('2');
    expect(vars.pr_merge_status).toContain('pull/100');
    expect(vars.pr_merge_status).toContain('pull/101');
    // Each PR line should include a status label (merged, open, closed, or unknown)
    for (const line of vars.pr_merge_status.split('\n')) {
      expect(line).toMatch(/— \*\*(merged|open|closed)\*\*|— unknown/);
    }
  });

  it('returns empty strings when no run_history exists', () => {
    const state = makeBatchState();
    const vars = buildTemplateVars(state, 1);

    expect(vars.run_history_table).toBe('');
    expect(vars.total_cost).toBe('');
    expect(vars.pr_count).toBe('');
    expect(vars.issues_closed_count).toBe('');
    expect(vars.run_count).toBe('');
    expect(vars.pr_merge_status).toBe('');
  });

  it('returns empty pr_merge_status when no PRs in state', () => {
    const state = makeBatchState({
      run_history: [makeRunMetrics({ prs: ['pr1'] })],
      prs: [],
    });
    const vars = buildTemplateVars(state, 2);

    expect(vars.run_history_table).not.toBe('');
    expect(vars.pr_merge_status).toBe('');
  });

  it('handles failed runs correctly in the history table', () => {
    const state = makeBatchState({
      run_history: [
        makeRunMetrics({ run: 1, exit_code: 1, prs: [], cost_usd: 0.5, mode: 'exploit' }),
      ],
    });
    const vars = buildTemplateVars(state, 2);

    expect(vars.run_history_table).toContain('crash');
    expect(vars.total_cost).toBe('0.50');
    expect(vars.pr_count).toBe('0');
  });
});

describe('buildTemplateVars with contemplation_recommendations', () => {
  it('formats contemplation recommendations as numbered list', () => {
    const state = makeBatchState({
      contemplation_recommendations: [
        'Shift focus to testing gaps',
        'Epic #548 needs decomposition',
      ],
    });
    const vars = buildTemplateVars(state, 5);
    expect(vars.contemplation_recommendations).toBe(
      '1. Shift focus to testing gaps\n2. Epic #548 needs decomposition',
    );
  });

  it('returns empty string when no contemplation recommendations', () => {
    const state = makeBatchState();
    const vars = buildTemplateVars(state, 1);
    expect(vars.contemplation_recommendations).toBe('');
  });

  it('returns empty string for empty array', () => {
    const state = makeBatchState({ contemplation_recommendations: [] });
    const vars = buildTemplateVars(state, 1);
    expect(vars.contemplation_recommendations).toBe('');
  });

  it('deduplicates identical recommendations (#700)', () => {
    const state = makeBatchState({
      contemplation_recommendations: [
        'Shift focus to testing gaps',
        'Epic #548 needs decomposition',
        'Shift focus to testing gaps',
        'Epic #548 needs decomposition',
        'Shift focus to testing gaps',
        'Epic #548 needs decomposition',
      ],
    });
    const vars = buildTemplateVars(state, 5);
    expect(vars.contemplation_recommendations).toBe(
      '1. Shift focus to testing gaps\n2. Epic #548 needs decomposition',
    );
  });
});

describe('renderTemplate', () => {
  it('substitutes simple variables', () => {
    const result = renderTemplate('Hello {{name}}!', { name: 'world' });
    expect(result).toBe('Hello world!');
  });

  it('preserves unresolved variables', () => {
    const result = renderTemplate('{{known}} and {{unknown}}', { known: 'yes' });
    expect(result).toBe('yes and {{unknown}}');
  });

  it('renders conditional sections when variable is non-empty', () => {
    const result = renderTemplate(
      'before\n{{#items}}Items: {{items}}{{/items}}\nafter',
      { items: 'a b c' },
    );
    expect(result).toContain('Items: a b c');
    expect(result).toContain('before');
    expect(result).toContain('after');
  });

  it('removes conditional sections when variable is empty', () => {
    const result = renderTemplate(
      'before\n{{#items}}Items: {{items}}{{/items}}\nafter',
      { items: '' },
    );
    expect(result).not.toContain('Items:');
    expect(result).toContain('before');
    expect(result).toContain('after');
  });

  it('handles multiple conditional sections', () => {
    const template = '{{#a}}A={{a}}{{/a}} {{#b}}B={{b}}{{/b}}';
    const result = renderTemplate(template, { a: '1', b: '' });
    expect(result).toContain('A=1');
    expect(result).not.toContain('B=');
  });

  it('collapses excessive blank lines from removed sections', () => {
    const template = 'top\n\n{{#empty}}removed{{/empty}}\n\n\nbottom';
    const result = renderTemplate(template, { empty: '' });
    expect(result).not.toMatch(/\n{3,}/);
  });

  it('trims leading and trailing whitespace', () => {
    const result = renderTemplate('\n  Hello  \n', {});
    expect(result).toBe('Hello');
  });
});

describe('loadPromptTemplate', () => {
  it('loads existing template file', () => {
    const template = loadPromptTemplate('deep-dive-default.md');
    expect(template).not.toBeNull();
    expect(template).toContain('{{guidance}}');
    expect(template).toContain('{{run_tag}}');
    expect(template).toContain('AUTO_DENT_PHASE: STOP');
  });

  it('loads test-task template file', () => {
    const template = loadPromptTemplate('test-task.md');
    expect(template).not.toBeNull();
    expect(template).toContain('synthetic test task');
    expect(template).toContain('{{run_tag}}');
  });

  it('returns null for non-existent template', () => {
    const template = loadPromptTemplate('nonexistent-template.md');
    expect(template).toBeNull();
  });
});

describe('buildPrompt with templates', () => {
  it('uses template file for deep-dive prompt', () => {
    const state = makeBatchState();
    const prompt = buildPrompt(state, 1);
    expect(prompt).toContain('/kaizen-deep-dive');
    expect(prompt).toContain('improve hooks reliability');
    expect(prompt).toContain('batch-260322-2100-a1b2/run-1');
    expect(prompt).toContain('AUTO_DENT_PHASE: STOP');
    // Should not contain raw template variables
    expect(prompt).not.toContain('{{guidance}}');
    expect(prompt).not.toContain('{{run_tag}}');
  });

  it('uses template file for test-task prompt', () => {
    const state = makeBatchState({ test_task: true });
    const prompt = buildPrompt(state, 1);
    expect(prompt).toContain('synthetic test task');
    expect(prompt).toContain('test-probe');
    expect(prompt).not.toContain('{{run_tag}}');
  });

  it('renders conditional sections based on state', () => {
    const stateWithHistory = makeBatchState({
      issues_closed: ['#100', '#200'],
      prs: ['https://github.com/Garsson-io/kaizen/pull/450'],
    });
    const prompt = buildPrompt(stateWithHistory, 2);
    expect(prompt).toContain('#100 #200');
    expect(prompt).toContain('pull/450');
    expect(prompt).toContain('do not rework');
    expect(prompt).toContain('avoid overlapping');
  });

  it('omits conditional sections when state arrays are empty', () => {
    const state = makeBatchState();
    const prompt = buildPrompt(state, 1);
    expect(prompt).not.toContain('do not rework');
    expect(prompt).not.toContain('avoid overlapping');
  });
});

describe('extractArtifacts', () => {
  it('extracts PR URLs from structured phase markers', () => {
    const result = makeRunResult();
    extractArtifacts(
      'AUTO_DENT_PHASE: PR | url=https://github.com/Garsson-io/kaizen/pull/450',
      result,
    );
    expect(result.prs).toEqual([
      'https://github.com/Garsson-io/kaizen/pull/450',
    ]);
  });

  it('tracks the structured work cycle from phase markers', () => {
    const result = makeRunResult();
    extractArtifacts([
      'AUTO_DENT_PHASE: PICK | issue=#1225 | title=redo CI proof gate',
      'AUTO_DENT_PHASE: EVALUATE | verdict=proceed | reason=concrete defect',
      'AUTO_DENT_PHASE: IMPLEMENT | case=2606272230-k1225 | branch=case/2606272230-k1225-ci-proof-redo',
      'AUTO_DENT_PHASE: TEST | result=pass | count=4',
      'AUTO_DENT_PHASE: PR | url=https://github.com/Garsson-io/kaizen/pull/1227',
      'AUTO_DENT_PHASE: MERGE | url=https://github.com/Garsson-io/kaizen/pull/1227 | status=queued',
    ].join('\n'), result);

    expect(result.pickedIssue).toBe('#1225');
    expect(result.pickedIssueTitle).toBe('redo CI proof gate');
    expect(result.progressSteps?.map((s) => s.phase)).toEqual([
      'PICK',
      'EVALUATE',
      'IMPLEMENT',
      'TEST',
      'PR',
      'MERGE',
    ]);
    expect(result.progressSteps?.find((s) => s.phase === 'PR')?.url).toBe('https://github.com/Garsson-io/kaizen/pull/1227');
  });

  it('extracts multiple PR URLs from structured phase markers', () => {
    const result = makeRunResult();
    extractArtifacts(
      [
        'AUTO_DENT_PHASE: PR | url=https://github.com/Garsson-io/kaizen/pull/450',
        'AUTO_DENT_PHASE: PR | url=https://github.com/Garsson-io/kaizen/pull/451',
      ].join('\n'),
      result,
    );
    expect(result.prs).toHaveLength(2);
  });

  it('extracts PR URLs from explicit final "PRs created" summary lines', () => {
    const result = makeRunResult();
    extractArtifacts(
      '**PRs created:** https://github.com/Garsson-io/kaizen/pull/1236 (auto-merge queued)',
      result,
    );

    expect(result.prs).toEqual(['https://github.com/Garsson-io/kaizen/pull/1236']);
    expect(result.progressSteps?.find((s) => s.phase === 'PR')?.url).toBe('https://github.com/Garsson-io/kaizen/pull/1236');
  });

  it('deduplicates PR URLs', () => {
    const result = makeRunResult();
    extractArtifacts(
      'AUTO_DENT_PHASE: PR | url=https://github.com/Garsson-io/kaizen/pull/450',
      result,
    );
    extractArtifacts(
      'AUTO_DENT_PHASE: PR | url=https://github.com/Garsson-io/kaizen/pull/450',
      result,
    );
    expect(result.prs).toHaveLength(1);
  });

  it('extracts filed issue URLs from structured phase markers', () => {
    const result = makeRunResult();
    extractArtifacts(
      'AUTO_DENT_PHASE: REFLECT | issues_filed=https://github.com/Garsson-io/kaizen/issues/267',
      result,
    );
    expect(result.issuesFiled).toEqual([
      'https://github.com/Garsson-io/kaizen/issues/267',
    ]);
  });

  it('extracts closed issue references from structured phase markers', () => {
    const result = makeRunResult();
    extractArtifacts('AUTO_DENT_PHASE: REFLECT | issues_closed=#100,#200,#300', result);
    expect(result.issuesClosed).toContain('#100');
    expect(result.issuesClosed).toContain('#200');
    expect(result.issuesClosed).toContain('#300');
  });

  it('does not treat referenced PRs or issues as produced artifacts (#1203)', () => {
    const result = makeRunResult();
    extractArtifacts([
      'AUTO_DENT_PHASE: PICK | issue=#1003 | title=checking availability',
      'AUTO_DENT_PHASE: EVALUATE | verdict=skip | reason=issue #1003 is already covered by open PR #1012',
      'AUTO_DENT_PHASE: STOP | reason=#1003 is effectively claimed by open PR https://github.com/Garsson-io/kaizen/pull/1012',
      'Evidence:',
      '- Issue `#1003` is open and unassigned, but active PR `#1012` explicitly includes `Fixes Garsson-io/kaizen#1003`.',
      '- Related PR: https://github.com/Garsson-io/kaizen/pull/621',
      '- Related issue: https://github.com/Garsson-io/kaizen/issues/1009',
      'No PRs created, no issues filed, no issues closed.',
    ].join('\n'), result);
    expect(result.prs).toEqual([]);
    expect(result.issuesFiled).toEqual([]);
    expect(result.issuesClosed).toEqual([]);
  });

  it('extracts case references', () => {
    const result = makeRunResult();
    extractArtifacts('case: 260322-1200-k451-hook-fix', result);
    expect(result.cases).toContain('260322-1200-k451-hook-fix');
  });

  it('handles text with no artifacts', () => {
    const result = makeRunResult();
    extractArtifacts('Just some regular text with no references', result);
    expect(result.prs).toHaveLength(0);
    expect(result.issuesFiled).toHaveLength(0);
    expect(result.issuesClosed).toHaveLength(0);
    expect(result.cases).toHaveLength(0);
  });

  it('counts issues pruned from gh issue close --reason not-planned', () => {
    const result = makeRunResult();
    extractArtifacts(
      'gh issue close 123 --repo Garsson-io/kaizen --reason not-planned\ngh issue close 456 --repo Garsson-io/kaizen --reason not-planned',
      result,
    );
    expect(result.issuesPruned).toBe(2);
  });

  it('does not count gh issue close without not-planned as pruned', () => {
    const result = makeRunResult();
    extractArtifacts('gh issue close 123 --repo Garsson-io/kaizen', result);
    expect(result.issuesPruned).toBe(0);
  });

  it('extracts net lines deleted from git diff stat output', () => {
    const result = makeRunResult();
    extractArtifacts(
      '5 files changed, 10 insertions(+), 60 deletions(-)',
      result,
    );
    expect(result.linesDeleted).toBe(50);
  });

  it('does not count lines deleted when insertions exceed deletions', () => {
    const result = makeRunResult();
    extractArtifacts(
      '3 files changed, 100 insertions(+), 20 deletions(-)',
      result,
    );
    expect(result.linesDeleted).toBe(0);
  });

  it('accumulates lines deleted across multiple diff stats', () => {
    const result = makeRunResult();
    extractArtifacts(
      '2 files changed, 5 insertions(+), 25 deletions(-)\n3 files changed, 10 insertions(+), 40 deletions(-)',
      result,
    );
    expect(result.linesDeleted).toBe(50);
  });
});

describe('extractContemplationRecommendations', () => {
  it('extracts structured recommendations from contemplate output', () => {
    const text = [
      'Some analysis text...',
      'CONTEMPLATION_REC: Shift focus from hooks to testing gaps',
      'More analysis...',
      'CONTEMPLATION_REC: Epic #548 is stalled — decompose next run',
    ].join('\n');
    const recs = extractContemplationRecommendations(text);
    expect(recs).toEqual([
      'Shift focus from hooks to testing gaps',
      'Epic #548 is stalled — decompose next run',
    ]);
  });

  it('returns empty array when no recommendations present', () => {
    expect(extractContemplationRecommendations('just regular text')).toEqual([]);
  });

  it('trims whitespace from recommendations', () => {
    const recs = extractContemplationRecommendations('CONTEMPLATION_REC:   padded text   ');
    expect(recs).toEqual(['padded text']);
  });

  it('ignores empty recommendations', () => {
    const text = ['CONTEMPLATION_REC:   ', 'CONTEMPLATION_REC: valid'].join('\n');
    const recs = extractContemplationRecommendations(text);
    expect(recs).toEqual(['valid']);
  });

  it('only matches at start of line', () => {
    const recs = extractContemplationRecommendations('some text CONTEMPLATION_REC: not a rec');
    expect(recs).toEqual([]);
  });
});

describe('extractReflectionInsights', () => {
  it('extracts structured insights from reflect-mode output', () => {
    const text = [
      'Some analysis text...',
      'REFLECTION_INSIGHT: Prioritize testing issues — 80% success rate',
      'More analysis...',
      'REFLECTION_INSIGHT: Avoid issue #472 — blocked on upstream merge',
    ].join('\n');
    const insights = extractReflectionInsights(text);
    expect(insights).toEqual([
      'Prioritize testing issues — 80% success rate',
      'Avoid issue #472 — blocked on upstream merge',
    ]);
  });

  it('returns empty array when no insights present', () => {
    expect(extractReflectionInsights('just regular text')).toEqual([]);
  });

  it('trims whitespace from insights', () => {
    const insights = extractReflectionInsights('REFLECTION_INSIGHT:   padded text   ');
    expect(insights).toEqual(['padded text']);
  });

  it('ignores empty insights', () => {
    const text = ['REFLECTION_INSIGHT:   ', 'REFLECTION_INSIGHT: valid'].join('\n');
    const insights = extractReflectionInsights(text);
    expect(insights).toEqual(['valid']);
  });

  it('only matches at start of line', () => {
    const insights = extractReflectionInsights('some text REFLECTION_INSIGHT: not an insight');
    expect(insights).toEqual([]);
  });
});

describe('buildTemplateVars with reflection_insights from state', () => {
  it('formats state reflection insights as numbered list', () => {
    const state = makeBatchState({
      reflection_insights: [
        'Prioritize testing issues',
        'Avoid blocked issues',
      ],
    });
    const vars = buildTemplateVars(state, 5);
    expect(vars.reflection_insights).toContain('1. Prioritize testing issues');
    expect(vars.reflection_insights).toContain('2. Avoid blocked issues');
  });

  it('returns empty string when no state reflection insights and no logDir', () => {
    const state = makeBatchState();
    const vars = buildTemplateVars(state, 1);
    expect(vars.reflection_insights).toBe('');
  });

  it('returns empty string for empty array', () => {
    const state = makeBatchState({ reflection_insights: [] });
    const vars = buildTemplateVars(state, 1);
    expect(vars.reflection_insights).toBe('');
  });

  it('deduplicates identical insights', () => {
    const state = makeBatchState({
      reflection_insights: [
        'Prioritize testing issues',
        'Avoid blocked issues',
        'Prioritize testing issues',
      ],
    });
    const vars = buildTemplateVars(state, 5);
    expect(vars.reflection_insights).toContain('1. Prioritize testing issues');
    expect(vars.reflection_insights).toContain('2. Avoid blocked issues');
    expect(vars.reflection_insights).not.toContain('3.');
  });

  it('merges file-based and state-based insights when logDir has reflection-summary.json', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'reflect-merge-'));
    const summary = {
      timestamp: new Date().toISOString(),
      runCount: 3,
      successRate: 0.67,
      avgCostPerPr: 2.50,
      insights: [{ type: 'success_pattern', message: 'Testing hooks works well' }],
      avoidIssues: [],
    };
    writeFileSync(join(tmpDir, 'reflection-summary.json'), JSON.stringify(summary));

    const state = makeBatchState({
      reflection_insights: ['Agent insight: focus on tests'],
    });
    const vars = buildTemplateVars(state, 5, tmpDir);
    expect(vars.reflection_insights).toContain('Testing hooks works well');
    expect(vars.reflection_insights).toContain('Agent Reflection Insights');
    expect(vars.reflection_insights).toContain('1. Agent insight: focus on tests');
  });
});

describe('checkStopSignal', () => {
  it('detects structured STOP phase marker (preferred format)', () => {
    const result = makeRunResult();
    checkStopSignal(
      'AUTO_DENT_PHASE: STOP | reason=backlog exhausted — no more open issues',
      result,
    );
    expect(result.stopRequested).toBe(true);
    expect(result.stopReason).toBe(
      'backlog exhausted — no more open issues',
    );
  });

  it('detects legacy AUTO_DENT_STOP signal', () => {
    const result = makeRunResult();
    checkStopSignal(
      'AUTO_DENT_STOP: backlog exhausted — no more open issues',
      result,
    );
    expect(result.stopRequested).toBe(true);
    expect(result.stopReason).toBe(
      'backlog exhausted — no more open issues',
    );
  });

  it('prefers structured format over legacy when both present', () => {
    const result = makeRunResult();
    checkStopSignal(
      'AUTO_DENT_PHASE: STOP | reason=structured reason\nAUTO_DENT_STOP: legacy reason',
      result,
    );
    expect(result.stopRequested).toBe(true);
    expect(result.stopReason).toBe('structured reason');
  });

  it('does not trigger on STOP phase without reason field', () => {
    const result = makeRunResult();
    checkStopSignal('AUTO_DENT_PHASE: STOP', result);
    expect(result.stopRequested).toBe(false);
  });

  it('does not trigger on text without stop signal', () => {
    const result = makeRunResult();
    checkStopSignal('Just regular output about AUTO_DENT features', result);
    expect(result.stopRequested).toBe(false);
  });

  it('trims whitespace from legacy stop reason', () => {
    const result = makeRunResult();
    checkStopSignal('AUTO_DENT_STOP:   spaces around reason   ', result);
    expect(result.stopReason).toBe('spaces around reason');
  });

  it('does not false-trigger on mid-sentence stop signal mention', () => {
    const result = makeRunResult();
    checkStopSignal(
      'The agent uses AUTO_DENT_STOP: <reason> to signal completion',
      result,
    );
    expect(result.stopRequested).toBe(false);
  });

  it('does not match removed OVERNIGHT_STOP legacy signal', () => {
    const result = makeRunResult();
    checkStopSignal('OVERNIGHT_STOP: all done', result);
    expect(result.stopRequested).toBe(false);
  });

  it('detects legacy stop signal on its own line amid other text', () => {
    const result = makeRunResult();
    checkStopSignal(
      'Some preamble\nAUTO_DENT_STOP: backlog exhausted\nSome epilogue',
      result,
    );
    expect(result.stopRequested).toBe(true);
    expect(result.stopReason).toBe('backlog exhausted');
  });

  it('detects structured stop amid other phase markers', () => {
    const result = makeRunResult();
    checkStopSignal(
      'AUTO_DENT_PHASE: REFLECT | issues_filed=0 | lessons=done\nAUTO_DENT_PHASE: STOP | reason=all issues claimed',
      result,
    );
    expect(result.stopRequested).toBe(true);
    expect(result.stopReason).toBe('all issues claimed');
  });

  it('does not false-trigger when discussing the STOP phase in prose', () => {
    const result = makeRunResult();
    checkStopSignal(
      'The AUTO_DENT_PHASE: STOP | reason=... marker is used to signal batch termination',
      result,
    );
    // Both structured and legacy formats require the marker at start of line.
    // Mid-sentence discussion of the signal mechanism does not trigger.
    expect(result.stopRequested).toBe(false);
  });
});

describe('parsePhaseMarkers', () => {
  it('parses a PICK marker with fields', () => {
    const markers = parsePhaseMarkers('AUTO_DENT_PHASE: PICK | issue=#472 | title=improve hook test DRY');
    expect(markers).toHaveLength(1);
    expect(markers[0].phase).toBe('PICK');
    expect(markers[0].fields.issue).toBe('#472');
    expect(markers[0].fields.title).toBe('improve hook test DRY');
  });

  it('parses a phase with no fields', () => {
    const markers = parsePhaseMarkers('AUTO_DENT_PHASE: REFLECT');
    expect(markers).toHaveLength(1);
    expect(markers[0].phase).toBe('REFLECT');
    expect(markers[0].fields).toEqual({});
  });

  it('parses multiple markers in multi-line text', () => {
    const text = [
      'Some preamble text',
      'AUTO_DENT_PHASE: PICK | issue=#472 | title=hook DRY',
      'More text in between',
      'AUTO_DENT_PHASE: EVALUATE | verdict=proceed | reason=clear spec',
      'AUTO_DENT_PHASE: IMPLEMENT | case=260323-1200-k472',
    ].join('\n');
    const markers = parsePhaseMarkers(text);
    expect(markers).toHaveLength(3);
    expect(markers[0].phase).toBe('PICK');
    expect(markers[1].phase).toBe('EVALUATE');
    expect(markers[2].phase).toBe('IMPLEMENT');
  });

  it('ignores non-marker lines', () => {
    const markers = parsePhaseMarkers('Just regular text about implementing things');
    expect(markers).toHaveLength(0);
  });

  it('ignores mid-line markers (must start at beginning of line)', () => {
    const markers = parsePhaseMarkers('The agent uses AUTO_DENT_PHASE: PICK | issue=#1');
    expect(markers).toHaveLength(0);
  });

  it('handles fields with URLs containing equals signs', () => {
    const markers = parsePhaseMarkers('AUTO_DENT_PHASE: PR | url=https://github.com/Garsson-io/kaizen/pull/500');
    expect(markers).toHaveLength(1);
    expect(markers[0].fields.url).toBe('https://github.com/Garsson-io/kaizen/pull/500');
  });

  it('parses TEST marker with result and count', () => {
    const markers = parsePhaseMarkers('AUTO_DENT_PHASE: TEST | result=pass | count=15');
    expect(markers).toHaveLength(1);
    expect(markers[0].fields.result).toBe('pass');
    expect(markers[0].fields.count).toBe('15');
  });

  it('parses MERGE marker with status', () => {
    const markers = parsePhaseMarkers('AUTO_DENT_PHASE: MERGE | url=https://github.com/Garsson-io/kaizen/pull/500 | status=queued');
    expect(markers).toHaveLength(1);
    expect(markers[0].fields.status).toBe('queued');
  });
});

describe('formatPhaseMarker', () => {
  it('formats PICK with issue and title', () => {
    const result = formatPhaseMarker({ phase: 'PICK', fields: { issue: '#472', title: 'improve hook test DRY' } });
    expect(result).toContain('[PICK]');
    expect(result).toContain('#472');
    expect(result).toContain('improve hook test DRY');
  });

  it('formats EVALUATE with verdict and reason', () => {
    const result = formatPhaseMarker({ phase: 'EVALUATE', fields: { verdict: 'proceed', reason: 'clear spec' } });
    expect(result).toContain('[EVALUATE]');
    expect(result).toContain('proceed');
    expect(result).toContain('(clear spec)');
  });

  it('formats IMPLEMENT with case and branch', () => {
    const result = formatPhaseMarker({ phase: 'IMPLEMENT', fields: { case: '260323-1200-k472', branch: 'case/260323-1200-k472' } });
    expect(result).toContain('[IMPLEMENT]');
    expect(result).toContain('case:260323-1200-k472');
    expect(result).toContain('branch:case/260323-1200-k472');
  });

  it('formats TEST with result and count', () => {
    const result = formatPhaseMarker({ phase: 'TEST', fields: { result: 'pass', count: '15' } });
    expect(result).toContain('[TEST]');
    expect(result).toContain('pass');
    expect(result).toContain('15 tests');
  });

  it('formats PR with url', () => {
    const result = formatPhaseMarker({ phase: 'PR', fields: { url: 'https://github.com/Garsson-io/kaizen/pull/500' } });
    expect(result).toContain('[PR]');
    expect(result).toContain('https://github.com/Garsson-io/kaizen/pull/500');
  });

  it('formats MERGE with url and status', () => {
    const result = formatPhaseMarker({ phase: 'MERGE', fields: { url: 'https://github.com/Garsson-io/kaizen/pull/500', status: 'queued' } });
    expect(result).toContain('[MERGE]');
    expect(result).toContain('https://github.com/Garsson-io/kaizen/pull/500');
    expect(result).toContain('queued');
  });

  it('formats REFLECT with issues_filed and lessons', () => {
    const result = formatPhaseMarker({ phase: 'REFLECT', fields: { issues_filed: '2', lessons: 'shared helpers reduce boilerplate' } });
    expect(result).toContain('[REFLECT]');
    expect(result).toContain('2 issues filed');
    expect(result).toContain('shared helpers reduce boilerplate');
  });

  it('formats phase with no fields', () => {
    const result = formatPhaseMarker({ phase: 'REFLECT', fields: {} });
    expect(result).toContain('[REFLECT]');
  });

  it('truncates very long output', () => {
    const longTitle = 'A'.repeat(200);
    const result = formatPhaseMarker({ phase: 'PICK', fields: { issue: '#1', title: longTitle } });
    // Allow for icon prefix (2 chars + space) in length check
    expect(result.length).toBeLessThanOrEqual(125);
  });

  it('formats DECOMPOSE with epic and issues_created', () => {
    const result = formatPhaseMarker({ phase: 'DECOMPOSE', fields: { epic: '#506', issues_created: '#560,#561,#562' } });
    expect(result).toContain('[DECOMPOSE]');
    expect(result).toContain('epic:#506');
    expect(result).toContain('created:#560,#561,#562');
  });

  it('formats DECOMPOSE with epic only', () => {
    const result = formatPhaseMarker({ phase: 'DECOMPOSE', fields: { epic: '#548' } });
    expect(result).toContain('[DECOMPOSE]');
    expect(result).toContain('epic:#548');
  });

  it('includes phase icon prefix', () => {
    const result = formatPhaseMarker({ phase: 'PICK', fields: {} });
    // Should contain the ◉ icon
    expect(result).toContain('\u25c9');
  });

  it('uses stop icon for STOP phase', () => {
    const result = formatPhaseMarker({ phase: 'STOP', fields: { reason: 'done' } });
    // Should contain the ● icon for STOP
    expect(result).toContain('\u25cf');
  });
});

describe('formatToolUse', () => {
  it('formats Read tool with file path', () => {
    expect(formatToolUse('Read', { file_path: '/src/hooks/main.ts' })).toBe(
      'Read /src/hooks/main.ts',
    );
  });

  it('formats Edit tool with file path', () => {
    expect(formatToolUse('Edit', { file_path: '/src/hooks/main.ts' })).toBe(
      'Edit /src/hooks/main.ts',
    );
  });

  it('formats Write tool with file path', () => {
    expect(formatToolUse('Write', { file_path: '/src/new-file.ts' })).toBe(
      'Write /src/new-file.ts',
    );
  });

  it('formats Bash tool with command', () => {
    expect(formatToolUse('Bash', { command: 'npm test' })).toBe('$ npm test');
  });

  it('formats Bash tool with description fallback', () => {
    expect(formatToolUse('Bash', { description: 'Run tests' })).toBe(
      '$ Run tests',
    );
  });

  it('formats Grep tool with pattern and path', () => {
    expect(
      formatToolUse('Grep', { pattern: 'TODO', path: 'src/' }),
    ).toBe('Grep "TODO" src/');
  });

  it('formats Glob tool with pattern', () => {
    expect(formatToolUse('Glob', { pattern: '**/*.test.ts' })).toBe(
      'Glob **/*.test.ts',
    );
  });

  it('formats Skill tool with skill name', () => {
    expect(formatToolUse('Skill', { skill: 'kaizen-reflect' })).toBe(
      'Skill /kaizen-reflect',
    );
  });

  it('formats Agent tool with description', () => {
    expect(
      formatToolUse('Agent', { description: 'Research codebase' }),
    ).toBe('Agent: Research codebase');
  });

  it('truncates long file paths', () => {
    const longPath = '/very/long/path/' + 'a'.repeat(100) + '/file.ts';
    const result = formatToolUse('Read', { file_path: longPath });
    expect(result.length).toBeLessThan(70);
    expect(result).toContain('\u2026');
  });

  it('returns just the tool name for unknown tools', () => {
    expect(formatToolUse('CustomTool', {})).toBe('CustomTool');
  });
});

describe('processStreamMessage', () => {
  it('processes system init message', () => {
    const result = makeRunResult();
    processStreamMessage(
      {
        type: 'system',
        subtype: 'init',
        session_id: 'abc123def456',
        model: 'claude-opus-4-6',
      },
      result,
      Date.now(),
    );
    // init message is logged but doesn't modify result
    expect(result.toolCalls).toBe(0);
  });

  it('counts tool_use blocks in assistant messages', () => {
    const result = makeRunResult();
    processStreamMessage(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } },
            { type: 'tool_use', name: 'Grep', input: { pattern: 'foo' } },
          ],
        },
      },
      result,
      Date.now(),
    );
    expect(result.toolCalls).toBe(2);
  });

  it('extracts artifacts from assistant text blocks', () => {
    const result = makeRunResult();
    processStreamMessage(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'AUTO_DENT_PHASE: PR | url=https://github.com/Garsson-io/kaizen/pull/500',
            },
          ],
        },
      },
      result,
      Date.now(),
    );
    expect(result.prs).toContain(
      'https://github.com/Garsson-io/kaizen/pull/500',
    );
  });

  it('detects stop signal in assistant text', () => {
    const result = makeRunResult();
    processStreamMessage(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'AUTO_DENT_PHASE: STOP | reason=backlog exhausted' },
          ],
        },
      },
      result,
      Date.now(),
    );
    expect(result.stopRequested).toBe(true);
  });

  it('records cost from result message', () => {
    const result = makeRunResult();
    processStreamMessage(
      {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 2.5,
        result: 'All done',
      },
      result,
      Date.now(),
    );
    expect(result.cost).toBe(2.5);
  });

  it('extracts artifacts from result text', () => {
    const result = makeRunResult();
    processStreamMessage(
      {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 1.0,
        result:
          [
            'AUTO_DENT_PHASE: PR | url=https://github.com/Garsson-io/kaizen/pull/500',
            'AUTO_DENT_PHASE: REFLECT | issues_closed=#451',
          ].join('\n'),
      },
      result,
      Date.now(),
    );
    expect(result.prs).toContain(
      'https://github.com/Garsson-io/kaizen/pull/500',
    );
    expect(result.issuesClosed).toContain('#451');
  });

  it('extracts PR artifacts from Claude Code tool result metadata', () => {
    const result = makeRunResult();
    processStreamMessage(
      {
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            content: 'https://github.com/Garsson-io/kaizen/pull/1236',
          }],
        },
        tool_use_result: {
          gitOperation: {
            pr: {
              action: 'created',
              url: 'https://github.com/Garsson-io/kaizen/pull/1236',
            },
          },
        },
      },
      result,
      Date.now(),
    );

    expect(result.prs).toEqual(['https://github.com/Garsson-io/kaizen/pull/1236']);
    expect(result.progressSteps?.find((s) => s.phase === 'PR')).toMatchObject({
      state: 'created',
      url: 'https://github.com/Garsson-io/kaizen/pull/1236',
    });
  });

  it('captures structured final claims from result text', () => {
    const result = makeRunResult();
    processStreamMessage(
      {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 1.0,
        result: JSON.stringify({
          schema_version: 1,
          selected_issue: '#1145',
          case_worktree: '2606271547-k1145-final-claim-contract',
          tests: { status: 'pass', command: 'npm test', count: 5, evidence: ['5 passed'] },
          pr_url: 'https://github.com/Garsson-io/kaizen/pull/1176',
          review_status: 'pass',
          reflection_status: 'done',
          stop_reason: null,
          blockers: [],
        }),
      },
      result,
      Date.now(),
    );

    expect(result.finalClaimStatus).toBe('valid');
    expect(result.finalClaim?.selected_issue).toBe('#1145');
    expect(result.finalClaimWarnings).toEqual([]);
  });

  it('handles messages without content gracefully', () => {
    const result = makeRunResult();
    processStreamMessage({ type: 'assistant' }, result, Date.now());
    processStreamMessage(
      { type: 'assistant', message: {} },
      result,
      Date.now(),
    );
    expect(result.toolCalls).toBe(0);
  });

  it('sets resultReceivedAt in context when result message arrives', () => {
    const result = makeRunResult();
    const ctx: StreamContext = {};
    const before = Date.now();
    processStreamMessage(
      {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 1.0,
        result: 'All done',
      },
      result,
      Date.now(),
      ctx,
    );
    expect(ctx.resultReceivedAt).toBeDefined();
    expect(ctx.resultReceivedAt!).toBeGreaterThanOrEqual(before);
  });

  it('does not set resultReceivedAt for non-result messages', () => {
    const result = makeRunResult();
    const ctx: StreamContext = {};
    processStreamMessage(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } },
          ],
        },
      },
      result,
      Date.now(),
      ctx,
    );
    expect(ctx.resultReceivedAt).toBeUndefined();
  });

  it('works without ctx parameter (backwards compatible)', () => {
    const result = makeRunResult();
    processStreamMessage(
      {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 1.0,
        result: 'All done',
      },
      result,
      Date.now(),
    );
    expect(result.cost).toBe(1.0);
  });
});

describe('formatHeartbeat', () => {
  it('shows working message when no result received', () => {
    const ctx: StreamContext = {};
    const msg = formatHeartbeat(Date.now() - 120_000, 42, ctx);
    expect(msg).toContain('working');
    expect(msg).toContain('42 tool calls so far');
  });

  it('shows waiting-for-exit message after result received', () => {
    const ctx: StreamContext = { resultReceivedAt: Date.now() - 30_000 };
    const msg = formatHeartbeat(Date.now() - 120_000, 90, ctx);
    expect(msg).toContain('waiting for process exit');
    expect(msg).toContain('result received');
    expect(msg).toContain('90 tool calls');
    expect(msg).toMatch(/\d+s ago/);
  });

  it('includes elapsed time from run start', () => {
    const ctx: StreamContext = {};
    const msg = formatHeartbeat(Date.now() - 180_000, 10, ctx);
    expect(msg).toMatch(/\[3m00s\]/);
  });

  it('shows accurate seconds-ago for recent result', () => {
    const ctx: StreamContext = { resultReceivedAt: Date.now() - 5_000 };
    const msg = formatHeartbeat(Date.now() - 60_000, 50, ctx);
    expect(msg).toContain('5s ago');
  });
});

describe('RunMetrics type', () => {
  it('can construct a valid RunMetrics object', () => {
    const metrics: RunMetrics = {
      run: 1,
      start_epoch: 1742680800,
      duration_seconds: 300,
      exit_code: 0,
      cost_usd: 2.5,
      tool_calls: 42,
      prs: ['https://github.com/Garsson-io/kaizen/pull/500'],
      issues_filed: [],
      issues_closed: ['#451'],
      cases: ['260322-1200-k451-hook-fix'],
      stop_requested: false,
      process_verdict: 'pass',
      process_issue_count: 0,
      process_summary: 'process verdict pass (durable evidence complete)',
      final_claim_status: 'valid',
      final_claim_path: 'logs/auto-dent/batch/run-1-final-claim.json',
      final_claim_warnings: [],
    };
    expect(metrics.run).toBe(1);
    expect(metrics.cost_usd).toBe(2.5);
    expect(metrics.prs).toHaveLength(1);
    expect(metrics.process_verdict).toBe('pass');
    expect(metrics.final_claim_status).toBe('valid');
  });

  it('supports run_history in BatchState', () => {
    const state = makeBatchState({
      run_history: [
        {
          run: 1,
          start_epoch: 1742680800,
          duration_seconds: 300,
          exit_code: 0,
          cost_usd: 2.5,
          tool_calls: 42,
          prs: [],
          issues_filed: [],
          issues_closed: [],
          cases: [],
          stop_requested: false,
        },
        {
          run: 2,
          start_epoch: 1742681400,
          duration_seconds: 450,
          exit_code: 0,
          cost_usd: 3.1,
          tool_calls: 60,
          prs: ['https://github.com/Garsson-io/kaizen/pull/501'],
          issues_filed: [],
          issues_closed: ['#452'],
          cases: [],
          stop_requested: false,
        },
      ],
    });
    expect(state.run_history).toHaveLength(2);
    const totalCost = state.run_history!.reduce(
      (sum, r) => sum + r.cost_usd,
      0,
    );
    expect(totalCost).toBeCloseTo(5.6);
  });

  it('defaults run_history to undefined when not set', () => {
    const state = makeBatchState();
    expect(state.run_history).toBeUndefined();
  });
});

describe('BatchState provider field (#1144)', () => {
  it('supports synthetic Codex provider state while preserving optional default', () => {
    const codexState = makeBatchState({ test_task: true, provider: 'codex' });
    const legacyState = makeBatchState({});

    expect(codexState.provider).toBe('codex');
    expect(codexState.test_task).toBe(true);
    expect(legacyState.provider).toBeUndefined();
  });

  it('treats Codex as a real run provider outside synthetic test-task mode (#1139)', () => {
    expect(shouldRunCodexProvider(makeBatchState({ provider: 'codex', test_task: false }))).toBe(true);
    expect(shouldRunCodexProvider(makeBatchState({ provider: 'codex', test_task: true }))).toBe(true);
    expect(shouldRunCodexProvider(makeBatchState({ provider: 'claude', test_task: false }))).toBe(false);
    expect(shouldRunCodexProvider(makeBatchState({ provider: undefined, test_task: false }))).toBe(false);
  });
});

describe('cleanGuidanceForTitle', () => {
  it('normalizes whitespace', () => {
    expect(cleanGuidanceForTitle('  hello   world  ')).toBe('hello world');
  });

  it('preserves clean guidance unchanged', () => {
    expect(cleanGuidanceForTitle('improve hooks reliability')).toBe('improve hooks reliability');
  });

  it('handles newlines and tabs', () => {
    expect(cleanGuidanceForTitle('line one\nline two\ttab')).toBe('line one line two tab');
  });
});

describe('DriveResult type', () => {
  it('is re-exported and constructable for stuck + terminal outcomes', () => {
    const reasons: DriveReason[] = [
      'blocked',
      'conflicting',
      'checks_failing',
      'timed_out',
      'unknown',
    ];
    for (const reason of reasons) {
      const result: DriveResult = {
        pr: 'https://github.com/Garsson-io/kaizen/pull/500',
        status: 'stuck',
        reason,
        attempts: 3,
      };
      expect(result.status).toBe('stuck');
      expect(result.reason).toBe(reason);
    }
    const merged: DriveResult = {
      pr: 'https://github.com/Garsson-io/kaizen/pull/501',
      status: 'merged',
      attempts: 1,
    };
    expect(merged.status).toBe('merged');
    expect(merged.reason).toBeUndefined();
  });
});

// Import the shared harness
import {
  msg,
  runStream,
  expectPhase,
  expectNoPhase,
  expectToolLogged,
} from './auto-dent-harness.js';

describe('e2e: full workflow through stream pipeline', () => {
  it('surfaces all 7 phases from a complete deep-dive run', () => {
    const capture = runStream([
      msg.init(),
      msg.phase('PICK', { issue: '#472', title: 'improve hook test DRY' }),
      msg.tool('Bash', { command: 'gh issue view 472' }),
      msg.phase('EVALUATE', { verdict: 'proceed', reason: 'clear spec and bounded scope' }),
      msg.phase('IMPLEMENT', { case: '260323-1200-k472', branch: 'case/260323-1200-k472' }),
      msg.tool('EnterWorktree', { name: 'k472-hook-test-dry' }),
      msg.phase('TEST', { result: 'pass', count: '15' }),
      msg.text('Created PR: https://github.com/Garsson-io/kaizen/pull/500'),
      msg.phase('PR', { url: 'https://github.com/Garsson-io/kaizen/pull/500' }),
      msg.phase('MERGE', { url: 'https://github.com/Garsson-io/kaizen/pull/500', status: 'queued' }),
      msg.phase('REFLECT', { issues_filed: '1', issues_closed: '#472', lessons: 'shared helpers reduce boilerplate' }),
      msg.done(2.5, 'Done.'),
    ]);

    expectPhase(capture, 'PICK', '#472', 'improve hook test DRY');
    expectPhase(capture, 'EVALUATE', 'proceed');
    expectPhase(capture, 'IMPLEMENT', 'case:260323-1200-k472');
    expectPhase(capture, 'TEST', 'pass', '15 tests');
    expectPhase(capture, 'PR', 'pull/500');
    expectPhase(capture, 'MERGE', 'queued');
    expectPhase(capture, 'REFLECT', 'issues filed');

    expect(capture.result.toolCalls).toBe(2);
    expect(capture.result.prs).toContain('https://github.com/Garsson-io/kaizen/pull/500');
    expect(capture.result.issuesClosed).toContain('#472');
    expect(capture.result.cost).toBe(2.5);
  });

  it('extracts phase markers embedded in prose blocks', () => {
    const capture = runStream([
      msg.proseWithPhase(
        'Looking at the issue backlog to find the best candidate.',
        'PICK',
        { issue: '#300', title: 'fix flaky test' },
        'This issue has clear reproduction steps and a bounded scope.',
      ),
    ]);

    expectPhase(capture, 'PICK', '#300', 'fix flaky test');
  });

  it('rejects mid-line marker mentions (no false positives)', () => {
    const capture = runStream([
      msg.text('The harness expects AUTO_DENT_PHASE: PICK markers from the agent.'),
    ]);

    expectNoPhase(capture, 'PICK');
  });

  it('handles a run with no phase markers (tools-only)', () => {
    const capture = runStream([
      msg.init(),
      msg.tool('Read', { file_path: '/src/index.ts' }),
      msg.tool('Grep', { pattern: 'TODO', path: 'src/' }),
      msg.tool('Edit', { file_path: '/src/index.ts' }),
      msg.done(1.0),
    ]);

    expect(capture.result.toolCalls).toBe(3);
    expectToolLogged(capture, 'Read /src/index.ts', 'Grep "TODO"', 'Edit /src/index.ts');
    for (const phase of ['PICK', 'EVALUATE', 'IMPLEMENT', 'TEST', 'PR', 'MERGE', 'REFLECT']) {
      expectNoPhase(capture, phase);
    }
  });

  it('handles EVALUATE skip — agent defers an issue', () => {
    const capture = runStream([
      msg.init(),
      msg.phase('PICK', { issue: '#400', title: 'risky migration' }),
      msg.phase('EVALUATE', { verdict: 'skip', reason: 'too risky for unattended batch' }),
      msg.phase('PICK', { issue: '#401', title: 'add test helpers' }),
      msg.phase('EVALUATE', { verdict: 'proceed', reason: 'safe and bounded' }),
      msg.done(0.8),
    ]);

    expect(capture.phases.filter(p => p.phase === 'PICK')).toHaveLength(2);
    expect(capture.phases.filter(p => p.phase === 'EVALUATE')).toHaveLength(2);
    expectPhase(capture, 'PICK', '#400');
    expectPhase(capture, 'PICK', '#401');
  });

  it('handles failed run with error result', () => {
    const capture = runStream([
      msg.init(),
      msg.phase('PICK', { issue: '#500', title: 'broken hook' }),
      msg.phase('IMPLEMENT', { case: '260323-1500-k500' }),
      msg.phase('TEST', { result: 'fail', count: '3' }),
      msg.error(1.2, 'Tests failed, could not complete.'),
    ]);

    expectPhase(capture, 'TEST', 'fail', '3 tests');
    expect(capture.logLines.some(l => l.includes('error'))).toBe(true);
    expect(capture.result.cost).toBe(1.2);
  });

  it('handles structured STOP phase marker alongside other phases', () => {
    const capture = runStream([
      msg.init(),
      msg.phase('PICK', { issue: '#450', title: 'last issue' }),
      msg.phase('PR', { url: 'https://github.com/Garsson-io/kaizen/pull/600' }),
      msg.phase('STOP', { reason: 'backlog exhausted — no more matching issues' }),
      msg.done(3.0, 'All done.'),
    ]);

    expectPhase(capture, 'PICK', '#450');
    expectPhase(capture, 'PR', 'pull/600');
    expectPhase(capture, 'STOP');
    expect(capture.result.stopRequested).toBe(true);
    expect(capture.result.stopReason).toContain('backlog exhausted');
  });

  it('handles legacy AUTO_DENT_STOP alongside phase markers', () => {
    const capture = runStream([
      msg.init(),
      msg.phase('PICK', { issue: '#450', title: 'last issue' }),
      msg.text('AUTO_DENT_STOP: legacy stop reason'),
      msg.done(2.0),
    ]);

    expectPhase(capture, 'PICK', '#450');
    expect(capture.result.stopRequested).toBe(true);
    expect(capture.result.stopReason).toBe('legacy stop reason');
  });

  it('handles mixed content blocks (text + tool in same message)', () => {
    const capture = runStream([
      msg.mixed(
        { type: 'text', text: 'AUTO_DENT_PHASE: IMPLEMENT | case=260323-0900-k100' },
        { type: 'tool_use', name: 'EnterWorktree', input: { name: 'k100-fix' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
      ),
    ]);

    expectPhase(capture, 'IMPLEMENT', 'case:260323-0900-k100');
    expectToolLogged(capture, 'EnterWorktree k100-fix', '$ npm test');
    expect(capture.result.toolCalls).toBe(2);
  });

  it('tracks artifacts across multiple messages', () => {
    const { result } = runStream([
      msg.phase('REFLECT', { issues_filed: 'https://github.com/Garsson-io/kaizen/issues/700' }),
      msg.phase('PR', { url: 'https://github.com/Garsson-io/kaizen/pull/701' }),
      msg.phase('PR', { url: 'https://github.com/Garsson-io/kaizen/pull/702' }),
      msg.done(2.0, 'AUTO_DENT_PHASE: REFLECT | issues_closed=#450,#451'),
    ]);

    expect(result.issuesFiled).toContain('https://github.com/Garsson-io/kaizen/issues/700');
    expect(result.prs).toHaveLength(2);
    expect(result.issuesClosed).toContain('#450');
    expect(result.issuesClosed).toContain('#451');
  });

  it('handles phase with no fields gracefully', () => {
    const capture = runStream([msg.phase('REFLECT')]);
    expectPhase(capture, 'REFLECT');
  });
});

describe('buildInFlightComment', () => {
  it('includes run number, tool calls, cost, and working status', () => {
    const runStart = Date.now() - 600_000; // 10 min ago
    const result = makeRunResult({ toolCalls: 42, cost: 2.50 });
    const ctx: StreamContext = {};

    const comment = buildInFlightComment(3, runStart, result, ctx);

    expect(comment).toContain('Run #3');
    expect(comment).toContain('in progress');
    expect(comment).toContain('42');
    expect(comment).toContain('$2.50');
    expect(comment).toContain('working');
    expect(comment).not.toContain('waiting for process exit');
  });

  it('shows waiting-for-exit status when result has been received', () => {
    const runStart = Date.now() - 900_000;
    const result = makeRunResult({ toolCalls: 80, cost: 4.00 });
    const ctx: StreamContext = { resultReceivedAt: Date.now() - 60_000 };

    const comment = buildInFlightComment(5, runStart, result, ctx);

    expect(comment).toContain('waiting for process exit');
    expect(comment).not.toMatch(/\| \*\*Status\*\* \| working/);
  });

  it('includes last activity and last phase when available', () => {
    const runStart = Date.now() - 300_000;
    const result = makeRunResult({ toolCalls: 20, cost: 1.00 });
    const ctx: StreamContext = {
      lastActivity: 'Edit src/hooks/state-utils.ts',
      lastPhase: '[IMPLEMENT] case:260323-1200-k472',
    };

    const comment = buildInFlightComment(2, runStart, result, ctx);

    expect(comment).toContain('Edit src/hooks/state-utils.ts');
    expect(comment).toContain('[IMPLEMENT] case:260323-1200-k472');
  });

  it('includes PRs so far when available', () => {
    const runStart = Date.now() - 600_000;
    const result = makeRunResult({
      toolCalls: 50,
      cost: 3.00,
      prs: ['https://github.com/Garsson-io/kaizen/pull/500'],
    });
    const ctx: StreamContext = {};

    const comment = buildInFlightComment(4, runStart, result, ctx);

    expect(comment).toContain('PRs so far');
    expect(comment).toContain('pull/500');
  });

  it('omits optional fields when not present', () => {
    const runStart = Date.now() - 120_000;
    const result = makeRunResult({ toolCalls: 5, cost: 0.25 });
    const ctx: StreamContext = {};

    const comment = buildInFlightComment(1, runStart, result, ctx);

    expect(comment).not.toContain('Last activity');
    expect(comment).not.toContain('Last phase');
    expect(comment).not.toContain('PRs so far');
  });
});

describe('processStreamMessage populates context', () => {
  it('sets lastActivity on tool_use messages', () => {
    const result = makeRunResult();
    const ctx: StreamContext = {};
    const msg = {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          name: 'Edit',
          input: { file_path: 'src/foo.ts' },
        }],
      },
    };
    processStreamMessage(msg, result, Date.now(), ctx);
    expect(ctx.lastActivity).toBe('Edit src/foo.ts');
  });

  it('sets lastPhase on phase marker text', () => {
    const result = makeRunResult();
    const ctx: StreamContext = {};
    const msg = {
      type: 'assistant',
      message: {
        content: [{
          type: 'text',
          text: 'AUTO_DENT_PHASE: PICK | issue=#472 | title=improve hook test DRY',
        }],
      },
    };
    processStreamMessage(msg, result, Date.now(), ctx);
    expect(ctx.lastPhase).toContain('[PICK]');
    expect(ctx.lastPhase).toContain('#472');
  });
});

describe('extractLinkedIssue', () => {
  it('extracts issue from "Closes #NNN"', () => {
    expect(extractLinkedIssue('This PR\n\nCloses #451')).toBe('451');
  });

  it('extracts issue from "Fixes #NNN"', () => {
    expect(extractLinkedIssue('Fixes #123 — some description')).toBe('123');
  });

  it('extracts issue from "Resolves #NNN"', () => {
    expect(extractLinkedIssue('Resolves #999')).toBe('999');
  });

  it('extracts issue from "closes #NNN" (lowercase)', () => {
    expect(extractLinkedIssue('closes #42')).toBe('42');
  });

  it('extracts issue from "Fixed #NNN"', () => {
    expect(extractLinkedIssue('Fixed #77 after investigation')).toBe('77');
  });

  it('returns null when no linked issue', () => {
    expect(extractLinkedIssue('Just a PR with no issue link')).toBeNull();
  });

  it('returns null for empty body', () => {
    expect(extractLinkedIssue('')).toBeNull();
  });

  it('returns first match when multiple issues linked', () => {
    const body = 'Closes #100\nAlso fixes #200';
    expect(extractLinkedIssue(body)).toBe('100');
  });
});

describe('formatPlanAsMarkdown', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'kaizen-test-'));
  const planPath = join(tmpDir, 'plan.json');
  const cleanupFiles: string[] = [];

  afterEach(() => {
    for (const f of cleanupFiles) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
    cleanupFiles.length = 0;
  });

  it('formats plan items as a markdown table', () => {
    const plan = {
      created_at: '2026-03-23T01:00:00Z',
      guidance: 'improve hooks',
      items: [
        { issue: '#302', title: 'Planning pre-pass', score: 8, approach: 'add planner', status: 'pending', item_type: 'leaf' },
        { issue: '#451', title: 'Hook performance', score: 6, approach: 'benchmark', status: 'pending', item_type: 'decompose' },
      ],
      wip_excluded: ['#500'],
      epics_scanned: ['#275', '#295'],
    };
    const path = join(tmpDir, 'plan-test-1.json');
    writeFileSync(path, JSON.stringify(plan));
    cleanupFiles.push(path);

    const md = formatPlanAsMarkdown(path);
    expect(md).toContain('### Batch Plan (pre-pass)');
    expect(md).toContain('| 1 | #302 | Planning pre-pass | 8 | leaf | pending |');
    expect(md).toContain('| 2 | #451 | Hook performance | 6 | decompose | pending |');
    expect(md).toContain('#500');
    expect(md).toContain('#275');
  });

  it('returns empty string for non-existent file', () => {
    expect(formatPlanAsMarkdown('/nonexistent/plan.json')).toBe('');
  });

  it('returns empty string for plan with no items', () => {
    const plan = { created_at: '2026-03-23', guidance: 'test', items: [] };
    const path = join(tmpDir, 'plan-test-2.json');
    writeFileSync(path, JSON.stringify(plan));
    cleanupFiles.push(path);

    expect(formatPlanAsMarkdown(path)).toBe('');
  });

  it('defaults item_type to leaf when not specified', () => {
    const plan = {
      created_at: '2026-03-23',
      guidance: 'test',
      items: [{ issue: '#1', title: 'Test', score: 5, approach: 'do it', status: 'pending' }],
    };
    const path = join(tmpDir, 'plan-test-3.json');
    writeFileSync(path, JSON.stringify(plan));
    cleanupFiles.push(path);

    const md = formatPlanAsMarkdown(path);
    expect(md).toContain('| leaf |');
  });
});

describe('selectMode', () => {
  it('selects exploit for runs 0-6 (mod 10)', () => {
    for (const run of [1, 2, 3, 4, 5, 6, 10, 11, 16]) {
      const { mode, template } = selectMode(makeBatchState(), run);
      expect(mode).toBe('exploit');
      expect(template).toBe('deep-dive-default.md');
    }
  });

  it('selects explore for run 7 (mod 10)', () => {
    const { mode, template } = selectMode(makeBatchState(), 7);
    expect(mode).toBe('explore');
    expect(template).toBe('explore-gaps.md');
  });

  it('selects reflect for run 8 (mod 10)', () => {
    const { mode, template } = selectMode(makeBatchState(), 8);
    expect(mode).toBe('reflect');
    expect(template).toBe('reflect-batch.md');
  });

  it('selects subtract for run 9 (mod 10)', () => {
    const { mode, template } = selectMode(makeBatchState(), 9);
    expect(mode).toBe('subtract');
    expect(template).toBe('subtract-prune.md');
  });

  it('cycles correctly for run 17, 18, 19', () => {
    expect(selectMode(makeBatchState(), 17).mode).toBe('explore');
    expect(selectMode(makeBatchState(), 18).mode).toBe('reflect');
    expect(selectMode(makeBatchState(), 19).mode).toBe('subtract');
  });

  it('forces mode from guidance "mode:explore"', () => {
    const state = makeBatchState({ guidance: 'fix bugs mode:explore' });
    const { mode, template } = selectMode(state, 1);
    expect(mode).toBe('explore');
    expect(template).toBe('explore-gaps.md');
  });

  it('forces mode from guidance "mode:subtract" case-insensitive', () => {
    const state = makeBatchState({ guidance: 'clean up mode:Subtract' });
    const { mode } = selectMode(state, 1);
    expect(mode).toBe('subtract');
  });

  it('falls back to exploit template for unknown forced mode', () => {
    const state = makeBatchState({ guidance: 'mode:unknown' });
    const { mode, template } = selectMode(state, 1);
    expect(mode).toBe('unknown');
    expect(template).toBe('deep-dive-default.md');
  });

  it('uses test-task template for test_task state', () => {
    const state = makeBatchState({ test_task: true });
    const { mode, template } = selectMode(state, 7);
    expect(mode).toBe('exploit');
    expect(template).toBe('test-task.md');
  });

  it('selects contemplate for run 14 (mod 15 === 14)', () => {
    const { mode, template } = selectMode(makeBatchState(), 14);
    expect(mode).toBe('contemplate');
    expect(template).toBe('contemplate-strategy.md');
  });

  it('selects contemplate for run 29 (mod 15 === 14)', () => {
    const { mode, template } = selectMode(makeBatchState(), 29);
    expect(mode).toBe('contemplate');
    expect(template).toBe('contemplate-strategy.md');
  });

  it('contemplate overlay takes precedence over base cycle', () => {
    // Run 14 would be slot 4 (exploit) in base cycle, but contemplate overlay wins
    const { mode } = selectMode(makeBatchState(), 14);
    expect(mode).toBe('contemplate');
  });

  it('forces mode:contemplate from guidance', () => {
    const state = makeBatchState({ guidance: 'review batch mode:contemplate' });
    const { mode, template } = selectMode(state, 1);
    expect(mode).toBe('contemplate');
    expect(template).toBe('contemplate-strategy.md');
  });

  it('does not contemplate on run 0', () => {
    // Run 0 should not trigger contemplate even though 0 % 15 !== 14
    const { mode } = selectMode(makeBatchState(), 0);
    expect(mode).toBe('exploit');
  });
});

function makeRunMetrics(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    run: 1,
    start_epoch: 0,
    duration_seconds: 60,
    exit_code: 0,
    cost_usd: 1.0,
    tool_calls: 10,
    prs: [],
    issues_filed: [],
    issues_closed: [],
    cases: [],
    stop_requested: false,
    ...overrides,
  };
}

describe('checkSignalOverrides', () => {
  it('returns null when history is too short', () => {
    const state = makeBatchState({ run_history: [makeRunMetrics(), makeRunMetrics()] });
    expect(checkSignalOverrides(state)).toBeNull();
  });

  it('returns null when no signals fire', () => {
    const state = makeBatchState({
      consecutive_failures: 0,
      run_history: [
        makeRunMetrics({ prs: ['pr1'], mode: 'exploit' }),
        makeRunMetrics({ prs: ['pr2'], mode: 'explore' }),
        makeRunMetrics({ prs: ['pr3'], mode: 'exploit' }),
      ],
    });
    expect(checkSignalOverrides(state)).toBeNull();
  });

  it('forces reflect on 3+ consecutive failures', () => {
    const state = makeBatchState({
      consecutive_failures: 3,
      run_history: [
        makeRunMetrics({ exit_code: 1 }),
        makeRunMetrics({ exit_code: 1 }),
        makeRunMetrics({ exit_code: 1 }),
      ],
    });
    const result = checkSignalOverrides(state);
    expect(result).not.toBeNull();
    expect(result!.mode).toBe('reflect');
    expect(result!.reason).toBe('signal:consecutive-failures');
  });

  it('forces explore when no PRs in last 5 runs', () => {
    const state = makeBatchState({
      consecutive_failures: 0,
      run_history: [
        makeRunMetrics({ prs: [] }),
        makeRunMetrics({ prs: [] }),
        makeRunMetrics({ prs: [] }),
        makeRunMetrics({ prs: [] }),
        makeRunMetrics({ prs: [] }),
      ],
    });
    const result = checkSignalOverrides(state);
    expect(result).not.toBeNull();
    expect(result!.mode).toBe('explore');
    expect(result!.reason).toBe('signal:no-recent-prs');
  });

  it('does not force explore when PRs exist in last 5 runs', () => {
    const state = makeBatchState({
      consecutive_failures: 0,
      run_history: [
        makeRunMetrics({ prs: [], mode: 'exploit' }),
        makeRunMetrics({ prs: [], mode: 'explore' }),
        makeRunMetrics({ prs: ['pr1'], mode: 'exploit' }),
        makeRunMetrics({ prs: [], mode: 'reflect' }),
        makeRunMetrics({ prs: [], mode: 'exploit' }),
      ],
    });
    expect(checkSignalOverrides(state)).toBeNull();
  });

  it('breaks mode streak after 4 consecutive same-mode runs', () => {
    const state = makeBatchState({
      consecutive_failures: 0,
      run_history: [
        makeRunMetrics({ prs: ['pr1'], mode: 'exploit' }),
        makeRunMetrics({ prs: ['pr2'], mode: 'exploit' }),
        makeRunMetrics({ prs: ['pr3'], mode: 'exploit' }),
        makeRunMetrics({ prs: ['pr4'], mode: 'exploit' }),
      ],
    });
    const result = checkSignalOverrides(state);
    expect(result).not.toBeNull();
    expect(result!.mode).toBe('explore');
    expect(result!.reason).toBe('signal:mode-streak-exploit');
  });

  it('breaks non-exploit mode streak with contemplate', () => {
    const state = makeBatchState({
      consecutive_failures: 0,
      run_history: [
        makeRunMetrics({ prs: ['pr1'], mode: 'explore' }),
        makeRunMetrics({ prs: ['pr2'], mode: 'explore' }),
        makeRunMetrics({ prs: ['pr3'], mode: 'explore' }),
        makeRunMetrics({ prs: ['pr4'], mode: 'explore' }),
      ],
    });
    const result = checkSignalOverrides(state);
    expect(result).not.toBeNull();
    expect(result!.mode).toBe('contemplate');
    expect(result!.reason).toBe('signal:mode-streak-explore');
  });

  it('consecutive failures takes priority over no-prs signal', () => {
    const state = makeBatchState({
      consecutive_failures: 3,
      run_history: [
        makeRunMetrics({ prs: [], exit_code: 1 }),
        makeRunMetrics({ prs: [], exit_code: 1 }),
        makeRunMetrics({ prs: [], exit_code: 1 }),
        makeRunMetrics({ prs: [], exit_code: 1 }),
        makeRunMetrics({ prs: [], exit_code: 1 }),
      ],
    });
    const result = checkSignalOverrides(state);
    expect(result!.mode).toBe('reflect');
  });

  it('signal overrides are used by selectMode', () => {
    const state = makeBatchState({
      consecutive_failures: 4,
      run_history: [
        makeRunMetrics({ exit_code: 1 }),
        makeRunMetrics({ exit_code: 1 }),
        makeRunMetrics({ exit_code: 1 }),
        makeRunMetrics({ exit_code: 1 }),
      ],
    });
    // Run 1 would normally be exploit, but signal overrides it
    const { mode, reason } = selectMode(state, 1);
    expect(mode).toBe('reflect');
    expect(reason).toBe('signal:consecutive-failures');
  });

  it('guidance override takes priority over signals', () => {
    const state = makeBatchState({
      guidance: 'fix bugs mode:subtract',
      consecutive_failures: 5,
      run_history: [
        makeRunMetrics({ exit_code: 1 }),
        makeRunMetrics({ exit_code: 1 }),
        makeRunMetrics({ exit_code: 1 }),
      ],
    });
    const { mode, reason } = selectMode(state, 1);
    expect(mode).toBe('subtract');
    expect(reason).toBe('guidance');
  });
});

describe('computeBanditWeights', () => {
  /** Build a history where each schedulable mode is played `plays[mode]` times,
   *  each play credited with `reward[mode]` units of that mode's OWN success metric
   *  (so modeSuccess === reward for every mode, not just exploit). */
  function makeHistory(plays: Record<string, number>, reward: Record<string, number> = {}): RunMetrics[] {
    const out: RunMetrics[] = [];
    let i = 0;
    const credit = (mode: string, r: number): Partial<RunMetrics> => {
      const ids = Array.from({ length: r }, (_, j) => `#${j}`);
      switch (mode) {
        case 'exploit': return { prs: Array.from({ length: r }, (_, j) => `pr-${j}`) };
        case 'explore':
        case 'reflect': return { issues_filed: ids };
        case 'subtract': return { lines_deleted: r * 100, issues_pruned: 0 };
        default: return { prs: Array.from({ length: r }, (_, j) => `pr-${j}`) };
      }
    };
    for (const mode of SCHEDULABLE_MODES) {
      const n = plays[mode] ?? 0;
      const r = reward[mode] ?? 0;
      for (let k = 0; k < n; k++) {
        out.push(makeRunMetrics({ run: i++, mode, cost_usd: 1.0, ...credit(mode, r) }));
      }
    }
    return out;
  }

  it('returns null when history has fewer than minRuns', () => {
    const history = Array.from({ length: 9 }, (_, i) =>
      makeRunMetrics({ run: i, mode: 'exploit', prs: ['pr-1'] }),
    );
    expect(computeBanditWeights(history, { minRuns: 10 })).toBeNull();
  });

  it('returns null when no runs have mode data', () => {
    const history = Array.from({ length: 15 }, (_, i) => makeRunMetrics({ run: i }));
    expect(computeBanditWeights(history)).toBeNull();
  });

  it('returns weights that sum to 1.0 with sufficient data', () => {
    const history = makeHistory(
      { exploit: 9, explore: 1, reflect: 1, subtract: 1 },
      { exploit: 1, explore: 1, subtract: 1 },
    );
    const result = computeBanditWeights(history, { minRuns: 10 });
    expect(result).not.toBeNull();
    const sum = Object.values(result!.weights).reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(1.0, 5);
    expect(result!.details).toHaveLength(SCHEDULABLE_MODES.length);
  });

  it('EXPLOITATION: with equal plays, the higher-reward mode gets more weight', () => {
    // exploit and explore both played 5x; exploit earns 2/play, explore 0/play.
    const history = makeHistory(
      { exploit: 5, explore: 5 },
      { exploit: 2, explore: 0 },
    );
    const result = computeBanditWeights(history, { minRuns: 10 })!;
    expect(result.weights.exploit).toBeGreaterThan(result.weights.explore);
  });

  it('EXPLORATION: with equal reward, the less-played mode gets more weight (uncertainty bonus)', () => {
    // Both earn the same reward/play, but exploit has been played far more.
    // The old heuristic could not express this; UCB1 must favor the rarer mode.
    const history = makeHistory(
      { exploit: 9, explore: 2, reflect: 0, subtract: 0 },
      { exploit: 1, explore: 1 },
    );
    const result = computeBanditWeights(history, { minRuns: 10 })!;
    expect(result.weights.explore).toBeGreaterThan(result.weights.exploit);
  });

  it('NO STARVATION: a never-played schedulable mode still gets substantial weight', () => {
    const history = makeHistory(
      { exploit: 12, explore: 0, reflect: 0, subtract: 0 },
      { exploit: 2 },
    );
    const result = computeBanditWeights(history, { minRuns: 10 })!;
    expect(result.weights.reflect).toBeGreaterThan(0);
    // An unplayed mode (max bonus, zero exploit term) must be competitive with a
    // heavily-exploited one — guaranteeing re-exploration, not a token sliver.
    expect(result.weights.reflect).toBeGreaterThan(result.weights.exploit * 0.5);
  });

  it('KNOB c=0 is greedy: the best-reward mode dominates and weights collapse to exploit', () => {
    const history = makeHistory(
      { exploit: 5, explore: 5, reflect: 1, subtract: 1 },
      { exploit: 3, explore: 0 },
    );
    const greedy = computeBanditWeights(history, { minRuns: 10, explorationC: 0 })!;
    // With no exploration bonus, only the best mean reward carries weight.
    expect(greedy.weights.exploit).toBeCloseTo(1.0, 5);
    expect(greedy.weights.explore).toBeCloseTo(0, 5);
  });

  it('KNOB: larger c flattens the weight distribution toward uniform', () => {
    const history = makeHistory(
      { exploit: 5, explore: 5, reflect: 2, subtract: 2 },
      { exploit: 3, explore: 0 },
    );
    const spread = (r: BanditResultLike) => {
      const w = Object.values(r.weights);
      return Math.max(...w) - Math.min(...w);
    };
    const low = computeBanditWeights(history, { minRuns: 10, explorationC: 0.5 })!;
    const high = computeBanditWeights(history, { minRuns: 10, explorationC: 50 })!;
    // More exploration ⇒ weights pulled toward uniform ⇒ smaller max-min spread.
    expect(spread(high)).toBeLessThan(spread(low));
  });

  it('details: exploreBonus strictly decreases as plays increase (holding N fixed)', () => {
    const history = makeHistory(
      { exploit: 6, explore: 3, reflect: 2, subtract: 1 },
      { exploit: 1, explore: 1, reflect: 1, subtract: 1 },
    );
    const result = computeBanditWeights(history, { minRuns: 10 })!;
    const byMode = Object.fromEntries(result.details.map(d => [d.mode, d]));
    // exploit(6p) < explore(3p) < reflect(2p) < subtract(1p) in plays ⇒ inverse for bonus.
    expect(byMode.exploit.exploreBonus).toBeLessThan(byMode.explore.exploreBonus);
    expect(byMode.explore.exploreBonus).toBeLessThan(byMode.reflect.exploreBonus);
    expect(byMode.reflect.exploreBonus).toBeLessThan(byMode.subtract.exploreBonus);
    expect(result.totalPlays).toBe(12);
    expect(result.explorationC).toBe(DEFAULT_BANDIT_C);
  });

  it('reward semantics: explore credited by issues_filed, subtract by lines/pruned', () => {
    const history: RunMetrics[] = [];
    for (let i = 0; i < 8; i++) history.push(makeRunMetrics({ run: i, mode: 'exploit', prs: [], cost_usd: 1 }));
    // explore files lots of issues (its reward), subtract deletes lines.
    history.push(makeRunMetrics({ run: 8, mode: 'explore', issues_filed: ['#1', '#2', '#3'], cost_usd: 1 }));
    history.push(makeRunMetrics({ run: 9, mode: 'explore', issues_filed: ['#4', '#5', '#6'], cost_usd: 1 }));
    history.push(makeRunMetrics({ run: 10, mode: 'subtract', lines_deleted: 400, issues_pruned: 2, cost_usd: 1 }));
    const result = computeBanditWeights(history, { minRuns: 10 })!;
    const byMode = Object.fromEntries(result.details.map(d => [d.mode, d]));
    // explore's mean reward reflects issues filed (3/play), not its zero PRs.
    expect(byMode.explore.meanReward).toBeCloseTo(3, 5);
    expect(byMode.subtract.meanReward).toBeGreaterThan(0);
    // exploit produced zero PRs ⇒ zero mean reward.
    expect(byMode.exploit.meanReward).toBe(0);
  });
});

type BanditResultLike = { weights: Record<string, number> };

describe('banditExplorationC', () => {
  const orig = process.env.KAIZEN_BANDIT_C;
  afterEach(() => {
    if (orig === undefined) delete process.env.KAIZEN_BANDIT_C;
    else process.env.KAIZEN_BANDIT_C = orig;
  });

  it('defaults to DEFAULT_BANDIT_C when unset', () => {
    delete process.env.KAIZEN_BANDIT_C;
    expect(banditExplorationC()).toBe(DEFAULT_BANDIT_C);
  });

  it('reads a valid non-negative number from the environment', () => {
    process.env.KAIZEN_BANDIT_C = '3.5';
    expect(banditExplorationC()).toBe(3.5);
  });

  it('falls back to default on invalid or negative input', () => {
    process.env.KAIZEN_BANDIT_C = 'not-a-number';
    expect(banditExplorationC()).toBe(DEFAULT_BANDIT_C);
    process.env.KAIZEN_BANDIT_C = '-2';
    expect(banditExplorationC()).toBe(DEFAULT_BANDIT_C);
  });
});

describe('modeSuccess', () => {
  it('exploit uses PRs', () => {
    expect(modeSuccess('exploit', makeRunMetrics({ prs: ['pr1', 'pr2'] }))).toBe(2);
    expect(modeSuccess('exploit', makeRunMetrics({ prs: [] }))).toBe(0);
  });

  it('explore uses issues_filed', () => {
    expect(modeSuccess('explore', makeRunMetrics({ issues_filed: ['#1', '#2', '#3'] }))).toBe(3);
    expect(modeSuccess('explore', makeRunMetrics({ prs: ['pr1'], issues_filed: [] }))).toBe(0);
  });

  it('reflect uses issues_filed', () => {
    expect(modeSuccess('reflect', makeRunMetrics({ issues_filed: ['#1'] }))).toBe(1);
  });

  it('subtract uses lines_deleted and issues_pruned', () => {
    expect(modeSuccess('subtract', makeRunMetrics({ lines_deleted: 200, issues_pruned: 1 }))).toBe(3);
    expect(modeSuccess('subtract', makeRunMetrics({ lines_deleted: 0, issues_pruned: 0 }))).toBe(0);
  });

  it('contemplate always returns 1', () => {
    expect(modeSuccess('contemplate', makeRunMetrics({ prs: [], issues_filed: [] }))).toBe(1);
  });

  it('unknown modes fall back to PRs', () => {
    expect(modeSuccess('unknown', makeRunMetrics({ prs: ['pr1'] }))).toBe(1);
  });
});

describe('deriveRunOutcome — verdict binding (#1224, meta #1227)', () => {
  // Baseline: a clean win. Each adversarial test perturbs one verdict.
  const cleanWin = {
    stopRequested: false,
    exitCode: 0,
    artifactCount: 1,
    reviewVerdict: 'pass' as const,
    processVerdict: 'pass' as const,
    lifecycleHealth: 'clean' as const,
  };

  it('the #1212 shape: artifact produced but review:fail + process-incomplete ⇒ failure (NOT success)', () => {
    // The exact run.complete shape from eastern-ant/run-2 that produced PR #1212.
    expect(
      deriveRunOutcome({
        stopRequested: false,
        exitCode: 0,
        artifactCount: 1, // a PR was created
        reviewVerdict: 'fail',
        processVerdict: 'process-incomplete',
        lifecycleHealth: 'degraded',
      }),
    ).toBe('failure');
  });

  it('review:fail alone blocks success', () => {
    expect(deriveRunOutcome({ ...cleanWin, reviewVerdict: 'fail' })).toBe('failure');
  });

  it('process-incomplete alone blocks success', () => {
    expect(deriveRunOutcome({ ...cleanWin, processVerdict: 'process-incomplete' })).toBe('failure');
  });

  it('lifecycle critical alone blocks success', () => {
    expect(deriveRunOutcome({ ...cleanWin, lifecycleHealth: 'critical' })).toBe('failure');
  });

  it('a quality-failed run with no artifacts is failure, not empty_success', () => {
    expect(
      deriveRunOutcome({ ...cleanWin, artifactCount: 0, processVerdict: 'process-incomplete' }),
    ).toBe('failure');
  });

  it('clean win with artifacts ⇒ success (happy path preserved)', () => {
    expect(deriveRunOutcome(cleanWin)).toBe('success');
  });

  it('clean run with no artifacts ⇒ empty_success (preserved)', () => {
    expect(deriveRunOutcome({ ...cleanWin, artifactCount: 0 })).toBe('empty_success');
  });

  it('fail-open-warning does NOT flip a win (fail-open by design)', () => {
    expect(deriveRunOutcome({ ...cleanWin, processVerdict: 'fail-open-warning' })).toBe('success');
  });

  it('lifecycle degraded alone does NOT block (too broad to gate on)', () => {
    expect(deriveRunOutcome({ ...cleanWin, lifecycleHealth: 'degraded' })).toBe('success');
  });

  it('skipped review is legitimate ⇒ success', () => {
    expect(deriveRunOutcome({ ...cleanWin, reviewVerdict: 'skipped' })).toBe('success');
  });

  it('undefined verdicts are treated as non-failing (no over-broad gate)', () => {
    expect(
      deriveRunOutcome({
        stopRequested: false,
        exitCode: 0,
        artifactCount: 1,
        reviewVerdict: undefined,
        processVerdict: undefined,
        lifecycleHealth: undefined,
      }),
    ).toBe('success');
  });

  it('stopRequested ⇒ stop, even with artifacts and verdicts', () => {
    expect(deriveRunOutcome({ ...cleanWin, stopRequested: true })).toBe('stop');
  });

  it('nonzero exit code ⇒ failure', () => {
    expect(deriveRunOutcome({ ...cleanWin, exitCode: 1 })).toBe('failure');
  });

  it('stop precedence: stopRequested wins over a nonzero exit code', () => {
    expect(deriveRunOutcome({ ...cleanWin, stopRequested: true, exitCode: 1 })).toBe('stop');
  });
});

describe('buildRunMetrics', () => {
  it('maps shared RunResult fields into RunMetrics once', () => {
    const result = makeRunResult({
      prs: ['https://github.com/Garsson-io/kaizen/pull/1'],
      issuesFiled: ['#10'],
      issuesClosed: ['#11'],
      cases: ['case-1'],
      cost: 1.25,
      toolCalls: 7,
      stopRequested: true,
      linesDeleted: 42,
      issuesPruned: 2,
    });

    const metrics = buildRunMetrics({
      runNum: 3,
      runStartEpoch: 1742680800,
      duration: 91,
      exitCode: 0,
      runMode: 'subtract',
      result,
    });

    expect(metrics).toMatchObject({
      run: 3,
      start_epoch: 1742680800,
      duration_seconds: 91,
      exit_code: 0,
      cost_usd: 1.25,
      tool_calls: 7,
      prs: ['https://github.com/Garsson-io/kaizen/pull/1'],
      issues_filed: ['#10'],
      issues_closed: ['#11'],
      cases: ['case-1'],
      stop_requested: true,
      mode: 'subtract',
      lines_deleted: 42,
      issues_pruned: 2,
    });
  });

  it('adds persisted metadata without duplicating the base mapping', () => {
    const metrics = buildRunMetrics({
      runNum: 4,
      runStartEpoch: 1742680900,
      duration: 30,
      exitCode: 0,
      runMode: 'exploit',
      result: makeRunResult({
        finalClaimStatus: 'valid',
        finalClaimPath: '/tmp/final-claim.json',
        finalClaimWarnings: ['warning'],
      }),
      metadata: {
        prompt_template: 'make-a-dent.md',
        prompt_hash: 'abc123',
        lifecycle_violations: 1,
        lifecycle_health: 'degraded',
        process_verdict: 'pass',
        process_issue_count: 0,
        process_summary: 'ok',
        review_verdict: 'pass',
        review_cost_usd: 0.12,
      },
    });

    expect(metrics).toMatchObject({
      prompt_template: 'make-a-dent.md',
      prompt_hash: 'abc123',
      lifecycle_violations: 1,
      lifecycle_health: 'degraded',
      process_verdict: 'pass',
      process_issue_count: 0,
      process_summary: 'ok',
      review_verdict: 'pass',
      review_cost_usd: 0.12,
      final_claim_status: 'valid',
      final_claim_path: '/tmp/final-claim.json',
      final_claim_warnings: ['warning'],
    });
  });

  it('persists the hook-activation verdict to state.json metrics (#843)', () => {
    const metrics = buildRunMetrics({
      runNum: 5,
      runStartEpoch: 1742681000,
      duration: 12,
      exitCode: 0,
      runMode: 'exploit',
      result: makeRunResult({
        hookActivation: {
          provider: 'claude',
          expected: true,
          active: false,
          degraded: true,
          observedPlugins: [],
          message: 'kaizen plugin NOT loaded',
        },
      }),
    });

    // The degraded verdict must reach the durable, machine-readable surface —
    // a regression dropping the field from run metrics would be silent otherwise.
    expect(metrics.hook_activation).toMatchObject({ degraded: true, expected: true, active: false });
  });

  it('leaves hook_activation undefined when the run produced no verdict', () => {
    const metrics = buildRunMetrics({
      runNum: 6,
      runStartEpoch: 1742681100,
      duration: 8,
      exitCode: 0,
      runMode: 'exploit',
      result: makeRunResult(),
    });
    expect(metrics.hook_activation).toBeUndefined();
  });
});

describe('weightedModeSelect', () => {
  it('is deterministic for the same runNum', () => {
    const weights = { exploit: 0.7, explore: 0.1, reflect: 0.1, subtract: 0.1 };
    const mode1 = weightedModeSelect(weights, 42);
    const mode2 = weightedModeSelect(weights, 42);
    expect(mode1).toBe(mode2);
  });

  it('produces different modes for different runNums', () => {
    const weights = { exploit: 0.4, explore: 0.3, reflect: 0.2, subtract: 0.1 };
    const modes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      modes.add(weightedModeSelect(weights, i));
    }
    // With balanced weights and 100 runs, we should see at least 2 different modes
    expect(modes.size).toBeGreaterThanOrEqual(2);
  });

  it('selects only mode with weight 1.0', () => {
    const weights = { exploit: 1.0, explore: 0, reflect: 0, subtract: 0 };
    for (let i = 0; i < 20; i++) {
      expect(weightedModeSelect(weights, i)).toBe('exploit');
    }
  });

  it('is deterministic for same runNum and batchId', () => {
    const weights = { exploit: 0.4, explore: 0.3, reflect: 0.2, subtract: 0.1 };
    const mode1 = weightedModeSelect(weights, 42, 'batch-abc');
    const mode2 = weightedModeSelect(weights, 42, 'batch-abc');
    expect(mode1).toBe(mode2);
  });

  it('produces different sequences for different batchIds', () => {
    const weights = { exploit: 0.4, explore: 0.3, reflect: 0.2, subtract: 0.1 };
    let differ = false;
    for (let i = 0; i < 100; i++) {
      const modeA = weightedModeSelect(weights, i, 'batch-alpha');
      const modeB = weightedModeSelect(weights, i, 'batch-beta');
      if (modeA !== modeB) {
        differ = true;
        break;
      }
    }
    expect(differ).toBe(true);
  });

  it('without batchId behaves like legacy (backward compatible)', () => {
    const weights = { exploit: 0.7, explore: 0.1, reflect: 0.1, subtract: 0.1 };
    const mode1 = weightedModeSelect(weights, 42);
    const mode2 = weightedModeSelect(weights, 42, undefined);
    expect(mode1).toBe(mode2);
  });
});

describe('selectMode bandit integration', () => {
  function makeVariedHistory(): RunMetrics[] {
    // Mix of modes so signal overrides don't fire (avoids 4+ streak)
    const modes = ['exploit', 'exploit', 'exploit', 'explore', 'exploit', 'exploit', 'exploit', 'reflect', 'exploit', 'exploit', 'subtract', 'exploit'];
    return modes.map((mode, i) =>
      makeRunMetrics({ run: i, mode, prs: ['pr'], cost_usd: 1.0 }),
    );
  }

  it('uses bandit selection when history is sufficient and exposes the breakdown', () => {
    const state = makeBatchState({ run_history: makeVariedHistory() });
    const result = selectMode(state, 1);
    expect(result.reason).toBe('bandit');
    expect(['exploit', 'explore', 'reflect', 'subtract']).toContain(result.mode);
    // Observability: the full per-mode breakdown rides along on the selection.
    expect(result.bandit).toBeDefined();
    expect(result.bandit!.details).toHaveLength(4);
    expect(result.bandit!.totalPlays).toBe(12);
  });

  it('falls back to fixed schedule when history is insufficient', () => {
    const history = [
      makeRunMetrics({ run: 0, mode: 'exploit', prs: ['pr'] }),
    ];
    const state = makeBatchState({ run_history: history });
    const result = selectMode(state, 7);
    expect(result.reason).toBe('schedule');
    expect(result.mode).toBe('explore');
  });

  it('signal overrides take priority over adaptive selection', () => {
    const state = makeBatchState({
      run_history: makeVariedHistory(),
      consecutive_failures: 5,
    });
    const result = selectMode(state, 1);
    expect(result.reason).toBe('signal:consecutive-failures');
    expect(result.mode).toBe('reflect');
  });

  it('contemplate overlay takes priority over adaptive selection', () => {
    const state = makeBatchState({ run_history: makeVariedHistory() });
    const result = selectMode(state, 14);
    expect(result.mode).toBe('contemplate');
    expect(result.reason).toBe('schedule');
  });
});

describe('computeModeDistribution', () => {
  it('counts modes from run history', () => {
    const history = [
      makeRunMetrics({ mode: 'exploit' }),
      makeRunMetrics({ mode: 'exploit' }),
      makeRunMetrics({ mode: 'explore' }),
      makeRunMetrics({ mode: 'reflect' }),
    ];
    const dist = computeModeDistribution(history);
    expect(dist).toEqual({ exploit: 2, explore: 1, reflect: 1 });
  });

  it('defaults missing mode to exploit', () => {
    const history = [makeRunMetrics({})];
    // mode is undefined, should default to exploit
    const dist = computeModeDistribution(history);
    expect(dist).toEqual({ exploit: 1 });
  });

  it('returns empty object for empty history', () => {
    expect(computeModeDistribution([])).toEqual({});
  });
});

describe('formatBatchFooter', () => {
  it('shows run count and PR count', () => {
    const state = makeBatchState({
      run: 5,
      prs: ['https://github.com/org/repo/pull/1', 'https://github.com/org/repo/pull/2'],
      run_history: [
        { run: 1, start_epoch: 0, duration_seconds: 60, exit_code: 0, cost_usd: 1.5, tool_calls: 10, prs: ['https://github.com/org/repo/pull/1'], issues_filed: [], issues_closed: [], cases: [], stop_requested: false },
        { run: 2, start_epoch: 0, duration_seconds: 90, exit_code: 0, cost_usd: 2.0, tool_calls: 15, prs: ['https://github.com/org/repo/pull/2'], issues_filed: [], issues_closed: [], cases: [], stop_requested: false },
      ],
    });
    const output = formatBatchFooter(state);
    expect(output).toContain('Run 5');
    expect(output).toContain('PRs: 2');
    expect(output).toContain('$3.50');
  });

  it('shows 0% success when no PRs', () => {
    const state = makeBatchState({ run: 1, prs: [], run_history: [] });
    const output = formatBatchFooter(state);
    expect(output).toContain('PRs: 0');
    expect(output).toContain('0% success');
  });

  it('calculates success rate from run history', () => {
    const state = makeBatchState({
      run: 3,
      prs: ['pr1', 'pr2'],
      run_history: [
        { run: 1, start_epoch: 0, duration_seconds: 60, exit_code: 0, cost_usd: 1.0, tool_calls: 10, prs: ['pr1'], issues_filed: [], issues_closed: [], cases: [], stop_requested: false },
        { run: 2, start_epoch: 0, duration_seconds: 60, exit_code: 1, cost_usd: 1.0, tool_calls: 10, prs: [], issues_filed: [], issues_closed: [], cases: [], stop_requested: false },
        { run: 3, start_epoch: 0, duration_seconds: 60, exit_code: 0, cost_usd: 1.0, tool_calls: 10, prs: ['pr2'], issues_filed: [], issues_closed: [], cases: [], stop_requested: false },
      ],
    });
    const output = formatBatchFooter(state);
    expect(output).toContain('100% success');
  });

  it('shows mode distribution when modes are present', () => {
    const state = makeBatchState({
      run: 3,
      prs: [],
      run_history: [
        makeRunMetrics({ run: 1, mode: 'exploit' }),
        makeRunMetrics({ run: 2, mode: 'exploit' }),
        makeRunMetrics({ run: 3, mode: 'explore' }),
      ],
    });
    const output = formatBatchFooter(state);
    expect(output).toContain('Modes:');
    expect(output).toContain('exploit:2');
    expect(output).toContain('explore:1');
  });

  it('omits mode line when no history', () => {
    const state = makeBatchState({ run: 0, prs: [], run_history: [] });
    const output = formatBatchFooter(state);
    expect(output).not.toContain('Modes:');
  });
});

describe('color helpers', () => {
  it('returns plain text in non-TTY environment', () => {
    // Tests run in non-TTY, so color should be disabled
    expect(color.green('hello')).toBe('hello');
    expect(color.red('error')).toBe('error');
    expect(color.bold('bold')).toBe('bold');
    expect(color.dim('dim')).toBe('dim');
    expect(color.cyan('cyan')).toBe('cyan');
    expect(color.yellow('yellow')).toBe('yellow');
    expect(color.magenta('magenta')).toBe('magenta');
  });
});

describe('buildPromptWithMetadata', () => {
  it('returns template name and hash for template-based prompts', () => {
    const state = makeBatchState();
    const meta = buildPromptWithMetadata(state, 1);
    // Default mode is exploit → deep-dive-default.md
    expect(meta.template).toBe('deep-dive-default.md');
    expect(meta.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(meta.prompt).toBeTruthy();
  });

  it('returns consistent hash for same template', () => {
    const state = makeBatchState();
    const meta1 = buildPromptWithMetadata(state, 1);
    const meta2 = buildPromptWithMetadata(state, 2);
    // Same template file → same hash
    expect(meta1.hash).toBe(meta2.hash);
  });

  it('returns different template for explore mode', () => {
    const state = makeBatchState({ guidance: 'mode:explore' });
    const meta = buildPromptWithMetadata(state, 1);
    expect(meta.template).toBe('explore-gaps.md');
    expect(meta.hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it('returns different template for reflect mode', () => {
    const state = makeBatchState({ guidance: 'mode:reflect' });
    const meta = buildPromptWithMetadata(state, 1);
    expect(meta.template).toBe('reflect-batch.md');
  });

  it('prompt content matches buildPrompt output', () => {
    const state = makeBatchState();
    const meta = buildPromptWithMetadata(state, 3);
    const prompt = buildPrompt(state, 3);
    expect(meta.prompt).toBe(prompt);
  });

  it('propagates claimedPlanIssue from plan', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'meta-plan-'));
    const plan = {
      created_at: '2026-03-23T00:00:00Z',
      guidance: 'test',
      items: [
        { issue: '#451', title: 'Hook perf', score: 7, approach: 'instrument', status: 'pending' },
      ],
      wip_excluded: [],
      epics_scanned: [],
    };
    writeFileSync(join(tmpDir, 'plan.json'), JSON.stringify(plan));

    const state = makeBatchState();
    const meta = buildPromptWithMetadata(state, 1, tmpDir);
    expect(meta.claimedPlanIssue).toBe('#451');
  });

  it('claimedPlanIssue is undefined when no plan exists', () => {
    const state = makeBatchState();
    const meta = buildPromptWithMetadata(state, 1);
    expect(meta.claimedPlanIssue).toBeUndefined();
  });
});

describe('atomic state I/O', () => {
  let dir: string;
  let stateFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'state-io-'));
    stateFile = join(dir, 'state.json');
  });

  it('routes state persistence through the shared durable JSON contract', () => {
    const stateSection = AUTO_DENT_RUN_SOURCE.slice(
      AUTO_DENT_RUN_SOURCE.indexOf('// State I/O'),
      AUTO_DENT_RUN_SOURCE.indexOf('// Resolve repo root'),
    );

    expect(stateSection).toContain('readDurableJsonValueFile');
    expect(stateSection).toContain('writeDurableJsonValueFile');
    expect(stateSection).not.toContain("JSON.parse(readFileSync(stateFile, 'utf8'))");
    expect(stateSection).not.toContain("JSON.parse(readFileSync(bak, 'utf8'))");
    expect(stateSection).not.toContain("const tmp = stateFile + '.tmp'");
    expect(stateSection).not.toContain("copyFileSync(stateFile, stateFile + '.bak')");
    expect(stateSection).not.toContain('renameSync(tmp, stateFile)');
  });

  it('writeState creates atomic temp-then-rename', () => {
    const state = makeBatchState({ run: 3 });
    writeState(stateFile, state);

    const read = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(read.run).toBe(3);
    // No lingering .tmp file
    expect(existsSync(stateFile + '.tmp')).toBe(false);
  });

  it('writeState creates backup of previous state', () => {
    const state1 = makeBatchState({ run: 1 });
    writeState(stateFile, state1);

    const state2 = makeBatchState({ run: 2 });
    writeState(stateFile, state2);

    // Backup should contain state1
    const bak = JSON.parse(readFileSync(stateFile + '.bak', 'utf8'));
    expect(bak.run).toBe(1);
    // Primary should contain state2
    const primary = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(primary.run).toBe(2);
  });

  it('readState reads normal state file', () => {
    const state = makeBatchState({ run: 5 });
    writeState(stateFile, state);

    const read = readState(stateFile);
    expect(read.run).toBe(5);
  });

  it('readState falls back to .bak correctly after two writes', () => {
    const state1 = makeBatchState({ run: 1 });
    writeState(stateFile, state1);

    const state2 = makeBatchState({ run: 2 });
    writeState(stateFile, state2);

    // Corrupt primary
    writeFileSync(stateFile, 'not-json!!!');

    const read = readState(stateFile);
    expect(read.run).toBe(1); // Falls back to backup (state before run=2)
  });

  it('readState throws when both primary and backup are missing', () => {
    expect(() => readState(stateFile)).toThrow('corrupt and no backup');
  });

  it('readState throws when primary is corrupt and no backup exists', () => {
    writeFileSync(stateFile, '{bad json');
    expect(() => readState(stateFile)).toThrow('corrupt and no backup');
  });

  it('writeState round-trip preserves all BatchState fields', () => {
    const state = makeBatchState({
      run: 10,
      prs: ['https://example.com/pr/1'],
      issues_filed: ['#100'],
      stop_reason: 'budget exhausted',
    });
    writeState(stateFile, state);
    const read = readState(stateFile);
    expect(read.run).toBe(10);
    expect(read.prs).toEqual(['https://example.com/pr/1']);
    expect(read.issues_filed).toEqual(['#100']);
    expect(read.stop_reason).toBe('budget exhausted');
  });
});

describe('validateRunLifecycle', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lifecycle-test-'));
  });

  it('returns valid for correct phase ordering', () => {
    const logFile = join(tmpDir, 'valid.log');
    writeFileSync(logFile, [
      'AUTO_DENT_PHASE: PICK | issue=#1 | title=test',
      'AUTO_DENT_PHASE: EVALUATE | verdict=proceed | reason=ok',
      'AUTO_DENT_PHASE: IMPLEMENT | case=test-case',
      'AUTO_DENT_PHASE: TEST | result=pass | count=5',
      'AUTO_DENT_PHASE: PR | url=https://example.com/pr/1',
      'AUTO_DENT_PHASE: MERGE | url=https://example.com/pr/1 | status=queued',
      'AUTO_DENT_PHASE: REFLECT | issues_filed=0',
    ].join('\n'));

    const result = validateRunLifecycle(logFile);
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.phasesMissing).toEqual([]);
    expect(result.phasesPresent).toEqual(['PICK', 'EVALUATE', 'IMPLEMENT', 'TEST', 'PR', 'MERGE', 'REFLECT']);
  });

  it('detects ordering violations', () => {
    const logFile = join(tmpDir, 'violation.log');
    writeFileSync(logFile, [
      'AUTO_DENT_PHASE: PICK | issue=#1',
      'AUTO_DENT_PHASE: TEST | result=pass',
      'AUTO_DENT_PHASE: EVALUATE | verdict=proceed',
    ].join('\n'));

    const result = validateRunLifecycle(logFile);
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toEqual({ phase: 'EVALUATE', after: 'TEST' });
  });

  it('ignores floating phases (DECOMPOSE, STOP)', () => {
    const logFile = join(tmpDir, 'floating.log');
    writeFileSync(logFile, [
      'AUTO_DENT_PHASE: PICK | issue=#1',
      'AUTO_DENT_PHASE: EVALUATE | verdict=proceed',
      'AUTO_DENT_PHASE: DECOMPOSE | epic=#100',
      'AUTO_DENT_PHASE: STOP | reason=done',
    ].join('\n'));

    const result = validateRunLifecycle(logFile);
    expect(result.valid).toBe(true);
    expect(result.phasesPresent).toContain('DECOMPOSE');
    expect(result.phasesPresent).toContain('STOP');
  });

  it('reports missing phases', () => {
    const logFile = join(tmpDir, 'missing.log');
    writeFileSync(logFile, [
      'AUTO_DENT_PHASE: PICK | issue=#1',
      'AUTO_DENT_PHASE: PR | url=https://example.com/pr/1',
    ].join('\n'));

    const result = validateRunLifecycle(logFile);
    expect(result.valid).toBe(true);
    expect(result.phasesMissing).toContain('EVALUATE');
    expect(result.phasesMissing).toContain('REFLECT');
  });

  it('handles log with no phases', () => {
    const logFile = join(tmpDir, 'empty.log');
    writeFileSync(logFile, 'just some log output\nno phases here\n');

    const result = validateRunLifecycle(logFile);
    expect(result.valid).toBe(true);
    expect(result.phasesPresent).toEqual([]);
    expect(result.phasesMissing).toEqual(['PICK', 'EVALUATE', 'IMPLEMENT', 'TEST', 'PR', 'MERGE', 'REFLECT']);
  });

  it('handles phases mixed with JSON stream messages', () => {
    const logFile = join(tmpDir, 'mixed.log');
    writeFileSync(logFile, [
      '{"type":"system","subtype":"init"}',
      '{"type":"content_block_delta","delta":{"text":"AUTO_DENT_PHASE: PICK | issue=#1"}}',
      'AUTO_DENT_PHASE: PICK | issue=#1',
      '{"type":"content_block_delta","delta":{"text":"working..."}}',
      'AUTO_DENT_PHASE: EVALUATE | verdict=proceed',
      'AUTO_DENT_PHASE: IMPLEMENT | case=test',
    ].join('\n'));

    const result = validateRunLifecycle(logFile);
    expect(result.valid).toBe(true);
    expect(result.phasesPresent).toContain('PICK');
    expect(result.phasesPresent).toContain('EVALUATE');
    expect(result.phasesPresent).toContain('IMPLEMENT');
  });
});

// Static analysis: verify re-exported symbols used locally are also imported (#746)
// Re-exports (export { X } from './mod') satisfy tsc but don't create local
// runtime bindings. This test parses the source to catch that class of wiring bug.
describe('module wiring: re-exported symbols used locally must be imported', () => {
  it('every symbol called in the module body that comes from a re-export is also in a local import', () => {
    const source = readFileSync(join(__dirname, 'auto-dent-run.ts'), 'utf-8');

    // Extract re-exported symbols (export { X, Y } from './mod')
    const reExportPattern = /^export\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/gm;
    const reExported = new Set<string>();
    for (const m of source.matchAll(reExportPattern)) {
      for (const sym of m[1].split(',')) {
        const name = sym.replace(/\s*as\s+\w+/, '').replace(/type\s+/, '').trim();
        if (name) reExported.add(name);
      }
    }

    // Extract locally imported symbols (import { X, Y } from './mod')
    const importPattern = /^import\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/gm;
    const imported = new Set<string>();
    for (const m of source.matchAll(importPattern)) {
      for (const sym of m[1].split(',')) {
        const name = sym.replace(/\s*as\s+\w+/, '').replace(/type\s+/, '').trim();
        if (name) imported.add(name);
      }
    }

    // Find the main function body (everything after the imports/exports block)
    // Look for symbols that are: (1) re-exported, (2) called as functions, (3) NOT imported
    const bodyStart = source.lastIndexOf('from \'./auto-dent-stream.js\';');
    const body = bodyStart > 0 ? source.slice(bodyStart) : source;

    const missing: string[] = [];
    for (const sym of reExported) {
      // Skip type-only re-exports
      if (sym.startsWith('type ')) continue;
      // Check if symbol is used as a function call in the body (not in an export block)
      const callPattern = new RegExp(`(?<!export[^;]*?)\\b${sym}\\s*\\(`, 'm');
      if (callPattern.test(body) && !imported.has(sym)) {
        missing.push(sym);
      }
    }

    expect(missing).toEqual([]);
  });
});

describe('runOnce stream-json line parsing', () => {
  it('delegates supervised stdout JSON object parsing to the shared helper', () => {
    const source = readFileSync(new URL('./auto-dent-run.ts', import.meta.url), 'utf-8');
    const parserStart = source.indexOf('const rl = createInterface');
    const parserSection = source.slice(
      parserStart,
      source.indexOf("child.stderr?.on('data'", parserStart),
    );

    expect(parserSection).toContain('parseJsonObject');
    expect(parserSection).not.toContain('JSON.parse(line)');
  });

  it('routes Codex JSONL rows through normalized shared stream messages (#1488)', () => {
    const source = readFileSync(new URL('./auto-dent-run.ts', import.meta.url), 'utf-8');
    const runCodexStart = source.indexOf('async function runCodex');
    const runCodexEnd = source.indexOf('// Execute one run', runCodexStart);
    const runCodexSection = source.slice(runCodexStart, runCodexEnd);

    expect(runCodexSection).toContain('normalizeCodexEventToStreamMessages');
    expect(runCodexSection).toContain('processStreamMessage(streamMessage');
    expect(runCodexSection).not.toContain('extractArtifacts([parsed.text, parsed.finalText]');
  });
});

describe('findExistingProgressIssue', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns URL when GitHub search finds a matching issue', () => {
    vi.spyOn(github, 'ghExec').mockReturnValue(JSON.stringify([{ url: 'https://github.com/Garsson-io/kaizen/issues/707' }]));
    const result = findExistingProgressIssue('batch-260323-1405-5400', 'Garsson-io/kaizen');
    expect(result).toBe('https://github.com/Garsson-io/kaizen/issues/707');
  });

  it('returns empty string when no matching issue found', () => {
    vi.spyOn(github, 'ghExec').mockReturnValue('[]');
    const result = findExistingProgressIssue('batch-nonexistent', 'Garsson-io/kaizen');
    expect(result).toBe('');
  });

  it('returns empty string when ghExec returns empty string', () => {
    vi.spyOn(github, 'ghExec').mockReturnValue('');
    const result = findExistingProgressIssue('batch-123', 'Garsson-io/kaizen');
    expect(result).toBe('');
  });

  it('returns empty string when ghExec returns invalid JSON', () => {
    vi.spyOn(github, 'ghExec').mockReturnValue('not-json');
    const result = findExistingProgressIssue('batch-123', 'Garsson-io/kaizen');
    expect(result).toBe('');
  });

  it('passes batch ID in search query', () => {
    const spy = vi.spyOn(github, 'ghExec').mockReturnValue('[]');
    findExistingProgressIssue('batch-260323-1405-5400', 'Garsson-io/kaizen');
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toContain('batch-260323-1405-5400');
    expect(spy.mock.calls[0][0]).toContain('--repo Garsson-io/kaizen');
    expect(spy.mock.calls[0][0]).toContain('--label auto-dent');
  });
});

describe('ensureBatchProgressIssue', () => {
  let tmpDir: string;
  let stateFile: string;

  beforeEach(() => {
    vi.restoreAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), 'progress-issue-'));
    stateFile = join(tmpDir, 'state.json');
  });

  afterEach(() => {
    try { unlinkSync(stateFile); } catch {}
  });

  it('returns cached progress_issue without calling GitHub', () => {
    const spy = vi.spyOn(github, 'ghExec');
    const state = makeBatchState({ progress_issue: 'https://github.com/o/r/issues/42' });
    writeState(stateFile, state);
    const result = ensureBatchProgressIssue(state, stateFile);
    expect(result).toBe('https://github.com/o/r/issues/42');
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns empty string when kaizen_repo is empty', () => {
    const spy = vi.spyOn(github, 'ghExec');
    const state = makeBatchState({ kaizen_repo: '' });
    writeState(stateFile, state);
    const result = ensureBatchProgressIssue(state, stateFile);
    expect(result).toBe('');
    expect(spy).not.toHaveBeenCalled();
  });

  it('reuses existing issue found via search instead of creating duplicate', () => {
    const existingUrl = 'https://github.com/Garsson-io/kaizen/issues/707';
    const spy = vi.spyOn(github, 'ghExec')
      .mockReturnValueOnce(JSON.stringify([{ url: existingUrl }]));
    const state = makeBatchState({ progress_issue: undefined });
    writeState(stateFile, state);

    const result = ensureBatchProgressIssue(state, stateFile);

    expect(result).toBe(existingUrl);
    expect(spy).toHaveBeenCalledOnce(); // only search, no create
    expect(spy.mock.calls[0][0]).toContain('issue list');
    const saved = readState(stateFile);
    expect(saved.progress_issue).toBe(existingUrl);
  });

  it('creates new issue when search finds nothing', () => {
    const newUrl = 'https://github.com/Garsson-io/kaizen/issues/800';
    const spy = vi.spyOn(github, 'ghExec')
      .mockReturnValueOnce('[]')       // search returns empty
      .mockReturnValueOnce(newUrl);     // create returns new URL
    const state = makeBatchState({ progress_issue: undefined });
    writeState(stateFile, state);

    const result = ensureBatchProgressIssue(state, stateFile);

    expect(result).toBe(newUrl);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0]).toContain('issue list');   // search
    expect(spy.mock.calls[1][0]).toContain('issue create'); // create
    const saved = readState(stateFile);
    expect(saved.progress_issue).toBe(newUrl);
  });
});

describe('updateBatchProgressIssue', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('posts issue, PR, review, and structured work-cycle artifacts', () => {
    const spy = vi.spyOn(github, 'ghExec').mockReturnValue('https://github.com/Garsson-io/kaizen/issues/1226#issuecomment-1');
    const result = makeRunResult({
      pickedIssue: '#1225',
      pickedIssueTitle: 'redo CI proof gate',
      prs: ['https://github.com/Garsson-io/kaizen/pull/1227'],
      reviewVerdict: 'fail',
      reviewUrls: ['https://github.com/Garsson-io/kaizen/pull/1227#issuecomment-2'],
      progressSteps: [
        {
          phase: 'STOP',
          state: 'requested',
          detail: 'done',
        },
        {
          phase: 'PICK',
          state: 'selected',
          detail: '#1225 — redo CI proof gate',
          url: 'https://github.com/Garsson-io/kaizen/issues/1225',
        },
        {
          phase: 'REVIEW',
          state: 'fail',
          detail: 'https://github.com/Garsson-io/kaizen/pull/1227#issuecomment-2',
          url: 'https://github.com/Garsson-io/kaizen/pull/1227#issuecomment-2',
        },
      ],
    });

    updateBatchProgressIssue(
      'https://github.com/Garsson-io/kaizen/issues/1226',
      'Garsson-io/kaizen',
      1,
      1,
      1205,
      result,
    );

    expect(spy).toHaveBeenCalledOnce();
    const cmd = spy.mock.calls[0][0];
    expect(cmd).toContain('gh issue comment 1226');
    const body = JSON.parse(cmd.match(/--body (.+)$/)![1]);
    expect(body).toContain('| **Issue worked** | https://github.com/Garsson-io/kaizen/issues/1225 — redo CI proof gate |');
    expect(body).toContain('| **PR generated** | https://github.com/Garsson-io/kaizen/pull/1227 |');
    expect(body).toContain('| **Review state** | fail (https://github.com/Garsson-io/kaizen/pull/1227#issuecomment-2) |');
    expect(body).toContain('#### Kaizen Work Cycle');
    expect(body).toContain('| PLAN | not observed | - | - |');
    expect(body).toContain('| CASE | not observed | - | - |');
    expect(body).toContain('| IMPLEMENT | not observed | - | - |');
    expect(body).toContain('| TEST | not observed | - | - |');
    expect(body).toContain('| REVIEW | fail | https://github.com/Garsson-io/kaizen/pull/1227#issuecomment-2 | https://github.com/Garsson-io/kaizen/pull/1227#issuecomment-2 |');
    expect(body).toContain('| REFLECT | not observed | - | - |');
    expect(body).toContain('| CLEANUP | not observed | - | - |');
    expect(body.indexOf('| PICK |')).toBeLessThan(body.indexOf('| REVIEW |'));
    expect(body.indexOf('| REVIEW |')).toBeLessThan(body.indexOf('| STOP |'));
  });
});

describe('extractPlanText — plan section regex extraction (kaizen #901)', () => {
  it('extracts ## Plan section from issue body', () => {
    const body = '## Problem\n\nSomething broke.\n\n## Plan\n\n1. Fix A\n2. Fix B\n\n## Test Plan\n\nRun tests.';
    const result = extractPlanText(body);
    expect(result).toContain('## Plan');
    expect(result).toContain('Fix A');
    expect(result).not.toContain('## Test Plan');
  });

  it('extracts ## Implementation Plan section', () => {
    const body = '## Implementation Plan\n\nStep 1: do X\nStep 2: do Y\n\n## References\n\n- #123';
    const result = extractPlanText(body);
    expect(result).toContain('## Implementation Plan');
    expect(result).toContain('Step 1');
    expect(result).not.toContain('## References');
  });

  it('returns undefined when no plan section exists', () => {
    const body = '## Problem\n\nBug report.\n\n## Acceptance Criteria\n\n- works';
    expect(extractPlanText(body)).toBeUndefined();
  });

  it('extracts plan that is the last section in the body', () => {
    const body = '## Problem\n\nBug.\n\n## Plan\n\n1. Fix it\n2. Test it';
    const result = extractPlanText(body);
    expect(result).toContain('Fix it');
    expect(result).toContain('Test it');
  });

  it('stops at ```yaml fence (structured metadata)', () => {
    const body = '## Plan\n\n1. Do stuff\n\n```yaml\ndeep_dive:\n  domain: foo\n```';
    const result = extractPlanText(body);
    expect(result).toContain('Do stuff');
    expect(result).not.toContain('deep_dive');
  });

  it('is case-insensitive', () => {
    const body = '## plan\n\nLowercase header.';
    const result = extractPlanText(body);
    expect(result).toContain('Lowercase header');
  });
});

describe('classifyFailure live wiring (#1102 regression guard)', () => {
  // The log-based heuristic branch (hook_rejection, infrastructure, timeout...)
  // is dead code unless the live call site passes the run log. This test pins
  // that the production call in auto-dent-run.ts passes a log argument, so the
  // branch can never be silently re-orphaned.
  const source = readFileSync(join(__dirname, 'auto-dent-run.ts'), 'utf8');

  it('reads the run log before classifying', () => {
    expect(source).toMatch(/readFileSync\(logFile, 'utf8'\)/);
  });

  it('passes a non-empty second argument to classifyFailure', () => {
    // Match the production call (not a bare metrics-only call). The second arg
    // must be the run log variable.
    const call = source.match(/classifyFailure\(runMetrics,\s*([A-Za-z0-9_]+)\)/);
    expect(call).not.toBeNull();
    expect(call![1]).not.toBe('');
  });
});

describe('test-task lifecycle evidence regression guard', () => {
  const source = readFileSync(join(__dirname, 'auto-dent-run.ts'), 'utf8');

  it('does not treat skipped review as process-incomplete for synthetic test tasks', () => {
    expect(source).toContain("reviewVerdict: state.test_task ? 'pass' : result.reviewVerdict");
  });
});

describe('auto-merge verdict binding wiring (#1220)', () => {
  it('routes post-review safety decisions into queueing and merge babysitting', () => {
    const decisionIndex = AUTO_DENT_RUN_SOURCE.indexOf('const autoMergeDecision = decideAutoMergeSafety({');
    const queueIndex = AUTO_DENT_RUN_SOURCE.indexOf('const autoMergeQueue = queueAutoMerge(result, state.host_repo || state.kaizen_repo, autoMergeDecision);');
    const cancelFailedIndex = AUTO_DENT_RUN_SOURCE.indexOf('const cancelFailed = new Set(autoMergeQueue.cancelFailed);');
    const unsafeSetIndex = AUTO_DENT_RUN_SOURCE.indexOf('result.prs.filter((pr) => !cancelFailed.has(pr))');
    const filterIndex = AUTO_DENT_RUN_SOURCE.indexOf('filter((pr) => !unsafeCurrentPRs.has(pr))');
    const driveIndex = AUTO_DENT_RUN_SOURCE.indexOf('driveBatchToMerge(allBatchPRs');

    expect(decisionIndex).toBeGreaterThan(-1);
    expect(queueIndex).toBeGreaterThan(decisionIndex);
    expect(cancelFailedIndex).toBeGreaterThan(queueIndex);
    expect(unsafeSetIndex).toBeGreaterThan(cancelFailedIndex);
    expect(filterIndex).toBeGreaterThan(unsafeSetIndex);
    expect(driveIndex).toBeGreaterThan(filterIndex);
  });

  it('holds cancel-failed unsafe PRs out of the merge-advance step (#1220 fail-open guard)', () => {
    // An unsafe PR we failed to --disable-auto must stay visible in babysitting
    // but never be update-branched toward merge. Assert the drive call passes
    // `holdPrs: cancelFailed`.
    const driveCall = AUTO_DENT_RUN_SOURCE.slice(
      AUTO_DENT_RUN_SOURCE.indexOf('driveBatchToMerge(allBatchPRs'),
      AUTO_DENT_RUN_SOURCE.indexOf('driveBatchToMerge(allBatchPRs') + 800,
    );
    expect(driveCall).toContain('holdPrs: cancelFailed');
  });

  it('feeds the hook-activation verdict + provider into the merge decision (#1220 completion)', () => {
    // Source-invariant guard: the fields are OPTIONAL on AutoMergeSafetySignals,
    // so typecheck cannot catch the call site dropping them. Assert the wiring at
    // the choke point binds the hook signal and defaults a missing provider to the
    // hook-expecting 'claude' (fail-closed).
    const callSite = AUTO_DENT_RUN_SOURCE.slice(
      AUTO_DENT_RUN_SOURCE.indexOf('const autoMergeDecision = decideAutoMergeSafety({'),
      AUTO_DENT_RUN_SOURCE.indexOf('const autoMergeQueue = queueAutoMerge('),
    );
    expect(callSite).toContain('hookActivation: result.hookActivation');
    expect(callSite).toContain("provider: state.provider ?? 'claude'");
  });

  it('stream → verdict → gate: a degraded claude run is blocked from auto-merge end-to-end', () => {
    // Build a REAL degraded verdict by replaying a captured plugins:[] system.init
    // through the production stream processor (the same path main() uses), then feed
    // the resulting RunResult into the merge gate exactly as the call site does.
    const result = makeRunResult({ prs: ['https://github.com/Garsson-io/kaizen/pull/1220'] });
    const ctx: StreamContext = { provider: 'claude' };
    processStreamMessage(
      { type: 'system', subtype: 'init', session_id: 'deadbeefcafef00d', model: 'claude-opus-4-6', plugins: [] },
      result,
      Date.now(),
      ctx,
    );
    expect(result.hookActivation?.degraded).toBe(true);

    const state = makeBatchState({ test_task: false }); // provider undefined → defaults to claude
    const decision = decideAutoMergeSafety({
      prCount: result.prs.length,
      reviewRequired: !state.test_task,
      reviewVerdict: 'pass',
      processVerdict: 'pass',
      lifecycleHealth: 'clean',
      hookActivation: result.hookActivation,
      provider: state.provider ?? 'claude',
    });
    expect(decision.allow).toBe(false);
    expect(decision.reasons).toContain('hook enforcement degraded (kaizen hooks did not load)');
  });

  it('stream → verdict → gate: a codex run with plugins:[] still auto-merges (provider asymmetry)', () => {
    const result = makeRunResult({ prs: ['https://github.com/Garsson-io/kaizen/pull/1221'] });
    const ctx: StreamContext = { provider: 'codex' };
    processStreamMessage(
      { type: 'system', subtype: 'init', session_id: 'codexsession01', model: 'gpt-5-codex', plugins: [] },
      result,
      Date.now(),
      ctx,
    );
    expect(result.hookActivation?.degraded).toBe(false);

    const state = makeBatchState({ test_task: false, provider: 'codex' });
    const decision = decideAutoMergeSafety({
      prCount: result.prs.length,
      reviewRequired: !state.test_task,
      reviewVerdict: 'pass',
      processVerdict: 'pass',
      lifecycleHealth: 'clean',
      hookActivation: result.hookActivation,
      provider: state.provider ?? 'claude',
    });
    expect(decision.allow).toBe(true);
  });
});

describe('post-run runId lifetime (#1128 regression guard)', () => {
  const source = readFileSync(join(__dirname, 'auto-dent-run.ts'), 'utf8');

  it('declares the run id once before all post-run telemetry and review wiring', () => {
    const declaration = 'const runId = makeRunId(state.batch_id, runNum);';
    const declarationIndex = source.indexOf(declaration);
    const runStartIndex = source.indexOf('events.emitAt(runStartDate');
    const reviewIndex = source.indexOf('const { reviewVerdict, reviewCostUsd, reviewUrls } = await runReviewWiring');

    expect(declarationIndex).toBeGreaterThan(-1);
    expect(declarationIndex).toBeLessThan(runStartIndex);
    expect(declarationIndex).toBeLessThan(reviewIndex);
    expect(source.split(declaration).length - 1).toBe(1);
    expect(source.slice(declarationIndex, reviewIndex)).toContain('run_id: runId');
  });
});

describe('attachRunTranscripts (#1508 wiring)', () => {
  const baseTranscript = '{"type":"system"}\n{"type":"result"}';

  function harness(over: Partial<Parameters<typeof attachRunTranscripts>[0]> = {}) {
    const attached: Array<{ target: any; parts: any }> = [];
    const logs: string[] = [];
    attachRunTranscripts({
      prs: ['https://github.com/o/r/pull/42'],
      repo: 'o/r',
      logFile: '/logs/run-1.log',
      label: 'batch/run-1',
      readLog: () => baseTranscript,
      attach: (target, parts) => {
        attached.push({ target, parts });
        return 'https://github.com/o/r/pull/42#issuecomment-1';
      },
      now: () => '2026-06-28T00:00:00Z',
      log: (m) => logs.push(m),
      ...over,
    });
    return { attached, logs };
  }

  it('attaches to each PR with the parsed PR number, label, and source path', () => {
    const { attached } = harness();
    expect(attached).toHaveLength(1);
    expect(attached[0].target).toEqual({ kind: 'pr', number: '42', repo: 'o/r' });
    expect(attached[0].parts.label).toBe('batch/run-1');
    expect(attached[0].parts.sourcePath).toBe('/logs/run-1.log');
    expect(attached[0].parts.transcript).toBe(baseTranscript);
  });

  it('skips a URL with no /pull/<N> (no throw, no attach)', () => {
    const { attached } = harness({ prs: ['https://github.com/o/r/pull/new/branch'] });
    expect(attached).toHaveLength(0);
  });

  it('skips when the repo is empty', () => {
    const { attached } = harness({ repo: '' });
    expect(attached).toHaveLength(0);
  });

  it('fails open when reading the log throws (logs a skip, does not throw)', () => {
    const { attached, logs } = harness({
      readLog: () => { throw new Error('ENOENT'); },
    });
    expect(attached).toHaveLength(0);
    expect(logs.some((l) => l.includes('skipped'))).toBe(true);
  });

  it('handles multiple PRs independently', () => {
    const { attached } = harness({
      prs: ['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2'],
    });
    expect(attached.map((a) => a.target.number)).toEqual(['1', '2']);
  });
});
