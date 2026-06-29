import { describe, expect, it } from 'vitest';

import {
  analyzeContextDelegation,
  buildAutomaticContextDelegationStep,
  DEFAULT_CONTEXT_DELEGATION_SUBSTEPS,
  renderContextDelegationPolicy,
} from './auto-dent-context-delegation.js';

function assistantText(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  });
}

function toolUse(name: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, input }] },
  });
}

function logWith(lines: string[]): string {
  return lines.join('\n');
}

describe('auto-dent context delegation pressure', () => {
  it('publishes the delegated-by-default sub-step policy in one reusable place', () => {
    expect(DEFAULT_CONTEXT_DELEGATION_SUBSTEPS).toEqual([
      'broad code search',
      'multi-file summarization',
      'independent investigations',
      'review dimensions',
      'related-area DRY/dead-code sweeps',
    ]);
    expect(renderContextDelegationPolicy()).toContain('fan out broad code search');
    expect(renderContextDelegationPolicy()).toContain('AUTO_DENT_PHASE: DELEGATE');
  });

  it('requires delegation for transcript context growth and missing-subagent signals', () => {
    const analysis = analyzeContextDelegation(logWith([
      assistantText('I need to re-read the issue after context compaction. I should have used a subagent.'),
      toolUse('Read', { file_path: 'src/transcript-analysis.ts' }),
      toolUse('Read', { file_path: 'src/transcript-analysis.ts' }),
    ]));

    expect(analysis.pressure.required).toBe(true);
    expect(analysis.pressure.reasons.join('\n')).toContain('context_growth');
    expect(analysis.pressure.reasons.join('\n')).toContain('missing_subagent');
    expect(analysis.pressure.recommendedSubsteps).toContain('multi-file summarization');
  });

  it('requires delegation when main-thread discovery crosses the tool-call threshold', () => {
    const repeatedReads = Array.from({ length: 9 }, () =>
      toolUse('Read', { file_path: 'src/auto-dent-run.ts' }),
    );
    const broadSearches = Array.from({ length: 5 }, (_, i) =>
      toolUse('Grep', { pattern: `context-delegation-${i % 2}`, glob: '**/*.ts' }),
    );

    const analysis = analyzeContextDelegation(logWith([
      ...repeatedReads,
      ...broadSearches,
    ]));

    expect(analysis.pressure.required).toBe(true);
    expect(analysis.pressure.mainThreadToolCalls).toBe(14);
    expect(analysis.pressure.repeatedReads).toBeGreaterThanOrEqual(1);
    expect(analysis.pressure.reasons.join('\n')).toContain('main_thread_discovery');
    expect(analysis.pressure.recommendedSubsteps).toContain('broad code search');
  });

  it('records automatic DELEGATE evidence from observed subagent tool use before implementation', () => {
    const analysis = analyzeContextDelegation(logWith([
      toolUse('Agent', {
        description: 'Map transcript-analysis and auto-dent delegation seams',
        subagent_type: 'explorer',
      }),
      toolUse('Read', { file_path: 'scripts/auto-dent-run.ts' }),
    ]));

    expect(analysis.delegation.observed).toBe(true);
    const step = buildAutomaticContextDelegationStep(analysis);
    expect(step).toEqual({
      phase: 'DELEGATE',
      state: 'done',
      detail: expect.stringContaining('Map transcript-analysis'),
    });
  });

  it('stays quiet for empty, malformed, and below-threshold logs', () => {
    const analysis = analyzeContextDelegation(logWith([
      'not-json',
      ...Array.from({ length: 9 }, (_, i) => toolUse('Read', { file_path: `src/file-${i}.ts` })),
      toolUse('Bash', { command: 'git status --short' }),
      toolUse('Bash', { command: 'git diff --check' }),
    ]));

    expect(analysis.pressure.required).toBe(false);
    expect(analysis.pressure.mainThreadToolCalls).toBe(11);
    expect(analysis.pressure.discoveryToolCalls).toBe(9);
    expect(analysis.delegation.observed).toBe(false);
    expect(buildAutomaticContextDelegationStep(analysis)).toBeUndefined();
  });

  it('ignores delegation tools after implementation has started', () => {
    for (const log of [
      logWith([
        assistantText('AUTO_DENT_PHASE: IMPLEMENT | case=case-1'),
        toolUse('Agent', { description: 'late search', subagent_type: 'explorer' }),
      ]),
      logWith([
        toolUse('Edit', { file_path: 'src/file.ts', old_string: 'a', new_string: 'b' }),
        toolUse('TaskCreate', { subject: 'late task' }),
      ]),
    ]) {
      const analysis = analyzeContextDelegation(log);
      expect(analysis.delegation.observed).toBe(false);
      expect(buildAutomaticContextDelegationStep(analysis)).toBeUndefined();
    }
  });

  it('records TaskCreate delegation using subject or prompt fallback evidence', () => {
    const subjectStep = buildAutomaticContextDelegationStep(analyzeContextDelegation(logWith([
      toolUse('TaskCreate', { subject: 'Review dimensions in parallel' }),
    ])));
    const promptStep = buildAutomaticContextDelegationStep(analyzeContextDelegation(logWith([
      toolUse('TaskCreate', { prompt: 'Summarize five files without loading them into the orchestrator' }),
    ])));

    expect(subjectStep?.detail).toContain('Review dimensions in parallel');
    expect(promptStep?.detail).toContain('Summarize five files');
  });

  it('demonstrates the synthetic before/after bounded main-thread tool volume', () => {
    const before = analyzeContextDelegation(logWith([
      ...Array.from({ length: 8 }, (_, i) => toolUse('Read', { file_path: `src/file-${i}.ts` })),
      ...Array.from({ length: 6 }, (_, i) => toolUse('Grep', { pattern: `symbol-${i}`, glob: '**/*.ts' })),
    ]));
    const after = analyzeContextDelegation(logWith([
      toolUse('Agent', {
        description: 'Fan out broad search and summarization',
        subagent_type: 'explorer',
      }),
      toolUse('Read', { file_path: 'summary.md' }),
      toolUse('Grep', { pattern: 'single follow-up', glob: '**/*.ts' }),
    ]));

    expect(before.pressure.required).toBe(true);
    expect(after.pressure.required).toBe(false);
    expect(after.delegation.observed).toBe(true);
    expect(after.pressure.mainThreadToolCalls).toBeLessThan(before.pressure.mainThreadToolCalls);
  });
});
