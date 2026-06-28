/**
 * scrub-secrets.ts — redact credential-shaped substrings from text before it is
 * attached to a public GitHub comment (I19: no secrets in commits/artifacts).
 *
 * Used by the run-transcript attachment (#1508): session JSONL can contain
 * tokens, Authorization headers, and `KEY=value` env dumps. We scrub before
 * attaching.
 *
 * FAIL CLOSED: the whole scrub runs inside a guard. If anything throws — or the
 * input is not a string — we return a sentinel and NEVER the raw text. A scrub
 * we are not certain about must withhold, not leak (the issue's hard constraint).
 *
 * Pure + deterministic. Idempotent: scrubbing already-scrubbed text is a no-op
 * on the text (the redaction placeholder matches none of the secret shapes).
 */

export const REDACTED = '«REDACTED»';

/** Sentinel returned when scrubbing fails — the content is withheld entirely. */
export const SCRUB_FAILED = '«scrub-failed: content withheld for safety»';

export interface ScrubResult {
  /** Scrubbed text, or {@link SCRUB_FAILED} when scrubbing could not complete. */
  text: string;
  /** Number of redactions applied, or -1 when scrubbing failed (withheld). */
  redactions: number;
}

/**
 * Token-shaped secrets: the WHOLE match is a credential, so the whole match is
 * replaced. Ordered roughly specific → generic.
 */
const TOKEN_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, // PEM private keys
  /sk-ant-[A-Za-z0-9_-]{12,}/g,                 // Anthropic
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,           // OpenAI
  /gh[pousr]_[A-Za-z0-9]{16,}/g,                // GitHub PAT/OAuth/server/refresh
  /github_pat_[A-Za-z0-9_]{20,}/g,              // GitHub fine-grained PAT
  /AKIA[0-9A-Z]{16}/g,                          // AWS access key id
  /(?:xox[baprs]|xapp)-[A-Za-z0-9-]{10,}/g,     // Slack bot/user/app tokens
  /AIza[0-9A-Za-z_-]{35}/g,                     // Google API key
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

/**
 * Key/value secrets: the KEY is benign (and useful context), only the VALUE is a
 * secret. We keep the key + separator (capture group 1) and redact the value.
 */
const KV_PATTERNS: RegExp[] = [
  // URL userinfo password: scheme://user:<password>@host  (DSNs, git remotes).
  // Keep scheme+user; redact the password. `@host` is a lookahead so the generic
  // single-group replacer (keeps group 1, redacts the rest) preserves the host.
  /([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(?=@)/gi,
  // Authorization: <scheme token>  /  "authorization": "<token>"
  // Consume the WHOLE header value (e.g. `Bearer <token>`), not just the scheme word.
  /(["']?[Aa]uthorization["']?\s*[:=]\s*)["']?[^\n"',}]{6,}/g,
  // Bearer <token> (also matches inside an Authorization value)
  /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/g,
  // FOO_API_KEY=...  /  "client_secret": "..."  /  PASSWORD=...
  // Value runs to end-of-line / JSON delimiter so spaces in the value don't leak.
  /(["']?[\w.-]*(?:API_?KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET|CREDENTIALS?)[\w.-]*["']?\s*[:=]\s*)["']?[^\n"',}]+/gi,
];

/**
 * Redact credential-shaped substrings from `text`. Returns the scrubbed text and
 * a redaction count. Fails closed: any error (or non-string input) yields
 * {@link SCRUB_FAILED} with `redactions: -1` — never the raw input.
 */
export function scrubSecrets(text: unknown): ScrubResult {
  try {
    if (typeof text !== 'string') return { text: SCRUB_FAILED, redactions: -1 };
    let out = text;
    let count = 0;

    for (const re of TOKEN_PATTERNS) {
      out = out.replace(re, () => {
        count++;
        return REDACTED;
      });
    }
    for (const re of KV_PATTERNS) {
      out = out.replace(re, (_m, prefix: string) => {
        count++;
        return `${prefix}${REDACTED}`;
      });
    }

    return { text: out, redactions: count };
  } catch {
    // Fail closed: withhold everything rather than risk leaking an unscrubbed secret.
    return { text: SCRUB_FAILED, redactions: -1 };
  }
}
