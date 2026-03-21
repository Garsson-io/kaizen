#!/bin/bash
# Tests for lib/allowlist.sh — shared allowlist functions (kaizen #172)
#
# INVARIANT UNDER TEST: Shared allowlist functions correctly classify commands
# and paths, and both gate hooks (enforce-pr-review, enforce-pr-kaizen) get
# consistent behavior from the shared implementation.

source "$(dirname "$0")/test-helpers.sh"
source "$(dirname "$0")/../lib/parse-command.sh"
source "$(dirname "$0")/../lib/allowlist.sh"

echo "=== is_readonly_monitoring_command: gh api allowed ==="

assert_ok "gh api repos check" is_readonly_monitoring_command "gh api repos/Garsson-io/nanoclaw/pulls/42"
assert_ok "gh api with --jq" is_readonly_monitoring_command "gh api repos/foo/bar --jq '.state'"
assert_ok "piped gh api" is_readonly_monitoring_command "something | gh api repos/foo/bar"

echo ""
echo "=== is_readonly_monitoring_command: gh run allowed ==="

assert_ok "gh run view" is_readonly_monitoring_command "gh run view 12345"
assert_ok "gh run list" is_readonly_monitoring_command "gh run list --limit 5"
assert_ok "gh run watch" is_readonly_monitoring_command "gh run watch 12345"

echo ""
echo "=== is_readonly_monitoring_command: gh run destructive blocked ==="

assert_fails "gh run delete blocked" is_readonly_monitoring_command "gh run delete 12345"
assert_fails "gh run rerun blocked" is_readonly_monitoring_command "gh run rerun 12345"
assert_fails "gh run cancel blocked" is_readonly_monitoring_command "gh run cancel 12345"

echo ""
echo "=== is_readonly_monitoring_command: git read-only allowed ==="

assert_ok "git diff" is_readonly_monitoring_command "git diff HEAD~1"
assert_ok "git log" is_readonly_monitoring_command "git log --oneline -5"
assert_ok "git show" is_readonly_monitoring_command "git show HEAD"
assert_ok "git status" is_readonly_monitoring_command "git status"
assert_ok "git branch" is_readonly_monitoring_command "git branch -a"
assert_ok "git fetch" is_readonly_monitoring_command "git fetch origin main"

echo ""
echo "=== is_readonly_monitoring_command: git write blocked ==="

assert_fails "git commit blocked" is_readonly_monitoring_command "git commit -m 'test'"
assert_fails "git push blocked" is_readonly_monitoring_command "git push origin main"
assert_fails "git checkout blocked" is_readonly_monitoring_command "git checkout main"
assert_fails "git reset blocked" is_readonly_monitoring_command "git reset --hard"

echo ""
echo "=== is_readonly_monitoring_command: filesystem read-only allowed ==="

assert_ok "ls" is_readonly_monitoring_command "ls -la"
assert_ok "cat" is_readonly_monitoring_command "cat README.md"
assert_ok "stat" is_readonly_monitoring_command "stat package.json"
assert_ok "find" is_readonly_monitoring_command "find . -name '*.ts'"
assert_ok "head" is_readonly_monitoring_command "head -20 file.ts"
assert_ok "tail" is_readonly_monitoring_command "tail -f log.txt"
assert_ok "wc" is_readonly_monitoring_command "wc -l file.ts"
assert_ok "file" is_readonly_monitoring_command "file binary.dat"

echo ""
echo "=== is_readonly_monitoring_command: write commands blocked ==="

assert_fails "npm blocked" is_readonly_monitoring_command "npm run build"
assert_fails "node blocked" is_readonly_monitoring_command "node script.js"
assert_fails "rm blocked" is_readonly_monitoring_command "rm -rf node_modules"
assert_fails "mkdir blocked" is_readonly_monitoring_command "mkdir -p newdir"

echo ""
echo "=== is_readonly_monitoring_command: pipe bypass prevention ==="

# The first segment is what matters — gh api after a pipe is still a readonly segment
assert_ok "pipe into gh api" is_readonly_monitoring_command "echo foo | gh api repos/bar"
# But npm before a pipe should fail (npm is the first word)
assert_fails "npm before pipe" is_readonly_monitoring_command "npm run build | grep error"

echo ""
echo "=== is_allowed_runtime_dir: allowed directories ==="

assert_ok ".claude/ allowed" is_allowed_runtime_dir ".claude/settings.json"
assert_ok ".claude/kaizen allowed" is_allowed_runtime_dir ".claude/kaizen/hooks/test.sh"
assert_ok ".claude/worktrees allowed" is_allowed_runtime_dir ".claude/worktrees/260319/src/foo.ts"
assert_ok "groups/ allowed" is_allowed_runtime_dir "groups/telegram_garsson/CLAUDE.md"
assert_ok "data/ allowed" is_allowed_runtime_dir "data/ipc/main/messages/msg.json"
assert_ok "store/ allowed" is_allowed_runtime_dir "store/messages.db"
assert_ok "logs/ allowed" is_allowed_runtime_dir "logs/app.log"

echo ""
echo "=== is_allowed_runtime_dir: source directories blocked ==="

assert_fails "src/ blocked" is_allowed_runtime_dir "src/index.ts"
assert_fails "container/ blocked" is_allowed_runtime_dir "container/Dockerfile"
assert_fails "docs/ blocked" is_allowed_runtime_dir "docs/README.md"
assert_fails "package.json blocked" is_allowed_runtime_dir "package.json"
assert_fails "tsconfig.json blocked" is_allowed_runtime_dir "tsconfig.json"

echo ""
echo "=== pr_url_to_state_key: URL conversion ==="

source "$(dirname "$0")/../lib/state-utils.sh"

RESULT=$(pr_url_to_state_key "https://github.com/Garsson-io/nanoclaw/pull/42")
assert_eq "standard PR URL" "Garsson-io_nanoclaw_42" "$RESULT"

RESULT=$(pr_url_to_state_key "https://github.com/org/repo-name/pull/123")
assert_eq "hyphenated repo" "org_repo-name_123" "$RESULT"

RESULT=$(pr_url_to_state_key "https://github.com/a/b/pull/1")
assert_eq "short names" "a_b_1" "$RESULT"

print_results
