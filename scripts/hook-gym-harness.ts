/**
 * hook-gym-harness.ts — Test harness for Hook Gym scenarios.
 *
 * Provides a clean API for:
 * - Setting up a fixture repo with kaizen installed
 * - Running a scenario and capturing the hook timeline
 * - Querying the results with expressive assertions
 * - Cleaning up after the run (PRs, branches, temp dirs)
 *
 * Usage:
 *   const fixture = await FixtureRepo.create('Garsson-io/kaizen-test-fixture');
 *   const run = await fixture.run(scenario, { model: 'haiku' });
 *   console.log(run.hooks.fired());           // all hooks that fired
 *   console.log(run.gates.activated());       // gates that were set
 *   console.log(run.agent.createdPR());       // PR URL if created
 *   await fixture.cleanup();
 */

import { spawn as realSpawn, execFileSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import type { HookTimeline, ParsedHookEvent, Scenario } from './hook-gym-schema.js';
import { createHookStreamProcessor } from './hook-gym-stream.js';
import { renderPrompt } from './hook-gym-scenarios.js';
import { validateAgainstScenario, validateFixtureFile, formatValidationReport, type ValidationReport } from './hook-gym-validate.js';
import { formatTimeline } from './hook-gym-format.js';
import { parseJsonLines } from '../src/lib/json-lines.js';
import { parseJsonObject } from '../src/lib/json-value.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Scenario setup-file seeding ─────────────────────────────────

/**
 * Write per-scenario setup files into a fixture repo and commit them.
 *
 * Idempotent: files whose on-disk content already matches are skipped, so
 * running twice against the same fixture produces no spurious commits.
 * Paths that would escape the fixture dir (via `..` or absolute paths) are
 * refused. Writes happen BEFORE the agent spawns so the scenario prompt's
 * assumptions about host state (e.g. ".pre-commit-config.yaml exists") are
 * true from turn zero. Extracted as a standalone function so scenarios that
 * need seeded host state can be tested without spinning up a full FixtureRepo.
 */
export function seedSetupFiles(
  fixtureDir: string,
  scenarioName: string,
  files: Record<string, string>,
  log: (...args: unknown[]) => void = () => {},
): { wrote: number; committed: boolean } {
  let wrote = 0;
  for (const [relPath, content] of Object.entries(files)) {
    const target = resolve(fixtureDir, relPath);
    if (!target.startsWith(fixtureDir + '/') && target !== fixtureDir) {
      log(`[fixture] refusing setupFile escape: ${relPath}`);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    let existing: string | null = null;
    try { existing = readFileSync(target, 'utf-8'); } catch { /* new file */ }
    if (existing === content) continue;
    writeFileSync(target, content, { flag: 'w' });
    wrote++;
  }
  if (wrote === 0) {
    log(`[fixture] setupFiles for ${scenarioName}: no changes`);
    return { wrote: 0, committed: false };
  }
  log(`[fixture] Seeded ${wrote} file(s) for ${scenarioName}`);
  execFileSync('git', ['add', '-A'], { stdio: 'pipe', timeout: 10_000, cwd: fixtureDir });
  try {
    execFileSync('git', [
      'commit', '-m', `chore: seed files for ${scenarioName} (hook-gym)`, '--no-verify',
    ], { stdio: 'pipe', timeout: 10_000, cwd: fixtureDir });
    return { wrote, committed: true };
  } catch {
    return { wrote, committed: false };
  }
}

// ── FixtureRepo ─────────────────────────────────────────────────

export class FixtureRepo {
  readonly dir: string;
  readonly hostRepo: string;
  readonly kaizenRoot: string;

  private constructor(dir: string, hostRepo: string, kaizenRoot: string) {
    this.dir = dir;
    this.hostRepo = hostRepo;
    this.kaizenRoot = kaizenRoot;
  }

  /**
   * Clone a host repo and install kaizen — full setup, same as any real project.
   */
  static async create(
    hostRepo: string,
    opts: { kaizenRoot?: string; log?: (...args: unknown[]) => void } = {},
  ): Promise<FixtureRepo> {
    const kaizenRoot = opts.kaizenRoot ?? resolve(__dirname, '..');
    const log = opts.log ?? console.log;
    // mkdtempSync for unique path (no race), then remove so git clone can create it
    const dir = mkdtempSync(join(tmpdir(), 'hook-gym-'));
    rmSync(dir, { recursive: true });

    // Clone
    log(`[fixture] Cloning ${hostRepo}...`);
    execFileSync('git', ['clone', '--depth', '1', `https://github.com/${hostRepo}.git`, dir], {
      stdio: 'pipe', timeout: 60_000,
    });

    // Install kaizen plugin from the current worktree.
    // Force marketplace update first to ensure the latest code is picked up
    // (the plugin system caches at install time, not live-links).
    log(`[fixture] Installing kaizen plugin from ${kaizenRoot}...`);
    try { execFileSync('claude', ['plugins', 'marketplace', 'add', kaizenRoot], { stdio: 'pipe', timeout: 15_000, cwd: dir }); } catch { /* may already exist */ }
    try { execFileSync('claude', ['plugins', 'marketplace', 'update', 'kaizen'], { stdio: 'pipe', timeout: 15_000, cwd: dir }); } catch { /* best effort */ }
    execFileSync('claude', ['plugins', 'install', 'kaizen@kaizen', '--scope', 'project'], {
      stdio: 'pipe', timeout: 15_000, cwd: dir,
    });

    // Run kaizen-setup (config + scaffold)
    const repoName = hostRepo.split('/').pop() ?? 'fixture';
    execFileSync('npx', [
      '--prefix', kaizenRoot, 'tsx', `${kaizenRoot}/src/kaizen-setup.ts`,
      '--step', 'config', '--name', repoName, '--repo', hostRepo,
      '--description', 'Hook Gym test fixture', '--kaizen-repo', 'Garsson-io/kaizen',
    ], { stdio: 'pipe', timeout: 15_000, cwd: dir });
    execFileSync('npx', [
      '--prefix', kaizenRoot, 'tsx', `${kaizenRoot}/src/kaizen-setup.ts`,
      '--step', 'scaffold',
    ], { stdio: 'pipe', timeout: 15_000, cwd: dir });

    // Inject CLAUDE.md instructions fragment
    const fragmentPath = join(kaizenRoot, '.agents', 'kaizen', 'instructions-fragment.md');
    try {
      let fragment = readFileSync(fragmentPath, 'utf-8');
      fragment = fragment.replace(/\{\{KAIZEN_ROOT\}\}/g, kaizenRoot);
      const claudeMdPath = join(dir, 'CLAUDE.md');
      let existing = '';
      try { existing = readFileSync(claudeMdPath, 'utf-8'); } catch { /* new file */ }
      if (!existing.toLowerCase().includes('kaizen')) {
        // O_WRONLY|O_CREAT|O_TRUNC — atomic create-or-replace, no TOCTOU
        writeFileSync(claudeMdPath, existing + '\n' + fragment, { flag: 'w' });
      }
    } catch { /* fragment not found — skip */ }

    // Gitignore runtime artifacts — append idempotently
    const gitignorePath = join(dir, '.gitignore');
    let gitignore = '';
    try { gitignore = readFileSync(gitignorePath, 'utf-8'); } catch { /* new file */ }
    if (!gitignore.includes('.kaizen/telemetry')) {
      writeFileSync(gitignorePath, gitignore + '\n.kaizen/telemetry/\n', { flag: 'w' });
    }

    // Commit setup files so working tree is clean (skip if nothing to commit)
    execFileSync('git', ['add', '-A'], { stdio: 'pipe', timeout: 10_000, cwd: dir });
    try {
      execFileSync('git', ['commit', '-m', 'chore: kaizen setup (hook-gym)', '--no-verify'], { stdio: 'pipe', timeout: 10_000, cwd: dir });
    } catch {
      log('[fixture] Nothing to commit (setup already committed)');
    }

    // Verify installation: log plugin version + source path
    try {
      const pluginList = execFileSync('claude', ['plugins', 'list'], {
        encoding: 'utf-8', timeout: 10_000, cwd: dir,
      });
      const kaizenLines = pluginList.split('\n').filter(l => l.includes('kaizen') || l.includes('Version') || l.includes('Status') || l.includes('Scope'));
      log(`[fixture] Plugin state:\n${kaizenLines.map(l => `  ${l.trim()}`).join('\n')}`);
    } catch { /* best effort */ }

    // Verify hooks exist by checking what settings.json contains
    try {
      const settingsPath = join(dir, '.claude', 'settings.json');
      if (existsSync(settingsPath)) {
        const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        const plugins = settings.enabledPlugins ?? {};
        log(`[fixture] Enabled plugins: ${JSON.stringify(plugins)}`);
      }
    } catch { /* best effort */ }

    log(`[fixture] Ready at ${dir}`);
    return new FixtureRepo(dir, hostRepo, kaizenRoot);
  }

  /**
   * Run a scenario against this fixture repo.
   */
  async run(scenario: Scenario, opts: RunOpts = {}): Promise<RunResult> {
    if (scenario.setupFiles) {
      seedSetupFiles(this.dir, scenario.name, scenario.setupFiles, opts.log ?? console.log);
    }
    return runScenario(scenario, { ...opts, cwd: this.dir, hostRepo: this.hostRepo });
  }

  /**
   * Clean up: close PRs created by hook-gym, delete branches, remove temp dir.
   */
  async cleanup(log: (...args: unknown[]) => void = console.log): Promise<void> {
    // Close hook-gym PRs
    try {
      const prList = execFileSync('gh', [
        'pr', 'list', '--repo', this.hostRepo, '--state', 'open',
        '--json', 'number,headRefName',
        '--jq', '.[] | select(.headRefName | startswith("hook-gym")) | .number',
      ], { encoding: 'utf-8', timeout: 10_000 }).trim();
      for (const prNum of prList.split('\n').filter(Boolean)) {
        try {
          execFileSync('gh', [
            'pr', 'close', prNum, '--repo', this.hostRepo,
            '--comment', 'Hook Gym — auto-closed.', '--delete-branch',
          ], { stdio: 'pipe', timeout: 10_000 });
          log(`[fixture] Closed PR #${prNum}`);
        } catch { /* best effort per PR */ }
      }
    } catch { /* best effort */ }

    // Remove temp dir
    try {
      rmSync(this.dir, { recursive: true, force: true });
      log(`[fixture] Cleaned up ${this.dir}`);
    } catch { /* best effort */ }
  }
}

// ── RunResult ───────────────────────────────────────────────────

export interface RunOpts {
  model?: string;
  debug?: boolean;
  log?: (...args: unknown[]) => void;
  /** Override spawn for unit tests. */
  spawn?: typeof realSpawn;
  /** Override output dir. Default: .hook-gym/runs/<ts>-<name>/ */
  outRoot?: string;
}

export class RunResult {
  readonly scenario: string;
  readonly timeline: HookTimeline;
  readonly validation: ValidationReport;
  readonly selfCheckPassed: boolean;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly outDir: string;
  readonly streamLines: string[];
  readonly events: ParsedHookEvent[];
  private parsedStreamMessagesCache?: Record<string, any>[];

  constructor(data: {
    scenario: string;
    timeline: HookTimeline;
    validation: ValidationReport;
    selfCheckPassed: boolean;
    timedOut: boolean;
    durationMs: number;
    outDir: string;
    streamLines: string[];
  }) {
    this.scenario = data.scenario;
    this.timeline = data.timeline;
    this.validation = data.validation;
    this.selfCheckPassed = data.selfCheckPassed;
    this.timedOut = data.timedOut;
    this.durationMs = data.durationMs;
    this.outDir = data.outDir;
    this.streamLines = data.streamLines;
    this.events = data.timeline.events;
  }

  private get parsedStreamMessages(): Record<string, any>[] {
    this.parsedStreamMessagesCache ??= parseJsonLines<Record<string, any>>(
      this.streamLines.join('\n'),
    );
    return this.parsedStreamMessagesCache;
  }

  get passed(): boolean {
    // Self-check is diagnostic (logs a warning on mismatch) but not a gate.
    // The validation result is the authoritative verdict.
    return this.validation.passed;
  }

  // ── Hook queries ──

  get hooks() {
    const events = this.events;
    return {
      /** All hook events. */
      all: () => events,
      /** Hooks filtered by event type. */
      byType: (type: string) => events.filter(e => e.eventType === type),
      /** All hooks that fired (any event type). */
      fired: () => events,
      /** All denials. */
      denials: () => events.filter(e => e.decision === 'deny'),
      /** All blocks. */
      blocks: () => events.filter(e => e.decision === 'block'),
      /** All gate-set events. */
      gatesSets: () => events.filter(e => e.decision === 'set-gate'),
      /** All gate-clear events. */
      gateClears: () => events.filter(e => e.decision === 'clear-gate'),
      /** Events matching a hook name pattern. */
      matching: (pattern: string) => events.filter(e =>
        e.hookName.includes(pattern) || e.eventType.includes(pattern),
      ),
    };
  }

  // ── Gate queries ──

  get gates() {
    const tl = this.timeline;
    return {
      /** Gates that were activated during the run. */
      activated: () => Object.keys(tl.gatesActivated),
      /** Gates that were cleared during the run. */
      cleared: () => Object.keys(tl.gatesCleared),
      /** Check if a specific gate was activated. */
      wasActivated: (gate: string) => gate in tl.gatesActivated,
      /** Check if a specific gate was cleared. */
      wasCleared: (gate: string) => gate in tl.gatesCleared,
      /** Check if a gate is still active (activated but not cleared). */
      isActive: (gate: string) => (gate in tl.gatesActivated) && !(gate in tl.gatesCleared),
    };
  }

  // ── Agent action queries (from stream) ──

  get agent() {
    const messages = this.parsedStreamMessages;
    const toolUses = (): Array<{ tool: string; input: Record<string, unknown> }> => {
      const uses: Array<{ tool: string; input: Record<string, unknown> }> = [];
      for (const d of messages) {
        if (d.type === 'assistant') {
          for (const block of d.message?.content ?? []) {
            if (block.type === 'tool_use') {
              uses.push({ tool: block.name, input: block.input ?? {} });
            }
          }
        }
      }
      return uses;
    };
    return {
      /** Extract all tool_use actions from the stream. */
      toolUses,
      /** Check if the agent used a specific tool. */
      usedTool: (name: string) => toolUses().some((use) => use.tool === name),
      /** Check if the agent used a skill. */
      usedSkill: (skillName?: string) => {
        return toolUses().some((use) => {
          if (use.tool !== 'Skill') return false;
          if (!skillName) return true;
          const skill = use.input.skill ?? '';
          return String(skill).includes(skillName);
        });
      },
      /** Find the PR URL if the agent created one. */
      createdPR: (): string | null => {
        for (const d of messages) {
          // Look in tool_result content for PR URL
          if (d.type === 'user') {
            const content = d.message?.content;
            if (Array.isArray(content)) {
              for (const c of content) {
                const text = c.content ?? c.text ?? '';
                const match = text.match(/https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/);
                if (match) return match[0];
              }
            }
          }
        }
        return null;
      },
      /** Check if the agent entered a worktree. */
      enteredWorktree: () => toolUses().some((use) => use.tool === 'EnterWorktree'),
    };
  }

  /** Diagnose hook behavior — which hooks produced output, which were silent. */
  diagnose(): string {
    const lines: string[] = ['=== Hook Diagnosis ==='];
    const byType: Record<string, { total: number; withOutput: number; decisions: string[] }> = {};
    for (const e of this.events) {
      if (!byType[e.eventType]) byType[e.eventType] = { total: 0, withOutput: 0, decisions: [] };
      byType[e.eventType].total++;
      if (e.rawOutput) byType[e.eventType].withOutput++;
      if (e.decision && e.decision !== 'none') {
        byType[e.eventType].decisions.push(`${e.decision}:${e.reason ?? '?'}`);
      }
    }
    for (const [type, stats] of Object.entries(byType)) {
      lines.push(`  ${type}: ${stats.total} events, ${stats.withOutput} with output`);
      if (stats.decisions.length > 0) {
        lines.push(`    decisions: ${stats.decisions.join(', ')}`);
      }
    }
    // Check for YAML gate signals specifically
    const yamlSignals = this.events.filter(e =>
      e.rawOutput.includes('---\nhook:') || e.rawOutput.includes('---\ngate:'),
    );
    lines.push(`  YAML gate signals found: ${yamlSignals.length}`);
    if (yamlSignals.length === 0) {
      lines.push(`  ⚠ No YAML signals — plugin may be running stale hooks without YAML output`);
    }
    return lines.join('\n');
  }

  /** Human-readable summary. */
  summary(): string {
    return [
      `Scenario: ${this.scenario}`,
      `Duration: ${(this.durationMs / 1000).toFixed(1)}s${this.timedOut ? ' (timeout)' : ''}`,
      `Hook events: ${this.events.length}`,
      `Gates activated: ${this.gates.activated().join(', ') || 'none'}`,
      `Gates cleared: ${this.gates.cleared().join(', ') || 'none'}`,
      `Denials: ${this.hooks.denials().length}`,
      `Blocks: ${this.hooks.blocks().length}`,
      `PR created: ${this.agent.createdPR() ?? 'none'}`,
      `Used skills: ${this.agent.usedSkill() ? 'yes' : 'no'}`,
      `Entered worktree: ${this.agent.enteredWorktree() ? 'yes' : 'no'}`,
      `Validation: ${this.validation.passed ? 'PASS' : 'FAIL'} (${this.validation.hooksMatched}/${this.validation.hooksTotal} hooks, ${this.validation.gatesMatched}/${this.validation.gatesTotal} gates)`,
      `Self-check: ${this.selfCheckPassed ? 'PASS' : 'FAIL'}`,
    ].join('\n');
  }
}

// ── Run logic ───────────────────────────────────────────────────

function timestamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/**
 * Run all scenarios serially, print summary, return aggregate.
 */
export async function runAll(
  scenarios: Scenario[],
  opts: RunOpts & { cwd?: string; hostRepo?: string } = {},
): Promise<{ results: RunResult[]; allPassed: boolean }> {
  const log = opts.log ?? console.log;
  const results: RunResult[] = [];
  log(`[run] Running ${scenarios.length} scenarios...\n`);
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario, opts));
    log('');
  }
  const allPassed = results.every(r => r.passed);
  log(`\n${results.filter(r => r.passed).length}/${results.length} passed.`);
  return { results, allPassed };
}

export function getHostRepo(): string {
  try {
    const config = JSON.parse(readFileSync('kaizen.config.json', 'utf-8'));
    return config?.host?.repo ?? 'Garsson-io/kaizen';
  } catch {
    return 'Garsson-io/kaizen';
  }
}

/**
 * Run a scenario. Can be called via FixtureRepo.run() or directly for unit tests.
 *
 * For unit tests: pass opts.spawn (mocked), opts.hostRepo, opts.outRoot.
 * For live runs: called by FixtureRepo.run() which passes cwd + hostRepo.
 */
export async function runScenario(
  scenario: Scenario,
  opts: RunOpts & { cwd?: string; hostRepo?: string } = {},
): Promise<RunResult> {
  const spawnFn = opts.spawn ?? realSpawn;
  const model = opts.model ?? scenario.model;
  const log = opts.log ?? console.log;
  const debug = opts.debug ?? false;
  const outRoot = opts.outRoot ?? '.hook-gym/runs';
  const hostRepo = opts.hostRepo ?? getHostRepo();
  const cwd = opts.cwd;

  const ts = timestamp();
  const outDir = resolve(outRoot, `${ts}-${scenario.name}`);
  mkdirSync(outDir, { recursive: true });

  const rendered = renderPrompt(scenario.prompt, {
    timestamp: ts,
    host_repo: hostRepo,
  });

  log(`[run] ${scenario.name} (model=${model}, timeout=${scenario.timeoutSeconds}s${cwd ? `, cwd=${cwd}` : ''})`);

  const streamLines: string[] = [];
  const processor = createHookStreamProcessor();
  const startMs = Date.now();

  const { timedOut } = await new Promise<{ timedOut: boolean }>((resolve) => {
    const child: ChildProcess = spawnFn('claude', [
      '-p', rendered,
      '--model', model,
      '--verbose',
      '--output-format', 'stream-json',
      '--include-hook-events',
      '--max-turns', '50',
      '--allowedTools', 'Bash,Read,Write,Edit,Glob,Grep,Skill,Agent',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      ...(cwd ? { cwd } : {}),
    } as SpawnOptions);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log(`[run] Timeout (${scenario.timeoutSeconds}s) — killing.`);
      child.kill('SIGTERM');
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5000);
    }, scenario.timeoutSeconds * 1000);

    let buf = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        streamLines.push(line);
        const msg = parseJsonObject(line);
        if (!msg) continue;
        try {
          const wasHook = processor.process(msg);
          if (wasHook && debug) process.stderr.write(`[hook] ${line}\n`);
        } catch { /* skip malformed stream messages */ }
      }
    });

    if (debug) child.stderr?.on('data', (c: Buffer) => process.stderr.write(c));

    child.on('close', () => { clearTimeout(timer); resolve({ timedOut }); });
    child.on('error', (err) => {
      clearTimeout(timer);
      log(`[run] Spawn error: ${err.message}`);
      resolve({ timedOut });
    });
  });

  const durationMs = Date.now() - startMs;
  const timeline = processor.getTimeline();

  log(`[run] Done in ${(durationMs / 1000).toFixed(1)}s — ${timeline.events.length} events.`);

  // Write output files
  writeFileSync(join(outDir, 'stream.jsonl'), streamLines.join('\n') + '\n');
  writeFileSync(join(outDir, 'timeline.md'), formatTimeline(timeline));
  writeFileSync(join(outDir, 'result.json'), JSON.stringify({
    scenario: scenario.name, model, durationMs, timedOut,
    hookEventCount: timeline.events.length,
    timeline,
  }, null, 2) + '\n');

  // Validate + self-check
  const validation = validateAgainstScenario(timeline, scenario);
  let selfCheckPassed = false;
  try {
    const replay = validateFixtureFile(join(outDir, 'stream.jsonl'), scenario);
    selfCheckPassed = replay.passed === validation.passed;
    if (selfCheckPassed) {
      log(`[run] Self-check: fixture replay matches live verdict (${validation.passed ? 'PASS' : 'FAIL'}).`);
    } else {
      log(`[run] Self-check MISMATCH: live=${validation.passed}, replay=${replay.passed}`);
    }
  } catch (err) {
    log(`[run] Self-check error: ${err instanceof Error ? err.message : err}`);
  }

  const result = new RunResult({
    scenario: scenario.name, timeline, validation,
    selfCheckPassed, timedOut, durationMs, outDir, streamLines,
  });

  // Print summary
  log('');
  log(formatValidationReport(validation));
  log(result.summary());

  return result;
}
