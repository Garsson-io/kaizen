#!/usr/bin/env node
/**
 * coverage-summary.mjs — Append a coverage summary table to GITHUB_STEP_SUMMARY.
 *
 * Reads artifacts/coverage/coverage-summary.json (produced by vitest's
 * json-summary reporter) and writes a Markdown table to GITHUB_STEP_SUMMARY
 * so the coverage totals show up on the workflow run page without opening
 * artifacts.
 *
 * Exits 0 on any failure — coverage reporting is advisory. The test step
 * itself is what fails the workflow on test failure; this script is just
 * formatting. A malformed or missing summary file must not break CI.
 */

import { readFileSync, appendFileSync, existsSync } from "node:fs";

export const SUMMARY_PATH = "artifacts/coverage/coverage-summary.json";

export function renderSummary(total) {
  const pct = (k) => total?.[k]?.pct?.toFixed(2) ?? "N/A";
  return [
    "## Test Coverage",
    "",
    "| Metric | Coverage |",
    "|--------|---------:|",
    `| Lines | ${pct("lines")}% |`,
    `| Statements | ${pct("statements")}% |`,
    `| Functions | ${pct("functions")}% |`,
    `| Branches | ${pct("branches")}% |`,
    "",
    "Artifacts: `junit.xml`, `coverage/lcov.info`, `coverage/cobertura-coverage.xml`, `coverage/` (HTML).",
  ].join("\n");
}

export function emit({
  path = SUMMARY_PATH,
  summaryFile = process.env.GITHUB_STEP_SUMMARY,
  log = console.log,
} = {}) {
  if (!existsSync(path)) {
    log("No coverage-summary.json produced; skipping summary.");
    return { ok: false, reason: "missing" };
  }
  let total;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    total = parsed?.total;
    if (!total || typeof total !== "object") {
      throw new Error("summary JSON has no `total` object");
    }
  } catch (err) {
    log(`Coverage summary unreadable (${err?.message ?? err}); skipping.`);
    return { ok: false, reason: "malformed" };
  }
  const rendered = renderSummary(total);
  if (summaryFile) appendFileSync(summaryFile, rendered + "\n");
  log(rendered);
  return { ok: true, rendered };
}

// Run when invoked as a script (not when imported by tests).
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) emit();
