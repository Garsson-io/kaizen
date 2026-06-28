const META_COMMENT_RE = /<!--\s*meta:([\s\S]*?)-->/;

/**
 * Parse the JSON payload from the first `<!-- meta:... -->` HTML comment.
 */
export function parseJsonMetaComment(text: string): unknown | null {
  const match = text.match(META_COMMENT_RE);
  if (!match) return null;

  try {
    return JSON.parse(match[1].trim());
  } catch {
    return null;
  }
}
