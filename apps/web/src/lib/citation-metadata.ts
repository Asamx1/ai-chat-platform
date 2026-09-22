/** JSON-safe source metadata, shared by persistence and the chat UI. */
export type Citation = {
  documentId: string;
  name: string;
  ordinal: number;
  text: string;
  headingPath: string[];
  distance: number;
};

export function parseHeadingPath(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) && value.every((part): part is string => typeof part === 'string') ? value : [];
  } catch {
    return [];
  }
}

/** Old messages and malformed JSON metadata render without citation badges. */
export function parseCitations(raw: unknown): Citation[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is Citation => {
    if (!value || typeof value !== 'object') return false;
    const item = value as Record<string, unknown>;
    return typeof item.documentId === 'string' && typeof item.name === 'string' &&
      typeof item.ordinal === 'number' && Number.isInteger(item.ordinal) && item.ordinal >= 0 &&
      typeof item.text === 'string' && typeof item.distance === 'number' && Number.isFinite(item.distance) &&
      Array.isArray(item.headingPath) && item.headingPath.every(part => typeof part === 'string');
  });
}
