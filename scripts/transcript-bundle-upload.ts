import { dirname } from 'node:path';
import artifactClient, { type UploadArtifactOptions, type UploadArtifactResponse } from '@actions/artifact';
import { writeAttachment, type AttachmentTarget } from '../src/section-editor.js';
import {
  TranscriptBundleManifestSchema,
  buildTranscriptBundle,
  type BuildTranscriptBundleOptions,
  type BuildTranscriptBundleResult,
  type TranscriptBundleManifest,
} from '../src/transcript-bundle.js';

export const BATCH_TRANSCRIPT_BUNDLE_ATTACHMENT = 'batch-transcript-bundle';
export const DEFAULT_TRANSCRIPT_ARTIFACT_RETENTION_DAYS = 90;

export type ArtifactUploader = (
  name: string,
  files: string[],
  rootDirectory: string,
  options?: UploadArtifactOptions,
) => Promise<UploadArtifactResponse>;

export type UploadTranscriptBundleStatus = 'uploaded' | 'skipped' | 'upload_failed';

export interface UploadTranscriptBundleResult {
  status: UploadTranscriptBundleStatus;
  manifest: TranscriptBundleManifest;
  bundlePath: string | null;
  attachmentUrl: string;
}

export interface UploadBatchTranscriptBundleInput {
  issueNumber: string;
  repo: string;
  batchDir: string;
  nowIso?: string;
  retentionDays?: number;
  maxBundleBytes?: number;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  build?: (options: BuildTranscriptBundleOptions) => BuildTranscriptBundleResult;
  upload?: ArtifactUploader;
  write?: (target: AttachmentTarget, name: string, body: string) => string;
}

function addDaysIso(nowIso: string, days: number): string {
  return new Date(new Date(nowIso).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function runtimeUploadAvailable(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  return Boolean(env.ACTIONS_RUNTIME_TOKEN && env.ACTIONS_RESULTS_URL);
}

function artifactRunUrl(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  repo: string,
): string | undefined {
  const runId = env.GITHUB_RUN_ID;
  if (!runId) return undefined;
  const server = env.GITHUB_SERVER_URL ?? 'https://github.com';
  const repository = env.GITHUB_REPOSITORY ?? repo;
  return `${server.replace(/\/$/, '')}/${repository}/actions/runs/${runId}`;
}

function updateManifest(
  manifest: TranscriptBundleManifest,
  patch: Partial<TranscriptBundleManifest>,
): TranscriptBundleManifest {
  return TranscriptBundleManifestSchema.parse({ ...manifest, ...patch });
}

export function formatTranscriptBundleAttachment(manifest: TranscriptBundleManifest): string {
  const diagnostic = manifest.diagnostic ? `\n\nDiagnostic: ${manifest.diagnostic}` : '';
  return [
    `## Batch Transcript Bundle: \`${manifest.batch_id}\``,
    '',
    `_Status: \`${manifest.status}\`. Full transcript payload is stored in the Actions artifact when status is \`ready\`; this attachment is only the manifest/index._`,
    diagnostic,
    '',
    '```json',
    JSON.stringify(manifest, null, 2),
    '```',
  ].join('\n');
}

export async function defaultActionsArtifactUpload(
  name: string,
  files: string[],
  rootDirectory: string,
  options?: UploadArtifactOptions,
): Promise<UploadArtifactResponse> {
  return artifactClient.uploadArtifact(name, files, rootDirectory, options);
}

export async function uploadBatchTranscriptBundle(
  input: UploadBatchTranscriptBundleInput,
): Promise<UploadTranscriptBundleResult> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const env = input.env ?? process.env;
  const retentionDays = input.retentionDays ?? DEFAULT_TRANSCRIPT_ARTIFACT_RETENTION_DAYS;
  const build = input.build ?? buildTranscriptBundle;
  const write = input.write ?? writeAttachment;
  const progressIssue = Number(input.issueNumber);
  const artifactUrl = artifactRunUrl(env, input.repo);
  const built = build({
    batchDir: input.batchDir,
    repo: input.repo,
    progressIssue: Number.isFinite(progressIssue) ? progressIssue : undefined,
    nowIso,
    expiresAtIso: addDaysIso(nowIso, retentionDays),
    artifactUrl,
    maxBundleBytes: input.maxBundleBytes,
  });

  const target: AttachmentTarget = { kind: 'issue', number: input.issueNumber, repo: input.repo };

  if (built.manifest.status !== 'ready' || !built.bundlePath) {
    const attachmentUrl = write(
      target,
      BATCH_TRANSCRIPT_BUNDLE_ATTACHMENT,
      formatTranscriptBundleAttachment(built.manifest),
    );
    return { status: 'skipped', manifest: built.manifest, bundlePath: null, attachmentUrl };
  }

  const upload = input.upload ?? defaultActionsArtifactUpload;
  if (!input.upload && !runtimeUploadAvailable(env)) {
    const manifest = updateManifest(built.manifest, {
      status: 'unauthorized',
      diagnostic:
        'Actions artifact runtime credentials are unavailable; transcript bundle remains local and was not uploaded.',
    });
    const attachmentUrl = write(
      target,
      BATCH_TRANSCRIPT_BUNDLE_ATTACHMENT,
      formatTranscriptBundleAttachment(manifest),
    );
    return { status: 'skipped', manifest, bundlePath: null, attachmentUrl };
  }

  try {
    await upload(
      built.manifest.artifact_name,
      [built.bundlePath],
      dirname(built.bundlePath),
      { compressionLevel: 0, retentionDays },
    );
    const manifest = updateManifest(built.manifest, {
      status: 'ready',
      artifact_url: artifactUrl,
    });
    const attachmentUrl = write(
      target,
      BATCH_TRANSCRIPT_BUNDLE_ATTACHMENT,
      formatTranscriptBundleAttachment(manifest),
    );
    return { status: 'uploaded', manifest, bundlePath: built.bundlePath, attachmentUrl };
  } catch (err) {
    const manifest = updateManifest(built.manifest, {
      status: 'upload_failed',
      diagnostic: `Actions artifact upload failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    const attachmentUrl = write(
      target,
      BATCH_TRANSCRIPT_BUNDLE_ATTACHMENT,
      formatTranscriptBundleAttachment(manifest),
    );
    return { status: 'upload_failed', manifest, bundlePath: null, attachmentUrl };
  }
}
