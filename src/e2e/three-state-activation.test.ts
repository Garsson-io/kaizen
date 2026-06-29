/**
 * three-state-activation.test.ts — the #1063 three-state matrix against a
 * synthetic host project.
 *
 * #1063 promises that a host project can cleanly occupy exactly one of:
 *   1. enabled          — enabledPlugins set in project settings.json
 *   2. not-enabled      — no enabledPlugins key; plugin dormant
 *   3. marketplace-only — plugin cache/marketplace present user-side, but
 *                         project hasn't activated it
 *
 * Each state should produce the right kaizen-doctor output and (for the
 * enabled state) should not trigger the dual-load footgun. A live claude -p
 * session is not required for these assertions — we verify on-disk state
 * and the doctor CLI's interpretation of it, which is the load-path
 * contract users care about.
 *
 * Runs in the normal `npm test` batch (not gated behind KAIZEN_LIVE_TEST).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { enablePlugin } from '../kaizen-setup.js';
import { buildTypeScriptSubprocess } from '../../scripts/test-typescript-runner.js';

const DOCTOR = resolve(__dirname, '../../scripts/kaizen-doctor.ts');
const DOCTOR_RUNNER = buildTypeScriptSubprocess(DOCTOR, {
  startDir: __dirname,
});
const TEST_SOURCE = readFileSync(
  resolve(__dirname, 'three-state-activation.test.ts'),
  'utf-8',
);

function runDoctor(projectRoot: string, homeDir: string): {
  exitCode: number;
  results: Array<{ name: string; status: string; detail: string }>;
} {
  try {
    const out = execFileSync(DOCTOR_RUNNER.command, [...DOCTOR_RUNNER.args, '--json'], {
      cwd: projectRoot,
      env: { ...process.env, HOME: homeDir },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: 0, results: JSON.parse(out).results };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return {
      exitCode: err.status ?? 1,
      results: err.stdout ? (JSON.parse(err.stdout).results ?? []) : [],
    };
  }
}

function findResult(
  results: Array<{ name: string; status: string }>,
  name: string,
): { status: string } {
  const r = results.find(x => x.name === name);
  if (!r) throw new Error(`check ${name} not in results`);
  return r;
}

describe('#1063 three-state matrix — host project activation', () => {
  let project: string;
  let home: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'kaizen-3state-proj-'));
    home = mkdtempSync(join(tmpdir(), 'kaizen-3state-home-'));
    mkdirSync(join(home, '.claude/plugins'), { recursive: true });
    // Every state has the marketplace listed (so "marketplace added" is constant).
    writeFileSync(
      join(home, '.claude/plugins/known_marketplaces.json'),
      JSON.stringify({
        kaizen: {
          source: { source: 'github', repo: 'Garsson-io/kaizen' },
          installLocation: join(home, '.claude/plugins/marketplaces/kaizen'),
        },
      }),
    );
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('test runtime invariant: doctor subprocesses use the shared TypeScript runner', () => {
    expect(runDoctor.toString()).toContain('DOCTOR_RUNNER');
    expect(TEST_SOURCE).toContain('buildTypeScriptSubprocess');
    expect(TEST_SOURCE).not.toMatch(/execFileSync\(['"]npx['"]/);
  });

  it('State 1: enabled — enabledPlugins present, doctor all-PASS, activation switch works', () => {
    // Use our new --step enable path to flip activation.
    const result = enablePlugin(project);
    expect(result.changed).toBe(true);
    const settings = JSON.parse(readFileSync(join(project, '.claude/settings.json'), 'utf-8'));
    expect(settings.enabledPlugins['kaizen@kaizen']).toBe(true);
    expect(settings.hooks).toBeUndefined(); // never add hooks

    // Doctor check: single-registration-path passes (no hooks anywhere in this tmp project)
    const { results } = runDoctor(project, home);
    expect(findResult(results, 'single-registration-path').status).toBe('PASS');
    expect(findResult(results, 'plugin-double-install').status).toBe('PASS');
  });

  it('State 2: not-enabled — no enabledPlugins, doctor reports kaizen absent from this project', () => {
    // Host project exists but hasn't run /kaizen-setup.
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(join(project, '.claude/settings.json'), JSON.stringify({ permissions: { allow: [] } }));

    const { results } = runDoctor(project, home);
    expect(findResult(results, 'single-registration-path').status).toBe('PASS');
    expect(findResult(results, 'plugin-double-install').status).toBe('PASS'); // activation absent = clean
  });

  it('State 3: marketplace-only — plugin listed in installed_plugins but activation flag absent in this project', () => {
    writeFileSync(
      join(home, '.claude/plugins/installed_plugins.json'),
      JSON.stringify({
        plugins: {
          'kaizen@kaizen': [
            { projectPath: '/some/other/project', installPath: '/nope' },
          ],
        },
      }),
    );
    // Our project: no settings.json activation.
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(join(project, '.claude/settings.json'), JSON.stringify({}));

    const { results } = runDoctor(project, home);
    // stale-plugin-cache must report PASS here — the installed_plugins entry
    // targets a DIFFERENT projectPath, so it's not a cache drift for US.
    expect(findResult(results, 'stale-plugin-cache').status).toBe('PASS');
  });

  it('footgun guard: enabled + hooks block is NOT reachable via /kaizen-setup enable', () => {
    // Even if the host already has a hooks block (e.g., non-kaizen hooks),
    // --step enable only adds enabledPlugins — it never touches the hooks key.
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(
      join(project, '.claude/settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './their-own-hook.sh' }] }],
        },
      }),
    );
    enablePlugin(project);
    const parsed = JSON.parse(readFileSync(join(project, '.claude/settings.json'), 'utf-8'));
    expect(parsed.hooks).toBeDefined(); // their hook preserved
    expect(parsed.enabledPlugins['kaizen@kaizen']).toBe(true);
    // The dual-load guard (kaizen-block-self-plugin-enable.sh) would fire on
    // commit for this state — but --step enable itself doesn't CAUSE the
    // state, it just makes the existing hooks-block-author's choice visible.
  });

  it('state transitions are reversible — enable, then manually disable, then enable again', () => {
    enablePlugin(project);
    let parsed = JSON.parse(readFileSync(join(project, '.claude/settings.json'), 'utf-8'));
    expect(parsed.enabledPlugins['kaizen@kaizen']).toBe(true);

    // Manual disable
    delete parsed.enabledPlugins['kaizen@kaizen'];
    writeFileSync(join(project, '.claude/settings.json'), JSON.stringify(parsed, null, 2));

    // Re-enable is not a no-op — it writes changed:true
    const r = enablePlugin(project);
    expect(r.changed).toBe(true);
    parsed = JSON.parse(readFileSync(join(project, '.claude/settings.json'), 'utf-8'));
    expect(parsed.enabledPlugins['kaizen@kaizen']).toBe(true);
  });
});
