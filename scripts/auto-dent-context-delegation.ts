import { analyzeTranscript, parseTranscript } from '../src/transcript-analysis.js';
import { parseJsonLines } from '../src/lib/json-lines.js';
import type { RunProgressStep } from './auto-dent-progress.js';

export const DEFAULT_CONTEXT_DELEGATION_SUBSTEPS = [
  'broad code search',
  'multi-file summarization',
  'independent investigations',
  'review dimensions',
  'related-area DRY/dead-code sweeps',
] as const;

export interface ContextDelegationThresholds {
  mainThreadToolCalls: number;
  discoveryToolCalls: number;
}

export const DEFAULT_CONTEXT_DELEGATION_THRESHOLDS: ContextDelegationThresholds = {
  mainThreadToolCalls: 12,
  discoveryToolCalls: 10,
};

export interface ContextDelegationPressure {
  required: boolean;
  reasons: string[];
  recommendedSubsteps: string[];
  mainThreadToolCalls: number;
  discoveryToolCalls: number;
  contextGrowthEvents: number;
  missingSubagentPatterns: number;
  repeatedReads: number;
  repeatedSearches: number;
}

export interface ObservedContextDelegation {
  observed: boolean;
  evidence?: string;
  toolName?: string;
}

export interface ContextDelegationAnalysis {
  pressure: ContextDelegationPressure;
  delegation: ObservedContextDelegation;
}

interface ToolUse {
  name: string;
  input: Record<string, unknown>;
  beforeImplementation: boolean;
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface StreamMessage {
  type?: string;
  message?: {
    content?: ContentBlock[] | string;
  };
}

const DISCOVERY_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const IMPLEMENTATION_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'EnterWorktree']);
const DELEGATION_TOOLS = new Set(['Agent', 'TaskCreate']);

function formatSubstepList(substeps: readonly string[]): string {
  if (substeps.length <= 1) return substeps.join('');
  return `${substeps.slice(0, -1).join(', ')}, and ${substeps[substeps.length - 1]}`;
}

export function renderContextDelegationPolicy(): string {
  const substeps = formatSubstepList(DEFAULT_CONTEXT_DELEGATION_SUBSTEPS);
  return [
    `For broad/context-heavy work, fan out ${substeps} to subagents before continuing implementation.`,
    'Emit AUTO_DENT_PHASE: DELEGATE | status=done | evidence=<what was delegated> when those sub-steps are delegated; emit status=not-applicable only for genuinely narrow work.',
  ].join(' ');
}

function asContentBlocks(content: ContentBlock[] | string | undefined): ContentBlock[] {
  return Array.isArray(content) ? content : [];
}

function toolSummary(tool: ToolUse): string {
  if (tool.name === 'Read') return String(tool.input.file_path ?? '');
  if (tool.name === 'Grep') return [tool.input.pattern, tool.input.glob].filter(Boolean).join(' ');
  if (tool.name === 'Glob') return String(tool.input.pattern ?? '');
  return JSON.stringify(tool.input ?? {});
}

function countRepeated(tools: ToolUse[], names: Set<string>): number {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    if (!names.has(tool.name)) continue;
    const summary = toolSummary(tool);
    counts.set(summary, (counts.get(summary) ?? 0) + 1);
  }
  return [...counts.values()].filter((count) => count >= 3).length;
}

function extractToolUses(logText: string): ToolUse[] {
  const tools: ToolUse[] = [];
  let implementationStarted = false;

  for (const msg of parseJsonLines<StreamMessage>(logText)) {
    if (!msg.message) continue;
    for (const block of asContentBlocks(msg.message.content)) {
      if (block.type === 'text' && block.text) {
        if (/^AUTO_DENT_PHASE:\s*(IMPLEMENT|TEST|PR|MERGE)\b/m.test(block.text)) {
          implementationStarted = true;
        }
      }
      if (block.type !== 'tool_use' || !block.name) continue;
      const input = block.input ?? {};
      tools.push({
        name: block.name,
        input,
        beforeImplementation: !implementationStarted,
      });
      if (IMPLEMENTATION_TOOLS.has(block.name)) {
        implementationStarted = true;
      }
    }
  }

  return tools;
}

function observedDelegation(tools: ToolUse[]): ObservedContextDelegation {
  const delegated = tools.find((tool) =>
    tool.beforeImplementation && DELEGATION_TOOLS.has(tool.name),
  );
  if (!delegated) return { observed: false };
  const description =
    delegated.input.description ??
    delegated.input.subject ??
    delegated.input.prompt ??
    'context-heavy sub-work to subagent';
  return {
    observed: true,
    evidence: `delegated ${String(description)}`,
    toolName: delegated.name,
  };
}

function addRecommended(set: Set<string>, substep: typeof DEFAULT_CONTEXT_DELEGATION_SUBSTEPS[number]): void {
  set.add(substep);
}

export function analyzeContextDelegation(
  logText: string,
  thresholds: ContextDelegationThresholds = DEFAULT_CONTEXT_DELEGATION_THRESHOLDS,
): ContextDelegationAnalysis {
  const transcript = analyzeTranscript(parseTranscript(logText));
  const tools = extractToolUses(logText);
  const mainThreadTools = tools.filter((tool) => !DELEGATION_TOOLS.has(tool.name));
  const discoveryTools = mainThreadTools.filter((tool) => DISCOVERY_TOOLS.has(tool.name));
  const repeatedReads = countRepeated(mainThreadTools, new Set(['Read']));
  const repeatedSearches = countRepeated(mainThreadTools, new Set(['Grep', 'Glob']));
  const reasons: string[] = [];
  const recommended = new Set<string>();

  if (transcript.summary.contextGrowthEvents > 0) {
    reasons.push(`context_growth:${transcript.summary.contextGrowthEvents}`);
    addRecommended(recommended, 'multi-file summarization');
  }
  if (transcript.summary.missingSubagentPatterns > 0) {
    reasons.push(`missing_subagent:${transcript.summary.missingSubagentPatterns}`);
    addRecommended(recommended, 'independent investigations');
  }
  if (mainThreadTools.length >= thresholds.mainThreadToolCalls) {
    reasons.push(`main_thread_tool_calls:${mainThreadTools.length}/${thresholds.mainThreadToolCalls}`);
  }
  if (discoveryTools.length >= thresholds.discoveryToolCalls) {
    reasons.push(`main_thread_discovery:${discoveryTools.length}/${thresholds.discoveryToolCalls}`);
  }
  if (repeatedReads > 0) {
    reasons.push(`repeated_reads:${repeatedReads}`);
    addRecommended(recommended, 'multi-file summarization');
  }
  if (repeatedSearches > 0 || tools.filter((tool) => tool.name === 'Grep' || tool.name === 'Glob').length >= 4) {
    if (repeatedSearches > 0) reasons.push(`repeated_searches:${repeatedSearches}`);
    addRecommended(recommended, 'broad code search');
  }
  if (reasons.some((reason) => reason.startsWith('main_thread_'))) {
    addRecommended(recommended, 'broad code search');
    addRecommended(recommended, 'multi-file summarization');
  }

  return {
    pressure: {
      required: reasons.length > 0,
      reasons,
      recommendedSubsteps: [...recommended],
      mainThreadToolCalls: mainThreadTools.length,
      discoveryToolCalls: discoveryTools.length,
      contextGrowthEvents: transcript.summary.contextGrowthEvents,
      missingSubagentPatterns: transcript.summary.missingSubagentPatterns,
      repeatedReads,
      repeatedSearches,
    },
    delegation: observedDelegation(tools),
  };
}

export function buildAutomaticContextDelegationStep(
  analysis: ContextDelegationAnalysis,
): RunProgressStep | undefined {
  if (!analysis.delegation.observed || !analysis.delegation.evidence) return undefined;
  return {
    phase: 'DELEGATE',
    state: 'done',
    detail: analysis.delegation.evidence,
  };
}
