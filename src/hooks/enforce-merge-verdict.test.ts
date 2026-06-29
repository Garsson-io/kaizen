import { spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkMergeVerdict,
  decideMergeGate,
  defaultVerdictReader,
  inferGithubRepoFromCommandTarget,
  MERGE_OVERRIDE_ENV,
  parseMergeTarget,
  type VerdictReader,
} from './enforce-merge-verdict.js';
import { clearCommentCache } from '../section-editor.js';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

const mockGh = vi.mocked(spawnSync);

function ghReturns(stdout: string) {
  mockGh.mockReturnValueOnce({ status: 0, stdout, stderr: '', signal: null, pid: 0, output: [null, stdout, ''] } as any);
}

beforeEach(() => {
  mockGh.mockReset();
  clearCommentCache();
});

const gitRunner = (remoteUrl = 'https://github.com/Garsson-io/kaizen.git') => (args: readonly string[]) => {
  if (args.join(' ').includes('remote get-url origin')) {
    return { stdout: `${remoteUrl}\n`, stderr: '', exitCode: 0 };
  }
  return { stdout: '', stderr: '', exitCode: 1 };
};

describe('parseMergeTarget', () => {
  it('parses bare PR number + --repo', () => {
    expect(parseMergeTarget('gh pr merge 123 --repo Garsson-io/kaizen --squash')).toEqual({
      pr: '123',
      repo: 'Garsson-io/kaizen',
    });
  });

  it('parses the full PR URL form', () => {
    expect(
      parseMergeTarget('gh pr merge https://github.com/Garsson-io/kaizen/pull/456 --squash --auto'),
    ).toEqual({ pr: '456', repo: 'Garsson-io/kaizen' });
  });

  it('infers repo from the command target worktree for bare PR numbers', () => {
    expect(parseMergeTarget('gh pr merge 123 --squash', {
      cwd: '/repo',
      git: gitRunner(),
    })).toEqual({ pr: '123', repo: 'Garsson-io/kaizen' });
  });

  it('returns null when no target repo can be resolved from flags, URL, or remote', () => {
    expect(parseMergeTarget('gh pr merge 123 --squash', {
      cwd: '/repo',
      git: gitRunner('not-github'),
    })).toBeNull();
  });
});

describe('inferGithubRepoFromCommandTarget', () => {
  it('anchors repo inference to cd target before reading origin', () => {
    const calls: string[][] = [];
    const git = (args: readonly string[]) => {
      calls.push([...args]);
      return { stdout: 'git@github.com:Garsson-io/kaizen.git\n', stderr: '', exitCode: 0 };
    };

    expect(inferGithubRepoFromCommandTarget('cd /wt && gh pr merge 123 --squash', {
      cwd: '/cwd',
      git,
    })).toBe('Garsson-io/kaizen');
    expect(calls[0]).toEqual(['-C', '/wt', 'remote', 'get-url', 'origin']);
  });
});

describe('decideMergeGate', () => {
  const target = { pr: '1212', repo: 'Garsson-io/kaizen' };

  it('denies a merge when the latest round derives FAIL', () => {
    const result = decideMergeGate('FAIL', { override: false, target });
    expect(result.action).toBe('deny');
    expect(result.message).toContain('MERGE BLOCKED');
    expect(result.message).toContain('PR #1212');
  });

  it('allows PASS and PASS_WITH_PARTIALS', () => {
    expect(decideMergeGate('PASS', { override: false, target }).action).toBe('allow');
    expect(decideMergeGate('PASS_WITH_PARTIALS', { override: false, target }).action).toBe('allow');
  });

  it('denies without stored review data', () => {
    const result = decideMergeGate(null, { override: false, target });
    expect(result.action).toBe('deny');
    expect(result.message).toContain('No stored review rounds found');
    expect(result.message).toContain('MERGE BLOCKED');
  });

  it('allows FAIL under an explicit override and marks it bypassed', () => {
    const result = decideMergeGate('FAIL', { override: true, target });
    expect(result.action).toBe('allow');
    expect(result.bypassed).toBe(true);
    expect(result.message).toContain(MERGE_OVERRIDE_ENV);
  });
});

describe('checkMergeVerdict', () => {
  const failReader: VerdictReader = () => 'FAIL';
  const passReader: VerdictReader = () => 'PASS';
  const noDataReader: VerdictReader = () => null;
  const throwReader: VerdictReader = () => {
    throw new Error('gh offline');
  };

  it('blocks a real merge command when the latest round is FAIL', () => {
    const result = checkMergeVerdict(
      'gh pr merge https://github.com/Garsson-io/kaizen/pull/1212 --repo Garsson-io/kaizen --squash --auto',
      { readVerdict: failReader, env: {} },
    );
    expect(result.action).toBe('deny');
  });

  it('blocks a bare gh pr merge <N> command when the current repo has a FAIL verdict', () => {
    const result = checkMergeVerdict('gh pr merge 1212 --squash', {
      readVerdict: failReader,
      env: {},
      cwd: '/repo',
      git: gitRunner(),
    });
    expect(result.action).toBe('deny');
    expect(result.target).toEqual({ pr: '1212', repo: 'Garsson-io/kaizen' });
    expect(result.verdict).toBe('FAIL');
  });

  it('allows a merge when the latest round is PASS', () => {
    expect(checkMergeVerdict('gh pr merge 1212 --repo Garsson-io/kaizen', {
      readVerdict: passReader,
      env: {},
    }).action).toBe('allow');
  });

  it('blocks when there are no review rounds', () => {
    expect(checkMergeVerdict('gh pr merge 999 --repo Garsson-io/kaizen', {
      readVerdict: noDataReader,
      env: {},
    }).action).toBe('deny');
  });

  it('honours the explicit override env on FAIL', () => {
    const result = checkMergeVerdict('gh pr merge 1212 --repo Garsson-io/kaizen', {
      readVerdict: failReader,
      env: { [MERGE_OVERRIDE_ENV]: '1' },
    });
    expect(result.action).toBe('allow');
    expect(result.bypassed).toBe(true);
  });

  it('fails open with a warning if verdict reading throws', () => {
    expect(checkMergeVerdict('gh pr merge 1212 --repo Garsson-io/kaizen', {
      readVerdict: throwReader,
      env: {},
    }).action).toBe('warn');
  });

  it('ignores non-merge commands', () => {
    expect(checkMergeVerdict('gh pr create --title x', { readVerdict: failReader }).action).toBe('allow');
    expect(checkMergeVerdict('git push origin HEAD', { readVerdict: failReader }).action).toBe('allow');
    expect(checkMergeVerdict('echo gh pr merge 1', { readVerdict: failReader }).action).toBe('allow');
  });
});

describe('defaultVerdictReader', () => {
  it('permits active r2 PASS even when stale higher r3 findings fail', () => {
    ghReturns(JSON.stringify({
      url: 'u',
      body: '<!-- kaizen:review/active-round -->\n<!-- meta:{"round":2} -->\nActive review round: r2',
    }));
    ghReturns([
      JSON.stringify({ url: 'u', body: '<!-- kaizen:review/r2/correctness -->' }),
      JSON.stringify({ url: 'u', body: '<!-- kaizen:review/r2/summary -->' }),
      JSON.stringify({ url: 'u', body: '<!-- kaizen:review/r3/security -->' }),
      JSON.stringify({ url: 'u', body: '<!-- kaizen:review/r3/summary -->' }),
    ].join('\n'));
    const r2Finding = JSON.stringify({
      url: 'u',
      body: '<!-- kaizen:review/r2/correctness -->\n<!-- meta:{"round":2,"dimension":"correctness","verdict":"pass","done":2,"partial":0,"missing":0} -->',
    });
    ghReturns(r2Finding);
    ghReturns(r2Finding);

    expect(defaultVerdictReader({ pr: '1212', repo: 'Garsson-io/kaizen' })).toBe('PASS');
  });
});
