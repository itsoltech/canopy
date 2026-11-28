/** Start the same-origin JavaScript decoder only after native image loading fails. */
export async function decodeHeic(source: Blob, signal: AbortSignal): Promise<ImageData | null> {
  signal.throwIfAborted();
  const worker = new Worker(new URL("./heic.worker.ts", import.meta.url), { type: "module" });
  const { promise, resolve } = Promise.withResolvers<ImageData | null>();
  const stop = () => resolve(null);

  try {
    signal.addEventListener("abort", stop, { once: true });
    worker.onerror = stop;
    worker.onmessageerror = stop;
    worker.onmessage = (event: MessageEvent<ImageData | null>) => resolve(event.data);
    worker.postMessage(source);

    return await promise;
  } finally {
    signal.removeEventListener("abort", stop);
    worker.terminate();
  }
}
