import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeIgnoredTestDir } from '../src/lib/test-dirs.js';
import {
  TRANSCRIPT_BUNDLE_MANIFEST_FILE,
  type TranscriptBundleManifest,
} from '../src/transcript-bundle.js';
import { analyzeBatch } from './auto-dent-analyze.js';
import { formatTranscriptBundleAttachment } from './transcript-bundle-upload.js';
import {
  formatTranscriptBundleUnavailableDiagnostic,
  parseTranscriptBundleAttachment,
  parseWorkflowRunId,
  readProgressIssueTranscriptBundle,
  unpackTranscriptBundleArtifact,
} from './transcript-bundle-download.js';

function manifest(overrides: Partial<TranscriptBundleManifest> = {}): TranscriptBundleManifest {
  return {
    version: 1,
    batch_id: 'batch-test',
    repo: 'Garsson-io/kaizen',
    progress_issue: 1706,
    transport: 'github-actions-artifact',
    artifact_name: 'auto-dent-transcripts-batch-test',
    artifact_url: 'https://github.com/Garsson-io/kaizen/actions/runs/123456',
    created_at: '2026-06-29T00:00:00.000Z',
    expires_at: '2026-09-27T00:00:00.000Z',
    content_encoding: 'tar+gzip',
    scrubbed: true,
    truncated: false,
    status: 'ready',
    bundle: {
      path: 'auto-dent-transcripts-batch-test.tar.gz',
      bytes: 123,
      sha256: 'a'.repeat(64),
    },
    files: [
      {
        path: 'run-1-test.log',
        bytes: 123,
        sha256: 'b'.repeat(64),
        redactions: 0,
      },
    ],
    ...overrides,
  };
}

function jsonLine(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function writeBundleArtifact(manifestValue: TranscriptBundleManifest): string {
  const artifactDir = makeIgnoredTestDir('transcript-artifact');
  const stageDir = makeIgnoredTestDir('transcript-stage');
  writeFileSync(
    join(stageDir, 'run-1-test.log'),
    [
      jsonLine({ type: 'user', timestamp: '2026-06-29T00:00:00.000Z', message: { content: [] } }),
      jsonLine({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'x' } }] },
      }),
      jsonLine({ type: 'user', timestamp: '2026-06-29T00:01:00.000Z', message: { content: [] } }),
      jsonLine({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'x' } }] },
      }),
    ].join('\n') + '\n',
  );
  writeFileSync(
    join(stageDir, TRANSCRIPT_BUNDLE_MANIFEST_FILE),
    `${JSON.stringify(manifestValue, null, 2)}\n`,
  );

  const archivePath = join(artifactDir, 'auto-dent-transcripts-batch-test.tar.gz');
  const result = spawnSync(
    'tar',
    ['-czf', archivePath, 'run-1-test.log', TRANSCRIPT_BUNDLE_MANIFEST_FILE],
    { cwd: stageDir, encoding: 'utf8' },
  );
  expect(result.status).toBe(0);
  return artifactDir;
}

describe('transcript bundle progress issue reader', () => {
  it('parses the manifest attachment body produced by the upload helper', () => {
    const parsed = parseTranscriptBundleAttachment(formatTranscriptBundleAttachment(manifest()));

    expect(parsed.batch_id).toBe('batch-test');
    expect(parsed.artifact_name).toBe('auto-dent-transcripts-batch-test');
  });

  it('extracts workflow run id from Actions artifact URLs', () => {
    expect(parseWorkflowRunId('https://github.com/Garsson-io/kaizen/actions/runs/987654321')).toBe(987654321);
  });

  it('downloads, safely unpacks, and feeds a ready bundle to analyzeBatch', async () => {
    const manifestValue = manifest();
    const artifactDir = writeBundleArtifact(manifestValue);
    const result = await readProgressIssueTranscriptBundle({
      issueNumber: '1706',
      repo: 'Garsson-io/kaizen',
      read: () => ({
        name: 'batch-transcript-bundle',
        content: formatTranscriptBundleAttachment(manifestValue),
      }),
      download: async () => ({ artifactDir }),
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(result.diagnostic);
    try {
      const analysis = analyzeBatch(result.batchDir);
      expect(analysis.batchId).toBe('batch-test');
      expect(analysis.runs).toHaveLength(1);
      expect(analysis.runs[0].coldStartSec).toBe(60);
    } finally {
      result.cleanup();
    }
  });

  it('preserves a missing-manifest result for the legacy diagnostic path', async () => {
    const result = await readProgressIssueTranscriptBundle({
      issueNumber: '1706',
      repo: 'Garsson-io/kaizen',
      read: () => null,
    });

    expect(result.status).toBe('missing');
    expect(result.diagnostic).toContain('No batch-transcript-bundle attachment');
  });

  it('reports malformed manifest attachments without downloading', async () => {
    const result = await readProgressIssueTranscriptBundle({
      issueNumber: '1706',
      repo: 'Garsson-io/kaizen',
      read: () => ({ name: 'batch-transcript-bundle', content: 'not a manifest' }),
      download: async () => {
        throw new Error('download should not run');
      },
    });

    expect(result.status).toBe('unavailable');
    expect(result.diagnostic).toContain('manifest is malformed');
  });

  it('reports missing artifacts with an unavailable diagnostic', async () => {
    const result = await readProgressIssueTranscriptBundle({
      issueNumber: '1706',
      repo: 'Garsson-io/kaizen',
      read: () => ({
        name: 'batch-transcript-bundle',
        content: formatTranscriptBundleAttachment(manifest()),
      }),
      download: async () => {
        throw new Error('artifact not found');
      },
    });

    expect(result.status).toBe('unavailable');
    expect(result.diagnostic).toContain('artifact not found');
    if (result.status === 'unavailable') {
      expect(formatTranscriptBundleUnavailableDiagnostic({
        issueNumber: '1706',
        repo: 'Garsson-io/kaizen',
        result,
      })).toContain('Run transcript logs are not available');
    }
  });

  it('rejects unsafe tar entries before extraction', () => {
    const manifestValue = manifest({ bundle: { path: 'unsafe.tar.gz', bytes: 1, sha256: 'c'.repeat(64) } });
    const artifactDir = makeIgnoredTestDir('transcript-unsafe-artifact');
    const stageDir = makeIgnoredTestDir('transcript-unsafe-stage');
    mkdirSync(join(stageDir, 'safe'), { recursive: true });
    writeFileSync(join(stageDir, 'safe', 'run-1-test.log'), 'x\n');
    const archivePath = join(artifactDir, 'unsafe.tar.gz');
    const result = spawnSync(
      'tar',
      ['--transform=s#safe/run-1-test.log#../evil.log#', '-czf', archivePath, 'safe/run-1-test.log'],
      { cwd: stageDir, encoding: 'utf8' },
    );
    expect(result.status).toBe(0);

    expect(() => unpackTranscriptBundleArtifact(artifactDir, manifestValue)).toThrow(/Unsafe transcript bundle entry/);
  });
});
