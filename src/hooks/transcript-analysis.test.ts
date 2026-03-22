import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  analyzeTranscript,
  analyzeTranscriptFile,
  formatAnalysisSummary,
  parseTranscript,
} from './transcript-analysis.js';
import {
  SyntheticSession,
  sessionWithCorrections,
  sessionWithFailures,
  sessionWithHookDenials,
  sessionWithRepeatedRequests,
  sessionWithMixedSignals,
  sessionClean,
} from './synthetic-transcript.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kaizen-transcript-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true });
});

describe('parseTranscript', () => {
  it('parses valid JSONL', () => {
    const jsonl = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: [] } }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [] },
      }),
    ].join('\n');

    const entries = parseTranscript(jsonl);
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe('user');
    expect(entries[1].type).toBe('assistant');
  });

  it('skips malformed lines', () => {
    const jsonl =
      '{"type":"user"}\nnot-json\n{"type":"assistant"}';
    const entries = parseTranscript(jsonl);
    expect(entries).toHaveLength(2);
  });
});

describe('analyzeTranscript', () => {
  describe('user corrections', () => {
    it('detects user pushback', () => {
      const session = sessionWithCorrections();
      const analysis = analyzeTranscript(session.getEntries());

      expect(analysis.summary.userCorrections).toBeGreaterThanOrEqual(1);
      expect(
        analysis.signals.some((s) => s.type === 'user_correction'),
      ).toBe(true);
    });

    it('detects "no don\'t" pattern', () => {
      const session = new SyntheticSession()
        .userMessage('Fix the bug')
        .userMessage("No, don't change that file");
      const analysis = analyzeTranscript(session.getEntries());
      expect(analysis.summary.userCorrections).toBe(1);
    });

    it('detects "you didn\'t actually" pattern', () => {
      const session = new SyntheticSession()
        .userMessage('Add tests')
        .userMessage("You didn't actually add any tests");
      const analysis = analyzeTranscript(session.getEntries());
      expect(analysis.summary.userCorrections).toBe(1);
    });

    it('detects "that\'s not what I asked" pattern', () => {
      const session = new SyntheticSession()
        .userMessage('Refactor the module')
        .userMessage("That's not what I asked for");
      const analysis = analyzeTranscript(session.getEntries());
      expect(analysis.summary.userCorrections).toBe(1);
    });
  });

  describe('failed tool calls', () => {
    it('detects failed tool calls', () => {
      const session = sessionWithFailures();
      const analysis = analyzeTranscript(session.getEntries());

      expect(analysis.summary.failedToolCalls).toBe(2);
      expect(
        analysis.signals.filter((s) => s.type === 'failed_tool_call'),
      ).toHaveLength(2);
    });
  });

  describe('hook denials', () => {
    it('detects hook blocks', () => {
      const session = sessionWithHookDenials();
      const analysis = analyzeTranscript(session.getEntries());

      expect(analysis.summary.hookDenials).toBeGreaterThanOrEqual(1);
      expect(
        analysis.signals.some((s) => s.type === 'hook_denial'),
      ).toBe(true);
    });

    it('detects BLOCKED: pattern in error results', () => {
      const session = new SyntheticSession()
        .toolUse('Bash', { command: 'git push' })
        .toolError('BLOCKED: enforce-worktree.sh — not in a worktree');
      const analysis = analyzeTranscript(session.getEntries());
      expect(analysis.summary.hookDenials).toBe(1);
    });

    it('ignores hook mentions in successful tool results (e.g. Read)', () => {
      const session = new SyntheticSession()
        .toolUse('Read', { file_path: '/hooks/enforce-worktree.sh' })
        .toolResult('#!/bin/bash\n# enforce-case-worktree.sh\nBLOCKED: test');
      const analysis = analyzeTranscript(session.getEntries());
      expect(analysis.summary.hookDenials).toBe(0);
    });

    it('detects --no-verify block in error results', () => {
      const session = new SyntheticSession()
        .toolUse('Bash', { command: 'git commit --no-verify -m "hack"' })
        .toolError(
          'BLOCKED: --no-verify is not allowed',
        );
      const analysis = analyzeTranscript(session.getEntries());
      expect(analysis.summary.hookDenials).toBeGreaterThanOrEqual(1);
    });
  });

  describe('retries', () => {
    it('detects sequential retries of same command', () => {
      const session = sessionWithFailures();
      const analysis = analyzeTranscript(session.getEntries());

      expect(analysis.summary.retries).toBeGreaterThanOrEqual(1);
      expect(analysis.signals.some((s) => s.type === 'retry')).toBe(true);
    });
  });

  describe('repeated requests', () => {
    it('detects user referencing previous request', () => {
      const session = sessionWithRepeatedRequests();
      const analysis = analyzeTranscript(session.getEntries());

      // The "You didn't actually" message is a correction, not a repeated request
      // But if there were "I asked about that earlier" it would be
      expect(analysis.signals.length).toBeGreaterThan(0);
    });

    it('detects "I asked about that earlier" pattern', () => {
      const session = new SyntheticSession()
        .userMessage('Add logging')
        .assistantText('Done.')
        .userMessage('I already asked about error handling earlier');
      const analysis = analyzeTranscript(session.getEntries());
      expect(
        analysis.signals.some((s) => s.type === 'repeated_request'),
      ).toBe(true);
    });
  });

  describe('mixed signals', () => {
    it('detects multiple signal types in one session', () => {
      const session = sessionWithMixedSignals();
      const analysis = analyzeTranscript(session.getEntries());

      const signalTypes = new Set(analysis.signals.map((s) => s.type));
      // Should detect at least corrections and failures
      expect(signalTypes.size).toBeGreaterThanOrEqual(2);
      expect(analysis.signals.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('clean session', () => {
    it('produces no signals for a clean session', () => {
      const session = sessionClean();
      const analysis = analyzeTranscript(session.getEntries());

      expect(analysis.signals).toHaveLength(0);
      expect(analysis.summary.failedToolCalls).toBe(0);
      expect(analysis.summary.userCorrections).toBe(0);
      expect(analysis.summary.hookDenials).toBe(0);
    });
  });
});

describe('analyzeTranscriptFile', () => {
  it('reads and analyzes a file', () => {
    const session = sessionWithCorrections();
    const filePath = join(tmpDir, 'test-transcript.jsonl');
    session.writeToFile(filePath);

    const analysis = analyzeTranscriptFile(filePath);
    expect(analysis.summary.userCorrections).toBeGreaterThanOrEqual(1);
  });
});

describe('formatAnalysisSummary', () => {
  it('formats clean session', () => {
    const analysis = analyzeTranscript(sessionClean().getEntries());
    const summary = formatAnalysisSummary(analysis);
    expect(summary).toContain('No signals detected');
    expect(summary).toContain('clean session');
  });

  it('formats session with signals', () => {
    const analysis = analyzeTranscript(
      sessionWithMixedSignals().getEntries(),
    );
    const summary = formatAnalysisSummary(analysis);
    expect(summary).toContain('signals detected');
    expect(summary).toContain('Evidence:');
  });
});

describe('SyntheticSession', () => {
  it('generates valid JSONL', () => {
    const session = new SyntheticSession()
      .userMessage('Hello')
      .assistantText('Hi')
      .toolUse('Bash', { command: 'echo test' })
      .toolResult('test');

    const jsonl = session.toJsonl();
    const parsed = parseTranscript(jsonl);
    expect(parsed).toHaveLength(4);
  });

  it('writes to file and reads back', () => {
    const session = sessionWithCorrections();
    const filePath = join(tmpDir, 'roundtrip.jsonl');
    session.writeToFile(filePath);

    const entries = parseTranscript(
      require('node:fs').readFileSync(filePath, 'utf-8'),
    );
    expect(entries.length).toBeGreaterThan(0);
  });
});
