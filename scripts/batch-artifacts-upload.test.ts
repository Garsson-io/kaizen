import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildArtifactsComment,
  readArtifactParts,
  type ArtifactParts,
  BATCH_ARTIFACTS_ATTACHMENT,
  ARTIFACTS_BODY_BUDGET,
  GITHUB_COMMENT_LIMIT,
} from './batch-artifacts-upload.js';

const NOW = '2026-06-26T17:00:00Z';

function makeParts(overrides: Partial<ArtifactParts> = {}): ArtifactParts {
  return {
    batchId: 'sticky-lark',
    stateJson: JSON.stringify({ batch_id: 'sticky-lark', run: 3, prs: ['x'] }, null, 2),
    eventsJsonl:
      '{"kind":"run_start","run":1}\n{"kind":"run_pr_created","run":1}\n{"kind":"run_complete","run":1}',
    summary: 'Runs: 3\nPRs: 1',
    ...overrides,
  };
}

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});
function freshBatchDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'batch-artifacts-'));
  tmpDirs.push(d);
  return d;
}

describe('buildArtifactsComment', () => {
  it('inlines events.jsonl and state.json in collapsed details with a correct event count', () => {
    const body = buildArtifactsComment(makeParts(), NOW);
    expect(body).toContain('## Batch Artifacts: `sticky-lark`');
    expect(body).toContain(NOW);
    // event count = 3 non-empty lines
    expect(body).toContain('events.jsonl (3 events)');
    expect(body).toContain('<summary>state.json</summary>');
    expect(body).toContain('```jsonl');
    expect(body).toContain('```json');
    // No marker — writeAttachment prepends it.
    expect(body).not.toContain('<!-- kaizen:');
    // Points humans at the on-disk source.
    expect(body).toContain('logs/auto-dent/sticky-lark');
  });

  it('includes the batch summary block when present and omits it when absent', () => {
    expect(buildArtifactsComment(makeParts(), NOW)).toContain('### Batch Summary');
    expect(buildArtifactsComment(makeParts({ summary: null }), NOW)).not.toContain(
      '### Batch Summary',
    );
  });

  it('produces a valid, non-empty comment for an empty batch (0 events)', () => {
    const body = buildArtifactsComment(
      makeParts({ eventsJsonl: '', summary: null, stateJson: '{}' }),
      NOW,
    );
    expect(body).toContain('## Batch Artifacts: `sticky-lark`');
    // 0 events → events block omitted, no crash, state still inlined.
    expect(body).not.toContain('events.jsonl');
    expect(body).toContain('<summary>state.json</summary>');
  });

  it('handles a missing events.jsonl gracefully (section omitted)', () => {
    const body = buildArtifactsComment(makeParts({ eventsJsonl: null }), NOW);
    expect(body).not.toContain('events.jsonl');
    expect(body).toContain('state.json');
  });

  it('handles a missing state.json gracefully (section omitted)', () => {
    const body = buildArtifactsComment(makeParts({ stateJson: null }), NOW);
    expect(body).not.toContain('<summary>state.json</summary>');
    expect(body).toContain('events.jsonl');
  });

  it('truncates an oversized events.jsonl head+tail to stay under budget', () => {
    // ~120K of events — well over the comment limit.
    const huge = Array.from({ length: 4000 }, (_, i) => `{"kind":"run_complete","run":${i}}`).join(
      '\n',
    );
    const body = buildArtifactsComment(makeParts({ eventsJsonl: huge }), NOW);

    expect(body.length).toBeLessThanOrEqual(ARTIFACTS_BODY_BUDGET);
    expect(body.length).toBeLessThanOrEqual(GITHUB_COMMENT_LIMIT);
    // Truncation is announced and points at the on-disk copy.
    expect(body).toMatch(/lines truncated — full data on disk at logs\/auto-dent\/sticky-lark/);
    expect(body).toContain('truncated)'); // the <summary> is relabelled
    // Head and tail are both retained.
    expect(body).toContain('"run":0}');
    expect(body).toContain('"run":3999}');
  });

  it('truncates state.json too when both blocks are oversized', () => {
    const hugeEvents = Array.from({ length: 2000 }, (_, i) => `{"run":${i}}`).join('\n');
    const hugeState = JSON.stringify(
      { batch_id: 'sticky-lark', blob: 'x'.repeat(60_000) },
      null,
      2,
    );
    const body = buildArtifactsComment(
      makeParts({ eventsJsonl: hugeEvents, stateJson: hugeState }),
      NOW,
    );
    expect(body.length).toBeLessThanOrEqual(ARTIFACTS_BODY_BUDGET);
    expect(body).toContain('## Batch Artifacts: `sticky-lark`'); // header always survives
  });
});

describe('readArtifactParts', () => {
  it('reads state.json, events.jsonl, and summary from a batch dir', () => {
    const dir = freshBatchDir();
    writeFileSync(join(dir, 'state.json'), '{"run":2}');
    writeFileSync(join(dir, 'events.jsonl'), '{"kind":"run_start"}');
    writeFileSync(join(dir, 'batch-summary.txt'), 'all good');

    const parts = readArtifactParts(dir);
    expect(parts.batchId).toBe(dir.split('/').pop());
    expect(parts.stateJson).toBe('{"run":2}');
    expect(parts.eventsJsonl).toBe('{"kind":"run_start"}');
    expect(parts.summary).toBe('all good');
  });

  it('tolerates missing files (each becomes null)', () => {
    const dir = freshBatchDir();
    writeFileSync(join(dir, 'state.json'), '{}');
    const parts = readArtifactParts(dir);
    expect(parts.stateJson).toBe('{}');
    expect(parts.eventsJsonl).toBeNull();
    expect(parts.summary).toBeNull();
  });

  it('falls back to batch-summary-report.md when batch-summary.txt is absent', () => {
    const dir = freshBatchDir();
    writeFileSync(join(dir, 'batch-summary-report.md'), '# report');
    expect(readArtifactParts(dir).summary).toBe('# report');
  });
});

describe('attachment contract', () => {
  it('uses a stable marker name (idempotency contract with writeAttachment)', () => {
    // The marker name is the cross-run identity that makes finalize idempotent —
    // it must not drift, or re-runs would post duplicate artifact comments.
    expect(BATCH_ARTIFACTS_ATTACHMENT).toBe('batch-artifacts');
  });
});
