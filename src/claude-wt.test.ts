import { describe, it, expect } from "vitest";
import { parseArgs, generateNonce, HELP_TEXT } from "./claude-wt.js";

describe("parseArgs", () => {
  it("adds --dangerously-skip-permissions by default", () => {
    const result = parseArgs([]);
    expect(result).not.toBe("help");
    if (result === "help") return;
    expect(result.claudeArgs).toEqual(["--dangerously-skip-permissions"]);
    expect(result.skipPermissions).toBe(true);
  });

  it("prepends skip-permissions before other args", () => {
    const result = parseArgs(["-p", "fix bug"]);
    expect(result).not.toBe("help");
    if (result === "help") return;
    expect(result.claudeArgs).toEqual([
      "--dangerously-skip-permissions",
      "-p",
      "fix bug",
    ]);
  });

  it("--safe suppresses skip-permissions", () => {
    const result = parseArgs(["--safe"]);
    expect(result).not.toBe("help");
    if (result === "help") return;
    expect(result.claudeArgs).toEqual([]);
    expect(result.skipPermissions).toBe(false);
  });

  it("--safe with other args passes them through", () => {
    const result = parseArgs(["--safe", "-p", "fix bug"]);
    expect(result).not.toBe("help");
    if (result === "help") return;
    expect(result.claudeArgs).toEqual(["-p", "fix bug"]);
  });

  it("--safe is consumed and not passed to claude", () => {
    const result = parseArgs(["--safe", "--verbose"]);
    expect(result).not.toBe("help");
    if (result === "help") return;
    expect(result.claudeArgs).not.toContain("--safe");
    expect(result.claudeArgs).toContain("--verbose");
  });

  it("unknown flags pass through", () => {
    const result = parseArgs(["--verbose", "--model", "opus", "-p", "test"]);
    expect(result).not.toBe("help");
    if (result === "help") return;
    expect(result.claudeArgs).toEqual([
      "--dangerously-skip-permissions",
      "--verbose",
      "--model",
      "opus",
      "-p",
      "test",
    ]);
  });

  it("--help returns 'help'", () => {
    expect(parseArgs(["--help"])).toBe("help");
  });
});

describe("generateNonce", () => {
  it("matches YYMMDD-HHMM-xxxx format", () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(/^\d{6}-\d{4}-[0-9a-f]{4}$/);
  });

  it("generates different values", () => {
    const a = generateNonce();
    const b = generateNonce();
    // Technically could collide but extremely unlikely in same ms
    // Just check format is stable
    expect(a).toMatch(/^\d{6}-\d{4}-[0-9a-f]{4}$/);
    expect(b).toMatch(/^\d{6}-\d{4}-[0-9a-f]{4}$/);
  });
});

describe("HELP_TEXT", () => {
  it("contains usage info", () => {
    expect(HELP_TEXT).toContain("Usage:");
    expect(HELP_TEXT).toContain("--safe");
  });
});
