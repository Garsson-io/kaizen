import artifactClient, { type ArtifactClient, type FindOptions } from '@actions/artifact';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, normalize } from 'node:path';
import { readAttachment, type AttachmentTarget } from '../src/section-editor.js';
import {
  TRANSCRIPT_BUNDLE_MANIFEST_FILE,
  TranscriptBundleManifestSchema,
  type TranscriptBundleStatus,
  type TranscriptBundleManifest,
} from '../src/transcript-bundle.js';
import { BATCH_TRANSCRIPT_BUNDLE_ATTACHMENT } from './transcript-bundle-upload.js';

export interface TranscriptArtifactDownload {
  artifactDir: string;
  cleanup?: () => void;
}

export type TranscriptArtifactDownloader = (
  manifest: TranscriptBundleManifest,
  options: {
    repo: string;
    env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  },
) => Promise<TranscriptArtifactDownload>;

export type TranscriptBundleUnavailableReason =
  | 'missing'
  | Exclude<TranscriptBundleStatus, 'ready'>
  | 'download_failed';

export type ProgressIssueTranscriptBundleResult =
  | {
      status: 'ready';
      manifest: TranscriptBundleManifest;
      batchDir: string;
      cleanup: () => void;
    }
  | {
      status: 'missing';
      reason: 'missing';
      diagnostic: string;
    }
  | {
      status: 'unavailable';
      reason: Exclude<TranscriptBundleUnavailableReason, 'missing'>;
      manifest?: TranscriptBundleManifest;
      diagnostic: string;
    };

export interface ReadProgressIssueTranscriptBundleInput {
  issueNumber: string;
  repo: string;
  nowIso?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  read?: typeof readAttachment;
  download?: TranscriptArtifactDownloader;
}

export function parseTranscriptBundleAttachment(body: string): TranscriptBundleManifest {
  const jsonFence = body.match(/```json\n([\s\S]*?)\n```/);
  if (!jsonFence) {
    throw new Error('batch-transcript-bundle attachment does not contain a JSON manifest fence');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonFence[1]);
  } catch (err) {
    throw new Error(`batch-transcript-bundle manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  return TranscriptBundleManifestSchema.parse(parsed);
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`Repository must be owner/repo, got ${repo}`);
  return { owner, name };
}

export function parseWorkflowRunId(artifactUrl: string | undefined): number {
  if (!artifactUrl) throw new Error('Transcript bundle manifest has no artifact_url');
  const match = artifactUrl.match(/\/actions\/runs\/(\d+)(?:[/?#]|$)/);
  if (!match) throw new Error(`Transcript bundle artifact_url does not contain a workflow run id: ${artifactUrl}`);
  return Number(match[1]);
}

function githubToken(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string {
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN or GH_TOKEN with actions:read permission is required to download transcript artifacts');
  }
  return token;
}

function isExpired(manifest: TranscriptBundleManifest, nowIso: string | undefined): boolean {
  if (!manifest.expires_at) return false;
  const expiresAt = new Date(manifest.expires_at).getTime();
  const now = nowIso ? new Date(nowIso).getTime() : Date.now();
  return Number.isFinite(expiresAt) && Number.isFinite(now) && expiresAt <= now;
}

function downloadFailureReason(err: unknown): 'unauthorized' | 'download_failed' {
  const message = err instanceof Error ? err.message : String(err);
  return /GITHUB_TOKEN|GH_TOKEN|actions:read|unauthori[sz]ed|authentication/i.test(message)
    ? 'unauthorized'
    : 'download_failed';
}

export async function defaultTranscriptArtifactDownloader(
  manifest: TranscriptBundleManifest,
  options: {
    repo: string;
    env: NodeJS.ProcessEnv | Record<string, string | undefined>;
    client?: ArtifactClient;
  },
): Promise<TranscriptArtifactDownload> {
  const { owner, name } = splitRepo(options.repo);
  const workflowRunId = parseWorkflowRunId(manifest.artifact_url);
  const token = githubToken(options.env);
  const findBy: NonNullable<FindOptions['findBy']> = {
    token,
    workflowRunId,
    repositoryOwner: owner,
    repositoryName: name,
  };
  const client = options.client ?? artifactClient;
  const artifact = await client.getArtifact(manifest.artifact_name, { findBy });
  const artifactDir = mkdtempSync(join(tmpdir(), 'kaizen-transcript-artifact-'));
  try {
    const downloaded = await client.downloadArtifact(artifact.artifact.id, {
      path: artifactDir,
      ...(artifact.artifact.digest ? { expectedHash: artifact.artifact.digest } : {}),
      findBy,
    });
    if (downloaded.digestMismatch) {
      throw new Error(`Downloaded artifact digest did not match ${artifact.artifact.digest}`);
    }
    return {
      artifactDir: downloaded.downloadPath ?? artifactDir,
      cleanup: () => rmSync(artifactDir, { recursive: true, force: true }),
    };
  } catch (err) {
    rmSync(artifactDir, { recursive: true, force: true });
    throw err;
  }
}

function tarEntries(archivePath: string): string[] {
  const result = spawnSync('tar', ['-tzf', archivePath], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`tar list failed for ${archivePath}: ${result.stderr.trim()}`);
  }
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

function validateTarEntry(entry: string): void {
  const normalized = normalize(entry).replace(/\\/g, '/');
  const allowed =
    /^run-[^/]+\.log$/.test(entry) ||
    entry === TRANSCRIPT_BUNDLE_MANIFEST_FILE;

  if (
    !entry ||
    entry.startsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    basename(entry) !== entry ||
    !allowed
  ) {
    throw new Error(`Unsafe transcript bundle entry: ${entry}`);
  }
}

function findArchive(artifactDir: string, manifest: TranscriptBundleManifest): string {
  const expected = manifest.bundle?.path ? basename(manifest.bundle.path) : null;
  const candidates = readdirSync(artifactDir)
    .filter((file) => file.endsWith('.tar.gz'))
    .sort();

  if (expected && candidates.includes(expected)) return join(artifactDir, expected);
  if (candidates.length === 1) return join(artifactDir, candidates[0]);
  if (candidates.length === 0) {
    throw new Error(`Downloaded artifact does not contain a transcript .tar.gz bundle`);
  }
  throw new Error(`Downloaded artifact contains multiple transcript bundles; expected ${expected ?? 'one .tar.gz file'}`);
}

export function unpackTranscriptBundleArtifact(
  artifactDir: string,
  manifest: TranscriptBundleManifest,
): { batchDir: string; cleanup: () => void } {
  const archivePath = findArchive(artifactDir, manifest);
  const entries = tarEntries(archivePath);
  for (const entry of entries) validateTarEntry(entry);
  if (!entries.some((entry) => /^run-[^/]+\.log$/.test(entry))) {
    throw new Error('Transcript bundle archive contains no run-*.log files');
  }

  const batchDir = mkdtempSync(join(tmpdir(), 'kaizen-transcript-batch-'));
  try {
    const result = spawnSync('tar', ['-xzf', archivePath, '-C', batchDir], { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`tar extract failed for ${archivePath}: ${result.stderr.trim()}`);
    }

    const archiveManifestPath = join(batchDir, TRANSCRIPT_BUNDLE_MANIFEST_FILE);
    try {
      const archiveManifest = TranscriptBundleManifestSchema.parse(
        JSON.parse(readFileSync(archiveManifestPath, 'utf8')),
      );
      if (
        archiveManifest.batch_id !== manifest.batch_id ||
        archiveManifest.artifact_name !== manifest.artifact_name
      ) {
        throw new Error('archive manifest does not match progress-issue manifest');
      }
      writeFileSync(
        join(batchDir, 'state.json'),
        `${JSON.stringify({ batch_id: archiveManifest.batch_id }, null, 2)}\n`,
      );
    } catch (err) {
      throw new Error(`Transcript bundle archive manifest is invalid: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {
      batchDir,
      cleanup: () => rmSync(batchDir, { recursive: true, force: true }),
    };
  } catch (err) {
    rmSync(batchDir, { recursive: true, force: true });
    throw err;
  }
}

export async function readProgressIssueTranscriptBundle(
  input: ReadProgressIssueTranscriptBundleInput,
): Promise<ProgressIssueTranscriptBundleResult> {
  const read = input.read ?? readAttachment;
  const target: AttachmentTarget = { kind: 'issue', number: input.issueNumber, repo: input.repo };
  const attachment = read(target, BATCH_TRANSCRIPT_BUNDLE_ATTACHMENT);
  if (!attachment) {
    return {
      status: 'missing',
      reason: 'missing',
      diagnostic: `No ${BATCH_TRANSCRIPT_BUNDLE_ATTACHMENT} attachment was found on ${input.repo}#${input.issueNumber}.`,
    };
  }

  let manifest: TranscriptBundleManifest;
  try {
    manifest = parseTranscriptBundleAttachment(attachment.content);
  } catch (err) {
    return {
      status: 'unavailable',
      reason: 'malformed',
      diagnostic: `Transcript bundle manifest is malformed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (manifest.status === 'ready' && isExpired(manifest, input.nowIso)) {
    return {
      status: 'unavailable',
      reason: 'expired',
      manifest,
      diagnostic: `Transcript bundle artifact expired at ${manifest.expires_at}.`,
    };
  }

  if (manifest.status !== 'ready') {
    return {
      status: 'unavailable',
      reason: manifest.status,
      manifest,
      diagnostic:
        `Transcript bundle status is ${manifest.status}.` +
        (manifest.diagnostic ? ` ${manifest.diagnostic}` : ''),
    };
  }

  const download = input.download ?? ((m, options) => defaultTranscriptArtifactDownloader(m, { ...options }));
  let downloaded: TranscriptArtifactDownload | null = null;
  try {
    downloaded = await download(manifest, {
      repo: input.repo,
      env: input.env ?? process.env,
    });
    const unpacked = unpackTranscriptBundleArtifact(downloaded.artifactDir, manifest);
    return {
      status: 'ready',
      manifest,
      batchDir: unpacked.batchDir,
      cleanup: () => {
        unpacked.cleanup();
        downloaded?.cleanup?.();
      },
    };
  } catch (err) {
    downloaded?.cleanup?.();
    return {
      status: 'unavailable',
      reason: downloadFailureReason(err),
      manifest,
      diagnostic: `Transcript bundle artifact is unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function diagnosticGuidance(reason: TranscriptBundleUnavailableReason): {
  condition: string;
  meaning: string;
  action: string;
  fallback: string;
} {
  switch (reason) {
    case 'missing':
      return {
        condition: 'missing manifest',
        meaning: 'No batch-transcript-bundle manifest has been posted to the progress issue.',
        action: 'If the batch is still finalizing, wait for upload; otherwise this batch likely predates transcript bundle upload or finalized outside the Actions artifact path.',
        fallback: 'Analyze the local batch directory when available.',
      };
    case 'absent':
      return {
        condition: 'absent run logs',
        meaning: 'Batch finalization ran, but no run-*.log transcript files were present to bundle.',
        action: 'Rerun with transcript logging enabled or inspect the machine that ran the batch.',
        fallback: 'Use local logs if they exist; otherwise there is no transcript payload to analyze.',
      };
    case 'expired':
      return {
        condition: 'expired artifact',
        meaning: 'The manifest points to an Actions artifact whose retention window has elapsed.',
        action: 'Use a local batch directory, rerun the batch, or choose archival storage for long-term transcript retention.',
        fallback: 'Local logs remain the authoritative fallback after artifact expiry.',
      };
    case 'unauthorized':
      return {
        condition: 'unauthorized artifact access',
        meaning: 'The artifact cannot be uploaded or downloaded with the current credentials.',
        action: 'Provide GITHUB_TOKEN or GH_TOKEN with actions:read permission, or rerun from an authenticated GitHub Actions environment.',
        fallback: 'Use local logs until artifact credentials are available.',
      };
    case 'malformed':
      return {
        condition: 'malformed transcript bundle metadata',
        meaning: 'The manifest or archive metadata did not match the expected schema/format.',
        action: 'Inspect the batch-transcript-bundle attachment and rerun finalization/upload to recreate the manifest.',
        fallback: 'Do not trust partial metadata; use local logs for analysis.',
      };
    case 'too_large':
      return {
        condition: 'bundle too large',
        meaning: 'The scrubbed transcript bundle exceeded the configured size limit and was withheld without truncation.',
        action: 'Analyze local logs or choose an archival storage transport; do not consume partial transcript data.',
        fallback: 'Local logs are required because the cloud bundle was intentionally not uploaded.',
      };
    case 'scrub_failed':
      return {
        condition: 'secret scrub failed',
        meaning: 'Secret scrubbing failed closed, so raw transcript logs were not uploaded.',
        action: 'Fix the redaction failure before uploading; do not bypass scrubbing with raw logs.',
        fallback: 'Analyze a secured local copy if needed.',
      };
    case 'upload_failed':
      return {
        condition: 'artifact upload failed',
        meaning: 'The bundle was built, but GitHub Actions artifact upload failed during finalization.',
        action: 'Inspect the finalize/upload logs and rerun finalization or the batch.',
        fallback: 'Use local logs while the upload failure is unresolved.',
      };
    case 'download_failed':
      return {
        condition: 'artifact download failed',
        meaning: 'The manifest was ready, but the artifact could not be downloaded or unpacked.',
        action: 'Check artifact retention, artifact name, workflow run URL, and repository permissions.',
        fallback: 'Use local logs if the artifact is unavailable.',
      };
  }
}

export function formatTranscriptBundleUnavailableDiagnostic(input: {
  issueNumber: string;
  repo: string;
  result: Extract<ProgressIssueTranscriptBundleResult, { status: 'unavailable' }>;
}): string {
  const { issueNumber, repo, result } = input;
  const guidance = diagnosticGuidance(result.reason);
  return [
    `auto-dent-analyze cannot analyze progress issue #${issueNumber} from transcript artifacts.`,
    '',
    'This tool analyzes run transcript logs (`run-*.log`) to compute cold-start, tool-pattern, and waste metrics.',
    '',
    `Condition: ${guidance.condition}.`,
    `Meaning: ${guidance.meaning}`,
    `Operator action: ${guidance.action}`,
    `Fallback: ${guidance.fallback}`,
    '',
    `Transcript artifact diagnostic for ${repo}#${issueNumber}: ${result.diagnostic}`,
    result.manifest ? `Manifest status: \`${result.manifest.status}\`, artifact: \`${result.manifest.artifact_name}\`.` : null,
  ].filter((line): line is string => line !== null).join('\n');
}

export function formatTranscriptBundleMissingDiagnostic(input: {
  issueNumber: string;
  repo: string;
  result: Extract<ProgressIssueTranscriptBundleResult, { status: 'missing' }>;
}): string {
  const guidance = diagnosticGuidance(input.result.reason);
  return [
    `auto-dent-analyze did not find transcript bundle metadata on progress issue #${input.issueNumber}.`,
    '',
    `Condition: ${guidance.condition}.`,
    `Meaning: ${guidance.meaning}`,
    `Operator action: ${guidance.action}`,
    `Fallback: ${guidance.fallback}`,
    '',
    `Transcript artifact diagnostic for ${input.repo}#${input.issueNumber}: ${input.result.diagnostic}`,
  ].join('\n');
}
