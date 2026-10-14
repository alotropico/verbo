/** Shared rough budget estimate: about four characters per token for Latin text. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
