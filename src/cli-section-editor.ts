#!/usr/bin/env npx tsx
/**
 * cli-section-editor.ts — CLI for structured PRs and issues.
 *
 * Sections (## headers in PR/issue bodies):
 *   npx tsx src/cli-section-editor.ts list-sections --pr 903 --repo Garsson-io/kaizen
 *   npx tsx src/cli-section-editor.ts read-section --issue 904 --repo Garsson-io/kaizen --name "Plan"
 *   npx tsx src/cli-section-editor.ts add-section --pr 903 --repo Garsson-io/kaizen --name "Validation" --text "..."
 *   npx tsx src/cli-section-editor.ts replace-section --pr 903 --repo Garsson-io/kaizen --name "Plan" --file plan.md
 *   npx tsx src/cli-section-editor.ts remove-section --pr 903 --repo Garsson-io/kaizen --name "Draft"
 *
 * Attachments (named marker comments on issues):
 *   npx tsx src/cli-section-editor.ts list-attachments --issue 904 --repo Garsson-io/kaizen
 *   npx tsx src/cli-section-editor.ts read-attachment --issue 904 --repo Garsson-io/kaizen --name plan
 *   npx tsx src/cli-section-editor.ts write-attachment --issue 904 --repo Garsson-io/kaizen --name plan --file plan.md
 *   npx tsx src/cli-section-editor.ts remove-attachment --issue 904 --repo Garsson-io/kaizen --name plan
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
  listAttachments,
  readAttachment,
  writeAttachment,
  removeAttachment,
  type TargetKind,
  type SectionTarget,
  type AttachmentTarget,
} from './section-editor.js';

function usage(): never {
  console.error(`Usage: npx tsx src/cli-section-editor.ts <command> [--pr N | --issue N] --repo <owner/repo> [options]

Section commands (## headers in PR/issue bodies):
  list-sections     List ## section names
  read-section      Read a section by name
  add-section       Add or upsert a named section
  replace-section   Replace content of an existing section
  remove-section    Remove a named section

Attachment commands (named marker comments on issues):
  list-attachments  List attachment names on an issue
  read-attachment   Read a named attachment
  write-attachment  Create or update a named attachment
  remove-attachment Delete a named attachment

Options:
  --pr <N>            PR number (sections only)
  --issue <N>         Issue number (sections or attachments)
  --repo <owner/repo> GitHub repo (required)
  --name <name>       Section name (## header text) or attachment name
  --text <string>     Content to write
  --file <path>       Read content from file
`);
  process.exit(1);
}

interface ParsedArgs {
  command: string;
  pr: string;
  issue: string;
  repo: string;
  name?: string;
  text?: string;
  file?: string;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command) usage();

  let pr = '', issue = '', repo = '';
  let name: string | undefined, text: string | undefined, file: string | undefined;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--pr' && args[i + 1]) { pr = args[++i]; continue; }
    if (args[i] === '--issue' && args[i + 1]) { issue = args[++i]; continue; }
    if (args[i] === '--repo' && args[i + 1]) { repo = args[++i]; continue; }
    if ((args[i] === '--name' || args[i] === '--section') && args[i + 1]) { name = args[++i]; continue; }
    if (args[i] === '--text' && args[i + 1]) { text = args[++i]; continue; }
    if (args[i] === '--file' && args[i + 1]) { file = args[++i]; continue; }
  }

  if (!repo) usage();
  return { command, pr, issue, repo, name, text, file };
}

function main(): void {
  const { command, pr, issue, repo, name, text, file } = parseArgs();

  // Section commands need a PR or issue target
  const sectionTarget = (): SectionTarget => {
    if (!pr && !issue) { console.error('Error: --pr or --issue required'); process.exit(1); }
    return { kind: (pr ? 'pr' : 'issue') as TargetKind, number: pr || issue, repo };
  };

  // Attachment commands need an issue target
  const attachmentTarget = (): AttachmentTarget => {
    if (!issue) { console.error('Error: --issue required for attachments'); process.exit(1); }
    return { issueNum: issue, repo };
  };

  const content = () => {
    const c = file ? readFileSync(file, 'utf8') : text;
    if (!c) { console.error('Error: --text or --file required'); process.exit(1); }
    return c;
  };

  switch (command) {
    case 'list-sections': {
      const names = listSections(sectionTarget());
      if (names.length === 0) { console.log('No sections found.'); break; }
      for (const n of names) console.log(n);
      break;
    }
    case 'read-section': {
      if (!name) { console.error('Error: --name required'); process.exit(1); }
      const c = readSection(sectionTarget(), name);
      if (!c) { console.error(`Section "${name}" not found.`); process.exit(1); }
      console.log(c);
      break;
    }
    case 'add-section': {
      if (!name) { console.error('Error: --name required'); process.exit(1); }
      addSection(sectionTarget(), name, content());
      console.log(`Section "${name}" added/updated.`);
      break;
    }
    case 'replace-section': {
      if (!name) { console.error('Error: --name required'); process.exit(1); }
      replaceSection(sectionTarget(), name, content());
      console.log(`Section "${name}" replaced.`);
      break;
    }
    case 'remove-section': {
      if (!name) { console.error('Error: --name required'); process.exit(1); }
      removeSection(sectionTarget(), name);
      console.log(`Section "${name}" removed.`);
      break;
    }
    case 'list-attachments': {
      const names = listAttachments(attachmentTarget());
      if (names.length === 0) { console.log('No attachments found.'); break; }
      for (const n of names) console.log(n);
      break;
    }
    case 'read-attachment': {
      if (!name) { console.error('Error: --name required'); process.exit(1); }
      const a = readAttachment(attachmentTarget(), name);
      if (!a) { console.error(`Attachment "${name}" not found.`); process.exit(1); }
      console.log(a.content);
      break;
    }
    case 'write-attachment': {
      if (!name) { console.error('Error: --name required'); process.exit(1); }
      const url = writeAttachment(attachmentTarget(), name, content());
      console.log(`Attachment "${name}" written: ${url}`);
      break;
    }
    case 'remove-attachment': {
      if (!name) { console.error('Error: --name required'); process.exit(1); }
      removeAttachment(attachmentTarget(), name);
      console.log(`Attachment "${name}" removed.`);
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      usage();
  }
}

main();
