import {
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { parseJsonObject, parseJsonValue } from './json-value.js';

export interface WriteJsonFileOptions {
  space?: number;
  trailingNewline?: boolean;
}

export interface DurableJsonFileOptions extends WriteJsonFileOptions {
  backup?: boolean;
  backupPath?: string;
  tempPath?: string;
  onBackupRead?: (backupPath: string) => void;
}

export function readJsonValueFile(path: string): unknown | null {
  try {
    return parseJsonValue(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export function readJsonObjectFile(path: string): Record<string, unknown> | null {
  try {
    return parseJsonObject(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export function serializeJsonFile(value: unknown, options: WriteJsonFileOptions = {}): string {
  const space = options.space ?? 2;
  const trailingNewline = options.trailingNewline ?? true;
  return JSON.stringify(value, null, space) + (trailingNewline ? '\n' : '');
}

export function writeJsonValueFile(
  path: string,
  value: unknown,
  options?: WriteJsonFileOptions,
): void {
  const fd = openSync(path, 'w', 0o600);
  try {
    writeFileSync(fd, serializeJsonFile(value, options));
  } finally {
    closeSync(fd);
  }
}

export function writeJsonObjectFile(
  path: string,
  value: Record<string, unknown>,
  options?: WriteJsonFileOptions,
): void {
  writeJsonValueFile(path, value, options);
}

export function readDurableJsonValueFile(
  path: string,
  options: Pick<DurableJsonFileOptions, 'backup' | 'backupPath' | 'onBackupRead'> = {},
): unknown | null {
  const primary = readJsonValueFile(path);
  if (primary !== null || !options.backup) return primary;

  const backupPath = options.backupPath ?? `${path}.bak`;
  if (!existsSync(backupPath)) return null;
  options.onBackupRead?.(backupPath);
  return readJsonValueFile(backupPath);
}

export function readDurableJsonObjectFile(
  path: string,
  options: Pick<DurableJsonFileOptions, 'backup' | 'backupPath' | 'onBackupRead'> = {},
): Record<string, unknown> | null {
  const value = readDurableJsonValueFile(path, options);
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function writeDurableJsonValueFile(
  path: string,
  value: unknown,
  options: DurableJsonFileOptions = {},
): void {
  const tempPath = options.tempPath ?? `${path}.tmp`;
  const backupPath = options.backupPath ?? `${path}.bak`;
  const content = serializeJsonFile(value, options);

  // Preserve the old auto-dent contract: fail before touching disk if the
  // serialized value cannot round-trip as JSON.
  JSON.parse(content);

  if (options.backup && existsSync(path)) {
    copyFileSync(path, backupPath);
  }

  writeJsonValueFile(tempPath, value, options);
  renameSync(tempPath, path);
}

export function writeDurableJsonObjectFile(
  path: string,
  value: Record<string, unknown>,
  options?: DurableJsonFileOptions,
): void {
  writeDurableJsonValueFile(path, value, options);
}
