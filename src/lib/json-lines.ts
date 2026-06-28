export interface ParsedJsonLines<T = unknown> {
  rows: T[];
  malformedRows: string[];
}

export function parseJsonLinesWithMalformedRows<T = unknown>(text: string): ParsedJsonLines<T> {
  const rows: T[] = [];
  const malformedRows: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as T);
    } catch {
      malformedRows.push(raw);
    }
  }
  return { rows, malformedRows };
}

export function parseJsonLines<T = unknown>(text: string): T[] {
  return parseJsonLinesWithMalformedRows<T>(text).rows;
}
