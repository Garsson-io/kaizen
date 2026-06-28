import YAML from 'yaml';

export interface YamlFrontmatter<T extends Record<string, unknown> = Record<string, unknown>> {
  data: T;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/;

export function parseYamlFrontmatter<T extends Record<string, unknown> = Record<string, unknown>>(
  content: string,
): YamlFrontmatter<T> | null {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;

  try {
    const parsed = YAML.parse(match[1]);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return { data: parsed as T, body: match[2] ?? '' };
  } catch {
    return null;
  }
}

export function readYamlFrontmatter<T extends Record<string, unknown> = Record<string, unknown>>(
  content: string,
): T | null {
  return parseYamlFrontmatter<T>(content)?.data ?? null;
}
