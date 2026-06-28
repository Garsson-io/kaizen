import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { parseJsonObject, parseJsonValue } from './json-value.js';

export interface WriteJsonFileOptions {
  space?: number;
  trailingNewline?: boolean;
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
