import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseSkillFrontmatter,
  loadAllSkillMetadata,
  validateSkillDependencies,
  validateSkillVersions,
} from "./skill-metadata.js";
import type { SkillMetadata } from "./skill-metadata.js";

describe("parseSkillFrontmatter", () => {
  it("parses minimal frontmatter with name and description", () => {
    const content = `---
name: kaizen-zen
description: Print the Zen of Kaizen
---

# The Zen of Kaizen`;

    const meta = parseSkillFrontmatter(content);
    expect(meta).toEqual({
      name: "kaizen-zen",
      description: "Print the Zen of Kaizen",
      triggers: undefined,
      depends_on: undefined,
      type: undefined,
      min_version: undefined,
      user_invocable: undefined,
    });
  });

  it("parses full frontmatter with all fields", () => {
    const content = `---
name: kaizen-implement
description: Take a spec to working code
triggers: ["implement spec", "go ahead", "build it"]
depends_on: [kaizen-evaluate]
type: kaizen-internal
min_version: "1.0.40"
user_invocable: true
---

# Implementation`;

    const meta = parseSkillFrontmatter(content);
    expect(meta).toEqual({
      name: "kaizen-implement",
      description: "Take a spec to working code",
      triggers: ["implement spec", "go ahead", "build it"],
      depends_on: ["kaizen-evaluate"],
      type: "kaizen-internal",
      min_version: "1.0.40",
      user_invocable: true,
    });
  });

  it("handles user_invocable boolean correctly", () => {
    const content = `---
name: test-skill
description: test
user_invocable: false
---`;

    const meta = parseSkillFrontmatter(content);
    expect(meta?.user_invocable).toBe(false);
  });

  it("ignores unknown type values", () => {
    const content = `---
name: test-skill
description: test
type: unknown-type
---`;

    const meta = parseSkillFrontmatter(content);
    expect(meta?.type).toBeUndefined();
  });

  it("returns null when no frontmatter present", () => {
    const content = "# Just a markdown file\nNo frontmatter here.";
    expect(parseSkillFrontmatter(content)).toBeNull();
  });

  it("returns null when name is missing", () => {
    const content = `---
description: no name field
---`;
    expect(parseSkillFrontmatter(content)).toBeNull();
  });

  it("handles empty arrays", () => {
    const content = `---
name: test-skill
description: test
triggers: []
depends_on: []
---`;

    const meta = parseSkillFrontmatter(content);
    expect(meta?.triggers).toEqual([]);
    expect(meta?.depends_on).toEqual([]);
  });

  it("handles single-item arrays", () => {
    const content = `---
name: test-skill
description: test
depends_on: [kaizen-evaluate]
---`;

    const meta = parseSkillFrontmatter(content);
    expect(meta?.depends_on).toEqual(["kaizen-evaluate"]);
  });

  it("strips quotes from array values", () => {
    const content = `---
name: test-skill
description: test
triggers: ["go ahead", 'build it']
---`;

    const meta = parseSkillFrontmatter(content);
    expect(meta?.triggers).toEqual(["go ahead", "build it"]);
  });
});

describe("loadAllSkillMetadata", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "skill-meta-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads skill metadata from directory tree", () => {
    const skillDir = join(tempDir, "skill-a");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---
name: skill-a
description: First skill
depends_on: [skill-b]
---

Content`,
    );

    const skillDirB = join(tempDir, "skill-b");
    mkdirSync(skillDirB, { recursive: true });
    writeFileSync(
      join(skillDirB, "SKILL.md"),
      `---
name: skill-b
description: Second skill
---

Content`,
    );

    const skills = loadAllSkillMetadata(tempDir);
    expect(skills.size).toBe(2);
    expect(skills.get("skill-a")?.depends_on).toEqual(["skill-b"]);
    expect(skills.get("skill-b")?.depends_on).toBeUndefined();
  });

  it("returns empty map for nonexistent directory", () => {
    const skills = loadAllSkillMetadata("/nonexistent/path");
    expect(skills.size).toBe(0);
  });

  it("skips directories without SKILL.md", () => {
    mkdirSync(join(tempDir, "no-skill"), { recursive: true });
    writeFileSync(join(tempDir, "no-skill", "README.md"), "not a skill");

    const skills = loadAllSkillMetadata(tempDir);
    expect(skills.size).toBe(0);
  });

  it("skips SKILL.md with invalid frontmatter", () => {
    mkdirSync(join(tempDir, "bad-skill"), { recursive: true });
    writeFileSync(join(tempDir, "bad-skill", "SKILL.md"), "no frontmatter here");

    const skills = loadAllSkillMetadata(tempDir);
    expect(skills.size).toBe(0);
  });
});

describe("validateSkillDependencies", () => {
  it("reports no issues when all dependencies exist", () => {
    const skills = new Map<string, SkillMetadata>([
      ["a", { name: "a", description: "A", depends_on: ["b"] }],
      ["b", { name: "b", description: "B" }],
    ]);

    expect(validateSkillDependencies(skills)).toEqual([]);
  });

  it("reports missing dependencies", () => {
    const skills = new Map<string, SkillMetadata>([
      ["a", { name: "a", description: "A", depends_on: ["b", "c"] }],
      ["b", { name: "b", description: "B" }],
    ]);

    const issues = validateSkillDependencies(skills);
    expect(issues).toEqual([{ skill: "a", missing_dependency: "c" }]);
  });

  it("handles skills with no dependencies", () => {
    const skills = new Map<string, SkillMetadata>([
      ["a", { name: "a", description: "A" }],
      ["b", { name: "b", description: "B" }],
    ]);

    expect(validateSkillDependencies(skills)).toEqual([]);
  });

  it("handles empty skill map", () => {
    expect(validateSkillDependencies(new Map())).toEqual([]);
  });
});

describe("validateSkillVersions", () => {
  it("reports no issues when version is sufficient", () => {
    const skills = new Map<string, SkillMetadata>([
      ["a", { name: "a", description: "A", min_version: "1.0.40" }],
    ]);

    expect(validateSkillVersions(skills, "1.0.78")).toEqual([]);
  });

  it("reports issues when version is too low", () => {
    const skills = new Map<string, SkillMetadata>([
      ["a", { name: "a", description: "A", min_version: "2.0.0" }],
    ]);

    const issues = validateSkillVersions(skills, "1.0.78");
    expect(issues).toEqual([
      { skill: "a", min_version: "2.0.0", current_version: "1.0.78" },
    ]);
  });

  it("considers equal versions as compatible", () => {
    const skills = new Map<string, SkillMetadata>([
      ["a", { name: "a", description: "A", min_version: "1.0.78" }],
    ]);

    expect(validateSkillVersions(skills, "1.0.78")).toEqual([]);
  });

  it("skips skills without min_version", () => {
    const skills = new Map<string, SkillMetadata>([
      ["a", { name: "a", description: "A" }],
    ]);

    expect(validateSkillVersions(skills, "1.0.0")).toEqual([]);
  });

  it("compares minor versions correctly", () => {
    const skills = new Map<string, SkillMetadata>([
      ["a", { name: "a", description: "A", min_version: "1.1.0" }],
    ]);

    expect(validateSkillVersions(skills, "1.0.99")).toHaveLength(1);
    expect(validateSkillVersions(skills, "1.1.0")).toHaveLength(0);
    expect(validateSkillVersions(skills, "1.2.0")).toHaveLength(0);
  });
});
