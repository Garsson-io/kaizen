import { getCurrentBranch } from '../hook-io.js';

export interface CurrentBranchOptions {
  readBranch?: () => string;
}

export function currentHookBranch(options: CurrentBranchOptions = {}): string {
  try {
    const branch = (options.readBranch ?? getCurrentBranch)().trim();
    return branch || 'unknown';
  } catch {
    return 'unknown';
  }
}
