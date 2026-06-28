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
import { truncateAfterPrefix } from './analysis/util.js';
import { parseJsonLines } from './lib/json-lines.js';

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
    | 'repeated_request'
    | 'context_growth'
    | 'missing_subagent';
  description: string;
  evidence: string;
  entryIndex: number;
  role?: string;
  toolName?: string;
}

interface TranscriptAnalysis {
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
    contextGrowthEvents: number;
    missingSubagentPatterns: number;
  };
}

export type FrictionCategory =
  | 'cli_fumble'
  | 'gate_reconciliation'
  | 'context_growth'
  | 'missing_subagent'
  | 'user_correction';

export interface TranscriptMoment {
  entryIndex: number;
  excerpt: string;
  role?: string;
  toolName?: string;
}

export interface FrictionCandidateSource {
  repo?: string;
  pr?: string;
  issue?: string;
  attachment?: string;
  url?: string;
}

export interface FrictionCandidate {
  category: FrictionCategory;
  title: string;
  summary: string;
  count: number;
  severity: 'low' | 'medium' | 'high';
  source?: FrictionCandidateSource;
  moments: TranscriptMoment[];
}

export interface FrictionCandidateReport {
  generatedAt: string;
  sources: FrictionCandidateSource[];
  candidates: FrictionCandidate[];
  summary: TranscriptAnalysis['summary'];
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

const CONTEXT_GROWTH_PATTERNS = [
  /\bcontext\s+(compaction|window|growth|transition)\b/i,
  /\bre-?read(?:ing)?\b/i,
  /\bread\s+(the\s+)?(issue|plan|source|files?)\s+again\b/i,
  /\btoo\s+much\s+context\b/i,
];

function isContextGrowthEvent(text: string): boolean {
  return CONTEXT_GROWTH_PATTERNS.some((p) => p.test(text));
}

const MISSING_SUBAGENT_PATTERNS = [
  /\bmissing\s+sub-?agent\b/i,
  /\bsub-?agent\b.*\b(not\s+available|unavailable|failed|missing|skipped)\b/i,
  /\bshould\s+have\s+used\s+(a\s+)?sub-?agent\b/i,
];

function isMissingSubagentPattern(text: string): boolean {
  return MISSING_SUBAGENT_PATTERNS.some((p) => p.test(text));
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
  toolCalls: Array<{
    name: string;
    input: string;
    succeeded: boolean;
    entryIndex: number;
    resultEntryIndex?: number;
    resultExcerpt?: string;
  }>,
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
        evidence: prev.resultExcerpt
          ? `Previous failure: ${prev.resultExcerpt} | Current: ${truncateAfterPrefix(curr.input, 100)}`
          : `Previous: ${truncateAfterPrefix(prev.input, 100)} | Current: ${truncateAfterPrefix(curr.input, 100)}`,
        entryIndex: prev.resultEntryIndex ?? curr.entryIndex,
        role: 'tool',
        toolName: curr.name,
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
        evidence: truncateAfterPrefix(msg, 200),
        entryIndex: i,
        role: 'user',
      });
    }
  }
  return signals;
}

// ── Main analysis ──

/** Parse a JSONL transcript into entries. */
export function parseTranscript(content: string): TranscriptEntry[] {
  return parseJsonLines<TranscriptEntry>(content);
}

/** Read and parse a transcript file. */
function readTranscript(filePath: string): TranscriptEntry[] {
  const content = readFileSync(filePath, 'utf-8');
  return parseTranscript(content);
}

/** Analyze a transcript for reflection signals. */
export function analyzeTranscript(entries: TranscriptEntry[]): TranscriptAnalysis {
  const signals: Signal[] = [];
  const userMessages: string[] = [];
  const toolCalls: Array<{
    name: string;
    input: string;
    succeeded: boolean;
    entryIndex: number;
    resultEntryIndex?: number;
    resultExcerpt?: string;
  }> = [];
  let failedToolCalls = 0;
  let userCorrections = 0;
  let hookDenials = 0;
  let totalToolCalls = 0;
  let userMessageCount = 0;
  let contextGrowthEvents = 0;
  let missingSubagentPatterns = 0;

  for (const [entryIndex, entry] of entries.entries()) {
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
              evidence: truncateAfterPrefix(block.text, 200),
              entryIndex,
              role: 'user',
            });
          }

          if (isContextGrowthEvent(block.text)) {
            contextGrowthEvents++;
            signals.push({
              type: 'context_growth',
              description: 'Transcript shows context growth or re-read overhead',
              evidence: truncateAfterPrefix(block.text, 200),
              entryIndex,
              role: 'user',
            });
          }

          if (isMissingSubagentPattern(block.text)) {
            missingSubagentPatterns++;
            signals.push({
              type: 'missing_subagent',
              description: 'Transcript references missing or skipped subagent use',
              evidence: truncateAfterPrefix(block.text, 200),
              entryIndex,
              role: 'user',
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
              evidence: truncateAfterPrefix(resultContent, 200),
              entryIndex,
              role: 'tool',
              toolName: toolCalls[toolCalls.length - 1]?.name,
            });

            // Only check for hook denials on error results — successful tool
            // results (e.g., Read returning file contents) may mention hooks
            // without being actual denials.
            if (isHookDenial(resultContent)) {
              hookDenials++;
              signals.push({
                type: 'hook_denial',
                description: 'Hook blocked an action (near-miss caught by L2)',
                evidence: truncateAfterPrefix(resultContent, 200),
                entryIndex,
                role: 'tool',
                toolName: toolCalls[toolCalls.length - 1]?.name,
              });
            }
          }

          // Record for retry detection
          if (toolCalls.length > 0) {
            const lastCall = toolCalls[toolCalls.length - 1];
            lastCall.succeeded = !block.is_error;
            lastCall.resultEntryIndex = entryIndex;
            lastCall.resultExcerpt = truncateAfterPrefix(resultContent, 200);
          }
        }
      }
    }

    if (entry.type === 'assistant') {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          if (isContextGrowthEvent(block.text)) {
            contextGrowthEvents++;
            signals.push({
              type: 'context_growth',
              description: 'Transcript shows context growth or re-read overhead',
              evidence: truncateAfterPrefix(block.text, 200),
              entryIndex,
              role: 'assistant',
            });
          }

          if (isMissingSubagentPattern(block.text)) {
            missingSubagentPatterns++;
            signals.push({
              type: 'missing_subagent',
              description: 'Transcript references missing or skipped subagent use',
              evidence: truncateAfterPrefix(block.text, 200),
              entryIndex,
              role: 'assistant',
            });
          }
        }

        if (block.type === 'tool_use' && block.name) {
          totalToolCalls++;
          const input =
            block.name === 'Bash'
              ? (block.input?.command as string) ?? ''
              : JSON.stringify(block.input ?? {});
          toolCalls.push({ name: block.name, input, succeeded: true, entryIndex });
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
      contextGrowthEvents,
      missingSubagentPatterns,
    },
  };
}

function candidateCategory(signal: Signal): FrictionCategory {
  switch (signal.type) {
    case 'failed_tool_call':
    case 'retry':
      return 'cli_fumble';
    case 'hook_denial':
      return 'gate_reconciliation';
    case 'context_growth':
      return 'context_growth';
    case 'missing_subagent':
      return 'missing_subagent';
    case 'user_correction':
    case 'repeated_request':
      return 'user_correction';
  }
}

function candidateTitle(signal: Signal): string {
  switch (signal.type) {
    case 'failed_tool_call':
      return 'Tool call failed';
    case 'retry':
      return 'Repeated failed Bash command';
    case 'hook_denial':
      return 'Hook blocked action during workflow';
    case 'context_growth':
      return 'Context growth or re-read overhead';
    case 'missing_subagent':
      return 'Missing or skipped subagent pattern';
    case 'user_correction':
      return 'User correction or pushback';
    case 'repeated_request':
      return 'Repeated user request';
  }
}

function severityFor(signal: Signal): FrictionCandidate['severity'] {
  if (signal.type === 'hook_denial' || signal.type === 'user_correction') return 'high';
  if (signal.type === 'failed_tool_call' || signal.type === 'retry') return 'medium';
  return 'low';
}

function sourceKey(source?: FrictionCandidateSource): string {
  return [
    source?.repo ?? '',
    source?.pr ?? '',
    source?.issue ?? '',
    source?.attachment ?? '',
  ].join('|');
}

export function mineFrictionCandidates(
  entries: TranscriptEntry[],
  source?: FrictionCandidateSource,
  generatedAt = new Date().toISOString(),
): FrictionCandidateReport {
  const analysis = analyzeTranscript(entries);
  const candidates = new Map<string, FrictionCandidate>();

  for (const signal of analysis.signals) {
    const category = candidateCategory(signal);
    const title = candidateTitle(signal);
    const key = `${sourceKey(source)}|${category}|${title}`;
    const moment: TranscriptMoment = {
      entryIndex: signal.entryIndex,
      excerpt: signal.evidence,
      role: signal.role,
      toolName: signal.toolName,
    };
    const existing = candidates.get(key);
    if (existing) {
      existing.count++;
      existing.moments.push(moment);
      if (severityFor(signal) === 'high') existing.severity = 'high';
      continue;
    }
    candidates.set(key, {
      category,
      title,
      summary: signal.description,
      count: 1,
      severity: severityFor(signal),
      source,
      moments: [moment],
    });
  }

  return {
    generatedAt,
    sources: source ? [source] : [],
    candidates: [...candidates.values()],
    summary: analysis.summary,
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
