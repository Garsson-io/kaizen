import YAML from 'yaml';

export interface DelimitedYamlBlock<T extends Record<string, unknown> = Record<string, unknown>> {
  data: T;
  raw: string;
}

export interface LeadingDelimitedYamlBlock<T extends Record<string, unknown> = Record<string, unknown>>
  extends DelimitedYamlBlock<T> {
  body: string;
}

const LEADING_DELIMITED_YAML_BLOCK_RE = /^(---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?)([\s\S]*)$/;
const DELIMITED_YAML_BLOCK_RE = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/gm;

function parseYamlObject<T extends Record<string, unknown>>(yaml: string): T | null {
  try {
    const parsed = YAML.parse(yaml);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as T;
  } catch {
    return null;
  }
}

export function formatDelimitedYamlBlock(data: Record<string, unknown>): string {
  return `---\n${YAML.stringify(data).trimEnd()}\n---\n`;
}

export function parseLeadingDelimitedYamlBlock<
  T extends Record<string, unknown> = Record<string, unknown>,
>(content: string): LeadingDelimitedYamlBlock<T> | null {
  const match = content.match(LEADING_DELIMITED_YAML_BLOCK_RE);
  if (!match) return null;

  const data = parseYamlObject<T>(match[2]);
  if (!data) return null;
  return { data, raw: match[1], body: match[3] ?? '' };
}

export function hasLeadingDelimitedYamlBlock(content: string): boolean {
  return LEADING_DELIMITED_YAML_BLOCK_RE.test(content);
}

export function parseFirstDelimitedYamlBlock<
  T extends Record<string, unknown> = Record<string, unknown>,
>(text: string): DelimitedYamlBlock<T> | null {
  DELIMITED_YAML_BLOCK_RE.lastIndex = 0;
  const match = DELIMITED_YAML_BLOCK_RE.exec(text);
  DELIMITED_YAML_BLOCK_RE.lastIndex = 0;
  if (!match) return null;

  const data = parseYamlObject<T>(match[1]);
  if (!data) return null;
  return { data, raw: match[0] };
}

export function parseDelimitedYamlBlocks<
  T extends Record<string, unknown> = Record<string, unknown>,
>(text: string): Array<DelimitedYamlBlock<T>> {
  const blocks: Array<DelimitedYamlBlock<T>> = [];
  DELIMITED_YAML_BLOCK_RE.lastIndex = 0;
  for (const match of text.matchAll(DELIMITED_YAML_BLOCK_RE)) {
    const data = parseYamlObject<T>(match[1]);
    if (data) blocks.push({ data, raw: match[0] });
  }
  DELIMITED_YAML_BLOCK_RE.lastIndex = 0;
  return blocks;
}
