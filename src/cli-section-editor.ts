#!/usr/bin/env npx tsx
/**
 * cli-section-editor.ts — CLI for section-based PR/issue body editing.
 *
 * Usage:
 *   npx tsx src/cli-section-editor.ts list-sections --pr 903 --repo Garsson-io/kaizen
 *   npx tsx src/cli-section-editor.ts read-section --issue 904 --repo Garsson-io/kaizen --section "Plan"
 *   npx tsx src/cli-section-editor.ts add-section --pr 903 --repo Garsson-io/kaizen --section "Known Limitations" --text "..."
 *   npx tsx src/cli-section-editor.ts add-section --pr 903 --repo Garsson-io/kaizen --section "Known Limitations" --file limits.md
 *   npx tsx src/cli-section-editor.ts replace-section --issue 904 --repo Garsson-io/kaizen --section "Plan" --text "..."
 *   npx tsx src/cli-section-editor.ts remove-section --pr 903 --repo Garsson-io/kaizen --section "Draft Notes"
 *
 * Part of kaizen issue #908.
 */

import { readFileSync } from 'node:fs';
import {
  listSections,
  readSection,
  addSection,
  replaceSection,
  removeSection,
  type TargetKind,
  type SectionTarget,
} from './section-editor.js';

function usage(): never {
  console.error(`Usage: npx tsx src/cli-section-editor.ts <command> [--pr N | --issue N] --repo <owner/repo> [options]

Commands:
  list-sections     List ## section names in the body
  read-section      Read a single section by name
  add-section       Add or upsert a named section
  replace-section   Replace content of an existing section
  remove-section    Remove a named section

Options:
  --pr <N>            PR number (mutually exclusive with --issue)
  --issue <N>         Issue number (mutually exclusive with --pr)
  --repo <owner/repo> GitHub repo (required)
  --section <name>    Section name (the ## header text, without ##)
  --text <string>     Section content
  --file <path>       Read content from file
`);
  process.exit(1);
}

function parseArgs(): { command: string; target: SectionTarget; section?: string; text?: string; file?: string } {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command) usage();

  let pr = '';
  let issue = '';
  let repo = '';
  let section: string | undefined;
  let text: string | undefined;
  let file: string | undefined;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--pr' && args[i + 1]) { pr = args[++i]; continue; }
    if (args[i] === '--issue' && args[i + 1]) { issue = args[++i]; continue; }
    if (args[i] === '--repo' && args[i + 1]) { repo = args[++i]; continue; }
    if (args[i] === '--section' && args[i + 1]) { section = args[++i]; continue; }
    if (args[i] === '--text' && args[i + 1]) { text = args[++i]; continue; }
    if (args[i] === '--file' && args[i + 1]) { file = args[++i]; continue; }
  }

  if ((!pr && !issue) || !repo) usage();

  const kind: TargetKind = pr ? 'pr' : 'issue';
  const number = pr || issue;

  return { command, target: { kind, number, repo }, section, text, file };
}

function main(): void {
  const { command, target, section, text, file } = parseArgs();

  switch (command) {
    case 'list-sections': {
      const names = listSections(target);
      if (names.length === 0) { console.log('No sections found.'); break; }
      for (const name of names) console.log(name);
      break;
    }
    case 'read-section': {
      if (!section) { console.error('Error: --section required'); process.exit(1); }
      const content = readSection(target, section);
      if (!content) { console.error(`Section "${section}" not found.`); process.exit(1); }
      console.log(content);
      break;
    }
    case 'add-section': {
      if (!section) { console.error('Error: --section required'); process.exit(1); }
      const content = file ? readFileSync(file, 'utf8') : text;
      if (!content) { console.error('Error: --text or --file required'); process.exit(1); }
      addSection(target, section, content);
      console.log(`Section "${section}" added/updated.`);
      break;
    }
    case 'replace-section': {
      if (!section) { console.error('Error: --section required'); process.exit(1); }
      const content = file ? readFileSync(file, 'utf8') : text;
      if (!content) { console.error('Error: --text or --file required'); process.exit(1); }
      replaceSection(target, section, content);
      console.log(`Section "${section}" replaced.`);
      break;
    }
    case 'remove-section': {
      if (!section) { console.error('Error: --section required'); process.exit(1); }
      removeSection(target, section);
      console.log(`Section "${section}" removed.`);
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      usage();
  }
}

main();
