import { describe, expect, it } from 'vitest';
import {
  isAllowedRuntimeDir,
  isEscapeHatch,
  isKaizenCommand,
  isReadonlyMonitoringCommand,
  isReviewCommand,
} from './allowlist.js';

describe('isReadonlyMonitoringCommand', () => {
  it('allows gh api calls', () => {
    expect(isReadonlyMonitoringCommand('gh api repos/org/repo/pulls/1')).toBe(true);
  });

  it('allows gh run view/list/watch', () => {
    expect(isReadonlyMonitoringCommand('gh run view 12345')).toBe(true);
    expect(isReadonlyMonitoringCommand('gh run list --json status')).toBe(true);
    expect(isReadonlyMonitoringCommand('gh run watch 12345')).toBe(true);
  });

  it('allows git read-only commands', () => {
    expect(isReadonlyMonitoringCommand('git diff')).toBe(true);
    expect(isReadonlyMonitoringCommand('git log --oneline')).toBe(true);
    expect(isReadonlyMonitoringCommand('git show HEAD')).toBe(true);
    expect(isReadonlyMonitoringCommand('git status')).toBe(true);
    expect(isReadonlyMonitoringCommand('git branch')).toBe(true);
    expect(isReadonlyMonitoringCommand('git fetch origin')).toBe(true);
  });

  it('allows filesystem read commands', () => {
    expect(isReadonlyMonitoringCommand('ls -la')).toBe(true);
    expect(isReadonlyMonitoringCommand('cat README.md')).toBe(true);
    expect(isReadonlyMonitoringCommand('head -5 file.txt')).toBe(true);
    expect(isReadonlyMonitoringCommand('tail -f log.txt')).toBe(true);
    expect(isReadonlyMonitoringCommand('wc -l file.txt')).toBe(true);
  });

  it('allows diagnostic commands (kaizen #775)', () => {
    expect(isReadonlyMonitoringCommand('grep -r "pattern" src/')).toBe(true);
    expect(isReadonlyMonitoringCommand('rg "pattern" src/')).toBe(true);
    expect(isReadonlyMonitoringCommand('npm test')).toBe(true);
    expect(isReadonlyMonitoringCommand('npx vitest run')).toBe(true);
    expect(isReadonlyMonitoringCommand('npx tsc --noEmit')).toBe(true);
  });

  it('blocks write commands', () => {
    expect(isReadonlyMonitoringCommand('git push')).toBe(false);
    expect(isReadonlyMonitoringCommand('git commit -m "test"')).toBe(false);
    expect(isReadonlyMonitoringCommand('rm -rf node_modules')).toBe(false);
    expect(isReadonlyMonitoringCommand('npm install')).toBe(false);
  });

  it('blocks gh pr create/merge', () => {
    expect(isReadonlyMonitoringCommand('gh pr create --title "test"')).toBe(false);
    expect(isReadonlyMonitoringCommand('gh pr merge 42')).toBe(false);
  });

  it('splits on bare newlines like the canonical splitter (#1013)', () => {
    // A readonly command on its own line after env assignments must still be
    // recognized — same newline-split parity the gate detectors rely on.
    expect(
      isReadonlyMonitoringCommand('export PATH=/x\ngit status'),
    ).toBe(true);
    // And a pure write command on its own line stays blocked.
    expect(isReadonlyMonitoringCommand('export PATH=/x\ngit push')).toBe(false);
  });

  it('blocks mixed readonly and write compounds (#1344)', () => {
    expect(isReadonlyMonitoringCommand('gh pr merge 5 && git status')).toBe(false);
    expect(isReadonlyMonitoringCommand('git status; gh pr merge 5')).toBe(false);
    expect(isReadonlyMonitoringCommand('git status | gh pr merge 5')).toBe(false);
    expect(isReadonlyMonitoringCommand('git log\ngh pr merge 5')).toBe(false);
    expect(isReadonlyMonitoringCommand('git status && git push')).toBe(false);
    expect(isReadonlyMonitoringCommand('FOO=1 git push')).toBe(false);
    expect(isReadonlyMonitoringCommand('PATH=/x npm install')).toBe(false);
  });

  it('allows pure readonly compounds (#1344)', () => {
    expect(isReadonlyMonitoringCommand('git status && git log --oneline')).toBe(true);
    expect(isReadonlyMonitoringCommand('git status; gh run list --limit 5')).toBe(true);
    expect(isReadonlyMonitoringCommand('git status | grep main')).toBe(true);
    expect(isReadonlyMonitoringCommand('cd .\ngit status')).toBe(true);
  });

  // #1350: isGitCommand's alternation was unanchored, so a blocking command that
  // merely CONTAINS a readonly subcommand substring (branch/log/show/status/...)
  // was classified as a readonly git command and sailed through every gate.
  it('does not allow a blocking command that merely contains a git subcommand substring (#1350)', () => {
    expect(isReadonlyMonitoringCommand('rm -rf branch-backups')).toBe(false);
    expect(isReadonlyMonitoringCommand('git push origin show')).toBe(false);
    expect(isReadonlyMonitoringCommand('docker rm show')).toBe(false);
    expect(isReadonlyMonitoringCommand('make deploy-log')).toBe(false);
    // ...and the same blocking commands are rejected by the review/kaizen gates.
    expect(isReviewCommand('rm -rf branch-backups')).toBe(false);
    expect(isKaizenCommand('git push origin show')).toBe(false);
  });
});

describe('isReviewCommand', () => {
  it('allows gh pr diff/view/comment/edit', () => {
    expect(isReviewCommand('gh pr diff 42')).toBe(true);
    expect(isReviewCommand('gh pr view 42')).toBe(true);
    expect(isReviewCommand('gh pr comment 42 --body "LGTM"')).toBe(true);
    expect(isReviewCommand('gh pr edit 42 --title "new"')).toBe(true);
  });

  it('includes readonly monitoring', () => {
    expect(isReviewCommand('git diff')).toBe(true);
    expect(isReviewCommand('npm test')).toBe(true);
  });

  it('blocks non-review commands', () => {
    expect(isReviewCommand('gh pr create --title "test"')).toBe(false);
    expect(isReviewCommand('git push')).toBe(false);
  });

  // #1068: the stop-gate advertises KAIZEN_UNFINISHED as the way out of a
  // needs_review block. The review allowlist must honor it, or the documented
  // escape deadlocks.
  it('allows the universal KAIZEN_UNFINISHED escape (no deadlock — #1068)', () => {
    expect(isReviewCommand("echo 'KAIZEN_UNFINISHED: review blocked, deferring'")).toBe(true);
  });

  it('blocks mixed review-allowed and write compounds (#1344)', () => {
    expect(isReviewCommand('gh pr view 42 && git push')).toBe(false);
    expect(isReviewCommand('git push && gh pr diff 42')).toBe(false);
    expect(isReviewCommand('git status && gh pr view 42')).toBe(true);
  });
});

describe('isEscapeHatch', () => {
  it('recognizes KAIZEN_UNFINISHED declarations', () => {
    expect(isEscapeHatch("echo 'KAIZEN_UNFINISHED: session timeout'")).toBe(true);
    expect(isEscapeHatch('KAIZEN_UNFINISHED: bare form')).toBe(true);
  });

  it('recognizes KAIZEN_NO_ACTION declarations', () => {
    expect(isEscapeHatch("echo 'KAIZEN_NO_ACTION [docs-only]: readme'")).toBe(true);
  });

  it('recognizes KAIZEN_IMPEDIMENTS declarations', () => {
    expect(isEscapeHatch("echo 'KAIZEN_IMPEDIMENTS: []'")).toBe(true);
  });

  it('does not match ordinary commands', () => {
    expect(isEscapeHatch('git push')).toBe(false);
    expect(isEscapeHatch('echo hello')).toBe(false);
    expect(isEscapeHatch('npm install')).toBe(false);
  });

  it('does not allow blocked work beside an escape declaration (#1344)', () => {
    expect(isEscapeHatch("echo 'KAIZEN_UNFINISHED: later' && git push")).toBe(false);
  });
});

// Boundary invariant: the Stop gate (gate-manager.ts) advertises a single
// universal escape (`echo 'KAIZEN_UNFINISHED: <reason>'`). Every PreToolUse
// gate allowlist MUST accept it, or the harness deadlocks the author it just
// told to run the escape (#1068). This test ties advertised escape to allowlist
// reality so a future gate can't silently re-introduce the deadlock.
describe('escape-hatch invariant across gate allowlists', () => {
  const UNIVERSAL_ESCAPE = "echo 'KAIZEN_UNFINISHED: honest reason'";
  const gateAllowlists: Array<[string, (c: string) => boolean]> = [
    ['isReviewCommand', isReviewCommand],
    ['isKaizenCommand', isKaizenCommand],
  ];

  for (const [name, allow] of gateAllowlists) {
    it(`${name} accepts the universal stop-gate escape`, () => {
      expect(allow(UNIVERSAL_ESCAPE)).toBe(true);
    });
  }
});

describe('isKaizenCommand', () => {
  it('allows gh issue commands', () => {
    expect(isKaizenCommand('gh issue create --title "test"')).toBe(true);
    expect(isKaizenCommand('gh issue list')).toBe(true);
    expect(isKaizenCommand('gh issue search "kaizen"')).toBe(true);
    expect(isKaizenCommand('gh issue comment 42')).toBe(true);
    expect(isKaizenCommand('gh issue view 42')).toBe(true);
  });

  it('allows KAIZEN_IMPEDIMENTS declarations', () => {
    expect(isKaizenCommand('echo \'KAIZEN_IMPEDIMENTS: []\'')).toBe(true);
  });

  it('allows KAIZEN_NO_ACTION declarations', () => {
    expect(isKaizenCommand('echo \'KAIZEN_NO_ACTION [docs-only]: readme update\'')).toBe(true);
  });

  it('allows KAIZEN_UNFINISHED declarations (kaizen #775)', () => {
    expect(isKaizenCommand('echo \'KAIZEN_UNFINISHED: session timeout\'')).toBe(true);
  });

  it('allows gh pr commands including merge', () => {
    expect(isKaizenCommand('gh pr diff 42')).toBe(true);
    expect(isKaizenCommand('gh pr merge 42')).toBe(true);
    expect(isKaizenCommand('gh pr checks 42')).toBe(true);
  });

  it('includes readonly monitoring', () => {
    expect(isKaizenCommand('git log --oneline')).toBe(true);
    expect(isKaizenCommand('npm test')).toBe(true);
  });

  it('blocks non-kaizen commands', () => {
    expect(isKaizenCommand('npm install lodash')).toBe(false);
    expect(isKaizenCommand('git push')).toBe(false);
  });

  it('prevents bypass via compound commands (#1344)', () => {
    expect(isKaizenCommand('npm build')).toBe(false);
    expect(isKaizenCommand('gh issue view 42 && git push')).toBe(false);
    expect(isKaizenCommand('git push && gh pr merge 42')).toBe(false);
    expect(isKaizenCommand('gh issue view 42 && git status')).toBe(true);
  });
});

describe('isAllowedRuntimeDir', () => {
  it('allows .claude/ paths', () => {
    expect(isAllowedRuntimeDir('.claude/memory/test.md')).toBe(true);
    expect(isAllowedRuntimeDir('.claude/worktrees/foo')).toBe(true);
  });

  it('allows runtime data paths', () => {
    expect(isAllowedRuntimeDir('groups/default/memory.json')).toBe(true);
    expect(isAllowedRuntimeDir('data/sessions/1234.json')).toBe(true);
    expect(isAllowedRuntimeDir('store/kaizen.db')).toBe(true);
    expect(isAllowedRuntimeDir('logs/hook.log')).toBe(true);
    expect(isAllowedRuntimeDir('strategy/batch-1.json')).toBe(true);
  });

  it('blocks source code paths', () => {
    expect(isAllowedRuntimeDir('src/hooks/stop-gate.ts')).toBe(false);
    expect(isAllowedRuntimeDir('package.json')).toBe(false);
  });
});
