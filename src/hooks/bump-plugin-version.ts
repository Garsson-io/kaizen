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

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readHookInput } from './hook-io.js';
import { isGhPrCommand, stripHeredocBody } from './parse-command.js';

export function bumpPluginVersion(
  command: string,
  options: {
    gitRunner?: (args: string) => string;
    projectRoot?: string;
  } = {},
): string | null {
  const cmdLine = stripHeredocBody(command);
  if (!isGhPrCommand(cmdLine, 'create')) return null;

  const git = options.gitRunner ?? ((args: string) => {
    try {
      return execSync(`git ${args}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
      return '';
    }
  });

  const projectRoot = options.projectRoot ?? (git('rev-parse --show-toplevel') || process.cwd());
  const pluginJson = join(projectRoot, '.claude-plugin', 'plugin.json');
  if (!existsSync(pluginJson)) return null;

  // Compare version on current branch vs main
  const mainVersion = (() => {
    try {
      const raw = git('show origin/main:.claude-plugin/plugin.json');
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

  // Stage, commit, and push (#919: push so gh pr create doesn't fail)
  try {
    git(`add "${pluginJson}"`);
    git(`commit -m "chore: bump plugin version to ${newVersion}" -m "Auto-bumped by kaizen-bump-plugin-version hook."`);
  } catch {
    // If commit fails (nothing to commit, etc.), ignore
  }
  try {
    git('push');
  } catch {
    // Push failure is non-blocking — agent can retry (#919: fail-open)
  }

  return `Plugin version bumped: ${currentVersion} -> ${newVersion}`;
}

async function main(): Promise<void> {
  const input = await readHookInput();
  if (!input) process.exit(0);

  const command = input.tool_input?.command ?? '';
  const result = bumpPluginVersion(command);

  if (result) {
    process.stdout.write(`\n${result}\n   (Claude Code requires version bumps to deliver updates to users)\n`);
  }
  process.exit(0);
}

if (
  process.argv[1]?.endsWith('bump-plugin-version.ts') ||
  process.argv[1]?.endsWith('bump-plugin-version.js')
) {
  main().catch(() => process.exit(0));
}
