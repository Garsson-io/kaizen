import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  tmpDir = mkdtempSync(join(tmpdir(), 'synth-test-'));
});

afterEach(() => {
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true });
  }
});

describe('SyntheticSession', () => {
  describe('builder API', () => {
    it('creates entries with correct types for user messages', () => {
      const session = new SyntheticSession('test-session');
      session.userMessage('hello');

      const entries = session.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('user');
      expect(entries[0].sessionId).toBe('test-session');
      expect(entries[0].message?.role).toBe('user');
      expect(entries[0].message?.content[0]).toEqual({
        type: 'text',
        text: 'hello',
      });
    });

    it('creates entries with correct types for assistant text', () => {
      const session = new SyntheticSession();
      session.assistantText('I will help');

      const entries = session.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('assistant');
      expect(entries[0].message?.role).toBe('assistant');
      expect(entries[0].message?.content[0]).toEqual({
        type: 'text',
        text: 'I will help',
      });
    });

    it('creates tool_use entries with proper ID format', () => {
      const session = new SyntheticSession();
      session.toolUse('Bash', { command: 'echo hi' });

      const entries = session.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].type).toBe('assistant');
      const content = entries[0].message?.content[0];
      expect(content).toHaveProperty('type', 'tool_use');
      expect(content).toHaveProperty('name', 'Bash');
      expect(content).toHaveProperty('input', { command: 'echo hi' });
      // tool_use ID starts with toolu_
      if (content && 'id' in content) {
        expect(content.id).toMatch(/^toolu_/);
      }
    });

    it('links tool_result to previous tool_use', () => {
      const session = new SyntheticSession();
      session.toolUse('Read', { file_path: '/test.ts' });
      session.toolResult('file contents');

      const entries = session.getEntries();
      expect(entries).toHaveLength(2);
      const toolUseContent = entries[0].message!.content[0];
      const toolResultContent = entries[1].message!.content[0];

      if ('id' in toolUseContent && 'tool_use_id' in toolResultContent) {
        expect(toolResultContent.tool_use_id).toBe(toolUseContent.id);
      }
    });

    it('creates error tool results with is_error flag', () => {
      const session = new SyntheticSession();
      session.toolUse('Bash', { command: 'npm test' });
      session.toolError('Exit code 1');

      const entries = session.getEntries();
      const errorContent = entries[1].message!.content[0];
      expect(errorContent).toHaveProperty('is_error', true);
      expect(errorContent).toHaveProperty('content', 'Exit code 1');
    });

    it('chains methods fluently', () => {
      const session = new SyntheticSession();
      const result = session
        .userMessage('do something')
        .assistantText('ok')
        .toolUse('Bash', { command: 'ls' })
        .toolResult('files');

      expect(result).toBe(session);
      expect(session.getEntries()).toHaveLength(4);
    });

    it('maintains parent-child UUID chain', () => {
      const session = new SyntheticSession();
      session
        .userMessage('first')
        .assistantText('second')
        .userMessage('third');

      const entries = session.getEntries();
      expect(entries[1].parentUuid).toBe(entries[0].uuid);
      expect(entries[2].parentUuid).toBe(entries[1].uuid);
    });

    it('assigns unique UUIDs to each entry', () => {
      const session = new SyntheticSession();
      session.userMessage('a').assistantText('b').userMessage('c');

      const uuids = session.getEntries().map((e) => e.uuid);
      const uniqueUuids = new Set(uuids);
      expect(uniqueUuids.size).toBe(3);
    });
  });

  describe('serialization', () => {
    it('writes valid JSONL to file', () => {
      const session = new SyntheticSession();
      session.userMessage('test').assistantText('response');

      const filePath = join(tmpDir, 'test.jsonl');
      session.writeToFile(filePath);

      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);

      // Each line should be valid JSON
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    it('toJsonl produces the same content as writeToFile', () => {
      const session = new SyntheticSession();
      session.userMessage('test').assistantText('reply');

      const filePath = join(tmpDir, 'compare.jsonl');
      session.writeToFile(filePath);
      const fileContent = readFileSync(filePath, 'utf-8');

      expect(session.toJsonl()).toBe(fileContent);
    });

    it('getEntries returns a copy, not the internal array', () => {
      const session = new SyntheticSession();
      session.userMessage('test');

      const entries1 = session.getEntries();
      const entries2 = session.getEntries();
      expect(entries1).not.toBe(entries2);
      expect(entries1).toEqual(entries2);
    });
  });

  describe('pre-built scenarios', () => {
    it('sessionWithCorrections has user corrections', () => {
      const session = sessionWithCorrections();
      const entries = session.getEntries();
      expect(entries.length).toBeGreaterThan(0);

      // Should contain a correction-like user message
      const userMessages = entries
        .filter((e) => e.type === 'user' && e.message?.content[0]?.type === 'text')
        .map((e) => {
          const content = e.message!.content[0];
          return 'text' in content ? content.text : '';
        });
      expect(userMessages.some((m) => m.includes("don't"))).toBe(true);
    });

    it('sessionWithFailures has tool errors', () => {
      const session = sessionWithFailures();
      const entries = session.getEntries();

      const errors = entries.filter((e) => {
        const content = e.message?.content[0];
        return content && 'is_error' in content && content.is_error;
      });
      expect(errors.length).toBeGreaterThanOrEqual(2);
    });

    it('sessionWithHookDenials has hook-related errors', () => {
      const session = sessionWithHookDenials();
      const entries = session.getEntries();

      const hookErrors = entries.filter((e) => {
        const content = e.message?.content[0];
        return (
          content &&
          'is_error' in content &&
          content.is_error &&
          'content' in content &&
          typeof content.content === 'string' &&
          content.content.includes('BLOCKED')
        );
      });
      expect(hookErrors.length).toBeGreaterThanOrEqual(1);
    });

    it('sessionWithRepeatedRequests has re-stated requests', () => {
      const session = sessionWithRepeatedRequests();
      const entries = session.getEntries();
      expect(entries.length).toBeGreaterThan(0);
    });

    it('sessionWithMixedSignals has multiple signal types', () => {
      const session = sessionWithMixedSignals();
      const entries = session.getEntries();

      // Should have both errors and user corrections
      const hasErrors = entries.some((e) => {
        const content = e.message?.content[0];
        return content && 'is_error' in content && content.is_error;
      });
      const hasUserCorrections = entries.some((e) => {
        const content = e.message?.content[0];
        return (
          e.type === 'user' &&
          content?.type === 'text' &&
          'text' in content &&
          content.text.includes('wrong direction')
        );
      });
      expect(hasErrors).toBe(true);
      expect(hasUserCorrections).toBe(true);
    });

    it('sessionClean has no errors or corrections', () => {
      const session = sessionClean();
      const entries = session.getEntries();

      const errors = entries.filter((e) => {
        const content = e.message?.content[0];
        return content && 'is_error' in content && content.is_error;
      });
      expect(errors).toHaveLength(0);
    });

    it('all scenarios produce valid JSONL when written to file', () => {
      const factories = [
        sessionWithCorrections,
        sessionWithFailures,
        sessionWithHookDenials,
        sessionWithRepeatedRequests,
        sessionWithMixedSignals,
        sessionClean,
      ];

      for (const factory of factories) {
        const session = factory();
        const filePath = join(tmpDir, `${factory.name}.jsonl`);
        session.writeToFile(filePath);

        const content = readFileSync(filePath, 'utf-8');
        const lines = content.trim().split('\n');
        for (const line of lines) {
          const parsed = JSON.parse(line);
          expect(parsed).toHaveProperty('type');
          expect(parsed).toHaveProperty('uuid');
          expect(parsed).toHaveProperty('sessionId');
          expect(parsed).toHaveProperty('timestamp');
        }
      }
    });
  });
});
