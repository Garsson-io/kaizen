import { describe, expect, it } from 'vitest';
import { parseJsonLines, parseJsonLinesWithMalformedRows } from './json-lines.js';

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
