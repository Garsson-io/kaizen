import { describe, it, expect } from 'vitest';
import {
  buildPrompt,
  extractArtifacts,
  checkStopSignal,
  formatToolUse,
  processStreamMessage,
  type BatchState,
  type RunResult,
} from './auto-dent-run.js';

function makeBatchState(overrides: Partial<BatchState> = {}): BatchState {
  return {
    batch_id: 'batch-260322-2100-a1b2',
    batch_start: 1742680800,
    guidance: 'improve hooks reliability',
    max_runs: 5,
    cooldown: 30,
    budget: '3.00',
    max_failures: 3,
    kaizen_repo: 'Garsson-io/kaizen',
    host_repo: 'Garsson-io/kaizen',
    run: 0,
    prs: [],
    issues_filed: [],
    issues_closed: [],
    cases: [],
    consecutive_failures: 0,
    current_cooldown: 30,
    stop_reason: '',
    last_issue: '',
    last_pr: '',
    last_case: '',
    last_branch: '',
    last_worktree: '',
    ...overrides,
  };
}

function makeRunResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    prs: [],
    issuesFiled: [],
    issuesClosed: [],
    cases: [],
    cost: 0,
    toolCalls: 0,
    stopRequested: false,
    ...overrides,
  };
}

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

  it('includes merge policy with host repo', () => {
    const state = makeBatchState({ host_repo: 'Garsson-io/kaizen' });
    const prompt = buildPrompt(state, 1);
    expect(prompt).toContain('gh pr merge');
    expect(prompt).toContain('Garsson-io/kaizen');
    expect(prompt).toContain('--squash --delete-branch --auto');
  });

  it('includes AUTO_DENT_STOP instructions', () => {
    const state = makeBatchState();
    const prompt = buildPrompt(state, 1);
    expect(prompt).toContain('AUTO_DENT_STOP:');
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

describe('extractArtifacts', () => {
  it('extracts PR URLs from text', () => {
    const result = makeRunResult();
    extractArtifacts(
      'Created PR: https://github.com/Garsson-io/kaizen/pull/450',
      result,
    );
    expect(result.prs).toEqual([
      'https://github.com/Garsson-io/kaizen/pull/450',
    ]);
  });

  it('extracts multiple PR URLs', () => {
    const result = makeRunResult();
    extractArtifacts(
      'PRs: https://github.com/Garsson-io/kaizen/pull/450 and https://github.com/Garsson-io/kaizen/pull/451',
      result,
    );
    expect(result.prs).toHaveLength(2);
  });

  it('deduplicates PR URLs', () => {
    const result = makeRunResult();
    extractArtifacts(
      'https://github.com/Garsson-io/kaizen/pull/450',
      result,
    );
    extractArtifacts(
      'https://github.com/Garsson-io/kaizen/pull/450',
      result,
    );
    expect(result.prs).toHaveLength(1);
  });

  it('extracts issue URLs', () => {
    const result = makeRunResult();
    extractArtifacts(
      'Filed: https://github.com/Garsson-io/kaizen/issues/267',
      result,
    );
    expect(result.issuesFiled).toEqual([
      'https://github.com/Garsson-io/kaizen/issues/267',
    ]);
  });

  it('extracts closes/fixes/resolves references', () => {
    const result = makeRunResult();
    extractArtifacts('Closes #100, fixes #200, resolves #300', result);
    expect(result.issuesClosed).toContain('#100');
    expect(result.issuesClosed).toContain('#200');
    expect(result.issuesClosed).toContain('#300');
  });

  it('extracts "closed" past tense references', () => {
    const result = makeRunResult();
    extractArtifacts('Closed #150', result);
    expect(result.issuesClosed).toContain('#150');
  });

  it('extracts kaizen issue references', () => {
    const result = makeRunResult();
    extractArtifacts('Addressed kaizen #451', result);
    expect(result.issuesClosed).toContain('#451');
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
});

describe('checkStopSignal', () => {
  it('detects AUTO_DENT_STOP signal', () => {
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

  it('does not trigger on text without stop signal', () => {
    const result = makeRunResult();
    checkStopSignal('Just regular output about AUTO_DENT features', result);
    expect(result.stopRequested).toBe(false);
  });

  it('trims whitespace from stop reason', () => {
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

  it('detects stop signal on its own line amid other text', () => {
    const result = makeRunResult();
    checkStopSignal(
      'Some preamble\nAUTO_DENT_STOP: backlog exhausted\nSome epilogue',
      result,
    );
    expect(result.stopRequested).toBe(true);
    expect(result.stopReason).toBe('backlog exhausted');
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
              text: 'Created https://github.com/Garsson-io/kaizen/pull/500',
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
            { type: 'text', text: 'AUTO_DENT_STOP: backlog exhausted' },
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
          'Done. Closes #451. PR: https://github.com/Garsson-io/kaizen/pull/500',
      },
      result,
      Date.now(),
    );
    expect(result.prs).toContain(
      'https://github.com/Garsson-io/kaizen/pull/500',
    );
    expect(result.issuesClosed).toContain('#451');
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
});
