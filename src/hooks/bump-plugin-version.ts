/**
 * bump-plugin-version.ts — Auto-bump plugin version before PR creation.
 *
 * TypeScript port of .claude/hooks/kaizen-bump-plugin-version.sh (kaizen #775).
 *
 * PreToolUse(Bash) hook: detects `gh pr create` and bumps the patch version
 * in .claude-plugin/plugin.json if it hasn't been bumped already.
 *
 * No .tmp files — uses in-memory JSON manipulation (kaizen #775).
 * Always exits 0 — advisory, never blocks.
 *
 * Part of kAIzen Agent Control Flow — kaizen #775
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readHookInput, traceNullInput } from './hook-io.js';
import { isGhPrCommand, stripHeredocBody } from './parse-command.js';
import { createDefaultGitExec, resolveTargetWorktree, type GitExec } from './lib/git-state.js';

export function bumpPluginVersion(
  command: string,
  options: {
    /**
     * argv-safe git runner (git-state.ts contract). The default routes
     * through `spawnSync('git', argv)` — no shell string interpolation.
     */
    exec?: GitExec;
    projectRoot?: string;
    /** Agent process cwd; used as the fallback target worktree (#1073/#240). */
    cwd?: string;
  } = {},
): string | null {
  const cmdLine = stripHeredocBody(command);
  if (!isGhPrCommand(cmdLine, 'create')) return null;

  const exec = options.exec ?? createDefaultGitExec();
  const fallbackCwd = options.cwd ?? process.cwd();

  // #1073/#240: anchor every git read to the *gated command's* worktree, not
  // the agent's inherited process.cwd(). When the agent runs
  // `cd <worktree> && gh pr create` while its cwd is the main checkout, an
  // un-anchored `rev-parse --show-toplevel` resolves the MAIN repo and bumps
  // the wrong .claude-plugin/plugin.json — the exact #1073 phantom-plugin.json
  // failure mode.
  const target = resolveTargetWorktree(command, fallbackCwd).dir;
  const anchor: readonly string[] = target ? ['-C', target] : [];
  const git = (args: readonly string[]): string => {
    try {
      const r = exec([...anchor, ...args]);
      return r.exitCode === 0 ? r.stdout.trim() : '';
    } catch {
      return '';
    }
  };

  const projectRoot = options.projectRoot ?? (git(['rev-parse', '--show-toplevel']) || fallbackCwd);
  const pluginJson = join(projectRoot, '.claude-plugin', 'plugin.json');
  if (!existsSync(pluginJson)) return null;

  // Compare version on current branch vs main
  const mainVersion = (() => {
    try {
      const raw = git(['show', 'origin/main:.claude-plugin/plugin.json']);
      return raw ? JSON.parse(raw).version || '0.0.0' : '0.0.0';
    } catch {
      return '0.0.0';
    }
  })();

  const content = JSON.parse(readFileSync(pluginJson, 'utf-8'));
  const currentVersion: string = content.version || '0.0.0';

  if (mainVersion !== currentVersion) {
    // Already bumped (author did minor/major, or previous auto-bump)
    return null;
  }

  // Auto-bump patch — no temp files (kaizen #775)
  const parts = currentVersion.split('.');
  const newVersion = `${parts[0]}.${parts[1]}.${Number(parts[2]) + 1}`;
  content.version = newVersion;
  writeFileSync(pluginJson, JSON.stringify(content, null, 2) + '\n');

  // Stage, commit, and push (#919: push so gh pr create doesn't fail).
  // argv form — the filename is a discrete array element, never interpolated
  // into a shell string (#1073 review: kill the shell-injection surface).
  try {
    git(['add', pluginJson]);
    git([
      'commit',
      '-m', `chore: bump plugin version to ${newVersion}`,
      '-m', 'Auto-bumped by kaizen-bump-plugin-version hook.',
    ]);
  } catch {
    // If commit fails (nothing to commit, etc.), ignore
  }
  try {
    git(['push']);
  } catch {
    // Push failure is non-blocking — agent can retry (#919: fail-open)
  }

  return `Plugin version bumped: ${currentVersion} -> ${newVersion}`;
}

async function main(): Promise<void> {
  const input = await readHookInput();
  if (!input) { traceNullInput("bump-plugin-version"); process.exit(0); }

  const command = input.tool_input?.command ?? '';
  const result = bumpPluginVersion(command);

  if (result) {
    const { formatHookOutput } = await import('./lib/gate-signal.js');
    process.stdout.write(
      formatHookOutput({ hook: 'bump-plugin-version', type: 'info', reason: result }) +
      `   (Claude Code requires version bumps to deliver updates to users)\n`,
    );
  }
  process.exit(0);
}

if (
  process.argv[1]?.endsWith('bump-plugin-version.ts') ||
  process.argv[1]?.endsWith('bump-plugin-version.js')
) {
  main().catch(() => process.exit(0));
}
