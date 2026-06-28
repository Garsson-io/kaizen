import { getCurrentBranch } from '../hook-io.js';

export interface CurrentBranchOptions {
  readBranch?: () => string;
  fallback?: string;
}

export function currentHookBranch(options: CurrentBranchOptions = {}): string {
  const fallback = options.fallback ?? 'unknown';
  try {
    const branch = (options.readBranch ?? getCurrentBranch)().trim();
    return branch || fallback;
  } catch {
    return fallback;
  }
}
