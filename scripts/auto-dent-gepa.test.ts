import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import {
  buildGepaPromptEvolutionBundle,
  type GepaBundleInput,
} from './auto-dent-gepa.js';
import type { RunMetrics } from './auto-dent-run.js';

function run(overrides: Partial<RunMetrics>): RunMetrics {
  return {
    run: 1,
    start_epoch: 1,
    duration_seconds: 60,
    exit_code: 0,
    cost_usd: 1,
    tool_calls: 10,
    prs: [],
    issues_filed: [],
    issues_closed: [],
    cases: [],
    stop_requested: false,
    ...overrides,
  };
}

function input(overrides: Partial<GepaBundleInput> = {}): GepaBundleInput {
  return {
    batchId: 'batch-gepa',
    generatedAt: '2026-06-29T01:09:00.000Z',
    promptTarget: {
      id: 'explore-gaps',
      path: 'prompts/explore-gaps.md',
      text: 'Explore prompt',
    },
    textualFeedback: [
      'Explore should emit durable candidate-task manifests, not only file issues.',
      'Reward should not collapse to a single issues_filed scalar.',
    ],
    runs: [
      run({
        run: 1,
        mode: 'explore',
        issues_filed: ['#1196', '#1211'],
        prompt_template: 'explore-gaps.md',
        prompt_hash: 'abc123',
        process_verdict: 'pass',
        review_verdict: 'skipped',
      }),
      run({
        run: 2,
        mode: 'exploit',
        prs: ['https://github.com/Garsson-io/kaizen/pull/1581'],
        review_verdict: 'pass',
      }),
    ],
    ...overrides,
  };
}

describe('auto-dent GEPA bundle (#1211)', () => {
  it('builds a dry-run GEPA-ready bundle from prompt, feedback, and run traces', () => {
    const bundle = buildGepaPromptEvolutionBundle(input());

    expect(bundle).toMatchObject({
      version: 1,
      optimizer: 'GEPA',
      runtime: { mode: 'dry-run', externalDependency: 'optional' },
      batchId: 'batch-gepa',
      promptTarget: {
        id: 'explore-gaps',
        path: 'prompts/explore-gaps.md',
        text: 'Explore prompt',
      },
    });
    expect(bundle.textualFeedback).toContain('Reward should not collapse to a single issues_filed scalar.');
    expect(bundle.traceExamples).toHaveLength(2);
    expect(bundle.traceExamples[0]).toMatchObject({
      run: 1,
      mode: 'explore',
      promptHash: 'abc123',
      promptTemplate: 'explore-gaps.md',
      reward: 2,
      artifacts: { prs: [], issuesFiled: ['#1196', '#1211'], issuesClosed: [] },
      qualitySignals: { processVerdict: 'pass', reviewVerdict: 'skipped' },
    });
    expect(bundle.traceExamples[1].reward).toBe(1);
  });

  it('names Pareto objectives instead of a single scalar reward', () => {
    const bundle = buildGepaPromptEvolutionBundle(input());

    expect(bundle.paretoObjectives.map((objective) => objective.id)).toEqual([
      'mode_reward',
      'process_completeness',
      'review_pass_rate',
      'cost_usd',
    ]);
    expect(bundle.paretoObjectives.find((objective) => objective.id === 'mode_reward')).toMatchObject({
      direction: 'maximize',
      source: 'scripts/auto-dent-run.ts:modeSuccess',
    });
    expect(bundle.paretoObjectives.find((objective) => objective.id === 'cost_usd')).toMatchObject({
      direction: 'minimize',
    });
  });

  it('CLI emits inspectable JSON without requiring live GEPA, Python, or API keys', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'auto-dent-gepa-'));
    const inputPath = join(tmp, 'input.json');
    const promptPath = join(tmp, 'explore-gaps.md');
    writeFileSync(inputPath, JSON.stringify(input({ promptTarget: { id: 'explore-gaps', path: promptPath } }), null, 2));
    writeFileSync(promptPath, 'Prompt from disk');

    const result = spawnSync('npx', ['tsx', 'scripts/auto-dent-gepa.ts', '--input', inputPath, '--prompt-file', promptPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const parsed = JSON.parse(result.stdout);
    expect(parsed.runtime).toEqual({ mode: 'dry-run', externalDependency: 'optional' });
    expect(parsed.promptTarget.text).toBe('Prompt from disk');
    expect(parsed.traceExamples[0].mode).toBe('explore');

    const source = readFileSync('scripts/auto-dent-gepa.ts', 'utf8');
    expect(source).not.toContain('child_process');
    expect(source).not.toContain('pip install');
    expect(source).not.toContain('OPENAI_API_KEY');
  });
});
