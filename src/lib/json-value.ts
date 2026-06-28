export function parseJsonValue(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export function parseJsonArray(text: string): unknown[] {
  return parseJsonArrayOrNull(text) ?? [];
}

export function parseJsonArrayOrNull(text: string): unknown[] | null {
  const parsed = parseJsonValue(text);
  return Array.isArray(parsed) ? parsed : null;
}

export function parseJsonObject(text: string): Record<string, unknown> | null {
  const parsed = parseJsonValue(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}
