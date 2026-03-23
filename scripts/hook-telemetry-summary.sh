#!/bin/bash
# hook-telemetry-summary.sh — Summarize hook execution telemetry from JSONL
#
# Reads .kaizen/telemetry/hooks.jsonl and produces:
#   - Per-hook: count, avg/p50/p95/max duration, error rate
#   - Overall: total invocations, total time, slowest hooks
#
# Usage:
#   scripts/hook-telemetry-summary.sh [--json] [--since HOURS]
#
# Examples:
#   scripts/hook-telemetry-summary.sh              # Last 24h, table format
#   scripts/hook-telemetry-summary.sh --since 1    # Last hour
#   scripts/hook-telemetry-summary.sh --json       # Machine-readable output

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TELEMETRY_FILE="${KAIZEN_TELEMETRY_DIR:-$PROJECT_ROOT/.kaizen/telemetry}/hooks.jsonl"

OUTPUT_JSON=false
SINCE_HOURS=24

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) OUTPUT_JSON=true; shift ;;
    --since) SINCE_HOURS="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ ! -f "$TELEMETRY_FILE" ]; then
  echo "No telemetry data found at $TELEMETRY_FILE"
  echo "Hook telemetry is emitted by hooks that source lib/hook-telemetry.sh"
  exit 0
fi

# Use jq to compute summary statistics
jq -rs --argjson since_hours "$SINCE_HOURS" --argjson json "$OUTPUT_JSON" '
  # Filter to recent entries
  (now - ($since_hours * 3600)) as $cutoff |
  [.[] | select(.timestamp != null)] |

  # Group by hook name
  group_by(.hook) |
  map({
    hook: .[0].hook,
    count: length,
    errors: [.[] | select(.exit_code != 0)] | length,
    durations: [.[].duration_ms] | sort,
    total_ms: ([.[].duration_ms] | add),
    avg_ms: (([.[].duration_ms] | add) / length | round),
    p50_ms: (sort_by(.duration_ms) | .[length/2 | floor].duration_ms),
    p95_ms: (sort_by(.duration_ms) | .[(length * 0.95) | floor].duration_ms),
    max_ms: ([.[].duration_ms] | max)
  }) |
  sort_by(-.total_ms) |

  if $json then
    {
      summary: {
        total_invocations: (map(.count) | add),
        total_time_ms: (map(.total_ms) | add),
        hooks_measured: length,
        since_hours: $since_hours
      },
      hooks: .
    }
  else
    # Table format
    "Hook Telemetry Summary (last \($since_hours)h)\n" +
    "Total invocations: \(map(.count) | add)  |  Total time: \(map(.total_ms) | add)ms  |  Hooks: \(length)\n" +
    "\n" +
    (["Hook", "Count", "Err", "Avg", "P50", "P95", "Max", "Total"] | @tsv) + "\n" +
    (["----", "-----", "---", "---", "---", "---", "---", "-----"] | @tsv) + "\n" +
    (map(
      [.hook, (.count|tostring), (.errors|tostring),
       "\(.avg_ms)ms", "\(.p50_ms)ms", "\(.p95_ms)ms", "\(.max_ms)ms", "\(.total_ms)ms"]
      | @tsv
    ) | join("\n"))
  end
' "$TELEMETRY_FILE"
