import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

describe('local main sync guidance', () => {
  it('uses ff-only sync in the kaizen-update self-dogfood path', () => {
    const skill = read('.agents/skills/kaizen-update/SKILL.md');
    expect(skill).toContain('git fetch origin main && git merge --ff-only origin/main');
    expect(skill).not.toContain('git fetch origin main && git merge origin/main --no-edit');
  });

  it('uses ff-only sync in post-merge prompt templates', () => {
    const prompt = read('.agents/kaizen/prompts/post-merge-block.md');
    expect(prompt).toContain('git -C {{MAIN_CHECKOUT}} fetch origin main && git -C {{MAIN_CHECKOUT}} merge --ff-only origin/main');
    expect(prompt).not.toContain('git -C {{MAIN_CHECKOUT}} fetch origin main && git -C {{MAIN_CHECKOUT}} merge origin/main --no-edit');
  });

  it('uses ff-only sync in hook design docs for local main checkout', () => {
    const docs = read('.agents/kaizen/docs/hook-design-principles.md');
    expect(docs).toContain('git -C "$MAIN_CHECKOUT" fetch origin main && git -C "$MAIN_CHECKOUT" merge --ff-only origin/main');
    expect(docs).not.toContain('git -C "$MAIN_CHECKOUT" fetch origin main && git -C "$MAIN_CHECKOUT" merge origin/main --no-edit');
  });
});
