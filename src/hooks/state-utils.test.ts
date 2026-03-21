import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllStatesWithStatus,
  clearStateWithStatus,
  clearStateWithStatusAnyBranch,
  findAllStatesWithStatus,
  findNewestStateWithStatusAnyBranch,
  findStateWithStatus,
  findStateWithStatusAnyBranch,
  isReflectionDone,
  listStateFilesAnyBranch,
  listStateFilesForCurrentWorktree,
  markReflectionDone,
  parseStateFile,
  prUrlToStateKey,
  serializeStateFile,
  writeStateFile,
} from './state-utils.js';

const TEST_STATE_DIR = '/tmp/.test-state-utils-ts';

beforeEach(() => {
  if (existsSync(TEST_STATE_DIR)) {
    rmSync(TEST_STATE_DIR, { recursive: true });
  }
  mkdirSync(TEST_STATE_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_STATE_DIR)) {
    rmSync(TEST_STATE_DIR, { recursive: true });
  }
});

describe('prUrlToStateKey', () => {
  it('converts PR URL to safe key', () => {
    expect(
      prUrlToStateKey('https://github.com/Garsson-io/nanoclaw/pull/33'),
    ).toBe('Garsson-io_nanoclaw_33');
  });

  it('handles repos with dots', () => {
    expect(prUrlToStateKey('https://github.com/org/my.repo/pull/1')).toBe(
      'org_my.repo_1',
    );
  });
});

describe('parseStateFile', () => {
  it('parses key=value format', () => {
    const content =
      'PR_URL=https://github.com/test/repo/pull/1\nSTATUS=needs_pr_kaizen\nBRANCH=main\n';
    const state = parseStateFile(content);
    expect(state.PR_URL).toBe('https://github.com/test/repo/pull/1');
    expect(state.STATUS).toBe('needs_pr_kaizen');
    expect(state.BRANCH).toBe('main');
  });

  it('handles empty content', () => {
    expect(parseStateFile('')).toEqual({});
  });
});

describe('serializeStateFile', () => {
  it('serializes state to key=value format', () => {
    const content = serializeStateFile({
      PR_URL: 'https://github.com/test/repo/pull/1',
      STATUS: 'needs_pr_kaizen',
      BRANCH: 'main',
    });
    expect(content).toContain('PR_URL=https://github.com/test/repo/pull/1');
    expect(content).toContain('STATUS=needs_pr_kaizen');
    expect(content).toContain('BRANCH=main');
  });

  it('includes ROUND when present', () => {
    const content = serializeStateFile({
      PR_URL: 'url',
      STATUS: 'needs_review',
      BRANCH: 'main',
      ROUND: '2',
    });
    expect(content).toContain('ROUND=2');
  });
});

describe('writeStateFile', () => {
  it('creates state file with correct content', () => {
    const filepath = writeStateFile(TEST_STATE_DIR, 'test-state', {
      PR_URL: 'https://github.com/test/repo/pull/1',
      STATUS: 'needs_pr_kaizen',
      BRANCH: 'feat-branch',
    });
    expect(existsSync(filepath)).toBe(true);
    const content = readFileSync(filepath, 'utf-8');
    expect(content).toContain('PR_URL=https://github.com/test/repo/pull/1');
    expect(content).toContain('STATUS=needs_pr_kaizen');
    expect(content).toContain('BRANCH=feat-branch');
  });

  it('creates state dir if it does not exist', () => {
    const subDir = join(TEST_STATE_DIR, 'sub');
    writeStateFile(subDir, 'test', {
      PR_URL: 'url',
      STATUS: 'status',
      BRANCH: 'branch',
    });
    expect(existsSync(join(subDir, 'test'))).toBe(true);
  });
});

describe('listStateFilesAnyBranch', () => {
  it('returns empty array for empty directory', () => {
    expect(listStateFilesAnyBranch(TEST_STATE_DIR)).toEqual([]);
  });

  it('lists files with BRANCH field', () => {
    writeFileSync(
      join(TEST_STATE_DIR, 'state1'),
      'PR_URL=url1\nSTATUS=needs\nBRANCH=main\n',
    );
    const files = listStateFilesAnyBranch(TEST_STATE_DIR);
    expect(files).toHaveLength(1);
  });

  it('skips files without BRANCH field (legacy)', () => {
    writeFileSync(
      join(TEST_STATE_DIR, 'legacy'),
      'PR_URL=url1\nSTATUS=needs\n',
    );
    const files = listStateFilesAnyBranch(TEST_STATE_DIR);
    expect(files).toHaveLength(0);
  });
});

describe('markReflectionDone / isReflectionDone', () => {
  const prUrl = 'https://github.com/Garsson-io/nanoclaw/pull/42';

  it('marks and checks reflection done', () => {
    expect(isReflectionDone(prUrl, TEST_STATE_DIR)).toBe(false);
    markReflectionDone(prUrl, 'main', TEST_STATE_DIR);
    expect(isReflectionDone(prUrl, TEST_STATE_DIR)).toBe(true);
  });

  it('returns false for empty PR URL', () => {
    expect(isReflectionDone('', TEST_STATE_DIR)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Branch-scoped queries (kaizen #333 — parity with bash state-utils.sh)
// ---------------------------------------------------------------------------

describe('listStateFilesForCurrentWorktree', () => {
  it('returns only files matching current branch', () => {
    writeStateFile(TEST_STATE_DIR, 'state-main', {
      PR_URL: 'url1',
      STATUS: 'needs_review',
      BRANCH: 'main',
    });
    writeStateFile(TEST_STATE_DIR, 'state-feat', {
      PR_URL: 'url2',
      STATUS: 'needs_review',
      BRANCH: 'feat-branch',
    });
    const files = listStateFilesForCurrentWorktree('main', TEST_STATE_DIR);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('state-main');
  });

  it('returns empty for nonexistent directory', () => {
    expect(
      listStateFilesForCurrentWorktree('main', '/tmp/nonexistent-dir-xyz'),
    ).toEqual([]);
  });
});

describe('findStateWithStatus', () => {
  it('finds first matching state file for current branch', () => {
    writeStateFile(TEST_STATE_DIR, 'pr1', {
      PR_URL: 'https://github.com/test/repo/pull/1',
      STATUS: 'needs_pr_kaizen',
      BRANCH: 'feat-a',
    });
    writeStateFile(TEST_STATE_DIR, 'pr2', {
      PR_URL: 'https://github.com/test/repo/pull/2',
      STATUS: 'needs_review',
      BRANCH: 'feat-a',
    });
    const result = findStateWithStatus(
      'needs_pr_kaizen',
      'feat-a',
      TEST_STATE_DIR,
    );
    expect(result).not.toBeNull();
    expect(result!.prUrl).toBe('https://github.com/test/repo/pull/1');
    expect(result!.status).toBe('needs_pr_kaizen');
  });

  it('returns null when no match', () => {
    writeStateFile(TEST_STATE_DIR, 'pr1', {
      PR_URL: 'url',
      STATUS: 'needs_review',
      BRANCH: 'main',
    });
    expect(
      findStateWithStatus('needs_pr_kaizen', 'main', TEST_STATE_DIR),
    ).toBeNull();
  });

  it('ignores state files from other branches', () => {
    writeStateFile(TEST_STATE_DIR, 'other', {
      PR_URL: 'url',
      STATUS: 'needs_pr_kaizen',
      BRANCH: 'other-branch',
    });
    expect(
      findStateWithStatus('needs_pr_kaizen', 'main', TEST_STATE_DIR),
    ).toBeNull();
  });
});

describe('clearStateWithStatus', () => {
  it('removes the matching state file', () => {
    writeStateFile(TEST_STATE_DIR, 'pr1', {
      PR_URL: 'url',
      STATUS: 'needs_pr_kaizen',
      BRANCH: 'main',
    });
    const cleared = clearStateWithStatus(
      'needs_pr_kaizen',
      'main',
      TEST_STATE_DIR,
    );
    expect(cleared).toBe(true);
    expect(existsSync(join(TEST_STATE_DIR, 'pr1'))).toBe(false);
  });

  it('returns false when no match', () => {
    expect(
      clearStateWithStatus('needs_pr_kaizen', 'main', TEST_STATE_DIR),
    ).toBe(false);
  });
});

describe('findAllStatesWithStatus', () => {
  it('returns all matching state files for current branch', () => {
    writeStateFile(TEST_STATE_DIR, 'pr1', {
      PR_URL: 'url1',
      STATUS: 'needs_post_merge',
      BRANCH: 'main',
    });
    writeStateFile(TEST_STATE_DIR, 'pr2', {
      PR_URL: 'url2',
      STATUS: 'needs_post_merge',
      BRANCH: 'main',
    });
    writeStateFile(TEST_STATE_DIR, 'pr3', {
      PR_URL: 'url3',
      STATUS: 'needs_review',
      BRANCH: 'main',
    });
    const results = findAllStatesWithStatus(
      'needs_post_merge',
      'main',
      TEST_STATE_DIR,
    );
    expect(results).toHaveLength(2);
  });
});

describe('clearAllStatesWithStatus', () => {
  it('removes all matching state files', () => {
    writeStateFile(TEST_STATE_DIR, 'pr1', {
      PR_URL: 'url1',
      STATUS: 'needs_post_merge',
      BRANCH: 'feat',
    });
    writeStateFile(TEST_STATE_DIR, 'pr2', {
      PR_URL: 'url2',
      STATUS: 'needs_post_merge',
      BRANCH: 'feat',
    });
    const count = clearAllStatesWithStatus(
      'needs_post_merge',
      'feat',
      TEST_STATE_DIR,
    );
    expect(count).toBe(2);
    expect(existsSync(join(TEST_STATE_DIR, 'pr1'))).toBe(false);
    expect(existsSync(join(TEST_STATE_DIR, 'pr2'))).toBe(false);
  });

  it('returns 0 when no match', () => {
    expect(
      clearAllStatesWithStatus('needs_post_merge', 'main', TEST_STATE_DIR),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-branch queries (kaizen #333)
// ---------------------------------------------------------------------------

describe('findStateWithStatusAnyBranch', () => {
  it('finds state across branches', () => {
    writeStateFile(TEST_STATE_DIR, 'other', {
      PR_URL: 'url-other',
      STATUS: 'needs_pr_kaizen',
      BRANCH: 'other-branch',
    });
    const result = findStateWithStatusAnyBranch(
      'needs_pr_kaizen',
      TEST_STATE_DIR,
    );
    expect(result).not.toBeNull();
    expect(result!.prUrl).toBe('url-other');
  });

  it('returns null when no match', () => {
    expect(
      findStateWithStatusAnyBranch('nonexistent', TEST_STATE_DIR),
    ).toBeNull();
  });
});

describe('clearStateWithStatusAnyBranch', () => {
  it('clears state across branches', () => {
    writeStateFile(TEST_STATE_DIR, 'cross', {
      PR_URL: 'url-cross',
      STATUS: 'needs_pr_kaizen',
      BRANCH: 'remote-branch',
    });
    expect(
      clearStateWithStatusAnyBranch('needs_pr_kaizen', TEST_STATE_DIR),
    ).toBe(true);
    expect(existsSync(join(TEST_STATE_DIR, 'cross'))).toBe(false);
  });

  it('filters by PR URL when specified', () => {
    writeStateFile(TEST_STATE_DIR, 'pr-a', {
      PR_URL: 'url-a',
      STATUS: 'needs_pr_kaizen',
      BRANCH: 'feat',
    });
    writeStateFile(TEST_STATE_DIR, 'pr-b', {
      PR_URL: 'url-b',
      STATUS: 'needs_pr_kaizen',
      BRANCH: 'feat',
    });
    expect(
      clearStateWithStatusAnyBranch(
        'needs_pr_kaizen',
        TEST_STATE_DIR,
        undefined,
        'url-a',
      ),
    ).toBe(true);
    expect(existsSync(join(TEST_STATE_DIR, 'pr-a'))).toBe(false);
    expect(existsSync(join(TEST_STATE_DIR, 'pr-b'))).toBe(true);
  });
});

describe('findNewestStateWithStatusAnyBranch', () => {
  it('returns the newest matching state file', async () => {
    writeStateFile(TEST_STATE_DIR, 'older', {
      PR_URL: 'url-old',
      STATUS: 'needs_pr_kaizen',
      BRANCH: 'branch-a',
    });
    // Ensure different mtime by writing slightly later
    await new Promise((r) => setTimeout(r, 50));
    writeStateFile(TEST_STATE_DIR, 'newer', {
      PR_URL: 'url-new',
      STATUS: 'needs_pr_kaizen',
      BRANCH: 'branch-b',
    });
    const result = findNewestStateWithStatusAnyBranch(
      'needs_pr_kaizen',
      TEST_STATE_DIR,
    );
    expect(result).not.toBeNull();
    expect(result!.prUrl).toBe('url-new');
  });

  it('returns null when no match', () => {
    expect(
      findNewestStateWithStatusAnyBranch('nonexistent', TEST_STATE_DIR),
    ).toBeNull();
  });
});
