export function parseJsonLines<T = unknown>(text: string): T[] {
  const rows: T[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as T);
    } catch {
      // Ignore malformed JSONL rows; callers consume best-effort streams.
    }
  }
  return rows;
}
