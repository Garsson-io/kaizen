export interface MarkdownFence {
  language: string;
  code: string;
}

const FENCE_RE = /^```([^\r\n`]*)\r?\n([\s\S]*?)\r?\n```(?=\r?\n|$)/gm;

function normalizeLanguage(language: string): string {
  return language.trim().toLowerCase();
}

function languageMatches(actual: string, expected?: string | string[]): boolean {
  if (expected == null) return true;
  const accepted = Array.isArray(expected) ? expected : [expected];
  const normalized = normalizeLanguage(actual);
  return accepted.some(language => normalizeLanguage(language) === normalized);
}

export function markdownFences(text: string, language?: string | string[]): MarkdownFence[] {
  const blocks: MarkdownFence[] = [];
  for (const match of text.matchAll(FENCE_RE)) {
    const rawLanguage = match[1].trim();
    if (!languageMatches(rawLanguage, language)) continue;
    blocks.push({ language: rawLanguage, code: match[2].trim() });
  }
  return blocks;
}

export function firstMarkdownFence(text: string, language?: string | string[]): MarkdownFence | null {
  return markdownFences(text, language)[0] ?? null;
}
