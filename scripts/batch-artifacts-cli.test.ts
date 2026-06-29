import { describe, it, expect } from 'vitest';
import { parseBatchArtifactCliArgs } from './batch-artifacts-cli.js';

describe('parseBatchArtifactCliArgs', () => {
  it('extracts positional dirs, json mode, repo, and repeated progress issues', () => {
    const parsed = parseBatchArtifactCliArgs([
      'logs/auto-dent',
      '--progress-issue',
      '100',
      '--json',
      '--repo',
      'owner/repo',
      '--progress-issue',
      '101',
    ]);

    expect(parsed).toEqual({
      jsonMode: true,
      positional: ['logs/auto-dent'],
      progressIssues: ['100', '101'],
      repo: 'owner/repo',
    });
  });

  it('falls back to GITHUB_REPOSITORY when --repo is absent', () => {
    const previous = process.env.GITHUB_REPOSITORY;
    process.env.GITHUB_REPOSITORY = 'env/repo';
    try {
      expect(parseBatchArtifactCliArgs(['--progress-issue', '100']).repo).toBe('env/repo');
    } finally {
      if (previous === undefined) delete process.env.GITHUB_REPOSITORY;
      else process.env.GITHUB_REPOSITORY = previous;
    }
  });
});
