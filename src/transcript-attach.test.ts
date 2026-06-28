import { describe, it, expect } from 'vitest';
import {
  buildTranscriptComment,
  attachTranscript,
  RUN_TRANSCRIPT_ATTACHMENT,
} from './transcript-attach.js';
import { GITHUB_COMMENT_LIMIT } from './capped-attachment.js';

const NOW = '2026-06-28T12:00:00Z';

describe('buildTranscriptComment', () => {
  it('scrubs secrets out of the transcript before attaching', () => {
    const transcript = [
      '{"type":"system"}',
      '{"type":"tool_result","content":"ANTHROPIC_API_KEY=sk-ant-deadbeefdeadbeef0000"}',
      '{"type":"result"}',
    ].join('\n');
    const { body, redactions } = buildTranscriptComment(
      { label: 'batch/run-1', transcript, sourcePath: 'logs/auto-dent/run-1.log' },
      NOW,
    );
    expect(body).not.toContain('sk-ant-deadbeefdeadbeef0000');
    expect(redactions).toBeGreaterThan(0);
    expect(body).toContain('## Session Transcript: `batch/run-1`');
    expect(body).toContain('logs/auto-dent/run-1.log');
  });

  it('caps an oversized transcript under GitHub’s comment limit', () => {
    const huge = Array.from({ length: 8000 }, (_, i) => `{"tool":"Bash","i":${i}}`).join('\n');
    const { body } = buildTranscriptComment(
      { label: 'big', transcript: huge, sourcePath: 'logs/x.log' },
      NOW,
    );
    expect(body.length).toBeLessThanOrEqual(GITHUB_COMMENT_LIMIT);
    expect(body).toContain('## Session Transcript: `big`');
    expect(body).toContain('(truncated)');
  });
});

describe('attachTranscript', () => {
  it('writes the scrubbed body under the stable run-transcript attachment name', () => {
    const calls: Array<{ name: string; body: string }> = [];
    const fakeWrite = (_t: unknown, name: string, body: string): string => {
      calls.push({ name, body });
      return 'https://github.com/o/r/pull/9#issuecomment-1';
    };
    const url = attachTranscript(
      { kind: 'pr', number: '9', repo: 'o/r' },
      {
        label: 'batch/run-2',
        transcript: '{"k":"v"}\nBearer sometokenvalue12345',
        sourcePath: 'logs/run-2.log',
      },
      NOW,
      fakeWrite,
    );
    expect(url).toContain('issuecomment');
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe(RUN_TRANSCRIPT_ATTACHMENT);
    expect(calls[0].name).toBe('run-transcript'); // idempotency identity must not drift
    expect(calls[0].body).not.toContain('sometokenvalue12345');
  });
});
