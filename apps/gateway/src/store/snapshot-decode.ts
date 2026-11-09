import { setImmediate } from "node:timers/promises";

/** Return to the I/O phase between decoding slices; a microtask yield alone starves sockets. */
export async function decodeSnapshotRows<A, B>(rows: readonly A[], decode: (row: A) => B): Promise<B[]> {
  const result: B[] = [];
  let started = performance.now();

  for (let offset = 0; offset < rows.length; offset += 32) {
    const end = Math.min(rows.length, offset + 32);

    result.push(...rows.slice(offset, end).map(decode));

    if (end < rows.length && performance.now() - started >= 4) {
      await setImmediate();
      started = performance.now();
    }
  }

  return result;
}
