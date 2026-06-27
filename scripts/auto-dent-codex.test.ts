import { describe, it, expect } from 'vitest';
import {
  buildCodexExecArgs,
  parseCodexJsonl,
  extractCodexPhaseMarkers,
} from './auto-dent-codex.js';

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
