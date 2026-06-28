import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readJsonObjectFile, readJsonValueFile } from './json-file.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaizen-json-file-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readJsonValueFile', () => {
  it('returns arbitrary JSON values and null for unreadable or malformed input', () => {
    const objectPath = join(dir, 'object.json');
    const arrayPath = join(dir, 'array.json');
    const stringPath = join(dir, 'string.json');
    const malformedPath = join(dir, 'malformed.json');
    const blankPath = join(dir, 'blank.json');

    writeFileSync(objectPath, '{"ok":true}');
    writeFileSync(arrayPath, '[1,2]');
    writeFileSync(stringPath, '"text"');
    writeFileSync(malformedPath, '{not json');
    writeFileSync(blankPath, '  ');

    expect(readJsonValueFile(objectPath)).toEqual({ ok: true });
    expect(readJsonValueFile(arrayPath)).toEqual([1, 2]);
    expect(readJsonValueFile(stringPath)).toBe('text');
    expect(readJsonValueFile(malformedPath)).toBeNull();
    expect(readJsonValueFile(blankPath)).toBeNull();
    expect(readJsonValueFile(join(dir, 'missing.json'))).toBeNull();
  });
});

describe('readJsonObjectFile', () => {
  it('returns objects and rejects unreadable, malformed, blank, array, or primitive input', () => {
    const objectPath = join(dir, 'object.json');
    const arrayPath = join(dir, 'array.json');
    const primitivePath = join(dir, 'primitive.json');
    const malformedPath = join(dir, 'malformed.json');
    const blankPath = join(dir, 'blank.json');

    writeFileSync(objectPath, '{"ok":true}');
    writeFileSync(arrayPath, '[1,2]');
    writeFileSync(primitivePath, '"text"');
    writeFileSync(malformedPath, '{not json');
    writeFileSync(blankPath, '  ');

    expect(readJsonObjectFile(objectPath)).toEqual({ ok: true });
    expect(readJsonObjectFile(arrayPath)).toBeNull();
    expect(readJsonObjectFile(primitivePath)).toBeNull();
    expect(readJsonObjectFile(malformedPath)).toBeNull();
    expect(readJsonObjectFile(blankPath)).toBeNull();
    expect(readJsonObjectFile(join(dir, 'missing.json'))).toBeNull();
  });
});
