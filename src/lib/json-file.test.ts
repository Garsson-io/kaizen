import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readDurableJsonValueFile,
  readJsonObjectFile,
  readJsonValueFile,
  writeDurableJsonValueFile,
  writeJsonObjectFile,
  writeJsonValueFile,
} from './json-file.js';

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

describe('writeJsonValueFile', () => {
  it('writes pretty JSON with a trailing newline by default', () => {
    const path = join(dir, 'value.json');

    writeJsonValueFile(path, { ok: true });

    expect(readFileSync(path, 'utf-8')).toBe('{\n  "ok": true\n}\n');
    expect(readJsonValueFile(path)).toEqual({ ok: true });
  });

  it('can preserve existing no-trailing-newline output contracts', () => {
    const path = join(dir, 'array.json');

    writeJsonValueFile(path, ['x'], { trailingNewline: false });

    expect(readFileSync(path, 'utf-8')).toBe('[\n  "x"\n]');
    expect(readJsonValueFile(path)).toEqual(['x']);
  });
});

describe('writeJsonObjectFile', () => {
  it('writes object JSON through the shared value writer', () => {
    const path = join(dir, 'object-write.json');

    writeJsonObjectFile(path, { ok: true });

    expect(readJsonObjectFile(path)).toEqual({ ok: true });
  });
});

describe('durable JSON file contract', () => {
  it('writes through a temp file and can back up the previous primary', () => {
    const path = join(dir, 'state.json');

    writeDurableJsonValueFile(path, { run: 1 }, { backup: true });
    writeDurableJsonValueFile(path, { run: 2 }, { backup: true });

    expect(readJsonValueFile(path)).toEqual({ run: 2 });
    expect(readJsonValueFile(`${path}.bak`)).toEqual({ run: 1 });
    expect(readFileSync(path, 'utf-8')).toMatch(/\n$/);
    expect(readFileSync(`${path}.bak`, 'utf-8')).toMatch(/\n$/);
    expect(() => readFileSync(`${path}.tmp`, 'utf-8')).toThrow();
  });

  it('reads a backup when the primary is missing or malformed', () => {
    const path = join(dir, 'recoverable.json');
    writeJsonValueFile(`${path}.bak`, { from: 'backup' });

    expect(readDurableJsonValueFile(path, { backup: true })).toEqual({ from: 'backup' });

    writeFileSync(path, '{not json');
    expect(readDurableJsonValueFile(path, { backup: true })).toEqual({ from: 'backup' });
  });

  it('returns null when both durable primary and backup are unreadable', () => {
    const path = join(dir, 'unrecoverable.json');
    writeFileSync(path, '{not json');
    writeFileSync(`${path}.bak`, '{also bad');

    expect(readDurableJsonValueFile(path, { backup: true })).toBeNull();
  });
});
