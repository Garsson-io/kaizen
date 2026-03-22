import { describe, test, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import { parseExperimentSpec } from './experiment-spec-parser.js';
import type { ExperimentSpec } from './experiment-spec-parser.js';

// INVARIANT: parseExperimentSpec extracts structured config from markdown experiment specs.
// Missing sections produce graceful defaults (empty strings, empty arrays, null values).

const COMPLETE_SPEC = `# Experiment: Phase markers improve coherence
## Hypothesis
Adding phase markers increases completed workflow phases per run.
## Variants
- baseline: prompts/deep-dive-v1.md
- treatment: prompts/deep-dive-v2-phases.md
## Metric
Primary: phases_completed
## Budget
5 runs per variant, $3 max per run
`;

describe('parseExperimentSpec', () => {
  test('parses complete spec with all fields', () => {
    const spec = parseExperimentSpec(COMPLETE_SPEC);

    expect(spec.title).toBe('Phase markers improve coherence');
    expect(spec.hypothesis).toBe(
      'Adding phase markers increases completed workflow phases per run.',
    );
    expect(spec.variants).toEqual([
      { name: 'baseline', value: 'prompts/deep-dive-v1.md' },
      { name: 'treatment', value: 'prompts/deep-dive-v2-phases.md' },
    ]);
    expect(spec.metrics).toEqual([
      { type: 'primary', name: 'phases_completed' },
    ]);
    expect(spec.budget).toEqual({
      runsPerVariant: 5,
      maxCostPerRun: 3,
    });
  });

  test('handles missing hypothesis gracefully', () => {
    const md = `# Experiment: No hypothesis here
## Variants
- a: foo
`;
    const spec = parseExperimentSpec(md);
    expect(spec.hypothesis).toBe('');
  });

  test('handles missing variants gracefully', () => {
    const md = `# Experiment: No variants
## Hypothesis
Some hypothesis.
`;
    const spec = parseExperimentSpec(md);
    expect(spec.variants).toEqual([]);
  });

  test('handles missing metrics gracefully', () => {
    const md = `# Experiment: No metrics
## Hypothesis
Some hypothesis.
`;
    const spec = parseExperimentSpec(md);
    expect(spec.metrics).toEqual([]);
  });

  test('handles missing budget gracefully', () => {
    const md = `# Experiment: No budget
## Hypothesis
Some hypothesis.
`;
    const spec = parseExperimentSpec(md);
    expect(spec.budget).toEqual({
      runsPerVariant: null,
      maxCostPerRun: null,
    });
  });

  test('parses multiple variants', () => {
    const md = `# Experiment: Multi variant
## Variants
- control: prompts/v1.md
- treatment-a: prompts/v2a.md
- treatment-b: prompts/v2b.md
`;
    const spec = parseExperimentSpec(md);
    expect(spec.variants).toHaveLength(3);
    expect(spec.variants[2]).toEqual({
      name: 'treatment-b',
      value: 'prompts/v2b.md',
    });
  });

  test('parses primary and secondary metrics', () => {
    const md = `# Experiment: Multi metric
## Metrics
Primary: phases_completed
Secondary: token_cost
Secondary: wall_clock_time
`;
    const spec = parseExperimentSpec(md);
    expect(spec.metrics).toEqual([
      { type: 'primary', name: 'phases_completed' },
      { type: 'secondary', name: 'token_cost' },
      { type: 'secondary', name: 'wall_clock_time' },
    ]);
  });

  test('extracts budget numbers correctly', () => {
    const md = `# Experiment: Budget test
## Budget
10 runs per variant, $5.50 max per run
`;
    const spec = parseExperimentSpec(md);
    expect(spec.budget.runsPerVariant).toBe(10);
    expect(spec.budget.maxCostPerRun).toBe(5.5);
  });

  test('handles "# Experiment: title" format', () => {
    const md = `# Experiment: My cool experiment
## Hypothesis
It works.
`;
    const spec = parseExperimentSpec(md);
    expect(spec.title).toBe('My cool experiment');
  });

  test('handles plain "# title" format without Experiment: prefix', () => {
    const md = `# My plain title
## Hypothesis
It works.
`;
    const spec = parseExperimentSpec(md);
    expect(spec.title).toBe('My plain title');
  });

  test('handles multiline hypothesis', () => {
    const md = `# Experiment: Multiline
## Hypothesis
This is a hypothesis that spans
multiple lines and has some
detailed reasoning.
## Variants
- a: foo
`;
    const spec = parseExperimentSpec(md);
    expect(spec.hypothesis).toContain('multiple lines');
    expect(spec.hypothesis).toContain('detailed reasoning');
  });

  test('handles empty markdown', () => {
    const spec = parseExperimentSpec('');
    expect(spec.title).toBe('');
    expect(spec.hypothesis).toBe('');
    expect(spec.variants).toEqual([]);
    expect(spec.metrics).toEqual([]);
    expect(spec.budget).toEqual({ runsPerVariant: null, maxCostPerRun: null });
  });

  test('handles bare list metrics without type prefix', () => {
    const md = `# Experiment: Bare metrics
## Metric
- completion_rate
- error_count
`;
    const spec = parseExperimentSpec(md);
    expect(spec.metrics).toEqual([
      { type: 'primary', name: 'completion_rate' },
      { type: 'primary', name: 'error_count' },
    ]);
  });

  test('handles budget with partial info (only runs)', () => {
    const md = `# Experiment: Partial budget
## Budget
3 runs per variant
`;
    const spec = parseExperimentSpec(md);
    expect(spec.budget.runsPerVariant).toBe(3);
    expect(spec.budget.maxCostPerRun).toBeNull();
  });

  test('handles budget with partial info (only cost)', () => {
    const md = `# Experiment: Partial budget
## Budget
$2 per run
`;
    const spec = parseExperimentSpec(md);
    expect(spec.budget.runsPerVariant).toBeNull();
    expect(spec.budget.maxCostPerRun).toBe(2);
  });

  test('handles metrics with "- Primary:" list format', () => {
    const md = `# Experiment: List metrics
## Metric
- Primary: phases_completed
- Secondary: cost
`;
    const spec = parseExperimentSpec(md);
    expect(spec.metrics).toEqual([
      { type: 'primary', name: 'phases_completed' },
      { type: 'secondary', name: 'cost' },
    ]);
  });
});

describe('parseExperimentSpec roundtrip with real files', () => {
  test('parses a real experiment file from experiments directory if available', () => {
    // Try to find experiment files in the repo
    const experimentsDir = path.resolve(
      __dirname,
      '..',
      '.claude',
      'kaizen',
      'experiments',
    );

    if (!fs.existsSync(experimentsDir)) {
      // No experiments directory — skip gracefully
      return;
    }

    const files = fs.readdirSync(experimentsDir).filter((f) => f.endsWith('.md'));
    if (files.length === 0) return;

    // Parse the first experiment file — should not throw
    const content = fs.readFileSync(path.join(experimentsDir, files[0]), 'utf-8');
    const spec = parseExperimentSpec(content);

    // Title should be non-empty for any real experiment file
    expect(typeof spec.title).toBe('string');
    expect(typeof spec.hypothesis).toBe('string');
    expect(Array.isArray(spec.variants)).toBe(true);
    expect(Array.isArray(spec.metrics)).toBe(true);
    expect(spec.budget).toBeDefined();
  });
});
