/**
 * Runs an async worker over items with a bounded number of in-flight tasks.
 *
 * Used to cap fan-out on operations that would otherwise fire one async call per
 * item all at once (e.g. embedding every entity in a large checkpoint sync), which
 * can stampede an external API and trip rate limits. Results preserve input order.
 *
 * Rejections from the worker propagate — wrap the worker in your own try/catch if
 * individual failures should be tolerated (the embedding sync does this).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const bound = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runner(): Promise<void> {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await worker(items[current]!, current);
    }
  }

  await Promise.all(Array.from({ length: bound }, () => runner()));
  return results;
}
