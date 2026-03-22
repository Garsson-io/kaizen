#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# enforce-pr-kaizen.sh — Level 3 kaizen enforcement (Issue #57)
# PreToolUse gate: blocks non-kaizen Bash commands until the agent
# completes kaizen reflection after `gh pr create`.
#
# State is set by kaizen-reflect.sh (PostToolUse) with STATUS=needs_pr_kaizen.
# Gate clears when pr-kaizen-clear.sh detects kaizen action was taken.
#
# Allowed commands during kaizen gate:
#   gh issue create (filing kaizen issues)
#   gh issue list/search (finding existing issues — kaizen #150)
#   gh issue comment (adding incidents to existing issues)
#   gh issue list/search/view (searching for duplicates — kaizen #150)
#   echo "KAIZEN_IMPEDIMENTS: ..." (structured impediment declaration)
#   echo "KAIZEN_NO_ACTION [category]: ..." (restricted categories — kaizen #140)
#   gh pr view, gh pr diff, gh pr edit, gh pr comment, gh pr checks (PR-related)
#   gh api (read-only API calls — CI monitoring, PR status)
#   gh run view, gh run list, gh run watch (CI monitoring)
#   git diff, git log, git show, git status, git branch, git fetch
#   ls, cat, stat, find, head, tail, wc, file (read-only)

source "$(dirname "$0")/lib/parse-command.sh" 2>/dev/null || { exit 0; }
source "$(dirname "$0")/lib/state-utils.sh" 2>/dev/null || { exit 0; }
source "$(dirname "$0")/lib/allowlist.sh" 2>/dev/null || { exit 0; }

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if [ -z "$COMMAND" ]; then
  exit 0
fi

source "$(dirname "$0")/lib/scope-guard.sh"

CMD_LINE=$(strip_heredoc_body "$COMMAND")

# Check if the command is allowed during kaizen gate.
# Uses segment splitting (kaizen #172 bug fix) to prevent bypass via pipes/chains.
# Before: `npm build && echo KAIZEN_IMPEDIMENTS:` passed the gate.
# After: each segment is checked independently.
is_kaizen_command() {
  local cmd="$1"
  # gh issue create/list/search/comment/view — filing and searching kaizen issues (kaizen #150)
  # Uses segment splitting to prevent bypass via pipes/chains
  if echo "$cmd" | sed 's/[|;&]\{1,\}/\n/g' | sed 's/^[[:space:]]*//' | \
    grep -qE '^gh[[:space:]]+issue[[:space:]]+(create|list|search|comment|view)'; then
    return 0
  fi
  # KAIZEN_IMPEDIMENTS declaration — must be the start of a segment (kaizen #172)
  if echo "$cmd" | sed 's/[|;&]\{1,\}/\n/g' | sed 's/^[[:space:]]*//' | \
    grep -qE '(^echo.*KAIZEN_IMPEDIMENTS:|^KAIZEN_IMPEDIMENTS:|^cat)'; then
    return 0
  fi
  # KAIZEN_NO_ACTION declaration — must be the start of a segment (kaizen #172)
  if echo "$cmd" | sed 's/[|;&]\{1,\}/\n/g' | sed 's/^[[:space:]]*//' | \
    grep -qE '(^echo.*KAIZEN_NO_ACTION|^KAIZEN_NO_ACTION)'; then
    return 0
  fi
  # gh pr diff/view/comment/edit/checks/merge — PR-related commands
  # merge is allowed because it's a continuation of the PR workflow (kaizen #323)
  if is_gh_pr_command "$cmd" "diff|view|comment|edit|checks|merge"; then
    return 0
  fi
  # Shared readonly monitoring commands (gh api, gh run, git read-only, ls/cat/etc.)
  # Extracted to lib/allowlist.sh (kaizen #172) to stay in sync with enforce-pr-review.sh
  if is_readonly_monitoring_command "$cmd"; then
    return 0
  fi
  return 1
}

# FAST PATH (kaizen #451): Check command relevance BEFORE expensive state
# iteration. Allowed commands exit immediately — no need to check whether
# a gate is active, since they'd be allowed through regardless.
if is_kaizen_command "$CMD_LINE"; then
  exit 0
fi

# SLOW PATH: Command would be blocked if gate is active. Check state.
STATE_INFO=$(find_state_with_status "needs_pr_kaizen")
if [ $? -ne 0 ] || [ -z "$STATE_INFO" ]; then
  # No active kaizen gate — allow everything
  exit 0
fi

PR_URL=$(echo "$STATE_INFO" | cut -d'|' -f1)

# Block the command — agent must complete kaizen reflection first
source "$(dirname "$0")/lib/hook-output.sh" 2>/dev/null || { exit 0; }

IMPEDIMENTS_FORMAT=$(render_prompt "impediments-format.md")

emit_deny "BLOCKED: Kaizen reflection required — ALL findings must be addressed.

You must reflect on the development process before proceeding.
  PR: $PR_URL

${IMPEDIMENTS_FORMAT}

Allowed commands during reflection:
  gh issue create/comment/list/search/view, gh pr diff/view/comment/edit
  gh api, gh run view/list/watch
  git diff, git log, git show, git status, git branch"
