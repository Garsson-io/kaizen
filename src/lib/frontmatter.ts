import { parseLeadingDelimitedYamlBlock } from './yaml-block.js';

export interface YamlFrontmatter<T extends Record<string, unknown> = Record<string, unknown>> {
  data: T;
  body: string;
}

export function parseYamlFrontmatter<T extends Record<string, unknown> = Record<string, unknown>>(
  content: string,
): YamlFrontmatter<T> | null {
  const parsed = parseLeadingDelimitedYamlBlock<T>(content);
  return parsed ? { data: parsed.data, body: parsed.body } : null;
}

export function readYamlFrontmatter<T extends Record<string, unknown> = Record<string, unknown>>(
  content: string,
): T | null {
  return parseYamlFrontmatter<T>(content)?.data ?? null;
}
