import { afterEach, describe, expect, it, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeIgnoredTestDir } from '../src/lib/test-dirs.js';
import type { TranscriptBundleManifest } from '../src/transcript-bundle.js';
import {
  BATCH_TRANSCRIPT_BUNDLE_ATTACHMENT,
  formatTranscriptBundleAttachment,
  uploadBatchTranscriptBundle,
} from './transcript-bundle-upload.js';

const NOW = '2026-06-29T18:00:00.000Z';
const ENV = {
  GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_REPOSITORY: 'Garsson-io/kaizen',
  GITHUB_RUN_ID: '28382697382',
};

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function freshBatchDir(): string {
  const dir = makeIgnoredTestDir('transcript-upload');
  tmpDirs.push(dir);
  return dir;
}

function manifestFromAttachment(body: string): TranscriptBundleManifest {
  const match = body.match(/```json\n([\s\S]*?)\n```/);
  if (!match) throw new Error(`missing manifest JSON block:\n${body}`);
  return JSON.parse(match[1]);
}

describe('uploadBatchTranscriptBundle', () => {
  it('uploads a ready bundle and writes only the manifest attachment', async () => {
    const dir = freshBatchDir();
    writeFileSync(join(dir, 'run-1.log'), 'hello\nANTHROPIC_API_KEY=sk-ant-deadbeefdeadbeef0000\n');
    const upload = vi.fn(async () => ({ id: 123, size: 456, digest: 'sha256:artifact-digest' }));
    const writes: Array<{ target: unknown; name: string; body: string }> = [];

    const result = await uploadBatchTranscriptBundle({
      issueNumber: '1705',
      repo: 'Garsson-io/kaizen',
      batchDir: dir,
      nowIso: NOW,
      retentionDays: 7,
      env: ENV,
      upload,
      write: (target, name, body) => {
        writes.push({ target, name, body });
        return 'https://github.com/Garsson-io/kaizen/issues/1705#issuecomment-1';
      },
    });

    expect(result.status).toBe('uploaded');
    expect(upload).toHaveBeenCalledOnce();
    const [artifactName, files, rootDirectory, options] = upload.mock.calls[0];
    expect(artifactName).toBe(result.manifest.artifact_name);
    expect(files).toEqual([result.bundlePath]);
    expect(result.bundlePath?.startsWith(rootDirectory)).toBe(true);
    expect(options).toEqual({ compressionLevel: 0, retentionDays: 7 });

    expect(writes).toHaveLength(1);
    expect(writes[0].target).toEqual({ kind: 'issue', number: '1705', repo: 'Garsson-io/kaizen' });
    expect(writes[0].name).toBe(BATCH_TRANSCRIPT_BUNDLE_ATTACHMENT);
    expect(writes[0].body).not.toContain('sk-ant-deadbeefdeadbeef0000');

    const manifest = manifestFromAttachment(writes[0].body);
    expect(manifest.status).toBe('ready');
    expect(manifest.artifact_url).toBe('https://github.com/Garsson-io/kaizen/actions/runs/28382697382');
    expect(manifest.expires_at).toBe('2026-07-06T18:00:00.000Z');
    expect(manifest.files).toHaveLength(1);
  });

  it('writes an upload_failed diagnostic when the artifact adapter rejects', async () => {
    const dir = freshBatchDir();
    writeFileSync(join(dir, 'run-1.log'), 'hello\n');
    const upload = vi.fn(async () => {
      throw new Error('artifact service unavailable');
    });
    const writes: Array<{ body: string }> = [];

    const result = await uploadBatchTranscriptBundle({
      issueNumber: '1705',
      repo: 'Garsson-io/kaizen',
      batchDir: dir,
      nowIso: NOW,
      env: ENV,
      upload,
      write: (_target, _name, body) => {
        writes.push({ body });
        return 'url';
      },
    });

    expect(result.status).toBe('upload_failed');
    expect(upload).toHaveBeenCalledOnce();
    const manifest = manifestFromAttachment(writes[0].body);
    expect(manifest.status).toBe('upload_failed');
    expect(manifest.diagnostic).toContain('artifact service unavailable');
  });

  it('writes an unauthorized diagnostic when no Actions runtime credentials are available', async () => {
    const dir = freshBatchDir();
    writeFileSync(join(dir, 'run-1.log'), 'hello\n');
    const writes: Array<{ body: string }> = [];

    const result = await uploadBatchTranscriptBundle({
      issueNumber: '1705',
      repo: 'Garsson-io/kaizen',
      batchDir: dir,
      nowIso: NOW,
      env: {},
      write: (_target, _name, body) => {
        writes.push({ body });
        return 'url';
      },
    });

    expect(result.status).toBe('skipped');
    const manifest = manifestFromAttachment(writes[0].body);
    expect(manifest.status).toBe('unauthorized');
    expect(manifest.diagnostic).toContain('Actions artifact runtime credentials are unavailable');
  });

  it('does not call the uploader when bundle building returns a scrub failure', async () => {
    const upload = vi.fn(async () => ({ id: 1 }));
    const manifest: TranscriptBundleManifest = {
      version: 1,
      batch_id: 'batch-x',
      repo: 'Garsson-io/kaizen',
      progress_issue: 1705,
      transport: 'github-actions-artifact',
      artifact_name: 'auto-dent-transcripts-batch-x',
      created_at: NOW,
      content_encoding: 'tar+gzip',
      scrubbed: false,
      truncated: false,
      status: 'scrub_failed',
      diagnostic: 'Secret scrubbing failed closed for run-1.log',
      files: [],
    };
    const writes: Array<{ body: string }> = [];

    const result = await uploadBatchTranscriptBundle({
      issueNumber: '1705',
      repo: 'Garsson-io/kaizen',
      batchDir: '/tmp/does-not-matter',
      nowIso: NOW,
      upload,
      build: () => ({ manifest, bundlePath: null }),
      write: (_target, _name, body) => {
        writes.push({ body });
        return 'url';
      },
    });

    expect(result.status).toBe('skipped');
    expect(upload).not.toHaveBeenCalled();
    expect(writes[0].body).toContain('"status": "scrub_failed"');
  });
});

describe('formatTranscriptBundleAttachment', () => {
  it('formats a manifest/index without embedding transcript text', () => {
    const body = formatTranscriptBundleAttachment({
      version: 1,
      batch_id: 'batch-x',
      transport: 'github-actions-artifact',
      artifact_name: 'auto-dent-transcripts-batch-x',
      created_at: NOW,
      content_encoding: 'tar+gzip',
      scrubbed: true,
      truncated: false,
      status: 'ready',
      files: [{ path: 'run-1.log', bytes: 5, sha256: 'a'.repeat(64), redactions: 0 }],
    });

    expect(body).toContain('## Batch Transcript Bundle: `batch-x`');
    expect(body).toContain('"artifact_name": "auto-dent-transcripts-batch-x"');
    expect(body).not.toContain('run transcript text');
  });
});
