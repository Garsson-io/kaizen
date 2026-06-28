import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildTypeScriptSubprocess,
  findAncestorFile,
  findBunExecutable,
  findExecutableOnPath,
} from './test-typescript-runner.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kz-ts-runner-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('test TypeScript subprocess runner', () => {
  it('finds executable files on PATH', () => {
    const root = makeTempDir();
    const binDir = join(root, 'bin');
    mkdirSync(binDir);
    const bun = join(binDir, 'bun');
    writeFileSync(bun, '#!/usr/bin/env sh\n');
    chmodSync(bun, 0o755);

    expect(findExecutableOnPath('bun', binDir)).toBe(bun);
  });

  it('finds ancestor files from nested worktrees', () => {
    const root = makeTempDir();
    const nested = join(root, 'a', 'b', 'c');
    const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(root, 'node_modules', 'tsx', 'dist'), { recursive: true });
    writeFileSync(tsx, '');

    expect(findAncestorFile(nested, 'node_modules/tsx/dist/cli.mjs')).toBe(tsx);
  });

  it('prefers Bun when available', () => {
    const root = makeTempDir();
    const binDir = join(root, 'bin');
    mkdirSync(binDir);
    const bun = join(binDir, 'bun');
    writeFileSync(bun, '#!/usr/bin/env sh\n');
    chmodSync(bun, 0o755);

    expect(
      buildTypeScriptSubprocess('/repo/script.ts', {
        env: { PATH: binDir },
        startDir: root,
      }),
    ).toEqual({
      command: bun,
      args: ['/repo/script.ts'],
      runtime: 'bun',
    });
  });

  it('finds Bun from HOME when PATH has not been refreshed', () => {
    const root = makeTempDir();
    const bunDir = join(root, '.bun', 'bin');
    mkdirSync(bunDir, { recursive: true });
    const bun = join(bunDir, 'bun');
    writeFileSync(bun, '#!/usr/bin/env sh\n');
    chmodSync(bun, 0o755);

    expect(findBunExecutable({ PATH: '', HOME: root })).toBe(bun);
  });

  it('falls back to Node plus repo-local tsx when Bun is unavailable', () => {
    const root = makeTempDir();
    const nested = join(root, 'scripts');
    const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(root, 'node_modules', 'tsx', 'dist'), { recursive: true });
    writeFileSync(tsx, '');

    expect(
      buildTypeScriptSubprocess('/repo/script.ts', {
        env: { PATH: '' },
        startDir: nested,
      }),
    ).toEqual({
      command: process.execPath,
      args: [tsx, '/repo/script.ts'],
      runtime: 'tsx',
    });
  });
});
