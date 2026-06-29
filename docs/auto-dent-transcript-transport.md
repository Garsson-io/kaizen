# Auto-Dent Transcript Transport Decision

This document unblocks #1643. It chooses the first supported cloud transport for
full auto-dent `run-*.log` transcript bundles and defines the redaction, size,
retention, and diagnostic contract for follow-up implementation PRs.

## Problem

`auto-dent-analyze --progress-issue` needs full run transcript logs to compute
cold-start, tool-pattern, phase-marker, and waste analysis. The current
cloud-backed `batch-artifacts` attachment stores `events.jsonl` and `state.json`
as capped GitHub marker comments. That is useful for structured replay, but it is
not a safe transport for full transcript logs: comment bodies are bounded and the
shared capper intentionally truncates large blocks.

A transcript transport must therefore separate:

- complete transcript bundles for analysis, which must not be silently truncated
- compact GitHub issue metadata, which should remain readable and idempotent
- scrubbed excerpts, which may be capped when they are only evidence pointers

## Decision

Use GitHub Actions artifacts as the first supported cloud transport for complete
compressed batch transcript bundles.

At batch finalize, a follow-up implementation should create a scrubbed compressed
bundle from `logs/auto-dent/<batch-id>/run-*.log` and upload it as a GitHub
Actions artifact. The batch progress issue should store only a small
idempotent manifest attachment that points to that artifact and records the
bundle metadata needed by `auto-dent-analyze --progress-issue`.

The progress issue remains the operator's durable index. The Actions artifact is
the byte transport.

## Manifest Contract

The progress issue should get an idempotent named attachment, for example
`batch-transcript-bundle`, containing YAML or JSON with these fields:

```yaml
version: 1
batch_id: batch-260629-example
repo: Garsson-io/kaizen
progress_issue: 1234
transport: github-actions-artifact
artifact_name: auto-dent-transcripts-batch-260629-example
artifact_url: https://github.com/Garsson-io/kaizen/actions/runs/...
created_at: 2026-06-29T00:00:00.000Z
expires_at: 2026-09-27T00:00:00.000Z
content_encoding: tar+gzip
scrubbed: true
truncated: false
files:
  - path: run-1-260629000000.log
    bytes: 12345
    sha256: ...
```

`auto-dent-analyze --progress-issue` should read this manifest before falling
back to the current diagnostic. If the artifact is absent, expired, unauthorized,
or malformed, the CLI must say which condition occurred and preserve the current
clear "run transcript logs are not available" diagnostic.

## Redaction And Size Contract

- Full uploaded transcript bundles must be scrubbed before upload through the
  same fail-closed secret-scrubbing policy used by `run-transcript` and
  `batch-artifacts`.
- A scrub failure must fail the upload path closed for that bundle. It must not
  upload raw transcript text.
- The compressed bundle must not be truncated. If the full scrubbed bundle cannot
  be uploaded within the selected artifact limit, the upload step must fail
  open with a manifest diagnostic instead of producing partial analysis input.
- Small manifest/comment attachments may be capped. They are indexes, not the
  transcript payload.
- The manifest must distinguish `absent`, `expired`, `unauthorized`,
  `malformed`, and `too_large` states so operators can tell whether rerunning,
  reauthenticating, or changing storage is required.

## Retention Contract

Actions artifacts are not permanent records. They are a first supported transport
for recent batch analysis, not archival storage.

Follow-up implementation must:

- record the artifact creation time and expected expiry time when available
- keep the progress issue manifest permanent and idempotent
- make expiry visible in `auto-dent-analyze --progress-issue`
- preserve local analysis of `logs/auto-dent/<batch-id>` as the authoritative
  fallback when artifacts have expired

If operators need long-term transcript retention beyond the Actions artifact
window, file a separate issue for external object storage or another archival
transport.

## Alternatives

### GitHub Marker Comments / Capped Inline Attachments

Rejected as the primary transport. Marker comments are excellent for small
structured artifacts and stable manifests, but the shared capper truncates large
blocks by design. Full transcript analysis must not consume truncated logs as if
they were complete.

Allowed use: a progress-issue manifest, capped excerpts, and human-readable
diagnostics.

### GitHub UI Issue Attachments

Rejected for automation. GitHub issue attachment upload is a user-interface flow,
not a stable repository API surface this harness can depend on.

Allowed use: humans may manually attach evidence, but auto-dent must not require
that path.

### Repository Contents, Git LFS, Or Release Assets

Rejected for the first implementation. These mechanisms either bloat the repo,
couple per-batch operational artifacts to release lifecycle, or require a new
retention/cleanup policy before they are safe for unattended runs.

Allowed use: revisit if Actions artifact retention is too short for real
operators and external storage is unavailable.

### External Object Storage

Deferred. This is the likely archival answer if auto-dent needs long-term
transcript storage, but it introduces credentials, bucket policy, lifecycle
rules, and deployment configuration. #1702 deliberately does not add cloud
infrastructure.

Allowed use: future archival transport once credential and retention policy are
explicitly designed.

## Follow-Up PR Boundaries

Use one PR per issue.

1. **Bundle writer and manifest schema**: build the scrubbed tar/gzip bundle,
   compute file metadata, and produce the manifest object without uploading.
2. **Actions artifact upload integration**: upload the scrubbed bundle at batch
   finalize and write the progress-issue manifest attachment.
3. **Analyzer download/read path**: teach `auto-dent-analyze --progress-issue`
   to read the manifest, download the artifact, unpack it safely, and run the
   existing local transcript analysis.
4. **Expiry and fallback diagnostics**: harden missing, expired, unauthorized,
   malformed, and too-large states with tests.

The first implementation issue after this decision should start with boundary 1.

## Non-Goals

- Do not upload raw unsanitized provider transcript logs.
- Do not make GitHub issue comments carry full transcript payloads.
- Do not add external object storage credentials in the first implementation.
- Do not remove local batch directory analysis; it remains the most complete
  source when available.
