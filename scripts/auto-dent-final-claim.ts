/**
 * Schema-constrained final run summary claims (#1145).
 *
 * These claims are worker self-report. They are useful structured inputs for
 * diagnostics, but durable evidence remains authoritative.
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';

export const FINAL_RUN_CLAIM_SCHEMA_VERSION = 1;

const statusSchema = z.enum(['pass', 'fail', 'skipped', 'missing']);
const testsSchema = z.object({
  status: statusSchema,
  command: z.string().min(1).nullable().optional(),
  count: z.number().int().nonnegative().nullable().optional(),
  evidence: z.array(z.string()).default([]),
});

export const finalRunClaimSchema = z.object({
  schema_version: z.literal(FINAL_RUN_CLAIM_SCHEMA_VERSION),
  selected_issue: z.string().min(1).nullable(),
  case_worktree: z.string().min(1).nullable(),
  tests: testsSchema,
  pr_url: z.string().url().nullable(),
  review_status: statusSchema,
  reflection_status: z.enum(['done', 'skipped', 'missing']),
  stop_reason: z.string().min(1).nullable(),
  blockers: z.array(z.string()),
});

export type FinalRunClaim = z.infer<typeof finalRunClaimSchema>;
export type FinalClaimStatus = 'valid' | 'invalid' | 'missing';

export interface FinalClaimParseResult {
  status: FinalClaimStatus;
  claim?: FinalRunClaim;
  warnings: string[];
}

export interface FinalClaimEvidence {
  prs: string[];
  cases: string[];
  testEvidence: boolean;
  reviewEvidence: boolean;
  reflectionEvidence: boolean;
}

export type FinalClaimProcessVerdict = 'pass' | 'process-incomplete' | 'fail-open-warning';

export interface FinalClaimProcessTelemetry {
  verdict: FinalClaimProcessVerdict;
  issueCount: number;
  summary: string;
}

function findJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(match[1].trim());
  }

  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    candidates.push(trimmed);
  }

  return candidates;
}

function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : 'claim';
    return `${path}: ${issue.message}`;
  });
}

export function parseFinalRunClaim(text: string): FinalClaimParseResult {
  const candidates = findJsonCandidates(text);
  if (candidates.length === 0) {
    return { status: 'missing', warnings: ['final claim object missing'] };
  }

  const warnings: string[] = [];
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (err) {
      warnings.push(`final claim JSON parse failed: ${(err as Error).message}`);
      continue;
    }

    const result = finalRunClaimSchema.safeParse(parsed);
    if (result.success) {
      return { status: 'valid', claim: result.data, warnings: [] };
    }
    warnings.push(...formatZodIssues(result.error));
  }

  return {
    status: 'invalid',
    warnings: warnings.length > 0 ? warnings : ['final claim object invalid'],
  };
}

export function compareFinalClaimToEvidence(
  claim: FinalRunClaim,
  evidence: FinalClaimEvidence,
): string[] {
  const warnings: string[] = [];

  if (claim.pr_url && !evidence.prs.includes(claim.pr_url)) {
    warnings.push(`claim selected PR ${claim.pr_url} but durable PR evidence is missing`);
  }
  if (claim.case_worktree && !evidence.cases.includes(claim.case_worktree)) {
    warnings.push(`claim selected case/worktree ${claim.case_worktree} but durable implementation evidence is missing`);
  }
  if (claim.tests.status === 'pass' && !evidence.testEvidence) {
    warnings.push('claim says tests passed but durable test evidence is missing');
  }
  if (claim.review_status === 'pass' && !evidence.reviewEvidence) {
    warnings.push('claim says review passed but durable review evidence is missing');
  }
  if (claim.reflection_status === 'done' && !evidence.reflectionEvidence) {
    warnings.push('claim says reflection completed but durable reflection evidence is missing');
  }

  return warnings;
}

export function writeFinalClaimArtifact(
  logDir: string,
  runNum: number,
  claim: FinalRunClaim,
): string {
  const path = join(logDir, `run-${runNum}-final-claim.json`);
  writeFileSync(path, JSON.stringify(claim, null, 2) + '\n');
  return path;
}

export function foldFinalClaimWarningsIntoProcess(
  verdict: FinalClaimProcessVerdict,
  issueCount: number,
  summary: string,
  hasValidClaim: boolean,
  warnings: string[],
): FinalClaimProcessTelemetry {
  if (!hasValidClaim || warnings.length === 0) {
    return { verdict, issueCount, summary };
  }

  const claimSummary = `final-claim: ${warnings.join('; ')}`;
  return {
    verdict: verdict === 'pass' ? 'process-incomplete' : verdict,
    issueCount: issueCount + warnings.length,
    summary: `${summary}; ${claimSummary}`,
  };
}
