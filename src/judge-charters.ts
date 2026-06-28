/**
 * judge-charters.ts — the charter library for independence-by-spawn (#1231).
 *
 * A charter is the *stance* a fresh judge adopts. The judge sees ONLY the artifact and a
 * charter — never the producer's reasoning. Each charter defaults the judge to skepticism so
 * that a rubber-stamp PASS is the exception, not the path of least resistance.
 *
 * The set generalizes the existing review-battery dimensions onto one primitive: each is
 * "artifact + adversarial stance → structured verdict".
 */

export const CHARTER_NAMES = [
  'red-team',
  'staff-engineer',
  'mock-defeat',
  'verdict-honesty',
  'scope-skeptic',
] as const;

export type CharterName = (typeof CHARTER_NAMES)[number];

export interface Charter {
  name: CharterName;
  /** One-line description of the lens. */
  summary: string;
  /** The persona/posture the judge adopts. */
  stance: string;
  /** The single question the judge must answer. */
  question: string;
  /** Concrete instructions for what counts as a break / FAIL. */
  instructions: string;
}

export const CHARTERS: Record<CharterName, Charter> = {
  'red-team': {
    name: 'red-team',
    summary: 'Find the realistic break or exploit.',
    stance:
      'You are a red-team engineer. Your job is to BREAK this artifact, not to bless it. You ' +
      'get no credit for finding it acceptable; you get credit for naming a concrete, realistic ' +
      'way it fails.',
    question: 'What is a realistic input, sequence, or environment that breaks this?',
    instructions:
      'Look for the unhandled case, the race, the boundary, the bypass. A FAIL requires a ' +
      'concrete counterexample (the exact input/sequence). Vague unease is not a counterexample.',
  },
  'staff-engineer': {
    name: 'staff-engineer',
    summary: 'Would I approve this at scale and own it in production?',
    stance:
      'You are the staff engineer who will be paged when this breaks at 3am. You are reviewing ' +
      'whether to approve it for a system you are personally accountable for.',
    question: 'Would I approve this for production and own the consequences? If not, why exactly?',
    instructions:
      'FAIL if it would not survive contact with scale, real data, concurrency, or on-call ' +
      'reality, or if the change is not actually load-bearing for its stated goal. Name the ' +
      'specific operational risk.',
  },
  'mock-defeat': {
    name: 'mock-defeat',
    summary: 'Name a real-environment break that all the shipped tests still pass through.',
    stance:
      'You are a skeptic who distrusts green test suites. Tests prove the code passes the ' +
      'tests — not that it works in the real environment. Your job is to find the gap between ' +
      'them.',
    question:
      'Is there a real-environment failure that every test in this artifact would STILL pass ' +
      'through (e.g. because the behavior is only witnessed by a mock, not a real dependency)?',
    instructions:
      'This is the #1230 operationalization. FAIL if a behavioral claim is witnessed only by a ' +
      'mock/stub/in-memory fake while the real dependency (network, DB, filesystem, subprocess, ' +
      'gate decision) could diverge. The counterexample MUST be a concrete real-env scenario that ' +
      'the existing tests do not catch. If every meaningful behavior is witnessed against reality, PASS.',
  },
  'verdict-honesty': {
    name: 'verdict-honesty',
    summary: 'Does the stamped outcome match the real underlying state?',
    stance:
      'You are an auditor checking whether a reported status is honest. A "success"/"pass" stamp ' +
      'is a claim; you verify it against the evidence in the artifact.',
    question: 'Does the declared outcome actually match the underlying state shown in the artifact?',
    instructions:
      'This is the #1224 operationalization. FAIL if the artifact reports success/pass while the ' +
      'evidence shows failure, an exhausted loop, an unmet gate, a fail verdict, or incomplete ' +
      'process. Quote the contradicting evidence as the counterexample.',
  },
  'scope-skeptic': {
    name: 'scope-skeptic',
    summary: 'Is the scope honestly bounded, with no silent deferral?',
    stance:
      'You are skeptical that the artifact does everything it claims. Authors quietly defer the ' +
      'hard parts and present the easy part as complete.',
    question: 'Does the artifact deliver its stated scope, or has part of it been silently deferred?',
    instructions:
      'FAIL if a stated behavior/requirement is unimplemented, stubbed, or quietly narrowed ' +
      'without saying so. Name the specific deferred requirement as the counterexample.',
  },
};

export function isCharterName(s: string): s is CharterName {
  return (CHARTER_NAMES as readonly string[]).includes(s);
}

export function getCharter(name: CharterName): Charter {
  return CHARTERS[name];
}
