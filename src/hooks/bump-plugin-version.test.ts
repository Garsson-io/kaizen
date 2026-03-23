import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const mockGit = (mainVersion: string) => (args: string) => {
  if (args.includes('rev-parse --show-toplevel')) return TEST_DIR;
  if (args.includes('show origin/main:.claude-plugin/plugin.json')) {
    return JSON.stringify({ version: mainVersion });
  }
  return '';
};

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
