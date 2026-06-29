/**
 * Self-invariant tests for the kaizen repo itself (#1063).
 *
 * These assert structural properties of the kaizen repo, not of any
 * host project. They are the repo-level companion of the kaizen-doctor
 * checks: doctor runs against a live project; these run in CI to keep
 * the source of truth clean.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENFORCEMENT_COVERAGE, coverageByCommandBasename } from '../src/enforcement-coverage.js';

const REPO_ROOT = join(__dirname, '..');

function commandBasename(command: string): string {
  return command.replace(/^.*\//, '');
}

function registeredHookCommandBasenames(): string[] {
  const raw = readFileSync(join(REPO_ROOT, '.claude-plugin/plugin.json'), 'utf-8');
  const data = JSON.parse(raw) as { hooks?: unknown };
  const commands: string[] = [];
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') {
      const obj = x as Record<string, unknown>;
      if (obj.type === 'command' && typeof obj.command === 'string') {
        commands.push(commandBasename(obj.command));
      }
      for (const v of Object.values(obj)) walk(v);
    }
  };
  walk(data.hooks ?? {});
  return [...new Set(commands)].sort();
}

describe('kaizen self-invariants (#1063)', () => {
  it('.claude/settings.json has NO `hooks` block (single source of truth is plugin.json)', () => {
    const raw = readFileSync(join(REPO_ROOT, '.claude/settings.json'), 'utf-8');
    const data = JSON.parse(raw) as { hooks?: unknown };
    expect(
      data.hooks,
      'The kaizen repo must distribute hooks via .claude-plugin/plugin.json only. A hooks block here would re-create the #1061 dual-load state. See #1063.',
    ).toBeUndefined();
  });

  it('.claude/settings.json has enabledPlugins["kaizen@kaizen"]=true (activation switch)', () => {
    const raw = readFileSync(join(REPO_ROOT, '.claude/settings.json'), 'utf-8');
    const data = JSON.parse(raw) as { enabledPlugins?: Record<string, unknown> };
    expect(
      data.enabledPlugins?.['kaizen@kaizen'],
      '#1063: kaizen-on-kaizen activates via the same plugin mechanism host projects use. enabledPlugins must be present.',
    ).toBe(true);
  });

  it('.claude-plugin/plugin.json has at least one hook entry (the single source)', () => {
    const raw = readFileSync(join(REPO_ROOT, '.claude-plugin/plugin.json'), 'utf-8');
    const data = JSON.parse(raw) as { hooks?: unknown };
    let n = 0;
    const walk = (x: unknown): void => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === 'object') {
        const obj = x as Record<string, unknown>;
        if (obj.type === 'command' && typeof obj.command === 'string') n++;
        for (const v of Object.values(obj)) walk(v);
      }
    };
    walk(data.hooks ?? {});
    expect(n).toBeGreaterThan(0);
  });

  it('provider enforcement coverage has one row per hook command (#1166)', () => {
    const coverage = coverageByCommandBasename();
    const missing = registeredHookCommandBasenames().filter(command => !coverage.has(command));
    expect(
      missing,
      `Every registered hook command needs an explicit provider coverage row in src/enforcement-coverage.ts (#1166). Missing: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('provider enforcement coverage rows are complete and uniquely keyed (#1166)', () => {
    const seen = new Set<string>();
    for (const row of ENFORCEMENT_COVERAGE) {
      expect(row.hookId, 'hookId must be present').not.toBe('');
      expect(row.commandBasename, `${row.hookId} commandBasename`).not.toBe('');
      expect(seen.has(row.commandBasename), `${row.commandBasename} appears more than once`).toBe(false);
      seen.add(row.commandBasename);
      expect(row.status, `${row.hookId} status`).not.toBe('');
      expect(row.fallbackClass, `${row.hookId} fallbackClass`).not.toBe('');
      expect(row.fallbackArtifact, `${row.hookId} fallbackArtifact`).not.toBe('');
      expect(row.notes, `${row.hookId} notes`).not.toBe('');
      if (row.status === 'provider-agnostic') {
        expect(row.claudeHookDependent, `${row.hookId} provider-agnostic row must not depend on Claude hooks`).toBe(false);
      }
    }
  });

  it('provider coverage doc projection lists every inventory row (#1166)', () => {
    const doc = readFileSync(join(REPO_ROOT, 'docs/kaizen-invariants.md'), 'utf-8');
    expect(doc).toContain('Provider Coverage Matrix');
    for (const row of ENFORCEMENT_COVERAGE) {
      expect(doc, `docs/kaizen-invariants.md must list ${row.hookId}`).toContain(`\`${row.hookId}\``);
      expect(doc, `docs/kaizen-invariants.md must mention ${row.commandBasename}`).toContain(`\`${row.commandBasename}\``);
      expect(doc, `docs/kaizen-invariants.md must include status ${row.status}`).toContain(`\`${row.status}\``);
    }
  });
});
