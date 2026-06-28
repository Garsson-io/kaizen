import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..');

function readRepoFile(file: string): string {
  return readFileSync(join(REPO_ROOT, file), 'utf8');
}

function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

describe('auto-dent runtime contract source invariants (#1490, #1489)', () => {
  it('keeps provider lifecycle files from defining local phase-order arrays (#1490)', () => {
    const providerLifecycleFiles = [
      'scripts/auto-dent-provider-matrix.ts',
      'scripts/auto-dent-run.ts',
      'scripts/auto-dent-events.ts',
      'scripts/batch-summary.ts',
    ];
    const localPhaseOrder = /\b(?:const|export\s+const)\s+\w*PHASE\w*(?:ORDER|DISPLAY_ORDER)\s*=\s*\[/;

    const offenders = providerLifecycleFiles.filter((file) => localPhaseOrder.test(stripComments(readRepoFile(file))));

    expect(offenders).toEqual([]);
  });

  it('keeps auto-dent display runtime files from defining local truncate helpers (#1489)', () => {
    const displayRuntimeFiles = [
      'scripts/auto-dent-stream.ts',
      'scripts/auto-dent-run.ts',
      'scripts/auto-dent-analyze.ts',
    ];
    const localTruncateHelper = /\b(?:function|const|let|var)\s+truncate[A-Z]\w*\s*(?:[:=(]|=)/;

    const offenders = displayRuntimeFiles.filter((file) => localTruncateHelper.test(stripComments(readRepoFile(file))));

    expect(offenders).toEqual([]);
  });

  it('fails synthetic local phase-order and truncate-helper fixtures', () => {
    const localPhaseOrder = /\b(?:const|export\s+const)\s+\w*PHASE\w*(?:ORDER|DISPLAY_ORDER)\s*=\s*\[/;
    const localTruncateHelper = /\b(?:function|const|let|var)\s+truncate[A-Z]\w*\s*(?:[:=(]|=)/;

    expect(localPhaseOrder.test('const PHASE_ORDER = ["planning"];')).toBe(true);
    expect(localPhaseOrder.test('const PHASE_DISPLAY_ORDER = ["planning"];')).toBe(true);
    expect(localTruncateHelper.test('function truncateCommand(input: string) { return input; }')).toBe(true);
    expect(localTruncateHelper.test('const truncatePath = (input: string) => input;')).toBe(true);
  });

  it('canonical homes own the shared contracts', () => {
    expect(readRepoFile('scripts/auto-dent-provider.ts')).toContain('export const PHASES');
    expect(readRepoFile('scripts/auto-dent-display.ts')).toContain('export function truncateDisplay');
  });
});
