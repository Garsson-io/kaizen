/**
 * truncate-helper-invariant.test.ts — category-prevention lint for #1385 (slice of #1164).
 *
 * #1164 named the truncation/formatting family as the canonical cross-PR DRY
 * drift: `auto-dent-stream.ts`, `auto-dent-run.ts`, `auto-dent-analyze.ts`, and
 * `transcript-analysis.ts` each grew their own bare `truncate()`. Merged PRs
 * (#1349, #1353, #1355) consolidated them into the canonical helpers in
 * `src/analysis/util.ts` (`truncate`) and `scripts/auto-dent-display.ts`
 * (`truncateDisplay`). This ratchet freezes that consolidation: it fails loudly
 * if any production file outside the canonical home defines a *bare* `truncate`
 * helper again.
 *
 * The bare generic name `truncate` is the copy-paste tell. Descriptive,
 * genuinely-distinct variants — `truncateMiddle` (head+tail), `truncateAtWordBoundary`
 * (word-aware), `truncateAfterPrefix` (prefix-preserving), `truncateDisplay`
 * (display-aware) — carry their own names and are intentionally NOT matched.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

interface Violation {
  file: string;
}

const REPO_ROOT = join(__dirname, '..');
const SCAN_DIRS = [join(REPO_ROOT, 'src'), join(REPO_ROOT, 'scripts')];

// Canonical home for the bare `truncate(s, maxLen)` ellipsis helper. Every other
// truncation need routes through this or through `truncateDisplay` in
// scripts/auto-dent-display.ts (descriptive name, not matched by this scanner).
const CANONICAL_HOME = 'src/analysis/util.ts';

// Terminal state of the truncation-helper consolidation. scripts/hook-gym-format.ts
// was the last duplicate and was migrated to truncateDisplay in #1385 — the ratchet
// is empty. Any new bare-`truncate` definition fails the invariant with no escape hatch.
const OPT_OUT = new Set<string>([]);

function repoRelative(path: string): string {
  return relative(REPO_ROOT, path).replace(/\\/g, '/');
}

function isProductionTsFile(file: string): boolean {
  if (!file.endsWith('.ts')) return false;
  if (file.endsWith('.test.ts')) return false;
  if (file.endsWith('.d.ts')) return false;
  return true;
}

function collectProductionFiles(dirs: string[] = SCAN_DIRS): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      const rel = repoRelative(fullPath);
      if (!isProductionTsFile(rel)) continue;
      if (rel === CANONICAL_HOME) continue;
      files.set(rel, readFileSync(fullPath, 'utf-8'));
    }
  };
  for (const dir of dirs) walk(dir);
  return files;
}

function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

/**
 * True if the file defines a bare `truncate` helper:
 *   - `function truncate(` (with or without `export`/`async`)
 *   - `const|let|var truncate =` / `: ... =>`
 *
 * The `\btruncate\b` word boundary means descriptive variants like
 * `truncateDisplay`/`truncateMiddle` do NOT match (no boundary between
 * `truncate` and the following capital).
 */
function definesBareTruncate(content: string): boolean {
  const src = stripComments(content);
  if (/\bfunction\s+truncate\s*\(/.test(src)) return true;
  if (/\b(?:const|let|var)\s+truncate\s*[:=]/.test(src)) return true;
  return false;
}

function findBareTruncateDefinitions(files: Map<string, string>): Violation[] {
  return Array.from(files.entries())
    .filter(([, content]) => definesBareTruncate(content))
    .map(([file]) => ({ file }));
}

// ── Head+tail capper drift guard (#1508 / #1385 family) ──────────────
//
// `truncateMiddle` (head+tail, on-disk pointer) was born private inside
// scripts/batch-artifacts-upload.ts. When the run-transcript attachment (#1508)
// needed the same "cap a body to GitHub's 65536-char comment limit" dance,
// copying it would have spawned a second capper that drifts. It was hoisted to
// src/capped-attachment.ts and both callers now share it. This guard freezes
// that: the head+tail capper may be DEFINED only in its canonical home. Unlike
// the bare-`truncate` scanner above, this one DOES match `truncateMiddle` —
// because there must be exactly one.

const CAPPER_HOME = 'src/capped-attachment.ts';

function definesTruncateMiddle(content: string): boolean {
  const src = stripComments(content);
  if (/\bfunction\s+truncateMiddle\s*\(/.test(src)) return true;
  if (/\b(?:const|let|var)\s+truncateMiddle\s*[:=]/.test(src)) return true;
  return false;
}

function findTruncateMiddleDefinitions(files: Map<string, string>): Violation[] {
  return Array.from(files.entries())
    .filter(([file]) => file !== CAPPER_HOME)
    .filter(([, content]) => definesTruncateMiddle(content))
    .map(([file]) => ({ file }));
}

// ── Secret-scrubber singularity guard (#1508 / #1385 family) ─────────
//
// `scrubSecrets` is the one credential redactor before a transcript or batch
// artifact hits a PUBLIC comment (I19). A second, divergent scrubber would be a
// silent leak surface — one redactor could be hardened while the other rots.
// Both public-comment paths (transcript-attach, batch-artifacts) share this one;
// freeze that so a future copy fails CI like the capper does.

const SCRUBBER_HOME = 'src/scrub-secrets.ts';

function definesScrubSecrets(content: string): boolean {
  const src = stripComments(content);
  if (/\bfunction\s+scrubSecrets\s*\(/.test(src)) return true;
  if (/\b(?:const|let|var)\s+scrubSecrets\s*[:=]/.test(src)) return true;
  return false;
}

function findScrubSecretsDefinitions(files: Map<string, string>): Violation[] {
  return Array.from(files.entries())
    .filter(([file]) => file !== SCRUBBER_HOME)
    .filter(([, content]) => definesScrubSecrets(content))
    .map(([file]) => ({ file }));
}

function unallowlistedViolations(violations: Violation[], allowlist: Set<string>): Violation[] {
  return violations.filter(v => !allowlist.has(v.file));
}

function staleAllowlistEntries(violations: Violation[], allowlist: Set<string>): string[] {
  const violationFiles = new Set(violations.map(v => v.file));
  return Array.from(allowlist).filter(f => !violationFiles.has(f));
}

describe('truncate-helper invariant scanner', () => {
  it('detects bare truncate definitions in synthetic fixtures', () => {
    const violations = findBareTruncateDefinitions(new Map([
      ['scripts/bad-fn.ts', 'function truncate(s: string, max: number) { return s; }'],
      ['scripts/bad-arrow.ts', 'const truncate = (s: string, max: number) => s.slice(0, max);'],
      ['scripts/bad-typed.ts', 'const truncate: (s: string) => string = s => s;'],
    ]));

    expect(violations.map(v => v.file).sort()).toEqual([
      'scripts/bad-arrow.ts',
      'scripts/bad-fn.ts',
      'scripts/bad-typed.ts',
    ]);
  });

  it('ignores descriptive truncation variants (no false positives)', () => {
    const violations = findBareTruncateDefinitions(new Map([
      ['scripts/ok-display.ts', 'export function truncateDisplay(t: string, m: number) { return t; }'],
      ['scripts/ok-middle.ts', 'function truncateMiddle(t: string, m: number) { return t; }'],
      ['scripts/ok-word.ts', 'export function truncateAtWordBoundary(t: string, m: number) { return t; }'],
      ['scripts/ok-prefix.ts', 'export function truncateAfterPrefix(s: string, p: number) { return s; }'],
      ['scripts/ok-call.ts', 'const x = truncate(reason, 60);'],
    ]));

    expect(violations).toEqual([]);
  });

  it('ignores a bare truncate that only appears in a comment', () => {
    const violations = findBareTruncateDefinitions(new Map([
      ['scripts/commented.ts', '// function truncate(s, max) { ... } — removed, use truncateDisplay\nexport const y = 1;'],
    ]));

    expect(violations).toEqual([]);
  });

  it('fails when a new bare truncate caller is not allowlisted', () => {
    const violations = findBareTruncateDefinitions(new Map([
      ['scripts/new-dup.ts', 'function truncate(s: string, max: number) { return s.slice(0, max); }'],
    ]));

    expect(unallowlistedViolations(violations, OPT_OUT)).toEqual([
      { file: 'scripts/new-dup.ts' },
    ]);
  });

  it('reports stale allowlist entries after migration', () => {
    const violations = findBareTruncateDefinitions(new Map([
      ['scripts/still-bad.ts', 'function truncate(s: string) { return s; }'],
    ]));
    const allowlist = new Set([
      'scripts/still-bad.ts',
      'scripts/already-migrated.ts',
    ]);

    expect(staleAllowlistEntries(violations, allowlist)).toEqual([
      'scripts/already-migrated.ts',
    ]);
  });

  it('finds production source files and excludes the canonical home', () => {
    const files = collectProductionFiles();

    expect(files.size).toBeGreaterThan(50);
    expect(files.has(CANONICAL_HOME)).toBe(false);
  });

  it('current production tree has no unallowlisted bare truncate definitions', () => {
    const violations = findBareTruncateDefinitions(collectProductionFiles());

    expect(unallowlistedViolations(violations, OPT_OUT)).toEqual([]);
  });

  it('OPT_OUT entries correspond to current bare truncate definitions', () => {
    const violations = findBareTruncateDefinitions(collectProductionFiles());

    expect(staleAllowlistEntries(violations, OPT_OUT)).toEqual([]);
  });
});

describe('head+tail capper invariant scanner (#1508)', () => {
  it('flags a truncateMiddle defined outside the canonical home', () => {
    const violations = findTruncateMiddleDefinitions(new Map([
      ['scripts/copy.ts', 'function truncateMiddle(t: string, m: number, p: string) { return t; }'],
      ['scripts/copy-arrow.ts', 'const truncateMiddle = (t: string) => t;'],
    ]));

    expect(violations.map(v => v.file).sort()).toEqual([
      'scripts/copy-arrow.ts',
      'scripts/copy.ts',
    ]);
  });

  it('does not flag the canonical home or mere callers', () => {
    const violations = findTruncateMiddleDefinitions(new Map([
      [CAPPER_HOME, 'export function truncateMiddle(t: string, m: number, p: string) { return t; }'],
      ['scripts/caller.ts', 'const x = truncateMiddle(body, 64000, pointer);'],
    ]));

    expect(violations).toEqual([]);
  });

  it('current production tree defines truncateMiddle only in the canonical home', () => {
    const violations = findTruncateMiddleDefinitions(collectProductionFiles());

    expect(violations).toEqual([]);
  });
});

describe('secret-scrubber singularity scanner (#1508)', () => {
  it('flags a scrubSecrets defined outside the canonical home', () => {
    const violations = findScrubSecretsDefinitions(new Map([
      ['scripts/copy.ts', 'export function scrubSecrets(t: string) { return t; }'],
      ['src/other.ts', 'const scrubSecrets = (t: string) => t;'],
    ]));

    expect(violations.map(v => v.file).sort()).toEqual(['scripts/copy.ts', 'src/other.ts']);
  });

  it('does not flag the canonical home or mere callers', () => {
    const violations = findScrubSecretsDefinitions(new Map([
      [SCRUBBER_HOME, 'export function scrubSecrets(t: unknown) { return { text: t, redactions: 0 }; }'],
      ['scripts/caller.ts', 'const r = scrubSecrets(body).text;'],
    ]));

    expect(violations).toEqual([]);
  });

  it('current production tree defines scrubSecrets only in the canonical home', () => {
    const violations = findScrubSecretsDefinitions(collectProductionFiles());

    expect(violations).toEqual([]);
  });
});
