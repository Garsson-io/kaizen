/**
 * auto-dent-codex — synthetic Codex provider helpers (#1144).
 *
 * This module deliberately contains no batch orchestration. It builds the
 * subscription-CLI Codex argv and parses Codex JSONL into text/marker evidence
 * that the existing auto-dent lifecycle validator can consume.
 */

import { parseJsonLinesWithMalformedRows } from '../src/lib/json-lines.js';

export interface ParsedCodexJsonl {
  events: unknown[];
  text: string;
  finalText: string;
  malformedLines: string[];
}

export function buildCodexExecArgs(repoRoot: string): string[] {
  return [
    'exec',
    '--json',
    '--cd',
    repoRoot,
    '--sandbox',
    'danger-full-access',
    '--dangerously-bypass-approvals-and-sandbox',
    '--color',
    'never',
    '-',
  ];
}

function collectText(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const obj = value as Record<string, unknown>;
  for (const key of ['text', 'message', 'content', 'output', 'final_message', 'item', 'aggregated_output']) {
    if (key in obj) collectText(obj[key], out);
  }
}

function isFinalEvent(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false;
  const type = String((event as Record<string, unknown>).type ?? '').toLowerCase();
  return type.includes('final') || type === 'result';
}

export function parseCodexJsonl(jsonl: string): ParsedCodexJsonl {
  const textChunks: string[] = [];
  const finalChunks: string[] = [];
  const agentMessages: string[] = [];
  const parsed = parseJsonLinesWithMalformedRows<unknown>(jsonl);

  for (const event of parsed.rows) {
    const chunks: string[] = [];
    collectText(event, chunks);
    textChunks.push(...chunks);
    if (isFinalEvent(event)) finalChunks.push(...chunks);
    if (!event || typeof event !== 'object') continue;
    const item = (event as Record<string, unknown>).item;
    if (item && typeof item === 'object') {
      const itemObj = item as Record<string, unknown>;
      if (itemObj.type === 'agent_message' && typeof itemObj.text === 'string') {
        agentMessages.push(itemObj.text);
      }
    }
  }

  return {
    events: parsed.rows,
    text: textChunks.join('\n'),
    finalText: finalChunks.length > 0 ? finalChunks.join('\n') : (agentMessages.at(-1) ?? ''),
    malformedLines: parsed.malformedRows,
  };
}

export function extractCodexPhaseMarkers(parsed: ParsedCodexJsonl): string[] {
  return [parsed.text, parsed.finalText]
    .join('\n')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line, index, lines) =>
      line.startsWith('AUTO_DENT_PHASE:') && lines.indexOf(line) === index,
    );
}
