import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  HookResponseEventSchema,
  parseHookGymFixtureContent,
} from './hook-gym-schema.js';

const LIVE_PROBE_FIXTURE = resolve(__dirname, '../fixtures/live/probe-hooks.jsonl');

function readLiveFixtureObjects(): Record<string, unknown>[] {
  return readFileSync(LIVE_PROBE_FIXTURE, 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('hook-gym fixture schema validation', () => {
  it('accepts a real captured probe-hooks fixture', () => {
    const events = parseHookGymFixtureContent(readFileSync(LIVE_PROBE_FIXTURE, 'utf-8'));

    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => event.type === 'system' && event.subtype === 'hook_started')).toBe(true);
    expect(events.some((event) => event.type === 'system' && event.subtype === 'hook_response')).toBe(true);
    expect(events.some((event) => event.type === 'assistant')).toBe(true);
    expect(events.some((event) => event.type === 'user')).toBe(true);
  });

  it('rejects malformed hook responses copied from the real fixture', () => {
    const objects = readLiveFixtureObjects();
    const response = objects.find(
      (event) => event.type === 'system' && event.subtype === 'hook_response',
    );
    expect(response).toBeDefined();
    response!.exit_code = '0';

    const malformedFixture = objects.map((event) => JSON.stringify(event)).join('\n');

    expect(() => parseHookGymFixtureContent(malformedFixture)).toThrow(/Invalid hook-gym fixture/);
    expect(HookResponseEventSchema.safeParse(response).success).toBe(false);
  });
});
