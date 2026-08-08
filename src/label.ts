/**
 * `A, B, C, …, #27` labeling shared by consensus's anonymized answer/critique
 * rendering and synthesize's candidate rendering — same lettering scheme, same
 * beyond-Z fallback.
 */

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Letter for a 0-based index, falling back to `#<n>` (1-based) past `Z`. */
export function letterLabel(index: number): string {
  return LETTERS[index] ?? `#${String(index + 1)}`;
}
