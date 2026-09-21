export type Part = { text: string };
export type Slice = { ordinal: number; start: number; end: number; text: string };
export function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\0/g, '');
}
/** Offsets count Unicode code points in the normalized, newline-joined text. */
export function chunk(parts: Part[], size = 512, overlap = 50): Slice[] {
  if (!Number.isSafeInteger(size) || !Number.isSafeInteger(overlap) || size <= 0 || overlap < 0 || overlap >= size) {
    throw new RangeError('Invalid chunk window');
  }
  const chars = Array.from(normalize(parts.map(p => p.text).join('\n')));
  if (!chars.join('').trim()) return [];
  const slices: Slice[] = [];
  for (let start = 0; start < chars.length; start += size - overlap) {
    const end = Math.min(start + size, chars.length);
    slices.push({ ordinal: slices.length, start, end, text: chars.slice(start, end).join('') });
    if (end === chars.length) break;
  }
  return slices;
}
