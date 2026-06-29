/**
 * cli-independent-judge.ts — CLI surface for the independence-by-spawn primitive (#1231).
 *
 * Lets gates and prompt-driven skills (#1220 merge gate, #1224 outcome stamp, #1230 mock-defeat
 * trigger, the review battery) call one independent judge without reinventing the spawn. Reads
 * the artifact from a file or stdin so a gate can pipe a diff/outcome straight in.
 *
 * Usage:
 *   npx tsx src/cli-independent-judge.ts judge --charter mock-defeat --artifact-file diff.patch
 *   git diff origin/main | npx tsx src/cli-independent-judge.ts judge --charter red-team,staff-engineer
 *   ROOT="$(git -C "$PWD" rev-parse --show-toplevel)" && git -C "$ROOT" diff origin/main | npx tsx "$ROOT/src/cli-independent-judge.ts" judge --provider codex --cwd "$ROOT"
 *   npx tsx src/cli-independent-judge.ts charters        # list the charter library
 *
 * Exit code: 0 if the panel verdict is PASS, 1 if FAIL — so a gate can branch on `$?`.
 */

import { readFileSync } from 'node:fs';
import {
  independentJudge,
  type AggregateMode,
  type JudgeRequest,
} from './independent-judge.js';
import { CHARTERS, CHARTER_NAMES, isCharterName, type CharterName } from './judge-charters.js';
import { parseSpawnAgentProvider, type SpawnAgentProvider, type SpawnClaudeFn } from './spawn-claude.js';

function getFlag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function readArtifact(argv: string[]): string {
  const file = getFlag(argv, 'artifact-file');
  if (file) return readFileSync(file, 'utf8');
  // No file → read stdin (allows piping a diff in).
  return readFileSync(0, 'utf8');
}

function parseCharters(raw: string | undefined): CharterName | CharterName[] {
  if (!raw) {
    console.error(`--charter is required. One of: ${CHARTER_NAMES.join(', ')} (comma-separate for a diverse panel)`);
    process.exit(2);
  }
  const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
  for (const n of names) {
    if (!isCharterName(n)) {
      console.error(`Unknown charter "${n}". Valid: ${CHARTER_NAMES.join(', ')}`);
      process.exit(2);
    }
  }
  return names.length === 1 ? (names[0] as CharterName) : (names as CharterName[]);
}

function parseProvider(raw: string | undefined): SpawnAgentProvider | undefined {
  if (!raw) return undefined;
  const parsed = parseSpawnAgentProvider(raw);
  if (parsed) return parsed;
  console.error(`Unknown provider "${raw}". Valid: claude, codex`);
  process.exit(2);
}

function cmdCharters(): void {
  for (const name of CHARTER_NAMES) {
    const c = CHARTERS[name];
    console.log(`${name.padEnd(16)} ${c.summary}`);
  }
}

export async function cmdJudge(argv: string[], spawn?: SpawnClaudeFn): Promise<number> {
  const charter = parseCharters(getFlag(argv, 'charter'));
  const artifact = readArtifact(argv);
  const nRaw = getFlag(argv, 'n');
  const aggregate = getFlag(argv, 'aggregate') as AggregateMode | undefined;
  const asJson = argv.includes('--json');

  const req: JudgeRequest = {
    artifact,
    charter,
    n: nRaw ? parseInt(nRaw, 10) : undefined,
    aggregate: aggregate ?? 'any-blocks',
    artifactKind: getFlag(argv, 'kind'),
    model: getFlag(argv, 'model'),
    provider: parseProvider(getFlag(argv, 'provider')),
    cwd: getFlag(argv, 'cwd') ?? process.cwd(),
    spawn,
  };

  const result = await independentJudge(req);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`verdict: ${result.verdict}  (aggregate: ${result.aggregate}, judges: ${result.votes.length})`);
    for (const v of result.votes) {
      console.log(`  [${v.charter}] ${v.verdict}${v.defaultedToReject ? ' (defaulted-to-reject)' : ''} — ${v.reasoning}`);
      if (v.counterexample) console.log(`     counterexample: ${v.counterexample}`);
    }
  }
  return result.verdict === 'pass' ? 0 : 1;
}

export async function parseArgs(argv: string[]): Promise<number> {
  const command = argv[2];
  switch (command) {
    case 'judge':
      return cmdJudge(argv);
    case 'charters':
      cmdCharters();
      return 0;
    default:
      console.error(`Unknown command: ${command ?? '(none)'}\nCommands: judge, charters`);
      return 2;
  }
}

const isMain = process.argv[1] &&
  (process.argv[1].endsWith('cli-independent-judge.ts') || process.argv[1].endsWith('cli-independent-judge.js'));
if (isMain) {
  parseArgs(process.argv).then((code) => process.exit(code));
}
