/**
 * section-editor.ts — Structured PRs and issues.
 *
 * Two capabilities:
 * 1. **Sections**: Named ## sections in PR/issue bodies — list/read/add/replace/remove
 *    without full body read/rewrite. Saves tokens.
 * 2. **Attachments**: Named marker comments on issues — store/retrieve/list named data
 *    (plans, test plans, metadata) as issue comments with HTML marker headers.
 *    Marker format: <!-- kaizen:<name> --> at the start of the comment.
 *
 * Part of kaizen issue #902, #905, #908.
 */

import { gh } from './lib/gh-exec.js';

export type TargetKind = 'pr' | 'issue';

export interface SectionTarget {
  /** 'pr' or 'issue' */
  kind: TargetKind;
  /** PR number or issue number */
  number: string;
  /** GitHub repo (owner/repo) */
  repo: string;
}

export interface Section {
  /** The header text (without ##) */
  name: string;
  /** The full content including the ## header line */
  content: string;
  /** Start offset in the body string */
  startOffset: number;
  /** End offset in the body string */
  endOffset: number;
}



/** Fetch the body of a PR or issue. */
export function fetchBody(target: SectionTarget): string {
  if (target.kind === 'pr') {
    return gh(['pr', 'view', target.number, '--repo', target.repo, '--json', 'body', '--jq', '.body']);
  }
  return gh(['issue', 'view', target.number, '--repo', target.repo, '--json', 'body', '--jq', '.body']);
}

/** Write back the full body of a PR or issue. */
function writeBody(target: SectionTarget, body: string): void {
  if (target.kind === 'pr') {
    gh(['pr', 'edit', target.number, '--repo', target.repo, '--body', body]);
  } else {
    gh(['issue', 'edit', target.number, '--repo', target.repo, '--body', body]);
  }
}

/**
 * Parse a markdown body into named sections.
 * Each section starts with a ## header and extends to the next ## or EOF.
 * Content before the first ## is returned as section with name '' (preamble).
 */
export function parseSections(body: string): Section[] {
  const sections: Section[] = [];
  const headerRe = /^## (.+)$/gm;
  let lastMatch: { name: string; start: number } | null = null;

  for (const match of body.matchAll(headerRe)) {
    if (lastMatch) {
      sections.push({
        name: lastMatch.name,
        content: body.slice(lastMatch.start, match.index!).trimEnd(),
        startOffset: lastMatch.start,
        endOffset: match.index!,
      });
    } else if (match.index! > 0) {
      // Preamble before first ##
      sections.push({
        name: '',
        content: body.slice(0, match.index!).trimEnd(),
        startOffset: 0,
        endOffset: match.index!,
      });
    }
    lastMatch = { name: match[1], start: match.index! };
  }

  // Last section extends to EOF
  if (lastMatch) {
    sections.push({
      name: lastMatch.name,
      content: body.slice(lastMatch.start).trimEnd(),
      startOffset: lastMatch.start,
      endOffset: body.length,
    });
  } else if (body.trim()) {
    // No ## headers at all — entire body is preamble
    sections.push({
      name: '',
      content: body.trimEnd(),
      startOffset: 0,
      endOffset: body.length,
    });
  }

  return sections;
}

/**
 * List section names in a PR or issue body.
 * Fast: fetches body, parses headers, returns names only.
 */
export function listSections(target: SectionTarget): string[] {
  const body = fetchBody(target);
  return parseSections(body).map(s => s.name).filter(Boolean);
}

/**
 * Read a single named section from a PR or issue body.
 * Returns the section content (including ## header), or null if not found.
 */
export function readSection(target: SectionTarget, sectionName: string): string | null {
  const body = fetchBody(target);
  const section = parseSections(body).find(s => s.name === sectionName);
  return section?.content ?? null;
}

/**
 * Add a new named section to the end of a PR or issue body.
 * If a section with the same name already exists, replaces it.
 */
export function addSection(target: SectionTarget, sectionName: string, content: string): void {
  const body = fetchBody(target);
  const sections = parseSections(body);
  const existing = sections.find(s => s.name === sectionName);

  const sectionText = `## ${sectionName}\n\n${content}`;

  if (existing) {
    // Replace existing section
    const newBody = body.slice(0, existing.startOffset) + sectionText + '\n\n' + body.slice(existing.endOffset);
    writeBody(target, newBody.replace(/\n{3,}/g, '\n\n').trimEnd());
  } else {
    // Append new section
    const newBody = body.trimEnd() + '\n\n' + sectionText;
    writeBody(target, newBody.trimEnd());
  }
}

/**
 * Replace the content of an existing named section.
 * Throws if the section doesn't exist (use addSection for upsert).
 */
export function replaceSection(target: SectionTarget, sectionName: string, content: string): void {
  const body = fetchBody(target);
  const sections = parseSections(body);
  const existing = sections.find(s => s.name === sectionName);

  if (!existing) {
    throw new Error(`Section "${sectionName}" not found. Use addSection to create it.`);
  }

  const sectionText = `## ${sectionName}\n\n${content}`;
  const newBody = body.slice(0, existing.startOffset) + sectionText + '\n\n' + body.slice(existing.endOffset);
  writeBody(target, newBody.replace(/\n{3,}/g, '\n\n').trimEnd());
}

/**
 * Remove a named section from a PR or issue body.
 * No-op if the section doesn't exist.
 */
export function removeSection(target: SectionTarget, sectionName: string): void {
  const body = fetchBody(target);
  const sections = parseSections(body);
  const existing = sections.find(s => s.name === sectionName);
  if (!existing) return;

  const newBody = (body.slice(0, existing.startOffset) + body.slice(existing.endOffset))
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
  writeBody(target, newBody);
}

// ── Attachments (named marker comments on issues) ──────────────────

export interface AttachmentTarget {
  /** Issue number */
  issueNum: string;
  /** GitHub repo (owner/repo) */
  repo: string;
}

export interface Attachment {
  /** The attachment name (from marker: <!-- kaizen:<name> -->) */
  name: string;
  /** The content after the marker line */
  content: string;
  /** GitHub comment URL */
  url: string;
  /** Comment ID (for targeted editing) */
  commentId: string;
}

const MARKER_RE = /^<!-- kaizen:(\S+) -->/;

/** Extract comment ID from GitHub URL (#issuecomment-123 → 123) */
function extractCommentId(url: string): string {
  return url.match(/#issuecomment-(\d+)/)?.[1] ?? '';
}

/** Fetch all comments on an issue as compact JSON lines. */
function fetchComments(target: AttachmentTarget): Array<{ url: string; body: string }> {
  try {
    const raw = gh([
      'issue', 'view', target.issueNum, '--repo', target.repo,
      '--json', 'comments',
      '--jq', '.comments[] | {url: .url, body: .body} | @json',
    ]);
    if (!raw) return [];
    const results: Array<{ url: string; body: string }> = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { results.push(JSON.parse(line)); } catch { continue; }
    }
    return results;
  } catch { return []; }
}

/**
 * List all kaizen attachments on an issue.
 * Returns attachment names (from <!-- kaizen:<name> --> markers).
 */
export function listAttachments(target: AttachmentTarget): string[] {
  const names: string[] = [];
  for (const c of fetchComments(target)) {
    const match = c.body.match(MARKER_RE);
    if (match) names.push(match[1]);
  }
  return names;
}

/**
 * Read a named attachment from an issue.
 * Returns the content after the marker line, or null if not found.
 */
export function readAttachment(target: AttachmentTarget, name: string): Attachment | null {
  const marker = `<!-- kaizen:${name} -->`;
  for (const c of fetchComments(target)) {
    if (c.body.includes(marker)) {
      const content = c.body.replace(marker, '').trim();
      return {
        name,
        content,
        url: c.url,
        commentId: extractCommentId(c.url),
      };
    }
  }
  return null;
}

/**
 * Write a named attachment on an issue.
 * Creates a new comment if the attachment doesn't exist, or updates the existing one by ID.
 */
export function writeAttachment(target: AttachmentTarget, name: string, content: string): string {
  const marker = `<!-- kaizen:${name} -->`;
  const body = `${marker}\n${content}`;
  const existing = readAttachment(target, name);

  if (existing && existing.commentId) {
    gh(['api', '--method', 'PATCH', `/repos/${target.repo}/issues/comments/${existing.commentId}`, '-f', `body=${body}`]);
    return existing.url;
  }
  return gh(['issue', 'comment', target.issueNum, '--repo', target.repo, '--body', body]);
}

/**
 * Remove a named attachment from an issue.
 * Deletes the comment entirely. No-op if not found.
 */
export function removeAttachment(target: AttachmentTarget, name: string): void {
  const existing = readAttachment(target, name);
  if (!existing || !existing.commentId) return;
  try {
    gh(['api', '--method', 'DELETE', `/repos/${target.repo}/issues/comments/${existing.commentId}`]);
  } catch { /* best effort */ }
}
