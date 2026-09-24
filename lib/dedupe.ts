/**
 * Best-effort duplicate-update guard, in-memory only.
 *
 * Vercel functions have an ephemeral filesystem and no shared state across
 * cold starts or instances, so this only catches retries that land on the
 * same warm instance. That's an accepted tradeoff for v1 (no external DB) —
 * worst case is an occasional duplicate draft reply, not a correctness bug.
 */

const MAX_SEEN = 500;
const seen = new Set<number>();

/** Returns true if this update_id was already processed (and records it if not). */
export function isDuplicate(updateId: number): boolean {
  if (seen.has(updateId)) {
    return true;
  }

  seen.add(updateId);
  if (seen.size > MAX_SEEN) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) {
      seen.delete(oldest);
    }
  }

  return false;
}
