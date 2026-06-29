/**
 * independent-judge.ts — independence-by-spawn (#1231).
 *
 * The keystone primitive of the #1212 / proxy-acceptance (#943) cluster. Every gap in that
 * cluster is the same word — *self*: the author self-classifies the test level (#1230), the
 * loop self-certifies its own gate edit (#1212/#1227), auto-dent self-grades the run outcome
 * (#1224), the author self-reviews the PR. The antidote is identical every time: instead of
 * *self*, spawn a FRESH judge that sees ONLY the artifact + an adversarial charter, never the
 * producer's reasoning. A fresh process is not merely "more objective" — it is structurally
 * uncontaminated: there is no channel through which the producer's rationalization can reach it.
 *
 * Structural independence: `JudgeRequest` has NO field for producer context. The judge can only
 * ever receive `artifact` (+ config). Independence is enforced by the type, not by discipline.
 *
 * Spawn is the shared provider-aware primitive (src/spawn-claude.ts) — the same one the review
 * battery uses; we do not reimplement the spawn loop (DRY mandate).
 */

import { z } from 'zod';
import YAML from 'yaml';
import {
  CHARTERS,
  type Charter,
  type CharterName,
  isCharterName,
} from './judge-charters.js';
import { spawnAgent, type SpawnAgentProvider, type SpawnClaudeFn } from './spawn-claude.js';

// ── Verdict schema (I29 — Zod + YAML, no hand-rolled parsing) ─────────

export const VerdictSchema = z.enum(['pass', 'fail']);
export const ConfidenceSchema = z.enum(['low', 'medium', 'high']);

/** Shape the spawned judge is asked to emit inside a ```yaml fence. */
export const JudgeReplySchema = z.object({
  verdict: VerdictSchema,
  counterexample: z.string().nullable().optional(),
  confidence: ConfidenceSchema.optional(),
  reasoning: z.string().optional(),
});
export type JudgeReply = z.infer<typeof JudgeReplySchema>;

export interface JudgeVerdict {
  verdict: 'pass' | 'fail';
  counterexample: string | null;
  confidence: 'low' | 'medium' | 'high';
  reasoning: string;
  charter: CharterName;
  /** True when the reply could not be parsed and we defaulted to reject. */
  defaultedToReject: boolean;
  costUsd: number;
}

export interface JudgePanelResult {
  /** Aggregated panel verdict. */
  verdict: 'pass' | 'fail';
  votes: JudgeVerdict[];
  /** Non-empty counterexamples gathered from FAIL votes. */
  counterexamples: string[];
  aggregate: AggregateMode;
  totalCostUsd: number;
}

export type AggregateMode = 'any-blocks' | 'majority';

export interface JudgeRequest {
  /** The ONLY thing the judge sees. Diff, PR body, outcome stamp, file content, … */
  artifact: string;
  /**
   * Charter(s). A single name spawns `n` judges of that lens; an array spawns one judge per
   * distinct lens (diversity — the loop-until-refute pattern for high-stakes gates).
   */
  charter: CharterName | CharterName[];
  /** Judges per charter when `charter` is a single name. Default 1. Ignored for arrays. */
  n?: number;
  /** How to combine votes. Default 'any-blocks' (any FAIL → panel FAIL) — correct for gates. */
  aggregate?: AggregateMode;
  /** Optional short framing of WHAT the artifact is (e.g. "a PR diff"). Never the producer's reasoning. */
  artifactKind?: string;
  model?: string;
  timeoutMs?: number;
  cwd?: string;
  /** Agent provider for the fresh judge process. Defaults to Claude for compatibility. */
  provider?: SpawnAgentProvider;
  /** Injectable spawn for tests (zero cost, deterministic). Defaults to the real provider spawn. */
  spawn?: SpawnClaudeFn;
}

// ── Prompt construction ──────────────────────────────────────────────

/**
 * Build the judge prompt. It contains ONLY the charter stance and the artifact — there is no
 * parameter through which a producer's rationalization could be injected. Two runs with
 * different "author justifications" produce byte-identical prompts because justification is
 * never an input.
 */
export function buildJudgePrompt(charter: Charter, artifact: string, artifactKind?: string): string {
  const kind = artifactKind ?? 'artifact';
  return [
    `You are an INDEPENDENT judge. You did not produce this ${kind} and you have no stake in`,
    `shipping it. You see only the ${kind} below — nothing about who made it or why.`,
    '',
    `# Your charter: ${charter.name}`,
    charter.stance,
    '',
    `Question you must answer: ${charter.question}`,
    '',
    `What counts as a problem: ${charter.instructions}`,
    '',
    '# Default to reject',
    'Start skeptical. If the evidence for PASS is not clear and concrete, the verdict is FAIL.',
    'Ambiguity, missing evidence, or an unfalsifiable claim → FAIL.',
    '',
    `# The ${kind}`,
    '```',
    artifact,
    '```',
    '',
    '# Your reply',
    'Reply with ONLY a YAML code fence, nothing else:',
    '```yaml',
    'verdict: pass | fail',
    'confidence: low | medium | high',
    'counterexample: |',
    '  A concrete counterexample if verdict is fail (the exact input/sequence/scenario),',
    '  or null if pass.',
    'reasoning: |',
    '  One or two sentences. Why this verdict.',
    '```',
  ].join('\n');
}

// ── Reply parsing (default-to-reject) ────────────────────────────────

/**
 * Extract the judge's verdict from its reply text. Default-to-reject: anything we cannot parse
 * into an unambiguous PASS becomes a FAIL. This is the second independence guard — a judge that
 * waffles, errors, or returns garbage cannot accidentally clear a gate.
 */
export function parseJudgeReply(
  text: string,
  charter: CharterName,
  costUsd: number,
): JudgeVerdict {
  const reject = (reasoning: string): JudgeVerdict => ({
    verdict: 'fail',
    counterexample: null,
    confidence: 'low',
    reasoning,
    charter,
    defaultedToReject: true,
    costUsd,
  });

  // Prefer a ```yaml fence; fall back to the first --- fence or the whole body.
  const fenced =
    text.match(/```ya?ml\s*\n([\s\S]*?)```/i)?.[1] ??
    text.match(/```\s*\n([\s\S]*?)```/)?.[1] ??
    text.match(/^---\n([\s\S]*?\n)---/m)?.[1];
  const raw = fenced ?? text;

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch {
    return reject('judge reply was not parseable YAML');
  }

  const result = JudgeReplySchema.safeParse(parsed);
  if (!result.success) {
    return reject(`judge reply did not match the verdict schema: ${result.error.issues[0]?.message ?? 'invalid'}`);
  }

  const reply = result.data;
  const counterexample =
    reply.counterexample && reply.counterexample.trim() && reply.counterexample.trim() !== 'null'
      ? reply.counterexample.trim()
      : null;

  return {
    verdict: reply.verdict,
    counterexample,
    confidence: reply.confidence ?? 'medium',
    reasoning: reply.reasoning?.trim() ?? '',
    charter,
    defaultedToReject: false,
    costUsd,
  };
}

// ── Aggregation ──────────────────────────────────────────────────────

/**
 * Combine individual votes into a panel verdict.
 * - any-blocks: any FAIL → panel FAIL. The correct, conservative default for gates.
 * - majority: panel FAIL only when strictly more than half FAIL. For advisory checks.
 *   Ties (exactly half fail) resolve to FAIL — default-to-reject extends to aggregation.
 */
export function aggregateVotes(votes: JudgeVerdict[], mode: AggregateMode): 'pass' | 'fail' {
  if (votes.length === 0) return 'fail'; // no judge ran → reject
  const fails = votes.filter((v) => v.verdict === 'fail').length;
  if (mode === 'any-blocks') return fails > 0 ? 'fail' : 'pass';
  // majority
  return fails * 2 >= votes.length ? 'fail' : 'pass';
}

// ── The primitive ────────────────────────────────────────────────────

/** Resolve the requested charter(s) into the concrete list of judges to spawn. */
export function resolveCharterPlan(req: JudgeRequest): CharterName[] {
  if (Array.isArray(req.charter)) {
    if (req.charter.length === 0) throw new Error('independentJudge: empty charter array');
    return req.charter;
  }
  const n = req.n ?? 1;
  if (n < 1) throw new Error('independentJudge: n must be >= 1');
  return Array.from({ length: n }, () => req.charter as CharterName);
}

/**
 * Spawn fresh, independent judges over an artifact and return an aggregated verdict.
 *
 * Each judge is a separate provider process with no shared context — it sees only the
 * artifact and its charter. The producing run physically cannot feed its own rationalization
 * to the judge of its own gate edit (#1212 hazard) because there is no input for it.
 */
export async function independentJudge(req: JudgeRequest): Promise<JudgePanelResult> {
  if (typeof req.artifact !== 'string' || req.artifact.trim() === '') {
    throw new Error('independentJudge: artifact must be a non-empty string');
  }
  const plan = resolveCharterPlan(req);
  for (const name of plan) {
    if (!isCharterName(name)) throw new Error(`independentJudge: unknown charter "${name}"`);
  }
  const spawn = req.spawn ?? spawnAgent;
  const aggregate = req.aggregate ?? 'any-blocks';

  const votes = await Promise.all(
    plan.map(async (name) => {
      const charter = CHARTERS[name];
      const prompt = buildJudgePrompt(charter, req.artifact, req.artifactKind);
      try {
        const { text, costUsd, exitCode } = await spawn(prompt, {
          cwd: req.cwd,
          timeoutMs: req.timeoutMs,
          model: req.model,
          provider: req.provider,
        });
        if (exitCode !== 0) {
          return parseJudgeReply('', name, costUsd); // non-zero exit → default-to-reject
        }
        return parseJudgeReply(text, name, costUsd);
      } catch (e: any) {
        // Spawn itself failed → reject (never silently pass on infrastructure failure).
        return {
          verdict: 'fail' as const,
          counterexample: null,
          confidence: 'low' as const,
          reasoning: `judge spawn failed: ${e?.message ?? e}`,
          charter: name,
          defaultedToReject: true,
          costUsd: 0,
        };
      }
    }),
  );

  return {
    verdict: aggregateVotes(votes, aggregate),
    votes,
    counterexamples: votes
      .filter((v) => v.verdict === 'fail' && v.counterexample)
      .map((v) => v.counterexample as string),
    aggregate,
    totalCostUsd: votes.reduce((s, v) => s + v.costUsd, 0),
  };
}
