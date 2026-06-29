import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ParsedJsonLines<T = unknown> {
  rows: T[];
  malformedRows: string[];
  malformed: Array<{ lineNumber: number; raw: string }>;
}

export function parseJsonLinesWithMalformedRows<T = unknown>(text: string): ParsedJsonLines<T> {
  const rows: T[] = [];
  const malformedRows: string[] = [];
  const malformed: Array<{ lineNumber: number; raw: string }> = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as T);
    } catch {
      malformedRows.push(raw);
      malformed.push({ lineNumber: index + 1, raw });
    }
  }
  return { rows, malformedRows, malformed };
}

export function parseJsonLines<T = unknown>(text: string): T[] {
  return parseJsonLinesWithMalformedRows<T>(text).rows;
}

function appendLineWithDescriptor(filepath: string, line: string): void {
  const fd = openSync(filepath, 'a');
  try {
    writeFileSync(fd, line);
  } finally {
    closeSync(fd);
  }
}

export function appendJsonLine(filepath: string, value: unknown): void {
  mkdirSync(dirname(filepath), { recursive: true });
  appendFileSync(filepath, JSON.stringify(value) + '\n');
}

export interface BoundedJsonLineOptions {
  /** Maximum active-file size before a new line rolls the file to `.1`. */
  maxBytes: number;
  /** Number of numeric backup generations to keep (`.1`, `.2`, ...). */
  maxBackups: number;
}

function normalizeBoundedOptions(options: BoundedJsonLineOptions): BoundedJsonLineOptions {
  return {
    maxBytes: Math.max(1, Math.floor(options.maxBytes)),
    maxBackups: Math.max(0, Math.floor(options.maxBackups)),
  };
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function renameIfPresent(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
}

function rotateFile(filepath: string, maxBackups: number): void {
  if (maxBackups === 0) {
    rmSync(filepath, { force: true });
    return;
  }

  rmSync(`${filepath}.${maxBackups}`, { force: true });
  for (let generation = maxBackups - 1; generation >= 1; generation -= 1) {
    const from = `${filepath}.${generation}`;
    renameIfPresent(from, `${filepath}.${generation + 1}`);
  }
  renameIfPresent(filepath, `${filepath}.1`);
}

/**
 * Append one JSON line while bounding local append-only telemetry growth.
 *
 * Rotation happens before the write when the active file is already at/over the
 * cap or the next line would exceed it. Backup names are deterministic so hook
 * telemetry stays easy to inspect and test.
 */
export function appendBoundedJsonLine(
  filepath: string,
  value: unknown,
  options: BoundedJsonLineOptions,
): void {
  const normalized = normalizeBoundedOptions(options);
  mkdirSync(dirname(filepath), { recursive: true });

  const line = JSON.stringify(value) + '\n';
  const lineBytes = Buffer.byteLength(line, 'utf-8');
  let fd: number | undefined = openSync(filepath, 'a');
  try {
    const currentSize = fstatSync(fd).size;
    if (
      currentSize >= normalized.maxBytes ||
      (currentSize > 0 && currentSize + lineBytes > normalized.maxBytes)
    ) {
      closeSync(fd);
      fd = undefined;
      rotateFile(filepath, normalized.maxBackups);
      appendLineWithDescriptor(filepath, line);
    } else {
      writeFileSync(fd, line);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
