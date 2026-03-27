import { z } from "zod";

export const Level = z.enum(["Unit", "Integration", "System", "Agentic", "Workflow"]);
export type Level = z.infer<typeof Level>;

export const BehaviorOutput = z.object({
  behavior_id: z.number().int().min(1).max(10),
  description: z.string().min(5),
  minimum_level: Level,
  justification: z.string().min(10),
  test_description: z.string().min(10),
  plan_consistent: z.boolean(),
  plan_consistent_note: z.string().optional(),
});
export type BehaviorOutput = z.infer<typeof BehaviorOutput>;

export const ProbeOutput = z.object({
  task_id: z.string().regex(/^EC-\d+$/),
  condition: z.enum(["baseline", "treatment"]),
  behaviors: z.array(BehaviorOutput).min(1).max(10),
});
export type ProbeOutput = z.infer<typeof ProbeOutput>;

export const GroundTruthBehavior = z.object({
  behavior_id: z.number().int().min(1).max(10),
  ground_truth_level: Level,
});

export const GroundTruth = z.object({
  task_id: z.string().regex(/^EC-\d+$/),
  behaviors: z.array(GroundTruthBehavior).min(1).max(10),
});
export type GroundTruth = z.infer<typeof GroundTruth>;
