/**
 * Stub for future trending-news / market-context injection.
 * gemini.ts calls this unconditionally so the real implementation can slot
 * in later without touching the prompt-assembly call site.
 */
export async function getTrendingContext(_noteText: string): Promise<string | null> {
  return null;
}
