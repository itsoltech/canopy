/** React Native's Response constructor doesn't accept streams. Connect consumes body, arrayBuffer or json. */
export function streamResponse(
  body: ReadableStream<Uint8Array>,
  event: { status: number; headers: Headers | Record<string, string> },
) {
  const response = new Response(null, { status: event.status, headers: event.headers });

  const arrayBuffer = async () => {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();

        if (done) break;
        size += value.byteLength;

        if (size > 32 * 1024 * 1024) throw new Error("Response is too large.");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }

    const result = new Uint8Array(size);
    let offset = 0;

    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result.buffer;
  };

  const text = async () => new TextDecoder().decode(await arrayBuffer());
  Object.defineProperties(response, {
    body: { value: body },
    arrayBuffer: { value: arrayBuffer },
    text: { value: text },
    json: { value: async () => JSON.parse(await text()) },
  });

  return response;
}

/** Failures after headers also invalidate the route. Cancellation stays local and never replays a request. */
export function observeResponse(response: Response, failed: (error: Error) => void) {
  if (!response.body) return response;
  const reader = response.body.getReader();

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();

        if (done) {
          reader.releaseLock();
          controller.close();
        } else controller.enqueue(value);
      } catch (error) {
        reader.releaseLock();
        failed(error instanceof Error ? error : new Error("Connection interrupted. Try again."));
        controller.error(error);
      }
    },
    async cancel() {
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    },
  });

  return streamResponse(body, response);
}
