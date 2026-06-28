export interface ParsedJsonLines<T = unknown> {
  rows: T[];
  malformedRows: string[];
  malformed: Array<{ lineNumber: number; raw: string }>;
}

export function parseJsonLinesWithMalformedRows<T = unknown>(text: string): ParsedJsonLines<T> {
  const rows: T[] = [];
  const malformedRows: string[] = [];
  const malformed: Array<{ lineNumber: number; raw: string }> = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as T);
    } catch {
      malformedRows.push(raw);
      malformed.push({ lineNumber: index + 1, raw });
    }
  }
  return { rows, malformedRows, malformed };
}

export function parseJsonLines<T = unknown>(text: string): T[] {
  return parseJsonLinesWithMalformedRows<T>(text).rows;
}
