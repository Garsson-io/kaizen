import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeIgnoredTestDir } from './lib/test-dirs.js';
import { SCRUB_FAILED } from './scrub-secrets.js';
import {
  TRANSCRIPT_BUNDLE_MANIFEST_FILE,
  TranscriptBundleManifestSchema,
  buildTranscriptBundle,
} from './transcript-bundle.js';

const NOW = '2026-06-29T16:00:00.000Z';
const EXPIRES = '2026-09-27T16:00:00.000Z';

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function freshBatchDir(): string {
  const dir = makeIgnoredTestDir('transcript-bundle');
  tmpDirs.push(dir);
  return dir;
}

function tarRead(archivePath: string, file: string): string {
  const result = spawnSync('tar', ['-xOzf', archivePath, file], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || `tar exited ${result.status}`);
  }
  return result.stdout;
}

describe('buildTranscriptBundle', () => {
  it('creates a scrubbed tar/gzip bundle with file metadata and a typed manifest', () => {
    const dir = freshBatchDir();
    writeFileSync(
      join(dir, 'run-1.log'),
      'start\nANTHROPIC_API_KEY=sk-ant-deadbeefdeadbeef0000\nfinish\n',
    );
    writeFileSync(join(dir, 'run-2.log'), 'second run\n');
    writeFileSync(join(dir, 'events.jsonl'), '{"ignored":true}\n');

    const result = buildTranscriptBundle({
      batchDir: dir,
      nowIso: NOW,
      expiresAtIso: EXPIRES,
      repo: 'Garsson-io/kaizen',
      progressIssue: 1704,
    });

    expect(result.bundlePath).toBeTruthy();
    expect(existsSync(result.bundlePath!)).toBe(true);
    expect(result.manifest.status).toBe('ready');
    expect(result.manifest.batch_id).toBe(dir.split('/').pop());
    expect(result.manifest.repo).toBe('Garsson-io/kaizen');
    expect(result.manifest.progress_issue).toBe(1704);
    expect(result.manifest.expires_at).toBe(EXPIRES);
    expect(result.manifest.content_encoding).toBe('tar+gzip');
    expect(result.manifest.scrubbed).toBe(true);
    expect(result.manifest.truncated).toBe(false);
    expect(result.manifest.files.map((f) => f.path)).toEqual(['run-1.log', 'run-2.log']);
    expect(result.manifest.files[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.manifest.files[0].redactions).toBeGreaterThan(0);
    expect(result.manifest.bundle?.bytes).toBeGreaterThan(0);
    expect(result.manifest.bundle?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(TranscriptBundleManifestSchema.parse(result.manifest)).toEqual(result.manifest);

    const scrubbedRun = tarRead(result.bundlePath!, 'run-1.log');
    expect(scrubbedRun).not.toContain('sk-ant-deadbeefdeadbeef0000');
    expect(scrubbedRun).toContain('ANTHROPIC_API_KEY=');

    const archivedManifest = TranscriptBundleManifestSchema.parse(
      JSON.parse(tarRead(result.bundlePath!, TRANSCRIPT_BUNDLE_MANIFEST_FILE)),
    );
    expect(archivedManifest.status).toBe('ready');
    expect(archivedManifest.files).toHaveLength(2);
  });

  it('returns an absent diagnostic manifest when no run logs exist', () => {
    const dir = freshBatchDir();
    writeFileSync(join(dir, 'events.jsonl'), '{}\n');

    const result = buildTranscriptBundle({ batchDir: dir, nowIso: NOW });

    expect(result.bundlePath).toBeNull();
    expect(result.manifest.status).toBe('absent');
    expect(result.manifest.diagnostic).toContain('No run transcript logs found');
    expect(result.manifest.files).toEqual([]);
    expect(result.manifest.truncated).toBe(false);
  });

  it('fails closed when scrubbing fails and does not write an upload-ready archive', () => {
    const dir = freshBatchDir();
    writeFileSync(join(dir, 'run-1.log'), 'raw secret sk-ant-deadbeefdeadbeef0000\n');

    const result = buildTranscriptBundle({
      batchDir: dir,
      nowIso: NOW,
      scrub: () => ({ text: SCRUB_FAILED, redactions: -1 }),
    });

    expect(result.bundlePath).toBeNull();
    expect(result.manifest.status).toBe('scrub_failed');
    expect(result.manifest.diagnostic).toContain('failed closed');
    expect(readdirSync(dir).filter((file) => file.endsWith('.tar.gz'))).toEqual([]);
  });

  it('returns a too_large diagnostic instead of truncating or leaving a partial bundle', () => {
    const dir = freshBatchDir();
    writeFileSync(join(dir, 'run-1.log'), 'x'.repeat(2000));

    const result = buildTranscriptBundle({
      batchDir: dir,
      nowIso: NOW,
      maxBundleBytes: 1,
    });

    expect(result.bundlePath).toBeNull();
    expect(result.manifest.status).toBe('too_large');
    expect(result.manifest.diagnostic).toContain('exceeds maxBundleBytes');
    expect(result.manifest.truncated).toBe(false);
    expect(readdirSync(dir).filter((file) => file.endsWith('.tar.gz'))).toEqual([]);
  });

  it('rejects manifest shape drift through the Zod schema', () => {
    const dir = freshBatchDir();
    writeFileSync(join(dir, 'run-1.log'), 'ok\n');
    const { manifest } = buildTranscriptBundle({ batchDir: dir, nowIso: NOW });

    expect(TranscriptBundleManifestSchema.safeParse({ ...manifest, version: 2 }).success).toBe(
      false,
    );
    expect(
      TranscriptBundleManifestSchema.safeParse({ ...manifest, transport: 'issue-comment' })
        .success,
    ).toBe(false);
  });
});
