---
name: kaizen-setup
description: Install and configure the kaizen plugin for a host project. Creates kaizen.config.json, scaffolds policies-local.md, injects CLAUDE.md section. Triggers on "kaizen setup", "install kaizen", "configure kaizen", "setup kaizen plugin".
user_invocable: true
---

# /kaizen-setup — Install Kaizen Plugin

Configure kaizen for the current project. Plugin hooks, skills, and agents are registered automatically via `plugin.json`. This setup creates host-project config files.

## Step 0: Check installation

Verify kaizen is installed:
```bash
echo "CLAUDE_PLUGIN_ROOT=$CLAUDE_PLUGIN_ROOT"
```

If `CLAUDE_PLUGIN_ROOT` is empty, the plugin isn't installed. Tell the user:
```
/plugin marketplace add Garsson-io/kaizen
/plugin install kaizen@kaizen
```
Then restart Claude Code and re-run `/kaizen-setup`.

## Step 1: Create kaizen.config.json

Ask the user for project name, repo (org/repo), and description. Then run:

```bash
npx --prefix "$CLAUDE_PLUGIN_ROOT" tsx "$CLAUDE_PLUGIN_ROOT/src/kaizen-setup.ts" \
  --step config \
  --name "<name>" \
  --repo "<org/repo>" \
  --description "<description>" \
  --kaizen-repo "Garsson-io/kaizen" \
  --channel "none"
```

This creates `kaizen.config.json` in the current project root.

## Step 2: Scaffold policies

```bash
npx --prefix "$CLAUDE_PLUGIN_ROOT" tsx "$CLAUDE_PLUGIN_ROOT/src/kaizen-setup.ts" --step scaffold
```

Creates `.claude/kaizen/policies-local.md` if it doesn't exist.

## Step 3: Inject CLAUDE.md section

Read the fragment at `${CLAUDE_PLUGIN_ROOT}/.claude/kaizen/claude-md-fragment.md` and append it to CLAUDE.md. If CLAUDE.md doesn't exist, create it. If it already has a kaizen section, skip.

## Step 4: Verify

```bash
npx --prefix "$CLAUDE_PLUGIN_ROOT" tsx "$CLAUDE_PLUGIN_ROOT/src/kaizen-setup.ts" --step verify
```

Reports which checks pass/fail. Fix any failures.

## Workflow Tasks

| # | Task | Description |
|---|------|-------------|
| 1 | Check installation | Verify CLAUDE_PLUGIN_ROOT is set |
| 2 | Create config and policies | Run CLI for config + scaffold steps |
| 3 | Inject CLAUDE.md and verify | Append kaizen section, run verify |

## Idempotency

Safe to re-run — config overwrites, scaffold skips if exists, verify re-checks.
