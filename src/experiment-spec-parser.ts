/**
 * Parser for Karpathy-style experiment spec markdown files.
 * Converts markdown with structured sections into typed config objects
 * that the experiment runner can execute.
 */

// Types

interface ExperimentVariant {
  name: string;
  value: string;
}

interface ExperimentMetric {
  type: 'primary' | 'secondary';
  name: string;
}

interface ExperimentBudget {
  runsPerVariant: number | null;
  maxCostPerRun: number | null;
}

export interface ExperimentSpec {
  title: string;
  hypothesis: string;
  variants: ExperimentVariant[];
  metrics: ExperimentMetric[];
  budget: ExperimentBudget;
}

// Helpers

/**
 * Extract the content of a ## section by heading name.
 * Returns the text between the matched heading and the next ## heading (or end of string).
 */
function extractSection(markdown: string, ...headingNames: string[]): string | null {
  for (const name of headingNames) {
    const pattern = new RegExp(
      `^##\\s+${escapeRegex(name)}\\s*\\n([\\s\\S]*?)(?=^##\\s|$(?!\\n))`,
      'mi',
    );
    const match = markdown.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }
  return null;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseTitle(markdown: string): string {
  // Match "# Experiment: <title>" or "# <title>"
  const match = markdown.match(/^#\s+(?:Experiment:\s*)?(.+)/m);
  return match ? match[1].trim() : '';
}

function parseHypothesis(markdown: string): string {
  const section = extractSection(markdown, 'Hypothesis');
  return section ?? '';
}

function parseVariants(markdown: string): ExperimentVariant[] {
  const section = extractSection(markdown, 'Variants');
  if (!section) return [];

  const variants: ExperimentVariant[] = [];
  const lines = section.split('\n');
  for (const line of lines) {
    // Match "- name: value" or "- name : value"
    const match = line.match(/^\s*-\s+([^:]+):\s*(.+)/);
    if (match) {
      variants.push({
        name: match[1].trim(),
        value: match[2].trim(),
      });
    }
  }
  return variants;
}

function parseMetrics(markdown: string): ExperimentMetric[] {
  const section = extractSection(markdown, 'Metric', 'Metrics');
  if (!section) return [];

  const metrics: ExperimentMetric[] = [];
  const lines = section.split('\n');
  for (const line of lines) {
    // Match "Primary: name" or "Secondary: name"
    const typedMatch = line.match(/^\s*(?:-\s+)?(Primary|Secondary)\s*:\s*(.+)/i);
    if (typedMatch) {
      metrics.push({
        type: typedMatch[1].toLowerCase() as 'primary' | 'secondary',
        name: typedMatch[2].trim(),
      });
      continue;
    }
    // Match bare "- name" (defaults to primary)
    const bareMatch = line.match(/^\s*-\s+(.+)/);
    if (bareMatch) {
      metrics.push({
        type: 'primary',
        name: bareMatch[1].trim(),
      });
    }
  }
  return metrics;
}

function parseBudget(markdown: string): ExperimentBudget {
  const section = extractSection(markdown, 'Budget');
  if (!section) return { runsPerVariant: null, maxCostPerRun: null };

  let runsPerVariant: number | null = null;
  let maxCostPerRun: number | null = null;

  // Match "N runs per variant"
  const runsMatch = section.match(/(\d+)\s+runs?\s+per\s+variant/i);
  if (runsMatch) {
    runsPerVariant = parseInt(runsMatch[1], 10);
  }

  // Match "$N max per run" or "$N per run"
  const costMatch = section.match(/\$(\d+(?:\.\d+)?)\s+(?:max\s+)?per\s+run/i);
  if (costMatch) {
    maxCostPerRun = parseFloat(costMatch[1]);
  }

  return { runsPerVariant, maxCostPerRun };
}

// Main parser

export function parseExperimentSpec(markdown: string): ExperimentSpec {
  return {
    title: parseTitle(markdown),
    hypothesis: parseHypothesis(markdown),
    variants: parseVariants(markdown),
    metrics: parseMetrics(markdown),
    budget: parseBudget(markdown),
  };
}
