#!/usr/bin/env npx tsx
/**
 * score-probe.ts — Mechanistic scorer for eval-probe YAML outputs.
 *
 * Usage:
 *   npx tsx scripts/score-probe.ts --output <file.yaml> --gt <ground-truth.yaml>
 *   npx tsx scripts/score-probe.ts --output-dir <dir/> --gt-dir <gt-dir/>
 *
 * Validates both files with Zod, then computes:
 *   - Boundary sufficiency   (55%)
 *   - Minimum-level precision (20%)
 *   - Plan consistency        (15%)
 *   - Required structure      (10%)
 *
 * Exits non-zero if any file fails Zod validation.
 */

import { readFileSync, readdirSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ProbeOutput, GroundTruth } from "../src/eval-probe-schema.js";

function parseFile(path: string): unknown {
  const raw = readFileSync(path, "utf-8");
  return path.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
}

const LEVEL_INDEX: Record<string, number> = {
  Unit: 0,
  Integration: 1,
  System: 2,
  Agentic: 3,
  Workflow: 4,
};

const ROW_WEIGHT: Record<string, number> = {
  Unit: 1,
  Integration: 2,
  System: 3,
  Agentic: 4,
  Workflow: 4,
};

function sufficiencyScore(pred: string, gt: string): number {
  const diff = LEVEL_INDEX[pred] - LEVEL_INDEX[gt];
  if (diff >= 0) return 1.0;
  if (diff === -1) return 0.4;
  if (diff === -2) return 0.15;
  return 0.05;
}

function precisionScore(pred: string, gt: string): number {
  const dist = Math.abs(LEVEL_INDEX[pred] - LEVEL_INDEX[gt]);
  if (dist === 0) return 1.0;
  if (dist === 1) return 0.65;
  if (dist === 2) return 0.3;
  return 0.0;
}

function consistencyScore(planConsistent: boolean): number {
  return planConsistent ? 1.0 : 0.0;
}

interface ScoreResult {
  task_id: string;
  condition: string;
  sufficiency: number;
  precision: number;
  consistency: number;
  structure: number;
  total: number;
  rows: Array<{
    behavior_id: number;
    predicted: string;
    ground_truth: string;
    suff: number;
    prec: number;
    cons: number;
    weight: number;
  }>;
}

function scoreOutput(output: z.infer<typeof ProbeOutput>, gt: z.infer<typeof GroundTruth>): ScoreResult {
  if (output.task_id !== gt.task_id) {
    throw new Error(`task_id mismatch: output has ${output.task_id}, GT has ${gt.task_id}`);
  }

  const gtMap = new Map(gt.behaviors.map((b) => [b.behavior_id, b.ground_truth_level]));
  const rows = [];
  let totalWeight = 0;
  let weightedSuff = 0;
  let weightedPrec = 0;
  let weightedCons = 0;

  for (const b of output.behaviors) {
    const gtLevel = gtMap.get(b.behavior_id);
    if (!gtLevel) {
      throw new Error(`No GT entry for behavior_id ${b.behavior_id} in task ${output.task_id}`);
    }

    const weight = ROW_WEIGHT[gtLevel];
    const suff = sufficiencyScore(b.minimum_level, gtLevel);
    const prec = precisionScore(b.minimum_level, gtLevel);
    const cons = consistencyScore(b.plan_consistent);

    totalWeight += weight;
    weightedSuff += suff * weight;
    weightedPrec += prec * weight;
    weightedCons += cons * weight;

    rows.push({ behavior_id: b.behavior_id, predicted: b.minimum_level, ground_truth: gtLevel, suff, prec, cons, weight });
  }

  const sufficiency = weightedSuff / totalWeight;
  const precision = weightedPrec / totalWeight;
  const consistency = weightedCons / totalWeight;
  const structure = 1.0; // all required fields present (Zod ensures this)
  const total = 0.55 * sufficiency + 0.20 * precision + 0.15 * consistency + 0.10 * structure;

  return { task_id: output.task_id, condition: output.condition, sufficiency, precision, consistency, structure, total, rows };
}

function loadAndValidate(path: string, schema: z.ZodTypeAny): unknown {
  const parsed = parseFile(path);
  const result = schema.safeParse(parsed);
  if (!result.success) {
    console.error(`\nZod validation FAILED for ${path}:`);
    for (const issue of result.error.issues) {
      console.error(`  [${issue.path.join(".")}] ${issue.message}`);
    }
    process.exit(1);
  }
  return result.data;
}

function printResult(r: ScoreResult) {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  console.log(`\n── ${r.task_id} / ${r.condition} ──`);
  console.log(`  Sufficiency : ${pct(r.sufficiency)}  (weight 55%)`);
  console.log(`  Precision   : ${pct(r.precision)}  (weight 20%)`);
  console.log(`  Consistency : ${pct(r.consistency)}  (weight 15%)`);
  console.log(`  Structure   : ${pct(r.structure)}  (weight 10%)`);
  console.log(`  TOTAL       : ${pct(r.total)}`);
  console.log(`\n  Behavior breakdown:`);
  console.log(`  ${"ID".padEnd(4)} ${"Predicted".padEnd(12)} ${"GT".padEnd(12)} ${"Suff".padEnd(7)} ${"Prec".padEnd(7)} ${"Cons".padEnd(7)} Wt`);
  for (const row of r.rows) {
    const match = row.predicted === row.ground_truth ? "✓" : row.suff < 1 ? "✗" : "↑";
    console.log(
      `  ${String(row.behavior_id).padEnd(4)} ${(row.predicted + " " + match).padEnd(12)} ${row.ground_truth.padEnd(12)} ${pct(row.suff).padEnd(7)} ${pct(row.prec).padEnd(7)} ${pct(row.cons).padEnd(7)} ${row.weight}`
    );
  }
}

function main() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const outputFile = get("--output");
  const gtFile = get("--gt");
  const outputDir = get("--output-dir");
  const gtDir = get("--gt-dir");

  const results: ScoreResult[] = [];

  if (outputFile && gtFile) {
    const output = loadAndValidate(outputFile, ProbeOutput) as z.infer<typeof ProbeOutput>;
    const gt = loadAndValidate(gtFile, GroundTruth) as z.infer<typeof GroundTruth>;
    results.push(scoreOutput(output, gt));
  } else if (outputDir && gtDir) {
    const files = readdirSync(outputDir).filter((f) => f.endsWith(".json") || f.endsWith(".yaml") || f.endsWith(".yml"));
    for (const file of files.sort()) {
      const ext = file.endsWith(".json") ? "json" : "yaml";
      const rawId = file.replace(/^out-[a-z]+-/, "").replace(/\.(json|yaml|yml)$/, "");
      // Normalize ec04 → ec-04, EC-04 stays EC-04
      const normalizedId = rawId.replace(/^([a-z]+)(\d+)$/i, "$1-$2").toLowerCase();
      const gtFile = `${gtDir}/${normalizedId}.${ext}`;
      try {
        const output = loadAndValidate(`${outputDir}/${file}`, ProbeOutput) as z.infer<typeof ProbeOutput>;
        const gt = loadAndValidate(gtFile, GroundTruth) as z.infer<typeof GroundTruth>;
        results.push(scoreOutput(output, gt));
      } catch (e) {
        console.error(`Skipping ${file}: ${(e as Error).message}`);
      }
    }
  } else {
    console.error("Usage: score-probe.ts --output <file> --gt <file>");
    console.error("       score-probe.ts --output-dir <dir> --gt-dir <dir>");
    process.exit(1);
  }

  for (const r of results) printResult(r);

  if (results.length > 1) {
    const avg = (key: keyof ScoreResult) =>
      results.reduce((s, r) => s + (r[key] as number), 0) / results.length;
    console.log(`\n══ AGGREGATE (${results.length} tasks) ══`);
    console.log(`  Avg sufficiency : ${(avg("sufficiency") * 100).toFixed(1)}%`);
    console.log(`  Avg precision   : ${(avg("precision") * 100).toFixed(1)}%`);
    console.log(`  Avg consistency : ${(avg("consistency") * 100).toFixed(1)}%`);
    console.log(`  Avg total       : ${(avg("total") * 100).toFixed(1)}%`);

    const byCondition: Record<string, ScoreResult[]> = {};
    for (const r of results) {
      (byCondition[r.condition] ??= []).push(r);
    }
    for (const [cond, rs] of Object.entries(byCondition)) {
      const avgTotal = rs.reduce((s, r) => s + r.total, 0) / rs.length;
      console.log(`  ${cond}: ${(avgTotal * 100).toFixed(1)}%`);
    }
  }
}

main();
