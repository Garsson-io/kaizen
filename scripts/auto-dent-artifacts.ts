/**
 * auto-dent-artifacts — Run artifact manifest and bundle utilities.
 *
 * Writes a manifest of all output files for a run, enabling portable
 * export and post-hoc analysis. Can bundle a run or entire batch
 * into a tar.gz archive.
 *
 * See issue #916, parent meta-issue #925.
 */

import { readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { execSync } from 'node:child_process';

export interface RunManifestEntry {
  path: string;
  size: number;
  type: 'log' | 'prompt' | 'events' | 'state' | 'reflection' | 'review' | 'other';
}

export interface RunManifest {
  batch_id: string;
  run_num: number;
  created_at: string;
  log_dir: string;
  files: RunManifestEntry[];
  total_size: number;
}

/** Classify a filename into an artifact type. */
export function classifyArtifact(filename: string): RunManifestEntry['type'] {
  if (filename.endsWith('.log')) return 'log';
  if (filename.includes('-prompt.md')) return 'prompt';
  if (filename === 'events.jsonl') return 'events';
  if (filename === 'state.json' || filename === 'state.json.bak') return 'state';
  if (filename.includes('reflection')) return 'reflection';
  if (filename.includes('review')) return 'review';
  return 'other';
}

/**
 * Scan the log directory and build a manifest of all run-related files.
 *
 * If runNum is provided, only includes files matching `run-{N}-*` plus
 * shared files (events.jsonl, state.json). If omitted, includes all files.
 */
export function buildRunManifest(
  logDir: string,
  batchId: string,
  runNum?: number,
): RunManifest {
  if (!existsSync(logDir)) {
    return { batch_id: batchId, run_num: runNum ?? 0, created_at: new Date().toISOString(), log_dir: logDir, files: [], total_size: 0 };
  }

  const allFiles = readdirSync(logDir).filter(f => {
    try { return statSync(join(logDir, f)).isFile(); } catch { return false; }
  });

  const runPrefix = runNum !== undefined ? `run-${runNum}-` : undefined;
  const sharedFiles = new Set(['events.jsonl', 'state.json', 'state.json.bak', 'reflection-summary.json', 'reflection-history.json']);

  const files: RunManifestEntry[] = [];
  let totalSize = 0;

  for (const f of allFiles) {
    const include = !runPrefix || f.startsWith(runPrefix) || sharedFiles.has(f);
    if (!include) continue;

    const fullPath = join(logDir, f);
    const size = statSync(fullPath).size;
    files.push({
      path: f,
      size,
      type: classifyArtifact(f),
    });
    totalSize += size;
  }

  return {
    batch_id: batchId,
    run_num: runNum ?? 0,
    created_at: new Date().toISOString(),
    log_dir: logDir,
    files,
    total_size: totalSize,
  };
}

/** Write a manifest JSON file to the log directory. */
export function writeRunManifest(logDir: string, manifest: RunManifest): string {
  const filename = manifest.run_num > 0
    ? `run-${manifest.run_num}-manifest.json`
    : 'batch-manifest.json';
  const outPath = join(logDir, filename);
  writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  return outPath;
}

/**
 * Bundle artifacts into a tar.gz archive.
 *
 * Uses the manifest to determine which files to include.
 * Returns the path to the created archive.
 */
export function bundleArtifacts(logDir: string, manifest: RunManifest): string {
  const archiveName = manifest.run_num > 0
    ? `run-${manifest.run_num}-bundle.tar.gz`
    : `batch-${manifest.batch_id}-bundle.tar.gz`;
  const archivePath = join(logDir, archiveName);
  const filePaths = manifest.files.map(f => f.path);

  // Include the manifest itself
  const manifestFile = manifest.run_num > 0
    ? `run-${manifest.run_num}-manifest.json`
    : 'batch-manifest.json';
  filePaths.push(manifestFile);

  execSync(
    `tar -czf ${JSON.stringify(basename(archivePath))} ${filePaths.map(f => JSON.stringify(f)).join(' ')}`,
    { cwd: logDir },
  );

  return archivePath;
}

/** Format a human-readable summary of the manifest. */
export function formatManifestSummary(manifest: RunManifest): string {
  const lines: string[] = [];
  const sizeKb = (manifest.total_size / 1024).toFixed(1);
  lines.push(`Run ${manifest.run_num} artifacts: ${manifest.files.length} files, ${sizeKb} KB total`);

  const byType = new Map<string, number>();
  for (const f of manifest.files) {
    byType.set(f.type, (byType.get(f.type) ?? 0) + 1);
  }
  const typeSummary = [...byType.entries()].map(([t, n]) => `${n} ${t}`).join(', ');
  lines.push(`  Types: ${typeSummary}`);

  return lines.join('\n');
}
