import { createHash } from 'crypto';
import type {
  EventEnvelope,
  ReviewFixCompleteEvent,
  ReviewFixSpawnedEvent,
  ReviewRoundCompleteEvent,
  ReviewRoundStartEvent,
  RunCompleteEvent,
  RunStartEvent,
} from './auto-dent-events.js';

export type OtelAttributeValue = string | number | boolean | string[] | number[] | boolean[];

export interface AutoDentOtelSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: 'INTERNAL';
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, OtelAttributeValue>;
  status: {
    code: 'OK' | 'ERROR';
    message?: string;
  };
}

export interface AutoDentOtelTrace {
  traceId: string;
  runId: string;
  spans: AutoDentOtelSpan[];
  warnings: string[];
}

export interface BuildAutoDentOtelTraceResult {
  trace?: AutoDentOtelTrace;
  warnings: string[];
}

export interface AutoDentOtelTransport {
  exportTrace(trace: AutoDentOtelTrace): void | Promise<void>;
}

export class MemoryOtelTransport implements AutoDentOtelTransport {
  readonly traces: AutoDentOtelTrace[] = [];

  exportTrace(trace: AutoDentOtelTrace): void {
    this.traces.push(trace);
  }
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; statusText: string }>;

export class HttpOtelTransport implements AutoDentOtelTransport {
  constructor(
    private readonly endpoint: string,
    private readonly fetchImpl: FetchLike = globalThis.fetch as FetchLike,
  ) {}

  async exportTrace(trace: AutoDentOtelTrace): Promise<void> {
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(toOtlpJson(trace)),
    });
    if (!response.ok) {
      throw new Error(`OTel export failed: ${response.status} ${response.statusText}`);
    }
  }
}

export class AutoDentOtelSink {
  private readonly eventsByRun = new Map<string, EventEnvelope[]>();
  readonly warnings: string[] = [];

  constructor(private readonly transport: AutoDentOtelTransport) {}

  emit(envelope: EventEnvelope): void {
    const runId = envelope.event.run_id;
    const events = this.eventsByRun.get(runId) ?? [];
    events.push(envelope);
    this.eventsByRun.set(runId, events);

    if (envelope.event.type !== 'run.complete') return;
    const result = buildAutoDentOtelTrace(events);
    this.eventsByRun.delete(runId);
    this.warnings.push(...result.warnings);
    if (!result.trace) return;

    try {
      const exportResult = this.transport.exportTrace(result.trace);
      if (exportResult && typeof (exportResult as Promise<void>).catch === 'function') {
        void (exportResult as Promise<void>).catch((err) => {
          this.warnings.push(formatExportWarning(err));
        });
      }
    } catch (err) {
      this.warnings.push(formatExportWarning(err));
    }
  }
}

export function createOtelSinkFromEnv(
  env: Pick<NodeJS.ProcessEnv, 'KAIZEN_OTEL_ENDPOINT'> = process.env,
): AutoDentOtelSink | undefined {
  const endpoint = env.KAIZEN_OTEL_ENDPOINT?.trim();
  if (!endpoint) return undefined;
  return new AutoDentOtelSink(new HttpOtelTransport(endpoint));
}

export function buildAutoDentOtelTrace(events: EventEnvelope[]): BuildAutoDentOtelTraceResult {
  const warnings: string[] = [];
  const start = findEvent<RunStartEvent>(events, 'run.start');
  const complete = findEvent<RunCompleteEvent>(events, 'run.complete');
  if (!complete) {
    return { warnings: ['missing:run.complete'] };
  }
  if (!start) warnings.push('missing:run.start');

  const runId = complete.event.run_id;
  const traceId = stableHex(`trace:${runId}`, 32);
  const rootSpanId = stableHex(`span:${runId}:run`, 16);
  const rootStart = start?.timestamp ?? complete.timestamp;
  const rootSpan: AutoDentOtelSpan = {
    traceId,
    spanId: rootSpanId,
    name: `auto-dent run ${complete.event.run_num}`,
    kind: 'INTERNAL',
    startTimeUnixNano: isoToUnixNano(rootStart),
    endTimeUnixNano: isoToUnixNano(complete.timestamp),
    attributes: buildRunAttributes(start?.event, complete.event),
    status: buildStatus(complete.event),
  };

  const spans = [
    rootSpan,
    ...buildReviewRoundSpans(events, traceId, rootSpanId),
    ...buildReviewFixSpans(events, traceId, rootSpanId),
  ];
  return {
    trace: { traceId, runId, spans, warnings },
    warnings,
  };
}

function buildRunAttributes(
  start: RunStartEvent | undefined,
  complete: RunCompleteEvent,
): Record<string, OtelAttributeValue> {
  return compactAttributes({
    'gen_ai.operation.name': 'invoke_agent',
    'gen_ai.provider.name': providerName(complete),
    'gen_ai.agent.name': 'kaizen-auto-dent',
    'gen_ai.prompt.name': complete.prompt_template ?? start?.prompt_template,
    'kaizen.prompt.hash': complete.prompt_hash ?? start?.prompt_hash,
    'kaizen.run.id': complete.run_id,
    'kaizen.batch.id': complete.batch_id,
    'kaizen.run.number': complete.run_num,
    'kaizen.run.mode': complete.mode ?? start?.mode,
    'kaizen.run.mode_reason': start?.mode_reason,
    'kaizen.run.outcome': complete.outcome,
    'kaizen.run.exit_code': complete.exit_code,
    'kaizen.run.cost_usd': complete.cost_usd,
    'kaizen.run.tool_calls': complete.tool_calls,
    'kaizen.run.prs_created': complete.prs_created,
    'kaizen.run.issues_filed': complete.issues_filed,
    'kaizen.run.issues_closed': complete.issues_closed,
    'kaizen.run.issues_filed_refs': complete.issues_filed_refs,
    'kaizen.run.issues_closed_refs': complete.issues_closed_refs,
    'kaizen.run.cases': complete.cases,
    'kaizen.run.lifecycle_health': complete.lifecycle_health,
    'kaizen.run.process_verdict': complete.process_verdict,
    'kaizen.run.post_merge_verification': complete.post_merge_verification,
    'kaizen.run.test_health': complete.test_health,
    'kaizen.run.hook_activation_status': complete.hook_activation?.status,
    'kaizen.run.review_verdict': complete.review_verdict,
    'kaizen.run.review_cost_usd': complete.review_cost_usd,
    'kaizen.run.workflow_repair_state': complete.workflow_repair_state,
    'kaizen.run.final_claim_status': complete.final_claim_status,
  });
}

function buildReviewRoundSpans(
  events: EventEnvelope[],
  traceId: string,
  parentSpanId: string,
): AutoDentOtelSpan[] {
  const starts = events.filter(isEventType<ReviewRoundStartEvent>('review.round_start'));
  const completes = events.filter(isEventType<ReviewRoundCompleteEvent>('review.round_complete'));
  return completes.map((complete) => {
    const start = starts.find((candidate) =>
      candidate.event.pr_url === complete.event.pr_url &&
      candidate.event.round === complete.event.round,
    );
    const spanId = stableHex(`span:${complete.event.run_id}:review:${complete.event.pr_url}:${complete.event.round}`, 16);
    return {
      traceId,
      spanId,
      parentSpanId,
      name: `review round ${complete.event.round}`,
      kind: 'INTERNAL',
      startTimeUnixNano: isoToUnixNano(start?.timestamp ?? complete.timestamp),
      endTimeUnixNano: isoToUnixNano(complete.timestamp),
      attributes: compactAttributes({
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.provider.name': 'kaizen',
        'gen_ai.agent.name': 'kaizen-review-battery',
        'kaizen.review.pr_url': complete.event.pr_url,
        'kaizen.review.round': complete.event.round,
        'kaizen.review.dimensions': start?.event.dimensions,
        'kaizen.review.verdict': complete.event.verdict,
        'kaizen.review.missing_count': complete.event.missing_count,
        'kaizen.review.partial_count': complete.event.partial_count,
        'kaizen.review.cost_usd': complete.event.cost_usd,
      }),
      status: complete.event.verdict === 'pass' ? { code: 'OK' } : { code: 'ERROR', message: 'review failed' },
    };
  });
}

function buildReviewFixSpans(
  events: EventEnvelope[],
  traceId: string,
  parentSpanId: string,
): AutoDentOtelSpan[] {
  const starts = events.filter(isEventType<ReviewFixSpawnedEvent>('review.fix_spawned'));
  const completes = events.filter(isEventType<ReviewFixCompleteEvent>('review.fix_complete'));
  return completes.map((complete) => {
    const start = starts.find((candidate) =>
      candidate.event.pr_url === complete.event.pr_url &&
      candidate.event.round === complete.event.round,
    );
    const spanId = stableHex(`span:${complete.event.run_id}:fix:${complete.event.pr_url}:${complete.event.round}`, 16);
    return {
      traceId,
      spanId,
      parentSpanId,
      name: `review fix round ${complete.event.round}`,
      kind: 'INTERNAL',
      startTimeUnixNano: isoToUnixNano(start?.timestamp ?? complete.timestamp),
      endTimeUnixNano: isoToUnixNano(complete.timestamp),
      attributes: compactAttributes({
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.provider.name': 'kaizen',
        'gen_ai.agent.name': 'kaizen-review-fix',
        'kaizen.review.pr_url': complete.event.pr_url,
        'kaizen.review.round': complete.event.round,
        'kaizen.review.gaps_count': start?.event.gaps_count,
        'kaizen.review.fix_success': complete.event.success,
        'kaizen.review.fix_cost_usd': complete.event.cost_usd,
      }),
      status: complete.event.success ? { code: 'OK' } : { code: 'ERROR', message: 'review fix failed' },
    };
  });
}

export function toOtlpJson(trace: AutoDentOtelTrace): unknown {
  return {
    resourceSpans: [{
      resource: {
        attributes: [
          keyValue('service.name', 'kaizen-auto-dent'),
          keyValue('kaizen.run.id', trace.runId),
        ],
      },
      scopeSpans: [{
        scope: { name: 'kaizen.auto-dent-otel' },
        spans: trace.spans.map((span) => ({
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId,
          name: span.name,
          kind: 1,
          startTimeUnixNano: span.startTimeUnixNano,
          endTimeUnixNano: span.endTimeUnixNano,
          attributes: Object.entries(span.attributes).map(([key, value]) => keyValue(key, value)),
          status: {
            code: span.status.code === 'OK' ? 1 : 2,
            message: span.status.message,
          },
        })),
      }],
    }],
  };
}

function providerName(complete: RunCompleteEvent): string {
  const firstProvider = Object.values(complete.phase_providers ?? {})[0]?.provider;
  return firstProvider ?? 'kaizen';
}

function buildStatus(event: RunCompleteEvent): AutoDentOtelSpan['status'] {
  if (event.exit_code === 0 && event.outcome !== 'failure') return { code: 'OK' };
  return { code: 'ERROR', message: event.failure_class ?? `exit_code_${event.exit_code}` };
}

function findEvent<T extends EventEnvelope['event']>(
  events: EventEnvelope[],
  type: T['type'],
): (EventEnvelope & { event: T }) | undefined {
  return events.find((event): event is EventEnvelope & { event: T } => event.event.type === type);
}

function isEventType<T extends EventEnvelope['event']>(
  type: T['type'],
): (event: EventEnvelope) => event is EventEnvelope & { event: T } {
  return (event): event is EventEnvelope & { event: T } => event.event.type === type;
}

function stableHex(input: string, length: number): string {
  return createHash('sha256').update(input).digest('hex').slice(0, length);
}

function isoToUnixNano(iso: string): string {
  return String(BigInt(new Date(iso).getTime()) * 1_000_000n);
}

function compactAttributes(input: Record<string, OtelAttributeValue | undefined>): Record<string, OtelAttributeValue> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) =>
      value !== undefined &&
      (!Array.isArray(value) || value.length > 0),
    ),
  ) as Record<string, OtelAttributeValue>;
}

function keyValue(key: string, value: OtelAttributeValue): unknown {
  if (Array.isArray(value)) {
    return {
      key,
      value: {
        arrayValue: {
          values: value.map((item) => primitiveValue(item)),
        },
      },
    };
  }
  return { key, value: primitiveValue(value) };
}

function primitiveValue(value: string | number | boolean): unknown {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (Number.isInteger(value)) return { intValue: value };
  return { doubleValue: value };
}

function formatExportWarning(err: unknown): string {
  return `otel_export_failed:${err instanceof Error ? err.message : String(err)}`;
}
