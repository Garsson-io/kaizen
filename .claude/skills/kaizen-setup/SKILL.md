---
name: kaizen-setup
description: Install and configure the kaizen plugin for a host project. Creates kaizen.config.json, scaffolds policies-local.md, injects CLAUDE.md section. Triggers on "kaizen setup", "install kaizen", "configure kaizen", "setup kaizen plugin".
user_invocable: true
---

# /kaizen-setup — Install Kaizen Plugin

Interactive setup for configuring kaizen in a host project after installation.

All mechanical steps use `npx tsx src/kaizen-setup.ts --step <name>` which emits structured JSON. You orchestrate the flow, handle user interaction, and make judgment calls.

## Step 0: Detect installation method

```bash
npx tsx src/kaizen-setup.ts --step detect
```

Outputs: `{"method": "plugin"|"submodule"|"none", "root": "..."}`

- **plugin**: Skills, hooks, and agents are registered automatically. Skip steps 3 and 4.
- **submodule**: Need symlinks and hook merging (steps 3 and 4).
- **none**: Kaizen is not installed. Tell the user:
  - Plugin (recommended): `/plugin marketplace add Garsson-io/kaizen` then `/plugin install kaizen@kaizen`
  - Submodule: `git submodule add https://github.com/Garsson-io/kaizen.git .kaizen && cd .kaizen && npm install && cd ..`

## Step 1: Create kaizen.config.json

Ask the user for:
1. **Host project name** — short identifier (e.g., "my-project")
2. **Host repo** — GitHub org/repo (e.g., "org/my-project")
3. **Host description** — brief description
4. **Case CLI** — case management CLI command, or empty for plain git worktrees
5. **Kaizen repo** — where kaizen issues are filed (default: "Garsson-io/kaizen")
6. **Notification channel** — "telegram", "slack", or "none" (default: "none")

Then run:
```bash
npx tsx src/kaizen-setup.ts --step config \
  --name "<name>" --repo "<repo>" --description "<desc>" \
  --kaizen-repo "<kaizen-repo>" --case-cli "<cli>" --channel "<channel>"
```

## Step 2: Scaffold policies

```bash
npx tsx src/kaizen-setup.ts --step scaffold
```

Creates `.claude/kaizen/policies-local.md` if it doesn't exist. Skips if already present.

## Step 3: Set up symlinks (submodule only)

**Skip for plugin installs.**

```bash
npx tsx src/kaizen-setup.ts --step symlinks --kaizen-root .kaizen
```

Creates symlinks from host `.claude/skills/`, `.claude/agents/`, `.claude/kaizen/` into the kaizen submodule.

## Step 4: Merge hook registrations (submodule only)

**Skip for plugin installs.**

```bash
npx tsx src/kaizen-setup.ts --step hooks --kaizen-root .kaizen
```

Merges kaizen hooks into `.claude/settings.json`. Idempotent — won't duplicate on re-run.

## Step 5: Inject CLAUDE.md section

This step is YOUR job — not a script. Read the kaizen CLAUDE.md fragment and inject it appropriately:

- For plugin installs, the fragment is at `${CLAUDE_PLUGIN_ROOT}/.claude/kaizen/claude-md-fragment.md`
- For submodule installs, it's at `.kaizen/.claude/kaizen/claude-md-fragment.md`

Read the fragment, then:
- **If CLAUDE.md doesn't exist:** Create it with the fragment.
- **If CLAUDE.md has `<!-- BEGIN KAIZEN PLUGIN -->` ... `<!-- END KAIZEN PLUGIN -->`:** Replace that section.
- **If CLAUDE.md exists but no kaizen section:** Append the fragment at an appropriate location.

Use your judgment on placement — this is why it's not scripted.

## Step 6: Verify

```bash
npx tsx src/kaizen-setup.ts --step verify --method <plugin|submodule>
```

Outputs structured check results. Report to the user which checks passed and which failed. Suggest fixes for failures.

## Idempotency

This setup is idempotent — running it again updates config and re-applies settings without duplicating entries. Safe to re-run after `/kaizen-update`.
