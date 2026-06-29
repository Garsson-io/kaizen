---
name: kaizen-setup
description: Install and configure the kaizen plugin for a host project. Creates kaizen.config.json, scaffolds policies-local.md, injects agent-instructions section. Triggers on "kaizen setup", "install kaizen", "configure kaizen", "setup kaizen plugin".
user_invocable: true
---

# /kaizen-setup — Install Kaizen Plugin

Configure kaizen for the current project. Plugin hooks, skills, and agents are registered automatically via `plugin.json`. This setup creates host-project config files.

## Step 0: Resolve plugin root

`CLAUDE_PLUGIN_ROOT` is reliable inside hook invocations, but it may be empty in
ad-hoc Bash calls made while this skill runs. Prefer it when present; otherwise
derive the root from Claude Code's plugin registry.

```bash
if [ -z "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  CLAUDE_PLUGIN_ROOT="$(claude plugin list --json 2>/dev/null \
    | jq -r '.[]? | select((.id // .name // .plugin) == "kaizen@kaizen" or (.id // .name // .plugin) == "kaizen") | (.installPath // .path // .root // .cachePath)')"
  export CLAUDE_PLUGIN_ROOT
fi
echo "CLAUDE_PLUGIN_ROOT=$CLAUDE_PLUGIN_ROOT"
```

If it is still empty, the plugin isn't installed for this project. Tell the user:
```
/plugin marketplace add Garsson-io/kaizen --scope project
/plugin install kaizen@kaizen --scope project
```
Then run `/reload-plugins` or restart Claude Code and re-run `/kaizen-setup`.

## Step 0.25: Check project-scope preconditions

Project-scope install writes activation to `.claude/settings.json`. If the host
repo gitignores the whole `.claude/` directory, activation silently stays local.

```bash
npx --prefix "$CLAUDE_PLUGIN_ROOT" tsx "$CLAUDE_PLUGIN_ROOT/src/kaizen-setup.ts" --step precondition
```

If this reports `status:"warn"`, replace broad `.claude/` ignores with the
narrow session-local entries shown in the warning.

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

Append the kaizen section to the host agent-instructions file mechanically:

```bash
npx --prefix "$CLAUDE_PLUGIN_ROOT" tsx "$CLAUDE_PLUGIN_ROOT/src/kaizen-setup.ts" --step inject-instructions
```

The step picks `CLAUDE.md` when present, falls back to `AGENTS.md`, creates
`CLAUDE.md` when neither exists, replaces the legacy root placeholder, and
skips when the kaizen section is already present.

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
| 1 | Resolve root and preconditions | Resolve `CLAUDE_PLUGIN_ROOT`, run `precondition` |
| 2 | Create config and policies | Run CLI for config + scaffold steps |
| 3 | Inject instructions and verify | Run `inject-instructions`, then `verify` |
| 4 | Install git hooks | Run `install-git-hooks` step (epic #1059) |

## Idempotency

Safe to re-run — config overwrites, scaffold skips if exists, verify re-checks, install-git-hooks detects existing kaizen chain markers and skips.
