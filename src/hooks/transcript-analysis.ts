/**
 * transcript-analysis.ts — Analyze Claude Code session transcripts for
 * reflection signals.
 *
 * Reads a JSONL transcript and identifies:
 * 1. User corrections / pushback
 * 2. Failed tool calls / retries
 * 3. Hook denials (near-misses caught by L2)
 * 4. Multiple attempts at the same thing
 * 5. Things the user had to ask for twice
 *
 * Part of kaizen #438 — Reflection subagent transcript analysis.
 */

import { readFileSync } from 'node:fs';

// ── Types ──

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

interface TranscriptEntry {
  type: string;
  message?: {
    role: string;
    content: ContentBlock[] | string;
  };
  [key: string]: unknown;
}

export interface Signal {
  type:
    | 'user_correction'
    | 'failed_tool_call'
    | 'hook_denial'
    | 'retry'
    | 'repeated_request';
  description: string;
  evidence: string;
}

export interface TranscriptAnalysis {
  signals: Signal[];
  summary: {
    totalEntries: number;
    userMessages: number;
    toolCalls: number;
    failedToolCalls: number;
    userCorrections: number;
    hookDenials: number;
    retries: number;
    repeatedRequests: number;
  };
}

// ── Correction detection patterns ──

const CORRECTION_PATTERNS = [
  /\bno[,.]?\s+(don'?t|not|stop|wrong)/i,
  /\bthat'?s\s+(not|wrong|incorrect)/i,
  /\byou'?re\s+(leaning|going)\s+(in\s+the\s+)?wrong/i,
  /\bdon'?t\s+(do|make|add|change|remove|delete|refactor|rewrite)/i,
  /\bstop\s+(doing|adding|changing)/i,
  /\byou\s+didn'?t\s+(actually|really)/i,
  /\bi\s+(already\s+)?asked\s+(you\s+)?(about\s+)?that/i,
  /\bi\s+said/i,
  /\bnot\s+what\s+i\s+(asked|meant|wanted)/i,
  /\bplease\s+(just|actually|really)/i,
];

/** Check if a user message is a correction/pushback. */
function isCorrection(text: string): boolean {
  return CORRECTION_PATTERNS.some((p) => p.test(text));
}

// ── Hook denial patterns ──
// These patterns only apply to tool_result entries that are errors (is_error: true)
// or from Bash tool calls. Reading a file that mentions "enforce-*.sh" is not a denial.

const HOOK_DENIAL_PATTERNS = [
  /^BLOCKED:/m,
  /^STOP BLOCKED:/m,
  /blocked\s+by\s+hook/i,
  /Cannot\s+commit\s+outside\s+worktree/i,
  /pre-commit\s+hook\s+failed/i,
  /GATED\s+until/i,
];

/** Check if a tool result indicates a hook denial. Only meaningful for error results. */
function isHookDenial(content: string): boolean {
  return HOOK_DENIAL_PATTERNS.some((p) => p.test(content));
}

// ── Retry detection ──

/** Detect sequential calls to the same tool with similar input. */
function detectRetries(
  toolCalls: Array<{ name: string; input: string; succeeded: boolean }>,
): Signal[] {
  const signals: Signal[] = [];
  for (let i = 1; i < toolCalls.length; i++) {
    const prev = toolCalls[i - 1];
    const curr = toolCalls[i];
    if (
      prev.name === curr.name &&
      !prev.succeeded &&
      prev.name === 'Bash' &&
      similarCommands(prev.input, curr.input)
    ) {
      signals.push({
        type: 'retry',
        description: `Retried ${curr.name} after failure`,
        evidence: `Previous: ${truncate(prev.input, 100)} | Current: ${truncate(curr.input, 100)}`,
      });
    }
  }
  return signals;
}

/** Check if two bash commands are similar (same base command). */
function similarCommands(a: string, b: string): boolean {
  const baseA = a.split(/\s+/).slice(0, 2).join(' ');
  const baseB = b.split(/\s+/).slice(0, 2).join(' ');
  return baseA === baseB;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '...';
}

// ── Repeated request detection ──

/** Detect user messages that reference something asked before. */
function detectRepeatedRequests(userMessages: string[]): Signal[] {
  const signals: Signal[] = [];
  for (let i = 1; i < userMessages.length; i++) {
    const msg = userMessages[i];
    if (
      /\b(earlier|before|already|again|i\s+asked)\b/i.test(msg) &&
      /\b(asked|said|mentioned|requested)\b/i.test(msg)
    ) {
      signals.push({
        type: 'repeated_request',
        description: 'User referenced a previous request that was not addressed',
        evidence: truncate(msg, 200),
      });
    }
  }
  return signals;
}

// ── Main analysis ──

/** Parse a JSONL transcript into entries. */
export function parseTranscript(content: string): TranscriptEntry[] {
  return content
    .trim()
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as TranscriptEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is TranscriptEntry => e !== null);
}

/** Read and parse a transcript file. */
export function readTranscript(filePath: string): TranscriptEntry[] {
  const content = readFileSync(filePath, 'utf-8');
  return parseTranscript(content);
}

/** Analyze a transcript for reflection signals. */
export function analyzeTranscript(entries: TranscriptEntry[]): TranscriptAnalysis {
  const signals: Signal[] = [];
  const userMessages: string[] = [];
  const toolCalls: Array<{ name: string; input: string; succeeded: boolean }> =
    [];
  let failedToolCalls = 0;
  let userCorrections = 0;
  let hookDenials = 0;
  let totalToolCalls = 0;
  let userMessageCount = 0;

  for (const entry of entries) {
    if (!entry.message?.content) continue;
    const content = Array.isArray(entry.message.content)
      ? entry.message.content
      : [];

    if (entry.type === 'user') {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          userMessageCount++;
          userMessages.push(block.text);

          if (isCorrection(block.text)) {
            userCorrections++;
            signals.push({
              type: 'user_correction',
              description: 'User corrected or pushed back on agent approach',
              evidence: truncate(block.text, 200),
            });
          }
        }

        if (block.type === 'tool_result') {
          const resultContent = block.content ?? '';

          if (block.is_error) {
            failedToolCalls++;
            signals.push({
              type: 'failed_tool_call',
              description: 'Tool call failed',
              evidence: truncate(resultContent, 200),
            });

            // Only check for hook denials on error results — successful tool
            // results (e.g., Read returning file contents) may mention hooks
            // without being actual denials.
            if (isHookDenial(resultContent)) {
              hookDenials++;
              signals.push({
                type: 'hook_denial',
                description: 'Hook blocked an action (near-miss caught by L2)',
                evidence: truncate(resultContent, 200),
              });
            }
          }

          // Record for retry detection
          if (toolCalls.length > 0) {
            const lastCall = toolCalls[toolCalls.length - 1];
            lastCall.succeeded = !block.is_error;
          }
        }
      }
    }

    if (entry.type === 'assistant') {
      for (const block of content) {
        if (block.type === 'tool_use' && block.name) {
          totalToolCalls++;
          const input =
            block.name === 'Bash'
              ? (block.input?.command as string) ?? ''
              : JSON.stringify(block.input ?? {});
          toolCalls.push({ name: block.name, input, succeeded: true });
        }
      }
    }
  }

  // Detect retries and repeated requests
  signals.push(...detectRetries(toolCalls));
  signals.push(...detectRepeatedRequests(userMessages));

  return {
    signals,
    summary: {
      totalEntries: entries.length,
      userMessages: userMessageCount,
      toolCalls: totalToolCalls,
      failedToolCalls,
      userCorrections,
      hookDenials,
      retries: signals.filter((s) => s.type === 'retry').length,
      repeatedRequests: signals.filter((s) => s.type === 'repeated_request')
        .length,
    },
  };
}

/** Read and analyze a transcript file. Returns the analysis. */
export function analyzeTranscriptFile(
  filePath: string,
): TranscriptAnalysis {
  const entries = readTranscript(filePath);
  return analyzeTranscript(entries);
}

/** Format analysis as a human-readable summary for the kaizen-bg agent. */
export function formatAnalysisSummary(analysis: TranscriptAnalysis): string {
  const { signals, summary } = analysis;
  const lines: string[] = [];

  lines.push('## Transcript Analysis Summary');
  lines.push('');
  lines.push(
    `Analyzed ${summary.totalEntries} entries: ${summary.userMessages} user messages, ${summary.toolCalls} tool calls`,
  );
  lines.push('');

  if (signals.length === 0) {
    lines.push('No signals detected — clean session.');
    return lines.join('\n');
  }

  lines.push(`**${signals.length} signals detected:**`);
  lines.push('');

  const byType = new Map<string, Signal[]>();
  for (const signal of signals) {
    const existing = byType.get(signal.type) ?? [];
    existing.push(signal);
    byType.set(signal.type, existing);
  }

  for (const [type, typeSignals] of byType) {
    lines.push(`### ${type} (${typeSignals.length})`);
    for (const signal of typeSignals) {
      lines.push(`- ${signal.description}`);
      lines.push(`  Evidence: ${signal.evidence}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
