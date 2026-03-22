/**
 * synthetic-transcript.ts — Generate synthetic Claude Code session transcripts
 * for testing transcript analysis in the reflection subagent.
 *
 * Produces JSONL files matching the real Claude Code transcript format:
 * - user entries with text content or tool_result content
 * - assistant entries with text, thinking, or tool_use content
 * - progress entries for tool execution
 *
 * Part of kaizen #438 — Reflection subagent transcript analysis.
 */

import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// ── Transcript entry types ──

export interface TranscriptEntry {
  type: 'user' | 'assistant' | 'system' | 'progress';
  uuid: string;
  parentUuid?: string;
  sessionId: string;
  timestamp: string;
  message?: {
    role: string;
    content: ContentBlock[];
  };
  [key: string]: unknown;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

// ── Builder API ──

export class SyntheticSession {
  private entries: TranscriptEntry[] = [];
  private sessionId: string;
  private lastUuid: string;

  constructor(sessionId?: string) {
    this.sessionId = sessionId ?? randomUUID();
    this.lastUuid = randomUUID();
  }

  /** Add a user text message (e.g., a prompt or correction). */
  userMessage(text: string): this {
    const uuid = randomUUID();
    this.entries.push({
      type: 'user',
      uuid,
      parentUuid: this.lastUuid,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      userType: 'human',
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
    });
    this.lastUuid = uuid;
    return this;
  }

  /** Add an assistant text response. */
  assistantText(text: string): this {
    const uuid = randomUUID();
    this.entries.push({
      type: 'assistant',
      uuid,
      parentUuid: this.lastUuid,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      userType: 'external',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
      },
    });
    this.lastUuid = uuid;
    return this;
  }

  /** Add an assistant tool call. */
  toolUse(toolName: string, input: Record<string, unknown>): this {
    const toolUseId = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const uuid = randomUUID();
    this.entries.push({
      type: 'assistant',
      uuid,
      parentUuid: this.lastUuid,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      userType: 'external',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseId, name: toolName, input }],
      },
    });
    this.lastUuid = uuid;
    // Store the tool use ID for the next tool result
    this._lastToolUseId = toolUseId;
    return this;
  }

  /** Add a successful tool result. */
  toolResult(content: string): this {
    const uuid = randomUUID();
    this.entries.push({
      type: 'user',
      uuid,
      parentUuid: this.lastUuid,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      userType: 'tool',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: this._lastToolUseId ?? 'unknown',
            content,
          },
        ],
      },
    });
    this.lastUuid = uuid;
    return this;
  }

  /** Add a failed tool result (is_error: true). */
  toolError(content: string): this {
    const uuid = randomUUID();
    this.entries.push({
      type: 'user',
      uuid,
      parentUuid: this.lastUuid,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      userType: 'tool',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: this._lastToolUseId ?? 'unknown',
            content,
            is_error: true,
          },
        ],
      },
    });
    this.lastUuid = uuid;
    return this;
  }

  /** Write the transcript to a JSONL file. */
  writeToFile(path: string): string {
    const lines = this.entries.map((e) => JSON.stringify(e));
    writeFileSync(path, lines.join('\n') + '\n');
    return path;
  }

  /** Get the raw entries (for in-memory testing). */
  getEntries(): TranscriptEntry[] {
    return [...this.entries];
  }

  /** Get as JSONL string. */
  toJsonl(): string {
    return this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  }

  private _lastToolUseId?: string;
}

// ── Pre-built scenarios for testing ──

/** Session with user corrections — the user pushes back on the agent's approach. */
export function sessionWithCorrections(): SyntheticSession {
  return new SyntheticSession()
    .userMessage('Fix the login bug in auth.ts')
    .assistantText('I\'ll refactor the entire auth module to fix this.')
    .userMessage('No, don\'t refactor everything. Just fix the bug.')
    .assistantText('You\'re right, let me focus on just the login function.')
    .toolUse('Read', { file_path: '/src/auth.ts' })
    .toolResult('export function login() { /* ... */ }')
    .toolUse('Edit', { file_path: '/src/auth.ts', old_string: 'bug', new_string: 'fix' })
    .toolResult('File edited successfully')
    .assistantText('Fixed the login bug.');
}

/** Session with failed tool calls — retries and errors. */
export function sessionWithFailures(): SyntheticSession {
  return new SyntheticSession()
    .userMessage('Run the test suite')
    .toolUse('Bash', { command: 'npm test' })
    .toolError('Exit code 1\nFailed: 3 tests failed')
    .assistantText('Tests failed, let me fix the issues.')
    .toolUse('Bash', { command: 'npm test' })
    .toolError('Exit code 1\nFailed: 2 tests failed')
    .assistantText('Still failing, investigating further.')
    .toolUse('Bash', { command: 'npm test' })
    .toolResult('All tests passed');
}

/** Session with hook denials — the agent gets blocked by hooks. */
export function sessionWithHookDenials(): SyntheticSession {
  return new SyntheticSession()
    .userMessage('Commit and push the changes')
    .toolUse('Bash', { command: 'git commit -m "fix: patch"' })
    .toolResult('BLOCKED: enforce-case-worktree.sh — Cannot commit outside worktree')
    .assistantText('I need to enter a worktree first.')
    .toolUse('Bash', { command: 'git commit -m "fix: patch" --no-verify' })
    .toolError('pre-commit hook failed: blocked on main checkout')
    .assistantText('Let me enter a worktree and try again.');
}

/** Session where user asks for the same thing twice. */
export function sessionWithRepeatedRequests(): SyntheticSession {
  return new SyntheticSession()
    .userMessage('Add error handling to the parser')
    .assistantText('I\'ll add comprehensive error handling with custom error classes.')
    .toolUse('Edit', { file_path: '/src/parser.ts', old_string: 'parse()', new_string: 'parse() with error handling' })
    .toolResult('File edited successfully')
    .userMessage('You didn\'t actually add error handling. Add try-catch around the parse call.')
    .assistantText('Sorry, let me add the actual try-catch block.')
    .toolUse('Edit', { file_path: '/src/parser.ts', old_string: 'code', new_string: 'try { code } catch(e) {}' })
    .toolResult('File edited successfully');
}

/** Session with multiple signal types combined. */
export function sessionWithMixedSignals(): SyntheticSession {
  return new SyntheticSession()
    .userMessage('Implement the new feature from issue #42')
    .assistantText('Let me start by reading the issue.')
    .toolUse('Bash', { command: 'gh issue view 42' })
    .toolResult('Title: Add caching layer\nBody: ...')
    .toolUse('Bash', { command: 'npm test' })
    .toolError('Exit code 1\nTypeError: Cannot read property')
    .userMessage('You\'re leaning in the wrong direction. The cache should be in-memory, not Redis.')
    .assistantText('Got it, switching to in-memory cache.')
    .toolUse('Bash', { command: 'npm test' })
    .toolError('Exit code 1\nStill failing')
    .toolUse('Bash', { command: 'npm test' })
    .toolResult('All tests passed')
    .userMessage('Can you also add the cache invalidation? I asked about that earlier.')
    .assistantText('Adding cache invalidation now.');
}

/** Clean session with no signals — everything goes smoothly. */
export function sessionClean(): SyntheticSession {
  return new SyntheticSession()
    .userMessage('Add a test for the utils module')
    .assistantText('I\'ll write a test for the utils module.')
    .toolUse('Read', { file_path: '/src/utils.ts' })
    .toolResult('export function add(a: number, b: number) { return a + b; }')
    .toolUse('Write', { file_path: '/src/utils.test.ts', content: 'test code' })
    .toolResult('File created successfully')
    .toolUse('Bash', { command: 'npm test' })
    .toolResult('All tests passed')
    .assistantText('Test added and passing.');
}
