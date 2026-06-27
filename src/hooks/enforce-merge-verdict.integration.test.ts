/**
 * Integration test for enforce-merge-verdict's DEFAULT verdict reader.
 *
 * The pure-logic tests inject a fake reader. This test drives the REAL default
 * path (latestReviewRound → deriveStoredRoundVerdict → stored findings) with the
 * GitHub CLI mocked, proving the gate BLOCKS a merge when the PR's actual stored
 * findings derive FAIL — not just when a stub reader says so (#1220 / #1227).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { clearCommentCache } from '../section-editor.js';
import { checkMergeVerdict } from './enforce-merge-verdict.js';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
const mockGh = vi.mocked(spawnSync);

/** Make every `gh` comment fetch return the same comment list. */
function commentsReturn(comments: Array<{ url: string; body: string }>): void {
  const stdout = comments.map((c) => JSON.stringify(c)).join('\n');
  mockGh.mockReturnValue({
    status: 0, stdout, stderr: '', signal: null, pid: 0, output: [null, stdout, ''],
  } as any);
}

beforeEach(() => { vi.clearAllMocks(); mockGh.mockReset(); clearCommentCache(); });

const MERGE_CMD = 'gh pr merge 1212 --repo Garsson-io/kaizen --squash';

describe('enforce-merge-verdict — default reader over the real storage stack', () => {
  it('BLOCKS the merge when the latest stored round derives FAIL (2 MISSING)', () => {
    // Mirrors the #1212 battery: a dimension with MISSING findings → derives FAIL.
    commentsReturn([
      {
        url: 'https://github.com/Garsson-io/kaizen/issues/1212#issuecomment-1',
        body: '<!-- kaizen:review/r1/improvement-lifecycle -->\n<!-- meta:{"round":1,"dimension":"improvement-lifecycle","verdict":"fail","done":0,"partial":0,"missing":2} -->',
      },
      {
        url: 'https://github.com/Garsson-io/kaizen/issues/1212#issuecomment-2',
        body: '<!-- kaizen:review/r1/summary -->\n<!-- meta:{"round":1,"verdict":"fail","round_verdict":"FAIL"} -->',
      },
    ]);

    const r = checkMergeVerdict(MERGE_CMD, { env: {} });
    expect(r.action).toBe('deny');
    expect(r.message).toContain('MERGE BLOCKED');
  });

  it('allows the merge when the latest stored round is all DONE (PASS)', () => {
    commentsReturn([
      {
        url: 'https://github.com/Garsson-io/kaizen/issues/1212#issuecomment-3',
        body: '<!-- kaizen:review/r1/correctness -->\n<!-- meta:{"round":1,"dimension":"correctness","verdict":"pass","done":3,"partial":0,"missing":0} -->',
      },
    ]);

    const r = checkMergeVerdict(MERGE_CMD, { env: {} });
    expect(r.action).toBe('allow');
  });

  it('warns (advisory) when the PR has no stored review rounds at all', () => {
    commentsReturn([
      {
        url: 'https://github.com/Garsson-io/kaizen/issues/1212#issuecomment-4',
        body: '<!-- kaizen:plan -->\nsome plan text, no review',
      },
    ]);

    const r = checkMergeVerdict(MERGE_CMD, { env: {} });
    expect(r.action).toBe('warn');
  });
});
