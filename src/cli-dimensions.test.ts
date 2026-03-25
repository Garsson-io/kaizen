/**
 * cli-dimensions.test.ts — Tests for the review dimension CLI tool.
 *
 * Verifies list, show, validate, and add commands work correctly
 * against both real prompts/ dimensions and temp fixtures.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { cmdList, cmdShow, cmdAdd, cmdValidate, formatValidation } from './cli-dimensions.js';
import { resolvePromptsDir } from './review-battery.js';

// Fixture helpers

function createTmpPromptsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-dim-test-'));
  return dir;
}

function writePrompt(dir: string, name: string, content: string): void {
  writeFileSync(resolve(dir, `review-${name}.md`), content, 'utf8');
}

const VALID_PROMPT = (name: string, appliesTo = 'pr') => `---
name: ${name}
description: Test dimension for ${name}
applies_to: ${appliesTo}
---

Some instructions.

\`\`\`json
{
  "dimension": "${name}",
  "summary": "",
  "findings": []
}
\`\`\`
`;

// Tests against the real prompts directory

describe('cli-dimensions against real prompts', () => {
  const realDir = resolvePromptsDir();

  it('list finds all 3 existing dimensions', () => {
    const output = cmdList(realDir);
    expect(output).toContain('plan-coverage');
    expect(output).toContain('requirements');
    expect(output).toContain('pr-description');
    // header + separator + 3 data rows = 5 lines
    const lines = output.split('\n');
    expect(lines.length).toBe(5);
  });

  it('show reads a dimension by name', () => {
    const output = cmdShow(['requirements'], realDir);
    expect(output).toContain('name: requirements');
    expect(output).toContain('adversarial PR reviewer');
    expect(output).toContain('```json');
  });

  it('show multiple dimensions includes headers', () => {
    const output = cmdShow(['requirements', 'plan-coverage'], realDir);
    expect(output).toContain('--- requirements (review-requirements.md) ---');
    expect(output).toContain('--- plan-coverage (review-plan-coverage.md) ---');
  });

  it('show unknown dimension returns error', () => {
    const output = cmdShow(['nonexistent'], realDir);
    expect(output).toContain('Error: unknown dimension "nonexistent"');
    expect(output).toContain('Available:');
  });

  it('validate passes on existing dimensions', () => {
    const v = cmdValidate(realDir);
    expect(v.ok).toBe(true);
    expect(v.results.length).toBe(3);
    for (const r of v.results) {
      expect(r.errors).toEqual([]);
    }
  });

  it('validate formatted output shows OK for all', () => {
    const v = cmdValidate(realDir);
    const output = formatValidation(v);
    expect(output).toContain('All dimensions valid.');
    expect(output).not.toContain('FAIL');
  });
});

// Tests with temp fixtures

describe('cli-dimensions with temp fixtures', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpPromptsDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('list returns no-dimensions message for empty dir', () => {
    const output = cmdList(tmpDir);
    expect(output).toBe('No dimensions found.');
  });

  it('list shows correct table structure', () => {
    writePrompt(tmpDir, 'alpha', VALID_PROMPT('alpha'));
    writePrompt(tmpDir, 'beta', VALID_PROMPT('beta', 'plan'));

    const output = cmdList(tmpDir);
    expect(output).toContain('alpha');
    expect(output).toContain('beta');
    expect(output).toContain('Name');
    expect(output).toContain('Description');
    expect(output).toContain('Applies To');
    expect(output).toContain('File');
  });

  it('add scaffolds a new dimension with correct frontmatter', () => {
    const result = cmdAdd({
      name: 'test-dim',
      description: 'A test dimension',
      appliesTo: 'pr',
      promptsDir: tmpDir,
    });

    expect(result).toContain('Created');
    expect(result).toContain('review-test-dim.md');

    const content = readFileSync(resolve(tmpDir, 'review-test-dim.md'), 'utf8');
    expect(content).toContain('name: test-dim');
    expect(content).toContain('description: A test dimension');
    expect(content).toContain('applies_to: pr');
    expect(content).toContain('```json');
    expect(content).toContain('"dimension": "test-dim"');
  });

  it('add with applies_to plan scaffolds plan-oriented prompt', () => {
    const result = cmdAdd({
      name: 'plan-check',
      description: 'Check the plan',
      appliesTo: 'plan',
      promptsDir: tmpDir,
    });

    expect(result).toContain('Created');
    const content = readFileSync(resolve(tmpDir, 'review-plan-check.md'), 'utf8');
    expect(content).toContain('applies_to: plan');
    expect(content).toContain('plan');
  });

  it('add with applies_to both is accepted', () => {
    const result = cmdAdd({
      name: 'universal',
      description: 'Universal check',
      appliesTo: 'both',
      promptsDir: tmpDir,
    });
    expect(result).toContain('Created');
  });

  it('add rejects invalid applies_to', () => {
    const result = cmdAdd({
      name: 'bad',
      description: 'Bad dimension',
      appliesTo: 'invalid',
      promptsDir: tmpDir,
    });
    expect(result).toContain('Error');
    expect(result).toContain('--applies-to must be one of');
  });

  it('add rejects duplicate dimension', () => {
    writePrompt(tmpDir, 'existing', VALID_PROMPT('existing'));
    const result = cmdAdd({
      name: 'existing',
      description: 'Duplicate',
      appliesTo: 'pr',
      promptsDir: tmpDir,
    });
    expect(result).toContain('Error');
    expect(result).toContain('already exists');
  });

  it('add then validate passes', () => {
    cmdAdd({
      name: 'new-dim',
      description: 'New dimension',
      appliesTo: 'pr',
      promptsDir: tmpDir,
    });
    const v = cmdValidate(tmpDir);
    expect(v.ok).toBe(true);
    expect(v.results.length).toBe(1);
    expect(v.results[0].errors).toEqual([]);
  });

  it('validate catches missing frontmatter', () => {
    writeFileSync(resolve(tmpDir, 'review-bad.md'), 'No frontmatter here.\n```json\n{}\n```\n');
    const v = cmdValidate(tmpDir);
    expect(v.ok).toBe(false);
    expect(v.results[0].errors).toContain('Missing YAML frontmatter');
  });

  it('validate catches missing frontmatter fields', () => {
    writeFileSync(resolve(tmpDir, 'review-partial.md'), '---\nname: partial\n---\nBody\n```json\n{}\n```\n');
    const v = cmdValidate(tmpDir);
    expect(v.ok).toBe(false);
    const errors = v.results[0].errors;
    expect(errors).toContain('Frontmatter missing "description" field');
    expect(errors).toContain('Frontmatter missing "applies_to" field');
  });

  it('validate catches missing json output section', () => {
    writeFileSync(resolve(tmpDir, 'review-nojson.md'), '---\nname: nojson\ndescription: test\napplies_to: pr\n---\nNo json block.\n');
    const v = cmdValidate(tmpDir);
    expect(v.ok).toBe(false);
    expect(v.results[0].errors).toContain('Missing ```json output format section');
  });

  it('formatValidation shows FAIL for invalid dimensions', () => {
    writeFileSync(resolve(tmpDir, 'review-broken.md'), 'broken content');
    const v = cmdValidate(tmpDir);
    const output = formatValidation(v);
    expect(output).toContain('FAIL');
    expect(output).toContain('Validation failed.');
  });
});
