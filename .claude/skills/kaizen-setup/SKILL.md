---
name: kaizen-setup
description: Install and configure the kaizen plugin for a host project. Creates kaizen.config.json, scaffolds policies-local.md, injects CLAUDE.md section. Triggers on "kaizen setup", "install kaizen", "configure kaizen", "setup kaizen plugin".
user_invocable: true
---

# /kaizen-setup — Install Kaizen Plugin

Interactive setup for configuring kaizen in a host project after installation.

## Step 0: Detect installation method

Kaizen can be installed two ways. Detect which one:

```bash
# Plugin install: CLAUDE_PLUGIN_ROOT is set, or we can find the plugin
if [ -n "$CLAUDE_PLUGIN_ROOT" ]; then
  INSTALL_METHOD="plugin"
  KAIZEN_ROOT="$CLAUDE_PLUGIN_ROOT"
elif [ -d ".kaizen/.claude-plugin" ]; then
  INSTALL_METHOD="submodule"
  KAIZEN_ROOT=".kaizen"
elif [ -d ".kaizen/.claude" ]; then
  INSTALL_METHOD="submodule"
  KAIZEN_ROOT=".kaizen"
else
  echo "Kaizen not found."
  echo ""
  echo "Install as a Claude Code plugin (recommended):"
  echo "  /plugin marketplace add Garsson-io/kaizen"
  echo "  /plugin install kaizen@kaizen"
  echo ""
  echo "Or as a git submodule:"
  echo "  git submodule add https://github.com/Garsson-io/kaizen.git .kaizen"
  echo "  cd .kaizen && npm install && cd .."
  exit 1
fi
```

**Plugin installs:** Skills, hooks, and agents are registered automatically by the plugin system. Steps 3 and 4 (symlinks and hook merging) are skipped.

**Submodule installs:** Skills, hooks, and agents need manual symlinks and settings.json merging.

## Step 1: Create kaizen.config.json

Ask the user for:
1. **Host project name** — short identifier (e.g., "my-project")
2. **Host repo** — GitHub org/repo (e.g., "org/my-project")
3. **Host description** — brief description
4. **Case CLI** — if the host has a case management CLI, its command (e.g., "npx tsx src/cli-cases.ts"). Leave empty for plain git worktrees.
5. **Kaizen repo** — where kaizen issues are filed (default: "Garsson-io/kaizen")
6. **Notification channel** — "telegram", "slack", or "none" (default: "none")

Generate `kaizen.config.json`:
```json
{
  "host": {
    "name": "<name>",
    "repo": "<org/repo>",
    "description": "<description>",
    "caseCli": "<cli command or empty>"
  },
  "kaizen": {
    "repo": "<kaizen-repo>",
    "issueLabel": "kaizen"
  },
  "taxonomy": {
    "levels": ["level-1", "level-2", "level-3"],
    "areas": [],
    "areaPrefix": "area/",
    "epicPrefix": "epic/",
    "horizonPrefix": "horizon/"
  },
  "notifications": {
    "channel": "<channel>"
  }
}
```

## Step 2: Create policies-local.md scaffold

```bash
mkdir -p .claude/kaizen
cat > .claude/kaizen/policies-local.md << 'EOF'
# Host-Specific Kaizen Policies

These policies extend the generic kaizen policies for this project.
Add project-specific enforcement rules here.

<!-- Example:
10. **Never install system packages on the host.** System deps go in Dockerfiles.
11. **All dev work must be in a case with its own worktree.**
-->
EOF
```

## Step 3: Set up symlinks (submodule only)

**Skip this step for plugin installs** — the plugin system registers components automatically.

For submodule installs, create symlinks from the host's `.claude/` directory into kaizen:

```bash
# Skills
mkdir -p .claude/skills
for skill in .kaizen/.claude/skills/kaizen-*; do
  name=$(basename "$skill")
  ln -sfn "../../.kaizen/.claude/skills/$name" ".claude/skills/$name"
done

# Philosophy docs
ln -sfn "../../.kaizen/.claude/kaizen" ".claude/kaizen"

# Agents
mkdir -p .claude/agents
ln -sfn "../../.kaizen/.claude/agents/kaizen-bg.md" ".claude/agents/kaizen-bg.md"
```

## Step 4: Merge hook registrations (submodule only)

**Skip this step for plugin installs** — the plugin system registers hooks from plugin.json automatically.

For submodule installs, read `.kaizen/.claude/settings-fragment.json` and merge the hook entries into the host's `.claude/settings.json`.

**If no settings.json exists:** Copy the hooks section directly.
**If settings.json exists:** Merge hook arrays for each event type (SessionStart, PreToolUse, PostToolUse, Stop). Do not overwrite existing host hooks.

Use `jq` to merge:
```bash
jq -s '.[0].hooks as $existing | .[1].hooks as $new |
  .[0] | .hooks = ($existing // {} | to_entries | map({key, value: (.value + ($new[.key] // []))}) | from_entries)
' .claude/settings.json .kaizen/.claude/settings-fragment.json > .claude/settings.json.tmp
mv .claude/settings.json.tmp .claude/settings.json
```

## Step 5: Inject CLAUDE.md section

Read the kaizen CLAUDE.md fragment and inject it into the host's `CLAUDE.md`.

For plugin installs, the fragment is at `${CLAUDE_PLUGIN_ROOT}/.claude/kaizen/claude-md-fragment.md`.
For submodule installs, it's at `.kaizen/.claude/kaizen/claude-md-fragment.md`.

**If CLAUDE.md doesn't exist:** Create it with the fragment.
**If CLAUDE.md exists but has no kaizen section:** Append the fragment.
**If CLAUDE.md already has `<!-- BEGIN KAIZEN PLUGIN -->` ... `<!-- END KAIZEN PLUGIN -->`:** Replace the existing section with the updated fragment.

```bash
FRAGMENT_PATH="${KAIZEN_ROOT}/.claude/kaizen/claude-md-fragment.md"
FRAGMENT=$(cat "$FRAGMENT_PATH")
if grep -q "BEGIN KAIZEN PLUGIN" CLAUDE.md 2>/dev/null; then
  # Replace existing section
  sed -i '/<!-- BEGIN KAIZEN PLUGIN/,/<!-- END KAIZEN PLUGIN -->/d' CLAUDE.md
  echo "$FRAGMENT" >> CLAUDE.md
elif [ -f CLAUDE.md ]; then
  # Append
  echo "" >> CLAUDE.md
  echo "$FRAGMENT" >> CLAUDE.md
else
  # Create
  echo "$FRAGMENT" > CLAUDE.md
fi
```

## Step 6: Verify

```bash
# Check config is valid
jq . kaizen.config.json

# For plugin installs: confirm plugin is active
# /plugin list should show kaizen

# For submodule installs: check symlinks resolve
ls -la .claude/skills/kaizen-reflect/SKILL.md
ls -la .claude/kaizen/zen.md
# Check hooks are registered
jq '.hooks | keys' .claude/settings.json
```

Report the results to the user including which install method was detected.

## Idempotency

This setup is idempotent — running it again updates config and re-applies settings without duplicating entries. Safe to re-run after `/kaizen-update`.
