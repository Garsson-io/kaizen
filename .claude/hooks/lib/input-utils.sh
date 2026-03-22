#!/bin/bash
# Part of kAIzen Agent Control Flow — see .claude/kaizen/README.md
# input-utils.sh — Shared input parsing for hook scripts (kaizen #429)
#
# DRYs up the boilerplate pattern duplicated across 12+ hooks:
#   INPUT=$(cat)
#   TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
#   COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
#   ...
#
# Usage:
#   source "$(dirname "$0")/lib/input-utils.sh"
#   read_hook_input          # reads stdin, sets INPUT + TOOL_NAME
#   get_command              # sets COMMAND
#   get_stdout               # sets STDOUT
#   get_exit_code            # sets EXIT_CODE (defaults to "0")
#   require_tool_bash        # exits 0 if TOOL_NAME != "Bash"
#   require_success          # exits 0 if EXIT_CODE != "0"
#
# All functions set global variables matching the existing naming convention
# so callers can source and use them as drop-in replacements.

# Read stdin into INPUT and extract TOOL_NAME.
# Must be called first — stdin can only be read once.
read_hook_input() {
  INPUT=$(cat)
  TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
}

# Extract .tool_input.command into COMMAND.
get_command() {
  COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
}

# Extract .tool_response.stdout into STDOUT.
get_stdout() {
  STDOUT=$(echo "$INPUT" | jq -r '.tool_response.stdout // empty')
}

# Extract .tool_response.stderr into STDERR.
get_stderr() {
  STDERR=$(echo "$INPUT" | jq -r '.tool_response.stderr // empty')
}

# Extract .tool_response.exit_code into EXIT_CODE (defaults to "0").
get_exit_code() {
  EXIT_CODE=$(echo "$INPUT" | jq -r '.tool_response.exit_code // "0"')
}

# Extract .tool_input.file_path into FILE_PATH (for Edit/Write/Read hooks).
get_file_path() {
  FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
}

# Exit 0 (allow) if TOOL_NAME is not "Bash".
# Use after read_hook_input in PostToolUse hooks that only care about Bash.
require_tool_bash() {
  if [ "$TOOL_NAME" != "Bash" ]; then
    exit 0
  fi
}

# Exit 0 (allow) if EXIT_CODE is not "0".
# Use after get_exit_code in hooks that only process successful commands.
require_success() {
  if [ "$EXIT_CODE" != "0" ]; then
    exit 0
  fi
}
