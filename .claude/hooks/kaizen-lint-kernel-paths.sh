#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# lint-kernel-paths.sh — Block test files that reference kernel interfaces (kaizen #685)
#
# Tests must be inert. Interacting with /proc, /sys, or /dev (except /dev/null)
# is platform-dependent and can cause hangs on WSL2 (mkdirSync('/proc/...') hangs
# instead of throwing). Also flags process.kill and process.exit in test files.
#
# Runs as PreToolUse hook on Edit and Write tool calls.
# Blocks with explanation pointing to mock-based alternatives.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only care about test files
if ! echo "$FILE_PATH" | grep -qE '\.(test|spec)\.(ts|js|tsx|jsx)$'; then
  exit 0
fi

source "$(dirname "$0")/lib/scope-guard.sh"
source "$(dirname "$0")/lib/hook-telemetry.sh" 2>/dev/null || true

# Get the content being written
# For Write: tool_input.content
# For Edit: tool_input.new_string
CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // .tool_input.new_string // empty')

if [ -z "$CONTENT" ]; then
  exit 0
fi

VIOLATIONS=""

# Check for /proc/ references (kernel interface)
if echo "$CONTENT" | grep -qE '/proc/' ; then
  VIOLATIONS="${VIOLATIONS}  - References /proc/ (hangs on WSL2 instead of failing)\n"
fi

# Check for /sys/ references (kernel interface)
if echo "$CONTENT" | grep -qE '/sys/' ; then
  VIOLATIONS="${VIOLATIONS}  - References /sys/ (platform-dependent kernel interface)\n"
fi

# Check for /dev/ references (except /dev/null which is safe)
# Strip /dev/null first, then check if any /dev/ remains
if echo "$CONTENT" | sed 's|/dev/null||g' | grep -qE '/dev/'; then
  VIOLATIONS="${VIOLATIONS}  - References /dev/ path (use /dev/null or a temp directory instead)\n"
fi

# Check for process.kill
if echo "$CONTENT" | grep -qE 'process\.kill\b'; then
  VIOLATIONS="${VIOLATIONS}  - Uses process.kill (can affect other processes; mock it instead)\n"
fi

# Check for process.exit
if echo "$CONTENT" | grep -qE 'process\.exit\b'; then
  VIOLATIONS="${VIOLATIONS}  - Uses process.exit (terminates the test runner; mock it instead)\n"
fi

if [ -n "$VIOLATIONS" ]; then
  REASON="Test file '$(basename "$FILE_PATH")' references kernel interfaces or dangerous process APIs:
$(echo -e "$VIOLATIONS")
Tests must be inert — mock the error path instead of provoking it from the OS.
Use non-kernel paths for error testing: /tmp/nonexistent or a temp directory.
See: kaizen #685, WSL2 /proc hang incident"

  jq -n \
    --arg reason "$REASON" \
    '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: $reason
      }
    }'
fi

exit 0
