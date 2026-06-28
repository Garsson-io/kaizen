import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  extractArtifacts,
  postInFlightUpdate,
  buildInFlightComment,
  processStreamMessage,
  relativizeWorktreePath,
  prettifyPath,
  stripCdPrefix,
  formatToolUse,
  collapseWhitespace,
  type StreamContext,
} from './auto-dent-stream.js';
import * as github from './auto-dent-github.js';
import { makeRunResult } from './auto-dent-test-helpers.js';

describe('postInFlightUpdate', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false when progressIssue is empty', () => {
    const result = makeRunResult();
    const ctx: StreamContext = {};
    expect(postInFlightUpdate('', 'owner/repo', 1, Date.now(), result, ctx)).toBe(false);
  });

  it('returns false when kaizenRepo is empty', () => {
    const result = makeRunResult();
    const ctx: StreamContext = {};
    expect(
      postInFlightUpdate('https://github.com/o/r/issues/42', '', 1, Date.now(), result, ctx),
    ).toBe(false);
  });

  it('returns false when progressIssue has no issue number', () => {
    const result = makeRunResult();
    const ctx: StreamContext = {};
    expect(postInFlightUpdate('not-a-url', 'owner/repo', 1, Date.now(), result, ctx)).toBe(false);
  });

  it('posts a comment and returns true on success', () => {
    const ghExecSpy = vi.spyOn(github, 'ghExec').mockReturnValue('ok');
    const result = makeRunResult({ toolCalls: 5, cost: 1.23 });
    const ctx: StreamContext = {};

    const posted = postInFlightUpdate(
      'https://github.com/o/r/issues/42',
      'owner/repo',
      3,
      Date.now() - 60_000,
      result,
      ctx,
    );

    expect(posted).toBe(true);
    expect(ghExecSpy).toHaveBeenCalledOnce();
    const cmd = ghExecSpy.mock.calls[0][0];
    expect(cmd).toContain('gh issue comment 42');
    expect(cmd).toContain('--repo owner/repo');
  });

  it('returns false when ghExec returns empty string', () => {
    vi.spyOn(github, 'ghExec').mockReturnValue('');
    const result = makeRunResult();
    const ctx: StreamContext = {};

    const posted = postInFlightUpdate(
      'https://github.com/o/r/issues/42',
      'owner/repo',
      1,
      Date.now(),
      result,
      ctx,
    );

    expect(posted).toBe(false);
  });
});

describe('buildInFlightComment', () => {
  it('shows working status when no resultReceivedAt', () => {
    const result = makeRunResult({ toolCalls: 10, cost: 2.5 });
    const ctx: StreamContext = {};
    const comment = buildInFlightComment(2, Date.now() - 120_000, result, ctx);

    expect(comment).toContain('Run #2');
    expect(comment).toContain('working');
    expect(comment).toContain('10');
    expect(comment).toContain('$2.50');
  });

  it('shows waiting status when resultReceivedAt is set', () => {
    const result = makeRunResult({ toolCalls: 5, cost: 1.0 });
    const ctx: StreamContext = { resultReceivedAt: Date.now() - 5_000 };
    const comment = buildInFlightComment(1, Date.now() - 60_000, result, ctx);

    expect(comment).toContain('waiting for process exit');
  });

  it('includes last activity and phase when present', () => {
    const result = makeRunResult();
    const ctx: StreamContext = { lastActivity: 'Read foo.ts', lastPhase: 'IMPLEMENT' };
    const comment = buildInFlightComment(1, Date.now(), result, ctx);

    expect(comment).toContain('Read foo.ts');
    expect(comment).toContain('IMPLEMENT');
  });

  it('includes PRs when present', () => {
    const result = makeRunResult({ prs: ['https://github.com/o/r/pull/1'] });
    const ctx: StreamContext = {};
    const comment = buildInFlightComment(1, Date.now(), result, ctx);

    expect(comment).toContain('https://github.com/o/r/pull/1');
  });

  it('shows observable work-cycle artifacts with URLs', () => {
    const result = makeRunResult({
      pickedIssue: '#1225',
      pickedIssueTitle: 'redo CI proof gate',
      prs: ['https://github.com/Garsson-io/kaizen/pull/1227'],
      reviewVerdict: 'fail',
      progressSteps: [
        {
          phase: 'PICK',
          state: 'selected',
          detail: '#1225 — redo CI proof gate',
        },
        {
          phase: 'PR',
          state: 'created',
          detail: 'https://github.com/Garsson-io/kaizen/pull/1227',
          url: 'https://github.com/Garsson-io/kaizen/pull/1227',
        },
      ],
    });
    const ctx: StreamContext = {};
    const comment = buildInFlightComment(1, Date.now(), result, ctx, 'Garsson-io/kaizen');

    expect(comment).toContain('| **Issue worked** | https://github.com/Garsson-io/kaizen/issues/1225 — redo CI proof gate |');
    expect(comment).toContain('| **PR generated** | https://github.com/Garsson-io/kaizen/pull/1227 |');
    expect(comment).toContain('| **Review state** | fail |');
    expect(comment).toContain('#### Kaizen Work Cycle');
    expect(comment).toContain('| PLAN | not observed | - | - |');
    expect(comment).toContain('| CASE | not observed | - | - |');
    expect(comment).toContain('| PR | created | https://github.com/Garsson-io/kaizen/pull/1227 | https://github.com/Garsson-io/kaizen/pull/1227 |');
    expect(comment).toContain('| CLEANUP | not observed | - | - |');
  });

  it('renders the full work-cycle checklist in canonical kaizen order', () => {
    const result = makeRunResult({
      progressSteps: [
        { phase: 'STOP', state: 'requested', detail: 'done' },
        { phase: 'PR', state: 'created', detail: 'https://github.com/o/r/pull/1', url: 'https://github.com/o/r/pull/1' },
        { phase: 'REVIEW', state: 'skipped', detail: 'https://github.com/o/r/pull/1', url: 'https://github.com/o/r/pull/1' },
        { phase: 'MERGE', state: 'merged', detail: 'https://github.com/o/r/pull/1', url: 'https://github.com/o/r/pull/1' },
      ],
    });

    const comment = buildInFlightComment(1, Date.now(), result, {});

    expect(comment).toContain('| PICK | not observed | - | - |');
    expect(comment).toContain('| PLAN | not observed | - | - |');
    expect(comment).toContain('| EVALUATE | not observed | - | - |');
    expect(comment).toContain('| CASE | not observed | - | - |');
    expect(comment).toContain('| IMPLEMENT | not observed | - | - |');
    expect(comment).toContain('| TEST | not observed | - | - |');
    expect(comment).toContain('| FIX |');
    expect(comment).toContain('| REFLECT |');
    expect(comment).toContain('| CLEANUP |');
    expect(comment.indexOf('| PR |')).toBeLessThan(comment.indexOf('| REVIEW |'));
    expect(comment.indexOf('| REVIEW |')).toBeLessThan(comment.indexOf('| MERGE |'));
    expect(comment.indexOf('| MERGE |')).toBeLessThan(comment.indexOf('| STOP |'));
  });

  it('marks review as not applicable for synthetic test tasks', () => {
    const result = makeRunResult({
      pickedIssue: 'not applicable',
      pickedIssueTitle: 'synthetic test task',
      prs: ['https://github.com/o/r/pull/1'],
      reviewVerdict: 'skipped',
    });

    const comment = buildInFlightComment(1, Date.now(), result, {});

    expect(comment).toContain('| **Review state** | not applicable |');
    expect(comment).toContain('| REVIEW | not applicable | synthetic test task | https://github.com/o/r/pull/1 |');
  });

  it('populates review and reflection rows from canonical gate set signals', () => {
    const result = makeRunResult({
      prs: ['https://github.com/Garsson-io/kaizen/pull/1242'],
    });

    extractArtifacts(
      `---
hook: pr-review-loop
type: gate-set
gate: needs_review
pr: https://github.com/Garsson-io/kaizen/pull/1242
round: 2
reason: Push detected - new review round
---
---
hook: kaizen-reflect
type: gate-set
gate: needs_pr_kaizen
reason: Kaizen reflection required
---
`,
      result,
    );

    const comment = buildInFlightComment(1, Date.now(), result, {}, 'Garsson-io/kaizen');

    expect(comment).toContain('| REVIEW | pending | round 2: Push detected - new review round | https://github.com/Garsson-io/kaizen/pull/1242 |');
    expect(comment).toContain('| REFLECT | pending | Kaizen reflection required | - |');
  });

  it('populates review and reflection rows from canonical gate clear signals', () => {
    const result = makeRunResult({
      prs: ['https://github.com/Garsson-io/kaizen/pull/1242'],
    });

    extractArtifacts(
      `---
hook: pr-review-loop
type: gate-clear
gate: needs_review
pr: https://github.com/Garsson-io/kaizen/pull/1242
round: 2
reason: Review passed
---
---
hook: pr-kaizen-clear
type: gate-clear
gate: needs_pr_kaizen
reason: Impediments filed
---
`,
      result,
    );

    const comment = buildInFlightComment(1, Date.now(), result, {}, 'Garsson-io/kaizen');

    expect(comment).toContain('| REVIEW | passed | round 2: Review passed | https://github.com/Garsson-io/kaizen/pull/1242 |');
    expect(comment).toContain('| REFLECT | completed | Impediments filed | - |');
  });

  it('populates merge rows from canonical post-merge gate signals', () => {
    const result = makeRunResult({
      prs: ['https://github.com/Garsson-io/kaizen/pull/1242'],
    });

    extractArtifacts(
      `---
hook: post-merge-clear
type: gate-set
gate: needs_post_merge
pr: https://github.com/Garsson-io/kaizen/pull/1242
reason: Merge confirmed - run /kaizen to reflect
---
`,
      result,
    );

    let comment = buildInFlightComment(1, Date.now(), result, {}, 'Garsson-io/kaizen');
    expect(comment).toContain('| MERGE | merged | Merge confirmed - run /kaizen to reflect | https://github.com/Garsson-io/kaizen/pull/1242 |');

    extractArtifacts(
      `---
hook: post-merge-clear
type: gate-clear
gate: needs_post_merge
reason: Kaizen reflection completed
---
`,
      result,
    );

    comment = buildInFlightComment(1, Date.now(), result, {}, 'Garsson-io/kaizen');
    expect(comment).toContain('| MERGE | completed | Kaizen reflection completed | https://github.com/Garsson-io/kaizen/pull/1242 |');
  });

  it('keeps synthetic task lifecycle rows not applicable even if gate text is present', () => {
    const result = makeRunResult({
      pickedIssue: 'not applicable',
      pickedIssueTitle: 'synthetic test task',
      prs: ['https://github.com/o/r/pull/1'],
      reviewVerdict: 'skipped',
    });

    extractArtifacts(
      `---
hook: pr-review-loop
type: gate-set
gate: needs_review
pr: https://github.com/o/r/pull/1
round: 1
reason: PR created
---
---
hook: kaizen-reflect
type: gate-set
gate: needs_pr_kaizen
reason: Kaizen reflection required
---
`,
      result,
    );

    const comment = buildInFlightComment(1, Date.now(), result, {}, 'Garsson-io/kaizen');

    expect(comment).toContain('| REVIEW | not applicable | synthetic test task | https://github.com/o/r/pull/1 |');
    expect(comment).toContain('| REFLECT | not applicable | synthetic test task | - |');
  });
});

// #1157 — semantic line budget for the live terminal stream.
const WT = '/home/aviad/projects/kaizen/.claude/worktrees/2606271151-c55d';

describe('relativizeWorktreePath', () => {
  it('collapses a worktree-absolute path to its repo-relative remainder', () => {
    expect(relativizeWorktreePath(`${WT}/scripts/foo.ts`)).toBe('scripts/foo.ts');
  });

  it('collapses a bare worktree root to "."', () => {
    expect(relativizeWorktreePath(WT)).toBe('.');
  });

  it('leaves non-worktree paths unchanged', () => {
    expect(relativizeWorktreePath('/usr/local/bin/node')).toBe('/usr/local/bin/node');
    expect(relativizeWorktreePath('src/cli.ts')).toBe('src/cli.ts');
  });

  it('relativizes a worktree path embedded inside a larger command string', () => {
    expect(relativizeWorktreePath(`sed -n 1,5p ${WT}/docs/x.md`)).toBe('sed -n 1,5p docs/x.md');
  });

  it('is a no-op on empty input', () => {
    expect(relativizeWorktreePath('')).toBe('');
  });
});

describe('prettifyPath', () => {
  it('collapses /home/<user>/ to ~/ for non-worktree absolute paths', () => {
    expect(prettifyPath('/home/aviad/projects/kaizen/src/cli.ts')).toBe(
      '~/projects/kaizen/src/cli.ts',
    );
  });

  it('prefers worktree-relative over home-collapse for worktree paths', () => {
    expect(prettifyPath(`${WT}/scripts/foo.ts`)).toBe('scripts/foo.ts');
  });
});

describe('stripCdPrefix', () => {
  it('removes a leading "cd <path>;" prefix', () => {
    expect(stripCdPrefix(`cd ${WT}; sed -n 1,5p file.ts`)).toBe('sed -n 1,5p file.ts');
  });

  it('removes a leading "cd <path> &&" prefix', () => {
    expect(stripCdPrefix(`cd ${WT} && npm test`)).toBe('npm test');
  });

  it('leaves commands without a cd prefix untouched', () => {
    expect(stripCdPrefix('npm run build')).toBe('npm run build');
    expect(stripCdPrefix('grep -n cd file.ts')).toBe('grep -n cd file.ts');
  });
});

describe('formatToolUse (#1157 semantic budget)', () => {
  it('Bash: renders the meaningful tail, not the worktree cd prefix', () => {
    const out = formatToolUse('Bash', {
      command: `cd ${WT}; sed -n 1,40p ${WT}/scripts/auto-dent-stream.ts`,
    });
    expect(out).toBe('$ sed -n 1,40p scripts/auto-dent-stream.ts');
    expect(out).not.toContain('worktrees');
    expect(out).not.toContain('cd ');
  });

  it('Read/Edit/Write: render worktree-absolute paths repo-relative', () => {
    expect(formatToolUse('Read', { file_path: `${WT}/scripts/foo.ts` })).toBe(
      'Read scripts/foo.ts',
    );
    expect(formatToolUse('Edit', { file_path: `${WT}/src/cli.ts` })).toBe('Edit src/cli.ts');
    expect(formatToolUse('Write', { file_path: `${WT}/docs/x.md` })).toBe('Write docs/x.md');
  });

  it('Grep: relativizes the search path', () => {
    expect(formatToolUse('Grep', { pattern: 'foo', path: `${WT}/scripts` })).toBe(
      'Grep "foo" scripts',
    );
  });

  it('preserves existing rendering for non-path tools', () => {
    expect(formatToolUse('Skill', { skill_name: 'kaizen-reflect' })).toBe('Skill /kaizen-reflect');
    expect(formatToolUse('Agent', { description: 'do a thing' })).toBe('Agent: do a thing');
    expect(formatToolUse('ExitWorktree', {})).toBe('ExitWorktree');
  });

  it('Bash falls back to description when no command, with prefix handling', () => {
    expect(formatToolUse('Bash', { description: 'run tests' })).toBe('$ run tests');
  });

  // #1170 — one tool event must render as exactly one stream line. A heredoc /
  // multiline script body previously spilled onto following lines with no
  // timestamp/tool prefix, so it looked like separate auto-dent events.
  it('Bash: collapses a multiline heredoc command to a single line', () => {
    const cmd = `cat > /tmp/analyze.sh << 'EOF'\n#!/bin/bash\n\n# get files\nall=$(find src -name '*.ts')\nEOF`;
    const out = formatToolUse('Bash', { command: cmd });
    expect(out).not.toContain('\n');
    expect(out.startsWith('$ ')).toBe(true);
  });

  it('formatToolUse output never contains a newline for any free-text field', () => {
    const multiline = 'line one\nline two\n\tindented';
    for (const [name, input] of [
      ['Bash', { command: multiline }],
      ['Grep', { pattern: multiline }],
      ['Agent', { description: multiline }],
      ['TaskCreate', { subject: multiline }],
    ] as const) {
      expect(formatToolUse(name, input)).not.toContain('\n');
    }
  });
});

describe('collapseWhitespace (#1170)', () => {
  it('collapses newlines, tabs, and runs of spaces to a single space and trims', () => {
    expect(collapseWhitespace('  a\n\nb\t c   d  ')).toBe('a b c d');
  });

  it('leaves a single-line string unchanged', () => {
    expect(collapseWhitespace('sed -n 1,40p scripts/x.ts')).toBe('sed -n 1,40p scripts/x.ts');
  });
});

describe('processStreamMessage — hook-activation proof (#843)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // Real captured system.init shapes (plugins arrays copied verbatim from logs).
  const initEmpty = { type: 'system', subtype: 'init', session_id: 'abc', plugins: [] as unknown[] };
  const initKaizen = {
    type: 'system',
    subtype: 'init',
    session_id: 'abc',
    plugins: [{ name: 'kaizen', path: '/x/marketplaces/kaizen/', source: 'kaizen@kaizen' }],
  };

  it('marks the run DEGRADED and emits a loud banner when a claude session loads plugins:[]', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = makeRunResult();
    const ctx: StreamContext = { provider: 'claude' };

    processStreamMessage(initEmpty, result, Date.now(), ctx);

    expect(result.hookActivation?.degraded).toBe(true);
    expect(ctx.hookActivation?.degraded).toBe(true);
    const banners = errSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(banners).toMatch(/HOOK ENFORCEMENT DEGRADED/);
    expect(banners).toMatch(/#843/);
  });

  it('marks the run active (not degraded) when the kaizen plugin loaded', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = makeRunResult();
    const ctx: StreamContext = { provider: 'claude' };

    processStreamMessage(initKaizen, result, Date.now(), ctx);

    expect(result.hookActivation?.active).toBe(true);
    expect(result.hookActivation?.degraded).toBe(false);
  });

  it('does not degrade a codex run with no plugins (no hook runtime expected)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = makeRunResult();
    const ctx: StreamContext = { provider: 'codex' };

    processStreamMessage(initEmpty, result, Date.now(), ctx);

    expect(result.hookActivation?.degraded).toBe(false);
    expect(result.hookActivation?.expected).toBe(false);
  });

  it('does NOT evaluate when called without ctx (replay/harness path must not misclassify)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = makeRunResult();
    // No ctx → provider unknown → opt out. A replayed codex log with plugins:[]
    // must not be flagged as a degraded claude run.
    processStreamMessage(initEmpty, result, Date.now());
    expect(result.hookActivation).toBeUndefined();
  });

  it('surfaces the degraded state in the in-flight progress comment', () => {
    const result = makeRunResult();
    const ctx: StreamContext = {
      provider: 'claude',
      hookActivation: {
        provider: 'claude',
        expected: true,
        active: false,
        degraded: true,
        observedPlugins: [],
        message: 'kaizen plugin NOT loaded',
      },
    };
    const comment = buildInFlightComment(1, Date.now(), result, ctx);
    expect(comment).toMatch(/DEGRADED/);
    expect(comment).toMatch(/#843/);
  });
});
