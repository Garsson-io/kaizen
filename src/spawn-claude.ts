/**
 * spawn-claude.ts — the ONE `claude -p` subprocess primitive for the repo.
 *
 * A single fresh `claude -p` invocation: new process, new context, no conversation
 * history. This is the substrate for every independent-judgment mechanism — the review
 * battery (`review-battery.ts`) and the independence-by-spawn judge (`independent-judge.ts`)
 * both call this rather than reimplementing the spawn loop (#1231 DRY mandate).
 *
 * Extracted verbatim from the original private `runClaude` in review-battery.ts so the
 * stream-json JSONL parsing + cost extraction + timeout live in exactly one place.
 */

import { spawn } from 'node:child_process';

export interface SpawnClaudeResult {
  text: string;
  costUsd: number;
  durationMs: number;
  exitCode: number;
}

export interface SpawnClaudeOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Model override. Defaults to REVIEW_MODEL env var, then 'sonnet'. */
  model?: string;
}

/**
 * The injectable shape callers depend on, so tests can substitute a fake spawn
 * (zero cost, deterministic) without touching a real `claude` process.
 */
export type SpawnClaudeFn = (
  prompt: string,
  opts: SpawnClaudeOptions,
) => Promise<SpawnClaudeResult>;

/**
 * Run a single `claude -p` call with the given prompt.
 * Each call is a fresh process — no shared context with the caller, by construction.
 * Model defaults to the REVIEW_MODEL env var (then 'sonnet').
 * Returns parsed text, cost, duration, and exit code.
 */
export const spawnClaude: SpawnClaudeFn = (prompt, opts) => {
  const model = opts.model ?? process.env.REVIEW_MODEL ?? 'sonnet';
  const start = Date.now();

  return new Promise((resolve) => {
    const child = spawn('claude', [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--model', model,
    ], {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin.write(prompt, 'utf8');
    child.stdin.end();

    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', () => {}); // drain to prevent blocking

    const timer = setTimeout(() => { child.kill(); }, opts.timeoutMs ?? 120_000);

    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;

      // Parse text and cost from stream-json JSONL output.
      // The `result` field in the final "result" message is now always empty;
      // actual text lives in assistant message content blocks.
      let costUsd = 0;
      let text = '';
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'result') {
            costUsd = msg.total_cost_usd ?? 0;
          } else if (msg.type === 'assistant') {
            const content = msg.message?.content ?? [];
            for (const block of content) {
              if (block.type === 'text') text += block.text;
            }
          }
        } catch { continue; }
      }

      resolve({ text, costUsd, durationMs, exitCode: code ?? -1 });
    });
  });
};
