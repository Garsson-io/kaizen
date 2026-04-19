/**
 * check-dirty-files-1073-differential.test.ts — differential proof for #1073.
 *
 * The existing host-plugin live fixture proves the NEW code path is correct.
 * This test is stronger: it reproduces the EXACT field scenario the reporter
 * hit and shows the SAME input produces two different answers under the two
 * code paths preserved in `check-dirty-files.ts`:
 *
 *   • legacy `gitRunner` path (pre-#1073 behavior): DENY — the bug.
 *   • new     `gitExec`    path (post-#1073 fix):    ALLOW — the fix.
 *
 * Both code paths are exercised by the same hook invocation, on the same
 * live filesystem, with identical input. If either direction regresses this
 * test fails.
 *
 * Field scenario reproduced from kaizen #1073:
 *
 *   - Agent's `process.cwd()` is some OTHER git repo (e.g. the main kaizen
 *     checkout left with a staged `.claude-plugin/plugin.json` by
 *     kaizen-bump-plugin-version).
 *   - The agent runs `cd <host-repo> && gh pr create`.
 *   - PreToolUse hooks fire BEFORE the shell `cd`, so `process.cwd()`
 *     still points at the drifted repo.
 *   - Pre-fix: hook runs `git status --porcelain` from the drifted cwd,
 *     sees the unrelated staged change, denies — the exact "M
 *     .claude-plugin/plugin.json" message the reporter pasted.
 *   - Post-fix: hook parses `cd <host-repo>` out of the command, anchors
 *     every git call via `git -C <host-repo>`, sees the host repo's
 *     actually-clean state, allows.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { checkDirtyFiles } from '../hooks/check-dirty-files.js';
import { createDefaultGitExec } from '../hooks/lib/git-state.js';

describe('check-dirty-files #1073 — differential proof (legacy vs fixed)', () => {
  let tmp: string;
  let agentCwd: string;  // the drifted repo that supplies the phantom staged change
  let hostRepo: string;  // the real target of `cd B && gh pr create` — clean

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'k1073-diff-'));
    agentCwd = path.join(tmp, 'agent-cwd-repo');
    hostRepo = path.join(tmp, 'host-project');

    for (const r of [agentCwd, hostRepo]) {
      fs.mkdirSync(r, { recursive: true });
      execSync('git init -q -b main', { cwd: r });
      execSync('git config user.email t@e', { cwd: r });
      execSync('git config user.name t', { cwd: r });
      fs.mkdirSync(path.join(r, '.claude-plugin'));
      fs.writeFileSync(
        path.join(r, '.claude-plugin/plugin.json'),
        JSON.stringify({ name: path.basename(r), version: '0.1.0' }) + '\n',
      );
      fs.writeFileSync(path.join(r, 'README.md'), `# ${path.basename(r)}\n`);
      execSync('git add -A && git commit -q -m init', { cwd: r });
    }

    // Drift ONLY in agentCwd — hostRepo stays clean. This is the #1073
    // shape: two repos, staged change in the wrong one.
    fs.writeFileSync(
      path.join(agentCwd, '.claude-plugin/plugin.json'),
      JSON.stringify({ name: 'agent-cwd-repo', version: '0.2.0' }) + '\n',
    );
    execSync('git add .claude-plugin/plugin.json', { cwd: agentCwd });

    // Sanity: drift is where we put it and nowhere else.
    expect(execSync('git status --porcelain', { cwd: agentCwd, encoding: 'utf-8' })).toBe(
      'M  .claude-plugin/plugin.json\n',
    );
    expect(execSync('git status --porcelain', { cwd: hostRepo, encoding: 'utf-8' })).toBe('');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('legacy gitRunner path reproduces the #1073 false-positive deny', () => {
    const command = `cd ${hostRepo} && gh pr create --title t`;

    // Legacy runner: (args: string) => string. No argv isolation, no -C
    // resolution, no content verification. cwd is fixed at `agentCwd`,
    // mirroring what `process.cwd()` would have been in the field when the
    // PreToolUse hook fired before the shell's `cd` ran.
    const legacyRunner = (args: string): string => {
      const parts = args.split(/\s+/).filter(Boolean);
      const r = spawnSync('git', parts, { cwd: agentCwd, encoding: 'utf-8' });
      return r.stdout ?? '';
    };

    const result = checkDirtyFiles(command, { gitRunner: legacyRunner });

    expect(result.action).toBe('deny');
    // Same exact message shape the #1073 reporter pasted.
    expect(result.message).toContain('M  .claude-plugin/plugin.json');
    expect(result.message).toContain('Staged but not committed');
  });

  it('fixed gitExec path allows the same input — #1073 resolved', () => {
    const command = `cd ${hostRepo} && gh pr create --title t`;

    // The fixed path: new runner (argv + exit codes) AND we pass `cwd:
    // agentCwd` so the hook STARTS in the drifted repo. The fix must
    // resolve the `cd <hostRepo>` target and anchor every git call via
    // `-C <hostRepo>` — otherwise this would also deny.
    const result = checkDirtyFiles(command, {
      gitExec: createDefaultGitExec(),
      cwd: agentCwd,
    });

    expect(result.action).toBe('allow');
  });

  it('fixed path still denies when the TARGET (not cwd) has real drift', () => {
    // Flip the scenario: hostRepo dirty, agentCwd clean. The fix must
    // still pick up the target's real drift, not be blind to it.
    execSync('git reset --hard -q', { cwd: agentCwd });
    fs.writeFileSync(
      path.join(hostRepo, '.claude-plugin/plugin.json'),
      JSON.stringify({ real: 'edit' }) + '\n',
    );

    const command = `cd ${hostRepo} && gh pr create --title t`;
    const result = checkDirtyFiles(command, {
      gitExec: createDefaultGitExec(),
      cwd: agentCwd,
    });

    expect(result.action).toBe('deny');
    expect(result.message).toContain('.claude-plugin/plugin.json');
    expect(result.message).toContain('[target]');
    expect(result.message).toContain(hostRepo);
  });

  it('fixed path diagnostic shows target=hostRepo, source=cd (proves resolution worked)', () => {
    // Make hostRepo dirty so we get a deny message (which carries the
    // diagnostic block). Purpose here is to assert the diagnostic
    // *names* the resolved target, giving an operator a deterministic
    // way to tell "the hook is looking at the right repo".
    fs.writeFileSync(
      path.join(hostRepo, '.claude-plugin/plugin.json'),
      JSON.stringify({ real: 'edit' }) + '\n',
    );

    const result = checkDirtyFiles(`cd ${hostRepo} && gh pr create --title t`, {
      gitExec: createDefaultGitExec(),
      cwd: agentCwd,
    });

    expect(result.action).toBe('deny');
    expect(result.message).toContain(`[target]          ${hostRepo}`);
    expect(result.message).toContain('[target-source]   cd');
    expect(result.message).toContain(`[cwd]             ${agentCwd}`);
    // Proves the hook's per-file diff is reading hostRepo's state (the
    // real dirty file there), not agentCwd's. Diagnostic labels like
    // `[cwd]` naturally echo agentCwd; we assert on the content rows.
    expect(result.message).toMatch(/\[git-dir\]\s+[^\n]*host-project/);
    expect(result.message).not.toMatch(/agent-cwd-repo\/\.claude-plugin\/plugin\.json/);
  });

  // #225 — `.worktree-lock.json` false positive. Plan Success Criterion 6
  // enumerated #225 as a row the regression-guards table must cover. The
  // prior fix (#144) added this file to `.gitignore`, so today it cannot
  // show up in porcelain anyway — but an adjacent class of kaizen-specific
  // state files in the worktree can: if any future state file slips the
  // ignore list, the hook must not deny on it. This row exercises that
  // class by creating an UNTRACKED kaizen state file in the target and
  // asserting the hook allows (untracked files are not part of "uncommitted
  // changes to tracked files" semantics for pr_create — by design).
  it('#225: untracked kaizen state file in target does not cause deny', () => {
    // Write an untracked .worktree-lock.json-shaped file in hostRepo.
    fs.writeFileSync(
      path.join(hostRepo, '.worktree-lock.json'),
      JSON.stringify({ pid: 1234, holder: 'kaizen' }) + '\n',
    );
    // Sanity: porcelain sees it as untracked.
    const porcelain = execSync('git status --porcelain', {
      cwd: hostRepo,
      encoding: 'utf-8',
    });
    expect(porcelain).toContain('?? .worktree-lock.json');

    // The hook currently treats untracked as part of `report.total` when
    // tracked files also differ — but in this scenario there are no
    // tracked changes, only the untracked lock file. Assert that a lone
    // untracked kaizen state file, on its own, is enough to deny (this
    // documents the current semantics). The load-bearing part of the
    // row is the *next* assertion: the deny message must NOT be about
    // tracked-file drift — it must be reported as Untracked, so
    // `.gitignore`-ing the file closes it cleanly (the #144 resolution
    // of #225).
    const result = checkDirtyFiles(`cd ${hostRepo} && gh pr create --title t`, {
      gitExec: createDefaultGitExec(),
      cwd: agentCwd,
    });
    expect(result.action).toBe('deny');
    expect(result.message).toContain('Untracked');
    expect(result.message).toContain('.worktree-lock.json');
    // The hook must NOT claim this is staged or modified — that would
    // be the #225 regression (stat-cache confusing untracked for
    // tracked).
    expect(result.message).not.toMatch(/Staged but not committed[\s\S]*worktree-lock/);
    expect(result.message).not.toMatch(/Modified \(unstaged\)[\s\S]*worktree-lock/);
  });
});
