import { describe, it, expect } from 'vitest';
import {
  buildCappedBody,
  truncateMiddle,
  detailsBlock,
  GITHUB_COMMENT_LIMIT,
  DEFAULT_BODY_BUDGET,
  type CappedBlock,
} from './capped-attachment.js';

describe('truncateMiddle', () => {
  it('returns the text unchanged when under the cap', () => {
    expect(truncateMiddle('short', 100, 'logs/x')).toBe('short');
  });

  it('keeps head and tail and names the on-disk pointer', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line-${i}`).join('\n');
    const out = truncateMiddle(lines, 400, 'logs/auto-dent/foo');
    expect(out.length).toBeLessThanOrEqual(400);
    expect(out).toContain('line-0');
    expect(out).toContain('line-499');
    expect(out).toMatch(/lines truncated — full data on disk at logs\/auto-dent\/foo/);
  });
});

describe('buildCappedBody', () => {
  const oneBlock = (content: string): CappedBlock => ({ label: 'data', fence: 'jsonl', content });

  it('assembles header + summary + blocks under budget unchanged', () => {
    const body = buildCappedBody({
      header: '## H',
      summary: '### S\n\nsmall',
      blocks: [oneBlock('a\nb\nc')],
      pointer: 'logs/x',
    });
    expect(body).toContain('## H');
    expect(body).toContain('### S');
    expect(body).toContain('<summary>data</summary>');
    expect(body).toContain('a\nb\nc');
  });

  it('bounds the body to the budget, truncating the block (single-block transcript path)', () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `{"i":${i}}`).join('\n');
    const body = buildCappedBody({
      header: '## Transcript',
      blocks: [oneBlock(huge)],
      budget: 4000,
      pointer: 'logs/auto-dent/run-1.log',
    });
    expect(body.length).toBeLessThanOrEqual(4000);
    expect(body).toContain('## Transcript'); // header always survives
    expect(body).toContain('(truncated)');
    expect(body).toMatch(/full data on disk at logs\/auto-dent\/run-1\.log/);
  });

  it('truncates the FIRST (largest-priority) block first; a small later block survives intact', () => {
    const huge = Array.from({ length: 4000 }, (_, i) => `events-${i}`).join('\n');
    const small = 'state-intact-marker';
    const body = buildCappedBody({
      header: '## H',
      blocks: [
        { label: 'events', fence: 'jsonl', content: huge },
        { label: 'state', fence: 'json', content: small },
      ],
      budget: 3000,
      pointer: 'logs/x',
    });
    expect(body.length).toBeLessThanOrEqual(3000);
    expect(body).toContain('events (truncated)');
    expect(body).toContain(small); // small block untouched
  });

  it('hard-cuts as a last resort when decoration alone overshoots', () => {
    const body = buildCappedBody({
      header: '#'.repeat(500),
      blocks: [oneBlock('x'.repeat(500))],
      budget: 200,
      pointer: 'logs/x',
    });
    expect(body.length).toBeLessThanOrEqual(200);
  });

  it('defaults the budget below GitHub’s hard comment limit', () => {
    expect(DEFAULT_BODY_BUDGET).toBeLessThan(GITHUB_COMMENT_LIMIT);
  });
});

describe('detailsBlock', () => {
  it('wraps content in a collapsed details with a fenced code body', () => {
    expect(detailsBlock('lbl', 'json', '{}')).toBe(
      '<details>\n<summary>lbl</summary>\n\n```json\n{}\n```\n\n</details>',
    );
  });
});
