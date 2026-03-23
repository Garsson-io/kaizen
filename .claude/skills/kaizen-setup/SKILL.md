---
name: kaizen-setup
description: Install and configure the kaizen plugin for a host project. Creates kaizen.config.json, scaffolds policies-local.md, injects CLAUDE.md section. Triggers on "kaizen setup", "install kaizen", "configure kaizen", "setup kaizen plugin".
user_invocable: true
---

# /kaizen-setup — Install Kaizen Plugin

Interactive setup for configuring kaizen in a host project after plugin installation.

Kaizen is installed as a Claude Code plugin. Hooks, skills, and agents are registered automatically via `plugin.json`. This setup only creates 3 host-project files:

1. `kaizen.config.json` — tells kaizen about the host project
2. `.claude/kaizen/policies-local.md` — host-specific enforcement policies
3. CLAUDE.md section — instructions for agents working in this repo

No Node.js is required in the host project. You create these files directly using Claude Code tools.

## Step 0: Check installation

Verify kaizen is installed as a plugin:
```bash
echo $CLAUDE_PLUGIN_ROOT
```

If `CLAUDE_PLUGIN_ROOT` is set, kaizen is installed. If not, tell the user:
```
/plugin marketplace add Garsson-io/kaizen
/plugin install kaizen@kaizen
```
Then restart Claude Code.

## Step 1: Create kaizen.config.json

Ask the user for:
1. **Host project name** — short identifier (e.g., "my-project")
2. **Host repo** — GitHub org/repo (e.g., "org/my-project")
3. **Host description** — brief description
4. **Kaizen repo** — where kaizen issues are filed (default: "Garsson-io/kaizen")
5. **Notification channel** — "telegram", "slack", or "none" (default: "none")

Then create `kaizen.config.json` in the project root using the Write tool:
```json
{
  "host": {
    "name": "<name>",
    "repo": "<org/repo>",
    "description": "<description>"
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

## Step 2: Scaffold policies

Create `.claude/kaizen/policies-local.md` if it doesn't exist:

```markdown
# Host-Specific Kaizen Policies

These policies extend the generic kaizen policies for this project.
Add project-specific enforcement rules here.
```

Skip if the file already exists (don't overwrite custom policies).

## Step 3: Inject CLAUDE.md section

Read the kaizen CLAUDE.md fragment from `${CLAUDE_PLUGIN_ROOT}/.claude/kaizen/claude-md-fragment.md`.

Then inject:
- **If CLAUDE.md doesn't exist:** Create it with the fragment.
- **If CLAUDE.md has `<!-- BEGIN KAIZEN PLUGIN -->` ... `<!-- END KAIZEN PLUGIN -->`:** Replace that section.
- **If CLAUDE.md exists but no kaizen section:** Append the fragment at an appropriate location.

Use your judgment on placement — this is why it's not scripted.

## Step 4: Verify

Check that all required files exist and are valid:
- [ ] `kaizen.config.json` exists, is valid JSON, has `host.name`, `host.repo`, `kaizen.repo`
- [ ] `.claude/kaizen/policies-local.md` exists
- [ ] `CLAUDE.md` exists and contains "kaizen" content

Report results to the user. Suggest fixes for any failures.

## Workflow Tasks

Create these tasks at skill start using TaskCreate:

| # | Task | Description |
|---|------|-------------|
| 1 | Check installation | Verify CLAUDE_PLUGIN_ROOT is set |
| 2 | Create config and policies | `kaizen.config.json` + `.claude/kaizen/policies-local.md` |
| 3 | Inject CLAUDE.md and verify | Add kaizen section to CLAUDE.md. Check all files are correct. |

**What comes next:** Nothing — standalone setup. Run `/kaizen-update` to pull future updates.

## Idempotency

This setup is idempotent — running it again updates config and re-applies settings without duplicating entries. Safe to re-run after `/kaizen-update`.
