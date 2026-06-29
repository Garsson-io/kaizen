import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendBoundedJsonLine,
  appendJsonLine,
  parseJsonLines,
  parseJsonLinesWithMalformedRows,
} from './json-lines.js';
import { makeIgnoredTestDir } from './test-dirs.js';

describe('parseJsonLines', () => {
  it('parses valid JSON lines while skipping blanks and malformed rows', () => {
    const rows = parseJsonLines('{"a":1}\n\nnot-json\n{"b":2}\n');

    expect(rows).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('splits CRLF JSON lines', () => {
    const rows = parseJsonLines('{"a":1}\r\n{"b":2}\r\n');

    expect(rows).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('returns parsed rows and malformed raw rows when callers need diagnostics', () => {
    const result = parseJsonLinesWithMalformedRows('{"a":1}\r\n\r\nnot-json\r\n  {"b":2}  \r\n{bad');

    expect(result.rows).toEqual([{ a: 1 }, { b: 2 }]);
    expect(result.malformedRows).toEqual(['not-json', '{bad']);
    expect(result.malformed).toEqual([
      { lineNumber: 3, raw: 'not-json' },
      { lineNumber: 5, raw: '{bad' },
    ]);
  });
});

describe('appendJsonLine', () => {
  it('creates parent directories and appends one JSON value per line', () => {
    const dir = makeIgnoredTestDir('json-lines-append-a');
    const filePath = join(dir, 'nested', 'events.jsonl');

    try {
      appendJsonLine(filePath, { a: 1 });
      appendJsonLine(filePath, { b: 2 });

      const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toEqual({ a: 1 });
      expect(JSON.parse(lines[1])).toEqual({ b: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('appendBoundedJsonLine', () => {
  it('creates parent directories and appends one JSON value per line', () => {
    const dir = makeIgnoredTestDir('json-lines-bounded-a');
    const filePath = join(dir, 'nested', 'events.jsonl');

    try {
      appendBoundedJsonLine(filePath, { a: 1 }, { maxBytes: 1024, maxBackups: 3 });
      appendBoundedJsonLine(filePath, { b: 2 }, { maxBytes: 1024, maxBackups: 3 });

      const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toEqual({ a: 1 });
      expect(JSON.parse(lines[1])).toEqual({ b: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rotates before the write that would exceed the active file cap', () => {
    const dir = makeIgnoredTestDir('json-lines-bounded-b');
    const filePath = join(dir, 'events.jsonl');

    try {
      appendBoundedJsonLine(filePath, { value: 'first' }, { maxBytes: 20, maxBackups: 3 });
      appendBoundedJsonLine(filePath, { value: 'second' }, { maxBytes: 20, maxBackups: 3 });

      expect(readFileSync(`${filePath}.1`, 'utf-8')).toContain('first');
      expect(readFileSync(filePath, 'utf-8')).toContain('second');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps only the configured number of backup generations', () => {
    const dir = makeIgnoredTestDir('json-lines-bounded-c');
    const filePath = join(dir, 'events.jsonl');

    try {
      appendBoundedJsonLine(filePath, { value: 'one' }, { maxBytes: 1, maxBackups: 2 });
      appendBoundedJsonLine(filePath, { value: 'two' }, { maxBytes: 1, maxBackups: 2 });
      appendBoundedJsonLine(filePath, { value: 'three' }, { maxBytes: 1, maxBackups: 2 });
      appendBoundedJsonLine(filePath, { value: 'four' }, { maxBytes: 1, maxBackups: 2 });

      expect(readFileSync(filePath, 'utf-8')).toContain('four');
      expect(readFileSync(`${filePath}.1`, 'utf-8')).toContain('three');
      expect(readFileSync(`${filePath}.2`, 'utf-8')).toContain('two');
      expect(existsSync(`${filePath}.3`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deletes the previous active file when zero backups are configured', () => {
    const dir = makeIgnoredTestDir('json-lines-bounded-d');
    const filePath = join(dir, 'events.jsonl');

    try {
      appendBoundedJsonLine(filePath, { value: 'old' }, { maxBytes: 1, maxBackups: 0 });
      appendBoundedJsonLine(filePath, { value: 'new' }, { maxBytes: 1, maxBackups: 0 });

      expect(readFileSync(filePath, 'utf-8')).toContain('new');
      expect(readFileSync(filePath, 'utf-8')).not.toContain('old');
      expect(existsSync(`${filePath}.1`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fills the active file exactly to the cap, then rotates on the next append', () => {
    const dir = makeIgnoredTestDir('json-lines-bounded-e');
    const filePath = join(dir, 'events.jsonl');
    const line = `${JSON.stringify({ a: 1 })}\n`;

    try {
      appendBoundedJsonLine(filePath, { a: 1 }, { maxBytes: line.length * 2, maxBackups: 3 });
      appendBoundedJsonLine(filePath, { b: 2 }, { maxBytes: line.length * 2, maxBackups: 3 });
      appendBoundedJsonLine(filePath, { c: 3 }, { maxBytes: line.length * 2, maxBackups: 3 });

      expect(readFileSync(`${filePath}.1`, 'utf-8')).toBe(`${line}${JSON.stringify({ b: 2 })}\n`);
      expect(readFileSync(filePath, 'utf-8')).toBe(`${JSON.stringify({ c: 3 })}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
