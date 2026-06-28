import { describe, it, expect } from 'vitest';
import { scrubSecrets, REDACTED, SCRUB_FAILED } from './scrub-secrets.js';

describe('scrubSecrets', () => {
  it('redacts token-shaped secrets (whole match)', () => {
    const cases = [
      'sk-ant-api03-AbCdEf123456_xyz-789',
      'ghp_0123456789abcdefABCDEF0123456789abcd',
      'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
      'AKIA1234567890ABCDEF',
      'xoxb-123456789012-abcdefghijkl',
      'AIzaSyA0123456789012345678901234567890abc',
    ];
    for (const secret of cases) {
      const { text, redactions } = scrubSecrets(`token here: ${secret} end`);
      expect(text, secret).not.toContain(secret);
      expect(text, secret).toContain(REDACTED);
      expect(redactions, secret).toBeGreaterThan(0);
    }
  });

  it('redacts a seeded fake token inside a JSONL transcript line', () => {
    const line = '{"type":"tool_result","content":"export ANTHROPIC_API_KEY=sk-ant-deadbeefdeadbeef0000"}';
    const { text, redactions } = scrubSecrets(line);
    expect(text).not.toContain('sk-ant-deadbeefdeadbeef0000');
    expect(redactions).toBeGreaterThan(0);
  });

  it('keeps the key but redacts the value for KEY=value secrets', () => {
    const { text } = scrubSecrets('FOO_API_KEY=supersecretvalue123');
    expect(text).toContain('FOO_API_KEY=');
    expect(text).toContain(REDACTED);
    expect(text).not.toContain('supersecretvalue123');
  });

  it('redacts Bearer and Authorization header values', () => {
    const a = scrubSecrets('Authorization: Bearer abcdef1234567890token');
    expect(a.text).not.toContain('abcdef1234567890token');
    expect(a.text).toContain(REDACTED);
  });

  it('redacts the password in a URL/DSN userinfo (keeps scheme+user)', () => {
    const { text } = scrubSecrets('DATABASE_URL was postgres://admin:s3cr3tpassword@db.host:5432/app');
    expect(text).toContain('postgres://admin:');
    expect(text).toContain(REDACTED);
    expect(text).toContain('@db.host:5432/app'); // host kept
    expect(text).not.toContain('s3cr3tpassword');
  });

  it('redacts a KEY=value secret even when the value contains spaces', () => {
    const { text } = scrubSecrets('PASSWORD=my secret pass phrase');
    expect(text).toContain('PASSWORD=');
    expect(text).toContain(REDACTED);
    expect(text).not.toContain('my secret pass phrase');
  });

  it('redacts Slack xapp- app-level tokens', () => {
    const { text } = scrubSecrets('SLACK_APP_TOKEN=xapp-1-A0123456789-abcdefghij');
    expect(text).not.toContain('xapp-1-A0123456789-abcdefghij');
    expect(text).toContain(REDACTED);
  });

  it('redacts PEM private key blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    const { text } = scrubSecrets(`key:\n${pem}\ndone`);
    expect(text).not.toContain('MIIEowIBAAKCAQEA');
    expect(text).toContain(REDACTED);
  });

  it('leaves benign text untouched (no over-redaction)', () => {
    const benign = 'The PLAN row stays not observed even when a plan exists. See PR #1499.';
    const { text, redactions } = scrubSecrets(benign);
    expect(text).toBe(benign);
    expect(redactions).toBe(0);
  });

  it('is idempotent on the text (incl. URL userinfo + KV-with-spaces)', () => {
    const input = [
      'A=sk-ant-deadbeefdeadbeef0000 B ghp_0123456789abcdefABCDEF0123456789abcd',
      'DB=postgres://admin:s3cr3tpassword@db.host:5432/app',
      'PASSWORD=my secret pass phrase',
    ].join('\n');
    const once = scrubSecrets(input).text;
    const twice = scrubSecrets(once).text;
    expect(twice).toBe(once);
  });

  it('fails closed on non-string input (never passes raw through)', () => {
    for (const bad of [undefined, null, 42, {}, []]) {
      const r = scrubSecrets(bad as unknown);
      expect(r.text).toBe(SCRUB_FAILED);
      expect(r.redactions).toBe(-1);
    }
  });
});
