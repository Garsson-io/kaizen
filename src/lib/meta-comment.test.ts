import { describe, expect, it } from 'vitest';
import { parseJsonMetaComment } from './meta-comment.js';

describe('parseJsonMetaComment', () => {
  it('parses nested JSON from a meta HTML comment', () => {
    expect(parseJsonMetaComment('<!-- meta:{"round":2,"counts":{"done":1}} -->\nBody')).toEqual({
      round: 2,
      counts: { done: 1 },
    });
  });

  it('allows CRLF and spacing around the meta payload', () => {
    expect(parseJsonMetaComment('<!-- meta:  {"verdict":"pass"}  -->\r\n## Review')).toEqual({
      verdict: 'pass',
    });
  });

  it('returns null when the first meta comment is malformed', () => {
    expect(parseJsonMetaComment('<!-- meta:not-json -->')).toBeNull();
  });
});
