/**
 * Shared Codex provider helpers.
 *
 * Builds the subscription-CLI Codex argv and parses Codex JSONL into
 * text/marker evidence that agent-spawn and auto-dent consumers share.
 */

import { parseJsonLinesWithMalformedRows } from './lib/json-lines.js';
import { formatPhaseMarkerLine, parsePhaseMarkers } from './phase-marker.js';

export interface ParsedCodexJsonl {
  events: unknown[];
  text: string;
  finalText: string;
  malformedLines: string[];
}

export type AutoDentStreamMessage = Record<string, any>;

export interface CodexExecArgsOptions {
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  bypassApprovalsAndSandbox?: boolean;
}

export interface CodexRunAssessment {
  malformedLineCount: number;
  hasTerminalEvent: boolean;
  hasFailedTerminalEvent: boolean;
  failureNotes: string[];
}

export function buildCodexExecArgs(repoRoot: string, opts: CodexExecArgsOptions = {}): string[] {
  const sandbox = opts.sandbox ?? 'danger-full-access';
  const args = [
    'exec',
    '--json',
    '--cd',
    repoRoot,
    '--sandbox',
    sandbox,
  ];
  if (opts.bypassApprovalsAndSandbox ?? (sandbox === 'danger-full-access')) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }
  args.push(
    '--color',
    'never',
    '-',
  );
  return args;
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

export function isCodexTerminalEvent(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false;
  const type = String((event as Record<string, unknown>).type ?? '').toLowerCase();
  return (
    type.includes('final') ||
    type === 'result' ||
    type === 'turn.completed' ||
    type === 'turn.failed'
  );
}

export function isCodexFailedTerminalEvent(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false;
  const type = String((event as Record<string, unknown>).type ?? '').toLowerCase();
  return type === 'turn.failed';
}

export function hasCodexTerminalEvent(parsed: ParsedCodexJsonl): boolean {
  return parsed.events.some(isCodexTerminalEvent);
}

export function hasCodexFailedTerminalEvent(parsed: ParsedCodexJsonl): boolean {
  return parsed.events.some(isCodexFailedTerminalEvent);
}

export function assessCodexRun(parsed: ParsedCodexJsonl): CodexRunAssessment {
  const malformedLineCount = parsed.malformedLines.length;
  const hasTerminalEvent = hasCodexTerminalEvent(parsed);
  const hasFailedTerminalEvent = hasCodexFailedTerminalEvent(parsed);
  const failureNotes = [
    ...(malformedLineCount > 0 ? [`malformed codex jsonl lines: ${malformedLineCount}`] : []),
    ...(!hasTerminalEvent ? ['missing codex terminal event'] : []),
    ...(hasFailedTerminalEvent ? ['codex turn failed'] : []),
  ];
  return { malformedLineCount, hasTerminalEvent, hasFailedTerminalEvent, failureNotes };
}

export function normalizeCodexProcessExitCode(exitCode: number, assessment: CodexRunAssessment): number {
  if (assessment.failureNotes.length > 0 && exitCode === 0) return 1;
  return exitCode;
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

  if (!isCodexTerminalEvent(event)) return [];
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
    if (isCodexTerminalEvent(event)) finalChunks.push(...chunks);
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
  const seen = new Set<string>();
  const markers: string[] = [];
  for (const marker of parsePhaseMarkers([parsed.text, parsed.finalText].join('\n'))) {
    const line = formatPhaseMarkerLine(marker.phase, marker.fields);
    if (seen.has(line)) continue;
    seen.add(line);
    markers.push(line);
  }
  return markers;
}
