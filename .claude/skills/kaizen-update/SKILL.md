---
name: kaizen-update
description: Pull kaizen plugin updates and re-run setup to apply new hooks and skills. Triggers on "kaizen update", "update kaizen", "pull kaizen updates".
user_invocable: true
---

# /kaizen-update — Update Kaizen Plugin

Pull the latest kaizen updates and re-apply the setup.

## Process

### Step 1: Pull updates

```bash
# If installed as submodule
git submodule update --remote .kaizen

# If installed as plain clone
# git -C .kaizen pull origin main
```

### Step 2: Install dependencies

```bash
cd .kaizen && npm install && cd ..
```

### Step 3: Re-run setup

Re-apply symlinks and merge any new hook registrations. This is the same as `/kaizen-setup` steps 3-4, which are idempotent.

### Step 4: Check for new skills

Compare skills in `.kaizen/.claude/skills/` against symlinks in `.claude/skills/`. Report any new skills that were added.

### Step 5: Show changelog

```bash
# Show recent kaizen commits
git -C .kaizen log --oneline -10
```

Report what changed to the user.
