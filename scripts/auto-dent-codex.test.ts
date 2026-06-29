import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  assessCodexRun,
  buildCodexExecArgs,
  hasCodexFailedTerminalEvent,
  hasCodexTerminalEvent,
  isCodexFailedTerminalEvent,
  isCodexTerminalEvent,
  parseCodexJsonl,
  extractCodexPhaseMarkers,
  normalizeCodexEventToStreamMessages,
  normalizeCodexFinalTextToStreamMessages,
} from './auto-dent-codex.js';
import { processStreamMessage } from './auto-dent-stream.js';
import { makeRunResult } from './auto-dent-test-helpers.js';

describe('buildCodexExecArgs (#1144)', () => {
  it('constructs codex exec argv for externally sandboxed synthetic runs', () => {
    const args = buildCodexExecArgs('/repo/worktree');

    expect(args).toEqual([
      'exec',
      '--json',
      '--cd',
      '/repo/worktree',
      '--sandbox',
      'danger-full-access',
      '--dangerously-bypass-approvals-and-sandbox',
      '--color',
      'never',
      '-',
    ]);
  });

  it('can construct read-only Codex exec argv for review and probe callers', () => {
    const args = buildCodexExecArgs('/repo/worktree', {
      sandbox: 'read-only',
      bypassApprovalsAndSandbox: false,
    });

    expect(args).toContain('read-only');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });
});

describe('parseCodexJsonl (#1144)', () => {
  it('extracts final text and text chunks from Codex JSONL', () => {
    const parsed = parseCodexJsonl([
      JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'AUTO_DENT_PHASE: PICK | issue=#1' }] }),
      JSON.stringify({ type: 'final_message', message: 'AUTO_DENT_PHASE: TEST | result=pass | count=1' }),
    ].join('\n'));

    expect(parsed.events).toHaveLength(2);
    expect(parsed.text).toContain('AUTO_DENT_PHASE: PICK');
    expect(parsed.finalText).toContain('AUTO_DENT_PHASE: TEST');
    expect(parsed.malformedLines).toEqual([]);
  });

  it('keeps malformed lines without throwing', () => {
    const parsed = parseCodexJsonl([
      '{"type":"message","content":"ok"}',
      '{not json',
    ].join('\n'));

    expect(parsed.events).toHaveLength(1);
    expect(parsed.malformedLines).toEqual(['{not json']);
  });

  it('delegates JSONL row parsing and malformed-row accounting to the shared helper', () => {
    const source = readFileSync('src/codex-agent.ts', 'utf8');
    const parserSource = source.slice(
      source.indexOf('export function parseCodexJsonl'),
      source.indexOf('export function extractCodexPhaseMarkers'),
    );

    expect(parserSource).not.toMatch(/JSON\.parse\(line\)/);
    expect(parserSource).not.toMatch(/jsonl\.split/);
  });

  it('extracts current Codex item payloads from supervised provider runs (#1197)', () => {
    const parsed = parseCodexJsonl([
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_0',
          type: 'agent_message',
          text: 'I will create the requested probe PR.',
        },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command: 'gh pr create',
          aggregated_output: 'https://github.com/Garsson-io/kaizen/pull/1194\n',
          exit_code: 0,
          status: 'completed',
        },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_2',
          type: 'agent_message',
          text: [
            'Completed all requested steps.',
            'Created and merged PR:',
            '- https://github.com/Garsson-io/kaizen/pull/1194',
          ].join('\n'),
        },
      }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }),
    ].join('\n'));

    expect(parsed.events).toHaveLength(4);
    expect(parsed.text).toContain('I will create the requested probe PR.');
    expect(parsed.text).toContain('https://github.com/Garsson-io/kaizen/pull/1194');
    expect(parsed.finalText).toContain('Completed all requested steps.');
    expect(parsed.finalText).toContain('pull/1194');
    expect(hasCodexTerminalEvent(parsed)).toBe(true);
  });

  it('recognizes real Codex turn lifecycle rows as terminal events', () => {
    expect(isCodexTerminalEvent({ type: 'turn.completed' })).toBe(true);
    expect(isCodexTerminalEvent({ type: 'turn.failed', error: { message: 'usage limit' } })).toBe(true);
    expect(isCodexTerminalEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'working' } })).toBe(false);
    expect(isCodexFailedTerminalEvent({ type: 'turn.failed', error: { message: 'usage limit' } })).toBe(true);
    expect(isCodexFailedTerminalEvent({ type: 'turn.completed' })).toBe(false);
    expect(hasCodexFailedTerminalEvent(parseCodexJsonl(JSON.stringify({ type: 'turn.failed' })))).toBe(true);
  });

  it('centralizes Codex run failure assessment', () => {
    expect(assessCodexRun(parseCodexJsonl(JSON.stringify({ type: 'turn.completed' })))).toMatchObject({
      malformedLineCount: 0,
      hasTerminalEvent: true,
      hasFailedTerminalEvent: false,
      failureNotes: [],
    });

    const failed = assessCodexRun(parseCodexJsonl([
      '{not json',
      JSON.stringify({ type: 'turn.failed' }),
    ].join('\n')));
    expect(failed.failureNotes).toEqual([
      'malformed codex jsonl lines: 1',
      'codex turn failed',
    ]);
  });

  it('recovers AUTO_DENT_PHASE markers from parsed Codex text', () => {
    const parsed = parseCodexJsonl(JSON.stringify({
      type: 'final_message',
      message: [
        'done',
        'AUTO_DENT_PHASE: IMPLEMENT | case=synthetic',
        'AUTO_DENT_PHASE: PR | url=https://example.test/pull/1',
      ].join('\n'),
    }));

    expect(extractCodexPhaseMarkers(parsed)).toEqual([
      'AUTO_DENT_PHASE: IMPLEMENT | case=synthetic',
      'AUTO_DENT_PHASE: PR | url=https://example.test/pull/1',
    ]);
  });
});

describe('normalizeCodexEventToStreamMessages (#1488)', () => {
  it('turns Codex agent messages into canonical assistant text messages', () => {
    const messages = normalizeCodexEventToStreamMessages({
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: 'AUTO_DENT_PHASE: PICK | issue=#1488 | title=Codex stream contract',
      },
    });

    const result = makeRunResult();
    for (const message of messages) {
      processStreamMessage(message, result, Date.now());
    }

    expect(result.pickedIssue).toBe('#1488');
    expect(result.pickedIssueTitle).toBe('Codex stream contract');
  });

  it('turns Codex command executions into shared tool-use and tool-result messages', () => {
    const messages = normalizeCodexEventToStreamMessages({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        command: 'gh pr create',
        aggregated_output: 'https://github.com/Garsson-io/kaizen/pull/1499\n',
        exit_code: 0,
        status: 'completed',
      },
    });

    const result = makeRunResult();
    const ctx = {};
    for (const message of messages) {
      processStreamMessage(message, result, Date.now(), ctx);
    }

    expect(result.toolCalls).toBe(1);
    expect(result.prs).toEqual(['https://github.com/Garsson-io/kaizen/pull/1499']);
    expect(ctx).toMatchObject({ lastActivity: expect.stringContaining('gh pr create') });
  });

  it('turns Codex final messages into canonical result messages for final claim parsing', () => {
    const claim = {
      schema_version: 1,
      selected_issue: '#1488',
      case_worktree: '260628-k1488-codex-stream-contract',
      tests: { status: 'pass', command: 'npm test', count: 3, evidence: ['3 passed'] },
      pr_url: 'https://github.com/Garsson-io/kaizen/pull/1499',
      review_status: 'pass',
      reflection_status: 'done',
      stop_reason: null,
      blockers: [],
    };

    const messages = normalizeCodexEventToStreamMessages({
      type: 'final_message',
      message: JSON.stringify(claim),
    });

    const result = makeRunResult();
    for (const message of messages) {
      processStreamMessage(message, result, Date.now());
    }

    expect(result.finalClaimStatus).toBe('valid');
    expect(result.finalClaim?.selected_issue).toBe('#1488');
  });

  it('preserves parsed final-text fallback through the canonical result path', () => {
    const result = makeRunResult();
    for (const message of normalizeCodexFinalTextToStreamMessages('AUTO_DENT_PHASE: TEST | result=pass | count=3')) {
      processStreamMessage(message, result, Date.now());
    }

    expect(result.progressSteps?.find((s) => s.phase === 'TEST')).toMatchObject({
      state: 'pass',
      detail: '3 tests',
    });
  });
});
