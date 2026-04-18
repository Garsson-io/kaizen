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

const REPO_ROOT = join(__dirname, '..');

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
});
