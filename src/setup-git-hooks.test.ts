/**
 * setup-git-hooks.test.ts — unit tests for host-project install (epic #1059).
 *
 * Covers all 5 framework branches: pre-commit (primary), husky, lefthook, raw, none.
 * Tests detection + injection + idempotency for each.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import YAML from 'yaml';
import {
  detectHostFramework,
  injectIntoHusky,
  injectIntoLefthook,
  injectIntoPreCommit,
  injectIntoRaw,
  installGitHooks,
  installStandalone,
  buildThinWrapper,
  KAIZEN_CHAIN_MARKER,
  KAIZEN_HOOK_ID,
  KAIZEN_ENTRY_PATH,
  writeEntryScript,
} from './setup-git-hooks.js';
import { AGENT_ENV_VARS } from './hooks/pre-push.js';

// ── Fixture helpers ───────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-setup-test-'));
  // Make it a git repo so git config works
  execSync('git init --quiet', { cwd: tmpDir });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const write = (relPath: string, content: string) => {
  const fullPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
};

const read = (relPath: string): string => fs.readFileSync(path.join(tmpDir, relPath), 'utf-8');

const exists = (relPath: string): boolean => fs.existsSync(path.join(tmpDir, relPath));

const stubEntryContent = '#!/usr/bin/env bash\necho kaizen-entry\n';

// ── detectHostFramework ───────────────────────────────────────────────

describe('detectHostFramework', () => {
  it('detects pre-commit (PRIMARY) when .pre-commit-config.yaml exists', () => {
    write('.pre-commit-config.yaml', 'repos: []\n');
    const result = detectHostFramework(tmpDir);
    expect(result.framework).toBe('pre-commit');
    expect(result.configPath).toBe('.pre-commit-config.yaml');
  });

  it('detects husky when .husky dir exists', () => {
    fs.mkdirSync(path.join(tmpDir, '.husky'));
    const result = detectHostFramework(tmpDir);
    expect(result.framework).toBe('husky');
  });

  it('detects lefthook when lefthook.yml exists', () => {
    write('lefthook.yml', 'pre-push:\n  commands: {}\n');
    const result = detectHostFramework(tmpDir);
    expect(result.framework).toBe('lefthook');
  });

  it('detects raw when .git/hooks/pre-push exists (and no framework)', () => {
    fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });
    write('.git/hooks/pre-push', '#!/bin/sh\necho existing\n');
    const result = detectHostFramework(tmpDir);
    expect(result.framework).toBe('raw');
  });

  it('returns none when nothing detected', () => {
    const result = detectHostFramework(tmpDir);
    expect(result.framework).toBe('none');
  });

  it('pre-commit wins over husky when both present (priority order)', () => {
    write('.pre-commit-config.yaml', 'repos: []\n');
    fs.mkdirSync(path.join(tmpDir, '.husky'));
    const result = detectHostFramework(tmpDir);
    expect(result.framework).toBe('pre-commit');
  });
});

// ── writeEntryScript ──────────────────────────────────────────────────

describe('writeEntryScript', () => {
  it('creates .kaizen-hooks/pre-push with content and executable bit', () => {
    writeEntryScript(tmpDir, stubEntryContent);
    expect(exists('.kaizen-hooks/pre-push')).toBe(true);
    expect(read('.kaizen-hooks/pre-push')).toBe(stubEntryContent);
    const mode = fs.statSync(path.join(tmpDir, '.kaizen-hooks/pre-push')).mode & 0o777;
    expect(mode & 0o100).toBe(0o100); // user-executable
  });

  it('creates the directory if absent', () => {
    writeEntryScript(tmpDir, 'x');
    expect(fs.statSync(path.join(tmpDir, '.kaizen-hooks')).isDirectory()).toBe(true);
  });
});

// ── buildThinWrapper (#1086) ──────────────────────────────────────────

describe('buildThinWrapper — host pre-push is a wrapper, not a copy', () => {
  const PLUGIN_ROOT = '/home/me/.claude/plugins/cache/kaizen';

  it('bakes the plugin root in as the secondary fallback', () => {
    const w = buildThinWrapper(PLUGIN_ROOT);
    // env var first, then the baked-in install path.
    expect(w).toContain('KAIZEN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"');
    expect(w).toContain(`KAIZEN_ROOT="${PLUGIN_ROOT}"`);
  });

  it('execs the plugin-resident canonical entry (does not inline its logic)', () => {
    const w = buildThinWrapper(PLUGIN_ROOT);
    expect(w).toContain('ENTRY="$KAIZEN_ROOT/src/hooks/kaizen-host-entry.sh"');
    expect(w).toContain('exec bash "$ENTRY" "$@"');
  });

  it('exports CLAUDE_PLUGIN_ROOT so the entry re-resolves to the same plugin', () => {
    const w = buildThinWrapper(PLUGIN_ROOT);
    expect(w).toContain('export CLAUDE_PLUGIN_ROOT="$KAIZEN_ROOT"');
  });

  it('has the full env -> baked-in -> cache -> fail-open resolution chain', () => {
    const w = buildThinWrapper(PLUGIN_ROOT);
    expect(w).toContain('.claude/plugins/cache'); // cache search
    expect(w).toContain('plugin.json');
    // Fail-open guards: never block a push if kaizen / entry can't be located.
    expect(w).toContain('[ -d "$KAIZEN_ROOT" ] || exit 0');
    expect(w).toContain('[ -f "$ENTRY" ] || exit 0');
  });

  it('is THIN — carries none of the version-sensitive dispatch logic', () => {
    const w = buildThinWrapper(PLUGIN_ROOT);
    // These live only in kaizen-host-entry.sh / pre-push.ts. If they leak into
    // the wrapper, the host has copied logic that goes stale again (#1086).
    expect(w).not.toContain('pre-push.ts');
    expect(w).not.toContain('tsx');
    expect(w).not.toContain('npx');
    // A wrapper, not a 66-line snapshot.
    expect(w.split('\n').length).toBeLessThan(40);
  });

  it('adds NO new copy of the agent-env var list (single-source via entry)', () => {
    // agent-env-agreement.test.ts pins the var list across pre-push.ts and the
    // two shell wrappers. The thin wrapper must not introduce a third copy —
    // the entry it execs already gates. Assert none of the canonical vars are
    // gated inside the wrapper.
    const w = buildThinWrapper(PLUGIN_ROOT);
    for (const v of AGENT_ENV_VARS) {
      expect(w).not.toContain(`-z "${'$'}{${v}:-}"`);
    }
  });

  it('starts with a bash shebang and set -eu', () => {
    const w = buildThinWrapper(PLUGIN_ROOT);
    expect(w.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(w).toContain('set -eu');
  });
});

// ── injectIntoPreCommit (PRIMARY) ─────────────────────────────────────

describe('injectIntoPreCommit — PRIMARY host framework', () => {
  beforeEach(() => {
    write('.pre-commit-config.yaml', 'repos:\n  - repo: https://github.com/foo/bar\n    rev: v1\n    hooks:\n      - id: foo\n');
  });

  it('adds local repo + kaizen hook entry', () => {
    const result = injectIntoPreCommit(tmpDir);
    expect(result.action).toBe('installed');
    expect(result.framework).toBe('pre-commit');

    const parsed = YAML.parse(read('.pre-commit-config.yaml'));
    const localRepo = parsed.repos.find((r: { repo: string }) => r.repo === 'local');
    expect(localRepo).toBeDefined();
    expect(localRepo.hooks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: KAIZEN_HOOK_ID,
          language: 'script',
          stages: ['pre-push'],
          entry: KAIZEN_ENTRY_PATH,
          always_run: true,
          pass_filenames: false,
        }),
      ]),
    );
  });

  it('preserves existing repos entries', () => {
    injectIntoPreCommit(tmpDir);
    const parsed = YAML.parse(read('.pre-commit-config.yaml'));
    expect(parsed.repos.find((r: { repo: string }) => r.repo === 'https://github.com/foo/bar')).toBeDefined();
  });

  it('returns post-install command: pre-commit install --hook-type pre-push', () => {
    const result = injectIntoPreCommit(tmpDir);
    expect(result.postInstallCommands).toEqual(['pre-commit install --hook-type pre-push']);
  });

  it('idempotent — second call detects existing hook id', () => {
    injectIntoPreCommit(tmpDir);
    const result2 = injectIntoPreCommit(tmpDir);
    expect(result2.action).toBe('already_installed');
    expect(result2.filesModified).toEqual([]);
  });

  it('idempotent — YAML not duplicated after 3 calls', () => {
    injectIntoPreCommit(tmpDir);
    injectIntoPreCommit(tmpDir);
    injectIntoPreCommit(tmpDir);
    const parsed = YAML.parse(read('.pre-commit-config.yaml'));
    const localRepo = parsed.repos.find((r: { repo: string }) => r.repo === 'local');
    const kaizenHooks = localRepo.hooks.filter((h: { id: string }) => h.id === KAIZEN_HOOK_ID);
    expect(kaizenHooks).toHaveLength(1);
  });

  it('creates local repo when absent', () => {
    write('.pre-commit-config.yaml', 'repos: []\n');
    injectIntoPreCommit(tmpDir);
    const parsed = YAML.parse(read('.pre-commit-config.yaml'));
    expect(parsed.repos.find((r: { repo: string }) => r.repo === 'local')).toBeDefined();
  });

  it('handles reuse of existing local repo', () => {
    write('.pre-commit-config.yaml', `repos:
  - repo: local
    hooks:
      - id: existing-local-hook
        name: Existing
        entry: echo hello
        language: system
`);
    injectIntoPreCommit(tmpDir);
    const parsed = YAML.parse(read('.pre-commit-config.yaml'));
    const localRepos = parsed.repos.filter((r: { repo: string }) => r.repo === 'local');
    expect(localRepos).toHaveLength(1);
    expect(localRepos[0].hooks.map((h: { id: string }) => h.id)).toEqual(
      expect.arrayContaining(['existing-local-hook', KAIZEN_HOOK_ID]),
    );
  });
});

// ── injectIntoHusky ───────────────────────────────────────────────────

describe('injectIntoHusky', () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(tmpDir, '.husky'));
  });

  it('creates .husky/pre-push with chain when none exists', () => {
    const result = injectIntoHusky(tmpDir);
    expect(result.action).toBe('installed');
    const content = read('.husky/pre-push');
    expect(content).toContain(KAIZEN_CHAIN_MARKER);
    expect(content).toContain(KAIZEN_ENTRY_PATH);
  });

  it('appends to existing .husky/pre-push', () => {
    write('.husky/pre-push', '#!/usr/bin/env bash\necho pre-existing\n');
    const result = injectIntoHusky(tmpDir);
    expect(result.action).toBe('updated');
    const content = read('.husky/pre-push');
    expect(content).toContain('pre-existing');
    expect(content).toContain(KAIZEN_CHAIN_MARKER);
  });

  it('idempotent — second call detects existing marker', () => {
    injectIntoHusky(tmpDir);
    const result2 = injectIntoHusky(tmpDir);
    expect(result2.action).toBe('already_installed');
  });

  it('sets executable bit on .husky/pre-push', () => {
    injectIntoHusky(tmpDir);
    const mode = fs.statSync(path.join(tmpDir, '.husky/pre-push')).mode & 0o777;
    expect(mode & 0o100).toBe(0o100);
  });
});

// ── injectIntoLefthook ────────────────────────────────────────────────

describe('injectIntoLefthook', () => {
  beforeEach(() => {
    write('lefthook.yml', 'pre-push:\n  commands:\n    existing:\n      run: echo hi\n');
  });

  it('adds pre-push.commands.kaizen-pre-push entry', () => {
    const result = injectIntoLefthook(tmpDir);
    expect(result.action).toBe('installed');
    const parsed = YAML.parse(read('lefthook.yml'));
    expect(parsed['pre-push'].commands[KAIZEN_HOOK_ID].run).toBe(`./${KAIZEN_ENTRY_PATH}`);
  });

  it('preserves existing commands', () => {
    injectIntoLefthook(tmpDir);
    const parsed = YAML.parse(read('lefthook.yml'));
    expect(parsed['pre-push'].commands.existing).toBeDefined();
  });

  it('idempotent', () => {
    injectIntoLefthook(tmpDir);
    const result2 = injectIntoLefthook(tmpDir);
    expect(result2.action).toBe('already_installed');
  });

  it('creates pre-push section when absent', () => {
    write('lefthook.yml', '# empty\n');
    injectIntoLefthook(tmpDir);
    const parsed = YAML.parse(read('lefthook.yml'));
    expect(parsed['pre-push'].commands[KAIZEN_HOOK_ID]).toBeDefined();
  });
});

// ── injectIntoRaw ─────────────────────────────────────────────────────

describe('injectIntoRaw', () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });
  });

  it('appends chain block to existing raw hook', () => {
    write('.git/hooks/pre-push', '#!/bin/sh\necho original\nexit 0\n');
    const result = injectIntoRaw(tmpDir);
    expect(result.action).toBe('updated');
    const content = read('.git/hooks/pre-push');
    expect(content).toContain('echo original');
    expect(content).toContain(KAIZEN_CHAIN_MARKER);
  });

  it('idempotent', () => {
    write('.git/hooks/pre-push', '#!/bin/sh\n');
    injectIntoRaw(tmpDir);
    const result2 = injectIntoRaw(tmpDir);
    expect(result2.action).toBe('already_installed');
  });
});

// ── installStandalone (none case) ─────────────────────────────────────

describe('installStandalone — no framework detected', () => {
  it('creates .githooks/pre-push and sets core.hooksPath', () => {
    const result = installStandalone(tmpDir);
    expect(result.action).toBe('installed');
    expect(exists('.githooks/pre-push')).toBe(true);
    const content = read('.githooks/pre-push');
    expect(content).toContain(KAIZEN_CHAIN_MARKER);

    // Verify core.hooksPath
    const configured = execSync('git config --get core.hooksPath', { cwd: tmpDir, encoding: 'utf-8' }).trim();
    expect(configured).toBe('.githooks');
  });

  it('idempotent', () => {
    installStandalone(tmpDir);
    const result2 = installStandalone(tmpDir);
    expect(result2.action).toBe('already_installed');
  });

  it('sets executable bit', () => {
    installStandalone(tmpDir);
    const mode = fs.statSync(path.join(tmpDir, '.githooks/pre-push')).mode & 0o777;
    expect(mode & 0o100).toBe(0o100);
  });
});

// ── installGitHooks (end-to-end orchestration) ────────────────────────

describe('installGitHooks — end-to-end', () => {
  it('pre-commit path: writes entry script + injects + returns pre-commit install command', () => {
    write('.pre-commit-config.yaml', 'repos: []\n');
    const result = installGitHooks({ cwd: tmpDir, entryScriptContent: stubEntryContent });
    expect(result.framework).toBe('pre-commit');
    expect(exists('.kaizen-hooks/pre-push')).toBe(true);
    expect(result.postInstallCommands).toContain('pre-commit install --hook-type pre-push');
  });

  it('husky path', () => {
    fs.mkdirSync(path.join(tmpDir, '.husky'));
    const result = installGitHooks({ cwd: tmpDir, entryScriptContent: stubEntryContent });
    expect(result.framework).toBe('husky');
    expect(exists('.kaizen-hooks/pre-push')).toBe(true);
    expect(exists('.husky/pre-push')).toBe(true);
  });

  it('none path → standalone', () => {
    const result = installGitHooks({ cwd: tmpDir, entryScriptContent: stubEntryContent });
    expect(result.framework).toBe('none');
    expect(exists('.githooks/pre-push')).toBe(true);
  });

  it('idempotent end-to-end: two runs produce same state', () => {
    write('.pre-commit-config.yaml', 'repos: []\n');
    installGitHooks({ cwd: tmpDir, entryScriptContent: stubEntryContent });
    const firstConfig = read('.pre-commit-config.yaml');
    const firstEntry = read('.kaizen-hooks/pre-push');

    const result2 = installGitHooks({ cwd: tmpDir, entryScriptContent: stubEntryContent });
    expect(result2.action).toBe('already_installed');
    expect(read('.pre-commit-config.yaml')).toBe(firstConfig);
    expect(read('.kaizen-hooks/pre-push')).toBe(firstEntry);
  });

  it('install with the thin wrapper writes a wrapper, not a copy of entry logic (#1086)', () => {
    write('.pre-commit-config.yaml', 'repos: []\n');
    const wrapper = buildThinWrapper('/plugins/cache/kaizen');
    installGitHooks({ cwd: tmpDir, entryScriptContent: wrapper });
    const installed = read('.kaizen-hooks/pre-push');
    expect(installed).toContain('exec bash "$ENTRY" "$@"');
    expect(installed).not.toContain('pre-push.ts');
  });

  it('migration: re-install overwrites a stale 66-line copy with the thin wrapper (#1086)', () => {
    write('.pre-commit-config.yaml', 'repos: []\n');
    // Simulate a host that previously installed the old full COPY of the entry.
    const stale = '#!/usr/bin/env bash\n# stale copy\n' +
      'HOOK_TS="$KAIZEN_ROOT/src/hooks/pre-push.ts"\n' +
      'exec npx --no-install tsx "$HOOK_TS" "$@"\n';
    writeEntryScript(tmpDir, stale);
    expect(read('.kaizen-hooks/pre-push')).toContain('pre-push.ts');

    // Next /kaizen-setup run installs the thin wrapper.
    const wrapper = buildThinWrapper('/plugins/cache/kaizen');
    installGitHooks({ cwd: tmpDir, entryScriptContent: wrapper });

    const migrated = read('.kaizen-hooks/pre-push');
    expect(migrated).toContain('exec bash "$ENTRY" "$@"');
    expect(migrated).not.toContain('pre-push.ts'); // stale dispatch logic gone
  });
});
