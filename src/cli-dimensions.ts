/**
 * cli-dimensions.ts — QoL CLI for working with review dimension prompts.
 *
 * Commands:
 *   list                          Show all dimensions in a table
 *   show <name> [name2 ...]       Display full content of dimension prompt(s)
 *   add <name> --description "..." --applies-to pr|plan|both   Scaffold new dimension
 *   validate                      Check all dimension files have valid frontmatter + JSON output section
 *   briefing --lines <N>          Show review briefing for a PR of N lines
 *
 * Usage: npx tsx src/cli-dimensions.ts <command> [args]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  discoverDimensions,
  loadDimensionMetas,
  resolvePromptsDir,
  parseFrontmatter,
  reviewBriefing,
} from './review-battery.js';

// ── Helpers ─────────────────────────────────────────────────────────

function pad(s: string, len: number): string {
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

// ── Commands ────────────────────────────────────────────────────────

export function cmdList(promptsDir?: string): string {
  const metas = loadDimensionMetas(promptsDir);
  if (metas.length === 0) return 'No dimensions found.';

  const nameW = Math.max(4, ...metas.map(m => m.name.length));
  const descW = Math.max(11, ...metas.map(m => m.description.length));
  const appW = Math.max(10, ...metas.map(m => m.applies_to.length));
  const fileW = Math.max(4, ...metas.map(m => m.file.length));

  const header = `${pad('Name', nameW)} | ${pad('Description', descW)} | ${pad('Applies To', appW)} | ${pad('File', fileW)}`;
  const sep = `${'-'.repeat(nameW)} | ${'-'.repeat(descW)} | ${'-'.repeat(appW)} | ${'-'.repeat(fileW)}`;
  const rows = metas.map(
    m => `${pad(m.name, nameW)} | ${pad(m.description, descW)} | ${pad(m.applies_to, appW)} | ${pad(m.file, fileW)}`,
  );
  return [header, sep, ...rows].join('\n');
}

export function cmdShow(names: string[], promptsDir?: string): string {
  const dir = promptsDir ?? resolvePromptsDir();
  const dims = discoverDimensions(dir);
  const outputs: string[] = [];

  for (const name of names) {
    const file = dims[name];
    if (!file) {
      outputs.push(`Error: unknown dimension "${name}". Available: ${Object.keys(dims).join(', ')}`);
      continue;
    }
    const content = readFileSync(resolve(dir, file), 'utf8');
    if (names.length > 1) {
      outputs.push(`--- ${name} (${file}) ---`);
    }
    outputs.push(content);
  }
  return outputs.join('\n');
}

export interface AddOptions {
  name: string;
  description: string;
  appliesTo: string;
  promptsDir?: string;
}

export function cmdAdd(opts: AddOptions): string {
  const dir = opts.promptsDir ?? resolvePromptsDir();
  const fileName = `review-${opts.name}.md`;
  const filePath = resolve(dir, fileName);

  if (existsSync(filePath)) {
    return `Error: ${fileName} already exists.`;
  }

  const validAppliesTo = ['pr', 'plan', 'both', 'reflection'];
  if (!validAppliesTo.includes(opts.appliesTo)) {
    return `Error: --applies-to must be one of: ${validAppliesTo.join(', ')}`;
  }

  const content = `---
name: ${opts.name}
description: ${opts.description}
applies_to: ${opts.appliesTo}
needs: [diff, issue]
---

You are an adversarial reviewer. Your job is to evaluate the ${opts.appliesTo === 'plan' ? 'plan' : 'PR'} against the "${opts.name}" dimension.

## Review Dimension: ${opts.name}

TODO: Describe what this dimension checks.

## Instructions

TODO: Add review instructions.

## Output Format

Output a YAML block fenced with \`\`\`yaml ... \`\`\` containing this exact structure:

\`\`\`yaml
dimension: ${opts.name}
verdict: pass  # pass | fail
summary: "<one-line summary of findings>"
findings:
  - requirement: "<name or description of the requirement>"
    status: DONE  # DONE | PARTIAL | MISSING
    detail: "<specific evidence>"
    }
  ]
}
\`\`\`

Rules for status:
- DONE: The criterion is fully met.
- PARTIAL: Some aspects are addressed but gaps remain. State what's missing.
- MISSING: The criterion is not addressed.

After the JSON block, you may add prose commentary, but the JSON block MUST come first.
`;

  writeFileSync(filePath, content, 'utf8');
  return `Created ${filePath}`;
}

export interface ValidationResult {
  file: string;
  errors: string[];
}

export function cmdValidate(promptsDir?: string): { results: ValidationResult[]; ok: boolean } {
  const dir = promptsDir ?? resolvePromptsDir();
  const dims = discoverDimensions(dir);
  const results: ValidationResult[] = [];
  let ok = true;

  for (const [dimName, file] of Object.entries(dims)) {
    const errors: string[] = [];
    const filePath = resolve(dir, file);
    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      errors.push('Cannot read file');
      results.push({ file, errors });
      ok = false;
      continue;
    }

    // Check frontmatter exists and has required fields
    const fm = parseFrontmatter(content);
    if (!fm) {
      const hasFrontmatterBlock = /^---\n[\s\S]*?\n---/.test(content);
      errors.push(hasFrontmatterBlock ? 'Frontmatter YAML is invalid (cannot parse)' : 'Missing YAML frontmatter');
    } else {
      if (!fm.name) errors.push('Frontmatter missing "name" field');
      if (!fm.description) errors.push('Frontmatter missing "description" field');
      if (!fm.applies_to) errors.push('Frontmatter missing "applies_to" field');
      if (fm.name && fm.name !== dimName) {
        errors.push(`Frontmatter "name" field "${fm.name}" does not match filename stem "${dimName}" (from ${file})`);
      }
    }

    // Check for ```yaml output format section (```json accepted for legacy compatibility)
    if (!content.includes('```yaml') && !content.includes('```json')) {
      errors.push('Missing ```yaml output format section');
    }

    if (errors.length > 0) ok = false;
    results.push({ file, errors });
  }

  return { results, ok };
}

export function cmdBriefing(prLines: number, promptsDir?: string): string {
  const metas = loadDimensionMetas(promptsDir)
    .filter(m => m.applies_to === 'pr' || m.applies_to === 'both');
  return reviewBriefing(metas, prLines);
}

export function formatValidation(v: { results: ValidationResult[]; ok: boolean }): string {
  const lines: string[] = [];
  for (const r of v.results) {
    if (r.errors.length === 0) {
      lines.push(`  OK  ${r.file}`);
    } else {
      lines.push(`  FAIL  ${r.file}`);
      for (const e of r.errors) {
        lines.push(`        - ${e}`);
      }
    }
  }
  lines.push('');
  lines.push(v.ok ? 'All dimensions valid.' : 'Validation failed.');
  return lines.join('\n');
}

// ── CLI Entry Point ─────────────────────────────────────────────────

export function parseArgs(argv: string[]): void {
  const args = argv.slice(2); // strip node + script
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.log(`Usage: npx tsx src/cli-dimensions.ts <command> [args]

Commands:
  list                                         Show all dimensions
  show <name> [name2 ...]                      Display dimension prompt(s)
  add <name> --description "..." --applies-to pr|plan|both|reflection   Scaffold new dimension
  validate                                     Check all dimension files
  briefing --lines <N>                         Show review briefing for a PR of N lines (pr/both dimensions only)`);
    process.exit(0);
  }

  switch (command) {
    case 'list': {
      console.log(cmdList());
      break;
    }
    case 'show': {
      const names = args.slice(1);
      if (names.length === 0) {
        console.error('Error: show requires at least one dimension name');
        process.exit(1);
      }
      console.log(cmdShow(names));
      break;
    }
    case 'add': {
      const name = args[1];
      if (!name) {
        console.error('Error: add requires a dimension name');
        process.exit(1);
      }
      let description = '';
      let appliesTo = 'pr';
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--description' && args[i + 1]) {
          description = args[++i];
        } else if (args[i] === '--applies-to' && args[i + 1]) {
          appliesTo = args[++i];
        }
      }
      if (!description) {
        console.error('Error: --description is required');
        process.exit(1);
      }
      console.log(cmdAdd({ name, description, appliesTo }));
      break;
    }
    case 'validate': {
      const v = cmdValidate();
      console.log(formatValidation(v));
      if (!v.ok) process.exit(1);
      break;
    }
    case 'briefing': {
      let prLines = 0;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--lines' && args[i + 1]) {
          prLines = parseInt(args[++i], 10);
        }
      }
      if (Number.isNaN(prLines) || prLines <= 0) {
        console.error('Error: --lines <N> is required');
        process.exit(1);
      }
      console.log(cmdBriefing(prLines));
      break;
    }
    default: {
      console.error(`Unknown command: ${command}`);
      process.exit(1);
    }
  }
}

// Only run when executed directly (not when imported by tests)
const isMain = process.argv[1] &&
  (process.argv[1].endsWith('cli-dimensions.ts') || process.argv[1].endsWith('cli-dimensions.js'));
if (isMain) {
  parseArgs(process.argv);
}
