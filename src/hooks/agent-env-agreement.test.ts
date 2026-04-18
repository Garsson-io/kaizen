import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_ENV_VARS } from './pre-push.js';

// AGENT_ENV_VARS is the canonical agent-env list in pre-push.ts. Two shell
// wrappers redeclare the same list inline: `.githooks/pre-push` (kaizen-self
// dispatcher) and `src/hooks/kaizen-host-entry.sh` (host-install template).
// If the TS list changes but either shell list doesn't — or vice versa — the
// gating diverges silently: the TS hook may run for a session the wrapper
// short-circuits past, or the wrapper may spend a subprocess on a non-agent
// session. Pin the agreement here so a missed sync breaks tests, not prod.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readVarsFromShell(path: string): string[] {
  const src = readFileSync(resolve(root, path), 'utf-8');
  // Match `[ -z "${VAR:-}" ]` — the canonical agent-env gate form.
  const matches = Array.from(src.matchAll(/\[\s*-z\s+"\$\{([A-Z_][A-Z0-9_]*):-\}"\s*\]/g));
  return [...new Set(matches.map(m => m[1]))];
}

describe('AGENT_ENV_VARS agreement across TS and shell wrappers', () => {
  const tsList = [...AGENT_ENV_VARS].sort();

  it('.githooks/pre-push checks exactly the TS-declared agent-env vars', () => {
    const shellVars = readVarsFromShell('.githooks/pre-push').sort();
    expect(shellVars).toEqual(tsList);
  });

  it('src/hooks/kaizen-host-entry.sh checks exactly the TS-declared agent-env vars', () => {
    const shellVars = readVarsFromShell('src/hooks/kaizen-host-entry.sh').sort();
    expect(shellVars).toEqual(tsList);
  });
});
