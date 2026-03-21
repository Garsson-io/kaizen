---
name: kaizen-setup
description: Install and configure the kaizen plugin for a host project. Creates kaizen.config.json, sets up symlinks, merges hook registrations, scaffolds policies-local.md. Triggers on "kaizen setup", "install kaizen", "configure kaizen", "setup kaizen plugin".
user_invocable: true
---

# /kaizen-setup — Install Kaizen Plugin

Interactive setup for installing kaizen as a Claude Code plugin in a host project.

## Prerequisites

- Kaizen repo cloned at `.kaizen/` in the host project root (as git submodule or plain clone)
- `jq` available on the system
- Node.js installed (for TypeScript hooks)

## The Setup Process

### Step 1: Verify installation

```bash
# Check kaizen is present
if [ ! -d ".kaizen" ]; then
  echo "Kaizen not found at .kaizen/"
  echo "Install with: git submodule add https://github.com/Garsson-io/kaizen.git .kaizen"
  exit 1
fi

# Install TS hook dependencies
cd .kaizen && npm install && cd ..
```

### Step 2: Create kaizen.config.json

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

### Step 3: Set up symlinks

Create symlinks from the host's `.claude/` directory into the kaizen plugin:

```bash
# Skills
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

### Step 4: Merge hook registrations

Read `.kaizen/.claude/settings-fragment.json` and merge the hook entries into the host's `.claude/settings.json`.

**If no settings.json exists:** Copy the hooks section directly.
**If settings.json exists:** Merge hook arrays for each event type (SessionStart, PreToolUse, PostToolUse, Stop). Do not overwrite existing host hooks.

Use `jq` to merge:
```bash
jq -s '.[0].hooks as $existing | .[1].hooks as $new |
  .[0] | .hooks = ($existing // {} | to_entries | map({key, value: (.value + ($new[.key] // []))}) | from_entries)
' .claude/settings.json .kaizen/.claude/settings-fragment.json > .claude/settings.json.tmp
mv .claude/settings.json.tmp .claude/settings.json
```

### Step 5: Create policies-local.md scaffold

```bash
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

### Step 6: Inject CLAUDE.md section

Read `.kaizen/.claude/kaizen/claude-md-fragment.md` and inject it into the host's `CLAUDE.md`.

**If CLAUDE.md doesn't exist:** Create it with the fragment.
**If CLAUDE.md exists but has no kaizen section:** Append the fragment before the last section.
**If CLAUDE.md already has `<!-- BEGIN KAIZEN PLUGIN -->` ... `<!-- END KAIZEN PLUGIN -->`:** Replace the existing section with the updated fragment.

```bash
FRAGMENT=$(cat .kaizen/.claude/kaizen/claude-md-fragment.md)
if grep -q "BEGIN KAIZEN PLUGIN" CLAUDE.md 2>/dev/null; then
  # Replace existing section
  sed -i '/<!-- BEGIN KAIZEN PLUGIN/,/<!-- END KAIZEN PLUGIN -->/d' CLAUDE.md
  echo "$FRAGMENT" >> CLAUDE.md
else
  # Append
  echo "" >> CLAUDE.md
  echo "$FRAGMENT" >> CLAUDE.md
fi
```

### Step 7: Verify

```bash
# Check symlinks resolve
ls -la .claude/skills/kaizen-reflect/SKILL.md
ls -la .claude/kaizen/zen.md

# Check config is valid
jq . kaizen.config.json

# Check hooks are registered
jq '.hooks | keys' .claude/settings.json
```

Report the results to the user.

## Idempotency

This setup is idempotent — running it again updates symlinks and re-merges hooks without duplicating entries. Safe to re-run after `/kaizen-update`.
