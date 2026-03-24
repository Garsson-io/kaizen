/**
 * skill-metadata.ts — Parse and validate SKILL.md frontmatter metadata.
 *
 * SKILL.md files use YAML frontmatter. This module defines the schema,
 * parses it, and validates cross-skill dependencies.
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

export interface SkillMetadata {
  name: string;
  description: string;
  triggers?: string[];
  depends_on?: string[];
  type?: "kaizen-internal" | "host-facing";
  min_version?: string;
  user_invocable?: boolean;
}

/**
 * Parse YAML frontmatter from a SKILL.md file content string.
 * Returns null if no valid frontmatter is found.
 */
export function parseSkillFrontmatter(content: string): SkillMetadata | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const yaml = match[1];
  const meta: Record<string, unknown> = {};

  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();

    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      // Inline YAML array: [a, b, c] or ["a", "b", "c"]
      const inner = rawValue.slice(1, -1);
      meta[key] = inner
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter((s) => s.length > 0);
    } else if (rawValue === "true") {
      meta[key] = true;
    } else if (rawValue === "false") {
      meta[key] = false;
    } else {
      meta[key] = rawValue.replace(/^["']|["']$/g, "");
    }
  }

  if (!meta.name || typeof meta.name !== "string") return null;

  return {
    name: meta.name as string,
    description: (meta.description as string) ?? "",
    triggers: Array.isArray(meta.triggers) ? (meta.triggers as string[]) : undefined,
    depends_on: Array.isArray(meta.depends_on) ? (meta.depends_on as string[]) : undefined,
    type: meta.type === "kaizen-internal" || meta.type === "host-facing" ? meta.type : undefined,
    min_version: typeof meta.min_version === "string" ? meta.min_version : undefined,
    user_invocable: typeof meta.user_invocable === "boolean" ? meta.user_invocable : undefined,
  };
}

/**
 * Load all SKILL.md files from a skills directory.
 * Returns a map of skill name → metadata.
 */
export function loadAllSkillMetadata(skillsDir: string): Map<string, SkillMetadata> {
  const skills = new Map<string, SkillMetadata>();

  if (!existsSync(skillsDir)) return skills;

  const entries = readdirSync(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(skillMdPath)) continue;

    try {
      const content = readFileSync(skillMdPath, "utf-8");
      const meta = parseSkillFrontmatter(content);
      if (meta) {
        skills.set(meta.name, meta);
      }
    } catch {
      // Skip unreadable files
    }
  }

  return skills;
}

export interface DependencyIssue {
  skill: string;
  missing_dependency: string;
}

/**
 * Validate that all depends_on references resolve to existing skills.
 */
export function validateSkillDependencies(skills: Map<string, SkillMetadata>): DependencyIssue[] {
  const issues: DependencyIssue[] = [];

  for (const [, meta] of skills) {
    if (!meta.depends_on) continue;
    for (const dep of meta.depends_on) {
      if (!skills.has(dep)) {
        issues.push({ skill: meta.name, missing_dependency: dep });
      }
    }
  }

  return issues;
}

export interface VersionIssue {
  skill: string;
  min_version: string;
  current_version: string;
}

/**
 * Check that all skills with min_version are compatible with the current plugin version.
 * Uses simple semver comparison (major.minor.patch).
 */
export function validateSkillVersions(
  skills: Map<string, SkillMetadata>,
  currentVersion: string,
): VersionIssue[] {
  const issues: VersionIssue[] = [];

  for (const [, meta] of skills) {
    if (!meta.min_version) continue;
    if (compareSemver(currentVersion, meta.min_version) < 0) {
      issues.push({
        skill: meta.name,
        min_version: meta.min_version,
        current_version: currentVersion,
      });
    }
  }

  return issues;
}

/**
 * Simple semver comparison. Returns negative if a < b, 0 if equal, positive if a > b.
 */
function compareSemver(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const pa = partsA[i] ?? 0;
    const pb = partsB[i] ?? 0;
    if (pa !== pb) return pa - pb;
  }
  return 0;
}
