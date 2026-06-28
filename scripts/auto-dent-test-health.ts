import type { KnownFailuresValidation } from '../src/known-failures.js';
import { loadKnownFailures, unownedFailures } from '../src/known-failures.js';
import type { TestHealthVerdict } from '../src/verdict-binding-policy.js';

export interface DeriveRunTestHealthOptions {
  runLog?: string;
  load?: () => KnownFailuresValidation;
}

function unique(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

export function extractObservedTestFailureIds(runLog?: string): string[] {
  if (!runLog) return [];

  const ids: string[] = [];
  const lines = runLog.split(/\r?\n/);
  let inFailedFiles = false;

  for (const line of lines) {
    const pytest = line.match(/^FAILED\s+(?!FILES:)(\S+)/);
    if (pytest?.[1]) ids.push(pytest[1]);

    if (/^FAILED FILES:\s*$/.test(line)) {
      inFailedFiles = true;
      continue;
    }

    if (inFailedFiles) {
      const item = line.match(/^\s*-\s+(.+?)\s*$/);
      if (item?.[1]) {
        ids.push(item[1]);
        continue;
      }
      inFailedFiles = false;
    }
  }

  return unique(ids);
}

export function classifyObservedTestFailures(
  failingIds: string[],
  registry: KnownFailuresValidation,
): TestHealthVerdict {
  const observed = unique(failingIds);
  if (observed.length === 0) return 'unknown';
  if (!registry.ok) return 'unowned-failures';
  return unownedFailures(observed, registry.entries).length > 0
    ? 'unowned-failures'
    : 'pass';
}

export function deriveRunTestHealth(options: DeriveRunTestHealthOptions = {}): TestHealthVerdict {
  const failingIds = extractObservedTestFailureIds(options.runLog);
  if (failingIds.length === 0) return 'unknown';
  const registry = (options.load ?? loadKnownFailures)();
  return classifyObservedTestFailures(failingIds, registry);
}
