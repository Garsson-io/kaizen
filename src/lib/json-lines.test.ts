import { describe, expect, it } from 'vitest';
import { parseJsonLines } from './json-lines.js';

describe('parseJsonLines', () => {
  it('parses valid JSON lines while skipping blanks and malformed rows', () => {
    const rows = parseJsonLines('{"a":1}\n\nnot-json\n{"b":2}\n');

    expect(rows).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('splits CRLF JSON lines', () => {
    const rows = parseJsonLines('{"a":1}\r\n{"b":2}\r\n');

    expect(rows).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
