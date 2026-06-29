# Auto-Dent Trace Platform Evaluation

This document resolves #545's first decision point: which trace platform path
auto-dent should use for remote run observability without creating another
conversion surface.

## Decision

Use the existing OpenTelemetry projection as the single trace ingestion contract.

- `logs/auto-dent/<batch>/events.jsonl` remains the durable structured source of
  truth.
- `scripts/auto-dent-otel.ts` is the only stream-to-trace projection for
  auto-dent run lifecycle, cost, review, and fix spans.
- `KAIZEN_OTEL_ENDPOINT` is the operator switch for mirroring completed runs to
  an OTLP HTTP collector.
- `docs/auto-dent-transcript-transport.md` remains the contract for complete
  scrubbed transcript bundles. Trace spans should carry IDs, cost, status,
  duration, issue/PR references, and artifact pointers, not raw reasoning logs.

Try Langfuse first for an interactive trace UI. Keep LangSmith, Braintrust, and
Phoenix as comparison/fallback targets because all have OpenTelemetry paths, but
none justify a vendor-specific `log-to-langfuse.ts` style converter before a live
endpoint proves a concrete gap in the current OTLP payload.

## Platform Matrix

| Platform | Store | View | Mine | Fit for current auto-dent path |
| --- | --- | --- | --- | --- |
| Langfuse | Accepts OTLP HTTP traces at `/api/public/otel`; cloud and self-host options exist. | LLM trace UI, costs, scores, sessions, and metadata filtering are close to #545's operator view. | Metadata filters and scores can support cross-run slices if auto-dent maps batch/run/case fields onto trace metadata. | First candidate. It matches the existing `HttpOtelTransport` shape best; only live smoke can prove UI fidelity. |
| LangSmith | Has an OpenTelemetry tracing path and collector/fanout guidance. | Mature trace UI and dataset/eval features. | Good analytics/eval surface, but LangChain-native workflows may be the easiest path. | Comparison target. Do not switch the exporter contract just to adopt LangSmith SDK conventions. |
| Braintrust | Supports OpenTelemetry integration/exporter paths. | Strong eval/logging workflow; observability is useful but more eval-centered. | Strong dataset/eval mining surface. | Secondary candidate if #545's "mine" goal outweighs trace-debug UI. Keep OTel boundary. |
| Phoenix | OTel/OpenInference-oriented and accepts OTLP-style configuration. | Strong ML/LLM trace inspection and eval workflows. | Good for OpenInference-rich traces. | Viable if auto-dent later enriches spans with OpenInference semantics; current GenAI OTel payload may render less richly. |
| Generic OTel backend | Any OTLP collector can store the spans. | Jaeger/Grafana-style views are reliable but less agent-aware. | Requires external metrics/log queries or custom dashboards. | Operational fallback, not the preferred human trace UI. |

## Metadata Contract

For the first UI smoke, the exported trace must make these fields filterable or
visible at trace/span level:

- `kaizen.batch.id`
- `kaizen.run.id`
- `kaizen.run.number`
- `kaizen.run.mode`
- `kaizen.run.outcome`
- `kaizen.run.exit_code`
- `kaizen.run.cost_usd`
- `kaizen.run.prs_created`
- `kaizen.run.issues_filed_refs`
- `kaizen.run.issues_closed_refs`
- `kaizen.run.cases`
- `kaizen.run.lifecycle_health`
- `kaizen.run.review_verdict`

If Langfuse needs promoted top-level trace metadata for filterability, enrich
the existing OTel projection in `scripts/auto-dent-otel.ts`. Do not add a
parallel Langfuse-only converter.

## Issue Questions Answered

1. **Ingest:** use OTLP through `scripts/auto-dent-otel.ts`. Do not convert
   stream-json directly to a vendor SDK format unless a live platform smoke
   proves OTLP cannot satisfy the UI contract.
2. **Agent hierarchy:** the current trace projection models the run as a root
   span and review/fix work as child spans. If future subagent events need their
   own hierarchy, add child spans to the same OTel projection.
3. **Cross-run analytics:** use `kaizen.batch.id`, `kaizen.run.*`,
   issue/PR-reference attributes, and score/lifecycle attributes as the first
   filter/group-by surface. If a platform only filters top-level trace metadata,
   promote those same fields in the OTel projection.
4. **Scoring integration:** push score outputs as span or trace attributes that
   point back to the scoring artifact. Keep large score artifacts in the
   existing artifact/attachment chain rather than embedding raw blobs in spans.
5. **Self-hosted vs cloud:** Langfuse remains first because it supports both
   cloud and self-host modes. The choice between them depends on credentials,
   retention, and current pricing at smoke time.
6. **Cost/free tier:** do not hard-code a pricing claim in repo docs. The
   credentialed smoke must check current platform pricing/free-tier limits when
   it runs.

## Transcript Boundary

Trace platforms are for timelines, span attributes, status, cost, and pointers.
Complete transcript retention is a separate artifact-chain concern.

The full `run-*.log` transcript bundle can contain sensitive reasoning, tool
outputs, and credentials accidentally echoed by tools. It must follow
`docs/auto-dent-transcript-transport.md`: scrub first, fail closed on scrub
failure, upload complete bundles through the chosen transcript transport, and
store only compact manifests/pointers on issues.

## Operator Smoke

Local deterministic proof:

```bash
npx vitest run scripts/auto-dent-otel.test.ts scripts/auto-dent-events.test.ts
```

Live platform proof requires a collector endpoint and credentials. For Langfuse,
configure the endpoint to its OTLP HTTP route and run an auto-dent batch with:

```bash
KAIZEN_OTEL_ENDPOINT=https://<langfuse-host>/api/public/otel
```

The current `HttpOtelTransport` posts OTLP JSON with `content-type:
application/json`. If a platform requires OTLP protobuf, gRPC, custom auth
headers, or promoted top-level metadata, adapt the single OTel transport or
projection behind `KAIZEN_OTEL_ENDPOINT`; keep JSONL and transcript artifacts as
the durable fallback.

Credentialed live smoke is tracked separately in #1723. That issue must verify
the actual Langfuse UI, metadata filterability, and current pricing/free-tier
constraints before any platform-specific converter or #556 dashboard work is
started.

## Disqualifiers

Disqualify the first-candidate path and revisit the matrix if a live smoke shows
one of these failures:

- completed auto-dent runs are not visible as one trace per run
- batch/run IDs cannot be filtered or searched
- costs, issue/PR references, lifecycle health, and review status are invisible
- raw transcripts are required for useful UI rendering
- export failures can block auto-dent lifecycle completion

If only metadata shape is missing, file a schema-enrichment issue against
`scripts/auto-dent-otel.ts`. If the UI cannot satisfy store/view/mine even with
metadata enrichment, compare LangSmith, Braintrust, and Phoenix using the same
OTLP payload before building #556's dashboard surface.

## Sources Checked

- Langfuse OpenTelemetry integration:
  `https://langfuse.com/integrations/native/opentelemetry`
- LangSmith OpenTelemetry tracing:
  `https://docs.langchain.com/langsmith/trace-with-opentelemetry`
- Braintrust OpenTelemetry integration:
  `https://www.braintrust.dev/docs/integrations/sdk-integrations/opentelemetry`
- Braintrust OTel JS exporter reference:
  `https://www.braintrust.dev/docs/reference/integrations/otel-js/0.2.0/otel-js`
- Phoenix OTel setup:
  `https://arize.com/docs/phoenix/tracing/how-to-tracing/setup-tracing/setup-using-phoenix-otel`
- Phoenix OpenInference exporter:
  `https://arize.com/docs/phoenix/tracing/concepts-tracing/otel-openinference/exporter`

## Current Limitations

This document does not claim a successful cloud ingestion smoke. That requires
external credentials or a self-hosted endpoint and is tracked by #1723. The
kaizen-side contract is
covered by deterministic OTLP payload/export tests; the remaining proof is
vendor availability and UI fidelity.
