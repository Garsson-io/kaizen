import { describe, expect, it } from 'vitest';
import {
  isAllowedRuntimeDir,
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

  it('prevents bypass via pipe chains', () => {
    // "npm build && echo KAIZEN_IMPEDIMENTS:" — the first segment is blocked
    expect(isKaizenCommand('npm build')).toBe(false);
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
