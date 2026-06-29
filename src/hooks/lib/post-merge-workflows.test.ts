import { describe, expect, it } from 'vitest';
import { postMergeWorkflowVerificationLines, safeMainSyncCommand } from './post-merge-workflows.js';

describe('postMergeWorkflowVerificationLines', () => {
  it('builds a concrete main workflow verification command from a PR URL', () => {
    const lines = postMergeWorkflowVerificationLines('https://github.com/org/repo/pull/42');

    expect(lines).toContain('org/repo');
    expect(lines).toContain('main');
    expect(lines).toContain('gh run list --repo org/repo --branch main --commit <merge-sha>');
    expect(lines).toContain('If any run failed');
  });

  it('falls back to the current repository when the PR URL is malformed', () => {
    const lines = postMergeWorkflowVerificationLines('not-a-pr-url');

    expect(lines).toContain('gh run list --branch main --commit <merge-sha>');
    expect(lines).not.toContain('--repo');
  });
});

describe('safeMainSyncCommand', () => {
  it('uses ff-only sync without creating a local main merge commit', () => {
    expect(safeMainSyncCommand()).toBe('git fetch origin main && git merge --ff-only origin/main');
  });

  it('quotes main checkout paths used with git -C', () => {
    expect(safeMainSyncCommand('/tmp/main checkout')).toBe(
      "git -C '/tmp/main checkout' fetch origin main && git -C '/tmp/main checkout' merge --ff-only origin/main",
    );
  });

  it('quotes single quotes in main checkout paths', () => {
    expect(safeMainSyncCommand("/tmp/main's checkout")).toContain("'/tmp/main'\\''s checkout'");
  });
});
