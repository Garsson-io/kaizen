import { describe, expect, it } from 'vitest';
import {
  buildAutoDentOtelTrace,
  createOtelSinkFromEnv,
  HttpOtelTransport,
  MemoryOtelTransport,
  toOtlpJson,
} from './auto-dent-otel.js';
import type { EventEnvelope } from './auto-dent-events.js';

const runStart: EventEnvelope = {
  timestamp: '2026-06-29T10:00:00.000Z',
  event: {
    type: 'run.start',
    run_id: 'batch/run-1',
    batch_id: 'batch',
    run_num: 1,
    mode: 'exploit',
    mode_reason: 'schedule',
    prompt_template: 'deep-dive-default.md',
    prompt_hash: 'abc123',
  },
};

const reviewStart: EventEnvelope = {
  timestamp: '2026-06-29T10:00:10.000Z',
  event: {
    type: 'review.round_start',
    run_id: 'batch/run-1',
    batch_id: 'batch',
    run_num: 1,
    pr_url: 'https://github.com/Garsson-io/kaizen/pull/1188',
    round: 1,
    dimensions: ['correctness', 'security'],
  },
};

const reviewComplete: EventEnvelope = {
  timestamp: '2026-06-29T10:00:20.000Z',
  event: {
    type: 'review.round_complete',
    run_id: 'batch/run-1',
    batch_id: 'batch',
    run_num: 1,
    pr_url: 'https://github.com/Garsson-io/kaizen/pull/1188',
    round: 1,
    verdict: 'pass',
    missing_count: 0,
    partial_count: 0,
    cost_usd: 0.15,
    duration_ms: 10_000,
  },
};

const fixStart: EventEnvelope = {
  timestamp: '2026-06-29T10:00:30.000Z',
  event: {
    type: 'review.fix_spawned',
    run_id: 'batch/run-1',
    batch_id: 'batch',
    run_num: 1,
    pr_url: 'https://github.com/Garsson-io/kaizen/pull/1188',
    round: 1,
    gaps_count: 2,
  },
};

const fixComplete: EventEnvelope = {
  timestamp: '2026-06-29T10:00:45.000Z',
  event: {
    type: 'review.fix_complete',
    run_id: 'batch/run-1',
    batch_id: 'batch',
    run_num: 1,
    pr_url: 'https://github.com/Garsson-io/kaizen/pull/1188',
    round: 1,
    success: true,
    cost_usd: 0.25,
  },
};

const runComplete: EventEnvelope = {
  timestamp: '2026-06-29T10:01:00.000Z',
  event: {
    type: 'run.complete',
    run_id: 'batch/run-1',
    batch_id: 'batch',
    run_num: 1,
    duration_ms: 60_000,
    exit_code: 0,
    cost_usd: 2.5,
    tool_calls: 42,
    prs_created: 1,
    issues_filed: 0,
    issues_filed_refs: [],
    issues_closed: 1,
    issues_closed_refs: ['#1188'],
    cases: ['260629-k1188-otel-genai-traces'],
    stop_requested: false,
    lifecycle_violations: 0,
    lifecycle_health: 'clean',
    process_verdict: 'pass',
    post_merge_verification: 'pass',
    process_issue_count: 0,
    process_summary: 'ok',
    review_verdict: 'pass',
    review_cost_usd: 0.15,
    test_health: 'pass',
    workflow_repair_state: 'merge_ready',
    phase_providers: {
      implementation: { provider: 'codex', billing: 'subscription-cli' },
    },
    prompt_template: 'deep-dive-default.md',
    prompt_hash: 'abc123',
    final_claim_status: 'valid',
    outcome: 'success',
    mode: 'exploit',
  },
};

describe('auto-dent OTel GenAI projection (#1188)', () => {
  it('maps run events to a GenAI-semconv root span with kaizen correlation attributes', () => {
    const result = buildAutoDentOtelTrace([runStart, runComplete]);

    expect(result.warnings).toEqual([]);
    expect(result.trace?.spans).toHaveLength(1);
    const root = result.trace?.spans[0];
    expect(root).toMatchObject({
      name: 'auto-dent run 1',
      kind: 'INTERNAL',
      status: { code: 'OK' },
    });
    expect(root?.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.provider.name': 'codex',
      'gen_ai.agent.name': 'kaizen-auto-dent',
      'gen_ai.prompt.name': 'deep-dive-default.md',
      'kaizen.prompt.hash': 'abc123',
      'kaizen.run.id': 'batch/run-1',
      'kaizen.run.mode': 'exploit',
      'kaizen.run.outcome': 'success',
      'kaizen.run.cost_usd': 2.5,
      'kaizen.run.issues_closed_refs': ['#1188'],
      'kaizen.run.cases': ['260629-k1188-otel-genai-traces'],
      'kaizen.run.process_verdict': 'pass',
      'kaizen.run.test_health': 'pass',
    });
  });

  it('maps review and fix-loop events as child spans under the run span', () => {
    const result = buildAutoDentOtelTrace([
      runStart,
      reviewStart,
      reviewComplete,
      fixStart,
      fixComplete,
      runComplete,
    ]);

    const spans = result.trace?.spans ?? [];
    expect(spans).toHaveLength(3);
    const root = spans.find((span) => span.name === 'auto-dent run 1');
    const review = spans.find((span) => span.name === 'review round 1');
    const fix = spans.find((span) => span.name === 'review fix round 1');
    expect(review?.parentSpanId).toBe(root?.spanId);
    expect(fix?.parentSpanId).toBe(root?.spanId);
    expect(review?.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'kaizen-review-battery',
      'kaizen.review.dimensions': ['correctness', 'security'],
      'kaizen.review.verdict': 'pass',
    });
    expect(fix?.attributes).toMatchObject({
      'gen_ai.agent.name': 'kaizen-review-fix',
      'kaizen.review.gaps_count': 2,
      'kaizen.review.fix_success': true,
    });
  });

  it('does not emit sensitive GenAI content attributes by default', () => {
    const result = buildAutoDentOtelTrace([runStart, runComplete]);
    const attrs = result.trace?.spans.flatMap((span) => Object.keys(span.attributes)) ?? [];

    expect(attrs).not.toContain('gen_ai.input.messages');
    expect(attrs).not.toContain('gen_ai.output.messages');
    expect(attrs).not.toContain('gen_ai.system_instructions');
    expect(attrs).not.toContain('gen_ai.tool.call.arguments');
    expect(attrs).not.toContain('gen_ai.tool.call.result');
    expect(attrs).not.toContain('gen_ai.usage.input_tokens');
    expect(attrs).not.toContain('gen_ai.usage.output_tokens');
  });

  it('does not fabricate a completed span when run.complete is missing', () => {
    const result = buildAutoDentOtelTrace([runStart]);

    expect(result.trace).toBeUndefined();
    expect(result.warnings).toEqual(['missing:run.complete']);
  });

  it('converts spans to an OTLP JSON trace payload shape', () => {
    const result = buildAutoDentOtelTrace([runStart, runComplete]);
    const payload = toOtlpJson(result.trace!);

    expect(payload).toMatchObject({
      resourceSpans: [{
        scopeSpans: [{
          scope: { name: 'kaizen.auto-dent-otel' },
        }],
      }],
    });
    expect(JSON.stringify(payload)).toContain('gen_ai.operation.name');
    expect(JSON.stringify(payload)).toContain('kaizen.run.id');
  });

  it('provides an in-memory transport for deterministic sink tests', () => {
    const transport = new MemoryOtelTransport();
    const trace = buildAutoDentOtelTrace([runStart, runComplete]).trace!;

    transport.exportTrace(trace);

    expect(transport.traces).toEqual([trace]);
  });

  it('constructs an env-gated sink only when KAIZEN_OTEL_ENDPOINT is set', () => {
    expect(createOtelSinkFromEnv({ KAIZEN_OTEL_ENDPOINT: '' })).toBeUndefined();
    expect(createOtelSinkFromEnv({ KAIZEN_OTEL_ENDPOINT: 'https://otel.example/v1/traces' })).toBeDefined();
  });

  it('posts OTLP JSON to the configured HTTP endpoint', async () => {
    const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
    const transport = new HttpOtelTransport('https://otel.example/v1/traces', async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, statusText: 'OK' };
    });
    const trace = buildAutoDentOtelTrace([runStart, runComplete]).trace!;

    await transport.exportTrace(trace);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'https://otel.example/v1/traces',
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
    });
    expect(JSON.parse(calls[0].init.body)).toMatchObject({
      resourceSpans: expect.any(Array),
    });
  });
});
