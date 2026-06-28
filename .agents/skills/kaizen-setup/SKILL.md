---
name: kaizen-setup
description: Install and configure the kaizen plugin for a host project. Creates kaizen.config.json, scaffolds policies-local.md, injects agent-instructions section. Triggers on "kaizen setup", "install kaizen", "configure kaizen", "setup kaizen plugin".
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

## Step 0.5: Enable at project scope (#1063)

After install, the plugin is downloaded but dormant until the host project **activates** it. Run:

```bash
npx --prefix "$CLAUDE_PLUGIN_ROOT" tsx "$CLAUDE_PLUGIN_ROOT/src/kaizen-setup.ts" --step enable
```

This idempotently writes `enabledPlugins["kaizen@kaizen"] = true` into the host project's `.claude/settings.json`, preserving all other keys. Safe to re-run.

Activation lives ONLY in the project's `.claude/settings.json`, never in user-scope, and never alongside a `hooks` block — either of those re-creates the #1061 dual-load state (guarded by `scripts/kaizen-self-invariants.test.ts` and the `kaizen-block-self-plugin-enable.sh` PreToolUse hook). kaizen-on-kaizen follows the same pattern: the kaizen repo's own settings.json activates via `enabledPlugins` only.

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

Creates `.agents/kaizen/local/policies-local.md` if it doesn't exist.

## Step 3: Inject CLAUDE.md section

Read the fragment at `${CLAUDE_PLUGIN_ROOT}/.agents/kaizen/instructions-fragment.md` and append it to the host agent-instructions file (typically `CLAUDE.md`; if your host workflow uses `AGENTS.md` as the primary instructions file, append there instead). If the target file doesn't exist, create it. If it already has a kaizen section, skip.

## Step 4: Verify

```bash
npx --prefix "$CLAUDE_PLUGIN_ROOT" tsx "$CLAUDE_PLUGIN_ROOT/src/kaizen-setup.ts" --step verify
```

Reports which checks pass/fail. Fix any failures.

## Step 5: Install git hooks (epic #1059)

Installs kaizen's `pre-push` git hook into the host project. Detects the host's hook framework (pre-commit, husky, lefthook, raw `.git/hooks`, or none) and injects kaizen non-destructively. Idempotent — safe to re-run.

```bash
npx --prefix "$CLAUDE_PLUGIN_ROOT" tsx "$CLAUDE_PLUGIN_ROOT/src/kaizen-setup.ts" \
  --step install-git-hooks --run-post-install true
```

Result reports the detected framework, modified files, and any post-install commands (e.g., for pre-commit hosts: `pre-commit install --hook-type pre-push`). With `--run-post-install true`, those commands run automatically.

**What gets installed:**
- Framework-specific injection (one of):
  - pre-commit: adds a remote `https://github.com/Garsson-io/kaizen` repo hook `kaizen-pre-push` with a pinned `rev`; no `.kaizen-hooks/` host wrapper is written
  - husky: writes `.kaizen-hooks/pre-push` and appends a chain block to `.husky/pre-push`
  - lefthook: adds a remote `https://github.com/Garsson-io/kaizen` config `lefthook-kaizen.yml` with a branch/tag `ref`; no `.kaizen-hooks/` host wrapper is written
  - raw `.git/hooks/pre-push`: writes `.kaizen-hooks/pre-push` and appends a chain block
  - none: writes `.kaizen-hooks/pre-push`, creates `.githooks/pre-push`, and sets `git config core.hooksPath .githooks`

See `docs/git-hooks-design.md` for architecture and decision rationale.

## Workflow Tasks

| # | Task | Description |
|---|------|-------------|
| 1 | Check installation | Verify CLAUDE_PLUGIN_ROOT is set |
| 2 | Create config and policies | Run CLI for config + scaffold steps |
| 3 | Inject CLAUDE.md and verify | Append kaizen section, run verify |
| 4 | Install git hooks | Run `install-git-hooks` step (epic #1059) |

## Idempotency

Safe to re-run — config overwrites, scaffold skips if exists, verify re-checks, install-git-hooks detects existing kaizen chain markers and skips.
