---
name: kaizen-update
description: Pull kaizen plugin updates and re-run setup to apply new hooks and skills. Triggers on "kaizen update", "update kaizen", "pull kaizen updates".
user_invocable: true
---

<!-- Host config: read .claude/kaizen/skill-config-header.md before running commands -->

# /kaizen-update — Update Kaizen Plugin

Pull the latest kaizen updates and re-apply the setup.

## Step 0: Detect install method

```bash
npx tsx src/kaizen-setup.ts --step detect
```

This tells you whether kaizen is installed as `plugin`, `submodule`, or `self` (self-dogfood).

## Step 1: Pull updates

**For submodule installs:**
```bash
git submodule update --remote .kaizen
```

**For plugin installs:**
```bash
claude plugin update kaizen
```

**For self-dogfood (kaizen repo itself):**
```bash
git fetch origin main && git merge origin/main --no-edit
```

## Step 2: Install dependencies

```bash
# For submodule:
cd .kaizen && npm install && cd ..

# For plugin: dependencies are in the plugin cache
# Run npm install from the plugin root if needed:
# npm --prefix "${CLAUDE_PLUGIN_ROOT}" install

# For self-dogfood:
npm install
```

## Step 3: Re-run setup

Re-apply symlinks and merge any new hook registrations. **Skip for plugin installs** — the plugin system handles hook registration via plugin.json.

For submodule installs, this is the same as `/kaizen-setup` steps 3-4, which are idempotent.

## Step 4: Check for new skills

For submodule installs, compare skills in `.kaizen/.claude/skills/` against symlinks in `.claude/skills/`. Report any new skills that were added.

For plugin installs, skills are served directly from the plugin — no symlinks needed.

## Step 5: Validate update

Run post-update validation to verify the update didn't break anything:

```bash
npx --prefix "$CLAUDE_PLUGIN_ROOT" tsx "$CLAUDE_PLUGIN_ROOT/src/kaizen-setup.ts" \
  --step post-update-validate \
  --plugin-root "$CLAUDE_PLUGIN_ROOT"
```

This runs `npm run build` and `npm test` against the plugin. If validation fails:
1. Show the user which check failed and the error output
2. Recommend rolling back: `cd "$CLAUDE_PLUGIN_ROOT" && git checkout HEAD~1`
3. Stop the update — do not proceed to the changelog step

If validation passes, continue to Step 6.

## Step 6: Show changelog

```bash
# For submodule:
git -C .kaizen log --oneline -10

# For self-dogfood:
git log --oneline -10

# For plugin: check the plugin's git log
# git -C "${CLAUDE_PLUGIN_ROOT}" log --oneline -10
```

Report what changed to the user.

## Workflow Tasks

Create these tasks at skill start using TaskCreate:

| # | Task | Description |
|---|------|-------------|
| 1 | Pull updates | `git submodule update --remote` or `git pull` |
| 2 | Install and re-setup | `npm install`, re-run symlinks/hooks (idempotent) |
| 3 | Validate update | Run post-update-validate, abort if build/tests fail |
| 4 | Show changelog | `git log --oneline -10`, report new skills |

**What comes next:** Nothing — standalone update. See [workflow-tasks.md](../../kaizen/workflow-tasks.md) for full workflow.
