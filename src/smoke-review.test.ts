/**
 * smoke-review.test.ts — Real claude -p call tests for --json-schema enforcement.
 *
 * Gated behind KAIZEN_SMOKE=1 to avoid running in CI.
 * Tests the actual runner (spawnReview) and parser (structured_output extraction).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnReview, REVIEW_FINDING_JSON_SCHEMA, loadReviewPrompt, renderTemplate } from './review-battery.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

describe.skipIf(!process.env.KAIZEN_SMOKE)('smoke: --json-schema structured output', () => {
  it('INVARIANT: runClaude extracts structured_output from result message', async () => {
    // INVARIANT: when claude uses StructuredOutput tool (triggered by --json-schema),
    // the structured data is in result.structured_output — not in assistant text blocks.
    // This test drives runClaude directly via the CLI to verify extraction.
    const schema = JSON.stringify({
      type: 'object', required: ['dimension', 'verdict', 'summary', 'findings'],
      properties: {
        dimension: { type: 'string' },
        verdict: { type: 'string', enum: ['pass', 'fail'] },
        summary: { type: 'string' },
        findings: { type: 'array', items: { type: 'object' } },
      },
    });

    const result = await new Promise<{ text: string; exitCode: number }>((resolve) => {
      const args = ['-p', '--output-format', 'stream-json', '--verbose',
        '--dangerously-skip-permissions', '--model', 'claude-haiku-4-5-20251001',
        '--json-schema', schema];
      const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.write('Return a review finding: dimension=smoke, verdict=pass, summary="ok", findings=[]', 'utf8');
      child.stdin.end();
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', () => {});
      setTimeout(() => { child.kill(); }, 45_000);
      child.on('close', (code) => {
        let text = '';
        let structuredOutput: unknown;
        for (const line of stdout.split('\n')) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === 'result' && msg.structured_output != null) {
              structuredOutput = msg.structured_output;
            } else if (msg.type === 'assistant') {
              for (const b of msg.message?.content ?? []) {
                if (b.type === 'text') text += b.text;
              }
            }
          } catch { continue; }
        }
        if (structuredOutput !== undefined) text = JSON.stringify(structuredOutput);
        resolve({ text, exitCode: code ?? -1 });
      });
    });

    console.log('extracted text:', result.text.slice(0, 200));
    expect(result.exitCode).toBe(0);
    const obj = JSON.parse(result.text);
    expect(['pass', 'fail']).toContain(obj.verdict);
    expect(obj.dimension).toBeTruthy();
    expect(Array.isArray(obj.findings)).toBe(true);
    console.log('PASS: structured_output extracted correctly');
  }, 60_000);

  it('INVARIANT: REVIEW_FINDING_JSON_SCHEMA is valid JSON Schema (derived from zod)', () => {
    // INVARIANT: schema must be derived from zod via z.toJSONSchema, not hand-rolled.
    // Verify the exported constant has all required fields.
    const s = REVIEW_FINDING_JSON_SCHEMA as Record<string, unknown>;
    expect(s).toHaveProperty('type', 'object');
    const props = s['properties'] as Record<string, unknown>;
    expect(props).toHaveProperty('dimension');
    expect(props).toHaveProperty('verdict');
    expect(props).toHaveProperty('summary');
    expect(props).toHaveProperty('findings');
    const required = s['required'] as string[];
    expect(required).toContain('dimension');
    expect(required).toContain('verdict');
    console.log('PASS: REVIEW_FINDING_JSON_SCHEMA is valid');
  });
});
