# Auto-Dent Dashboard Data Contract

#1725 defines the read-only data boundary for future #556 dashboard work. The
dashboard is a consumer of existing progress issue artifacts and GitHub/cloud
indexes; it does not scrape local logs, re-parse worker prose, or introduce a
second lifecycle model.

## Contract Module

The typed contract lives in `scripts/auto-dent-dashboard-contract.ts`.

- `DashboardDataProjectionSchema` validates the read-only projection future UI
  code can consume.
- `dashboardArtifactSources(progressIssue)` lists the artifact/API source for
  each panel.
- `buildDashboardDataProjection(input)` is pure: callers pass existing
  artifact-shaped data, and the builder returns a schema-validated projection.

The module intentionally has no GitHub I/O. #1726 can add a reader/UI around this
contract; #1727 can add live transport around the same model.

## Panel Sources

| Panel | Primary source | Supporting source | Notes |
|---|---|---|---|
| Batch timeline | `batch-outcome` named attachment | Progress issue body | Uses `BatchOutcomeSchema` fields: `batch_id`, `guidance`, start/end, wall time, stop reason, and run totals. |
| Run table | `progress/run-*` named attachments | `batch-outcome` PR/issue refs; GitHub issue API for titles/states | Uses existing per-run progress attachments and `RunProgressStep`; no raw log parsing. |
| PR pipeline | `progress/run-*` named attachments | GitHub PR API for title/state enrichment | Uses the existing phase model from `scripts/auto-dent-progress.ts`, not a second phase taxonomy. |
| Score and quality | `batch-outcome` named attachment | `progress/batch-complete`, anomaly incident refs, `rsi-improvement-proposals` | Shows success rate, review fail rate, degradation verdict, anomaly links, and RSI proposal count/verdict. |
| Artifact links | `progress/batch-complete` named attachment | `batch-artifacts`, `batch-transcript-bundle`, GitHub Actions artifact URL | Links to drill-down artifacts; does not inline full transcripts or raw forensic payloads. |

## Artifact Catalog

| Artifact | Kind | Required? | Dashboard use |
|---|---|---:|---|
| Progress issue body | issue body | yes | Human operator index and guidance summary. Not the machine source of truth. |
| `batch-outcome` | named attachment | yes | Machine-readable batch timeline, totals, mode breakdown, degradation signal, PR/issue refs. |
| `progress/run-*` | named attachments | yes | Per-run outcome, run metrics, issue/PR links, and work-cycle phase rows. |
| `progress/batch-complete` | named attachment | yes | Final scorecard, merge audit, anomaly summary, and durable artifact index. |
| `batch-artifacts` | named attachment | no | Capped `events.jsonl`/`state.json` forensic drill-down and on-disk pointer. |
| `batch-transcript-bundle` | named attachment | no | Manifest/index for the full scrubbed transcript bundle in GitHub Actions artifacts. |
| `rsi-improvement-proposals` | named attachment | no | Structured proposal count, proof requirements, and cross-run improvement verdict. |
| GitHub PR API | API enrichment | no | PR title, state, and URL for refs already present in durable artifacts. |
| GitHub Issue API | API enrichment | no | Issue title, state, and URL for refs already present in durable artifacts. |

## Retention And Privacy

`batch-transcript-bundle` is only a manifest. The complete scrubbed transcript
payload lives in a GitHub Actions artifact with retention metadata, so dashboard
UI must show the manifest status, artifact URL, and expiry when present.

`batch-artifacts` may inline capped forensic snippets, but the dashboard
projection treats it as a link/source. Dashboard surfaces must not embed raw
transcripts or use raw artifact text as the primary state model.

## Non-Goals

- No live SSE or Cloudflare Worker stream. #1727 owns live event transport.
- No read-only dashboard UI. #1726 owns the first web surface.
- No asciinema replay generation. #1728 owns replay output.
- No Telegram or push notifications. #1729 owns notifications.
- No raw transcript embedding. Link to `batch-transcript-bundle` and its Actions
  artifact instead.

## Consumer Rule

Future dashboard readers should fail soft per optional artifact and fail closed
on malformed required typed artifacts:

- Missing optional drill-down links produce an unavailable badge.
- Missing or malformed `batch-outcome` blocks the batch projection, because
  scores and timeline would otherwise be invented.
- Missing `progress/run-*` attachments should be visible as incomplete run rows,
  not silently reconstructed from logs.
