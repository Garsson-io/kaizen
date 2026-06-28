/**
 * Shared Codex provider helpers.
 *
 * Builds the subscription-CLI Codex argv and parses Codex JSONL into
 * text/marker evidence that agent-spawn and auto-dent consumers share.
 */

import { parseJsonLinesWithMalformedRows } from './lib/json-lines.js';

export interface ParsedCodexJsonl {
  events: unknown[];
  text: string;
  finalText: string;
  malformedLines: string[];
}

export type AutoDentStreamMessage = Record<string, any>;

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

function textFrom(value: unknown): string {
  const chunks: string[] = [];
  collectText(value, chunks);
  return chunks.join('\n');
}

function assistantText(text: string): AutoDentStreamMessage {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
    },
  };
}

function resultText(text: string): AutoDentStreamMessage {
  return {
    type: 'result',
    subtype: 'success',
    result: text,
  };
}

export function normalizeCodexFinalTextToStreamMessages(text: string): AutoDentStreamMessage[] {
  return text ? [resultText(text)] : [];
}

function extractPullRequestUrl(text: string): string | undefined {
  return text.match(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/)?.[0];
}

/**
 * Normalize provider-specific Codex JSONL rows into the same stream-json shape
 * that auto-dent's stream processor already consumes for Claude.
 */
export function normalizeCodexEventToStreamMessages(event: unknown): AutoDentStreamMessage[] {
  if (!event || typeof event !== 'object') return [];

  const obj = event as Record<string, unknown>;
  const item = obj.item;
  if (item && typeof item === 'object') {
    const itemObj = item as Record<string, unknown>;
    if (itemObj.type === 'agent_message') {
      const text = textFrom(itemObj.text);
      return text ? [assistantText(text)] : [];
    }

    if (itemObj.type === 'command_execution') {
      const messages: AutoDentStreamMessage[] = [];
      const command = typeof itemObj.command === 'string' ? itemObj.command : '';
      if (command) {
        messages.push({
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              name: 'Bash',
              input: { command },
            }],
          },
        });
      }

      const output = textFrom(itemObj.aggregated_output ?? itemObj.output);
      if (output) {
        const toolResult: AutoDentStreamMessage = {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', content: output }],
          },
        };
        const prUrl = extractPullRequestUrl(output);
        if (prUrl) {
          toolResult.tool_use_result = {
            gitOperation: {
              pr: {
                action: 'created',
                url: prUrl,
              },
            },
          };
        }
        messages.push(toolResult);
      }

      return messages;
    }
  }

  if (!isFinalEvent(event)) return [];
  const text = textFrom(event);
  return normalizeCodexFinalTextToStreamMessages(text);
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
