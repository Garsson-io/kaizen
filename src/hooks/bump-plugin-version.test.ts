import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bumpPluginVersion } from './bump-plugin-version.js';

const TEST_DIR = '/tmp/.test-bump-plugin';
const PLUGIN_DIR = join(TEST_DIR, '.claude-plugin');
const PLUGIN_JSON = join(PLUGIN_DIR, 'plugin.json');

function writePlugin(version: string) {
  mkdirSync(PLUGIN_DIR, { recursive: true });
  writeFileSync(PLUGIN_JSON, JSON.stringify({ name: 'test', version }, null, 2));
}

function trackingGit(mainVersion: string) {
  const calls: string[] = [];
  const runner = (args: string) => {
    calls.push(args);
    if (args.includes('rev-parse --show-toplevel')) return TEST_DIR;
    if (args.includes('show origin/main:.claude-plugin/plugin.json')) {
      return JSON.stringify({ version: mainVersion });
    }
    return '';
  };
  return { runner, calls };
}

const mockGit = (mainVersion: string) => trackingGit(mainVersion).runner;

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe('bumpPluginVersion', () => {
  it('returns null for non-pr-create commands', () => {
    writePlugin('1.0.0');
    expect(bumpPluginVersion('git push', { projectRoot: TEST_DIR })).toBeNull();
    expect(bumpPluginVersion('npm test', { projectRoot: TEST_DIR })).toBeNull();
  });

  it('bumps patch version when main and current match', () => {
    writePlugin('1.0.5');
    const result = bumpPluginVersion('gh pr create --title "test"', {
      gitRunner: mockGit('1.0.5'),
      projectRoot: TEST_DIR,
    });
    expect(result).toContain('1.0.5 -> 1.0.6');
    const updated = JSON.parse(readFileSync(PLUGIN_JSON, 'utf-8'));
    expect(updated.version).toBe('1.0.6');
  });

  it('skips when already bumped (different from main)', () => {
    writePlugin('1.1.0');
    const result = bumpPluginVersion('gh pr create --title "test"', {
      gitRunner: mockGit('1.0.5'),
      projectRoot: TEST_DIR,
    });
    expect(result).toBeNull();
  });

  it('returns null when plugin.json does not exist', () => {
    const result = bumpPluginVersion('gh pr create --title "test"', {
      projectRoot: TEST_DIR,
    });
    expect(result).toBeNull();
  });

  it('does not create temp files', () => {
    writePlugin('1.0.0');
    bumpPluginVersion('gh pr create --title "test"', {
      gitRunner: mockGit('1.0.0'),
      projectRoot: TEST_DIR,
    });
    expect(existsSync(join(PLUGIN_DIR, 'plugin.json.tmp'))).toBe(false);
  });
});

// #919, #921: INVARIANT — bump hook commits AND pushes so gh pr create doesn't fail
describe('INVARIANT: bump hook pushes after committing (#919)', () => {
  it('calls git push after git add + git commit', () => {
    writePlugin('1.0.5');
    const { runner, calls } = trackingGit('1.0.5');
    bumpPluginVersion('gh pr create --title "test"', {
      gitRunner: runner,
      projectRoot: TEST_DIR,
    });
    // Must have add → commit → push in order
    const addIdx = calls.findIndex(c => c.includes('add'));
    const commitIdx = calls.findIndex(c => c.includes('commit'));
    const pushIdx = calls.findIndex(c => c === 'push');
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeGreaterThan(addIdx);
    expect(pushIdx).toBeGreaterThan(commitIdx);
  });

  it('returns success even if push fails (fail-open)', () => {
    writePlugin('1.0.5');
    const { runner } = trackingGit('1.0.5');
    // Override to throw on push
    const failOnPush = (args: string) => {
      if (args.includes('push')) throw new Error('push failed');
      return runner(args);
    };
    const result = bumpPluginVersion('gh pr create --title "test"', {
      gitRunner: failOnPush,
      projectRoot: TEST_DIR,
    });
    // Should still succeed — push failure is non-blocking
    expect(result).toContain('1.0.5 -> 1.0.6');
  });
});

// #923: INVARIANT — no cross-module hook imports from non-hook files
describe('INVARIANT: architectural boundary — no hook entry point imports (#923)', () => {
  it('non-hook files must not import from src/hooks/ entry points', () => {
    const srcDir = join(__dirname, '..');

    const violations: string[] = [];
    // Negative lookahead: allow hooks/lib/ but block hooks/<anything-else>
    const importPattern = /from\s+['"].*\/hooks\/(?!lib\/)/;

    function scanDir(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (fullPath === join(srcDir, 'hooks')) continue;
          scanDir(fullPath);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          const content = readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (importPattern.test(lines[i])) {
              violations.push(`${fullPath}:${i + 1}: ${lines[i].trim()}`);
            }
          }
        }
      }
    }

    scanDir(srcDir);
    expect(violations).toEqual([]);
  });
});
