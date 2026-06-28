import { describe, expect, it } from 'vitest';
import {
  buildDrySweepReport,
  collectMechanismDriftCandidates,
  fetchRecentMergedPrs,
  formatDrySweepReport,
  type DrySweepFile,
} from './auto-dent-dry-sweep.js';

const files: DrySweepFile[] = [
  {
    path: 'scripts/auto-dent-run.ts',
    content: `
      import { writeAttachment } from '../src/section-editor.js';
      import { ghExec } from './auto-dent-github.js';
      function postProgress() {
        ghExec(\`gh issue comment 1 --repo o/r --body "hi"\`);
        writeAttachment({ kind: 'issue', number: '1', repo: 'o/r' }, 'review', 'body');
      }
    `,
  },
  {
    path: 'scripts/auto-dent-ctl.ts',
    content: `
      import { execSync } from 'node:child_process';
      function postReflection() {
        execSync(\`gh issue comment 1 --repo o/r --body "reflection"\`);
      }
    `,
  },
  {
    path: 'src/issue-backend.ts',
    content: `
      function shellExec(cmd: string) {
        return cmd;
      }
    `,
  },
  {
    path: 'scripts/auto-dent-events.ts',
    content: 'export interface EventEnvelope { type: string }',
  },
  {
    path: 'src/hooks/session-telemetry.ts',
    content: 'export interface SessionEventEnvelope { type: string }',
  },
];

describe('collectMechanismDriftCandidates', () => {
  it('groups known duplicate mechanism families from current code evidence', () => {
    const candidates = collectMechanismDriftCandidates(files);

    expect(candidates.map(c => c.kind)).toEqual(expect.arrayContaining([
      'github_execution',
      'progress_comments',
      'telemetry_events',
    ]));
    expect(candidates.find(c => c.kind === 'github_execution')?.evidence.map(e => e.path)).toEqual(
      expect.arrayContaining(['scripts/auto-dent-run.ts', 'src/issue-backend.ts']),
    );
    expect(candidates.find(c => c.kind === 'progress_comments')?.suggestedUnificationTarget).toContain('writeAttachment');
  });

  it('orders competing evidence before shared targets so reports stay actionable', () => {
    const progressComments = collectMechanismDriftCandidates(files).find(c => c.kind === 'progress_comments');

    expect(progressComments?.evidence[0]).toMatchObject({
      path: 'scripts/auto-dent-run.ts',
      symbol: 'gh issue comment',
    });
    expect(progressComments?.evidence.at(-1)?.symbol).toBe('writeAttachment');
  });

  it('ignores weak one-off similarity', () => {
    const candidates = collectMechanismDriftCandidates([
      { path: 'scripts/one.ts', content: 'export function helper() { return 1; }' },
      { path: 'scripts/unrelated.ts', content: 'export const value = 2;' },
    ]);

    expect(candidates).toEqual([]);
  });
});

describe('fetchRecentMergedPrs', () => {
  it('uses argv-based gh collection with no shell command string', () => {
    const calls: string[][] = [];
    const prs = fetchRecentMergedPrs('Garsson-io/kaizen', 2, {
      gh: (args) => {
        calls.push(args);
        return JSON.stringify([
          {
            number: 10,
            title: 'refactor(auto-dent): share progress comments',
            mergedAt: '2026-06-28T10:00:00Z',
            files: [{ path: 'scripts/auto-dent-run.ts' }],
            url: 'https://github.com/Garsson-io/kaizen/pull/10',
          },
        ]);
      },
    });

    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ number: 10, changedFiles: ['scripts/auto-dent-run.ts'] });
    expect(calls[0]).toEqual([
      'pr',
      'list',
      '--repo',
      'Garsson-io/kaizen',
      '--state',
      'merged',
      '--limit',
      '2',
      '--json',
      'number,title,mergedAt,files,url',
    ]);
  });
});

describe('buildDrySweepReport', () => {
  it('adds recent PR evidence and renders an actionable report', () => {
    const report = buildDrySweepReport({
      files,
      repo: 'Garsson-io/kaizen',
      recentPrLimit: 5,
      gh: () => JSON.stringify([
        {
          number: 1387,
          title: 'refactor(hooks): ratchet bare truncate-helper drift',
          mergedAt: '2026-06-28T09:00:00Z',
          files: [{ path: 'scripts/auto-dent-run.ts' }, { path: 'src/hooks/session-telemetry.ts' }],
          url: 'https://github.com/Garsson-io/kaizen/pull/1387',
        },
      ]),
    });

    expect(report.candidates.length).toBeGreaterThan(0);
    expect(report.candidates.some(c => c.recentPrs.some(pr => pr.number === 1387))).toBe(true);

    const text = formatDrySweepReport(report);
    expect(text).toContain('DRY Sweep');
    expect(text).toContain('github_execution');
    expect(text).toContain('scripts/auto-dent-run.ts');
    expect(text).toContain('#1387');
  });
});
