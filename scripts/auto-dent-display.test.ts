import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import {
  collapseWhitespace,
  prettifyPath,
  relativizeWorktreePath,
  renderCommandForDisplay,
  renderPhaseMarkerSummary,
  renderToolInputSummary,
  renderToolUse,
  stripCdPrefix,
  truncateAtWordBoundary,
  truncateDisplay,
} from './auto-dent-display.js';

describe('auto-dent display text helpers (#1348)', () => {
  it('collapses arbitrary free text to one display line', () => {
    expect(collapseWhitespace(' line one\n\tline two   line three ')).toBe(
      'line one line two line three',
    );
  });

  it('truncates after whitespace collapse with a visible one-character ellipsis', () => {
    expect(truncateDisplay('abc\n  def ghi', 8)).toBe('abc def…');
  });

  it('leaves already short display text unchanged', () => {
    expect(truncateDisplay('short text', 20)).toBe('short text');
  });

  it('supports the existing word-boundary title contract', () => {
    expect(truncateAtWordBoundary('improve hooks, testing, and more stuff here', 25)).toBe(
      'improve hooks, testing...',
    );
    expect(truncateAtWordBoundary('abcdefghijklmnopqrstuvwxyz', 10)).toBe(
      'abcdefghij...',
    );
  });

  it('normalizes worktree paths while preserving non-worktree text (#1489)', () => {
    expect(
      relativizeWorktreePath('/home/aviad/projects/kaizen/.claude/worktrees/260628-1517-k1490-runtime-contracts/scripts/auto-dent-display.ts'),
    ).toBe('scripts/auto-dent-display.ts');
    expect(prettifyPath('/home/aviad/projects/kaizen/src/index.ts')).toBe('~/projects/kaizen/src/index.ts');
    expect(prettifyPath('/tmp/not-a-worktree/file.txt')).toBe('/tmp/not-a-worktree/file.txt');
  });

  it('prettifies and line-budgets long commands through one renderer (#1489)', () => {
    const command = 'cd /home/aviad/projects/kaizen/.claude/worktrees/260628-1517-k1490-runtime-contracts && npm run test -- scripts/auto-dent-display.test.ts --reporter verbose';

    expect(stripCdPrefix(command)).toBe('npm run test -- scripts/auto-dent-display.test.ts --reporter verbose');
    expect(renderCommandForDisplay(command, 48)).toBe('npm run test -- scripts/auto-dent-display.test.…');
  });

  it('renders tool summaries through the shared renderer contract (#1489)', () => {
    expect(renderToolUse('Read', {
      file_path: '/home/aviad/projects/kaizen/.claude/worktrees/260628-1517-k1490-runtime-contracts/scripts/auto-dent-stream.ts',
    })).toBe('Read scripts/auto-dent-stream.ts');
    expect(renderToolUse('Bash', {
      command: 'cd /home/aviad/projects/kaizen/.claude/worktrees/260628-1517-k1490-runtime-contracts; git status --short --branch',
    })).toBe('$ git status --short --branch');
    expect(renderToolInputSummary('Grep', { pattern: 'AUTO_DENT_PHASE: PICK and a very long pattern' })).toBe(
      '"AUTO_DENT_PHASE: PICK and a ve"',
    );
  });

  it('renders phase/event summaries through the shared renderer contract (#1489)', () => {
    expect(renderPhaseMarkerSummary({
      phase: 'PICK',
      fields: {
        issue: '#1490',
        title: 'consolidate auto-dent provider lifecycle records',
      },
    }, '[PICK]')).toBe('[PICK] #1490 consolidate auto-dent provider lifecycle records');

    const long = renderPhaseMarkerSummary({
      phase: 'REFLECT',
      fields: { lessons: 'x'.repeat(160) },
    }, '[REFLECT]');
    expect(long).toHaveLength(120);
    expect(long.endsWith('\u2026')).toBe(true);
  });
});

describe('auto-dent display ownership invariant (#1348)', () => {
  it('keeps migrated Auto-dent files from reintroducing private generic truncators', () => {
    const migratedFiles = [
      'scripts/auto-dent-stream.ts',
      'scripts/auto-dent-analyze.ts',
      'scripts/auto-dent-run.ts',
    ];

    for (const file of migratedFiles) {
      const source = readFileSync(file, 'utf8');
      expect(source, `${file} should use scripts/auto-dent-display.ts`).not.toMatch(
        /function\s+truncate(?:Input|AtWord)?\s*\(/,
      );
    }
  });
});
