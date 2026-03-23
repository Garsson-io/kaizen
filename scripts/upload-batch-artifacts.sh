#!/usr/bin/env bash
# Publish auto-dent batch data to the batch's GitHub tracking issue.
#
# Usage:
#   ./scripts/upload-batch-artifacts.sh <batch-dir> <issue-number> update
#   ./scripts/upload-batch-artifacts.sh <batch-dir> <issue-number> finalize [--include-logs]
#
# Modes:
#   update    — Called after each run (or periodically) during the batch.
#               Updates the issue BODY with current human-readable progress.
#
#   finalize  — Called once at batch end.
#               1. Posts a comment with full machine-readable data
#                  (events.jsonl, state.json inlined; compressed logs as Release asset)
#               2. Updates the issue body with final human summary + link to that comment
#
# Architecture (#688): small data inlined on the issue, large data in Releases.
# The tracking issue is the single source of truth for both humans and machines.

set -euo pipefail

BATCH_DIR="${1:?Usage: $0 <batch-dir> <issue-number> <update|finalize> [--include-logs]}"
ISSUE="${2:?Usage: $0 <batch-dir> <issue-number> <update|finalize> [--include-logs]}"
MODE="${3:?Usage: $0 <batch-dir> <issue-number> <update|finalize> [--include-logs]}"
INCLUDE_LOGS="${4:-}"

REPO="${KAIZEN_REPO:-Garsson-io/kaizen}"
BATCH_ID=$(basename "$BATCH_DIR")
STATE_FILE="$BATCH_DIR/state.json"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

if [ ! -f "$STATE_FILE" ]; then
  echo "Error: $STATE_FILE not found"
  exit 1
fi

# Read state.json fields via node (same pattern as auto-dent.sh)
read_json() {
  node -e "
    const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const v = process.argv[2].split('.').reduce((o,k) => o && o[k], s);
    if (Array.isArray(v)) console.log(v.join(' '));
    else console.log(v === null || v === undefined ? '' : String(v));
  " "$STATE_FILE" "$1"
}

read_json_count() {
  node -e "
    const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const v = process.argv[2].split('.').reduce((o,k) => o && o[k], s);
    console.log(Array.isArray(v) ? v.length : 0);
  " "$STATE_FILE" "$1"
}

# Common fields
GUIDANCE=$(read_json guidance)
RUN_NUM=$(read_json run)
BATCH_START=$(read_json batch_start)
STOP_REASON=$(read_json stop_reason)
PR_COUNT=$(read_json_count prs)
ISSUES_CLOSED=$(read_json issues_closed)
ISSUES_CLOSED_COUNT=$(read_json_count issues_closed)
ISSUES_FILED_COUNT=$(read_json_count issues_filed)

# Calculate duration
ELAPSED=$(node -e "
  const start = Number(process.argv[1]);
  const now = Math.floor(Date.now() / 1000);
  const d = now - start;
  const h = Math.floor(d / 3600);
  const m = Math.floor((d % 3600) / 60);
  console.log(h + 'h ' + m + 'm');
" "$BATCH_START")

# Calculate cost
TOTAL_COST=$(node -e "
  const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  const cost = (s.run_history || []).reduce((sum, r) => sum + (r.cost_usd || 0), 0);
  console.log(cost.toFixed(2));
" "$STATE_FILE")

# Fetch PR titles from GitHub (cached in tmpfile to avoid repeated API calls)
fetch_pr_table() {
  local prs=$(read_json prs)
  if [ -z "$prs" ]; then
    echo "_No PRs created yet._"
    return
  fi

  node -e "
    const { execSync } = require('child_process');
    const prs = process.argv.slice(1);
    // Fetch all PR data in one call
    let allPrs = {};
    try {
      const out = execSync(
        'gh pr list --repo ${REPO} --state all --limit 200 --json number,title,state',
        { encoding: 'utf8', timeout: 30000 }
      );
      for (const p of JSON.parse(out)) allPrs[p.number] = p;
    } catch {}

    console.log('| PR | Title | Status |');
    console.log('|----|-------|--------|');
    for (const url of prs) {
      const m = url.match(/pull\/(\d+)/);
      if (!m) continue;
      const n = Number(m[1]);
      const p = allPrs[n];
      if (p) {
        console.log('| #' + n + ' | ' + p.title + ' | ' + p.state.toLowerCase() + ' |');
      } else {
        console.log('| #' + n + ' | _(title unavailable)_ | ? |');
      }
    }
  " $prs
}

# Generate the human-readable body
generate_body() {
  local status_label="$1"  # "In Progress" or "Complete"
  local artifacts_link="${2:-}"  # optional link to artifacts comment

  local body_file="$TMPDIR/body.md"
  cat > "$body_file" << HEADER
## Auto-Dent Batch: \`$BATCH_ID\`

**Status:** $status_label
**Guidance:** $GUIDANCE

| Metric | Value |
|--------|-------|
| **Runs** | $RUN_NUM |
| **Duration** | $ELAPSED |
| **PRs created** | $PR_COUNT |
| **Issues closed** | $ISSUES_CLOSED_COUNT |
| **Issues filed** | $ISSUES_FILED_COUNT |
| **Total cost** | \$$TOTAL_COST |
| **Stop reason** | ${STOP_REASON:-_(running)_} |

HEADER

  if [ "$PR_COUNT" -gt 0 ]; then
    echo "### PRs ($PR_COUNT)" >> "$body_file"
    echo "" >> "$body_file"
    fetch_pr_table >> "$body_file"
    echo "" >> "$body_file"
  fi

  if [ -n "$ISSUES_CLOSED" ]; then
    echo "### Issues Closed ($ISSUES_CLOSED_COUNT)" >> "$body_file"
    echo "" >> "$body_file"
    # Format as linked issue refs
    for inum in $ISSUES_CLOSED; do
      echo -n "$inum " >> "$body_file"
    done
    echo "" >> "$body_file"
    echo "" >> "$body_file"
  fi

  local issues_filed=$(read_json issues_filed)
  if [ -n "$issues_filed" ]; then
    echo "### Issues Filed ($ISSUES_FILED_COUNT)" >> "$body_file"
    echo "" >> "$body_file"
    for inum in $issues_filed; do
      echo -n "$inum " >> "$body_file"
    done
    echo "" >> "$body_file"
    echo "" >> "$body_file"
  fi

  if [ -n "$artifacts_link" ]; then
    cat >> "$body_file" << ARTIFACTS
### Batch Artifacts

Machine-readable data (events.jsonl, state.json, logs): [$artifacts_link]($artifacts_link)
ARTIFACTS
  fi

  echo "" >> "$body_file"
  echo "---" >> "$body_file"
  echo "_Auto-managed by the auto-dent harness._" >> "$body_file"

  echo "$body_file"
}

# Post machine-readable data as a comment, return the comment URL
post_artifacts_comment() {
  local comment_file="$TMPDIR/artifacts-comment.md"

  cat > "$comment_file" << HEADER
## Batch Artifacts: \`$BATCH_ID\`

_Finalized on $(date -u +%Y-%m-%dT%H:%M:%SZ) by \`upload-batch-artifacts.sh\`_
HEADER

  # Inline batch-summary.txt
  if [ -f "$BATCH_DIR/batch-summary.txt" ]; then
    cat >> "$comment_file" << SUMMARY

### Batch Summary

\`\`\`
$(cat "$BATCH_DIR/batch-summary.txt")
\`\`\`
SUMMARY
    echo "  Inlined: batch-summary.txt" >&2
  fi

  # Inline events.jsonl (collapsed)
  if [ -f "$BATCH_DIR/events.jsonl" ]; then
    local event_count
    event_count=$(wc -l < "$BATCH_DIR/events.jsonl")
    cat >> "$comment_file" << EVENTS

<details>
<summary>events.jsonl ($event_count events, $(du -h "$BATCH_DIR/events.jsonl" | cut -f1))</summary>

\`\`\`jsonl
$(cat "$BATCH_DIR/events.jsonl")
\`\`\`

</details>
EVENTS
    echo "  Inlined: events.jsonl ($event_count events)" >&2
  fi

  # Inline state.json (collapsed)
  if [ -f "$BATCH_DIR/state.json" ]; then
    cat >> "$comment_file" << STATE

<details>
<summary>state.json ($(du -h "$BATCH_DIR/state.json" | cut -f1))</summary>

\`\`\`json
$(cat "$BATCH_DIR/state.json")
\`\`\`

</details>
STATE
    echo "  Inlined: state.json" >&2
  fi

  # Upload compressed logs to Release if requested
  if [ "$INCLUDE_LOGS" = "--include-logs" ]; then
    local log_count
    log_count=$(find "$BATCH_DIR" -name "*.log" | wc -l)
    if [ "$log_count" -gt 0 ]; then
      local log_archive="$TMPDIR/${BATCH_ID}-logs.tar.gz"
      (cd "$BATCH_DIR" && find . -name "*.log" -print0 | sort -z | xargs -0 tar czf "$log_archive")
      local log_size
      log_size=$(du -h "$log_archive" | cut -f1)
      echo "  Compressed: $log_count logs → $log_size" >&2

      local release_tag="batch-${BATCH_ID}"
      if ! gh release view "$release_tag" --repo "$REPO" >/dev/null 2>&1; then
        gh release create "$release_tag" \
          --repo "$REPO" \
          --title "Batch logs: $BATCH_ID" \
          --notes "Compressed run logs. Tracking issue: #$ISSUE" \
          --latest=false >&2
      fi

      gh release upload "$release_tag" "$log_archive" --repo "$REPO" --clobber >&2
      local download_url="https://github.com/$REPO/releases/download/$release_tag/${BATCH_ID}-logs.tar.gz"

      cat >> "$comment_file" << LOGS

### Run Logs

$log_count log files ($log_size compressed): [\`${BATCH_ID}-logs.tar.gz\`]($download_url)
LOGS
      echo "  Uploaded logs to release $release_tag" >&2
    fi
  fi

  # Post the comment and capture the URL
  local comment_url
  comment_url=$(gh issue comment "$ISSUE" --repo "$REPO" --body-file "$comment_file" 2>/dev/null)
  echo "$comment_url"
}

# Main
case "$MODE" in
  update)
    echo "Updating issue #$ISSUE body (run $RUN_NUM, $PR_COUNT PRs, \$$TOTAL_COST)..."
    BODY_FILE=$(generate_body "In Progress")
    gh issue edit "$ISSUE" --repo "$REPO" --body-file "$BODY_FILE"
    echo "Done. https://github.com/$REPO/issues/$ISSUE"
    ;;

  finalize)
    echo "Finalizing batch $BATCH_ID on issue #$ISSUE..."

    # 1. Post machine-readable artifacts comment
    echo "Posting artifacts comment..."
    ARTIFACTS_URL=$(post_artifacts_comment)
    echo "Artifacts comment: $ARTIFACTS_URL"

    # 2. Update body with final summary + link to artifacts
    echo "Updating issue body with final summary..."
    BODY_FILE=$(generate_body "Complete" "$ARTIFACTS_URL")
    gh issue edit "$ISSUE" --repo "$REPO" --body-file "$BODY_FILE"

    echo ""
    echo "Done! https://github.com/$REPO/issues/$ISSUE"
    echo "Artifacts: $ARTIFACTS_URL"
    ;;

  *)
    echo "Error: mode must be 'update' or 'finalize'"
    echo "Usage: $0 <batch-dir> <issue-number> <update|finalize> [--include-logs]"
    exit 1
    ;;
esac
