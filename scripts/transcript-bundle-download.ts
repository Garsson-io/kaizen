import artifactClient, { type ArtifactClient, type FindOptions } from '@actions/artifact';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, normalize } from 'node:path';
import { readAttachment, type AttachmentTarget } from '../src/section-editor.js';
import {
  TRANSCRIPT_BUNDLE_MANIFEST_FILE,
  TranscriptBundleManifestSchema,
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

export type ProgressIssueTranscriptBundleResult =
  | {
      status: 'ready';
      manifest: TranscriptBundleManifest;
      batchDir: string;
      cleanup: () => void;
    }
  | {
      status: 'missing';
      diagnostic: string;
    }
  | {
      status: 'unavailable';
      manifest?: TranscriptBundleManifest;
      diagnostic: string;
    };

export interface ReadProgressIssueTranscriptBundleInput {
  issueNumber: string;
  repo: string;
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
      diagnostic: `No ${BATCH_TRANSCRIPT_BUNDLE_ATTACHMENT} attachment was found on ${input.repo}#${input.issueNumber}.`,
    };
  }

  let manifest: TranscriptBundleManifest;
  try {
    manifest = parseTranscriptBundleAttachment(attachment.content);
  } catch (err) {
    return {
      status: 'unavailable',
      diagnostic: `Transcript bundle manifest is malformed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (manifest.status !== 'ready') {
    return {
      status: 'unavailable',
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
      manifest,
      diagnostic: `Transcript bundle artifact is unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function formatTranscriptBundleUnavailableDiagnostic(input: {
  issueNumber: string;
  repo: string;
  result: Extract<ProgressIssueTranscriptBundleResult, { status: 'unavailable' }>;
}): string {
  const { issueNumber, repo, result } = input;
  return [
    `auto-dent-analyze cannot analyze progress issue #${issueNumber} from transcript artifacts.`,
    '',
    'This tool analyzes run transcript logs (`run-*.log`) to compute cold-start, tool-pattern, and waste metrics.',
    '',
    `Transcript artifact diagnostic for ${repo}#${issueNumber}: ${result.diagnostic}`,
    result.manifest ? `Manifest status: \`${result.manifest.status}\`, artifact: \`${result.manifest.artifact_name}\`.` : null,
    '',
    'Run transcript logs are not available from the progress issue artifact.',
    'Use a local batch directory if the Actions artifact has expired or cannot be downloaded.',
  ].filter((line): line is string => line !== null).join('\n');
}
