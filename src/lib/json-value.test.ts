import { describe, expect, it } from 'vitest';
import { parseJsonArray, parseJsonObject, parseJsonValue } from './json-value.js';

describe('parseJsonValue', () => {
  it('returns parsed JSON values', () => {
    expect(parseJsonValue('{"ok":true}')).toEqual({ ok: true });
    expect(parseJsonValue('[1,2]')).toEqual([1, 2]);
    expect(parseJsonValue('"text"')).toBe('text');
  });

  it('returns null for blank or malformed JSON', () => {
    expect(parseJsonValue('')).toBeNull();
    expect(parseJsonValue('  ')).toBeNull();
    expect(parseJsonValue('{not json')).toBeNull();
  });
});

describe('parseJsonArray', () => {
  it('returns arrays and rejects non-arrays', () => {
    expect(parseJsonArray('[{"url":"u"}]')).toEqual([{ url: 'u' }]);
    expect(parseJsonArray('{"url":"u"}')).toEqual([]);
    expect(parseJsonArray('{not json')).toEqual([]);
  });
});

describe('parseJsonObject', () => {
  it('returns plain JSON objects and rejects arrays/primitives', () => {
    expect(parseJsonObject('{"state":"OPEN"}')).toEqual({ state: 'OPEN' });
    expect(parseJsonObject('[{"state":"OPEN"}]')).toBeNull();
    expect(parseJsonObject('"OPEN"')).toBeNull();
    expect(parseJsonObject('{not json')).toBeNull();
  });
});
