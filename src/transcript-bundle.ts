import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { SCRUB_FAILED, scrubSecrets, type ScrubResult } from './scrub-secrets.js';

export const TRANSCRIPT_BUNDLE_MANIFEST_FILE = 'transcript-bundle-manifest.json';
export const TRANSCRIPT_BUNDLE_VERSION = 1;
export const TRANSCRIPT_BUNDLE_TRANSPORT = 'github-actions-artifact';
export const TRANSCRIPT_BUNDLE_CONTENT_ENCODING = 'tar+gzip';

export const TranscriptBundleStatusSchema = z.enum([
  'ready',
  'absent',
  'scrub_failed',
  'too_large',
  'expired',
  'unauthorized',
  'malformed',
]);

export const TranscriptBundleFileSchema = z.object({
  path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  redactions: z.number().int().nonnegative(),
});

export const TranscriptBundleManifestSchema = z.object({
  version: z.literal(TRANSCRIPT_BUNDLE_VERSION),
  batch_id: z.string().min(1),
  repo: z.string().min(1).optional(),
  progress_issue: z.number().int().positive().optional(),
  transport: z.literal(TRANSCRIPT_BUNDLE_TRANSPORT),
  artifact_name: z.string().min(1),
  artifact_url: z.string().url().optional(),
  created_at: z.string().min(1),
  expires_at: z.string().min(1).optional(),
  content_encoding: z.literal(TRANSCRIPT_BUNDLE_CONTENT_ENCODING),
  scrubbed: z.boolean(),
  truncated: z.literal(false),
  status: TranscriptBundleStatusSchema,
  diagnostic: z.string().min(1).optional(),
  bundle: z
    .object({
      path: z.string().min(1),
      bytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
  files: z.array(TranscriptBundleFileSchema),
});

export type TranscriptBundleStatus = z.infer<typeof TranscriptBundleStatusSchema>;
export type TranscriptBundleFile = z.infer<typeof TranscriptBundleFileSchema>;
export type TranscriptBundleManifest = z.infer<typeof TranscriptBundleManifestSchema>;

export interface BuildTranscriptBundleOptions {
  batchDir: string;
  outputDir?: string;
  batchId?: string;
  repo?: string;
  progressIssue?: number;
  nowIso?: string;
  expiresAtIso?: string;
  artifactName?: string;
  artifactUrl?: string;
  maxBundleBytes?: number;
  scrub?: (text: unknown) => ScrubResult;
}

export interface BuildTranscriptBundleResult {
  manifest: TranscriptBundleManifest;
  bundlePath: string | null;
}

interface ScrubbedTranscript {
  path: string;
  content: string;
  meta: TranscriptBundleFile;
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function fileSha256(path: string): string {
  return sha256(readFileSync(path));
}

function safeArtifactFileName(artifactName: string): string {
  return artifactName.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'auto-dent-transcripts';
}

function manifestFor(
  options: {
    batchId: string;
    repo?: string;
    progressIssue?: number;
    nowIso: string;
    expiresAtIso?: string;
    artifactName: string;
    artifactUrl?: string;
  },
  fields: {
    status: TranscriptBundleStatus;
    scrubbed: boolean;
    diagnostic?: string;
    files?: TranscriptBundleFile[];
    bundle?: TranscriptBundleManifest['bundle'];
  },
): TranscriptBundleManifest {
  return TranscriptBundleManifestSchema.parse({
    version: TRANSCRIPT_BUNDLE_VERSION,
    batch_id: options.batchId,
    ...(options.repo ? { repo: options.repo } : {}),
    ...(options.progressIssue ? { progress_issue: options.progressIssue } : {}),
    transport: TRANSCRIPT_BUNDLE_TRANSPORT,
    artifact_name: options.artifactName,
    ...(options.artifactUrl ? { artifact_url: options.artifactUrl } : {}),
    created_at: options.nowIso,
    ...(options.expiresAtIso ? { expires_at: options.expiresAtIso } : {}),
    content_encoding: TRANSCRIPT_BUNDLE_CONTENT_ENCODING,
    scrubbed: fields.scrubbed,
    truncated: false,
    status: fields.status,
    ...(fields.diagnostic ? { diagnostic: fields.diagnostic } : {}),
    ...(fields.bundle ? { bundle: fields.bundle } : {}),
    files: fields.files ?? [],
  });
}

function runLogFiles(batchDir: string): string[] {
  if (!existsSync(batchDir)) return [];
  return readdirSync(batchDir)
    .filter((name) => {
      if (!/^run-[^/]+\.log$/.test(name)) return false;
      try {
        return statSync(join(batchDir, name)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

function scrubRunLogs(
  batchDir: string,
  files: string[],
  scrub: (text: unknown) => ScrubResult,
): ScrubbedTranscript[] | { error: string } {
  const scrubbed: ScrubbedTranscript[] = [];

  for (const file of files) {
    const raw = readFileSync(join(batchDir, file), 'utf8');
    const result = scrub(raw);
    if (result.redactions < 0 || result.text === SCRUB_FAILED) {
      return { error: `Secret scrubbing failed closed for ${file}; upload-ready bundle withheld.` };
    }

    scrubbed.push({
      path: file,
      content: result.text,
      meta: {
        path: file,
        bytes: Buffer.byteLength(result.text, 'utf8'),
        sha256: sha256(result.text),
        redactions: result.redactions,
      },
    });
  }

  return scrubbed;
}

function writeStage(stageDir: string, scrubbed: ScrubbedTranscript[], manifest: TranscriptBundleManifest): void {
  for (const file of scrubbed) {
    writeFileSync(join(stageDir, file.path), file.content);
  }
  writeFileSync(join(stageDir, TRANSCRIPT_BUNDLE_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}

function createTarGzip(stageDir: string, archivePath: string, entries: string[]): void {
  const result = spawnSync('tar', ['-czf', archivePath, ...entries], {
    cwd: stageDir,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`tar exited ${result.status}: ${result.stderr.trim()}`);
  }
}

export function buildTranscriptBundle(options: BuildTranscriptBundleOptions): BuildTranscriptBundleResult {
  const batchId = options.batchId ?? basename(options.batchDir);
  const nowIso = options.nowIso ?? new Date().toISOString();
  const artifactName = options.artifactName ?? `auto-dent-transcripts-${batchId}`;
  const manifestOptions = {
    batchId,
    repo: options.repo,
    progressIssue: options.progressIssue,
    nowIso,
    expiresAtIso: options.expiresAtIso,
    artifactName,
    artifactUrl: options.artifactUrl,
  };

  const files = runLogFiles(options.batchDir);
  if (files.length === 0) {
    return {
      bundlePath: null,
      manifest: manifestFor(manifestOptions, {
        status: 'absent',
        scrubbed: true,
        diagnostic: `No run transcript logs found in ${options.batchDir}.`,
      }),
    };
  }

  const scrubbed = scrubRunLogs(options.batchDir, files, options.scrub ?? scrubSecrets);
  if ('error' in scrubbed) {
    return {
      bundlePath: null,
      manifest: manifestFor(manifestOptions, {
        status: 'scrub_failed',
        scrubbed: false,
        diagnostic: scrubbed.error,
      }),
    };
  }

  const fileMetadata = scrubbed.map((file) => file.meta);
  const archiveManifest = manifestFor(manifestOptions, {
    status: 'ready',
    scrubbed: true,
    files: fileMetadata,
  });

  const outputDir = options.outputDir ?? options.batchDir;
  mkdirSync(outputDir, { recursive: true });
  const archivePath = join(outputDir, `${safeArtifactFileName(artifactName)}.tar.gz`);
  const stageDir = mkdtempSync(join(tmpdir(), 'kaizen-transcript-bundle-'));

  try {
    rmSync(archivePath, { force: true });
    writeStage(stageDir, scrubbed, archiveManifest);
    createTarGzip(stageDir, archivePath, [...files, TRANSCRIPT_BUNDLE_MANIFEST_FILE]);

    const archiveBytes = statSync(archivePath).size;
    if (options.maxBundleBytes !== undefined && archiveBytes > options.maxBundleBytes) {
      rmSync(archivePath, { force: true });
      return {
        bundlePath: null,
        manifest: manifestFor(manifestOptions, {
          status: 'too_large',
          scrubbed: true,
          files: fileMetadata,
          diagnostic:
            `Transcript bundle ${archiveBytes} bytes exceeds maxBundleBytes ` +
            `${options.maxBundleBytes}; bundle withheld without truncation.`,
        }),
      };
    }

    return {
      bundlePath: archivePath,
      manifest: manifestFor(manifestOptions, {
        status: 'ready',
        scrubbed: true,
        files: fileMetadata,
        bundle: {
          path: archivePath,
          bytes: archiveBytes,
          sha256: fileSha256(archivePath),
        },
      }),
    };
  } catch (err) {
    rmSync(archivePath, { force: true });
    return {
      bundlePath: null,
      manifest: manifestFor(manifestOptions, {
        status: 'malformed',
        scrubbed: true,
        files: fileMetadata,
        diagnostic: err instanceof Error ? err.message : String(err),
      }),
    };
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}
