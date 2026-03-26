import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  classifyArtifact,
  buildRunManifest,
  writeRunManifest,
  bundleArtifacts,
  formatManifestSummary,
} from './auto-dent-artifacts.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'artifacts-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('classifyArtifact', () => {
  it('classifies log files', () => {
    expect(classifyArtifact('run-1-20260326.log')).toBe('log');
  });

  it('classifies prompt files', () => {
    expect(classifyArtifact('run-1-prompt.md')).toBe('prompt');
  });

  it('classifies events.jsonl', () => {
    expect(classifyArtifact('events.jsonl')).toBe('events');
  });

  it('classifies state files', () => {
    expect(classifyArtifact('state.json')).toBe('state');
    expect(classifyArtifact('state.json.bak')).toBe('state');
  });

  it('classifies reflection artifacts', () => {
    expect(classifyArtifact('reflection-summary.json')).toBe('reflection');
  });

  it('classifies review artifacts', () => {
    expect(classifyArtifact('review-results.json')).toBe('review');
  });

  it('classifies unknown files as other', () => {
    expect(classifyArtifact('random.txt')).toBe('other');
  });
});

describe('buildRunManifest', () => {
  it('returns empty manifest for non-existent directory', () => {
    const manifest = buildRunManifest('/nonexistent/path', 'batch-1');
    expect(manifest.files).toEqual([]);
    expect(manifest.total_size).toBe(0);
  });

  it('includes all files when no runNum specified', () => {
    writeFileSync(join(tmpDir, 'run-1-prompt.md'), 'prompt1');
    writeFileSync(join(tmpDir, 'run-2-prompt.md'), 'prompt2');
    writeFileSync(join(tmpDir, 'events.jsonl'), '{}');

    const manifest = buildRunManifest(tmpDir, 'batch-1');
    expect(manifest.files.length).toBe(3);
    expect(manifest.batch_id).toBe('batch-1');
  });

  it('filters to specific run when runNum provided', () => {
    writeFileSync(join(tmpDir, 'run-1-prompt.md'), 'prompt1');
    writeFileSync(join(tmpDir, 'run-2-prompt.md'), 'prompt2');
    writeFileSync(join(tmpDir, 'events.jsonl'), 'shared');
    writeFileSync(join(tmpDir, 'state.json'), '{}');

    const manifest = buildRunManifest(tmpDir, 'batch-1', 1);
    const filenames = manifest.files.map(f => f.path);
    expect(filenames).toContain('run-1-prompt.md');
    expect(filenames).toContain('events.jsonl');
    expect(filenames).toContain('state.json');
    expect(filenames).not.toContain('run-2-prompt.md');
  });

  it('computes correct total size', () => {
    writeFileSync(join(tmpDir, 'run-1-prompt.md'), 'hello');
    writeFileSync(join(tmpDir, 'events.jsonl'), 'world!');

    const manifest = buildRunManifest(tmpDir, 'batch-1', 1);
    expect(manifest.total_size).toBe(11); // 5 + 6
  });

  it('classifies each file by type', () => {
    writeFileSync(join(tmpDir, 'run-1-20260326.log'), 'log data');
    writeFileSync(join(tmpDir, 'run-1-prompt.md'), 'prompt');
    writeFileSync(join(tmpDir, 'events.jsonl'), '{}');

    const manifest = buildRunManifest(tmpDir, 'batch-1', 1);
    const types = manifest.files.map(f => f.type);
    expect(types).toContain('log');
    expect(types).toContain('prompt');
    expect(types).toContain('events');
  });
});

describe('writeRunManifest', () => {
  it('writes manifest JSON to log directory', () => {
    const manifest = buildRunManifest(tmpDir, 'batch-1', 3);
    const outPath = writeRunManifest(tmpDir, manifest);
    expect(outPath).toContain('run-3-manifest.json');
    expect(existsSync(outPath)).toBe(true);

    const written = JSON.parse(readFileSync(outPath, 'utf8'));
    expect(written.batch_id).toBe('batch-1');
    expect(written.run_num).toBe(3);
  });

  it('uses batch-manifest.json when run_num is 0', () => {
    const manifest = buildRunManifest(tmpDir, 'batch-1');
    const outPath = writeRunManifest(tmpDir, manifest);
    expect(outPath).toContain('batch-manifest.json');
  });
});

describe('bundleArtifacts', () => {
  it('creates a tar.gz archive with manifest files', () => {
    writeFileSync(join(tmpDir, 'run-1-prompt.md'), 'prompt');
    writeFileSync(join(tmpDir, 'events.jsonl'), '{}');

    const manifest = buildRunManifest(tmpDir, 'batch-1', 1);
    writeRunManifest(tmpDir, manifest);
    const archivePath = bundleArtifacts(tmpDir, manifest);

    expect(archivePath).toContain('run-1-bundle.tar.gz');
    expect(existsSync(archivePath)).toBe(true);
  });
});

describe('formatManifestSummary', () => {
  it('produces human-readable summary', () => {
    writeFileSync(join(tmpDir, 'run-1-20260326.log'), 'x'.repeat(1024));
    writeFileSync(join(tmpDir, 'run-1-prompt.md'), 'prompt');
    writeFileSync(join(tmpDir, 'events.jsonl'), '{}');

    const manifest = buildRunManifest(tmpDir, 'batch-1', 1);
    const summary = formatManifestSummary(manifest);
    expect(summary).toContain('Run 1 artifacts');
    expect(summary).toContain('3 files');
    expect(summary).toContain('KB total');
  });
});
