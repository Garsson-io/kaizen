#!/usr/bin/env node
/**
 * coverage-summary.mjs — Append a coverage summary table to GITHUB_STEP_SUMMARY.
 *
 * Reads artifacts/coverage/coverage-summary.json (produced by vitest's
 * json-summary reporter) and writes a Markdown table to GITHUB_STEP_SUMMARY
 * so the coverage totals show up on the workflow run page without opening
 * artifacts.
 *
 * Exits 0 even when the summary is missing — coverage failure shouldn't
 * fail the whole workflow, the test step already does that.
 */

import { readFileSync, appendFileSync, existsSync } from "node:fs";

const path = "artifacts/coverage/coverage-summary.json";
if (!existsSync(path)) {
  console.log("No coverage-summary.json produced; skipping summary.");
  process.exit(0);
}

const total = JSON.parse(readFileSync(path, "utf8")).total;
const pct = (k) => total[k]?.pct?.toFixed(2) ?? "N/A";
const lines = [
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

const out = process.env.GITHUB_STEP_SUMMARY;
if (out) appendFileSync(out, lines + "\n");
console.log(lines);
