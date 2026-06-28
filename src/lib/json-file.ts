import { readFileSync } from 'node:fs';
import { parseJsonObject, parseJsonValue } from './json-value.js';

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
